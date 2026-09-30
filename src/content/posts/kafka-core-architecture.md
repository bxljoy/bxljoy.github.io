---
title: "Kafka core architecture: brokers, partitions, replication, and consumer groups"
description: "How Kafka's building blocks fit together — brokers, topics and partitions, leader/follower replication and ISR, acks, consumer groups and fan-out, offset commits, and rebalancing — and the sizing rules and gotchas that follow."
pubDatetime: 2026-09-30T10:40:00+02:00
tags: [kafka, messaging, architecture]
sourceNotes: [kafka-core-architecture]
---

> Kafka is a distributed append-only log where topics are split into partitions (the physical storage unit), replicated across brokers for fault tolerance, and consumed by consumer groups that track progress via offset cursors.

## Table of contents

## Overview

Kafka's architecture is built around a small number of concepts that compose into a powerful system: brokers (servers), topics (logical names), partitions (physical logs), replication (leader/follower), and consumer groups (coordinated consumers). Understanding how these fit together is essential for reasoning about ordering, durability, scalability, and failure modes.

## Key points

- **Broker = a server.** A Kafka cluster is multiple brokers. You run and manage them yourself (or pay for managed Kafka, such as Confluent or MSK).
- **Topic = logical name, partition = physical storage.** A topic is split into N partitions. Each partition is an append-only log file living on a broker. Ordering is guaranteed only within a partition.
- **Replication = leader + followers.** Each partition has one leader (which handles all reads and writes) and N-1 followers that replicate from it. The ISR (In-Sync Replicas) tracks which followers are caught up. If the leader dies, a follower from the ISR is promoted automatically.
- **Consumer group = load-balanced consumers sharing partitions.** Each partition is assigned to exactly one consumer in the group. Multiple groups = fan-out (each reads the full log independently, via its own offset cursors).
- **Offset = cursor position.** A consumer commits "I'm done up to offset N" — everything before N is considered processed. This is coarser than Pub/Sub's per-message ack.

## Brokers and the cluster

```
Kafka Cluster
┌─────────┐  ┌─────────┐  ┌─────────┐
│ Broker 0 │  │ Broker 1 │  │ Broker 2 │
│ (server) │  │ (server) │  │ (server) │
└─────────┘  └─────────┘  └─────────┘
```

A cluster controller (ZooKeeper in older versions, KRaft in newer ones) coordinates leader election and metadata. Each broker stores the partitions assigned to it on local disk.

**Brokers are infrastructure you provision independently of topics.** You decide "I want 4 brokers" when setting up the cluster. When you create topics, Kafka's controller distributes partition replicas across whatever brokers already exist. A broker with no partitions for a given topic simply doesn't participate in that topic.

## Broker and partition sizing

Brokers and partitions are independent decisions that interact:

| You decide                        | Kafka decides                                 |
| --------------------------------- | --------------------------------------------- |
| How many brokers (cluster sizing) | Which broker hosts which partition replica    |
| How many partitions per topic     | Leader distribution (balanced across brokers) |
| Replication factor                | ISR membership (based on replication lag)     |
| `min.insync.replicas`             | Leader election on failure                    |
| `acks` level                      | Replica placement (rack-aware if configured)  |

**Key constraint:** `replication-factor` cannot exceed the broker count — you can't place 5 copies on 4 brokers.

Example — 4 partitions, replication-factor=3, across 4 brokers:

```
Broker 0              Broker 1              Broker 2              Broker 3
┌────────────────┐   ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
│ P0 ★ leader    │   │ P0   follower  │   │ P0   follower  │   │                │
│ P1   follower  │   │ P1 ★ leader    │   │                │   │ P1   follower  │
│                │   │ P2   follower  │   │ P2 ★ leader    │   │ P2   follower  │
│ P3   follower  │   │                │   │ P3   follower  │   │ P3 ★ leader    │
└────────────────┘   └────────────────┘   └────────────────┘   └────────────────┘
  3 replicas           3 replicas           3 replicas           3 replicas
  1 leader             1 leader             1 leader             1 leader
```

- 4 partitions × 3 replicas = 12 total replica placements across 4 brokers = 3 per broker
- Each partition's 3 replicas are always on **different brokers** (same-broker replicas would defeat fault tolerance)
- Kafka balances leaders evenly — each broker hosts 1 leader
- For each partition, one broker has no copy of it (4 brokers, only 3 needed)

**Replication-factor=3 means 3 total copies: 1 leader + 2 followers.** The leader IS counted as one of the replicas.

### Common production sizing

```
Typical production setup:
  Brokers:              3-5 (for fault tolerance)
  replication-factor:   3   (survives 1 broker failure with min.insync.replicas=2)
  Partitions per topic: 6-12 (depends on throughput needs)
  min.insync.replicas:  2   (with acks=all)

Failure scenarios:
  Lose 1 broker → no data loss, automatic leader election, still writing
  Lose 2 brokers → writes rejected (1 ISR < min.insync=2), but no data loss
  Lose 3 brokers → data potentially unavailable until recovery
```

The "3 brokers, replication-factor=3" setup is common but fragile — losing 1 broker puts you at exactly `min.insync.replicas=2`, one more failure away from a write outage. With 4+ brokers and replication-factor=3, losing 1 still leaves 3 candidates per partition, giving you breathing room to repair.

## Topics and partitions

A topic is split into partitions at creation time. Each partition is an independent, ordered, append-only log with its own offset sequence (0, 1, 2, ...).

```
Topic: "inventory-updates" (3 partitions)

  Partition 0 (Broker 0)     Partition 1 (Broker 1)     Partition 2 (Broker 2)
  ┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
  │ offset 0: msg-A  │       │ offset 0: msg-E  │       │ offset 0: msg-H  │
  │ offset 1: msg-B  │       │ offset 1: msg-F  │       │ offset 1: msg-I  │
  │ offset 2: msg-C  │       │ offset 2: msg-G  │       └──────────────────┘
  │ offset 3: msg-D  │       └──────────────────┘
  └──────────────────┘
```

The partition count determines the maximum consumer parallelism and the ordering boundaries. Choose it upfront — changing it later breaks key-based ordering.

### How messages land in a partition

```java
// Kafka's DefaultPartitioner (simplified)
if (key != null) {
    partition = murmur2(key) % numPartitions;    // deterministic hash
} else {
    partition = stickyCounter++ % numPartitions;  // round-robin per batch
}
```

**It's a simple modulo hash, not consistent hashing.** This is deliberate — Kafka partitions are rarely changed after creation, so the problem consistent hashing solves (minimizing key redistribution on resize) barely exists. Consistent hashing is for systems where nodes come and go (caches, distributed DBs); Kafka partitions are fixed infrastructure.

The sticky partitioner (Kafka 2.4+) batches keyless messages to the same partition before rotating, improving throughput by creating larger network batches.

Custom partitioners are possible (e.g., routing by region or priority), but most teams use the default.

## Replication — leader, followers, ISR

Every partition has one **leader** and N-1 **followers**. The `replication-factor` is set at topic creation.

```
Topic: 3 partitions, replication-factor=3

Broker 0              Broker 1              Broker 2
┌────────────────┐   ┌────────────────┐   ┌────────────────┐
│ P0 ★ LEADER    │   │ P0   follower  │   │ P0   follower  │
│ P1   follower  │   │ P1 ★ LEADER    │   │ P1   follower  │
│ P2   follower  │   │ P2   follower  │   │ P2 ★ LEADER    │
└────────────────┘   └────────────────┘   └────────────────┘
```

- All reads and writes go through the leader (follower reads have been available since Kafka 2.4, but aren't the default).
- Followers continuously replicate from the leader.
- **ISR (In-Sync Replicas)** = the replicas that are caught up with the leader. A follower that falls behind is removed from the ISR.
- If the leader dies, a follower from the ISR is elected as the new leader automatically.

### The `acks` setting — durability vs. speed

```
acks=0    → fire and forget (fastest, can lose messages)
acks=1    → wait for leader to write (message lost if leader crashes before replication)
acks=all  → wait for ALL ISR replicas to confirm (slowest, survives any single broker failure)
```

**The production standard:** `acks=all` + `min.insync.replicas=2`. This means at least 2 replicas must confirm the write. If fewer than 2 are in the ISR, the write is rejected with `NotEnoughReplicasException` — Kafka chooses data integrity over availability.

## Consumer groups

A consumer group is a set of consumers that divide partitions among themselves. Each partition goes to exactly one consumer in the group.

```
Consumer Group A: "inventory-worker" (3 consumers)
  Consumer A-1 → reads P0 (offset: 3)
  Consumer A-2 → reads P1 (offset: 2)
  Consumer A-3 → reads P2 (offset: 1)
```

Rules:

- Consumers > partitions → some consumers sit idle
- Consumers < partitions → some consumers handle multiple partitions
- Each consumer tracks its offset per assigned partition

### Multiple consumer groups = fan-out

Different groups are independent readers of the same physical log — no copies are made.

```
Same partitions, same bytes on disk

Consumer Group A: "sync-worker"        Consumer Group B: "analytics"
  A-1 → P0 @offset 3                    B-1 → P0 @offset 0  (just started)
  A-2 → P1 @offset 2                    B-1 → P1 @offset 0
  A-3 → P2 @offset 1                    B-1 → P2 @offset 0
```

Group A committing offset 3 has zero effect on Group B. They maintain separate offset cursors in Kafka's internal `__consumer_offsets` topic. This is why Kafka fan-out is storage-cheap — 10 groups = 10 sets of cursors, not 10 copies of the messages.

### Offset commit — the "done up to here" model

```
Consumer processing Partition 0:
  offset 0: msg-A  ✓ processed
  offset 1: msg-B  ✓ processed
  offset 2: msg-C  ✗ FAILED
  offset 3: msg-D  ✓ processed

  Options:
  1. Commit offset 4 → msg-C is lost (skipped)
  2. Commit offset 2 → reprocess C AND D on restart (duplicate for D)
  3. Commit offset 4 + produce msg-C to a DLQ topic → no loss, no duplicates
     (but DLQ is YOUR code's responsibility)
```

There is no "ack C, nack B" — the offset is a single cursor. Everything before it is "done."

### Rebalancing — the operational cost

When a consumer joins, leaves, or crashes, Kafka reassigns partitions across the group. During a rebalance, **all consumers in the group pause**.

```
BEFORE: A-1→P0, A-2→P1, A-3→P2
A-3 crashes → REBALANCING (all pause)
AFTER:  A-1→P0+P2, A-2→P1
```

This "stop the world" window can last from seconds to minutes. It's the main operational pain point of Kafka consumer groups.

## Gotchas

- **Changing the partition count breaks key ordering.** `hash(key) % 3` and `hash(key) % 4` map to different partitions, so messages for the same key end up split across old and new partitions. Avoid changing the partition count in production.
- **`acks=1` loses messages in production.** If the leader crashes after acknowledging but before the followers replicate, the message is gone. Most teams learn this the hard way and switch to `acks=all`.
- **ISR shrinkage is a silent alarm.** A slow disk on one broker causes its follower replicas to fall out of the ISR. If `min.insync.replicas=2` and only the leader is in the ISR, all writes start failing. Monitor the ISR count per partition.
- **More consumers than partitions = wasted resources.** Unlike Pub/Sub (which distributes messages to any available worker), Kafka assigns whole partitions. 3 partitions with 5 consumers means 2 consumers do nothing.
- **Rebalancing frequency scales with group size.** Large consumer groups (20+ consumers) with frequent deploys trigger frequent rebalances, each pausing the entire group. Consider static partition assignment or the cooperative rebalancing protocol to mitigate this.
- **The partition count is the hardest thing to change.** You can add brokers (Kafka rebalances replicas). You can increase the replication factor (Kafka adds followers). But changing the partition count breaks key-based ordering, because `hash(key) % N` changes. Over-provision partitions upfront — idle partitions are cheaper than a topic migration later.
- **3 brokers with replication-factor=3 is fragile.** Losing 1 broker leaves you at exactly `min.insync.replicas=2` — one more failure stops writes. Use 4+ brokers for production headroom.

## References

- [Kafka documentation — Design](https://kafka.apache.org/documentation/#design)
- [Kafka documentation — Replication](https://kafka.apache.org/documentation/#replication)
- [Kafka documentation — Consumer configs](https://kafka.apache.org/documentation/#consumerconfigs)
- [KIP-480 — Sticky Partitioner](https://cwiki.apache.org/confluence/display/KAFKA/KIP-480%3A+Sticky+Partitioner)
