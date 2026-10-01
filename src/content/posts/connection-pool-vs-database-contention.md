---
title: "Connection pool starvation vs. DB resource contention: diagnosing Spring Boot + Postgres slowdowns"
description: "The two failure modes behind a slow database — app-side HikariCP starvation and Postgres-side resource contention — the metrics that tell them apart, what actually contends inside Postgres under write load, the connection math for RDS, and the right fix for each mode."
pubDatetime: 2026-10-01T16:29:00+02:00
tags: [postgres, hikaricp, rds, performance, troubleshooting]
sourceNotes: [connection-pool-vs-database-contention-failure-modes]
---

> Spring Boot apps facing a slow database have two distinct failure modes that require opposite fixes. Mode A — app-side HikariCP starvation — responds to pool tuning. Mode B — Postgres-side resource contention (buffer cache, WAL, IOPS, CPU) — is immune to pool tuning and requires DB-layer fixes: read replicas, vertical scaling, a cache, or batched writes. Treating them as the same problem leads to useless pool-bumping while the real bottleneck sits at the database.

## Table of contents

## Overview

A common production failure pattern: one service in your modular monolith starts hammering the database (a Kafka consumer during a traffic spike, a batch job, a slow migration), and another service's response times quadruple. The instinct is to "bump the connection pool", but whether that helps depends entirely on _where_ the contention actually lives. If your HikariCP metrics show pending connection requests, pool tuning is the answer. If HikariCP is healthy but the queries themselves are slow, you're looking at a database-layer problem where pool tuning does nothing.

This post covers the two failure modes, the metrics that distinguish them, the Postgres resources that actually contend under write load, and the correct fixes for each mode — critical production operator knowledge for whenever someone asks "why is the API slow?"

## Key points

- **Two distinct failure modes**: app-side pool starvation (Mode A) vs. DB-side resource contention (Mode B). Opposite fixes.
- **HikariCP is a JVM-level pool.** Each Spring Boot process has its own pool. Three deployed processes from the same JAR = three separate pools.
- **Total RDS connections = the sum across (services × tasks × pool size)**. It must stay below Postgres's `max_connections`.
- **Each Postgres connection costs ~5–15 MB of RDS-side RAM** for its backend process. 400 connections ≈ 4 GB. This drives RDS instance sizing.
- **Mode A symptoms**: `hikaricp.connections.pending > 0`, and `hikaricp.connections.acquire` timing out. Only the starved service is slow.
- **Mode B symptoms**: all services touching the DB are slow; the HikariCP pending metric is healthy; Postgres CPU / IOPS / replication lag are climbing.
- **MVCC actually helps readers during writes** — readers don't block writers in Postgres. The real read slowdown comes from `shared_buffers` cache eviction, WAL contention, and backend CPU starvation.
- **Process separation gives resource isolation** — a runaway consumer can't starve the API's pool if they're separate processes. This is one of the best reasons to split a modular monolith into multiple ECS services.
- **Bumping pools is the wrong fix for Mode B.** Read replicas, vertical scaling, and cache layers are the correct levers.
- **RDS Proxy / PgBouncer** multiplexes many app-side connections onto fewer Postgres backends — the production answer at high scale.

## Mode A — App-side HikariCP starvation

```
Service X requests connection → HikariCP pool empty → getConnection() blocks
   → Service X requests queue and eventually time out (default 30s)
   → Other services unaffected (different pool)
```

### Diagnostic signatures

- `hikaricp.connections.pending > 0` on Service X
- `hikaricp.connections.acquire` (a timer) climbing or timing out on Service X
- Service X logs: `HikariPool-1 - Connection is not available, request timed out`
- Other services' HikariCP metrics look healthy
- Postgres-side metrics are normal

### Fix

Bump Service X's pool size, and make sure RDS has enough `max_connections` headroom to absorb the increase.

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: ${DB_POOL_SIZE:10}
```

Set `DB_POOL_SIZE` per ECS service deployment. For a REST API: 20–30. For a Kafka consumer with `concurrency=3`: 8–10. For a worker running one big query per job: 5.

## Mode B — DB-side resource contention

```
Consumer hammering writes → Postgres CPU/memory/IOPS/WAL saturated
   → ALL services touching the DB get slower, regardless of their HikariCP state
   → Pools have plenty of free connections, but each query itself takes longer
```

### Diagnostic signatures

- All services are slow (API, worker, and consumer all degraded)
- The HikariCP pending metric is healthy on all services
- **Postgres-side metrics are climbing**: CPU utilization, IOPS, WAL writer activity, autovacuum load
- **RDS CloudWatch**: `CPUUtilization`, `WriteIOPS`, `WriteLatency`, and `ReplicaLag` (if Multi-AZ) are all elevated
- At the query level: `pg_stat_statements` shows even simple SELECTs taking longer than their baseline

### Fix

**Bumping connection pools does nothing here.** The queries themselves are slow. Target the actual bottleneck at the DB layer.

## What actually contends in Postgres under write load

| Resource                         | What happens during a write spike                                         | Effect on reads                                                                 |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **`shared_buffers` (RAM cache)** | Hot pages from INSERTs evict cached read pages                            | The cache hit ratio drops → reads now hit disk → **100–1000x slower per query** |
| **WAL writer + fsync**           | Every commit fsyncs the WAL to disk; a high write rate dominates disk I/O | API reads queue behind WAL flushes for IOPS bandwidth                           |
| **Backend CPU**                  | INSERT processing (parse, plan, execute, update indexes) burns CPU        | API query backends get less CPU time                                            |
| **Index page locks**             | Concurrent INSERTs briefly lock index pages; hot indexes serialize writes | Reads against the same indexes wait                                             |
| **Autovacuum**                   | A high write/update rate triggers more vacuum work                        | Vacuum competes for IOPS and CPU                                                |
| **Multi-AZ sync replication**    | Every write waits for the standby's ack                                   | Write latency rises → backends are held longer → fewer are free for reads       |

**`shared_buffers` cache eviction is the single biggest factor in read slowdown under write load.** Dashboard queries that previously hit RAM now hit disk, and each disk I/O is 100–1000x slower. This is why a moderate write spike can destroy read latency for a read-heavy API.

### MVCC is NOT the bottleneck

Postgres [MVCC](/posts/postgres-isolation-levels-and-mvcc/) (multi-version concurrency control) actually **helps readers under write load** — readers don't block writers and vice versa, because each transaction sees its own consistent snapshot. The read slowdown isn't from MVCC locking; it's from the shared physical resources (RAM cache, disk IOPS, CPU) that MVCC can't arbitrate.

Saying "MVCC causes read contention" gets it backwards — MVCC is the mechanism that prevents _logical_ contention between reads and writes, not the cause of physical contention.

## HikariCP in a modular monolith — separate pools per process

When a single Spring Boot codebase is deployed as three processes (API, Kafka consumer, export worker), **each process has its own HikariCP pool**. They don't share memory, threads, or connections.

```
Same JAR, three deployments:

Dashboard API task        Kafka Consumer task       Export Worker task
─────────────────         ────────────────────       ──────────────────
JVM #1                    JVM #2                     JVM #3
├── HikariCP pool A       ├── HikariCP pool B        ├── HikariCP pool C
│   (20 connections)      │   (10 connections)       │   (5 connections)
│                         │                          │
└── 20 socket connections └── 10 socket connections  └── 5 socket connections
    to RDS                    to RDS                     to RDS

                         ┌──────────────────────────┐
                         │  RDS Postgres            │
                         │  Sees 35 connections     │
                         │  total from your service │
                         └──────────────────────────┘
```

### Each pool can — and should — have a different config

Even from the same codebase. Use env vars per ECS service:

| Service                        | Typical pool size | Why                                                |
| ------------------------------ | ----------------- | -------------------------------------------------- |
| Dashboard API (REST)           | 20–30             | Highly concurrent; many simultaneous user requests |
| Kafka consumer (concurrency=3) | 8–10              | 3 internal threads, plus headroom for retries      |
| Export worker (SQS)            | 5                 | One big query per export job; low parallelism      |

Three different pool sizes, same JAR. This is one of the strongest justifications for splitting a modular monolith into multiple ECS services, rather than running all workloads in one process.

### Process separation = resource isolation

If all three workloads ran in **one process**, they'd share one HikariCP pool. It sounds simpler, but it creates a contention failure mode:

```
Single JVM running all three workloads:
├── Tomcat threads         ─┐
├── @KafkaListener threads ─┼── all competing for ONE 10-connection pool
└── @SqsListener threads   ─┘

Scenario: consumer uses 8 of 10 connections
→ API has 2 connections left → queues + times out
→ Export worker can't start → blocks on connection acquire
```

Splitting into three processes means a Kafka consumer flooding its own pool can't starve the API's pool. **Same codebase, multiple processes — for resource isolation, not just scale isolation.**

## The connection math for RDS

Postgres has a hard `max_connections` ceiling. The default for a `db.t3.medium` is ~85; for a `db.r6g.large`, ~1700.

For a modular monolith with autoscaling:

```
Dashboard API:    max 10 tasks × 20 connections = 200 connections
Kafka Consumer:   max 6 tasks  × 8 connections  =  48 connections
Export Worker:    max 20 tasks × 5 connections  = 100 connections
                                                 ────
Total potential:                                 348 connections
Headroom for ops, migrations, monitoring, DBAs:  ~50
                                                 ────
Required RDS max_connections:                    ~400+
```

**This drives RDS instance sizing.** Connection capacity — not CPU or RAM — is often what forces you off a `db.t3.medium` and onto a `db.r6g.large`.

## Postgres connection RAM cost

Each Postgres connection forks a backend process that consumes **~5–15 MB of RDS-side RAM** just for itself (plus any in-flight work memory).

- 100 connections ≈ ~1 GB of RDS RAM
- 400 connections ≈ ~4 GB
- 1000 connections ≈ ~10 GB

On an 8 GB RDS instance, 400 connections means half your RAM is gone before you store any data. **Connection counts are a first-class capacity concern**, not a free parameter.

## RDS Proxy / PgBouncer — the connection multiplexer

When connection counts cross ~300–500, put a **connection pooler in front of Postgres**:

```
[Apps: 400 client connections]
        │
        ▼
[RDS Proxy / PgBouncer]   ◄── multiplexer
        │
        ▼
[Postgres: 50 actual backend connections]
```

The pooler holds many "client" connections from your apps and multiplexes them onto fewer "server" connections to Postgres. Apps see a normal connection from their pool; the pooler efficiently shares those onto a small number of real Postgres backends.

- **RDS Proxy** — AWS-managed; a drop-in via a connection-string change. It adds ~1–2 ms of latency per query and unlocks 5–10x effective connection capacity.
- **PgBouncer** — self-hosted; older, but very mature. Transaction-pooling mode gives the highest multiplexing, but restricts some features (prepared statements, `SET LOCAL`).

For AWS architectures above ~500 connections, RDS Proxy is almost always the right answer. It also improves failover time — the proxy keeps existing app connections alive during an RDS failover, reducing app-visible downtime.

## Fix matrix: which lever for which mode

### Mode A (HikariCP starvation) fixes

| Lever                                                 | Timescale                           | When to use                                                  |
| ----------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| Bump the pool size on the starved service             | Minutes (env var + rolling restart) | `hikaricp.connections.pending > 0` on one service            |
| Reduce transaction scope (release connections faster) | Hours (code change)                 | Long-held transactions causing pool exhaustion               |
| Async/non-blocking I/O for slow operations            | Days                                | The service holds connections while waiting on external APIs |

### Mode B (DB contention) fixes

| Lever                                           | Timescale                   | What it does                                                                   |
| ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| **Vertically scale RDS**                        | Minutes (modify-instance)   | A bigger instance = more RAM (less cache eviction), more CPU, more IOPS        |
| **Provision higher IOPS**                       | Minutes (gp3 tuning or io2) | Relieves WAL/disk contention specifically                                      |
| **Disable non-critical features**               | Minutes (feature flag)      | Removes expensive API queries temporarily                                      |
| **Add a read replica + route reads to it**      | Hours                       | API reads no longer compete with writes on the primary                         |
| **Add a Redis cache layer**                     | Hours                       | 90%+ of read traffic served from the cache, never touching Postgres            |
| **Batch consumer writes** (multi-VALUES INSERT) | Hours                       | 10–100x fewer statements, less WAL, less CPU, less lock contention             |
| **Drop unused indexes**                         | Hours                       | Each index is write amplification — an audit can halve the write load          |
| **CQRS / a separate read model**                | Weeks                       | Writes go to an insert-optimized DB; reads come from a denormalized read model |
| **Permanent read replicas for the API**         | Weeks                       | Structural separation of the read and write paths                              |

## Gotchas

- **"Bump HikariCP" is reflexive and often wrong.** Check `hikaricp.connections.pending` first. If it's zero, the DB is the bottleneck, and pool tuning does nothing.
- **Pool size × task count × service count must fit under RDS `max_connections`.** Aggressive per-service tuning can silently exhaust the cluster-wide connection limit.
- **`max_connections` is not free to raise.** Each connection reserves RAM on the Postgres side. Raising it without bigger hardware causes OOM.
- **Connections held open across requests** (e.g. long transactions, interactive SQL consoles) count against the pool even when idle. Watch for leaked connections.
- **Each service's pool max should leave headroom** below the RDS ceiling — don't allocate 100% of `max_connections` to your apps; leave ~20% for ops, DBAs, monitoring, and migrations.
- **The default `maximumPoolSize=10` is often too small for APIs but too big for low-concurrency workers.** Tune per workload, not one-size-fits-all.
- **The connection acquisition timeout defaults to 30 seconds.** That's too long for user-facing APIs. Set `connectionTimeout: 3000` so slow acquisition surfaces fast rather than cascading into upstream timeouts.
- **MVCC is not the read-slowness culprit.** Name `shared_buffers` eviction, WAL contention, or backend CPU — not "MVCC locking".
- **Multi-AZ RDS adds write latency** via synchronous replication. Under high write load, this amplifies Mode B contention, because backends are held longer waiting for the standby's ack.
- **[Autovacuum](/posts/postgres-autovacuum-execution-and-tuning/) falling behind** is a stealth Mode B contributor — dead tuples pile up, the cache hit ratio drops, and queries slow down. Check `pg_stat_user_tables.last_autovacuum` if you're diagnosing a slowly degrading DB.

## References

- [Multi-AZ patterns: active-active vs. active-passive](/posts/multi-az-active-active-vs-active-passive/) — why Multi-AZ sync replication amplifies write latency.
- [HikariCP](https://github.com/brettwooldridge/HikariCP)
- [AWS RDS Proxy docs](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
- [Postgres connection settings (`max_connections`)](https://www.postgresql.org/docs/current/runtime-config-connection.html)
- [PgBouncer configuration and pooling modes](https://www.pgbouncer.org/config.html)
