---
title: "Claim-then-process worker queue on Postgres + Spring"
description: "How to drain a durable work table safely: claim in a short transaction with FOR UPDATE SKIP LOCKED, do slow I/O outside any transaction, record outcomes in another short transaction — plus the Spring/JPA traps, crash recovery with reapers or reclaimable leases, and giving up by age."
pubDatetime: 2026-10-01T17:00:00+02:00
tags: [postgres, spring, worker-queue]
sourceNotes: [claim-then-process-worker-queue-postgres-spring]
---

> Claim durable work in a short transaction, perform the slow I/O outside it, then record the outcome in another short transaction. Atomic claims, reclaimable leases, and token-conditional updates prevent stranded work and stale bookkeeping; they do not eliminate duplicate external effects. Crash recovery can use a reaper, or expired-lease selection directly in the claim query.

## Table of contents

## Overview

A durable work table drained by pollers is the backbone of outbox relays, webhook delivery, retryable batch jobs — anything at-least-once. One rule governs the whole implementation: **never hold a DB transaction open across the slow work** (an HTTP call, external I/O), or you get [long-running-transaction bloat](/posts/postgres-long-transactions-and-vacuum-bloat/) plus connection tie-up. This post covers the exact commit boundaries and the Spring/JPA traps. It's reusable for _any_ Postgres worker queue, not just webhooks.

## Key points

- **Three phases, two transactions:** `claim()` → COMMIT → _(no txn)_ slow I/O, ≤N concurrent → `record()` → COMMIT. The transaction never spans the I/O.
- **Claim with one atomic statement:** `UPDATE … SET status='in_progress', locked_at=now() WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING …`. `SKIP LOCKED` lets many pollers drain the same table without colliding.
- **A single statement auto-commits — no explicit transaction needed.** Postgres wraps every statement in an implicit transaction that commits when it finishes. You only need an explicit txn when _multiple_ statements must be atomic together, or when a framework (JPA `@Modifying`) forces it.
- **`@Modifying` returns a row _count_, not rows.** `@Modifying` + `RETURNING List<entity>` does **not** work — use `JdbcTemplate` for the single-statement form, or the JPA **two-statement** form (`lockDue` + `markInProgress`) inside one `@Transactional`.
- **Self-invocation silently nukes `@Transactional`.** Call `claim()`/`record()` on **separate beans** so the Spring proxy applies; `this.claim()` bypasses the proxy → no transaction at all.
- **`@Modifying(clearAutomatically=true)` detaches the claimed entities** → return an immutable **record** (mapped while the data is loaded), not the managed entity, or the fan-out hits `LazyInitializationException`.
- **The two-transaction split makes a reaper mandatory.** A crash between `claim()` (committed) and `record()` strands rows in `in_progress`; a scheduled job resets `in_progress` rows older than the lease back to `pending`.
- **Give up by age, not just by attempt count** — `now − created_at > max_age` bounds the wall-clock time regardless of the backoff schedule.

## The commit boundaries

```
@Scheduled pollOnce()  (NOT @Transactional)
  │
  ├─ TXN 1  claimService.claim(500)   ── BEGIN … lock+flip 500 rows … COMMIT   (~2ms, cross-bean → proxy fires)
  │
  ├─ (no txn) virtual-thread fan-out, Semaphore(50), 2s timeout + circuit breaker   (~10s, ZERO db held)
  │
  └─ TXN 2  resultService.record(results)   ── BEGIN … batch success / reschedule / dead-letter … COMMIT  (~5ms)
```

## The claim — pick ONE form

**Form A — JdbcTemplate, a single statement (the cleanest).** No wrapper: the statement auto-commits.

```java
private static final String CLAIM = """
    UPDATE deliveries SET status='in_progress', locked_at=now()
     WHERE id IN (
        SELECT id FROM deliveries
         WHERE status='pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at LIMIT ? FOR UPDATE SKIP LOCKED)
    RETURNING id, endpoint_url, payload, attempts, created_at
    """;
List<ClaimedDelivery> claim(int limit) { return jdbc.query(CLAIM, mapper, limit); } // runs & commits, no @Transactional
```

**Form B — pure JPA, two statements in one transaction.** `@Modifying` can't return rows, so lock, then flip:

```java
public interface DeliveryRepo extends JpaRepository<Delivery, Long> {
    @Query(value = """
        SELECT * FROM deliveries WHERE status='pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT :limit FOR UPDATE SKIP LOCKED""", nativeQuery = true)
    List<Delivery> lockDue(@Param("limit") int limit);

    @Modifying(clearAutomatically = true)
    @Query("UPDATE Delivery d SET d.status='in_progress', d.lockedAt=CURRENT_TIMESTAMP WHERE d.id IN :ids")
    void markInProgress(@Param("ids") List<Long> ids);
}

@Service @RequiredArgsConstructor
class ClaimService {
    private final DeliveryRepo repo;
    @Transactional                                             // commit boundary = method return
    public List<ClaimedDelivery> claim(int limit) {
        List<Delivery> locked = repo.lockDue(limit);
        if (locked.isEmpty()) return List.of();
        repo.markInProgress(locked.stream().map(Delivery::getId).toList());
        return locked.stream().map(ClaimedDelivery::from).toList(); // map to RECORD (entities now detached)
    }
}
```

## The poller (orchestration only — never `@Transactional`)

```java
@Component @RequiredArgsConstructor
class DeliveryPoller {
    private final ClaimService  claimService;    // separate beans → proxy applies
    private final ResultService resultService;
    private final WebhookHttpClient http;
    private final Semaphore concurrency = new Semaphore(50);

    @Scheduled(fixedDelay = 200)                 // safe on N instances — SKIP LOCKED de-collides
    public void pollOnce() {
        List<ClaimedDelivery> batch = claimService.claim(500);      // TXN 1, committed
        if (batch.isEmpty()) return;

        List<DeliveryResult> results;                                // fan-out, no txn
        try (var vexec = Executors.newVirtualThreadPerTaskExecutor()) {
            var futures = batch.stream().map(d -> vexec.submit(() -> deliverOne(d))).toList();
            results = futures.stream().map(this::await).toList();
        }
        resultService.record(results);                               // TXN 2
    }

    private DeliveryResult deliverOne(ClaimedDelivery d) throws InterruptedException {
        concurrency.acquire();
        try { http.post(d.endpointUrl(), d.payload()); return DeliveryResult.success(d); }
        catch (Exception e) { return DeliveryResult.failure(d, e); }   // one failure never kills the batch
        finally { concurrency.release(); }
    }
    private DeliveryResult await(Future<DeliveryResult> f) {
        try { return f.get(); } catch (Exception e) { throw new IllegalStateException(e); }
    }
}
```

## Recording outcomes — give up by AGE

```java
@Service @RequiredArgsConstructor
class ResultService {
    private static final Duration MAX_AGE = Duration.ofHours(24);   // per-subscription in practice
    private final DeliveryRepo repo;

    @Transactional
    public void record(List<DeliveryResult> results) {
        var ok = results.stream().filter(DeliveryResult::ok).map(DeliveryResult::id).toList();
        if (!ok.isEmpty()) repo.markSuccess(ok);                     // one batch UPDATE

        var now = Instant.now();
        results.stream().filter(r -> !r.ok()).forEach(r -> {
            if (Duration.between(r.createdAt(), now).compareTo(MAX_AGE) > 0)
                repo.markFailed(r.id());                             // dead-letter → notify + replay
            else
                repo.reschedule(r.id(), backoffWithJitter(r.attempts()));  // status='pending', next_attempt_at
        });
    }
}
```

## Crash recovery: a reaper or reclaimable leases

A dedicated reaper is one option, not a requirement. Alternatively, the atomic claim query can select expired leases directly. Every claim gets a fresh token, and both success and failure updates require that token. An old worker can't overwrite a newer claim — though it can still finish an external send and create a duplicate. The example below needs token-conditional completion if work may outlive its claim.

```java
@Scheduled(fixedDelay = 60_000) @Transactional
public void reapStuck() { repo.resetStuckInProgress(Duration.ofMinutes(5)); }
//  UPDATE deliveries SET status='pending' WHERE status='in_progress' AND locked_at < now() - interval '5 min'
```

## The forks (state these; don't cargo-cult one)

| Fork                                                            | Default                                | Trigger to switch                                      |
| --------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| Claim: **JdbcTemplate one-statement** vs. **JPA two-statement** | JdbcTemplate (cleaner; RETURNING maps) | Staying pure-JPA / no JdbcTemplate in the codebase     |
| Record: **batch all outcomes** vs. **per-call update**          | Batch (less write load)                | You need finer crash granularity than the reaper gives |
| Give up: **by age** vs. **by attempts**                         | By age (bounds wall-clock time)        | Attempts, if the backoff schedule is fixed and short   |

## Gotchas

- **`@Transactional` on `pollOnce()` is the classic bug** — it wraps the txn around the HTTP fan-out → long-running-transaction bloat. The poller must be non-transactional; only `claim()`/`record()` are transactional.
- **Self-invocation:** `@Transactional` only works through the Spring proxy. A same-class `claim()` method called via `this` does nothing. Keep it on a separate bean.
- **`@Modifying` + `RETURNING List<entity>`** fights you — `@Modifying` expects to return an `int` count. Use JdbcTemplate for a single-statement RETURNING.
- **`clearAutomatically=true` detaches** the just-claimed entities mid-transaction → returning a `List<Delivery>` and touching a lazy field later throws `LazyInitializationException`. Return a record.
- **Don't wrap a single-statement claim in a transaction "to be safe"** — it already auto-commits; the wrapper is only needed for the two-statement JPA form, or by framework demand.
- **`FOR UPDATE` locks live only for the claim txn (~2ms)** — after the commit, it's the `status='in_progress'` value, not a lock, that keeps other pollers out. Locks cover the select-and-flip window; the status column covers the long I/O window.
- **Forget crash reclamation, and work can remain stranded.** Use either a reaper or expired-lease eligibility in the atomic claim query. With either approach, fence stale completions using a claim token.

## References

- Earlier in this topic:
  - [Long transactions and vacuum bloat](/posts/postgres-long-transactions-and-vacuum-bloat/) — _why_ the txn must not span the I/O.
  - [Connection pool starvation vs. DB resource contention](/posts/connection-pool-vs-database-contention/) — why holding a connection across I/O exhausts the pool.
  - [Postgres insert throughput and buffered writers](/posts/postgres-insert-throughput-and-buffered-writers/) — the write-side counterpart.
- Related:
  - [The outbox pattern and the dual-write problem](/posts/outbox-pattern-and-dual-write-problem/) · [Outbox publishers and parallel dispatch](/posts/outbox-publishers-and-parallel-dispatch/) — the outbox relay is the same claim-then-process shape.
  - [CompletableFuture, async patterns, and the cancellation problem](/posts/completablefuture-async-patterns-and-cancellation/) — the fan-out concurrency.
- [Postgres `SELECT … FOR UPDATE SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
