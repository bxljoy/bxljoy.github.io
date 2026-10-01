---
title: "CQRS architecture: write/read split, projections, and eventual consistency"
description: "What CQRS actually is (two models kept in sync asynchronously), why the outbox is its linchpin, how projectors and read models work, state-stored CQRS vs. event sourcing, the cheap end of CQRS with no new infrastructure, and when not to use it."
pubDatetime: 2026-10-01T17:51:00+02:00
tags: [cqrs, event-driven, architecture, elasticsearch]
sourceNotes: [cqrs-architecture-write-read-split-and-projections]
---

> Split the write model (commands → Postgres as the source of truth) from the read model (queries → purpose-built stores like Elasticsearch), kept in sync asynchronously via an event log. The win is independent scaling and read-shape freedom; the cost is eventual consistency.

## Table of contents

## Overview

CQRS (Command Query Responsibility Segregation) separates the model used to mutate state from the model used to read it. In a traditional CRUD app, the same Postgres table serves both — which is fine until reads diverge wildly from writes (heavy joins, full-text search, faceting, analytics), or read volume dwarfs write volume. CQRS says stop forcing one database to be good at both: put commands on a normalized write store, propagate events through a log, and let multiple read models subscribe and project into stores tuned to their query patterns. This post covers the production shape of that pattern — what each piece does, why the outbox is non-negotiable, where eventual consistency bites, and when _not_ to adopt CQRS.

## Key points

- CQRS = two models (write + read), kept in sync asynchronously via an event log. That's the entire pattern; everything else is implementation detail.
- The write side owns the truth (Postgres, normalized, transactional). The read side is _derived_ — anything in it must be rebuildable from the event log.
- Reliable event emission requires the **outbox pattern**: write the business state + an outbox row in the same DB transaction, then ship it to Kafka via a poller or CDC (Debezium). A direct `kafkaTemplate.send()` inside a transaction is broken.
- Read models are **independent and pluggable**: ES for search, Redis for hot lookups, BigQuery for analytics — each maintained by its own projector consuming the same topic.
- **Eventual consistency is the tax.** The read side trails the write side by ms–s in normal operation, and longer during incidents. Plan the UX for it (optimistic UI, read-your-own-writes, version pinning), or keep that flow on Postgres.
- Projectors must be **idempotent** (a replay must converge) and **partition-ordered** (events for one aggregate go to one partition).
- **CQRS ≠ Event Sourcing.** Most production CQRS is "state-stored": Postgres holds the current state, and events are emitted on changes. Event sourcing reconstructs state by replaying events — it adds power and complexity; adopt it only when audit/replay/temporal queries are core.
- **CQRS does not require a broker.** The outbox table itself can serve as the log, consumed directly by workers — no Kafka, no Debezium, with the read model in the same Postgres. That's the version worth reaching for first; add a broker when a _second_ consumer appears.
- Premature CQRS is one of the most expensive architectural mistakes. Start with one Postgres + a read replica, add ES only for the search use case, and fully embrace CQRS only when read models multiply or scale demands it.

## The pattern in one diagram

```
              ┌─────────────────────────────────────────────────┐
              │                  WRITE SIDE                     │
              │                                                 │
 POST /orders │   Command Handler ──► Postgres (truth)          │
─────────────►│            │                                    │
              │            └─► outbox table (same tx)           │
              │                       │                         │
              │           Debezium / poller                     │
              │                       ▼                         │
              │                  Kafka topic                    │
              └───────────────────────┼─────────────────────────┘
                                      │ OrderPlaced, OrderShipped...
              ┌───────────────────────┼─────────────────────────┐
              │        ▼   READ SIDE                            │
              │   Projectors (separate consumer services)       │
              │        │                                        │
              │        ├─► Elasticsearch (search, faceted)      │
              │        ├─► Redis         (hot lookups)          │
              │        └─► BigQuery      (analytics)            │
              │                                                 │
 GET /orders  │   Query Handler ◄── reads from above            │
              └─────────────────────────────────────────────────┘
```

## Write side — Postgres as the source of truth

Commands flow through handlers that:

1. Validate the command (`PlaceOrderCommand`)
2. Load the aggregate state from Postgres
3. Apply the business rules
4. Persist the new state in a transaction
5. **Emit a domain event** via the outbox

Postgres stays normalized and transactional — no denormalization for read performance, no joins-of-doom. The write model can be small, because the read models live elsewhere.

## The outbox pattern — the linchpin

The naive approach is broken:

```java
@Transactional
public void placeOrder(...) {
    orderRepo.save(order);                    // Postgres
    kafkaTemplate.send("orders", event);      // Kafka — different system, no atomicity
}
```

The failure modes:

- Postgres commits → Kafka fails → the DB has the order but no event → the read side silently misses it
- Both succeed → the app crashes before returning → the client retries → a duplicate event

The fix: write the event to a Postgres `outbox` table in the same transaction:

```sql
CREATE TABLE outbox (
  id           UUID PRIMARY KEY,
  aggregate    TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,        -- used as Kafka key for partition affinity
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  published_at TIMESTAMPTZ           -- null until shipped
);
```

```java
@Transactional
public void placeOrder(...) {
    orderRepo.save(order);
    outboxRepo.save(new OutboxEntry("order", order.getId(), "OrderPlaced", payload));
    // both committed atomically — or both rolled back
}
```

There are two ways to ship it to Kafka:

| Option             | How it works                                                                    | Trade-offs                                                                     |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Outbox poller**  | A background job: `SELECT WHERE published_at IS NULL` → send → mark             | Simple and portable; adds latency (the poll interval) and DB load              |
| **Debezium / CDC** | Reads the Postgres WAL via logical replication and streams row changes to Kafka | Near-zero latency, no app code; adds Debezium/Kafka Connect to the ops surface |

Debezium's outbox event router SMT routes outbox rows to topics by aggregate type, and uses `aggregate_id` as the Kafka key. This is the gold standard for serious deployments.

**Why an outbox table at all, if you have CDC?** You could CDC the `orders` table directly — but the outbox decouples the _table schema_ (private) from the _event contract_ (public). It also lets one transaction emit multiple events (`OrderPlaced` + `InventoryReserved`) and carry metadata (causation/correlation IDs) cleanly.

See [the outbox pattern](/posts/outbox-pattern-and-dual-write-problem/) for the full pattern.

## The event log — Kafka as the integration backbone

Kafka isn't just a queue; it's a **durable, replayable event log**:

- **A topic per aggregate type**: `orders.events`, `inventory.events`
- **Partitioned by aggregate ID**: all events for order `123` → the same partition → in-order processing per order
- **Long retention** (7d is typical, or compacted/infinite), so read models can be rebuilt by replay

Why Kafka (vs. SQS/RabbitMQ): replay, multiple consumers, partition ordering, throughput. The GCP equivalent is Pub/Sub with ordered keys + BigQuery subscriptions — the same shape, a different brand.

See [event-driven architecture and Kafka as an event log](/posts/event-driven-architecture-and-kafka-as-event-log/) and [Kafka core architecture](/posts/kafka-core-architecture/).

## Read side — projectors and read models

A **projector** is a stateless function: `project(state, event) → newState`. Each read model is independent, and you can have as many as you need:

| Read model         | Purpose                                  | Tech                             |
| ------------------ | ---------------------------------------- | -------------------------------- |
| Order search       | Full-text + filters for "find my orders" | Elasticsearch / OpenSearch       |
| Order detail cache | "Show the order 123 page", pre-joined    | Redis or DynamoDB                |
| Merchant dashboard | Aggregates: revenue today, counts        | A Postgres replica or ClickHouse |
| Reporting / BI     | Analytics                                | BigQuery / Snowflake             |

A typical projector:

```java
@KafkaListener(topics = "orders.events", groupId = "es-projector")
public void onEvent(ConsumerRecord<String, OrderEvent> rec, Acknowledgment ack) {
    var event = rec.value();
    switch (event.type()) {
        case "OrderPlaced"    -> esClient.index("orders", event.orderId(), toDoc(event));
        case "OrderShipped"   -> esClient.update("orders", event.orderId(),
                                     Map.of("status","shipped","shippedAt",event.shippedAt()));
        case "OrderCancelled" -> esClient.update("orders", event.orderId(),
                                     Map.of("status","cancelled"));
    }
    ack.acknowledge();
}
```

Required properties:

- **Idempotent** — the same event twice → the same final state. ES upsert-by-ID gets this for free; Redis needs `SETNX` or version checks.
- **Partition-ordered** — events for one aggregate are processed in order (Kafka guarantees this within a partition). Cross-partition order is _not_ guaranteed and shouldn't be relied on.
- **Failure-tolerant** — on error, don't ack; let the consumer retry. After N retries, dead-letter and alert.

## Querying the read side

Query handlers never touch Postgres directly:

```java
@GetMapping("/orders/search")
public List<OrderView> search(@RequestParam String q, @RequestParam String merchantId) {
    return esClient.search("orders",
        QueryBuilders.bool()
            .must(matchQuery("title", q))
            .filter(termQuery("merchantId", merchantId)));
}
```

This is where the pattern pays off: queries never block behind a write transaction, joins are pre-computed (denormalized into the document), full-text search runs on an inverted index, and the read store scales independently of the write DB.

## State-stored CQRS vs. event sourcing

These are often confused — they're orthogonal:

|                            | State-stored CQRS                   | Event sourcing                                                  |
| -------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| Source of truth            | The current state in Postgres       | The event log itself                                            |
| Postgres's role            | Holds the current state             | Holds events only (or is used as a snapshot store)              |
| Loading an aggregate       | `SELECT * FROM orders WHERE id=?`   | Replay all events for that aggregate                            |
| Audit log                  | Optional (the outbox is your audit) | Free                                                            |
| Time travel                | Hard                                | Trivial                                                         |
| Schema evolution of events | Easier                              | Hard — you can't change history; you need versioned event types |

**Most production CQRS is state-stored.** Adopt event sourcing only when audit/replay/temporal queries are core requirements, because it materially raises the complexity floor.

## When NOT to use CQRS

CQRS is overkill when:

- The read and write models are essentially the same shape
- Traffic is low, and one Postgres handles everything
- Search/aggregation needs are met inside Postgres (FTS, materialized views, rollup tables) — though note that those _are_ read models; see **The cheap end of CQRS** below
- The team isn't ready to operate Kafka, projectors, and eventual-consistency UX

A reasonable progression: a single Postgres → a read replica when reads dominate → add Elasticsearch (driven from the outbox) for the _specific_ search use case → fully embrace CQRS only when multiple read models exist or scale demands it.

## The cheap end of CQRS

"CQRS" usually evokes the full Kafka-and-projectors diagram above, but the pattern is defined by **model divergence, not infrastructure**. Three minimal forms need _no new components at all_:

| Form                                   | What it is                                                                                                                           | New infra |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| **Two code paths, one schema**         | Commands go through the domain model (aggregates, invariants); queries bypass it with hand-written SQL projecting straight into DTOs | None      |
| **A same-DB projection table**         | `order_summary`, denormalized alongside `orders`, maintained in the same tx or by a job                                              | None      |
| **A materialized view / rollup table** | Derived, rebuildable, refreshed on a schedule                                                                                        | None      |

The first is CQRS at its origin — **CQS** (Meyer: a method either changes state or returns state, never both), lifted to the architecture level. Plenty of teams do exactly this and never call it CQRS.

It's worth naming explicitly: **a metrics rollup table is a CQRS read model.** It has a different shape from the write model, is asynchronously maintained, is fully rebuildable from the raw source, and is eventually consistent with a bounded lag — the whole pattern, in one database, with no Kafka. It's the cheapest real CQRS there is, and the right first rung when the problem is read _shape_ rather than read _volume_.

**Where the cheap end runs out:** a materialized view or rollup table only works when the read model's inputs are _other tables in the same database_. The moment an input lives outside — another datastore, an internal API — a view can't express it, and you need a **projector**. That's the cleanest criterion for stepping up a rung.

The two axes, kept separate:

```
model shape
    ▲
    │  same-DB projection ──────── separate read store (ES / Redis / ClickHouse)
    │  (minimal CQRS)              (full CQRS — the diagram above)
    │
    │  single model ─────────────── single model + replicas
    │  (plain CRUD)                 (read scaling)
    └──────────────────────────────────────────────────► physical copies
```

## The full-fat version

When read models multiply, the full-fat version looks like this:

- **Write side**: `POST /orders` → command handler → Postgres `orders` + an `outbox` row in the same tx → Debezium → the Kafka topic `orders.events`
- **Read models**, each with its own projector:
  - `orders-search-projector` → an Elasticsearch index for portal search
  - `orders-cache-projector` → Redis, with a denormalized `OrderDetailView`
  - `orders-analytics-projector` → BigQuery, for daily revenue dashboards
  - `inventory-sync-projector` → calls inventory-service to deduct stock
- **Query side**:
  - `GET /orders/search` → Elasticsearch
  - `GET /orders/{id}` → Redis (Postgres fallback on a miss)
  - `GET /merchant/dashboard` → BigQuery

Adding a new read model = deploying a new projector, with zero impact on the write path. That decoupling is the headline benefit.

## Gotchas

- **A read replica is not CQRS — not even a simple case of it.** It's the most common conflation, and it matters because the two fix different problems. **CQRS is defined by divergence of the _model_, not multiplicity of the _storage_.** A replica is a byte-identical physical copy (WAL streaming); it _cannot_ have a different shape. The test: _after adding the replica, did any read-side code change?_ Same entities, same queries, a different datasource ⇒ you did read scaling, not CQRS. Practically: **a replica runs your slow six-join query exactly as slowly, just on another box**, whereas a read model replaces it with a lookup. Replicas scale read **volume**; CQRS changes read **shape** — orthogonal axes, so you can have either, both, or neither. What they genuinely share is the _tax_: the moment reads leave the primary, you inherit staleness, and the mitigations are the same list (route just-written reads to the source, LSN/version fencing, session pinning). So a replica is a good **rehearsal** for the consistency problem CQRS makes permanent — a team that can't handle replica lag isn't ready for projectors. See [scaling the database](/posts/scaling-databases-replicas-partitioning-sharding/).
- **Eventual consistency is the #1 underestimated cost.** A user creates an order → the POST returns 201 → "My Orders" page → the order isn't there yet (200ms of projector lag). Mitigations: optimistic UI, read-your-own-writes (route the next N seconds of this user's reads to Postgres), version pinning (the POST returns `version: 42`, and the GET retries until the read side is ≥ 42), or just educate users with a "search index updates within 1 minute" badge.
- **A direct `kafkaTemplate.send()` from inside a `@Transactional` method is the dual-write trap.** Always use the outbox; never trust "it works most of the time".
- **`acks=all` without `min.insync.replicas ≥ 2` is misleading.** With RF=3 and `min.insync.replicas=1`, "all" can mean just the leader.
- **Cross-aggregate ordering is not guaranteed.** Kafka only orders within a partition. If your business logic requires "OrderPlaced before InventoryReserved" across partitions, you need either a single partition (which kills throughput) or a process manager / [saga](/posts/saga-choreography-orchestration-and-compensation/) that tolerates reordering.
- **Schema evolution of events is a long-term tax.** Add new fields as optional. Use a schema registry (Confluent, Apicurio) with Avro/Protobuf. Version event types (`OrderPlacedV1`, `OrderPlacedV2`), and have projectors handle multiple versions during migration windows.
- **Projector bugs that index the wrong data.** The killer feature is replay: reset the consumer group offset to 0, truncate the read store, re-consume — and the read model rebuilds from scratch. This only works if the event log's retention is long enough; check before you need it.
- **The outbox table grows forever.** Run a background job to delete rows with `published_at < now() - 7 days`, or use a partitioned table and drop old partitions.
- **Idempotent consumer logic is non-negotiable.** At-least-once delivery means retries → duplicates. Use upsert-by-ID, dedup tables keyed by event UUID, or version checks.
- **CQRS amplifies the operational surface area.** You're now running Postgres + Kafka + Debezium + ES + Redis + projectors, each of which can break independently. Don't adopt it without observability for projector lag (consumer-group offset alarms), DLQ depth, and end-to-end "POST → ES indexed" timing.
- **State-stored CQRS does NOT give you a free audit log.** The event log shows what _was emitted_; if the outbox publishes only state-change deltas, you can't reconstruct history. If audit matters, either do event sourcing or design events to carry the full before/after state.
- **Premature CQRS is the most expensive variant.** Splitting before reads actually diverge from writes adds 5+ operational components for zero user-facing benefit. Earn the complexity.

## References

- Earlier in this topic:
  - [The outbox pattern and the dual-write problem](/posts/outbox-pattern-and-dual-write-problem/) — the reliable-event-emission half of CQRS.
  - [Streaming dedup and ordered emission](/posts/streaming-dedup-and-ordered-emission/) — partition ordering and idempotency in projectors.
- Related:
  - [Event-driven architecture and Kafka as an event log](/posts/event-driven-architecture-and-kafka-as-event-log/) — why Kafka is more than a queue.
  - [Kafka core architecture](/posts/kafka-core-architecture/) — partitioning, ordering, and replication primitives.
  - [Kafka vs. Pub/Sub](/posts/kafka-vs-pubsub-architecture-comparison/) — GCP equivalents for the event-log layer.
- [Debezium outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html) — the SMT for routing outbox rows to topics.
