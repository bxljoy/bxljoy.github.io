---
title: "Postgres long-running transactions and VACUUM bloat"
description: "Why one open transaction — even an idle one — stops VACUUM from reclaiming dead tuples across the whole database, how to spot the transaction pinning the horizon, and the guardrails that prevent it."
pubDatetime: 2026-09-29T19:15:00+02:00
tags: [postgres, mvcc, vacuum, performance]
sourceNotes: [postgres-long-running-transactions-and-vacuum-bloat]
---

> An open transaction pins the **xmin horizon**: VACUUM may not reclaim any dead tuple newer than the _oldest_ in-progress transaction's snapshot. So one long-running transaction — even an _idle_ one holding a connection — quietly blocks cleanup across the whole database, and a high-churn table (lots of `UPDATE`/`DELETE`) bloats without bound: table and index files grow, scans slow down, the disk fills. The classic trigger is **holding a transaction open across non-DB work** — an HTTP call, view rendering (OSIV), a slow external step. The fix: keep transactions short (claim-then-process), and set `idle_in_transaction_session_timeout` and `statement_timeout` as guardrails.

## Table of contents

## Overview

Postgres is MVCC: an `UPDATE` doesn't overwrite a row, it writes a **new tuple** and marks the old one dead; a `DELETE` marks it dead. `VACUUM` later reclaims dead tuples for reuse. The catch: a dead tuple can only be reclaimed once **no running transaction could still need to see it** — that is, once it's older than the oldest active snapshot. A transaction that stays open for minutes (or an app that `BEGIN`s and then waits on something slow) freezes that horizon, and dead tuples pile up as **bloat**.

This post explains the mechanism, how to see it, and how to avoid it. It's the "why" behind the claim-then-process rule for worker and delivery pipelines, and the same failure mode as Open Session In View (OSIV).

## Key points

- **VACUUM's reclaim boundary is the oldest snapshot, database-wide.** One old transaction anywhere holds the `xmin` horizon back for _every_ table, not just the one it touched.
- **Idle-in-transaction is as bad as busy.** It's not about work done — an open transaction holding a snapshot (even doing nothing) pins the horizon and a connection.
- **Bloat scales with churn.** A hot table (an `UPDATE` per status change, frequent `DELETE`s) generates dead tuples fast; block VACUUM and it bloats fast. Cold tables barely notice.
- **The trigger is almost always "transaction held across non-DB work"** — an HTTP call, a message send, a view render (OSIV), user think-time. The transaction should _bracket the DB writes_, nothing slower.
- **Symptoms:** table/index size far larger than live-row size, a climbing dead-tuple ratio, autovacuum reporting "found N dead rows but cannot remove", slowing sequential and index scans, disk creep, occasional wraparound-risk warnings.
- **Fixes:** short transactions (claim-then-process); `idle_in_transaction_session_timeout`; `statement_timeout`; keep slow I/O _outside_ the transaction; batch writes rather than holding a transaction open.

## Mechanism

```
UPDATE deliveries SET status='success' WHERE id=42;
   old tuple (status='in_progress')  → marked dead (dead xmax set)
   new tuple (status='success')      → inserted, visible

VACUUM can reclaim the dead tuple only when:
   dead tuple's xmax  <  oldest running transaction's snapshot xmin
                           ▲
             one long-open txn keeps this LOW → nothing newer than it is reclaimable
```

So a single transaction that opened 10 minutes ago means VACUUM can't reclaim _anything_ that died in the last 10 minutes — across the database. On a table doing hundreds of `UPDATE`s per second, that's hundreds of thousands of unreclaimable dead tuples, and the heap and every index grow to hold them.

## The canonical anti-pattern: a transaction across a slow call

```java
// BAD: transaction spans the HTTP call
@Transactional
void deliver(Batch b) {
    var rows = claimForUpdate(b);      // BEGIN … SELECT FOR UPDATE
    httpClient.post(rows);             // ← seconds; txn still open, snapshot pinned, conn held, rows locked
    markResults(rows);                 // COMMIT
}

// GOOD: claim-then-process — txn brackets only the DB writes
void deliver(Batch b) {
    var rows = txn(() -> claimAndMarkInProgress(b));  // BEGIN…COMMIT in ms → horizon released
    var results = httpClient.post(rows);              // slow work holds NO snapshot/lock/conn
    txn(() -> writeResults(results));                 // BEGIN…COMMIT in ms
}
```

It's the same lesson as OSIV: Open Session In View holds the DB transaction open across _view rendering_; here it's across _HTTP delivery_. A different slow step, identical horizon-pinning damage.

## Seeing it

```sql
-- longest-running / idle-in-transaction sessions (the horizon pinners)
SELECT pid, state, now()-xact_start AS txn_age, now()-state_change AS since, query
FROM pg_stat_activity
WHERE state <> 'idle' OR state = 'idle in transaction'
ORDER BY xact_start ASC NULLS LAST;

-- bloat proxy: dead tuples vs live
SELECT relname, n_live_tup, n_dead_tup,
       round(100*n_dead_tup/GREATEST(n_live_tup+n_dead_tup,1),1) AS dead_pct,
       last_autovacuum
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC;
```

A `txn_age` measured in minutes is a red flag for an OLTP workload; a persistent one is a bloat generator.

If `pg_stat_activity` looks clean but bloat still climbs, the pinner is **remote** — a standby with `hot_standby_feedback = on`, or an abandoned replication slot:

```sql
-- standbys reporting an xmin upstream (hot_standby_feedback)
SELECT client_addr, state, backend_xmin, age(backend_xmin) AS xmin_age
FROM pg_stat_replication
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC;

-- slots pin the horizon even with nothing connected
SELECT slot_name, active, xmin, catalog_xmin, age(xmin) AS xmin_age
FROM pg_replication_slots
ORDER BY age(xmin) DESC NULLS LAST;
```

## Guardrails

- **`idle_in_transaction_session_timeout`** (e.g. `30s`) — Postgres kills sessions that `BEGIN` and then sit. This is the single best safety net against application bugs that leak open transactions.
- **`statement_timeout`** — caps runaway statements.
- **Short transactions by design** — do external I/O outside the transaction, batch DB writes, commit promptly.
- **Tune autovacuum only _after_ removing the pinner** — a more aggressive autovacuum can't reclaim what an open snapshot forbids.

## Gotchas

- **The bloat is database-wide, not table-local.** A long transaction reading table A blocks reclaim of dead tuples in unrelated table B.
- **"It's just idle, it's fine" — no.** `idle in transaction` still holds the snapshot. Idle-in-transaction is the sneakiest pinner, because nothing looks busy.
- **Making VACUUM/autovacuum more aggressive won't help** while a snapshot is pinned — that treats the symptom. Find the open transaction.
- **Connection-pool interaction:** a transaction held across slow I/O also holds a pooled connection the whole time, so connection-pool exhaustion rides along with the bloat.
- **`hot_standby_feedback = on` lets a _replica's_ queries pin the _primary's_ horizon** — and it's the nastiest variant, because the pinner is on another machine and `pg_stat_activity` on the primary shows nothing. The path there is predictable: a long analytics query on the standby gets killed by `canceling statement due to conflict with recovery` → someone enables `hot_standby_feedback` to stop the cancellations → the standby now reports its oldest xmin upstream, and the primary stops reclaiming. The trade-off is explicit: **cancel queries on the replica (`max_standby_streaming_delay`, default 30s) or bloat the primary.** Check `pg_stat_replication.backend_xmin`, not just `pg_stat_activity`. Abandoned **replication slots** pin the horizon the same way (`pg_replication_slots.xmin`), even with no query running at all.
- **Wraparound is the extreme tail.** In pathological cases, long-open transactions can block freezing and push toward transaction-ID wraparound — loud warnings, then a forced shutdown. Rare, but it's the same root cause.

## References

- Earlier in this topic: [Database isolation levels, MVCC, and the anomalies each prevents](/posts/postgres-isolation-levels-and-mvcc/) — how MVCC creates the dead tuples this post is about.
- PostgreSQL documentation: [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
