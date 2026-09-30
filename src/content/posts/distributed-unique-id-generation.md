---
title: "Distributed unique ID generation: Snowflake, ULID, UUIDv7, and the database trade-offs"
description: "The five requirements every ID scheme trades off, how auto-increment, UUIDv4, UUIDv7, Snowflake and ULID compare, why random IDs fragment B-tree indexes, the clock hazards of time-based IDs, and which scheme to pick when."
pubDatetime: 2026-09-30T16:57:00+02:00
tags: [distributed-systems, unique-id, database, system-design]
sourceNotes: [distributed-unique-id-generation-snowflake-ulid-uuid]
---

> Generating IDs at scale is a balancing act between _uniqueness_, _sortability_, _no coordination_, _compactness_, and _no info-leak_ — and you can't max out all five. DB auto-increment is compact and monotonic, but central. **UUIDv4** needs zero coordination, but its randomness wrecks B-tree index locality (the classic "don't use it as a clustered PK" rule). The modern answers are **time-prefixed**: **Snowflake** (64-bit = timestamp + worker-id + sequence, fits a BIGINT), **UUIDv7** (a 128-bit time-ordered UUID, RFC 9562), and **ULID** (a 128-bit, sortable base32 string). All three are _k-sortable_ (roughly time-ordered) — which restores index locality — but never globally monotonic, because there's no global clock.

## Table of contents

## Overview

"Design a unique ID generator at scale" is a classic system-design problem, and the underlying choice is a real production decision: the ID scheme touches every primary key, every foreign key, and every index, so it drives storage cost and write performance.

This post maps the options against the requirements they trade off, gives the Snowflake bit layout and the clock hazards that make it subtle, and covers the system-design framings (Snowflake per node vs. a range-allocation "ticket" service). It connects to [database indexing](/posts/database-indexing-and-query-planning/) (why random IDs fragment indexes) and to distributed-systems theory (why k-sortable is the best you can get without consensus).

## Key points

- **Five competing requirements:** uniqueness, sortability, coordination-free generation, compactness (bytes), and non-guessability. Every scheme sacrifices some of them.
- **k-sortable** = roughly ordered by creation time. It's good enough for index locality and cursor pagination — but **not** a strict global order (there's no global clock).
- **Auto-increment (a BIGINT sequence):** compact, strictly monotonic, perfect index locality — but central (a round-trip), it leaks volume, and it's hard across shards.
- **UUIDv4 (random):** zero coordination; generate anywhere — but it's 128-bit, and its **random insert position → page splits, fragmentation, and a poor cache hit ratio**. Bad as a clustered primary key.
- **UUIDv7 (time-ordered UUID):** a 48-bit timestamp + randomness; sortable and locality-friendly while keeping the UUID format. The modern default replacing v4 for DB keys (RFC 9562, 2024).
- **Snowflake (64-bit):** ~41 bits of ms timestamp + ~10 bits of worker-id + ~12 bits of sequence. It fits a BIGINT, produces ~4M IDs/sec/node, and needs coordination only for worker-id assignment.
- **ULID (128-bit):** 48-bit ms + 80-bit randomness, encoded as a 26-char sortable base32 string. Sortable like Snowflake, but coordination-free; bigger than 64-bit.
- **The clock is the hazard.** Time-based IDs assume a forward-moving wall clock. A backwards clock (NTP step), per-ms sequence overflow, and cross-node skew are the three failure modes to address.
- **Don't over-engineer.** A single-DB app should just use a `BIGINT` sequence; distributed ID schemes are for multi-writer, sharded, or high-throughput systems.

## The requirements (why this is a real trade-off)

| Requirement                  | Why it matters                                                 | Tension                                                  |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| **Uniqueness**               | Collisions corrupt data — non-negotiable                       | Randomness gives it for free; counters need coordination |
| **Sortability (k-sortable)** | Index locality, natural ordering, cursor pagination            | Pure randomness has none                                 |
| **No coordination**          | Throughput + availability (no network hop / central authority) | Strict monotonicity _requires_ coordination              |
| **Compactness**              | The PK + every FK + every index pay the byte cost at scale     | 64-bit beats 128-bit beats 36-char text                  |
| **Non-guessability**         | Sequential IDs leak volume and enable enumeration/IDOR         | Sortable IDs leak creation time by design                |

You cannot maximize all of these. The schemes below are points in this space.

## The options

### 1. DB auto-increment / sequence (`BIGSERIAL`, `IDENTITY`)

- **Pros:** 8 bytes, strictly monotonic, _perfect_ index locality (every insert appends to the right edge of the B-tree), dead simple.
- **Cons:** it needs the DB / a central authority (a round-trip — you don't know the ID before the insert); it doesn't span shards or multi-master setups without coordination; it **leaks business volume** (a competitor sees order #50123 today and #51200 tomorrow → ~1000 orders/day); and it's trivially enumerable.
- **`IDENTITY` defeats Hibernate batching** — use `SEQUENCE` with a matching `allocationSize`.
- **Sharded variants:** stepped sequences (shard A: 1, 4, 7…; shard B: 2, 5, 8…), or bake a shard-id into the value (Instagram's per-schema sequence + shard bits).

### 2. UUIDv4 (random) — the one to be careful with

- 128-bit, with 122 random bits → collisions are negligibly unlikely; generate anywhere (even client-side); no leak.
- **The cost is index locality.** Random keys insert at random points in the B-tree → page splits, fragmentation, write amplification, and a cold cache (each insert touches a different page). As a **clustered** PK (MySQL InnoDB stores the table _as_ the PK B-tree, and secondary indexes embed the PK), this is doubly painful — see [heap vs. clustered indexes](/posts/database-indexing-and-query-planning/#postgres-vs-mysql-heap-vs-clustered-index).
- It's also 128-bit storage; stored as `varchar(36)` instead of a native `uuid`/`binary(16)`, it bloats further and slows comparisons.

### 3. UUIDv7 (time-ordered UUID) — the modern default

- The first **48 bits = a Unix ms timestamp**; the rest is random. It's lexicographically and time sortable → it restores index locality, while keeping the 128-bit UUID format and ecosystem.
- Standardized in **RFC 9562 (2024)**; increasingly native in drivers and libraries.
- **Recommendation:** prefer UUIDv7 over v4 whenever you want UUID ergonomics (client-generated, no coordination) without the fragmentation tax.

### 4. Snowflake (64-bit) — compact + sortable

Twitter's design. A typical 64-bit layout:

```
 0 | 41 bits timestamp        | 10 bits worker-id | 12 bits sequence
 ^   (ms since custom epoch)    (1024 nodes)        (4096 ids/ms/node)
 sign
```

- **41 bits of ms ≈ 69 years** from your chosen epoch — use a _recent_ custom epoch to maximize the lifespan.
- **~4096 IDs/ms/node ≈ 4M/sec/node**; scale by adding nodes.
- **Pros:** it fits a `BIGINT` (8 bytes, compact), is k-sortable, and is coordination-free _per node_ once the worker-id is assigned.
- **Cons:** worker-id assignment is the one coordination point (an etcd/ZooKeeper lease, a k8s StatefulSet ordinal, or static config); it's clock-dependent (below); and it leaks the rough creation time + node.
- **Variants:** Sonyflake (more time, fewer nodes), Instagram (41 ts + 13 shard + 10 seq), Discord, Meituan Leaf (snowflake mode).

### 5. ULID / KSUID (sortable strings)

- **ULID:** 128-bit = a 48-bit ms timestamp + 80 bits of randomness, encoded as a **26-char Crockford base32** string — case-insensitive, URL-safe, lexicographically sortable. Coordination-free (randomness instead of worker-id + sequence), with an optional monotonic factory for ordering within the same ms.
- **KSUID:** 160-bit = a 32-bit second timestamp + 128 random bits, as a 27-char base62 string. Similar goals, at second granularity.
- **The trade-off vs. Snowflake:** no worker-id coordination and string-friendly, but 128/160-bit (bigger than Snowflake's 64) and slightly less locality than a pure counter.

### Comparison

| Scheme         | Bits | Sortable   | Coordination | Index locality | Leaks       | Generated where |
| -------------- | ---- | ---------- | ------------ | -------------- | ----------- | --------------- |
| Auto-increment | 64   | Strict     | Central DB   | Best           | Volume      | DB only         |
| UUIDv4         | 128  | No         | None         | Worst          | None        | Anywhere        |
| UUIDv7         | 128  | k-sortable | None         | Good           | Time        | Anywhere        |
| Snowflake      | 64   | k-sortable | Worker-id    | Good           | Time + node | Per node        |
| ULID           | 128  | k-sortable | None         | Good           | Time        | Anywhere        |
| KSUID          | 160  | k-sortable | None         | Good           | Time        | Anywhere        |

## Clock hazards

Time-prefixed IDs assume the wall clock moves forward. There are three failure modes:

1. **A backwards clock** (an NTP step, a leap second, VM live migration). Re-using an earlier ms can produce duplicate or out-of-order IDs. **Snowflake's defense:** track the last timestamp; if `now < last`, either _wait_ until the clock catches up or throw — never issue an ID with a rewound clock.
2. **Per-ms sequence overflow.** If a node issues more than `2^12 = 4096` IDs in one ms, the sequence wraps. **The defense:** busy-wait for the next ms (backpressure) rather than reusing sequence values.
3. **Cross-node clock skew.** Two nodes' clocks differ by milliseconds, so globally the IDs are only _k-sortable_, never strictly ordered. **There is no fix** without coordination — strict global monotonicity needs a consensus-backed sequencer, which reintroduces the central bottleneck (there's no global clock without consensus).

**Why wall-clock, not monotonic time:** Snowflake/ULID use `System.currentTimeMillis()` (the wall clock), because the timestamp must be _meaningful and comparable across processes and restarts_. That's the opposite of a rate limiter, which uses monotonic `System.nanoTime()` for _intervals_. Different jobs, different clocks.

## System-design framing: "design a unique ID generator at scale"

**Clarify first:** the target rate (IDs/sec)? Is sortability required? 64-bit (compact) vs. 128-bit OK? Any enumeration/security concern? Single-region or global?

**The default answer — Snowflake per node:**

> "I'd use a 64-bit Snowflake: ~41 bits of millisecond timestamp from a recent custom epoch, ~10 bits of worker-id, ~12 bits of per-ms sequence. That's coordination-free at generation time, k-sortable so it plays nicely with the B-tree, and it fits a BIGINT. The only coordination is assigning each node a unique worker-id — I'd use a Kubernetes StatefulSet ordinal or an etcd lease. I'd guard the clock: if it steps backwards I wait rather than issue, and if the per-ms sequence overflows I spin to the next millisecond."

**The alternative — range/segment allocation (a "ticket server"):**

> "If I don't want per-node clock logic, a central ID service hands out _blocks_ of IDs — e.g., a node requests 1,000 IDs at once and serves them locally. That cuts coordination calls 1000:1, and survives brief ID-service downtime via the cached block. Flickr's stepped MySQL auto-increment and Meituan Leaf's segment mode work this way; for HA you run two DBs with an offset + increment-by-2."

**Don't over-engineer:** for a single-database service, a `BIGINT` sequence is the right answer — say so explicitly.

## When to use which

| Situation                                                 | Pick                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| A single-DB app                                           | A `BIGINT` sequence — don't distribute IDs you don't need to          |
| A compact PK, a high write rate, and you want sortable    | **Snowflake** or **UUIDv7**                                           |
| Generate on the client / offline / with no infrastructure | **UUIDv7** or **ULID**                                                |
| Public-facing, must not be enumerable                     | Random (UUIDv4), or an opaque slug / hashid over an internal sequence |
| A huge append-only table                                  | A sortable ID + a BRIN index on the time-prefixed key                 |

## Gotchas

- **UUIDv4 as a clustered/primary key fragments the index** → page splits, write amplification, cache misses. The most common real-world ID mistake. Use UUIDv7/Snowflake/ULID if you want random-ish _and_ sortable.
- **Storing UUIDs as `varchar(36)`** instead of a native `uuid`/`binary(16)` wastes ~2.5× the bytes and slows every comparison and index.
- **Snowflake worker-id collisions = duplicate IDs.** If two nodes ever share a worker-id (bad config, a reused ordinal), they can mint identical IDs. The uniqueness of the worker-id is load-bearing — assign it from a single source of truth.
- **An unhandled clock-backwards event or sequence overflow → duplicates.** Both must be explicitly guarded (wait/throw; spin to the next ms).
- **The 41-bit timestamp overflows ~69 years after the epoch.** Use a recent custom epoch, and document it.
- **Sortable IDs leak creation time and volume.** Don't use them where that's sensitive (security tokens, public IDs you don't want mined). Use random or a separate opaque identifier.
- **ULID needs the monotonic factory for same-ms ordering.** Naive ULID generation can produce out-of-order values within a single millisecond.
- **Never expose internal auto-increment IDs in public APIs.** It enables enumeration, scraping, and IDOR. Expose a UUID/slug, and keep the sequence internal.
- **k-sortable ≠ globally ordered.** Never rely on ID order for _strict_ cross-node event ordering — use an explicit sequence number / logical clock (see [streaming dedup + ordered emission](/posts/streaming-dedup-and-ordered-emission/)).
- **App-generated vs. DB-generated.** App-side IDs (UUID/Snowflake) are known _before_ the insert — useful for outbox rows, event references, and avoiding a round-trip; DB sequences require the insert first. (Idempotency keys like a `txn_id` are a _separate_ concept from the primary key — see [request-level idempotency keys](/posts/request-idempotency-keys-for-write-apis/).)

## References

- Earlier in this topic:
  - [Streaming dedup + ordered emission](/posts/streaming-dedup-and-ordered-emission/) — sequence numbers for strict ordering, distinct from IDs.
  - [Request-level idempotency for write/send APIs](/posts/request-idempotency-keys-for-write-apis/) — idempotency keys are a separate concept from primary keys.
- Related: [Database indexing and query planning](/posts/database-indexing-and-query-planning/) — why random IDs destroy B-tree locality; clustered vs. heap tables.
- Twitter Snowflake (announcement + `IdWorker`) · [ULID spec](https://github.com/ulid/spec) · [RFC 9562 (UUIDv7)](https://www.rfc-editor.org/rfc/rfc9562) · Instagram's "Sharding & IDs" blog post · Meituan Leaf
