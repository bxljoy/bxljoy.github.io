---
title: "Pub/Sub topic, subscription, and DLQ model"
description: "Why a Google Cloud Pub/Sub topic stores nothing after fan-out, how each subscription keeps its own message copies, ack state, and dead-letter policy, how the DLQ is wired and when messages land in it, and how this differs from Kafka."
pubDatetime: 2026-10-02T07:55:00+02:00
tags: [pubsub, gcp, messaging, dlq]
sourceNotes: [pubsub-topic-subscription-and-dlq-model]
---

> Topics are stateless routers; subscriptions store independent message copies, each with its own ack state, delivery counters, and DLQ policy.

## Table of contents

## Overview

Google Cloud Pub/Sub's storage and delivery model is frequently misunderstood — especially by engineers coming from Kafka, where the topic partition holds the messages and consumers track offsets. In Pub/Sub, the topic holds nothing after fan-out. Each subscription maintains its own physical copy of every message, with an independent lifecycle. The DLQ (dead-letter) policy binds to the subscription, not the topic.

## Key points

- **Topic = a stateless router.** At publish time, Pub/Sub copies the message into every active subscription's backlog. The topic retains nothing afterwards.
- **Each subscription = an independent inbox.** Its own message copy, its own ack state, its own delivery-attempt counter, its own retention clock. Acking in one subscription has zero effect on any other.
- **The DLQ binds to the subscription, not the topic.** Each subscription can have its own `dead_letter_policy`, with its own `max_delivery_attempts` and its own DLQ topic. That's because different consumers have different failure modes and reliability needs.
- **New subscriptions don't get old messages.** If you create a subscription after messages were published, those messages were never copied into its backlog. (The exception: topic-level `message_retention_duration` enables backfill for new subscriptions, but it's opt-in.)

## Storage model

```
Producer ──publish──▶  Topic (stores ZERO messages after fan-out)
                         │
                         │  copies message into every subscription's backlog
                         │
                    ┌────┴────────────────┐
                    ▼                     ▼
             Subscription A         Subscription B
             ┌─────────────┐       ┌─────────────┐
             │ msg-1  ✓    │       │ msg-1        │  ← independent copies
             │ msg-2  ✓    │       │ msg-2        │
             │ msg-3       │       │ msg-3  ✓     │
             └─────────────┘       └─────────────┘
               acked 1,2            acked 3
               backlog: 3           backlog: 1,2
```

Storage cost = the sum of all subscription backlogs. One topic with 3 subscriptions and 1M messages = 3M stored copies.

## DLQ wiring

The DLQ is configured as a `dead_letter_policy` block on the subscription resource:

```hcl
resource "google_pubsub_subscription" "main_sub" {
  topic = google_pubsub_topic.main_topic.name

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq_topic.name
    max_delivery_attempts = 10
  }
}
```

The DLQ itself is just another topic + subscription pair. When a message exhausts `max_delivery_attempts` on the main subscription, Pub/Sub publishes it to the DLQ topic with a `CloudPubSubDeadLetterSourceDeliveryCount` attribute. The DLQ subscription holds it for inspection or replay.

## The message failure flow

```
1. Consumer nacks message (or ack deadline expires)
2. Pub/Sub increments delivery_attempt on THIS subscription's copy
3. Pub/Sub redelivers to the same subscription
4. ... repeat ...
5. delivery_attempt == max_delivery_attempts
6. Pub/Sub publishes the message to dead_letter_topic
7. Message is removed from the main subscription
8. DLQ subscription holds it (default 7-day retention) for inspection
```

## Push vs. pull: DLQ binding differences

- **Pull subscriptions**: the `dead_letter_policy` is set inline on the subscription resource. Fully declarative in Terraform.
- **Push subscriptions via Eventarc**: Eventarc owns the subscription resource and doesn't expose `dead_letter_policy`. You have to patch it after creation with `gcloud pubsub subscriptions update`. That's a side-effecting provisioner that may not re-run on `terraform apply` — operationally fragile compared to pull.

## The Kafka comparison

| Aspect            | Kafka                                                 | Pub/Sub                                                         |
| ----------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| Message storage   | The topic partition (one copy)                        | A per-subscription backlog (N copies)                           |
| Consumer tracking | The consumer group tracks an offset                   | The subscription tracks a per-message ack                       |
| Adding a consumer | A new group reads from the earliest/latest offset     | A new subscription only gets future messages                    |
| DLQ               | Application-level (produce to a DLQ topic on failure) | Infrastructure-level (`dead_letter_policy` on the subscription) |
| Ordering          | Partition-level ordering guaranteed                   | No ordering by default; ordering keys are opt-in                |

The fundamental difference: Kafka is "one log, many readers". Pub/Sub is "one router, many independent inboxes". (For the wider comparison, including SNS+SQS, see [Kafka vs. Pub/Sub](/posts/kafka-vs-pubsub-architecture-comparison/).)

## Gotchas

- **`message_retention_duration` on the subscription** (e.g. 7 days) retains messages even after they're acked, enabling seek/replay. This is different from the DLQ — retention is about replay capability; the DLQ is about failure handling.
- **`message_retention_duration` on the topic** is a separate, opt-in setting that lets new subscriptions backfill old messages. Don't confuse the two.
- **The DLQ requires IAM permissions.** The Pub/Sub service account needs `pubsub.publisher` on the DLQ topic and `pubsub.subscriber` on the main subscription. Missing these silently prevents DLQ forwarding — messages just keep redelivering past `max_delivery_attempts`.
- **The default max delivery attempts is 5** if a `dead_letter_policy` is set without specifying `max_delivery_attempts`. If no `dead_letter_policy` is set at all, messages retry indefinitely until retention expires.

## References

- Earlier in this topic: [Kafka vs. Pub/Sub vs. SNS+SQS](/posts/kafka-vs-pubsub-architecture-comparison/) — shared log vs. per-subscriber copies.
- [Google Cloud — Handling message failures (dead lettering)](https://cloud.google.com/pubsub/docs/handling-failures)
- [Google Cloud — Choosing a subscription type](https://cloud.google.com/pubsub/docs/subscription-overview)
