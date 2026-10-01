---
title: "Postgres insert throughput: fsync amortisation, connection saturation, and buffered writers"
description: "What a Postgres INSERT physically costs, why adding connections stops helping around cores × 2, how the four batching mechanisms differ on the wire, the batch-size knee, and how to build a buffered writer with real backpressure and durability semantics."
pubDatetime: 2026-10-01T16:45:00+02:00
tags: [postgres, performance, concurrency, batching]
sourceNotes: [postgres-insert-throughput-and-buffered-writers]
---

> A single-row INSERT costs microseconds of work and milliseconds of waiting — the `fsync` at COMMIT dominates. That gives exactly two levers: more connections (hides latency, but saturates hard around `cores × 2`) and batching (removes the per-row cost entirely). Batching is the bigger multiplier, and the cheaper one. The four batching mechanisms are _not_ equivalent: multi-row VALUES and UNNEST merge into one statement, pgx `SendBatch` pipelines N statements over one round trip, and COPY bypasses SQL entirely.

## Table of contents

## Overview

This is the companion to [Postgres write performance: batching and ON CONFLICT idempotency](/posts/postgres-write-batching-and-idempotency/), which covers _which API to call_ from Spring (the JPA `saveAll` trap, Hibernate batching, `ON CONFLICT`). This post covers the layer underneath: **what an insert physically costs, why adding connections stops helping, and how to build a write buffer.** It's the "why" behind the API choice, and the mental model that lets you predict throughput instead of measuring blindly.

It's anchored on Hatchet's benchmark (Go + pgx, Postgres in Docker on an M3 Max, a `tasks` table of id / created_at / jsonb payload), which took inserts from ~2,000 to ~92,000 rows/s — 31× — using only these two levers. The absolute numbers are laptop-specific; the _shape_ of the curves generalises.

## Key points

- **`fsync` at COMMIT is the dominant cost.** The heap insert is ~10 µs; the durability wait is 0.1–5 ms. Everything else is a rounding error.
- **At one connection, throughput is literally `1 / latency`.** The benchmark confirms it: 2,000 rows/s = 0.5 ms/insert; add 2 ms of network latency → `1/2.5ms` = ~400 rows/s, exactly what was measured.
- **A Postgres connection is strictly single-threaded**, and each one is a separate OS _process_ on the server side. Concurrency requires multiple connections — there's no multiplexing on one.
- **Connection scaling saturates around `(cores × 2)`** — ~20 on the test hardware. Going from 10 to 20 connections bought only 2,000 extra rows/s; 40 was _slower_ than 20.
- **The relation extension lock is the insert-specific ceiling.** Only one backend may extend a table's heap file at a time, so concurrent inserts into the same table serialise there, regardless of pool size.
- **The four batching mechanisms differ at the wire protocol**, not just in speed: multi-row VALUES (1 statement), pgx `SendBatch` (N statements, 1 round trip — _pipelining_, not merging), UNNEST (1 statement, array params), COPY (not SQL at all).
- **Batch-size returns are brutally non-linear.** Going from 1 to 25 rows eliminates 96% of fsyncs; 25 → 100 eliminates another 3% while quadrupling the buffering latency. Tune to the _smallest_ batch that captures most of the win.
- **Batching beats concurrency, and costs less.** ~12,000 rows/s from 20 connections of single inserts vs. ~80,000 from the same 20 connections doing 100-row batches.
- **A buffered writer needs two flush triggers** (size OR time) and a per-caller completion signal, so callers still learn when their row is durable.
- **A queue absorbs bursts, not overload.** If the arrival rate persistently exceeds the service rate, no capacity saves you — so the full-queue policy _is_ the overload strategy.
- **Block vs. shed is decided by one question: is the row already durable upstream?** If yes (an unacked broker message), block — the broker is a better buffer than your heap. If no, reject before accepting responsibility.
- **Never ack before the flush completes**, or at-least-once silently degrades to at-most-once — during crashes only.
- **Order events and metrics get inverted policies:** block-and-never-lose vs. never-block-and-drop-freely. Observability must not stall the path it measures.
- **Goroutines are ~2 KB and park for free; Java platform threads are ~1 MB OS threads.** "Spawn 100, let the pool throttle" is idiomatic Go and wasteful Java — unless you use Java 21 virtual threads.

## Where the time actually goes

| Cost                            | Order of magnitude           | Notes                              |
| ------------------------------- | ---------------------------- | ---------------------------------- |
| Network round trip              | 0.05 ms local, 1–5 ms remote | The client blocks, doing nothing   |
| Parse + plan                    | ~50 µs                       | Avoidable with prepared statements |
| Heap insert + index maintenance | ~10 µs                       | The actual work                    |
| WAL record write                | ~10 µs                       | Buffered in memory                 |
| **fsync at COMMIT**             | **0.1–5 ms**                 | **Dominates everything**           |

Postgres won't acknowledge a commit until the WAL is durably on disk — that's what `fsync` guarantees (see [WAL, durability, and checkpoints](/posts/postgres-wal-durability-and-checkpoints/)). So the per-row cost is almost entirely _waiting_, which is why there are only two levers: **do more in parallel**, or **stop paying per row**.

## Lever 1 — Connections (hides latency, saturates fast)

A connection is a request/response protocol over one socket, and on the server side it's a forked backend process. One connection = one statement in flight, ever. So concurrency _requires_ a pool:

```go
pool, _ := pgxpool.New(ctx, "postgres://...?pool_max_conns=20")
// N goroutines each: pool.Acquire(ctx) → Exec → conn.Release()
```

**The pool is a semaphore, and it — not the caller count — sets the concurrency.** 200 goroutines against a 20-connection pool means 20 inserts in flight and 180 parked in `Acquire`.

### The saturation curve

| Connections | Rows/s          | Ideal (N × 2,000) | Efficiency |
| ----------- | --------------- | ----------------- | ---------- |
| 1           | 2,000           | 2,000             | 100%       |
| 10          | ~10,000         | 20,000            | 50%        |
| 20          | ~12,000         | 40,000            | 30%        |
| 40          | _Lower than 20_ | 80,000            | —          |

Going from 10 to 20 connections bought 20% more throughput for double the connections. Four things bend the curve down:

1. **Process-per-connection.** Once active backends exceed the CPU cores, the scheduler thrashes — context switches, cache eviction. You add overhead, not parallelism. Each backend also holds RAM (see [connection pool vs. DB contention](/posts/connection-pool-vs-database-contention/) for the ~5–15 MB-per-connection capacity math).
2. **The relation extension lock.** Extending a table's heap file by a page requires an exclusive lock — **one backend at a time, per table.** This is the insert-specific ceiling: more writers to the same table just queue here.
3. **WAL insert locks.** All backends write into shared WAL buffers guarded by a bounded set of locks. Same story.
4. **Client-side pool acquisition overhead.**

**The sizing heuristic:** `connections ≈ (cores × 2) + effective_spindle_count` (from the PostgreSQL wiki, popularised by HikariCP). On the test hardware that lands near 20 — the benchmark's optimum isn't magic, it's the formula.

## Lever 2 — Batching (removes the per-row cost)

The four mechanisms are commonly blurred together, but they're materially different:

| Mechanism              | One SQL statement?        | Round trips /100 rows | fsyncs | Parses          |
| ---------------------- | ------------------------- | --------------------- | ------ | --------------- |
| A loop of `INSERT`s    | No — 100 statements       | 100                   | 100    | 100 (cacheable) |
| **Multi-row `VALUES`** | **Yes**                   | 1                     | 1      | 1               |
| **pgx `SendBatch`**    | **No — pipelined**        | 1                     | 1      | 100 (cached)    |
| **`UNNEST`**           | **Yes** (array params)    | 1                     | 1      | 1               |
| **`COPY FROM STDIN`**  | Not SQL — a binary stream | 1                     | 1      | 0               |

### Multi-row VALUES — genuine statement merging

```sql
INSERT INTO tasks (created_at, payload) VALUES ($1,$2), ($3,$4), ($5,$6), ...
```

One parse, one plan, one commit. **The hard cap: 65,535 bind parameters** (the protocol count is an `int16`) — with 3 columns, that's ~21,845 rows.

### pgx `SendBatch` — pipelining, not merging

```go
batch := &pgx.Batch{}
for _, r := range rows {
    batch.Queue("INSERT INTO tasks (created_at, payload) VALUES ($1, $2)", r.CreatedAt, r.Payload)
}
br := pool.SendBatch(ctx, batch)   // ONE socket flush
defer br.Close()
for range rows { if _, err := br.Exec(); err != nil { return err } }
```

It sends `Parse/Bind/Execute` for _each_ statement, but writes them all in **one flush**, then reads all the responses — one round trip instead of 100. pgx terminates the batch with a single `Sync`, so it runs in **one implicit transaction → one fsync**. That's where most of the win lives.

The trade-off vs. multi-row VALUES: the statements stay independent (mixed queries and tables are allowed), and there's no 65,535 limit — at the cost of 100 server-side executions.

### COPY FROM STDIN — a different protocol entirely

```go
pool.CopyFrom(ctx, pgx.Identifier{"tasks"}, []string{"created_at", "payload"},
    pgx.CopyFromSlice(len(rows), func(i int) ([]any, error) {
        return []any{rows[i].CreatedAt, rows[i].Payload}, nil
    }))
```

It streams rows as binary `CopyData` messages — no parse, no plan, no executor, no per-row parameter binding. Postgres also takes bulk shortcuts internally: it pins a target buffer and reuses it instead of re-acquiring buffer locks per row, and it batches relation-extension work. Hence ~92,000 rows/s at 18 ms latency, vs. ~80,000 at 43 ms for batched inserts.

### UNNEST — one statement, no parameter limit

```sql
INSERT INTO tasks (created_at, payload)
SELECT * FROM unnest($1::timestamptz[], $2::jsonb[])
```

One array parameter per _column_, regardless of the row count — two params for 100,000 rows. It supports `ON CONFLICT` and `RETURNING`, which makes it the pragmatic default for upsert-heavy bulk writes where COPY can't be used.

### The batch-size knee — the most useful finding

The win is _eliminated fsyncs_, and that curve flattens immediately:

| Batch size | fsyncs /100 rows | Eliminated |
| ---------- | ---------------- | ---------- |
| 1          | 100              | —          |
| 25         | 4                | 96%        |
| 100        | 1                | 99%        |

The benchmark found that **an average batch of 25 rows nearly saturated throughput**, at ~10 ms lower latency than larger batches. So the naive instinct ("a bigger batch = faster") is wrong past the knee: throughput has already flattened, while latency keeps growing linearly.

## The buffered writer

Accumulate rows in memory, flush on **size OR time**, and signal each caller when _its_ row has committed.

```java
@Component
public class TaskBuffer {
    private record Item(Row row, CompletableFuture<Void> done) {}

    private final BlockingQueue<Item> queue = new LinkedBlockingQueue<>(10_000); // bounded = backpressure
    private final JdbcTemplate jdbc;
    private static final int MAX_ROWS = 100;
    private static final long MAX_WAIT_MS = 10;

    public TaskBuffer(JdbcTemplate jdbc, @Value("${app.flushers:8}") int flushers) {
        this.jdbc = jdbc;
        var pool = Executors.newFixedThreadPool(flushers);
        for (int i = 0; i < flushers; i++) pool.submit(this::runFlusher);
    }

    /** Caller awaits the future → still knows the row is durably committed. */
    public CompletableFuture<Void> add(Row row) {
        var item = new Item(row, new CompletableFuture<>());
        if (!queue.offer(item)) {                       // full → shed, don't block forever
            return CompletableFuture.failedFuture(
                new RejectedExecutionException("write buffer full"));
        }
        return item.done();
    }

    private void runFlusher() {
        var pending = new ArrayList<Item>(MAX_ROWS);
        while (!Thread.currentThread().isInterrupted()) {
            try {
                Item first = queue.poll(MAX_WAIT_MS, TimeUnit.MILLISECONDS);  // time trigger
                if (first == null) continue;
                pending.add(first);
                queue.drainTo(pending, MAX_ROWS - 1);                         // size trigger
                flush(pending);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                pending.clear();
            }
        }
    }

    private void flush(List<Item> batch) {
        try {
            jdbc.batchUpdate("INSERT INTO tasks (created_at, payload) VALUES (?, ?)",
                batch.stream().map(i -> new Object[]{ i.row().createdAt(), i.row().payload() }).toList());
            batch.forEach(i -> i.done().complete(null));
        } catch (RuntimeException e) {
            batch.forEach(i -> i.done().completeExceptionally(e));  // never leave callers hanging
        }
    }
}
```

The design points that matter:

- **`poll(timeout)` + `drainTo` self-tunes the batch size.** It never _waits_ to fill a batch: it blocks up to 10 ms for the first row, then sweeps up everything already queued. Under load you get full batches; when idle, you flush one row immediately. This is why an "average batch of ~25" happens naturally, and it's strictly better than fixed-window batching for latency.
- **The completion signal preserves durability semantics.** The caller blocks until the commit, so you trade a few ms of latency — not durability. Fire-and-forget buffering loses unflushed rows on a crash.
- **A bounded queue = explicit backpressure.** A `LinkedBlockingQueue` with no capacity argument is _unbounded_ — one constructor argument away from an OOM. What happens when it fills is a real design decision; see the next section (and [thread pool queue OOM](/posts/thread-pool-queue-oom-and-virtual-thread-limits/)).
- **Single-owner accumulation.** In Go, one goroutine per buffer owns the slice, so there's no mutex — the concurrency lives in the channel. In Java, N flushers sharing one queue is simpler than N independent buffers, and it self-balances.
- **N flushers ≈ the pool size.** `throughput ≈ (flushers × batch_size) / flush_duration`. Flushers beyond the pool size just queue in `getConnection()`.

## Backpressure — what happens when the buffer fills

**A queue absorbs bursts; it does not add capacity.** Little's Law (`L = λW`) says that if the arrival rate λ persistently exceeds the service rate μ, the depth grows without bound, and _no queue size saves you_ — a bigger buffer just fails later, with more RAM wasted and staler data. So the buffer handles variance, and **the full-queue policy is the actual overload strategy.** Not choosing one means choosing unbounded growth → OOM, the worst option, because it kills the whole process, including traffic you could still have served.

### The four policies

| Policy            | Mechanism                      | Effect                                    | Right when                                                  |
| ----------------- | ------------------------------ | ----------------------------------------- | ----------------------------------------------------------- |
| **Block**         | `queue.put()`                  | The producer slows to the consumer's rate | The producer _can_ slow down, and rows sit durably upstream |
| **Bounded block** | `queue.offer(t, timeout)`      | Absorb jitter, then reject                | Request paths — the pragmatic default                       |
| **Shed**          | `offer()` → false → 503/429    | Reject fast, protect admitted traffic     | The caller can react or retry elsewhere                     |
| **Drop**          | A ring buffer; evict + counter | Lose data deliberately                    | Disposable telemetry                                        |

**Block is the only true backpressure** — it propagates upstream instead of absorbing locally. That's both its strength and its risk: it _relocates_ the problem rather than solving it. It's excellent when upstream is a broker, and dangerous when upstream is a user.

**Blocking an HTTP request thread is how congestion collapse happens.** The thread and connection stay held, latency passes the client's timeout, the client retries — and now you have 2× the arrival rate at the worst moment. Fast rejection breaks that loop: **a 503 in 1 ms beats a 30 s timeout.** This is the _throughput vs. goodput_ distinction — under overload without shedding, throughput looks fine while goodput (work someone still wants) collapses.

### The one question that decides block vs. shed

> **Is this row already durable somewhere else?**

- **Yes** (an unacked Pub/Sub message, an uncommitted Kafka offset) → **block freely.** The broker is a far better buffer than your heap: persistent, monitorable, replayable, and operated by someone else. Blocking means "stop polling"; lag grows and nothing is lost.
- **No** (an HTTP request already accepted, a webhook already 200'd) → you may not shed silently. Reject _before_ accepting responsibility, or see the write through.

Hence the rule that ties buffering to delivery semantics: **never ack before the flush completes.**

```java
@KafkaListener(topics = "orders")
public void onEvent(OrderEvent e, Acknowledgment ack) {
    buffer.add(toRow(e)).join();   // may block — correct here
    ack.acknowledge();             // only now is it durable
}
```

That `join()` is why the buffer returns a future at all. Drop it, and an at-least-once pipeline silently becomes at-most-once _during crashes only_ — invisible in testing (see [at-least-once delivery → exactly-once effect](/posts/at-least-once-to-exactly-once-effect/)).

### Order events vs. metrics — inverted answers

|                              | Order events                       | Metrics / telemetry                                             |
| ---------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| Cost of losing a row         | Unacceptable — money, audit, trust | Negligible — one point in thousands                             |
| Cost of slowing the producer | Acceptable — the broker absorbs it | **Unacceptable — it must not add latency to the business path** |
| Full-queue policy            | **Block**, don't ack               | **Drop**, bump a counter                                        |
| API shape                    | `CompletableFuture<Void> add()`    | `void record()`                                                 |

**Observability must not be able to take down the thing it observes.** A telemetry buffer that blocks will, under load, stall the exact request path it was measuring. Two refinements: for metrics, prefer **lower fidelity over loss** (pre-aggregate — increment a counter rather than queueing a row — or sample), and **always expose a `dropped_total` counter**, or you can't distinguish "traffic fell" from "we discarded 40% of our telemetry" during the one incident the dashboard exists for.

The API asymmetry is deliberate: a method returning a future says _you must await durability_; a `void` method says _fire and forget_. Same class, two entry points, no accidental misuse.

### Implementation

```java
public enum FullPolicy { BLOCK, SHED, DROP }

private final FullPolicy policy;
private final Duration admitWait;                 // e.g. 250ms for BLOCK
private final AtomicLong dropped = new AtomicLong();
private volatile boolean accepting = true;

public CompletableFuture<Void> add(Row row) {
    if (!accepting) {                             // shutting down
        return CompletableFuture.failedFuture(new RejectedExecutionException("draining"));
    }
    var item = new Item(row, new CompletableFuture<>());
    try {
        boolean admitted = switch (policy) {
            // bounded block: absorb micro-bursts, then reject rather than hang
            case BLOCK      -> queue.offer(item, admitWait.toMillis(), TimeUnit.MILLISECONDS);
            case SHED, DROP -> queue.offer(item);
        };
        if (!admitted) {
            if (policy == FullPolicy.DROP) {
                dropped.incrementAndGet();
                return CompletableFuture.completedFuture(null);   // telemetry only
            }
            return CompletableFuture.failedFuture(
                new RejectedExecutionException("write buffer full"));
        }
        return item.done();
    } catch (InterruptedException ie) {
        Thread.currentThread().interrupt();
        return CompletableFuture.failedFuture(ie);
    }
}
```

**`offer(timeout)` is the default for any request path.** Pure blocking risks hung threads; pure shedding is twitchy under normal jitter. Bounded blocking gives you burst tolerance _and_ a latency ceiling.

### Sizing the queue — by time, not rows

```
queue_capacity ≈ service_rate × acceptable_added_latency
```

At 80k rows/s with a 100 ms latency budget: ~8,000 rows. **A queue deeper than your timeout allows you to drain is pure waste** — every row past that depth is stale or abandoned before you reach it. That's the "queue of doom": a system busily completing work nobody is waiting for.

### Monitoring the buffer

| Signal                 | Type    | Why                                                                |
| ---------------------- | ------- | ------------------------------------------------------------------ |
| Queue depth            | Gauge   | A leading indicator; healthy ≈ near zero, monotonic growth = λ > μ |
| **Average batch size** | Gauge   | **A free saturation gauge**                                        |
| `rejected` / `dropped` | Counter | The only evidence that shedding happened                           |

The average batch size falls out of the `drainTo` design for free: healthy means small batches (the queue drains faster than it fills); **pinned at `MAX_ROWS` means saturated and growing.** It's a better early warning than latency, which stays flat right up until it doesn't. Alert on _sustained_ depth — spikes are the buffer doing its job.

### Shutdown drain (the forgotten bug)

Rolling deploys silently losing buffered rows is a real failure class. The required sequence: flip `accepting = false` → drain and flush the remaining batches → complete the outstanding futures → exit. And the environment must permit it: Spring's `server.shutdown=graceful` plus `spring.lifecycle.timeout-per-shutdown-phase`, and a Kubernetes `terminationGracePeriodSeconds` longer than the worst-case drain. Otherwise SIGKILL lands mid-drain, and you lose precisely the rows you made durable-on-ack.

## Threads vs. connections (Go → Java)

|               | Goroutine                   | Java platform thread                    | Java 21 virtual thread          |
| ------------- | --------------------------- | --------------------------------------- | ------------------------------- |
| Stack         | ~2 KB, grows                | **~1 MB, reserved**                     | ~Hundreds of bytes, on the heap |
| Scheduled by  | The Go runtime (user space) | The OS kernel (1:1)                     | The JVM (user space)            |
| Blocking cost | Park, reuse the OS thread   | **OS context switch; the thread idles** | Park, the carrier is freed      |
| 100k of them  | Fine                        | Impossible                              | Fine                            |

In a Spring Boot web app, you **don't create threads for DB parallelism — you already have them**: Tomcat's pool (default 200) contending for HikariCP (default 10). The Go idiom "spawn 100, let the pool throttle" is free with goroutines, but costs ~1 MB per blocked platform thread in Java, and each will eventually throw `SQLTransientConnectionException` after Hikari's 30 s `connectionTimeout`.

**Java 21 virtual threads** (`spring.threads.virtual.enabled=true`) make the Go model transfer exactly — a virtual thread blocked in `getConnection()` unmounts and costs almost nothing. But they make _waiting_ cheap, not Postgres faster: the 20-connection and relation-extension-lock ceilings are unchanged. Keep fixed flusher pools on platform threads (few and long-lived — virtual threads buy nothing there). See [platform threads vs. virtual threads](/posts/platform-vs-virtual-threads-scheduling/).

## JDBC / Spring equivalents

| Go / pgx                       | Java                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `pgxpool`, `pool_max_conns=20` | HikariCP `maximum-pool-size` — the same `(cores × 2)` heuristic, the same "bigger is worse" |
| `SendBatch`                    | `PreparedStatement.addBatch()/executeBatch()`, `JdbcTemplate.batchUpdate()`                 |
| Multi-row `VALUES`             | **`reWriteBatchedInserts=true`** on the datasource URL                                      |
| `CopyFrom`                     | `org.postgresql.copy.CopyManager.copyIn(...)`                                               |
| `unnest($1::type[])`           | The same SQL; `Connection.createArrayOf(...)`                                               |

## Gotchas

- **`reWriteBatchedInserts=true` is off by default in pgJDBC.** Without it, `executeBatch()` saves round trips but still sends N separate INSERTs for Postgres to parse individually. Setting it makes the driver rewrite them into multi-row VALUES — typically 2–3× on batch inserts, from one connection-string parameter that most Spring codebases never set.
- **`SendBatch` is not statement merging.** Reading it as "combines into one INSERT" leads to wrong predictions about parse cost and the parameter limit (it has none). It's one round trip over N statements.
- **The 65,535 limit is per _parameter_, not per row.** Sizing batches by row count without accounting for the column count breaks on wide tables. `UNNEST` sidesteps it entirely.
- **COPY can't upsert.** No `ON CONFLICT`, no `RETURNING`, and it's all-or-nothing per copy. For idempotent bulk writes: `COPY` into a temp table, then `INSERT … SELECT … FROM temp … ON CONFLICT DO NOTHING`. COPY also bypasses some triggers.
- **More connections can make inserts _slower_.** It's non-obvious because it contradicts the pooling intuition — but past `cores × 2` you're adding scheduler thrash and lock contenders. The relation extension lock means writers to one table can never fully parallelise.
- **Bigger batches past the knee only buy latency.** Beyond ~25–100 rows the fsync saving is spent; you're paying buffering delay and holding larger transactions (more locks, more WAL, more replication lag) for ~nothing.
- **Fire-and-forget buffering silently trades away durability.** If callers don't await a completion signal, a crash loses everything unflushed. Fine for metrics, wrong for order events.
- **`new LinkedBlockingQueue<>()` is unbounded.** The OOM default is one constructor argument away from correct.
- **Blocking an HTTP request thread invites a retry storm.** Past the client's timeout, you get retries on top of the existing load — the arrival rate doubles at the worst moment. A bounded `offer(timeout)` gives burst tolerance with a latency ceiling.
- **Blocking a Kafka listener past `max.poll.interval.ms` (default 5 min) evicts the consumer** from the group and triggers a rebalance. Bound the block, or `pause()` the partition explicitly.
- **A queue deeper than your timeout can drain is pure waste** — those rows are abandoned before you reach them. Size by `service_rate × acceptable_latency`, not by available RAM.
- **Silent drops make dashboards lie during incidents.** Any DROP policy needs a `dropped_total` counter, or "traffic fell" and "we discarded telemetry" look identical.
- **Deploys lose buffered rows without an explicit drain.** Stop accepting → flush → complete the futures → exit, with a grace period longer than the worst-case drain. SIGKILL mid-drain loses exactly the rows you made durable-on-ack.
- **A 200-thread Tomcat pool over a 20-connection Hikari pool queues in the wrong place** — 180 threads holding ~1 MB stacks each, timing out after 30 s. Keep the feeding thread count near the pool size, or switch to virtual threads.
- **Virtual thread pinning:** in JDK 21, a virtual thread blocking inside `synchronized` pins its carrier (fixed by JEP 491 in JDK 24). It's generally fine with Hikari, but measure before enabling it on a hot write path.

## References

- Earlier in this topic:
  - [Postgres write performance: batching and ON CONFLICT idempotency](/posts/postgres-write-batching-and-idempotency/) — the companion: which API to call from Spring, and `ON CONFLICT` idempotency.
  - [WAL, durability, and checkpoints](/posts/postgres-wal-durability-and-checkpoints/) — why COMMIT waits on fsync.
  - [Connection pool starvation vs. DB resource contention](/posts/connection-pool-vs-database-contention/) — pool starvation vs. DB contention, per-connection RAM cost, RDS Proxy.
- Related:
  - [Platform threads vs. virtual threads](/posts/platform-vs-virtual-threads-scheduling/) — carrier threads, pinning, mounting.
  - [Thread pool queue OOM and virtual-thread concurrency limits](/posts/thread-pool-queue-oom-and-virtual-thread-limits/) — bounded queues and backpressure.
  - [At-least-once delivery → exactly-once effect](/posts/at-least-once-to-exactly-once-effect/) — why "never ack before flush" is load-bearing.
- [Hatchet, "The fastest way to insert rows into Postgres"](https://hatchet.run/blog/fastest-postgres-inserts) (part 2 covers multi-table transactions, FK overhead / `multixact members limit exceeded`, and unlogged tables)
- [Postgres COPY docs](https://www.postgresql.org/docs/current/sql-copy.html)
- [pgJDBC connection parameters](https://jdbc.postgresql.org/documentation/use/#connection-parameters)
