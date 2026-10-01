---
title: "Postgres write performance: the JPA saveAll trap, JDBC batching, multi-VALUES INSERT, and ON CONFLICT idempotency"
description: "Why saveAll() is a loop of single INSERTs, the four levels of Postgres insert batching and when to use each, the IDENTITY gotcha that silently disables Hibernate batching, and ON CONFLICT DO NOTHING for race-free, idempotent batch writes."
pubDatetime: 2026-10-01T16:38:00+02:00
tags: [postgres, jpa, hibernate, spring-boot, idempotency, performance]
sourceNotes: [postgres-write-performance-batching-and-idempotency]
---

> `saveAll()` is a loop of individual INSERTs in disguise. There are four distinct levels of Postgres batching — default JPA (100 statements), Hibernate JDBC batching (2 round trips, 100 statements), multi-VALUES INSERT (1 statement, 1 round trip), and COPY (a binary stream). Each is 5–10x faster than the last. Combined with `ON CONFLICT DO NOTHING`, a multi-VALUES INSERT gives you high-throughput, idempotent consumer writes in a single query.

## Table of contents

## Overview

Streaming consumers writing to Postgres (Kafka consumers, SQS workers, webhook handlers) are one of the most common places where Spring Boot services silently underperform. The default `JpaRepository.saveAll()` _looks_ like a batch operation, but it's actually a loop of individual INSERTs under the hood — which only becomes painfully obvious when the consumer falls behind under load. This post covers the four performance levels of Postgres inserts, the `IDENTITY` vs. `SEQUENCE` gotcha that silently disables Hibernate batching, the `ON CONFLICT DO NOTHING` pattern for database-level idempotency, and the trade-off between SELECT-first and ON CONFLICT for handling duplicates.

## Key points

- **`saveAll()` is NOT a batch INSERT.** It iterates and calls `persist()` per entity. Each one generates a separate INSERT statement, sent to Postgres individually. Most services discover this during a capacity incident.
- **Four levels of insert batching**: default JPA → Hibernate JDBC batching → multi-VALUES INSERT → COPY. Each is ~5–10x faster than the previous one.
- **Hibernate JDBC batching is off by default.** Enable it with `hibernate.jdbc.batch_size=50` plus `order_inserts=true`.
- **`IDENTITY` ID generation silently defeats Hibernate batching.** Use `SEQUENCE`, with an `allocationSize` matching your batch size.
- **`ON CONFLICT DO NOTHING` is the canonical database-level idempotency pattern.** It requires a unique constraint; the constraint is the actual guarantee.
- **`ON CONFLICT` is race-free; SELECT-first has a concurrency window.** Under load, two consumers can both pass a SELECT check and both try to INSERT — one throws.
- **Multi-VALUES INSERT + `ON CONFLICT` = idempotent batch writes in one atomic statement.** The combination that solves "the consumer is falling behind under load" for most Spring Boot services.
- **Postgres COPY is for bulk loads, not streaming.** It bypasses SQL parsing entirely — millions of rows/sec — but it's overkill for consumer use.

## The four levels of insert batching

### Level 1 — Default JPA `saveAll()` (the trap)

```java
@Transactional
public void process(List<RefundEvent> events) {
    refundRepository.saveAll(events);  // looks like a batch
}
```

What actually hits Postgres:

```sql
INSERT INTO refunds (...) VALUES (..);   -- statement 1
INSERT INTO refunds (...) VALUES (..);   -- statement 2
... 100 statements total
```

**100 separate round trips, 100 parses, 100 plans, 100 WAL entries.** For 100 events: ~500ms. For 1000: 5+ seconds.

### Level 2 — Hibernate JDBC batching

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50
          batch_versioned_data: true
        order_inserts: true # group by entity type before batching
        order_updates: true
```

With this on, `saveAll(100 events)` becomes:

```
2 batches sent to JDBC driver:
  Batch 1: 50 INSERT statements via executeBatch() → 1 round trip
  Batch 2: 50 INSERT statements via executeBatch() → 1 round trip
```

100 statements → 2 round trips. **The statements are still parsed individually by Postgres**, but the network overhead collapses 50x. ~50ms for the same 100 events.

#### Don't stop here — add `reWriteBatchedInserts=true`

Hibernate batching alone only saves round trips. The pgJDBC driver can go further and **rewrite a batch into a single multi-row VALUES statement** — but the flag is off by default:

```yaml
spring:
  datasource:
    url: jdbc:postgresql://host:5432/db?reWriteBatchedInserts=true
```

This effectively promotes Level 2 to Level 3 without changing any application code — typically 2–3x on batch inserts. **Most Spring codebases never set it**, which is why `batch_size=50` often underdelivers against expectations. (The win comes from an amortised `fsync`, not from fewer packets.)

#### A critical gotcha: IDENTITY defeats batching

```java
// Silently disables Hibernate batching
@Id
@GeneratedValue(strategy = GenerationType.IDENTITY)
private Long id;
```

Hibernate must wait for the DB-generated ID after each INSERT before continuing → it can't batch. Switch to SEQUENCE:

```java
@Id
@GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "refund_seq")
@SequenceGenerator(name = "refund_seq", sequenceName = "refund_seq", allocationSize = 50)
private Long id;
```

`allocationSize = 50` pre-fetches 50 IDs per sequence call → Hibernate can batch the inserts. **Without this, the `batch_size=50` config does nothing.** Always check both together.

### Level 3 — Multi-VALUES INSERT (a single SQL statement)

```sql
INSERT INTO refunds (id, merchant_id, status, amount, created_at) VALUES
  (1, 'M1', 'pending', 100, '2026-04-22'),
  (2, 'M1', 'pending', 200, '2026-04-22'),
  (3, 'M1', 'pending', 150, '2026-04-22'),
  ...
  (100, 'M1', 'pending', 75, '2026-04-22');
```

**One statement, one round trip, one parse, one plan, one execution context.** ~10–15ms for 100 rows.

In Spring, use `JdbcTemplate` directly:

```java
@Component
public class RefundBulkInserter {
    @Autowired private JdbcTemplate jdbcTemplate;

    public void bulkInsert(List<RefundEvent> events) {
        String sql = "INSERT INTO refunds (id, merchant_id, status, amount, created_at) VALUES " +
                     events.stream()
                           .map(e -> "(?, ?, ?, ?, ?)")
                           .collect(Collectors.joining(", "));

        Object[] args = events.stream()
            .flatMap(e -> Stream.of(e.getId(), e.getMerchantId(),
                                     e.getStatus(), e.getAmount(), e.getCreatedAt()))
            .toArray();

        jdbcTemplate.update(sql, args);
    }
}
```

**The parameter limit:** Postgres has a hard limit of **65,535 parameters per query**. For very large batches, chunk them into groups of 500–1000 rows at a time.

### Level 4 — Postgres COPY (the nuclear option)

For bulk loads (ETL, initial imports, reindexing):

```java
CopyManager copyManager = ((PGConnection) connection).getCopyAPI();
copyManager.copyIn(
    "COPY refunds (id, merchant_id, status, amount) FROM STDIN WITH CSV",
    new StringReader(csvData)
);
```

It bypasses SQL parsing entirely — streaming data directly into the table. **~3–5ms for 100 rows; millions of rows/sec at scale.** It's overkill for streaming consumers; reserve it for batch ETL jobs.

### Performance comparison

For 100 rows:

| Approach                           | Time     | Statements | Round trips | Postgres parses |
| ---------------------------------- | -------- | ---------- | ----------- | --------------- |
| `saveAll()` default                | ~500ms   | 100        | 100         | 100             |
| `saveAll()` + `batch_size=50`      | ~50ms    | 100        | 2           | 100             |
| `JdbcTemplate` multi-VALUES INSERT | ~10–15ms | 1          | 1           | 1               |
| Postgres `COPY`                    | ~3–5ms   | 0 (binary) | 1           | 0               |

**Each level is 5–10x faster than the previous one.** Going from the default `saveAll()` to a multi-VALUES INSERT is a ~50x speedup — exactly the kind of fix that turns a falling-behind consumer into one that catches up in minutes.

## When to use which level

| Scenario                                             | Approach                           |
| ---------------------------------------------------- | ---------------------------------- |
| Low-volume CRUD (1–10 entities per transaction)      | Default JPA — clarity wins         |
| Medium throughput (a 100–1000 entities/sec consumer) | JPA + JDBC batching + SEQUENCE IDs |
| High throughput (a 10k+ entities/sec consumer)       | `JdbcTemplate` multi-VALUES INSERT |
| Bulk import / ETL (millions of rows)                 | Postgres COPY                      |

For a Kafka/SQS consumer hitting 1000 events/sec on Black Friday, **a multi-VALUES INSERT batching 50–100 events at a time** is the right tool. Typically, the 50–100x throughput jump solves the partition-cap problem without repartitioning the broker.

## ON CONFLICT DO NOTHING — the canonical idempotency pattern

It triggers when a row would violate a **unique constraint** (or a unique index, primary key, or exclusion constraint). Other constraint violations (FK, CHECK, NOT NULL) still throw errors.

### Three forms

```sql
-- Form 1: any unique violation
INSERT INTO refunds (...) VALUES (...)
ON CONFLICT DO NOTHING;

-- Form 2: specific column constraint (safer — explicit)
INSERT INTO refunds (refund_id, merchant_id, ...) VALUES (...)
ON CONFLICT (merchant_id, refund_id) DO NOTHING;

-- Form 3: named constraint
INSERT INTO refunds (...) VALUES (...)
ON CONFLICT ON CONSTRAINT uniq_refund_per_merchant DO NOTHING;
```

**Form 2 is the production default.** Other unique violations still throw errors (which is what you want — those are real bugs, not duplicate events).

### The constraint is the actual guarantee

`ON CONFLICT` requires a unique constraint to exist:

```sql
ALTER TABLE refunds
  ADD CONSTRAINT uniq_refund_per_merchant
  UNIQUE (merchant_id, refund_id);
```

**Without the constraint, `ON CONFLICT (cols)` throws at query time.** The application code using `ON CONFLICT` is just the optimistic path; the constraint is what enforces the invariant. This matters: even if your consumer doesn't use `ON CONFLICT`, having the constraint means duplicate INSERTs throw exceptions your application can catch. The constraint is load-bearing; the syntax is ergonomic.

### DO NOTHING vs. DO UPDATE (UPSERT)

```sql
-- DO NOTHING: skip duplicates, keep original row
INSERT INTO refunds (...) VALUES (...)
ON CONFLICT (merchant_id, refund_id) DO NOTHING;

-- DO UPDATE: overwrite (true UPSERT)
INSERT INTO refunds (...) VALUES (...)
ON CONFLICT (merchant_id, refund_id)
DO UPDATE SET status = EXCLUDED.status, updated_at = NOW();
```

For event idempotency, `DO NOTHING` is usually right — the first event already wrote the row, and duplicates should be no-ops. **`DO UPDATE` is for scenarios where newer events should overwrite** (e.g. status transitions that should apply the latest value).

## SELECT-first vs. ON CONFLICT — the idempotency trade-off

Two patterns that both work, with different trade-offs:

```java
// SELECT-first pattern
@Transactional
public void process(RefundEvent event) {
    if (refundRepo.existsById(event.getRefundId())) {
        return; // already processed
    }
    refundRepo.save(event);
}

// ON CONFLICT pattern
@Transactional
public void process(RefundEvent event) {
    jdbcTemplate.update(
        "INSERT INTO refunds (...) VALUES (...) ON CONFLICT (merchant_id, refund_id) DO NOTHING",
        ...
    );
}
```

| Aspect                                 | SELECT-first                                                                                                      | ON CONFLICT                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Round trips, duplicate path            | 1 SELECT + 0 INSERT                                                                                               | 1 INSERT                        |
| Round trips, new path                  | 1 SELECT + 1 INSERT                                                                                               | 1 INSERT                        |
| Race condition under concurrency       | **Yes** — two consumers can both pass the SELECT check and both try to INSERT; the second fails on the constraint | **No** — atomic at the DB level |
| Requires a unique constraint           | No (but you should have one anyway, for safety)                                                                   | Yes                             |
| Code clarity                           | More explicit ("this is an idempotency check")                                                                    | Implicit in DB semantics        |
| Performance — duplicate-heavy workload | Slower (an extra SELECT per message)                                                                              | Faster (a single statement)     |
| Performance — duplicate-rare workload  | Similar                                                                                                           | Slightly faster                 |
| Fits with a multi-VALUES batch INSERT  | No (you can't SELECT-first for a batch)                                                                           | **Yes** — per-row skip          |

### Which to pick

- **SELECT-first** reads better and avoids holding a transaction open on the duplicate path. Good for readability-first teams; safe as long as you have the unique constraint as a backstop.
- **ON CONFLICT** is race-free, one atomic statement, and composes with a multi-VALUES INSERT for high-throughput consumers. Preferred when performance or batching matters.

The unique constraint does the real work in both patterns. The application code is just the "optimistic path" that avoids exceptions on the happy path. Don't treat these as mutually exclusive — **always have the constraint**, then pick whichever application pattern fits your readability and performance preferences.

### Three sources of duplicates the unique constraint protects against

- **Kafka redelivery** — the consumer processed a message but crashed before committing the offset → it's re-read on restart
- **Rebalance** — consumer A was processing message X when a rebalance reassigned the partition to consumer B → both process X
- **Producer retries** — the upstream publisher's ack timed out, so it retried → the same event is published twice

One unique constraint catches all three.

## Multi-VALUES INSERT + ON CONFLICT = the killer combination

These compose perfectly, which is why they're the default high-throughput pattern:

```sql
INSERT INTO refunds (refund_id, merchant_id, status, amount) VALUES
  ('refund_1', 'M1', 'pending', 100),
  ('refund_2', 'M1', 'pending', 200),
  ('refund_3', 'M1', 'pending', 150),  -- duplicate, will be skipped
  ('refund_4', 'M1', 'pending', 300)
ON CONFLICT (merchant_id, refund_id) DO NOTHING;
```

If row 3 conflicts, only that row is skipped; rows 1, 2, and 4 still insert. **No transaction rollback, no exception, no per-row handling needed.** One SQL statement, ~10–15ms, idempotent, and batch-safe.

For a Kafka consumer processing 100-event batches every 100ms, this is the right shape. The same approach with the default `saveAll()` would take ~500ms per batch, plus exception-handling logic for duplicates.

## Cross-database syntax reference

| Database   | Idempotent INSERT equivalent                                                         |
| ---------- | ------------------------------------------------------------------------------------ |
| Postgres   | `INSERT ... ON CONFLICT (cols) DO NOTHING` / `DO UPDATE`                             |
| MySQL      | `INSERT IGNORE` (skips ALL errors — broader) or `INSERT ... ON DUPLICATE KEY UPDATE` |
| SQLite     | `INSERT OR IGNORE`                                                                   |
| Oracle     | `MERGE INTO ... USING ... WHEN NOT MATCHED THEN INSERT`                              |
| SQL Server | `MERGE` (similar to Oracle)                                                          |

Postgres's `ON CONFLICT` is widely considered the cleanest — an explicit target, narrow, with predictable failure modes.

## Gotchas

- **`saveAll()` looks like batching.** Reading the Spring Data docs without profiling the actual SQL leads to silent performance problems. Check with `spring.jpa.show-sql=true` or `logging.level.org.hibernate.SQL=DEBUG`.
- **`IDENTITY` IDs silently disable Hibernate batching.** If `batch_size=50` shows no improvement, this is the first thing to check. Switch to `SEQUENCE` with a matching `allocationSize`.
- **`order_inserts=true` is required** for Hibernate to actually batch inserts of mixed entity types — without it, Hibernate flushes whenever the entity type changes.
- **A multi-VALUES INSERT has a 65,535-parameter limit** per query — and it counts _parameters_, not rows, so wide tables hit it sooner (3 columns → ~21,845 rows). Chunk into groups of 500–1000 rows, or use `INSERT … SELECT * FROM unnest($1::type[], $2::type[])`, which passes one array param per column and has no row limit, while still supporting `ON CONFLICT`.
- **Transaction size grows with batch size.** Bigger batches = bigger transactions = more locks held longer = more WAL = more replication lag. The sweet spot is usually 50–500 rows per batch.
- **`ON CONFLICT` requires the target columns to have a unique constraint or unique index.** Without one, the query throws at plan time, not at execution.
- **`ON CONFLICT DO UPDATE` can trigger unexpected row updates** if your logic assumed "only insert new rows". If you want a strict "skip duplicates, never modify", use `DO NOTHING`.
- **Batching breaks per-row error handling under `DO NOTHING`.** With `ON CONFLICT DO NOTHING`, conflicts are silently skipped — you won't know from the INSERT how many duplicates were in your batch. Use `RETURNING id` with a row-count check if you need to observe conflict rates.
- **Postgres COPY bypasses triggers and some constraints** by default. Use it carefully if you rely on INSERT triggers (audit logs, denormalization, etc.).
- **`DO UPDATE` sets `xmax` even when no row has changed in practice** — it's the same physical UPDATE, which consumes WAL and VACUUM work. For no-op-dominant workloads, `DO NOTHING` is cheaper.

## References

- Earlier in this topic: [Connection pool starvation vs. DB resource contention](/posts/connection-pool-vs-database-contention/) — when the DB becomes the bottleneck despite app-side optimizations.
- Related: [Streaming dedup and ordered emission](/posts/streaming-dedup-and-ordered-emission/) — deduplication patterns for streaming.
- [Postgres docs — `INSERT ... ON CONFLICT`](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT)
- [Hibernate batching docs](https://docs.jboss.org/hibernate/orm/current/userguide/html_single/Hibernate_User_Guide.html#batch)
- [Postgres COPY docs](https://www.postgresql.org/docs/current/sql-copy.html)
