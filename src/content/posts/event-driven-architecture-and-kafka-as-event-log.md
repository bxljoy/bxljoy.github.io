---
title: "Event-driven architecture: Kafka as an event log vs. message queues"
description: "Why Kafka is an event log rather than a message queue, how retention differs from consumption, request-driven vs. event-driven services, why Kafka fits event-driven architecture, and where event sourcing sits on the spectrum."
pubDatetime: 2026-09-30T11:01:00+02:00
tags: [kafka, event-driven, architecture, messaging]
sourceNotes: [event-driven-architecture-and-kafka-as-event-log]
---

> Kafka is not a message queue — it's a distributed event log where messages persist after consumption, enabling replay, multi-consumer fan-out, and event sourcing. Message queues (Pub/Sub, SQS) delete messages after processing.

## Table of contents

## Overview

The choice between a message queue and an event log reflects a deeper architectural question: are you distributing _tasks_ ("do this thing") or recording _facts_ ("this thing happened")?

Message queues like Pub/Sub and SQS are task distributors — messages disappear after acknowledgement. Kafka is a fact recorder — events persist in an append-only log regardless of consumption. This distinction drives when to use each, and it's the foundation of event-driven architecture (EDA).

## Key points

- **Message queue**: produce → consume → ack → message deleted. "Is the work done?"
- **Event log (Kafka)**: produce → consume → commit offset → message stays until retention expires. "What happened, and in what order?"
- **Kafka retention is time/size-based, NOT consumption-based.** Messages stay for the configured retention period (default 7 days) whether they've been consumed or not. Set `retention.ms=-1` for infinite retention.
- **Event-driven architecture** decouples services by publishing facts ("OrderPlaced") instead of sending commands ("ProcessOrder"). Consumers subscribe independently; the producer doesn't know or care who reads.
- **Event sourcing** is the extreme — events ARE the database, and current state is derived by replaying the log.

## Three paradigms for moving data

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  MESSAGE QUEUE             EVENT LOG              DATABASE          │
│  (Pub/Sub, SQS,           (Kafka)                (PostgreSQL)      │
│   RabbitMQ)                                                         │
│                                                                     │
│  "Deliver this task       "Record what           "Store current     │
│   to a worker"             happened"              state"            │
│                                                                     │
│  Message deleted           Message retained       Row updated       │
│  after processing          for days/months/ever   in place          │
│                                                                     │
│  No replay                 Full replay            Query any time    │
│  One consumer per msg      Many consumers         Many readers      │
│  (per subscription)        (consumer groups)                        │
│                                                                     │
│  "Do this thing"          "This thing happened"  "This is true now" │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

One-sentence mental models:

| System            | Mental model                                                              |
| ----------------- | ------------------------------------------------------------------------- |
| **Pub/Sub / SQS** | A mailbox — deliver to a recipient, they take it, it's gone               |
| **Kafka**         | A newspaper archive — published facts that anyone can read, and they stay |
| **Database**      | A whiteboard — current state, overwritten in place                        |

## Kafka message retention

```
Topic config (set per topic):
  retention.ms = 604800000        (7 days — default)
  retention.ms = -1               (infinite — messages live forever)
  retention.bytes = 10GB          (keep newest 10GB per partition, delete oldest)

Timeline:
  Day 1: msg-A written
  Day 3: consumer commits offset past msg-A
  Day 3: msg-A is STILL on disk (retention ≠ consumption)
  Day 7: retention expires → Kafka's log cleaner deletes the segment
```

The storage cost is real: `100k msgs/sec × 1KB × 86400s × 7 days × 3 replicas ≈ 180 TB` on broker disks. Kafka 3.6+ offers **tiered storage** — old segments migrate automatically to object storage (S3/GCS), keeping broker disks small while enabling long retention.

## Request-driven vs. event-driven architecture

**Request-driven (traditional):**

```
Order Service ──HTTP──▶ Inventory Service ──HTTP──▶ Shipping Service
                                                    ──HTTP──▶ Email Service

Problems:
  - Order service KNOWS about every downstream service (tight coupling)
  - If email service is down, the whole chain fails
  - Adding analytics means modifying order service code
  - Order service waits for all calls to finish (latency accumulates)
```

**Event-driven:**

```
Order Service ──publishes──▶ "OrderPlaced" event ──▶ Kafka topic

  Inventory Service ──reads──▶ reserves stock
  Shipping Service  ──reads──▶ schedules pickup
  Email Service     ──reads──▶ sends confirmation
  Analytics Service ──reads──▶ updates dashboard
  (future service)  ──reads──▶ whatever it needs

Benefits:
  - Producer doesn't know who consumes (decoupled)
  - If email service is down, events wait in the log (no data loss)
  - Adding a consumer = new consumer group, zero producer changes
  - Producer returns immediately after publishing (async)
```

## Why Kafka fits EDA better than Pub/Sub

| Property                          | Why it matters for EDA                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Retention**                     | Events are facts. Facts don't disappear when observed — Kafka keeps them.                                                                                                  |
| **Replay**                        | A new service joins 6 months later? It reads from offset 0. In Pub/Sub, those events are gone.                                                                             |
| **Ordering**                      | "Order placed" comes before "order shipped". Kafka guarantees ordering within a partition.                                                                                 |
| **Multiple consumers, same data** | 10 teams read the same events with zero coordination. A shared log = free fan-out (see [consumer groups in the Kafka architecture post](/posts/kafka-core-architecture/)). |
| **Schema evolution**              | Events evolve (v1 → v2 → v3). Kafka + Schema Registry enforces compatibility.                                                                                              |

## Event sourcing — the extreme version

A normal architecture stores current state. Event sourcing stores the history of changes and derives state by replaying it:

```
TRADITIONAL (state-based):
  UPDATE accounts SET balance = balance - 100 WHERE id = 42;
  → Current state: balance = 400
  → History: lost

EVENT SOURCED:
  Event 1: AccountOpened { id: 42, balance: 0 }
  Event 2: Deposited    { id: 42, amount: 500 }
  Event 3: Withdrawn    { id: 42, amount: 100 }
  → Current state: replay events → 0 + 500 - 100 = 400
  → History: complete, auditable, replayable
```

It's used in finance (trading, banking), audit-heavy systems, and CQRS (Command Query Responsibility Segregation). It's powerful but complex — the event schema becomes your most critical API contract, replay time grows linearly, and debugging requires understanding the full event sequence.

## The spectrum in practice

```
Simple work queue ◄──────────────────────────────────────► Full event sourcing

Pub/Sub            Kafka               Kafka               Kafka
"process this      "record what        "record what         "the log IS
 task and           happened,           happened,            the database,
 forget it"         keep 7 days"        keep forever"        derive all state
                                                              from replay"

Background task    Order audit trail   Compliance/finance   Banking, CQRS
/ job queues       Analytics pipeline  Legal retention       Trading systems
```

Most systems sit in the left half. Event sourcing (the right side) is rare and requires a significant architectural commitment.

## Gotchas

- **"Events are facts" is a philosophical shift, not just a technical one.** A command says "do this" (imperative, can be rejected). An event says "this happened" (declarative, immutable). Designing around events means accepting that facts don't get deleted or modified — only new facts get added.
- **Kafka's real cost is organizational, not storage.** Running Kafka means broker ops, partition planning, a schema registry, consumer group monitoring, ISR alerts, retention policies, and tiered storage config. For small teams, this overhead dwarfs the storage bill. Pub/Sub's zero-ops model lets teams focus on business logic.
- **Event sourcing's hardest problem is schema evolution.** Changing an event's shape is like a database migration that never ends — every replay must handle every historical version. Most teams that try full event sourcing end up with a hybrid: an event log for the write path, and a traditional database for the read path (CQRS).
- **Not everything needs to be an event.** Simple request/response (get a user profile, check a balance) is fine as synchronous HTTP. EDA shines for cross-service side effects (order placed → inventory reserved → email sent), not for every API call.

## References

- Previous in this topic: [Kafka core architecture: brokers, partitions, replication, and consumer groups](/posts/kafka-core-architecture/)
- [Martin Fowler — Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Martin Fowler — CQRS](https://martinfowler.com/bliki/CQRS.html)
- [Confluent — Event-Driven Architecture](https://www.confluent.io/learn/event-driven-architecture/)
