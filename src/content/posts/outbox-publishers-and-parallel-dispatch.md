---
title: "Outbox publishers and parallel dispatch: poller, Kafka relay, Debezium CDC, and the @Transactional trap"
description: "The three ways to publish an outbox (scheduled poller, poller-to-Kafka relay, Debezium CDC) and when to use each, running pollers on multiple instances, and why @Transactional on a parallel dispatcher is wrong — with the three-transaction pattern, status-based claims, and stale-claim recovery."
pubDatetime: 2026-09-30T17:39:00+02:00
tags: [microservices, kafka, spring, distributed-systems]
sourceNotes: [outbox-pattern-and-dual-write-problem]
---

> - **Three publisher flavors:** a `@Scheduled` poller (simplest, polling latency), a poller → Kafka relay (decoupled fan-out), and Debezium CDC (real-time, reads the binlog/WAL).
> - **Multi-instance polling needs SKIP LOCKED or ShedLock**; otherwise multiple replicas grab the same row.
> - **Don't put `@Transactional` on a parallel batch dispatcher.** Use the three-transaction pattern instead: a short claim transaction, no transaction during the async batch, and a short per-event transaction — HTTP calls happen _between_ transactions, never inside them.

## Table of contents

## Overview

This is Part 2 of the outbox pattern. [Part 1](/posts/outbox-pattern-and-dual-write-problem/) covered the dual-write problem, the pattern itself, the dispatch shapes, the outbox table, and the two idempotency layers.

This part covers the _publisher_ — the component that reads outbox rows and forwards them: the three implementation flavors and how to choose between them, how to run pollers on several instances, and the parallel-dispatch design, where putting `@Transactional` on the dispatcher is a subtle but serious mistake.

## Key points

- **Three publisher flavors:** a `@Scheduled` poller (simplest, with polling latency), a poller → Kafka relay (decoupled fan-out), and Debezium CDC (real-time, reading the binlog/WAL).
- **Multi-instance polling needs SKIP LOCKED or ShedLock.** Otherwise multiple replicas grab the same row.
- **Don't put `@Transactional` on a parallel batch dispatcher.** Spring's `@Transactional` is thread-bound (it uses `ThreadLocal`); async tasks on virtual/worker threads run _outside_ the outer transaction. The wrapper only meaningfully wraps the initial fetch, but it holds the DB connection and row locks for the whole batch (30+ seconds of HTTP calls) — the worst possible shape.
- **The three-transaction pattern for parallel dispatch:** (1) a short claim transaction marks rows as `PROCESSING` and returns them; (2) the async batch processes events with NO outer transaction; (3) a per-event short transaction inside `markProcessed`/`markFailed`. HTTP calls happen _between_ transactions, never inside them.
- **Put the per-event update methods on a separate `@Service` bean** (e.g., `OutboxUpdater`) and inject it. `@Transactional` works via Spring's proxy; calling a `@Transactional` method on `this` from another method of the same class **silently bypasses the proxy** — no transaction fires. This is the self-invocation gotcha.
- **Status-based ownership beats long-held row locks for parallel dispatch.** Replace a `SELECT FOR UPDATE SKIP LOCKED` held across the batch with an `UPDATE … SET status='PROCESSING'` claim — locks are released in milliseconds, ownership is encoded in the row status, and it's recoverable via a stale-claim sweeper.

## Three publisher flavors

### Flavor A — a `@Scheduled` poller (simplest)

The publisher itself calls the external API:

```java
@Scheduled(fixedDelay = 100)
public void publishOutbox() {
    var events = outboxRepo.findByStatusOrderByCreatedAt(PENDING, limit(100));
    for (var event : events) {
        try {
            paymentProcessor.send(event.getPayload());
            outboxRepo.markProcessed(event.getId());
        } catch (Exception e) {
            log.error("will retry next tick");
        }
    }
}
```

- ✅ Dead simple, no extra infrastructure
- ✅ Easy to reason about, easy to debug
- ❌ Polling latency (100ms+) — not great for sub-second SLAs
- ❌ Doesn't scale across instances without `SELECT ... FOR UPDATE SKIP LOCKED` (otherwise replicas grab the same rows)

**The default choice. Use this until you have a reason not to.**

### Flavor B — the poller publishes to Kafka; a separate consumer dispatches

This decouples producers from consumers. The poller's only job is moving outbox rows onto a Kafka topic; downstream consumers (possibly in different services) handle the actual external call:

```java
@Scheduled(fixedDelay = 100)
public void publishOutbox() {
    var events = outboxRepo.findByStatusOrderByCreatedAt(PENDING, limit(100));
    for (var event : events) {
        try {
            kafkaTemplate.send("withdrawal.dispatch", event.getKey(), event.getPayload()).get();
            outboxRepo.markProcessed(event.getId());
        } catch (Exception e) {
            log.error("will retry next tick", e);
        }
    }
}

// Different service / consumer
@KafkaListener(topics = "withdrawal.dispatch")
public void handle(WithdrawalEvent event) {
    paymentProcessor.send(event);  // idempotency key on processor side
}
```

- ✅ Kafka decouples producers and consumers — multiple downstream systems can subscribe to the same event
- ✅ Kafka handles retries, ordering (per partition), partitioning, and replay
- ✅ Scales horizontally — multiple consumer instances share the load
- ❌ More moving parts, more infrastructure to operate
- ❌ Still has poll latency between the DB and Kafka

**Most large systems land here.** The outbox table → Kafka step is the "publisher", and Kafka becomes the integration backbone.

### Flavor C — Change Data Capture (Debezium)

Skip the poller entirely. **Debezium** reads MySQL's binlog (or the Postgres WAL) and turns row changes into Kafka events automatically:

```
outbox table INSERT → MySQL binlog → Debezium → Kafka topic → consumer → API
```

The service code just inserts outbox rows; Debezium handles publishing them. No `@Scheduled`, no polling, no application-level relay.

- ✅ Near-real-time (milliseconds, not poll-cycle latency)
- ✅ No application code for the relay — an operational concern, not a code concern
- ✅ Strong ordering guarantees per partition
- ✅ Scales well — Debezium runs as a Kafka Connect worker
- ❌ Heavyweight infrastructure: a Kafka Connect cluster + the Debezium connector + monitoring
- ❌ DB-specific (the binlog must be enabled, a replication user, etc.)
- ❌ Operational complexity — when Debezium falls behind, debugging is non-trivial

**The industrial-grade outbox**, for very high transaction volumes.

## Decision rule of thumb

| Scale / latency need                                          | Use                                     |
| ------------------------------------------------------------- | --------------------------------------- |
| A small service, <1k events/min, latency in seconds is fine   | Flavor A: a `@Scheduled` poller         |
| Multiple downstream consumers; you want event fan-out         | Flavor B: the poller publishes to Kafka |
| High volume, real-time, and you can afford the infrastructure | Flavor C: Debezium CDC                  |

## Multi-instance polling

If you run 3 service replicas, all 3 schedulers fire simultaneously and grab the same rows. There are two solutions.

### Option 1 — `SKIP LOCKED` (Postgres + MySQL 8+)

```sql
SELECT * FROM outbox
 WHERE status='PENDING'
 ORDER BY created_at
 LIMIT 100
 FOR UPDATE SKIP LOCKED;
```

Each instance grabs different rows. This parallelizes work across replicas — best for high throughput.

### Option 2 — ShedLock

```java
@Scheduled(fixedDelay = 100)
@SchedulerLock(name = "publishOutbox", lockAtMostFor = "30s")
public void publishOutbox() { ... }
```

Only one instance runs the job at a time. Simpler to reason about, but with no parallelism — best for low-throughput services where simplicity wins.

## Parallel dispatch and the `@Transactional` trap

The Flavor A poller above is sequential — one event at a time. That's fine up to a few hundred events/min. Above that, you parallelize: fetch a batch, fan the work out across threads (virtual threads in Java 21+), and wait for all of them to finish. This is where most people put `@Transactional` on the dispatcher method — which is **wrong**, in subtle ways that are worth understanding.

### The wrong shape — `@Transactional` on the parallel dispatcher

```java
@Scheduled(fixedDelay = 5_000)
@Transactional                           // ◄── WRONG
public void dispatch() {
    List<OutboxEvent> events = outbox.lockAndFetchPending(500);   // FOR UPDATE SKIP LOCKED

    try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
        List<CompletableFuture<Void>> futures = events.stream()
            .map(e -> CompletableFuture.runAsync(() -> processEvent(e), executor))
            .toList();
        CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
    }
}

private void processEvent(OutboxEvent e) {
    chargeStripe(e);
    sendNotification(e);
    outbox.markProcessed(e.id());        // also problematic — see self-invocation
}
```

There are three concrete problems with the `@Transactional` here.

#### Problem 1: async tasks don't see the outer transaction

Spring's `@Transactional` uses `TransactionSynchronizationManager`, which is built on `ThreadLocal` (see [ThreadLocal mechanics](/posts/threadlocal-mechanics-and-cleanup/)) — **the transaction is bound to the calling thread.** When `CompletableFuture.runAsync(..., executor)` submits a task to a virtual thread, that thread starts with **empty** `ThreadLocal` state. It does NOT inherit the outer transaction. (Even if it did, sharing one JDBC connection across threads is unsafe.)

So when `processEvent` runs on a virtual thread:

- The HTTP calls happen with no DB involvement.
- `outbox.markProcessed(e.id())` runs in **its own** transaction (or auto-commit), completely separate from the outer one.

The 500 async tasks **execute entirely outside the outer `@Transactional`.** The outer transaction has no idea what they're doing, and can't roll them back.

#### Problem 2: the outer transaction holds a connection for the whole batch

`@Transactional` checks out a HikariCP connection at method entry and returns it at exit. With `allOf(...).join()` blocking for 30+ seconds across the batch, **one DB connection is checked out but idle for 30 seconds.** Multiply by N dispatcher pods, and you've consumed N connections from a pool that's probably only 10–20 in size.

This is the classic connection-pool exhaustion shape — connections held during slow remote calls.

#### Problem 3: row locks held across HTTP calls

`SELECT FOR UPDATE SKIP LOCKED` acquires row-level locks that are released only at commit. With `@Transactional` on the dispatcher, those locks are held across 30s of HTTP work. If the pod crashes mid-batch, the locks linger until the connection times out (potentially minutes).

#### What does the `@Transactional` actually wrap?

| Statement                                       | Inside the outer transaction?                          |
| ----------------------------------------------- | ------------------------------------------------------ |
| `outbox.lockAndFetchPending(500)`               | ✅ Yes                                                 |
| `events.stream().map(...).toList()`             | ✅ Yes (CPU only; doesn't matter)                      |
| `CompletableFuture.runAsync(...)` (the kickoff) | ✅ Yes (just submits; doesn't matter)                  |
| `processEvent(e)` running on a virtual thread   | ❌ **No — a different thread**                         |
| `chargeStripe`, `sendNotification` (HTTP)       | ❌ No                                                  |
| `outbox.markProcessed(...)` (per event)         | ❌ **No — a different thread, a separate transaction** |
| `allOf(...).join()`                             | ✅ Yes (blocking, no DB activity)                      |

**The `@Transactional` only meaningfully wraps the fetch.** Everything else either doesn't touch the DB on this thread, or runs on a different thread. The wrapper holds resources for nothing useful.

### The correct shape — three separate transaction scopes

Replace one long-held transaction with three short, focused ones:

```java
@Service
public class OutboxDispatcher {

    private final OutboxClaimer claimer;        // own bean for claim TX
    private final OutboxUpdater updater;        // own bean for per-event update TX
    private final RestClient stripeClient;
    private final RestClient notificationClient;

    @Scheduled(fixedDelay = 5_000)              // ◄── NO @Transactional here
    public void dispatch() {
        List<OutboxEvent> events = claimer.claimPending(500);
        if (events.isEmpty()) return;

        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<CompletableFuture<Void>> futures = events.stream()
                .map(e -> CompletableFuture.runAsync(() -> processEvent(e), executor))
                .toList();
            CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
        }
    }

    private void processEvent(OutboxEvent e) {
        try {
            chargeStripe(e);                    // HTTP, between TXes
            sendNotification(e);                // HTTP, between TXes
            updater.markProcessed(e.id());      // ◄── short TX inside
        } catch (Exception ex) {
            updater.markFailed(e.id(), ex.getMessage());   // short TX
            log.error("Event {} failed", e.id(), ex);
        }
    }
}

@Service
public class OutboxClaimer {

    private final OutboxRepository outbox;

    @Transactional                              // ◄── short TX, just the claim
    public List<OutboxEvent> claimPending(int batchSize) {
        return outbox.claimPendingNative(batchSize, podId(), Instant.now());
    }
}

@Service
public class OutboxUpdater {

    private final OutboxRepository outbox;

    @Transactional
    public void markProcessed(UUID id) {
        outbox.findById(id).ifPresent(e -> {
            e.setStatus(PROCESSED);
            e.setProcessedAt(Instant.now());
        });   // dirty-checking flushes UPDATE at commit
    }

    @Transactional
    public void markFailed(UUID id, String reason) {
        outbox.findById(id).ifPresent(e -> {
            e.setStatus(FAILED);
            e.setFailureReason(reason);
            e.setRetryCount(e.getRetryCount() + 1);
        });
    }
}
```

Three transactions, each focused:

1. **Transaction 1 — the claim** (in `OutboxClaimer`): atomically marks rows as `PROCESSING` and returns them. It holds a connection and locks for milliseconds.
2. **No transaction during the async batch** — `dispatch()` itself owns no transaction. HTTP calls happen freely, without any DB connection held.
3. **Transaction 2 — the per-event update** (in `OutboxUpdater`): each event's final status update gets its own short transaction, running on the virtual thread that's executing that event.

**The rule:** never hold a database transaction across remote I/O. HTTP calls happen _between_ transactions, never _inside_ them.

> **Caveat:** the dispatcher snippets here are conceptual. When claims can expire (see stale-claim recovery below), the per-event updates also need a claim-token check, so a late worker can't overwrite a row that another dispatcher has since reclaimed.

### The claim query — replacing FOR UPDATE held across the batch

Instead of a `SELECT FOR UPDATE SKIP LOCKED` held for the whole batch, use a single atomic UPDATE that claims rows by status:

```sql
UPDATE outbox
   SET status = 'PROCESSING',
       claimed_by = :podId,
       claimed_at = now()
 WHERE id IN (
     SELECT id FROM outbox
      WHERE status = 'PENDING'
      ORDER BY created_at
      LIMIT :batchSize
        FOR UPDATE SKIP LOCKED
 )
RETURNING *;
```

This is one short SQL statement. It:

- Atomically claims `batchSize` PENDING rows
- Marks them PROCESSING (so other pods skip them by status, not by lock)
- Returns them to the caller
- Releases all locks immediately on commit

The locks now live for **milliseconds**, not for the duration of the batch. Other dispatcher pods see those rows as `PROCESSING` and skip them via `WHERE status='PENDING'`. Ownership is encoded in the row's `claimed_by` / `claimed_at` columns — visible to humans, and recoverable.

### Stale-claim recovery — for crash safety

What if a dispatcher pod crashes mid-batch? Some rows are stuck in `PROCESSING` forever. Add a recovery sweeper:

```sql
UPDATE outbox
   SET status = 'PENDING',
       claimed_by = NULL,
       claimed_at = NULL
 WHERE status = 'PROCESSING'
   AND claimed_at < now() - interval '5 minutes';
```

```java
@Scheduled(fixedDelay = 60_000)
@SchedulerLock(name = "outboxStaleClaimRecovery")
public void recoverStaleClaims() {
    int recovered = outbox.recoverStaleClaims(Duration.ofMinutes(5));
    if (recovered > 0) log.warn("Recovered {} stale outbox claims", recovered);
}
```

Run it every minute. Rows stuck in `PROCESSING` for more than 5 minutes were abandoned by a dead pod; reset them to `PENDING` so the next dispatcher picks them up. Combined with idempotency on the receiver side, this is safe — at worst, the events are re-dispatched (and deduped at the destination).

**Why this beats relying on row locks for recovery:** locks die with the connection, but the timing is unpredictable (TCP keepalives, pool eviction). Status-based recovery is deterministic — you can query exactly what's stuck with SQL.

### The self-invocation gotcha — why separate beans

In the corrected code above, `OutboxClaimer` and `OutboxUpdater` are **separate `@Service` beans**, not methods on `OutboxDispatcher`. This isn't stylistic — it's necessary for `@Transactional` to fire.

```java
// ❌ WRONG — markProcessed has @Transactional but it doesn't fire
@Service
public class OutboxDispatcher {
    @Transactional
    public void markProcessed(UUID id) { ... }

    private void processEvent(OutboxEvent e) {
        // ...
        markProcessed(e.id());     // direct method call → bypasses proxy → NO TX
    }
}
```

Spring's `@Transactional` works by wrapping the bean in a proxy. **External callers** go through the proxy (the transaction kicks in). **Internal calls** (`this.markProcessed(...)`, or just `markProcessed(...)`) bypass the proxy, because they're plain Java method calls — the annotation is silently ignored.

Putting `markProcessed` on a different bean (`OutboxUpdater`) and injecting it ensures the call goes through the proxy:

```java
// ✅ Correct — outboxUpdater is injected → proxy fires → TX kicks in
private void processEvent(OutboxEvent e) {
    // ...
    updater.markProcessed(e.id());     // through proxy, TX kicks in
}
```

### `@Transactional` and virtual threads

One worry to put to rest: **`@Transactional` works fine with virtual threads.** Spring 6's transaction manager uses `ThreadLocal`, and virtual threads have their own per-thread `ThreadLocal` storage, so each virtual thread that enters a `@Transactional` method gets its own transaction. What does NOT happen is a "shared" transaction across threads — that has never been a thing in Spring or JDBC.

When `processEvent` runs on a virtual thread Tv and calls `updater.markProcessed(...)`:

1. The call hits the proxy on `updater`.
2. Spring opens a fresh transaction on Tv.
3. It acquires a connection from HikariCP.
4. It runs the UPDATE.
5. It commits and returns the connection.

Short, focused, fast. **This is exactly what you want.** Each transaction scope is independent; the dispatcher doesn't try to coordinate them.

### Schema additions for the claim pattern

```sql
ALTER TABLE outbox
    ADD COLUMN claimed_by   VARCHAR(64),
    ADD COLUMN claimed_at   TIMESTAMP,
    ADD COLUMN retry_count  INT NOT NULL DEFAULT 0,
    ADD COLUMN failure_reason TEXT;

-- Replace status enum to include PROCESSING and FAILED
ALTER TABLE outbox
    ALTER COLUMN status TYPE VARCHAR(20),
    ADD CONSTRAINT outbox_status_check
        CHECK (status IN ('PENDING','PROCESSING','PROCESSED','FAILED'));

-- Index for the claim query
CREATE INDEX idx_outbox_pending ON outbox (status, created_at) WHERE status = 'PENDING';

-- Index for stale-claim recovery
CREATE INDEX idx_outbox_processing ON outbox (status, claimed_at) WHERE status = 'PROCESSING';
```

Partial indexes (`WHERE status = ...`) keep the indexes small, even as the table grows.

### Decision: when to parallelize the dispatcher

The Flavor A sequential poller is fine for low throughput. Parallelize when:

| Symptom                                                                                   | Action                                                                        |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The dispatch rate < the event creation rate (the backlog is growing)                      | Parallelize                                                                   |
| A `@Scheduled` run takes longer than the schedule interval (overlapping runs are blocked) | Parallelize                                                                   |
| Per-event API call latency × event count > the acceptable backlog drain time              | Parallelize                                                                   |
| A single-thread dispatcher is pegged at 100% CPU                                          | Unusual; profile first — it's usually I/O-bound, and parallelism doesn't help |

Once you parallelize, you're in three-transaction territory. Don't try to make a parallel dispatcher work with `@Transactional` on the outer method — it doesn't, for the reasons above.

## Gotchas

- **Polling delay is not a worst-case delivery bound.** Processing time, backlog, backoff, outages, and scheduling all add latency. Measure the latency you need; CDC changes the mechanism, not the need to handle outages.
- **Multi-instance pollers without `SKIP LOCKED` or ShedLock cause double-dispatch.** Two replicas read the same row, and both call the API. The receiver's idempotency saves you, but the load is doubled and the logs become confusing.
- **`SELECT ... FOR UPDATE SKIP LOCKED`** is supported by PostgreSQL as well as MySQL 8+. It protects the short claim transaction, not the later network call. An expiring lease plus token-conditional updates protects the subsequent bookkeeping.
- **Debezium falling behind is hard to detect.** Monitor Kafka Connect's `source-record-write-rate` and the binlog/WAL position. A silent fallback can mean events aren't dispatched for hours.
- **`@Transactional` on a parallel dispatcher method is the worst of both worlds** — it only meaningfully wraps the initial fetch (which needs its own transaction anyway), but holds a connection and locks for the whole 30+ second batch. The 500 async tasks run on virtual threads entirely outside the transaction. Replace it with the three-transaction pattern: a short claim transaction, no transaction during the async batch, and a short per-event transaction in a separate bean.
- **`@Transactional` is thread-bound** — Spring's `TransactionSynchronizationManager` uses `ThreadLocal`. Async tasks on other threads get a fresh transaction context (or none). There's no concept of a transaction "spanning multiple threads" in Spring/JDBC; there never has been. Don't try to engineer one.
- **Self-invocation bypasses `@Transactional`.** Calling `this.markProcessed(...)` from another method of the same class skips the proxy → no transaction fires. Move `@Transactional` methods to a separate `@Service` bean and inject it.
- **Holding FOR UPDATE SKIP LOCKED locks across HTTP calls is an anti-pattern.** Locks are released only at transaction commit; if the transaction wraps a 30s batch, the locks live for 30s. Replace them with status-based ownership (`UPDATE … SET status='PROCESSING'`) — locks released in milliseconds, with ownership encoded in the row itself.
- **A stale-claim recovery sweeper that uses `SELECT FOR UPDATE` without proper locking** can race with active dispatchers. Use a single atomic `UPDATE … WHERE status='PROCESSING' AND claimed_at < ...` rather than fetch-then-update, or run the sweeper under `@SchedulerLock` to serialize it across pods.
- **A per-event `@Transactional(REQUIRES_NEW)`** would also work around the outer-transaction problem — it suspends the outer transaction and creates a new one for the update — but it's a workaround for a bug, not a fix. Better to remove the outer `@Transactional` and use plain `REQUIRED` propagation on the per-event method.

## References

- Previous in this topic: [The outbox pattern and the dual-write problem](/posts/outbox-pattern-and-dual-write-problem/) — the failure modes, the pattern, the shapes, and the idempotency layers.
- Related: [ThreadLocal mechanics](/posts/threadlocal-mechanics-and-cleanup/) — why `@Transactional` context doesn't follow work onto other threads · [Kafka core architecture](/posts/kafka-core-architecture/) — per-partition ordering for Flavors B and C.
- [Debezium documentation](https://debezium.io/documentation/reference/stable/) · [ShedLock](https://github.com/lukas-krecan/ShedLock) · [PostgreSQL `SELECT` and locking](https://www.postgresql.org/docs/16/sql-select.html)
