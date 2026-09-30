---
title: "Kafka exactly-once semantics (transactions) and schema evolution"
description: "Idempotent producer vs. transactions, the consume-process-produce loop with sendOffsetsToTransaction, zombie fencing, read_committed, why Kafka EOS stops at Kafka's edge — and how Schema Registry compatibility modes decide your upgrade order."
pubDatetime: 2026-09-30T11:40:00+02:00
tags: [kafka, exactly-once, schema-registry, messaging]
sourceNotes: [kafka-exactly-once-transactions-and-schema-evolution]
---

> Two things people conflate. The **idempotent producer** (`enable.idempotence`, PID + sequence) only dedups _retries to one partition within one producer session_ — necessary but not sufficient for EOS. **Kafka transactions** (`transactional.id` + `sendOffsetsToTransaction`) add the missing piece: an _atomic_ **consume-process-produce** unit — the output records _and_ the input-offset commit succeed or fail together, with zombie fencing across restarts. But the giant caveat: **Kafka EOS is Kafka-to-Kafka only** — it does _not_ cover your Postgres write or HTTP call, so crossing into an external system still needs the exactly-once _effect_ (an idempotent write or the inbox pattern). On the data side, **Schema Registry** + a **compatibility mode** (BACKWARD = upgrade consumers first; FORWARD = producers first; FULL = both) keeps producers and consumers independently deployable.

## Table of contents

## Overview

This post covers genuine **Kafka transactional EOS** and **schema evolution** — the two pieces that come after "use an idempotent consumer".

The spine to hold onto: there are _two different_ exactly-once stories — Kafka's transactional EOS (atomic _within_ Kafka) and the idempotent-effect pattern (for when you write to a database) — and knowing which one applies where is the key distinction.

## Key points

- **Three delivery guarantees:** at-most-once (commit before processing → lose data on a crash), **at-least-once** (process then commit → duplicates on a crash — the default), and exactly-once.
- **Idempotent producer ≠ transactions.** The idempotent producer dedups producer _retries_ to a single partition (PID + per-partition sequence). Transactions give _atomic multi-partition writes + the consumer offset commit_.
- **Kafka transactions make consume-process-produce atomic:** the output records and `sendOffsetsToTransaction` (the input offsets) commit as one unit — all or nothing.
- **`transactional.id` gives a stable producer identity**, so the broker can **fence zombies** (epoch bump) — a hung-then-revived producer can't write after a replacement has taken over.
- **Consumers must set `isolation.level=read_committed`** to skip aborted/uncommitted records; the default, `read_uncommitted`, sees everything and breaks read-side EOS.
- **Kafka EOS is Kafka-internal only.** It does **not** extend to a database or an external API. Consume-process-**write-to-Postgres** is _not_ covered — use the idempotent-effect / inbox pattern there.
- **Kafka Streams makes EOS a one-liner:** `processing.guarantee=exactly_once_v2` — the easy path for Kafka → Kafka topologies.
- **Schema Registry** decouples producer and consumer deploys: versioned schemas per subject, a compatibility check that gates new schemas, and a schema id in each message (magic byte + 4-byte id).
- **Compatibility direction = upgrade order:** BACKWARD (the new schema reads old data → consumers first), FORWARD (the old schema reads new data → producers first), FULL (both). Add fields _with defaults_; never rename in place.
- **Avro/Protobuf >> JSON** for production — compactness + evolution safety. Field **defaults** are what make add/remove changes safe.

## Kafka transactional EOS

### Idempotent producer vs. transactions (clear this up first)

|                     | Idempotent producer                                           | Transactions                                                                               |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Config              | `enable.idempotence=true` (default since 3.0)                 | `transactional.id` + `initTransactions()`                                                  |
| Scope               | Retries to **one partition**, within **one** producer session | **Atomic across partitions/topics** + the input-offset commit                              |
| Solves              | Producer-retry duplicates from lost acks                      | Partial writes in multi-step processing; consume-process-produce atomicity; zombie fencing |
| Sufficient for EOS? | **No** — a necessary building block                           | **Yes** (within Kafka)                                                                     |

The idempotent producer is the foundation; transactions build on it.

### The consume-process-produce pattern

The canonical EOS use case: read from an input topic, transform, and write to an output topic — exactly once, end to end (within Kafka).

```java
producer.initTransactions();                         // once, at startup — registers transactional.id

while (running) {
    var records = consumer.poll(...);
    producer.beginTransaction();
    try {
        for (var rec : records) {
            producer.send(transform(rec));           // output(s) — possibly many partitions/topics
        }
        // commit the INPUT offsets *inside the same transaction*
        producer.sendOffsetsToTransaction(offsetsOf(records), consumer.groupMetadata());
        producer.commitTransaction();                // atomic: outputs + input offsets together
    } catch (Exception e) {
        producer.abortTransaction();                 // nothing is visible to read_committed consumers
    }
}
```

**The key move is `sendOffsetsToTransaction`:** the consumer's input offsets are committed _as part of the producer's transaction_. So either the outputs are produced **and** the inputs are marked consumed, or **neither** happens. On an abort or crash, the inputs are re-polled and reprocessed cleanly, and the aborted outputs are never seen by `read_committed` consumers. No double output, no skipped input.

### Zombie fencing via `transactional.id`

A stable `transactional.id` lets the **transaction coordinator** assign the producer an **epoch**. If a producer hangs (a GC pause, a network partition) and a replacement starts with the same `transactional.id`, the coordinator bumps the epoch and **fences** the old instance — its later writes are rejected. This is what prevents a revived "zombie" from corrupting the stream after failover. (Reusing the same `transactional.id` across two _concurrent_ producers fences one of them off; randomizing it on every restart loses the protection.)

Under the hood, a transaction coordinator and the internal `__transaction_state` topic track state, and **transaction markers** (control records) are written to each touched partition to flag commit or abort.

### Consumer isolation level (the half people forget)

```properties
isolation.level=read_committed   # only see committed records; skip aborted; read up to the LSO
# default: read_uncommitted      # sees aborted + in-flight records → breaks EOS on the read side
```

`read_committed` consumers read only up to the **Last Stable Offset (LSO)** — the point before any open transaction. Producer-side transactions are pointless if the consumer reads uncommitted data.

### Spring Kafka

Set `spring.kafka.producer.transaction-id-prefix` to enable transactions. Spring wires up a `KafkaTransactionManager`, runs the listener + send under `@Transactional`, and configures the container for `read_committed`. The container manages `beginTransaction`/`commit`/`abort` and `sendOffsetsToTransaction` for you.

### The giant caveat — EOS stops at Kafka's edge

**Kafka transactions are atomic only across Kafka topics + Kafka offsets.** They do **not** include your database write or an external HTTP call. So:

- **Kafka → Kafka** (stream processing, enrichment, routing): use transactional EOS / Kafka Streams. ✅
- **Kafka → Postgres / external API** (the common consumer case): EOS does **not** apply. You still need the **exactly-once effect** — an idempotent write (`UNIQUE` / `ON CONFLICT`), commit-then-ack, or the **inbox** pattern.

> This is the most common Kafka EOS misconception. "We enabled exactly-once" usually means the idempotent producer, and even real transactional EOS doesn't reach into the database. State the boundary explicitly.

### Kafka Streams EOS

For Kafka-internal topologies, `processing.guarantee=exactly_once_v2` is a one-line switch — Streams manages the transaction lifecycle, the state-store changelog, and offset commits atomically. **v2** uses one producer per instance (not per task), so it's far more efficient than the original `exactly_once` / "eos-alpha". Use v2; `exactly_once` (v1) is deprecated.

### Cost

Transactions add latency (coordinator round-trips, commit markers) and reduce throughput. **Don't** enable EOS on a pipeline that tolerates duplicates — at-least-once + an idempotent consumer is cheaper and usually enough. Also, a **long-open transaction blocks `read_committed` consumers** at the LSO (head-of-line) — keep transactions short.

## Schema evolution & Schema Registry

### Why a registry

Producers and consumers deploy independently, so **the message is the contract**. Change a field with no governance and you break consumers at runtime (a deserialization failure, or silent data loss). Schema Registry stores **versioned schemas per subject**, **validates** a new schema against a compatibility rule _before_ allowing it to be registered, and lets clients fetch and cache schemas by id.

### Wire format

The Confluent format is `[magic byte 0][4-byte schema id][payload]`. The consumer reads the id, fetches that schema from the registry (cached), and deserializes — Avro uses the writer's schema (from the id) plus the reader's own schema to resolve fields.

### Format choice

| Format                 | Size             | Evolution                     | Notes                                                    |
| ---------------------- | ---------------- | ----------------------------- | -------------------------------------------------------- |
| **Avro**               | Compact (binary) | Excellent (defaults, aliases) | Historically the Kafka default; needs the schema to read |
| **Protobuf**           | Compact (binary) | Excellent                     | Codegen, cross-language, shared with gRPC                |
| **JSON Schema**        | Large (text)     | Weaker                        | Human-readable; fine for low volume                      |
| Raw JSON (no registry) | Large            | None                          | Prototypes only — no contract enforcement                |

### Compatibility modes

| Mode                   | Guarantee                                                           | Upgrade order       | Allowed changes                                   |
| ---------------------- | ------------------------------------------------------------------- | ------------------- | ------------------------------------------------- |
| **BACKWARD** (default) | The new schema can read data written by the previous schema         | **Consumers first** | Add a field _with a default_; delete a field      |
| **FORWARD**            | The old schema can read data written by the new schema              | **Producers first** | Add a field; delete a field _that had a default_  |
| **FULL**               | Both backward and forward                                           | Either              | Add/delete only _optional_ fields (with defaults) |
| **\*_TRANSITIVE**      | Same, but checked against **all** prior versions, not just the last | —                   | Stricter                                          |
| **NONE**               | No checks                                                           | —                   | Anything (you own the risk)                       |

**Mnemonic:** _BACKWARD = new code reads old data → upgrade **consumers** first. FORWARD = old code reads new data → upgrade **producers** first. FULL = both, so the order doesn't matter._

### Practical rules

- **Always add fields with a default** — that's what lets old data (which lacks the field) deserialize under the new schema.
- **Never rename in place** (it's a delete + add, which usually breaks compatibility) — use **Avro aliases** instead.
- **Don't change a field's type incompatibly**; deletes need the field to have had a default (for FORWARD/FULL).
- **Subject naming strategy:** `TopicNameStrategy` (the default — one schema per topic) vs. `RecordNameStrategy` / `TopicRecordNameStrategy` (multiple event types per topic).

## Gotchas

- **The idempotent producer is not EOS.** It only dedups retries to one partition within one producer session, and a restart resets its state. Cross-partition atomicity + zombie fencing need transactions.
- **Forgetting `isolation.level=read_committed`** on the consumer silently breaks EOS — it reads aborted and uncommitted records.
- **Kafka EOS does not include external systems** (DB, cache, HTTP). This is the #1 misconception. Use the exactly-once effect there.
- **Transactions cost latency + throughput**, and a long-open transaction blocks `read_committed` consumers at the LSO. Keep transactions short, and don't enable EOS where duplicates are tolerable.
- **`transactional.id` must be stable and unique per logical producer.** Randomizing it on every restart loses zombie protection; sharing it across concurrent producers fences one of them off.
- **`transaction.timeout.ms` must be ≤ the broker's `transaction.max.timeout.ms`**, or `initTransactions` fails.
- **Adding a field without a default breaks BACKWARD compatibility** — old data has no value for it. Always supply defaults.
- **Renaming a field = delete + add** → usually breaks compatibility. Use Avro aliases.
- **Changing the compatibility mode doesn't re-check existing versions**, unless you use a `_TRANSITIVE` mode.
- **Schema Registry is a hard runtime dependency** for serialization — if it's down, producers can't serialize and sends fail. Cache aggressively.
- **`exactly_once` (v1) is deprecated** in Kafka Streams — use `exactly_once_v2`.
- **`JsonSerializer` type headers couple consumers to producer class names** — a schema registry with Avro/Protobuf avoids this brittleness.

## References

- Earlier in this topic:
  - [Kafka core architecture: brokers, partitions, replication, and consumer groups](/posts/kafka-core-architecture/) — partitions and offsets, the substrate for transactions
  - [Event-driven architecture: Kafka as an event log vs. message queues](/posts/event-driven-architecture-and-kafka-as-event-log/) — why schema evolution matters for events
  - [Kafka vs. Pub/Sub (and SNS+SQS)](/posts/kafka-vs-pubsub-architecture-comparison/)
- [KIP-98 — Exactly Once Delivery and Transactional Messaging](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging) (idempotent + transactional producer)
- [KIP-447 — Producer scalability for exactly once semantics](https://cwiki.apache.org/confluence/display/KAFKA/KIP-447%3A+Producer+scalability+for+exactly+once+semantics) (`sendOffsetsToTransaction` / EOS v2)
- Confluent: [Exactly-Once Semantics in Apache Kafka](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)
- Confluent: [Schema Evolution and Compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)
