---
title: "Kafka vs. Pub/Sub (and SNS+SQS): architecture and trade-off comparison"
description: "Shared log vs. per-subscriber copies: how Kafka, GCP Pub/Sub, and AWS SNS+SQS differ in storage cost, offset vs. per-message ack, DLQs, ordering, replay, and rebalancing — and when to use which."
pubDatetime: 2026-09-30T11:21:00+02:00
tags: [kafka, pubsub, sns-sqs, messaging, architecture]
sourceNotes: [kafka-vs-pubsub-architecture-comparison]
---

> Kafka is a distributed log where consumers track offsets into a shared partition; Pub/Sub and SNS+SQS are message routers where each subscription/queue holds independent message copies with per-message ack state. Kafka's storage cost stays constant with consumer count; Pub/Sub and SNS+SQS scale linearly.

## Table of contents

## Overview

Engineers moving between Kafka and GCP Pub/Sub often carry assumptions from one system into the other. The two look similar on the surface (publish/subscribe, topics, consumer groups vs. subscriptions) but diverge fundamentally in storage model, failure handling, ordering, and replay.

**AWS SNS+SQS fan-out shares the same storage model as Pub/Sub** — each subscriber gets its own physical copy — so the Kafka vs. Pub/Sub trade-offs map directly onto Kafka vs. SNS+SQS. Understanding these differences is critical when choosing between them, or when explaining why a system uses one over the other.

## Key points

- **Kafka = shared log.** One physical copy per partition. All consumer groups read the same bytes and track their position via an offset cursor. Storage cost is constant regardless of consumer count.
- **Pub/Sub = per-consumer inbox.** Each subscription gets its own physical copy of every message, with independent ack state, delivery counter, and retention. Storage cost scales linearly with subscription count.
- **SNS+SQS = the AWS equivalent of Pub/Sub.** SNS fans out one physical copy to each subscribed SQS queue. Each queue has independent storage, retention, ack, and DLQ config. Same cost-scaling model as Pub/Sub.
- **Offset vs. per-message ack** is the deepest difference. Kafka commits "everything up to offset N"; Pub/Sub and SQS ack/nack individual messages. This shapes how each system handles partial failure.
- **The DLQ is infrastructure-level in Pub/Sub and SQS** (config on the subscription/queue) vs. **application-level in Kafka** (your code produces to a DLQ topic on failure).
- **Ordering is free in Kafka** (within a partition) vs. **opt-in and constrained in Pub/Sub** (ordering keys, with head-of-line blocking on nack) vs. **opt-in with a throughput penalty in SQS** (FIFO queues, ~300 msg/s cap).
- **Replay is a Kafka-only feature.** Pub/Sub and SNS+SQS cannot rewind — once a message is acked/deleted, it's gone. Kafka consumers can reset offsets to replay history.

## Storage model

```
KAFKA                                    PUB/SUB
─────                                    ───────
Producer ──▶ Partition Log               Producer ──▶ Topic (stateless)
             ┌──────────────┐                         │
             │ offset 0: A  │                    copies at publish
             │ offset 1: B  │                         │
             │ offset 2: C  │               ┌─────────┴─────────┐
             └──────────────┘               ▼                   ▼
                    │                  Sub A backlog        Sub B backlog
           ┌───────┴───────┐           (own copies)        (own copies)
           ▼               ▼
    Group A (offset:2) Group B (offset:0)
    reads same bytes   reads same bytes
```

Adding 10 consumer groups in Kafka costs ~zero extra storage (10 cursors into the same log — see [consumer-group fan-out](/posts/kafka-core-architecture/)). Adding 10 subscriptions in Pub/Sub (or 10 SQS queues under an SNS topic) costs 10× the storage (10 independent copies). At typical message sizes and modest volumes this is negligible, but for high-volume event streaming (millions/sec) it matters.

## SNS+SQS fan-out — the AWS equivalent of Pub/Sub's model

When fan-out is needed in AWS, the canonical pattern is SNS+SQS. **The storage model is architecturally identical to Pub/Sub**, not to Kafka:

```
AWS SNS+SQS FANOUT
──────────────────
Publisher ──▶ SNS Topic (stateless)
                 │ (fan-out: one copy per subscribed queue)
       ┌─────────┼─────────┬─────────┐
       ▼         ▼         ▼         ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ SQS A   │ │ SQS B   │ │ SQS C   │ │ SQS D   │
   │ (own    │ │ (own    │ │ (own    │ │ (own    │
   │  retn,  │ │  retn,  │ │  retn,  │ │  retn,  │
   │  ack,   │ │  ack,   │ │  ack,   │ │  ack,   │
   │  DLQ)   │ │  DLQ)   │ │  DLQ)   │ │  DLQ)   │
   └─────────┘ └─────────┘ └─────────┘ └─────────┘
   physical    physical    physical    physical
   copy        copy        copy        copy
```

For understanding purposes, **treat SNS+SQS and Pub/Sub as architecturally equivalent** — the storage model, ack semantics, replay limitations, and cost scaling are the same. The operational differences (SNS+SQS is two AWS services vs. Pub/Sub's single service) are surface-level; the deep architectural trade-offs against Kafka are identical.

### Cost comparison — 1M messages × 4 subscribers

| System                                 | Storage cost     | Why                           |
| -------------------------------------- | ---------------- | ----------------------------- |
| **Kafka** (1 topic, 4 consumer groups) | 1× message bytes | One physical log, 4 cursors   |
| **SNS+SQS** (1 topic, 4 queues)        | 4× message bytes | 4 physical copies in 4 queues |
| **GCP Pub/Sub** (1 topic, 4 subs)      | 4× message bytes | 4 per-subscription copies     |

This is _the_ reason Kafka wins for high-volume event streaming with many consumers (event sourcing, audit logs, fan-out to analytics pipelines), and SNS+SQS / Pub/Sub wins for low-volume domain events with fewer subscribers (operational simplicity, no partition tuning, a native managed service).

### Independence of subscriber state (shared by SNS+SQS and Pub/Sub, not Kafka)

Because each SQS queue / Pub/Sub subscription is physically separate:

- **Queue A drains at 100 msg/s, Queue B at 1 msg/s** → no cross-impact. Each progresses at its own pace.
- **Queue A's consumer crashes for an hour** → only Queue A's backlog grows. Queue B is unaffected.
- **Different retention per queue** (A: 14 days, B: 1 day) → configured independently.
- **Different DLQ policies per queue** → independent `maxReceiveCount`, different DLQ targets.

Compare that to Kafka: if Consumer Group A falls far behind and the topic hits its retention limit (default 7 days), messages get **deleted from the log even though Group A hasn't consumed them yet**. Group A loses those messages permanently. Pub/Sub and SNS+SQS don't have this failure mode — each subscriber's copy is retained until _that subscriber_ acks it (or the per-subscriber retention expires).

## Failure handling — the core trade-off

```
KAFKA (offset commit):
  "I've processed everything up to offset 42"
  → If message 37 actually failed, two choices:
    a) Commit 42 anyway → lose message 37
    b) Don't commit past 36 → reprocess 37-42 (duplicates for 38-42)

PUB/SUB (per-message ack):
  → Ack messages that succeeded, nack message 37
  → Only message 37 is redelivered
  → No "rewind the stream" needed
```

Kafka's offset model is simpler and faster, but coarser. Pub/Sub's per-message ack is finer-grained, but has no concept of "everything up to here."

This is why Pub/Sub fits rate-limited egress (for example, calling a third-party API with per-customer credentials) — when one customer's token is revoked, you ack-drop that message and continue. In Kafka, you'd need application-level logic to skip the poison message without blocking the partition offset.

## Feature comparison

| Dimension                  | Kafka                                                                | Pub/Sub                                                               | SNS+SQS                                                     |
| -------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Message storage**        | One copy in the partition log                                        | N copies (one per subscription)                                       | N copies (one per SQS queue)                                |
| **Consumer tracking**      | Offset (cursor position)                                             | Per-message ack/nack                                                  | Per-message `DeleteMessage`                                 |
| **Ordering**               | Guaranteed within a partition                                        | Opt-in ordering keys (head-of-line blocking on nack)                  | FIFO queues, opt-in (~300 msg/s cap)                        |
| **Replay**                 | Seek to any offset — the log is always there                         | Seek by timestamp, if `message_retention_duration` is set             | **Not supported** — once deleted, it's gone                 |
| **Adding a consumer**      | A new group reads from the earliest/latest offset in the same log    | A new subscription only gets future messages                          | A new SQS queue subscribed to SNS only gets future messages |
| **DLQ**                    | Application-level (your code produces to a DLQ topic)                | Infrastructure-level (`dead_letter_policy` on the subscription)       | Infrastructure-level (`RedrivePolicy` on the SQS queue)     |
| **Backpressure**           | The consumer controls its poll rate                                  | Pull: flow control settings. Push: Pub/Sub controls the delivery rate | The consumer controls its poll rate (long polling)          |
| **Consumer failure**       | Partition rebalancing — all consumers in the group pause             | No rebalancing — timed-out messages are redelivered                   | No rebalancing — visibility-timeout redelivery              |
| **Parallelism cap**        | Partition count                                                      | Unbounded (per-message delivery)                                      | Unbounded (competing consumers)                             |
| **Ops overhead**           | Broker cluster (ZooKeeper/KRaft), partition planning, ISR management | Fully managed; no cluster, no partition tuning                        | Fully managed; two AWS services                             |
| **Managed cloud offering** | AWS MSK, Confluent Cloud                                             | GCP Pub/Sub                                                           | AWS SNS + SQS (always managed)                              |

## Consumer groups vs. subscriptions

Kafka's consumer group has a rebalancing protocol: when a consumer joins or leaves, partitions are reassigned across the group. During a rebalance, **all consumers in the group pause** ("stop the world"). For latency-sensitive workloads, this window is painful.

Pub/Sub has no equivalent. If a pull worker dies, the remaining workers keep pulling. Messages assigned to the dead worker eventually time out (the ack deadline expires) and get redelivered to a surviving worker. No coordination, no pause.

## When to use which

| Use case                                  | Better fit               | Why                                                                |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| High-throughput streaming (>100k msg/sec) | **Kafka**                | Shared log, cheaper at scale                                       |
| Strict ordering required                  | **Kafka**                | Partition ordering is free and guaranteed                          |
| Replay / event sourcing                   | **Kafka**                | The log IS the replay mechanism — Pub/Sub and SNS+SQS can't rewind |
| Fan-out to many independent consumers     | **Pub/Sub / SNS+SQS**    | A new subscription = one Terraform resource, no partition planning |
| Per-message failure isolation             | **Pub/Sub / SNS+SQS**    | Per-message ack/nack, infrastructure-level DLQ                     |
| Rate-limited egress                       | **Pub/Sub**              | Flow control + per-message nack fit naturally                      |
| Serverless / scale-to-zero                | **Pub/Sub / Lambda+SQS** | Native cloud integration                                           |
| No ops team for broker management         | **Pub/Sub / SNS+SQS**    | Fully managed                                                      |
| AWS-native architecture                   | **SNS+SQS**              | Native IAM, CloudWatch, cross-region, no extra infrastructure      |
| GCP-native architecture                   | **Pub/Sub**              | Native IAM, Cloud Logging, Cloud Run integration                   |

## Hybrid pattern

A common architecture uses Kafka for the event backbone (event sourcing, audit log, cross-team contracts) and Pub/Sub for "last mile" delivery to rate-limited or serverless consumers.

## Gotchas

- **Kafka's rebalancing is the operational cost people underestimate.** Adding or removing a consumer triggers a "stop the world" rebalance across the entire group. In latency-sensitive systems, this can mean seconds of downtime per rebalance.
- **Pub/Sub ordering keys cause head-of-line blocking.** If a message with ordering key "merchant-A" is nacked, ALL subsequent messages for "merchant-A" are blocked until the nacked message is resolved or acked. This makes ordering keys a "use with care" feature, not a safe default.
- **Kafka's offset model hides a subtle data-loss risk.** If you commit offset N but message N-3 actually failed, that failure is silently swallowed. The offset says "done" even though it isn't. Pub/Sub's per-message ack eliminates this whole class of bug.
- **Pub/Sub replay is weaker than Kafka's.** Kafka replay = seek to an exact offset. Pub/Sub replay = seek to a timestamp, replaying ALL messages from that point. If you need event sourcing or precise replay, Kafka is significantly better.
- **SNS+SQS has no replay at all.** Once a message is deleted from SQS (on ack), it's permanently gone. If you need to "re-run history" for a new consumer or a bug fix, SNS+SQS cannot help — you must re-publish from the source system. This is a frequent gotcha when teams default to SNS+SQS for event distribution and later realize they need replay.
- **SNS+SQS is two services, billed and configured separately.** Some teams forget that SNS itself has charges (per publish, per delivery) on top of the SQS charges (per API call, storage). For high-volume fan-out, budget for both.
- **Kafka is the only system where subscribers can fall behind the retention window.** In Pub/Sub and SNS+SQS, a slow subscriber grows its own private backlog — it never loses messages to producer-side retention. That's sometimes a reason to prefer a per-subscriber-copy model even at a higher storage cost, especially for subscribers with variable processing speed.

## References

- Earlier in this topic:
  - [Kafka core architecture: brokers, partitions, replication, and consumer groups](/posts/kafka-core-architecture/)
  - [Event-driven architecture: Kafka as an event log vs. message queues](/posts/event-driven-architecture-and-kafka-as-event-log/)
- [Kafka documentation — Consumer configs](https://kafka.apache.org/documentation/#consumerconfigs)
- [Google Cloud — Pub/Sub subscription overview](https://cloud.google.com/pubsub/docs/subscription-overview)
- [Google Cloud — Ordering messages](https://cloud.google.com/pubsub/docs/ordering)
- [AWS — SNS fan-out to SQS](https://docs.aws.amazon.com/sns/latest/dg/sns-sqs-as-subscriber.html)
