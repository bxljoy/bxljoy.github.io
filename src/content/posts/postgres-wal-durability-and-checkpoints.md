---
title: "Postgres WAL, the durability write path, and checkpoints"
description: "What the write-ahead rule really guarantees, when WAL and dirty pages actually reach disk, how buffer eviction and checkpoints work, and why WAL volume spikes after every checkpoint."
pubDatetime: 2026-09-29T17:30:00+02:00
tags: [postgres, wal, durability, performance]
sourceNotes: [postgres-wal-durability-path-and-checkpoints]
---

> The write-ahead rule is a **disk-ordering** invariant, not a memory-ordering one: pages are modified in RAM _before_ any WAL touches disk, and what's actually forbidden is flushing a dirty page whose WAL isn't durable yet — enforced per page via `pd_lsn` + `XLogFlush`. Two separate guarantees hide behind "WAL": the **commit rule** (at `COMMIT`, block until WAL up to the commit LSN is fsync'd) and the **write-ahead rule** (never write a data page ahead of its WAL). WAL reaches disk at three moments, dirty pages are written by three actors, and full-page writes explain why WAL volume spikes right after every checkpoint.

## Table of contents

## Overview

Every durability, replication, and write-throughput question in Postgres bottoms out in the same machinery: shared buffers, the WAL buffer, the commit fsync, and the checkpointer. The textbook one-liner — _"the log is written before the data"_ — is **too loose to reason with**. This post covers the precise version: what happens in memory vs. on disk, what enforces the ordering, who writes what and when, and the operational traps (`max_wal_size` is not a cap; post-checkpoint WAL spikes; `synchronous_commit=off` semantics).

It's useful for diagnosing WAL-volume and checkpoint-I/O spikes, and for reasoning about write cost in append-heavy designs such as event tables.

## Key points

- **The write-ahead rule is about disk-write ordering, not memory.** A page is modified in shared buffers _before_ any WAL is on disk. The invariant is: **a dirty page may never be flushed to a data file ahead of the WAL describing its change.**
- **Two distinct guarantees, often conflated:**
  - _Commit rule_ — at `COMMIT`, the backend blocks until WAL up to its commit LSN is fsync'd (durability of a transaction).
  - _Write-ahead rule_ — the checkpointer, background writer, or a backend forces `XLogFlush(page.pd_lsn)` before writing any page (recoverability of data files).
- **Shared buffers is primarily a _read_ cache.** Dirty pages are a small subset; most buffers are clean pages cached to avoid disk reads. It's one pool serving both roles.
- **`wal_buffers` is tiny by comparison** — the default `-1` means 1/32 of `shared_buffers`, minimum 64kB, **capped at one WAL segment (16MB)**. Think of it as a big page cache plus a small staging ring, not "two halves of shared memory".
- **WAL reaches disk at three moments:** the WAL buffer fills mid-transaction, the WAL writer's timer fires (`wal_writer_delay`, default 200ms), or `COMMIT`. Commit is where it's _forced and waited on_ — not where writing begins.
- **A commit flush includes other transactions' interleaved records** (it flushes _up to an LSN_). That's the basis of **group commit**: one fsync satisfies many committing backends.
- **Three actors write dirty pages:** the checkpointer, the background writer, and — the bad case — a backend that needs a free buffer and finds none clean.
- **Buffer replacement is a _clock sweep_, not LRU** (`usage_count` 0–5, second-chance decrement). Dirty pages don't consume _extra_ buffer space — they're dirtied in place. The read/write contention people feel is that a **dirty victim must be written (and its WAL flushed) before eviction**, so a `SELECT` pays for someone else's `UPDATE`.
- **Full-page writes:** the first modification of a page after a checkpoint writes the whole 8KB page into WAL (torn-page protection). This is why **WAL volume spikes right after every checkpoint**.
- **`max_wal_size` is a soft checkpoint trigger, not a disk cap.** `pg_wal` can still fill up (lagging archiver, replication slots, `wal_keep_size`).
- **`synchronous_commit=off` loses the last fraction of a second of commits but does _not_ corrupt data or violate consistency.** Recovery still yields a valid state.
- **Autovacuum has three jobs**, not two: dead-tuple cleanup, `ANALYZE` statistics, and **freezing to prevent 32-bit transaction-ID wraparound**.

## The write path, precisely

For a single `UPDATE` inside a transaction:

```
1. Pin + lock the target page in shared buffers
     (read it from disk first if not cached; INSERT is identical —
      consult the FSM for a page with free space, or extend the relation)
2. Modify the page IN MEMORY
3. Write the WAL record into the WAL buffer (in memory) → obtain its LSN
4. Stamp that LSN into the page header (pd_lsn); mark the page dirty
5. Unlock
```

**Nothing has touched disk yet.** Steps 2 and 3 both happen in RAM, and step 2 does not wait for step 3 to reach storage.

```
Client
  │
  ▼
[Shared memory]
  Shared buffers ──── dirty page (pd_lsn stamped)
  WAL buffer     ──── redo records
  │                        │
  │  COMMIT: fsync WAL up to commit LSN ──► pg_wal/  (sequential, append-only)
  │  ── client gets "success" ────────────┘
  │
  └─ later: checkpointer / bgwriter / backend
        │  must first XLogFlush(page.pd_lsn)
        ▼
      base/  (data files; fsync'd at checkpoint)
```

## What actually enforces "write-ahead"

This is the piece almost every summary omits. Page flushing is **not** freely asynchronous — it is _ordered behind_ WAL durability, page by page:

> Before any process writes a dirty page to a data file, it reads the page header's `pd_lsn` and calls `XLogFlush(pd_lsn)`, forcing WAL up to that LSN to disk if it isn't already there.

Consequence: **any change visible in a data file is guaranteed to have its redo record already on disk.** That single check is what makes crash recovery possible — replay can always reconstruct forward from the last checkpoint.

## Shared memory layout

| Region                     | Holds                                                  | Notes                                                                               |
| -------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **Shared buffers**         | 8KB pages of tables, indexes, and _all_ relation forks | Read cache **and** write workspace; dirty pages are a subset. Typically ~25% of RAM |
| **WAL buffer**             | Redo records waiting to be written                     | Default 1/32 of `shared_buffers`, **max 16MB** (one segment)                        |
| **CLOG / subtrans**        | Transaction commit/abort status                        | Needed by MVCC visibility checks                                                    |
| **Lock tables, ProcArray** | Heavyweight locks, LWLocks, session state              | Coordination, not data                                                              |

The **FSM (free space map)** and **VM (visibility map)** are _not_ a separate memory region. They're extra **forks of the relation on disk**, cached in shared buffers like any other page. CLOG and the lock tables _are_ genuinely separate; FSM and VM are not.

## When WAL reaches disk

| Trigger          | Blocking?       | Notes                                                                                   |
| ---------------- | --------------- | --------------------------------------------------------------------------------------- |
| WAL buffer fills | no (background) | A 10GB bulk update does not hold 10GB of WAL in RAM — it spills continuously            |
| WAL writer timer | no              | `wal_writer_delay`, default 200ms; reduces work at commit time and serves async commits |
| `COMMIT`         | **yes**         | The backend blocks until WAL up to its commit LSN is durable                            |

Two mechanics worth naming:

- **`write()` then `fsync()`** — a WAL "flush" is a write into the OS page cache followed by an fsync. `wal_sync_method` selects the syscall strategy (`fdatasync` is the usual Linux default).
- **Group commit** — because the flush targets an LSN, concurrent committers riding the same fsync all become durable together. `commit_delay` / `commit_siblings` deliberately trade a little latency for far fewer fsyncs under high commit rates.

## Who writes dirty pages

| Writer                | When                                                               | Signal                                                                               |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Checkpointer**      | At checkpoints, spread over `checkpoint_completion_target` (0.9)   | Normal                                                                               |
| **Background writer** | Continuously, keeping clean buffers available for reuse            | Normal                                                                               |
| **A backend itself**  | It needs a free buffer and none is clean → it must write one first | **Bad** — your query pays for someone else's dirty page                              |
| VACUUM / autovacuum   | While cleaning pages                                               | Uses a small **256kB ring buffer** so it doesn't evict the application's working set |

A rising count of backend-written buffers (`pg_stat_bgwriter.buffers_backend`, or `pg_stat_io` in newer versions) means `shared_buffers` and/or the background writer are under-configured.

## Buffer eviction: clock sweep, and why a dirty victim hurts reads

This is the mechanism behind the "bad case" row above, and it's the real shape of read/write contention inside one instance.

**Replacement is a clock sweep, not LRU.** There is no recency list and no timestamps. Each buffer carries a `usage_count` (0–5), and a sweep hand rotates around the pool:

```
at each buffer:
    pinned (refcount > 0)  → skip
    usage_count > 0        → decrement, move on      ← the "second chance"
    usage_count == 0       → victim
```

(A freelist of genuinely free buffers is consulted first, but it's normally empty on a warm server.) Postgres used true LRU historically, then ARC/2Q in 8.0, and moved to the clock sweep in 8.1 — **maintaining the LRU ordering list was itself a lock-contention bottleneck** under concurrency.

**Dirty pages do not consume extra buffer space.** A page is dirtied _in place_ — the write already had to bring it into memory (or extend the relation into it). So the common mental model "dirty pages accumulate and squeeze the read cache out via LRU" is wrong on both halves.

What actually hurts:

| Victim    | Cost to evict                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------ |
| Clean     | Free — just overwrite the buffer                                                                       |
| **Dirty** | `XLogFlush(pd_lsn)` **then** write the page — synchronously, in whichever backend drew the short straw |

Under write load the sweep meets dirty buffers more often, and a **reader** ends up performing a write plus a WAL flush inside its own query. That is what "reads and writes contend for shared buffers" really means — an eviction-cost problem, not a capacity problem. There _is_ a secondary capacity effect (buffers holding the write set aren't holding hot read pages), but the latency you feel is the forced flush.

**Bulk operations are exempt.** Postgres assigns _buffer access strategies_ — small rings that recycle their own buffers instead of evicting the working set:

| Strategy        | Ring   | Used by                                                      |
| --------------- | ------ | ------------------------------------------------------------ |
| `BAS_BULKREAD`  | 256 kB | Sequential scans of tables larger than ¼ of `shared_buffers` |
| `BAS_BULKWRITE` | 16 MB  | `COPY`, `CREATE TABLE AS`, `ALTER TABLE` rewrites            |
| `BAS_VACUUM`    | 256 kB | (Auto)vacuum                                                 |

So a bulk load does **not** flush your cache. High-frequency small OLTP writes use the normal pool and do compete — that's the workload where this contention actually shows up.

**Sizing note:** a `shared_buffers` miss is usually served by the **OS page cache**, not physical disk — Postgres deliberately treats the OS cache as a second tier. This is why setting `shared_buffers` to 80% of RAM is an anti-pattern: it starves the OS cache and double-buffers the same pages. About 25% is the conventional starting point.

Mitigations, in order of cost:

1. Tune the **background writer** so clean buffers are always available (attacks the mechanism directly).
2. Raise `checkpoint_timeout` / `max_wal_size`.
3. Cut write amplification at the source: fewer indexes, restore HOT updates, batch writes.
4. **Partition**, so the write working set is a small, recent partition.
5. Add a read model, so the read path never touches the hot table.

A read replica also works, but it relocates the workload rather than shrinking it — and the standby replays the same WAL, so it dirties its own buffers too.

## Checkpoints

A checkpoint flushes all dirty buffers, fsyncs the data files, and records the checkpoint LSN in `pg_control` — establishing a point that recovery can start from. It's triggered by `checkpoint_timeout` (default 5min), by WAL volume reaching `max_wal_size` (default 1GB), by an explicit `CHECKPOINT`, or by shutdown. WAL segments entirely older than the checkpoint LSN — and not needed by archiving or a replication slot — are then **deleted or recycled** (renamed for reuse, governed by `min_wal_size`).

## Full-page writes → post-checkpoint WAL spikes

With `full_page_writes = on` (the default), the **first** modification of a given page after a checkpoint writes a **full 8KB page image** into WAL, not just the change. The reason: a crash mid-write can leave a torn 8KB block (partially updated across disk sectors), which no delta record could repair — replay needs a known-good base image.

The practical consequence: **WAL generation is bursty by design** — high right after a checkpoint, tapering off as pages get their first touch. Frequent checkpoints make this much worse (more first-touches per unit of time). If someone asks "why is our WAL volume so spiky?", this is usually the answer.

## LSN and page-level bookkeeping

The **LSN (Log Sequence Number)** is a 64-bit byte offset into the logical WAL stream, printed like `0/16B3718`. Each 8KB page header carries `pd_lsn`, the LSN of the last WAL record that modified it. That one field links the two subsystems together and makes the write-ahead check a cheap local comparison.

## Config reference

| Parameter                                             | Meaning                                                        | Trap                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `wal_level`                                           | `minimal` / `replica` (default) / `logical`                    | Logical decoding needs `logical`; changing it requires a restart |
| `synchronous_commit`                                  | `on` (default), `remote_write`, `remote_apply`, `local`, `off` | `off` = lose recent commits, **not** corruption                  |
| `max_wal_size`                                        | **Soft** WAL target that triggers a checkpoint                 | **Not a disk cap** — see Gotchas                                 |
| `min_wal_size`                                        | How much WAL to recycle rather than delete                     | Avoids re-allocating segments under bursty load                  |
| `wal_buffers`                                         | Staging ring size                                              | `-1` = auto, capped at one 16MB segment                          |
| `wal_writer_delay`                                    | Background WAL flush interval (200ms)                          | Interacts with async commit's loss window                        |
| `checkpoint_timeout` / `checkpoint_completion_target` | Checkpoint cadence and spreading                               | Short timeouts → more full-page writes                           |
| `full_page_writes`                                    | Torn-page protection                                           | Only safe to disable on storage with atomic 8KB writes           |
| `archive_mode` / `archive_command`                    | WAL archiving for point-in-time recovery                       | A failing archiver **fills `pg_wal`**                            |

## Why WAL exists at all

- **Random I/O → sequential I/O.** Scattered data-page updates become one append-only stream. Commit latency is bounded by a sequential fsync, and the expensive random writes are deferred and batched by the checkpointer.
- **Crash recovery, replication, and point-in-time recovery from one artifact.** Replaying from the last checkpoint restores committed-but-unflushed work; streaming the same records to standbys gives replication; a base backup plus archived WAL gives point-in-time recovery.

## Gotchas

- **"WAL is written to disk before the page is modified" is wrong.** The page is modified in memory first; only the _disk write_ of that page is ordered behind WAL durability.
- **`max_wal_size` is not a ceiling on `pg_wal`.** It's a checkpoint trigger. WAL can far exceed it when the archiver is failing, a **replication slot** is holding segments (an abandoned slot is the classic disk-full incident), or `wal_keep_size` retains them. Monitor `pg_replication_slots` and archiver status, not just the setting.
- **`synchronous_commit=off` risks _lost commits_, not corruption.** Recovery produces a consistent state; you lose only the most recent commits (bounded roughly by `wal_writer_delay`). Say "lost transactions", never "corruption" — the distinction matters.
- **"The client gets success right after the local fsync" assumes no synchronous replication.** With `synchronous_standby_names` set, the backend also waits for standby confirmation, so commit latency is no longer purely local.
- **Every index multiplies WAL per insert.** Each index entry is its own WAL record (plus a possible full-page image). This is why append-only and event tables want the _minimum_ number of indexes: extra indexes tax ingest throughput, WAL volume, and replication lag at the same time.
- **Bigger batches are not free.** Larger transactions hold locks longer and generate WAL in bigger bursts, which means more replication lag.
- **`DELETE` is a terrible way to expire data.** Deleting a billion rows writes WAL for every dead row, then autovacuum has to reclaim them, and the table doesn't shrink. `DROP` / `DETACH PARTITION` is a metadata change plus a file unlink — no WAL storm, no vacuum storm, constant time. This alone justifies time-partitioning high-volume event and log tables.
- **Autovacuum also generates WAL.** Tuple cleanup, visibility-map updates, index pruning, and freezing are all logged (so standbys replay them). A deep autovacuum on a high-churn table shows up as a WAL and I/O spike.
- **Autovacuum's third job — freezing — is the one people forget.** Transaction IDs are 32-bit and wrap around; if tuples aren't frozen in time, Postgres enters anti-wraparound emergency mode and eventually refuses writes. Anti-wraparound vacuums **cannot be skipped**, which is why they take down under-tuned large tables.
- **Hint bits can cost WAL too.** With data checksums (or `wal_log_hints`) enabled, hint-bit updates must be WAL-logged — so a pure `SELECT` can generate WAL after a bulk load.

## References

- Previous in this topic: [Database isolation levels, MVCC, and the anomalies each prevents](/posts/postgres-isolation-levels-and-mvcc/) — the MVCC visibility rules that CLOG serves.
- PostgreSQL documentation: [WAL Internals](https://www.postgresql.org/docs/current/wal-internals.html)
- PostgreSQL documentation: [Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal-reliability.html)
- PostgreSQL documentation: [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html) (freezing and wraparound)
- Hatchet, [Use Postgres for your events table](https://hatchet.run/blog/postgres-events-table) — event-table shapes, minimal indexing, partition-based retention.
