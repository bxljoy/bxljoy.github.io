---
title: "Scaling the database: read replicas, partitioning, and sharding"
description: "The data-scaling ladder — vertical, read replicas, partitioning, sharding — what each rung scales, the read-after-write problem replicas create, partition pruning, shard-key choice, what sharding breaks, and resharding."
pubDatetime: 2026-09-30T20:18:00+02:00
tags: [database, sharding, partitioning, replication]
sourceNotes: [scaling-databases-read-replicas-partitioning-sharding]
---

> The data-scaling ladder, climbed only when forced: **vertical** (bigger box) → **read replicas** (scale _reads_; async → replica lag → read-after-write staleness) → **partitioning** (split one big table _within one DB_; partition pruning + cheap archival via `DROP PARTITION`) → **sharding** (split data _across DB servers_; scales _writes_ + storage, but breaks cross-shard joins/transactions/IDs and makes resharding painful). Partitioning ≠ sharding. The shard-key choice is the most consequential, least reversible decision — a bad one gives you hot shards. Most "big database" problems are solved by replicas + partitioning; sharding is the last resort.

## Table of contents

## Overview

When one relational primary stops coping, there's a well-defined escalation path, and the real skill is knowing which rung the problem actually needs — not jumping to sharding because it sounds impressive. This post covers each rung: read replicas and the read-after-write problem they create, in-database partitioning and partition pruning, and full sharding with shard-key selection, the cross-shard problems it introduces, and resharding strategy.

It builds on [CAP, PACELC, and consensus](/posts/cap-pacelc-consistency-and-consensus/) (replication and consistency), multi-AZ failover topology, [indexing and query planning](/posts/database-indexing-and-query-planning/) (partition pruning), and [distributed unique ID generation](/posts/distributed-unique-id-generation/) (why sharding kills auto-increment).

## Key points

- **The ladder: vertical → read replicas → partitioning → sharding.** Each rung is a step change in operational complexity. Climb only when the cheaper rung is exhausted.
- **Read replicas scale READS, not writes.** A write-bound system gets nothing from replicas — that needs sharding.
- **Replicas are async → replica lag → read-after-write staleness.** A user who just wrote to the leader may read stale data from a replica. This must be designed around.
- **Partitioning ≠ sharding.** Partitioning splits one table into pieces _inside a single database_; sharding splits data _across multiple database servers_. People routinely conflate them.
- **Partitioning's wins:** partition pruning (the planner skips irrelevant partitions) and `DROP PARTITION` for instant archival (vs. a slow `DELETE` + vacuum bloat).
- **Sharding scales writes + storage + connections** beyond one machine — at the cost of cross-shard joins, transactions, aggregates, and unique IDs.
- **The shard key is the decision.** It must be high-cardinality, evenly distributed, and present in most queries (so you can route). A skewed key → **hot shards**.
- **Resharding is the operational nightmare.** Mitigate it with consistent hashing or over-provisioned _logical_ shards mapped onto fewer physical nodes.
- **Co-locate related data under the same shard key** to keep transactions and joins within a single shard.
- **NewSQL/distributed SQL (Aurora, Citus, Vitess, CockroachDB, Spanner)** automates most of this — trading some latency and cost for not hand-sharding.

## The scaling ladder

| Rung                              | Scales                               | Complexity | Use when                                                |
| --------------------------------- | ------------------------------------ | ---------- | ------------------------------------------------------- |
| **1. Vertical** (bigger instance) | Everything, to a ceiling             | Trivial    | First move — buys time cheaply                          |
| **2. Caching + read replicas**    | Reads                                | Low–medium | Read-heavy; reads are the bottleneck                    |
| **3. Partitioning**               | Manageability of big tables (one DB) | Medium     | One or a few huge tables, queries scoped by time/tenant |
| **4. Sharding**                   | Writes + storage (many DBs)          | High       | Write throughput / data volume exceeds one node         |

Always climb in order. A surprising number of "we need to shard" situations are solved by a bigger box + read replicas + partitioning.

## Rung 2: Read replicas (read scaling)

The leader takes all writes and streams changes to follower replicas that serve reads.

- **Recap (multi-AZ):** an RDS Multi-AZ standby is _synchronous_, for failover, and **not readable**. Read Replicas are _asynchronous_, **readable**, and for read scaling. They're independent features; you can run both.
- **Replication mechanism:** Postgres uses **WAL streaming** (physical replication) for hot standbys, and **logical replication** for selective / cross-version / CDC use. (MySQL: binlog, row- or statement-based.)
- **The sync vs. async trade-off:** synchronous replication = zero lag, but every commit waits for the replica (a latency + availability cost); asynchronous = fast commits, but the replica trails. Quorum/semi-sync sits between (see the [quorum discussion](/posts/cap-pacelc-consistency-and-consensus/#consensus--how-a-cp-system-actually-agrees) in the CAP post).

### The read-after-write problem

Async replicas lag the leader by milliseconds to seconds (worse under write load). So:

```
User updates profile → write goes to leader
User immediately reloads → read hits a replica → still shows the OLD profile
```

This is a **read-your-writes** violation. Strategies:

| Strategy                               | How                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Read from the leader after a write** | For ~N seconds after a user writes, route _their_ reads to the leader (a sticky-to-leader window)                               |
| **Route by criticality**               | Just-written / critical reads → leader; tolerant reads (search, feeds, analytics) → replica                                     |
| **LSN / write fence**                  | Record the write's WAL position (LSN); only serve from a replica that has caught up to it, else wait or fall back to the leader |
| **Monotonic reads**                    | Pin a user/session to one replica, so reads don't jump backward by hopping between replicas at different lag                    |

### Routing reads in Spring

- `@Transactional(readOnly = true)` is the hint; combine it with an `AbstractRoutingDataSource` that picks a replica datasource for read-only transactions and the primary for writes.
- Aurora exposes a **reader endpoint** that load-balances across replicas (and a writer endpoint for the primary).
- **Replicas double as failover targets** — one can be promoted to leader. They give read capacity _and_ a promotion candidate; they give the write path nothing.

## Rung 3: Partitioning (within one database)

Split one logical table into multiple physical partitions on the **same** instance. Postgres declarative partitioning (10+):

| Strategy  | Partition by                       | Typical use                                |
| --------- | ---------------------------------- | ------------------------------------------ |
| **RANGE** | A range of values (usually a date) | Time series; `events` partitioned by month |
| **LIST**  | Discrete values                    | By region / tenant / status                |
| **HASH**  | A hash of the key (even spread)    | Flatten skew when there's no natural range |

**Benefits:**

- **Partition pruning** — if the partition key is in the `WHERE` clause, the planner scans only the relevant partition(s), skipping the rest (see [indexing and query planning](/posts/database-indexing-and-query-planning/)). A big speedup on large tables.
- **Cheap archival/retention** — drop old data with `DROP TABLE partition_2024_01` (instant, no bloat) instead of `DELETE … WHERE created_at < …` (slow; it generates dead tuples + vacuum work — see [MVCC](/posts/postgres-isolation-levels-and-mvcc/)).
- **Smaller per-partition indexes** → better cache locality; per-partition `VACUUM`/`REINDEX`.

**Caveats:**

- Queries that **omit the partition key** can't prune → they scan every partition.
- A unique constraint / PK on a partitioned table **must include the partition key** (indexes are per-partition / local).
- Too many partitions → planning overhead and slow `\d`-style metadata ops.

**Key point: partitioning is a single-node technique.** It manages big tables; it does _not_ add write throughput beyond the one machine. It's frequently the right answer when someone thinks they need to shard.

## Rung 4: Sharding (across database servers)

Horizontal partitioning across independent DB instances; each **shard** owns a disjoint subset of rows. This is what finally scales **writes, storage, and connection capacity** past a single machine.

### Choosing the shard key (the critical, hard-to-reverse decision)

A good shard key is:

- **High cardinality** — many distinct values to spread across shards.
- **Evenly distributed** — no value dominates.
- **Present in most queries** — so the router can target a single shard instead of fanning out.

Common good keys: `user_id`, `tenant_id`, `account_id`. **Bad keys → hot shards:**

- Sharding by `country` when one country is 70% of traffic → one overloaded shard.
- Sharding by `created_at`/timestamp → _all_ new writes hit the newest shard (a moving hotspot).
- Low-cardinality keys (`status`, `boolean`) → can't spread.
- The "celebrity problem" — one `user_id` with vastly more data than the others.

### Sharding strategies

| Strategy               | How                          | Trade-off                                                             |
| ---------------------- | ---------------------------- | --------------------------------------------------------------------- |
| **Range**              | Key ranges → shards          | Simple, and range queries stay local; prone to hotspots + uneven fill |
| **Hash**               | `hash(key) % N` → shard      | Even spread; **changing N reshuffles almost everything**              |
| **Consistent hashing** | Keys + shards on a hash ring | Adding/removing a shard moves only ~1/N of the keys                   |
| **Directory / lookup** | A service maps key → shard   | Flexible rebalancing; the directory is an extra hop and must be HA    |

Routing is done by the app or by middleware: **Citus** (a Postgres extension), **Vitess** (MySQL, from YouTube).

### What sharding breaks (the cross-shard problems)

- **Cross-shard joins** don't exist. Either denormalize so related data is co-located, or do **scatter-gather** (fan out to all shards, merge in the app) — slow and limited.
- **Cross-shard transactions** aren't a single ACID unit. You need a **saga** or two-phase commit (see [the outbox pattern](/posts/outbox-pattern-and-dual-write-problem/)). **Design to keep each transaction within one shard.**
- **Global aggregates / reports** need fan-out + merge, or a separate read model / analytics store (CQRS).
- **Unique IDs** — there's no single auto-increment across shards. Use Snowflake/UUIDv7/ULID (see [distributed unique ID generation](/posts/distributed-unique-id-generation/)); some schemes bake the shard ID into the value.
- **Referential integrity** — FK constraints can't span shards; enforce them in the application.

### Resharding — the part everyone underestimates

Adding a shard means **moving data** while serving traffic. Mitigations:

- **Consistent hashing** minimizes how much moves.
- **Over-provision logical shards:** create many logical shards (e.g. 1024 "virtual buckets") up front, map groups of them onto fewer physical nodes, and rebalance by _moving whole buckets_ — no rehashing of individual rows. This is the Vitess / Slack / Notion approach and the pragmatic default.
- **Co-locate by shard key**, so a moved bucket carries all of an entity's related rows together.

### When to shard

Only when a single primary — already scaled vertically, fronted by read replicas, and partitioned — still can't absorb the **write** throughput or **data volume**. Sharding multiplies _everything_ operationally: backups, migrations, monitoring, and failover now happen × N.

## Decision framework

| Symptom                                              | Reach for                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Reads are slow / read-heavy                          | Read replicas (+ caching)                                                 |
| One enormous table, queries scoped by time or tenant | Partitioning                                                              |
| Write throughput or storage exceeds one node         | Sharding                                                                  |
| Need global aggregates across all data               | A CQRS read model / analytics store, not OLTP queries                     |
| Want sharding without the manual pain                | Distributed SQL (CockroachDB, Spanner, YugabyteDB) or Citus/Vitess/Aurora |

**Distributed SQL** (CockroachDB, Spanner, YugabyteDB) auto-shards and replicates with consensus (Raft/Paxos) under the hood, offering strong consistency without hand-sharding — trading some write latency and cost. It's the "I don't want to build sharding myself" answer.

## Gotchas

- **Read replicas don't help write-bound systems.** If writes are the bottleneck, replicas add zero — you need sharding. Diagnose read vs. write first.
- **Replica lag breaks read-your-writes.** Default to routing a user's reads to the leader for a short window after they write.
- **Reading from a replica inside a transaction that also writes** sees stale / not-your-own-write data. Keep read-after-write paths on the leader.
- **No partition pruning without the partition key in the predicate** → every partition gets scanned, often slower than an unpartitioned table.
- **Partitioned-table unique/PK constraints must include the partition key.** You can't cheaply enforce global uniqueness on a non-key column across partitions.
- **`hash(key) % N` sharding makes adding a node move ~all rows.** Use consistent hashing or logical shards instead.
- **Hot shards from a skewed or low-cardinality shard key.** Validate the distribution with real data before committing — the key is painful to change later.
- **Cross-shard JOINs and ACID transactions don't exist.** Denormalize and co-locate; use sagas for multi-shard writes; never assume a global transaction.
- **Auto-increment PKs break across shards** — switch to a distributed ID scheme _before_ sharding, not after.
- **FK constraints can't cross shards** — referential integrity becomes the app's job.
- **Don't shard prematurely.** It's the highest-complexity rung; partitioning + replicas cover most "large DB" cases. Reach for managed distributed SQL before hand-rolling shard routing.
- **Aurora ≠ sharding.** Aurora scales _reads_ (up to 15 replicas on shared storage) and failover, but it's still a **single writer** — it doesn't scale writes. Don't pitch Aurora as a write-scaling/sharding solution.

## References

- [CAP, PACELC, consistency models, and consensus](/posts/cap-pacelc-consistency-and-consensus/) — replication, consistency models, and quorum; the theory under read-after-write.
- [Database indexing and query planning](/posts/database-indexing-and-query-planning/) — partition pruning, local vs. global indexes.
- [Postgres isolation levels and MVCC](/posts/postgres-isolation-levels-and-mvcc/) — why `DROP PARTITION` beats `DELETE` (dead tuples/vacuum); replica snapshots.
- [Distributed unique ID generation](/posts/distributed-unique-id-generation/) — sharding kills auto-increment; shard-ID-in-key schemes.
- [The outbox pattern and the dual-write problem](/posts/outbox-pattern-and-dual-write-problem/) — cross-shard writes via saga/outbox instead of distributed transactions.
- _Designing Data-Intensive Applications_ (Kleppmann), ch. 5 (Replication) and ch. 6 (Partitioning) — the canonical treatment.
- [Vitess](https://vitess.io), [Citus](https://www.citusdata.com); Notion's "sharding Postgres" engineering post.
