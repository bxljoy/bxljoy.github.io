---
title: "How autovacuum executes, and why it falls behind"
description: "Vacuum's three phases, the maintenance_work_mem cliff, the trigger formula that waits for 200 million dead tuples on a billion-row table, autovacuum's self-throttling, and how to tune it per table."
pubDatetime: 2026-09-29T20:26:00+02:00
tags: [postgres, vacuum, mvcc, performance]
sourceNotes: [postgres-autovacuum-execution-and-tuning]
---

> Vacuum is **three phases**, not one: scan the heap collecting dead TIDs → scan **every index in full** to remove those TIDs → return to the heap to free the line pointers. Phase 2 dominates, scales with index count, and if the dead-TID list outgrows `maintenance_work_mem` the whole index scan **repeats from scratch** — the difference between a one-hour and a one-day vacuum. Separately, autovacuum deliberately **throttles itself** (`vacuum_cost_limit` 200 / `cost_delay` 2ms) with defaults tuned for spinning disks, and only _triggers_ at `50 + 0.2 × reltuples` dead tuples — which on a billion-row table means waiting for 200 million. Reclaimed space is **reused inside the table, not returned to the OS**.

## Table of contents

## Overview

[Postgres long-running transactions and VACUUM bloat](/posts/postgres-long-transactions-and-vacuum-bloat/) covers when vacuum is **allowed** to reclaim — the `xmin` horizon, and why one long transaction blocks cleanup database-wide. This post is the other half: **how vacuum actually runs, and why it's slow or falls behind even when nothing is pinning the horizon.**

Those are the two distinct diagnoses behind every real bloat incident, and they need opposite fixes:

- **Horizon problem** → find and kill the open transaction; tuning autovacuum harder achieves nothing.
- **Execution problem** → the horizon is fine, vacuum is simply running too slowly or starting too late, and tuning is exactly the answer.

Establish which one you have _before_ changing settings.

Vacuum is also a **write-heavy workload** in its own right: every phase dirties pages and emits WAL, which flows through the same path as any other write (see [Postgres WAL, the durability write path, and checkpoints](/posts/postgres-wal-durability-and-checkpoints/)).

## Key points

- **Three phases, and the middle one dominates.** Phase 2 scans _every index on the table, end to end_. Vacuum cost scales with index count, just like insert cost does.
- **`maintenance_work_mem` overflow is the classic pathology.** If the collected dead TIDs don't fit, vacuum runs phases 2 and 3, resumes the heap scan, and **re-scans every index again**. `index_vacuum_count > 1` in `pg_stat_progress_vacuum` is the tell.
- **The trigger formula is `autovacuum_vacuum_threshold (50) + autovacuum_vacuum_scale_factor (0.2) × reltuples`.** The 20% scale factor is sane at 10k rows and absurd at 10⁹ — always override it per table on large tables.
- **Insert-only tables were never autovacuumed before PG13.** `autovacuum_vacuum_insert_threshold` (1000) exists precisely for append-only and event tables, which generate no dead tuples and so never tripped the old trigger.
- **Autovacuum throttles itself on purpose.** After `vacuum_cost_limit` (200) credits of page access it sleeps for `autovacuum_vacuum_cost_delay` (2ms). On NVMe this is very often _the_ reason it can't keep up.
- **Space is reused, not returned.** Only trailing all-empty pages are truncated back to the OS. Everything else is reclaimed _for reuse inside the relation_ — which is why bloat is sticky.
- **`VACUUM FULL` is a different operation**, not "vacuum but harder": it rewrites the table under an `ACCESS EXCLUSIVE` lock. `pg_repack` achieves the same result mostly online.
- **A tuple is not dead when it's deleted.** `DELETE` sets `t_xmax`; the tuple becomes removable only once `t_xmax` is committed and older than `OldestXmin`. Until then it's _recently dead_.
- **Vacuum maintains the visibility map**, which is what makes **index-only scans** possible — so when vacuum falls behind, index-only scan plans silently degrade to heap fetches.
- **Anti-wraparound autovacuum does not auto-cancel.** Normal autovacuum workers yield when they block a conflicting lock; anti-wraparound ones don't. That asymmetry is why they take down under-tuned large tables.
- **`PARALLEL` index vacuuming (PG13+) applies to manual `VACUUM` only** — autovacuum never uses it.

## The three phases

```
Phase 1 — scan heap
    · skip pages marked all-visible in the visibility map (cheap on static tables)
    · prune + defragment pages as it goes
    · collect TIDs of dead tuples into memory (maintenance_work_mem / autovacuum_work_mem)
    · "dead" = t_xmax committed AND older than OldestXmin   ← the horizon gate

Phase 2 — vacuum indexes                        ◄── usually the bottleneck
    · for EACH index: full scan, remove every entry pointing at a collected TID
    · cost scales with (index count × index size), not with dead-tuple count

Phase 3 — vacuum heap
    · now that no index references them, mark line pointers LP_UNUSED
    · the space is finally reusable

Then: update FSM (free space map) and VM (visibility map);
      freeze old xids and advance relfrozenxid;
      optionally truncate trailing empty pages (brief ACCESS EXCLUSIVE).
```

Phase 2 is why _index count is a vacuum tax_, not just an insert tax. It's the same multiplier that shows up in [WAL volume](/posts/postgres-wal-durability-and-checkpoints/) and in insert cost — one design decision, three separate costs.

## The `maintenance_work_mem` cliff

Dead TIDs must be held in memory between phase 1 and phase 2. When that buffer fills, vacuum can't just continue — it must complete phases 2 and 3 for what it has, then resume the heap scan and **do the entire index scan over again**:

```
heap scan ─┬─► [buffer full] ─► ALL indexes ─► heap ─┐
           │                                          │
           └──────────────  resume  ◄─────────────────┘
                     ... ×N passes, N full index scans
```

A vacuum that should take an hour takes a day. **Diagnostic: `index_vacuum_count` in `pg_stat_progress_vacuum` — anything above 1 means you overflowed.** Fix: raise `autovacuum_work_mem` (it falls back to `maintenance_work_mem`, default 64MB — far too small for large tables).

> **Version note:** PG17 replaced the flat TID array with a radix-tree TID store, hugely reducing memory per TID and removing the old ~1GB effective cap. On PG17+ this pathology is largely historical; on anything older it is very much live. `pg_stat_progress_vacuum` column names also changed in PG17 (`num_dead_tuples`/`max_dead_tuples` → `dead_tuple_bytes`/`max_dead_tuple_bytes`); `index_vacuum_count` is stable across versions.

## When a worker is even launched

| Trigger         | Formula                                                                | Default                               |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| Dead tuples     | `autovacuum_vacuum_threshold + scale_factor × reltuples`               | `50 + 0.2 × n`                        |
| Inserts (PG13+) | `autovacuum_vacuum_insert_threshold + insert_scale_factor × reltuples` | `1000 + 0.2 × n`                      |
| ANALYZE         | `autovacuum_analyze_threshold + analyze_scale_factor × reltuples`      | `50 + 0.1 × n`                        |
| Wraparound      | `age(relfrozenxid) > autovacuum_freeze_max_age`                        | 200M — **aggressive, non-cancelling** |

The 0.2 scale factor is the footgun: a 1-billion-row table waits for **200 million dead tuples** before a worker starts, by which point the vacuum is enormous and the bloat is already there. On any large, high-churn table, override it.

Also: `autovacuum_max_workers` is **3** by default, and `autovacuum_naptime` is 1min. Three workers isn't much if you have many large tables — a single huge table can occupy one worker for hours while the others queue.

## The self-throttling nobody expects

Autovacuum accumulates cost credits for every page it touches (`vacuum_cost_page_hit`, `_page_miss`, `_page_dirty` — dirtying is by far the most expensive). Once it exceeds `vacuum_cost_limit` (200) it **sleeps** for `autovacuum_vacuum_cost_delay` (2ms since PG12; it was 20ms before, and old blog posts still reflect that).

These defaults assume a modest server on spinning disks. On a provisioned-IOPS or NVMe instance they cap autovacuum at a small fraction of the available throughput. If autovacuum "never finishes" on a big table and the horizon is clean, check this _before_ anything else.

> PG14+ adds a **failsafe** (`vacuum_failsafe_age`): once wraparound risk becomes acute, vacuum abandons index cleanup and disables the cost delay entirely to race to completion. Seeing it activate in the logs means you were already dangerously behind.

## Tuple states, precisely

Every heap tuple header carries `t_xmin` (creator), `t_xmax` (deleter), and `t_ctid` (pointer to the next version).

- **INSERT** → `t_xmin = myXid`, `t_xmax = 0`
- **DELETE** → sets `t_xmax = myXid`. The row is _still physically present and still visible_ to older snapshots.
- **UPDATE** → atomically both: the old tuple gets `t_xmax` + `t_ctid` → new tuple; the new tuple gets `t_xmin`. This forms a **version chain** that readers walk forward.

The state that matters for vacuum:

| State             | Meaning                                | Removable?                                        |
| ----------------- | -------------------------------------- | ------------------------------------------------- |
| Live              | Visible to some snapshot               | No                                                |
| **Recently dead** | `t_xmax` committed, but ≥ `OldestXmin` | **No** — this is where horizon-pinned bloat lives |
| Dead              | `t_xmax` committed and < `OldestXmin`  | Yes                                               |

HOT updates change this picture substantially: they create no new index entries, and the old versions can be cleaned by opportunistic pruning without vacuum at all.

## Seeing what vacuum is doing

```sql
-- what phase is a running vacuum in, and did it overflow memory?
SELECT c.relname, p.phase, p.index_vacuum_count,
       p.heap_blks_scanned, p.heap_blks_total,
       round(100.0 * p.heap_blks_scanned / NULLIF(p.heap_blks_total,0), 1) AS pct
FROM pg_stat_progress_vacuum p
JOIN pg_class c ON c.oid = p.relid;
-- index_vacuum_count > 1  ⇒  maintenance_work_mem too small

-- is autovacuum keeping up at all?
SELECT relname, n_live_tup, n_dead_tup,
       last_autovacuum, autovacuum_count,
       last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;

-- wraparound headroom (watch against autovacuum_freeze_max_age = 200M)
SELECT relname, age(relfrozenxid) AS xid_age
FROM pg_class WHERE relkind = 'r'
ORDER BY age(relfrozenxid) DESC LIMIT 20;
```

The phases are reported as: `scanning heap` → `vacuuming indexes` → `vacuuming heap` → `cleaning up indexes` → `truncating heap`. Parked in `vacuuming indexes` for hours = phase 2, as expected.

## Per-table tuning for a large, high-churn table

```sql
ALTER TABLE big_table SET (
  autovacuum_vacuum_scale_factor        = 0.01,   -- 1% not 20%
  autovacuum_vacuum_threshold           = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.02,   -- PG13+, append-heavy tables
  autovacuum_vacuum_cost_delay          = 0       -- don't throttle on fast storage
);
```

The global companion: raise `autovacuum_work_mem` (e.g. 1GB on a large instance), and consider raising `autovacuum_max_workers` if many big tables compete.

## Why partitioning helps here too

Autovacuum operates **per partition**, not per logical table. So partitioned event and log tables get, for free:

- vacuum in small units that fit comfortably in `autovacuum_work_mem` — no phase-2 re-scans
- multiple partitions vacuumed concurrently by different workers
- old, closed partitions frozen **once** and then never touched again
- retention by `DROP`/`DETACH` — no dead tuples generated at all, so no vacuum work whatsoever

That last point closes the loop with events-table design: `DELETE`-based retention creates exactly the bloat that vacuum then has to work through, while dropping partitions bypasses the entire machinery. See the `DELETE` vs `DROP PARTITION` gotcha in [the WAL post](/posts/postgres-wal-durability-and-checkpoints/).

## Gotchas

- **Two different diagnoses, opposite fixes.** Horizon-pinned (see [the long-running transactions post](/posts/postgres-long-transactions-and-vacuum-bloat/)) → tuning autovacuum is useless; find the open transaction. Execution-bound → tuning is exactly right. Check `pg_stat_activity` for an old `xact_start` _first_; it takes seconds and decides everything downstream.
- **`n_dead_tup` stops rising but the bloat stays.** Expected. Vacuum makes space _reusable_; it doesn't shrink the file. Only `VACUUM FULL` / `pg_repack` return space to the OS.
- **`VACUUM FULL` on a live table is an outage.** It holds `ACCESS EXCLUSIVE` for the duration of a full table rewrite, and it needs disk space for a second copy. Reach for `pg_repack` instead.
- **Adding an index costs you twice.** Once on every write, and once on every vacuum's phase 2. The read benefit has to clear both bars.
- **Index-only scans quietly degrade when vacuum lags.** The visibility map goes stale, so the planner's index-only scan must fetch heap pages anyway. A query that "randomly got slower" with no plan change is often this.
- **Anti-wraparound vacuum won't step aside.** Regular autovacuum cancels itself when it blocks a conflicting lock request; anti-wraparound does not. A DDL migration waiting behind one can stall an entire deploy.
- **`autovacuum = off` is almost never the right answer**, including "temporarily during a bulk load". Wraparound protection is not optional; disabling it defers a much worse event.
- **PG12 and older: insert-only tables are never autovacuumed.** No dead tuples ⇒ the trigger never fires ⇒ the table sails along until anti-wraparound scans the whole thing at once, years later, with no visibility-map skipping. Directly relevant to any append-only events table.
- **`autovacuum_work_mem` defaults to `-1`**, meaning it inherits `maintenance_work_mem` — so raising the latter for index builds silently changes autovacuum behaviour too. Set them independently if you care.
- **Manual `VACUUM (PARALLEL n)` exists; autovacuum never uses it.** Don't assume a hand-run vacuum's timing predicts autovacuum's.

## References

- [Postgres long-running transactions and VACUUM bloat](/posts/postgres-long-transactions-and-vacuum-bloat/) — the other half: the `xmin` horizon, and when vacuum is _permitted_ to reclaim.
- [Postgres WAL, the durability write path, and checkpoints](/posts/postgres-wal-durability-and-checkpoints/) — vacuum's output is WAL plus dirty pages on the same durability path; `DELETE` vs `DROP PARTITION`.
- [Database isolation levels, MVCC, and the anomalies each prevents](/posts/postgres-isolation-levels-and-mvcc/) — the MVCC visibility rules that `OldestXmin` derives from.
- PostgreSQL documentation: [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- PostgreSQL documentation: [`pg_stat_progress_vacuum`](https://www.postgresql.org/docs/current/progress-reporting.html#VACUUM-PROGRESS-REPORTING)
- PostgreSQL documentation: [Automatic Vacuuming configuration](https://www.postgresql.org/docs/current/runtime-config-autovacuum.html)
