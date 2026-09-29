---
title: "Database indexing and query planning: B-tree internals, index types, and reading EXPLAIN ANALYZE"
description: "How a B-tree index works, the leftmost-prefix and equality-before-range rules for composite indexes, covering/partial/expression indexes, when an index won't help, and how to read EXPLAIN ANALYZE."
pubDatetime: 2026-09-29T20:55:00+02:00
tags: [postgres, indexing, query-planning, performance]
sourceNotes: [database-indexing-and-query-planning]
---

> An index is a separate sorted structure (usually a B-tree) that turns an O(n) table scan into an O(log n) lookup — paid for with slower writes, more storage, and planner work. The core skills are three: pick the right index (composite column order follows the **leftmost-prefix** rule; equality columns before range), know **when an index won't help** (low selectivity → the planner correctly chooses a Seq Scan), and read **EXPLAIN ANALYZE** to find the expensive node (a Seq Scan on a selective filter, or estimated vs. actual row counts wildly off = stale statistics). This is the read-side counterpart to write-side performance tuning.

## Table of contents

## Overview

Indexing is where "knows SQL" becomes "can make SQL fast." The wrong index (or an over-indexed table) is one of the most common production performance problems, and reading a query plan is a skill you can't fake.

This post covers how a B-tree index actually works, the index _types_ beyond the default, the composite-index ordering rules, covering/partial/expression indexes, the selectivity principle that decides whether an index is even used, and a practical guide to reading `EXPLAIN ANALYZE`. Deliberately out of scope: ORM N+1 queries and write batching — indexing is orthogonal to both.

## Key points

- **An index trades write speed + storage for read speed.** Every `INSERT`/`UPDATE`/`DELETE` must maintain every index on the table. Over-indexing is a real anti-pattern.
- **The default index is a B-tree** — it supports `=`, `<`, `>`, `BETWEEN`, `IN`, `IS NULL`, `ORDER BY`, and **prefix** `LIKE 'abc%'`. It cannot serve a **leading wildcard** `LIKE '%abc'` or a function on the column.
- **Composite index column order follows the leftmost-prefix rule.** `INDEX(a, b, c)` serves predicates on `(a)`, `(a, b)`, `(a, b, c)` — but **not** `(b)` or `(b, c)` alone.
- **Order columns equality-first, range-last.** A range/inequality column "stops" the index from filtering on the columns after it.
- **Covering index → index-only scan.** If every column the query needs is in the index (use `INCLUDE`), Postgres answers from the index without touching the heap.
- **A partial index** (`WHERE status='active'`) indexes only a hot subset — smaller and cheaper to maintain. **An expression index** (`LOWER(email)`) is required when you filter on a function.
- **Selectivity decides whether the index is used.** If a query returns a large fraction of the table (~>5–10%), a Seq Scan is _cheaper_, and the planner picks it correctly. Indexes win on **selective** predicates.
- **The planner is cost-based and statistics-driven.** Stale stats (no `ANALYZE`) → bad estimates → bad plans. An estimated-vs-actual row mismatch in `EXPLAIN ANALYZE` is the #1 diagnostic.
- **Foreign-key columns are NOT auto-indexed in Postgres.** Missing FK indexes cause Seq Scans on joins and lock contention on cascades.
- **`EXPLAIN` estimates; `EXPLAIN ANALYZE` actually runs the query.** Add `BUFFERS` to see cache hits vs. disk reads.

## How a B-tree index works

A B-tree is a balanced, sorted tree with a very high fan-out (hundreds of keys per node), so even millions of rows are only ~3–4 levels deep — a lookup is a handful of page reads instead of a full scan.

```
                 [ • M • ]                     ← root
                /        \
        [ • F • ]          [ • T • ]           ← internal nodes
        /   |   \          /   |   \
   leaves: sorted keys → heap tuple pointers (ctid)   ← leaf level (linked)
```

- **Equality lookup:** descend root → leaf, O(log n).
- **Range scan / `ORDER BY`:** find the start leaf, then walk the linked leaf level in sorted order — no separate sort step.
- **Leaf entries point at heap tuples** (the actual row, by `ctid`). An "Index Scan" reads the index _then_ fetches the heap row — two accesses, unless it's an index-only scan.

### What a B-tree can and can't serve

| Can use the index                  | Cannot (or won't)                            |
| ---------------------------------- | -------------------------------------------- |
| `col = ?`, `col IN (...)`          | `LOWER(col) = ?` (needs an expression index) |
| `col < / > / BETWEEN`              | `col LIKE '%abc'` (leading wildcard)         |
| `col LIKE 'abc%'` (prefix)         | `col <> ?` / `NOT IN` (not selective)        |
| `ORDER BY col [LIMIT n]`           | Type-mismatched comparison (forces a cast)   |
| `IS NULL` (Postgres indexes NULLs) | Predicate on a non-leftmost composite column |

## Composite indexes and the leftmost-prefix rule

`CREATE INDEX ix ON orders (merchant_id, status, created_at);` can serve:

- `WHERE merchant_id = ?` ✅
- `WHERE merchant_id = ? AND status = ?` ✅
- `WHERE merchant_id = ? AND status = ? AND created_at > ?` ✅
- `WHERE status = ?` ❌ (skips the leftmost column)
- `WHERE merchant_id = ? AND created_at > ?` ⚠️ uses only the `merchant_id` part, then filters `created_at` without index help (there's a gap at `status`)

**Column-ordering rules:**

1. **Equality columns before range columns.** Once the index hits a range (`>`, `<`, `BETWEEN`), the columns after it can't be used for further index filtering — only for ordering.
   - `WHERE a = ? AND b > ?` → `INDEX(a, b)` ✅
   - `WHERE a > ? AND b = ?` → `INDEX(b, a)` is better (put the equality column `b` first).
2. **Match `ORDER BY`.** An index whose column order (and direction) matches `ORDER BY` lets the planner skip the sort — huge for `ORDER BY … LIMIT n`.
3. **More selective columns earlier** (among the equality columns) helps, though for pure-equality prefixes the benefit is smaller than the equality-before-range rule.

## Specialized index shapes

### Covering index → index-only scan

If the index contains every column the query reads, Postgres can answer from the index alone:

```sql
CREATE INDEX ix ON orders (merchant_id) INCLUDE (status, total);
-- SELECT status, total FROM orders WHERE merchant_id = ?  → Index Only Scan
```

`INCLUDE` columns live in the leaf but aren't part of the key (no ordering cost). **Caveat:** an index-only scan still does a heap fetch if the page isn't marked all-visible in the visibility map — that is, if vacuum is behind (this ties back to MVCC dead tuples; see [Database isolation levels, MVCC, and the anomalies each prevents](/posts/postgres-isolation-levels-and-mvcc/)).

### Partial index → index a hot subset

```sql
CREATE INDEX ix ON jobs (created_at) WHERE status = 'PENDING';
```

Only `PENDING` rows are indexed → smaller, faster, cheaper to maintain. Perfect for queue tables where you only ever query the unprocessed slice.

### Expression / functional index

```sql
CREATE INDEX ix ON users (LOWER(email));
-- needed for: WHERE LOWER(email) = ?   (a plain index on email won't be used)
```

## Index types beyond B-tree

| Type        | Best for                                                                                        | Example                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **B-tree**  | The default — equality + range + ordering                                                       | `WHERE id = ?`, `ORDER BY created_at`                                   |
| **Hash**    | Equality only (rarely worth it; a B-tree is usually as good)                                    | `WHERE token = ?`                                                       |
| **GIN**     | "Contains" over composite values — `jsonb`, arrays, full-text, trigram                          | `WHERE tags @> '{sale}'`, `tsvector @@ query`, `%substr%` via `pg_trgm` |
| **GiST**    | Geometric data, ranges, nearest-neighbor                                                        | Geo "within radius", range overlap                                      |
| **BRIN**    | Huge, naturally ordered tables (append-only time series) — stores min/max per block range, tiny | A billion-row events table indexed on `created_at`                      |
| **SP-GiST** | Space-partitioned data (quadtrees, IP ranges)                                                   | Non-balanced data                                                       |

Two practical ones to remember: **GIN** for `jsonb`, full-text, and `%text%` search (with `pg_trgm`, which is how you _do_ serve a leading-wildcard `LIKE`), and **BRIN** for enormous append-only tables where a B-tree would be wastefully large.

## Selectivity — when an index does NOT help

The planner is **cost-based**: it uses table statistics (`ANALYZE` → `pg_statistic`) to estimate how many rows a predicate returns, then picks the cheapest plan.

- **High selectivity** (the predicate returns few rows) → Index Scan wins.
- **Low selectivity** (the predicate returns a large fraction) → **Seq Scan wins**, because many random index→heap lookups cost more than one sequential read of the table.
- Rule of thumb: above ~5–10% of the table, a Seq Scan is usually cheaper — and the planner knows this. **A Seq Scan is not automatically a bug.**

```
WHERE status = 'shipped'   -- 2% of rows  → Index Scan
WHERE active = true        -- 80% of rows → Seq Scan (correct!)
```

**Don't fight the planner** by forcing index use; fix the _inputs_: run `ANALYZE` for fresh stats, raise the statistics target on skewed columns, or rethink whether the query is selective at all.

## Reading EXPLAIN ANALYZE

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ... ;
```

- **`EXPLAIN`** = the plan + cost _estimates_, no execution.
- **`EXPLAIN ANALYZE`** = actually runs the query, showing real timings and **actual** row counts.
- **`BUFFERS`** = shared-buffer hits (cache) vs. reads (disk) — distinguishes "slow plan" from "cold cache".

### Scan nodes

| Node                                     | Meaning                                                                                 | Signal                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Seq Scan**                             | Read the whole table                                                                    | Fine for small tables or low selectivity; a red flag on a big table with a selective `WHERE` |
| **Index Scan**                           | Walk the index, fetch each heap row                                                     | Good for selective predicates returning few rows                                             |
| **Index Only Scan**                      | Answered from the index alone                                                           | Best case — a covering index working                                                         |
| **Bitmap Index Scan + Bitmap Heap Scan** | Collect matching tuple locations into a bitmap, then fetch heap pages in physical order | The sweet spot for _medium_ selectivity, or for combining multiple indexes                   |

### Join nodes

- **Nested Loop** — good when one side is tiny or the inner side has an index; catastrophic as `loops` × a big table.
- **Hash Join** — builds a hash of one side; good for large, unsorted joins.
- **Merge Join** — both inputs sorted (often by an index); good for large sorted joins.

### How to read a node

```
Index Scan using ix_orders_merchant on orders
  (cost=0.43..8.45 rows=1 width=64) (actual time=0.02..0.03 rows=1 loops=1)
   ^estimate                          ^reality
```

- `cost=startup..total` — the planner's abstract cost units (not ms).
- `rows=` (estimate) vs. `actual … rows=` (reality).
- `loops` — how many times this node ran (multiply for the true cost).

### Red flags

- **Estimated vs. actual rows off by orders of magnitude** → stale or insufficient statistics → `ANALYZE` the table (or raise `default_statistics_target`). This is the single most common cause of bad plans.
- **A Seq Scan on a large table** with a selective filter → a missing or unused index. Check `Rows Removed by Filter:` — a huge number means the engine scanned a lot just to discard it.
- **A Nested Loop with high `loops` over a big inner table** → a missing index on the join key.
- **A Sort node spilling to disk** (`Sort Method: external merge Disk:`) → raise `work_mem`, or add an index that provides the order.

## Postgres vs. MySQL: heap vs. clustered index

Worth knowing if you also work with MySQL:

- **Postgres** tables are _heaps_; all indexes are _secondary_ and point to a `ctid`. There's no built-in clustered index (`CLUSTER` is a one-off physical reorder, not maintained).
- **MySQL InnoDB** stores the table _as_ its primary-key B-tree (a clustered index). Secondary indexes store the **PK value**, not a row pointer → a secondary-index lookup does two B-tree descents (secondary → PK). The implication: keep the PK small, and avoid random UUIDv4 as the clustered key — it fragments inserts. This is why time-sortable IDs such as Snowflake or ULID matter.

## Practical workflow

1. Identify the slow query (`pg_stat_statements`, the slow-query log, APM).
2. Run `EXPLAIN (ANALYZE, BUFFERS)` on it.
3. Find the most expensive node (highest `actual time` × `loops`, or a Seq Scan over many rows).
4. Add or adjust an index for the predicate, join, and order columns (mind leftmost-prefix and equality-before-range).
5. Re-run `EXPLAIN ANALYZE` to confirm the plan changed and is faster.
6. Check the **write cost**: more indexes = slower writes + bloat. Drop unused indexes — `pg_stat_user_indexes` where `idx_scan = 0`.

## Gotchas

- **A leading-wildcard `LIKE '%abc'` can't use a B-tree.** Use a `pg_trgm` GIN index for substring search.
- **A function on the indexed column disables the index.** `WHERE LOWER(email)=?` ignores a plain `email` index — add an expression index.
- **Type mismatches silently kill index use.** Comparing a `varchar` column to an integer parameter (or `bigint` vs. `int`) can force a cast that prevents the index from being used. Match types.
- **A composite index is unused without its leftmost column.** `INDEX(a, b)` does nothing for `WHERE b = ?`.
- **Low-selectivity indexes are dead weight.** An index on a 50/50 boolean-like column will almost never be chosen — it just slows writes.
- **Over-indexing slows writes and bloats storage.** Every index is maintained on every write. Audit and drop unused ones.
- **`OR` across different columns** often can't use a single index well — consider a `UNION` of two indexed queries, or rely on a Bitmap Or of two indexes.
- **Foreign keys aren't auto-indexed in Postgres.** Unindexed FK columns → Seq Scans on joins and exclusive-lock contention when the parent row is updated or deleted.
- **`!=` / `NOT IN` / `IS NOT NULL` are usually not index-friendly** (they return most of the table).
- **Stale statistics produce bad plans.** After a big bulk load, run `ANALYZE` before trusting plans; otherwise rely on autovacuum/autoanalyze.
- **An index-only scan can still hit the heap** if the page isn't all-visible (vacuum lag) — the `Heap Fetches:` line in `EXPLAIN ANALYZE` shows how often.
- **`cost` units are not milliseconds.** Don't compare `cost` to a latency budget; use `actual time` from `EXPLAIN ANALYZE`.
- **`CREATE INDEX` blocks writes; use `CREATE INDEX CONCURRENTLY` in production** (slower, but no exclusive lock). Note that it can't run inside a transaction — relevant when running it through migration tools like Flyway or Alembic.

## References

- Earlier in this topic: [Database isolation levels, MVCC, and the anomalies each prevents](/posts/postgres-isolation-levels-and-mvcc/) — MVCC dead tuples and the visibility map (why index-only scans sometimes still hit the heap).
- Earlier in this topic: [How autovacuum executes, and why it falls behind](/posts/postgres-autovacuum-execution-and-tuning/) — why index count is also a vacuum cost.
- Markus Winand, [_Use The Index, Luke_](https://use-the-index-luke.com/) — the canonical practical reference on B-tree indexing.
- PostgreSQL documentation: [Indexes](https://www.postgresql.org/docs/current/indexes.html) and [Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html).
