---
title: "The outbox pattern and the dual-write problem"
description: "Why updating your database and calling an external system in one transaction corrupts state in four ways, how the outbox pattern splits it into an atomic local commit plus at-least-once dispatch, the three dispatch shapes, the outbox table, and the two idempotency layers you need."
pubDatetime: 2026-09-30T17:27:00+02:00
tags: [microservices, kafka, idempotency, distributed-systems]
sourceNotes: [outbox-pattern-and-dual-write-problem]
---

> An outbox atomically stores business state and publication intent, then dispatches after commit. It does not atomically commit PostgreSQL and Kafka together: a crash after acknowledgement can republish the same event. Stable request/event identities protect creation; atomic receiver-side deduplication protects business effects.

## Table of contents

## Overview

Any service that updates local DB state AND must call an external system has a distributed-write problem. The naive code — both inside one `@Transactional` method — has four failure modes that all corrupt state: long-held connections, send-succeeds-commit-fails, ambiguous timeouts, and a crash between the send and the status update.

The outbox pattern is the canonical fix: split the operation into two phases that each have a single source of truth. Phase 1 is a local atomic commit; phase 2 is at-least-once dispatch with idempotency on the receiver.

This is the first of two parts. It covers the failure modes, the pattern itself, the dispatch shapes, the outbox table, and the idempotency layers. Part 2 covers the publisher implementations (poller, Kafka relay, Debezium CDC) and the operational side: multi-instance polling and parallel dispatch.

## Key points

- **The dual-write problem:** any time you must update local DB state AND call an external system, doing both in the same transaction creates four distinct failure modes.
- **The outbox is ALWAYS a DB table.** The whole pattern depends on the business write and the "intent to send" landing in the same DB, in the same transaction.
- **Kafka is not the outbox.** Kafka is one possible _destination_ the outbox publisher forwards to.
- **The receiver must be idempotent.** Every publisher flavor is at-least-once delivery — the external system must dedupe by an idempotency key.
- **The outbox table needs cleanup.** Delete or archive processed rows; otherwise it grows without bound.
- **Two independent idempotency layers, not one.** A unique event ID prevents inserting that ID twice — not repeated business requests that generate fresh IDs. Persist the request identity with the order/event and replay it. Receiver deduplication must be atomic with the business mutation; an `existsBy` check alone races.
- **Three shapes by destination type, orthogonal to publisher flavor.** Shape A: the poller calls an external HTTP/email/SMS API directly. Shape B: the poller publishes to a Kafka topic for downstream consumers. Shape C: multi-destination fan-out (Kafka + email + audit from one outbox event). The shape is determined by what the original buggy code was dispatching to.
- **The publisher's `send()` looks identical to the buggy original.** What makes it safe is its _position in the system_ — it runs after the business commit, in a separate thread/process, with retry built in. The syntax is the same; the failure semantics are completely different.

## The dual-write problem

```java
@Transactional
public void withdraw(Long userId, BigDecimal amount, String idempotencyKey) {
    ledger.append(new Entry(userId, amount.negate(), "WITHDRAWAL", idempotencyKey));
    var request = withdrawalRepo.save(new WithdrawalRequest(userId, amount, PENDING));
    paymentProcessor.send(request);   // ← BLOCKER. External call inside transaction.
    request.setStatus(SENT);
}
```

### Four failure modes — all corrupt state

1. **A long-held DB connection.** The external API takes 2 seconds → the DB connection is held for 2 seconds → the connection pool is exhausted under load.
2. **The send succeeds, the commit fails.** `paymentProcessor.send()` succeeds; the transaction commit fails (a DB blip). Money is sent to the bank, with no record in your DB. The customer can claim the withdrawal again — a silent loss.
3. **The send times out.** Did the processor receive it or not? You can't know. Retry → you might double-send. Don't retry → you might lose a real withdrawal.
4. **The JVM crashes between `send()` and `setStatus(SENT)`.** The money is sent, and the status is stuck on PENDING. Manual reconciliation is required.

These aren't edge cases — they happen routinely under load and during deploys.

## The outbox pattern

```java
@Transactional
public void requestWithdrawal(Long userId, BigDecimal amount, String idempotencyKey) {
    ledger.append(new Entry(userId, amount.negate(), "WITHDRAWAL", idempotencyKey));
    var request = withdrawalRepo.save(new WithdrawalRequest(userId, amount, PENDING));
    outboxRepo.save(new OutboxEvent("withdrawal.dispatch", request.getId()));
    // commits atomically: ledger + withdrawal + outbox row
}
```

A separate publisher polls the outbox and dispatches:

```java
@Scheduled(fixedDelay = 100)
public void publishOutbox() {
    var events = outboxRepo.findUnprocessed(100);
    for (var event : events) {
        try {
            paymentProcessor.send(event.getPayload());  // idempotency key on processor side
            outboxRepo.markProcessed(event.getId());
        } catch (Exception e) {
            log.error("retry next tick", e);  // event stays unprocessed → retried
        }
    }
}
```

### Why this works

- **An atomic local commit** — the withdrawal record and the "intent to send" are written together; no partial state.
- **Crash-safe** — if the JVM dies after the commit but before the send, the outbox poller picks the event up later.
- **Retry-safe** — the processor uses an idempotency key, so multiple sends produce one withdrawal.
- **No external calls inside `@Transactional`** — DB connections are released immediately.

## Architecture

```
   ┌───────────────────────────────────────────┐
   │  Service request handler                  │
   │  @Transactional {                         │
   │    INSERT withdrawal row                  │
   │    INSERT outbox row                      │  ← atomic local commit
   │  }                                        │
   └────────────────┬──────────────────────────┘
                    ↓
            ┌───────────────┐
            │  outbox table │  ← rows: id, payload, status, created_at
            └───────┬───────┘
                    ↓
            ┌───────────────────────────────┐
            │  Publisher / Relay / Dispatcher│
            │  reads outbox rows             │
            │  forwards them somewhere       │
            └───────┬───────────────────────┘
                    ↓
       ┌────────────┴────────────┐
       ↓                         ↓
  Kafka topic              HTTP call to processor
       ↓                         ↓
  consumer → API           (direct dispatch)
```

The "publisher" goes by many names — relay, dispatcher, forwarder, poller, CDC connector. It's the same role. (Its implementations are the subject of Part 2.)

## Three shapes — by destination type

What the publisher _does_ with each outbox row depends on what the original buggy code was dispatching to. These shapes are **orthogonal to the publisher flavor** (poller / Kafka relay / Debezium) — you can combine any shape with any flavor.

### Shape A — an external HTTP/email/SMS API (no Kafka in the middle)

The original buggy code: `paymentProcessor.send(withdrawal)` inside `@Transactional`.

The outbox flow:

```
@Transactional → INSERT business + outbox row
                                ↓
            @Scheduled poller reads outbox
                                ↓
              paymentProcessor.send(payload)   ← directly calls the HTTP API
                                ↓
              outboxRepo.markProcessed(eventId)
```

No Kafka is involved. The poller IS the dispatcher. The receiver (the external API) needs to dedupe via an idempotency key in the request header (see [request-level idempotency keys](/posts/request-idempotency-keys-for-write-apis/)).

### Shape B — a Kafka publish for downstream consumers

The original buggy code: `kafkaTemplate.send("wallet.events", event).get()` inside `@Transactional`.

The outbox flow:

```
@Transactional → INSERT business + outbox row
                                ↓
            @Scheduled poller reads outbox (or Debezium reads binlog)
                                ↓
              kafkaTemplate.send(topic, key, payload)   ← publishes to Kafka
                                ↓
              outboxRepo.markProcessed(eventId)
                                ↓
            @KafkaListener in downstream service consumes from topic
```

This is the most common shape — Kafka is often the integration backbone (see [Kafka as an event log](/posts/event-driven-architecture-and-kafka-as-event-log/)). Each downstream consumer must dedupe via `existsByIdempotencyKey`.

### Shape C — multi-destination fan-out

The original buggy code mixed several:

```java
@Transactional
void processOrder(Order order) {
    orderRepo.save(order);
    notificationService.email(order);
    auditLog.record(order);
    kafkaTemplate.send("orders", order);
}
```

The outbox flow: one outbox event, with multiple consumers each handling their slice (or one publisher fanning out to multiple destinations). Each receiver dedupes independently.

### Shape table

| Shape | Original dispatch                             | Publisher dispatches to     | Receiver dedupes via                     |
| ----- | --------------------------------------------- | --------------------------- | ---------------------------------------- |
| A     | HTTP/email/SMS in `@Transactional`            | The external API directly   | An Idempotency-Key header                |
| B     | A Kafka send in `@Transactional`              | A Kafka topic               | `existsByIdempotencyKey` at the consumer |
| C     | Multiple external systems in `@Transactional` | Each destination separately | Each receiver dedupes its own way        |

**The shape is determined by _what the original code was doing_; the publisher flavor (poller vs. Debezium) is determined by _throughput/latency requirements_.** They're independent decisions.

## Outbox table schema

```sql
CREATE TABLE outbox (
    event_id    UUID PRIMARY KEY,        -- ← producer-side idempotency
    aggregate   VARCHAR(50) NOT NULL,    -- 'withdrawal', 'order', etc.
    payload     JSON        NOT NULL,
    status      ENUM('PENDING','PROCESSED') DEFAULT 'PENDING',
    created_at  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_pending (status, created_at)  -- the poller's query path
);
```

An `event_id` primary key prevents duplicate insertion only when the logical event keeps that ID. Fresh UUIDs on each request bypass it. Combine atomic request identity with a business-event uniqueness constraint — e.g., `UNIQUE(order_id, event_type)` for a one-per-order creation event. Do not swallow an arbitrary integrity violation in the same transaction: let the losing transaction roll back, identify the expected constraint, and replay the winner in a fresh transaction after validating the payload.

After processing, either DELETE the row or move it to an archive table — otherwise the table grows forever and the `idx_pending` query slows down (even with the index, the table itself bloats).

## Idempotency — two independent layers

The outbox pattern requires idempotency at **two distinct layers**, protecting against different classes of bugs. Conflating them — or implementing only one — leaves a specific failure mode open.

### Layer 1 — producer side: UNIQUE on the outbox `event_id`

This protects against the _same event_ being inserted into the outbox twice.

It protects retries/replays only when the event identity is stable. A request-key record or a business-event uniqueness constraint must connect repeated triggers to the original logical event; the primary key alone cannot infer that connection.

```sql
CREATE TABLE outbox (
    event_id    UUID PRIMARY KEY,         -- ← producer-side idempotency
    aggregate   VARCHAR(50) NOT NULL,
    payload     JSON        NOT NULL,
    status      ENUM('PENDING','PROCESSED'),
    created_at  TIMESTAMP   NOT NULL
);
```

```text
transaction: business row + request identity + outbox event
expected request-key race: rollback the whole losing transaction
fresh transaction: read winner, compare canonical payload, return its identity
other constraint failure: propagate; do not label it a successful replay
```

Publication retries reuse the committed row; they do not insert a new event.

### Layer 2 — receiver side: atomic deduplication and effects

This protects against the _same event_ being processed twice under at-least-once delivery. It fires when:

- The publisher's `send().get()` succeeds but `markProcessed` fails → the next poll re-sends.
- A Kafka consumer crashes between processing and the offset commit → on restart, it re-reads the same offset.
- A network retry between the publisher and Kafka → the broker writes the event twice (without `enable.idempotence=true`).

```java
// Pattern 1: idempotency key in the request header
HttpRequest.newBuilder()
    .uri(processor)
    .header("Idempotency-Key", event.getKey())
    .POST(payload)
    .build();

// Pattern 2: unique constraint at the receiver's DB
INSERT INTO processed_withdrawals (idempotency_key, ...)
VALUES (?, ...)
ON CONFLICT (idempotency_key) DO NOTHING;

// Unsafe by itself: concurrent consumers can both pass this check.
if (processedRepo.existsByIdempotencyKey(event.getKey())) return;
process(event);
processedRepo.save(new Processed(event.getKey()));
```

For a PostgreSQL consumer, atomically claim a unique event ID and apply the local business mutation (plus any result outbox) in the same transaction. If the claim already exists, skip the mutation. A local check cannot atomically protect an external HTTP effect; that receiver needs its own idempotency/reconciliation contract. (This receiver-side claim is the inbox pattern described in [at-least-once delivery → exactly-once effect](/posts/at-least-once-to-exactly-once-effect/).)

### The two-layer model

| Layer                                       | Protects against                            | Mechanism                                                                                              | Where it lives                          |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| **Producer side** (outbox)                  | Retried creation of the same business event | Atomic request identity and event uniqueness; reuse the committed event ID                             | Your service's DB                       |
| **Receiver side** (consumer / external API) | Repeated delivery of the same event         | A unique dedup claim and the local mutation in one transaction, or receiver-supported HTTP idempotency | The downstream consumer or external API |

You need both. Skip the producer side, and a retried `@Transactional` writes the event twice → the publisher dispatches it twice → even with receiver dedup, you've burned dispatch capacity and confused the logs. Skip the receiver side, and a retried Kafka delivery (or a publisher crash mid-send) processes the business effect twice.

If you can't make the receiver idempotent (no API support, you can't change their schema), wrap the call in a local "have we already done this?" check — but be aware that it adds another race window between the check and the dispatch.

## Gotchas

- **The outbox is a DB table, not Kafka.** The whole pattern depends on the business row and the outbox row sharing a transaction. If the outbox were Kafka, you'd be back to the dual-write problem.
- **An outbox without a unique constraint** on the business row's natural key won't survive replay. If the publisher crashes mid-send, on retry you might write the business row twice. Always combine the outbox with `UNIQUE` on the dedup-relevant column.
- **Outbox table cleanup is mandatory.** Even with the `(status, created_at)` index, an unbounded table eventually slows the poller's scan. Schedule a job to delete or archive rows older than N days.
- **Ordering is per partition only.** If you need strict global ordering of outbox events, you have to single-partition them in Kafka — which kills horizontal scaling. Usually "ordering per aggregate" (per `wallet_id`, per `order_id`) is enough; partition by the aggregate ID (see [Kafka core architecture](/posts/kafka-core-architecture/)).
- **Outbox row size matters.** If you store the full payload as JSON in `payload`, the table grows fast. The alternative: store just an event type + the business-row ID, and let the consumer re-fetch from the source table. The trade-off: replay-after-deletion stops working.
- **The outbox doesn't help with read-side consistency.** A consumer that reads the local DB right after the request sees the new state. But a downstream service consuming the Kafka event sees it eventually (after the publisher latency). Plan for eventual consistency.
- **Receivers MUST be idempotent.** This isn't optional — every flavor is at-least-once. If the receiver can't dedupe, the whole pattern is unsafe.
- **Event-ID uniqueness is not request idempotency.** Regenerating the ID on every attempt bypasses the constraint. Reuse the persisted event, and protect the business request identity too.
- **The publisher's `send().get()` looks identical to the buggy original.** This trips up code reviewers who pattern-match on syntax. What makes it safe is _position_ — it runs after the business commit, in a separate thread, with retry on failure. Same line, completely different failure profile. When reviewing outbox code, check that the `send()` is in the publisher (a separate process / `@Scheduled`), not in the original `@Transactional` method.
- **Shape and flavor are orthogonal.** "Three publisher flavors" (poller / Kafka relay / Debezium) describes _how the publisher works_. "Three shapes" (HTTP API / Kafka topic / multi-destination) describes _what the dispatch is_. Don't conflate them — Shape A (external HTTP) with Debezium is unusual but valid; Shape B (Kafka) with a `@Scheduled` poller is the most common production combination.
- **`@Retryable` is not automatically safe.** Retryable failures, transaction boundaries, stable request identity, and uniqueness handling must be designed together. Do not blindly retry arbitrary integrity failures or external effects.

## References

- Earlier in this topic:
  - [At-least-once delivery → exactly-once effect](/posts/at-least-once-to-exactly-once-effect/) — the receiver side: idempotent consumers and the inbox pattern.
  - [Request-level idempotency for write/send APIs](/posts/request-idempotency-keys-for-write-apis/) — the request-identity layer on the producer side.
- Related: [Kafka core architecture](/posts/kafka-core-architecture/) — partition and ordering semantics that constrain outbox design · [Event-driven architecture: Kafka as an event log](/posts/event-driven-architecture-and-kafka-as-event-log/) — the broader pattern the outbox enables.
- [Microservices.io — Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- [Kafka 3.7 producer configuration](https://kafka.apache.org/37/configuration/producer-configs/)
