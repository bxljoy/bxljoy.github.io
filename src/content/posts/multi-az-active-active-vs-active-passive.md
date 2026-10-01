---
title: "Multi-AZ patterns: active-active vs. active-passive across AWS services"
description: "Why 'Multi-AZ' means an idle standby for stateful services like RDS but parallel workers for stateless ones like Fargate, a service-by-service map, the state-ownership principle behind it, cost implications, and what Multi-AZ doesn't protect against."
pubDatetime: 2026-10-01T11:43:00+02:00
tags: [aws, high-availability, ecs-fargate, rds, multi-az]
sourceNotes: [multi-az-active-active-vs-active-passive]
---

> "Multi-AZ" means different things depending on whether the service is stateful or stateless. RDS Multi-AZ is active-passive (the standby is idle, just waiting for failover). ECS Fargate, SQS workers, and Kafka consumers across AZs are active-active — every instance does work in parallel. Saying "Multi-AZ for HA" without knowing which pattern applies hides a distinction that matters for cost, throughput, and failover.

## Table of contents

## Overview

The phrase "Multi-AZ for high availability" gets used uniformly across AWS services, but it hides a fundamental split: stateful services (RDS, ElastiCache primary/replica) replicate **active-passive**, with an idle standby that exists only for failover, while stateless services (Fargate, Lambda, ALB, SQS workers, Kafka consumers) deploy **active-active**, with every instance handling production traffic. Confusing the two patterns leads to misunderstandings about cost, throughput, and what "the second instance" actually does. This post maps the patterns across common AWS services and explains the underlying principle.

## Key points

- **Active-passive** (stateful): one primary handles all reads and writes. The standby is synchronously replicated, **cannot be queried**, and exists only for failover. You pay 2x the cost for HA.
- **Active-active** (stateless): all instances handle traffic in parallel. There's no "primary" concept. You pay 2x the cost for HA _and_ get 2x the throughput.
- **Stateful = active-passive**, because two writers would conflict on the same data. A single primary preserves consistency.
- **Stateless = active-active**, because any instance can handle any request — there's no shared mutable state in the JVM.
- **RDS Multi-AZ ≠ Read Replicas.** Multi-AZ is sync replication for failover (the standby is unreadable). Read Replicas are async replication for read scaling (the replicas serve reads).
- **The standby in RDS Multi-AZ does literally nothing useful** during normal operation. This is a common misconception.
- **For stateless services, "the second AZ task" is doing the same work as the first** — a load balancer or message broker splits the load.

## Active-passive: stateful services

### RDS Multi-AZ (the canonical example)

```
Primary (eu-north-1a) ─── synchronous replication ──► Standby (eu-north-1b)
   ACTIVE                                                  IDLE
   handles ALL reads + writes                              cannot be queried
                                                          (just waiting for failover)
```

**Key facts:**

- Synchronous replication — every write is committed on both before returning. Zero data loss.
- The standby has its own EBS volumes; it's not "the same disk attached twice".
- The application connects via a single DNS endpoint. On failover, RDS swings the DNS to the standby, and the app reconnects.
- Failover takes 60–90 seconds (DNS TTL + reconnect time).
- **The standby is invisible to applications.** There's no way to send queries to it — it's pure dead weight during normal operation.

### What if you want to read from the standby?

You can't — that's not what it's for. To offload reads, you add **Read Replicas**, which are a separate feature:

```
Primary ─── async replication ──► Read Replica 1
   │                              (queryable for reads)
   │
   └─── async replication ──► Read Replica 2
                              (queryable for reads)
```

Read replicas are async, so they may lag. Apps must tolerate read-after-write inconsistency (e.g. a user updates their profile → reads from a replica → still sees the old data for a few hundred ms). See [the read-after-write problem](/posts/scaling-databases-replicas-partitioning-sharding/#the-read-after-write-problem) for the strategies.

You can run **both** Multi-AZ AND Read Replicas — Multi-AZ for failover, Read Replicas for read scaling. They're independent features.

## Active-active: stateless services

### ECS Fargate across AZs

```
Task 1 (eu-north-1a)        Task 2 (eu-north-1b)
   ACTIVE                       ACTIVE
   processes work              processes work
   in parallel                 in parallel
```

Both tasks are live; neither is a backup. **The Multi-AZ benefit is fault tolerance, but the throughput is also doubled.**

How traffic is split:

- **HTTP requests:** the ALB does round-robin or least-outstanding-requests across all healthy tasks, regardless of AZ
- **SQS workers:** all tasks compete for messages from the same queue
- **Kafka consumers:** Kafka assigns partitions across all consumers in the group, regardless of AZ

What happens on an AZ failure:

1. ECS detects the unhealthy task (health check, ~30 sec)
2. The ALB stops routing traffic to that AZ's task
3. The surviving task(s) absorb the load (degraded throughput)
4. ECS launches a replacement task in another AZ (~60–90 sec)
5. Back to full capacity

## Service-by-service map

| Service                                 | Multi-AZ pattern                                  | Are all instances doing work?                     | Notes                                                |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| **RDS (Postgres, MySQL, etc.)**         | Active-passive (sync)                             | **No** — the standby is idle                      | The primary serves all queries                       |
| **RDS Read Replicas**                   | Active-active (async)                             | Yes — replicas serve reads                        | A separate feature from Multi-AZ                     |
| **Aurora**                              | Active-active for reads, single writer for writes | Yes for reads, no for writes                      | Up to 15 read replicas, async to the writer          |
| **DynamoDB**                            | Active-active multi-AZ inside a Region            | Yes — replicated across AZs natively              | Built in, transparent to the user                    |
| **ElastiCache Redis (primary/replica)** | Active-passive for writes                         | Replicas can serve reads                          | Failover swaps the primary role                      |
| **ElastiCache Redis (cluster mode)**    | Active-active, sharded                            | Yes — keys distributed across nodes               | Each shard has its own primary/replica pair          |
| **MSK Kafka brokers**                   | Active-active                                     | Yes — partition leadership is distributed         | Each broker leads some partitions and follows others |
| **ECS Fargate (any role)**              | Active-active                                     | **Yes** — all tasks process                       | Stateless, identical                                 |
| **EC2 with ALB**                        | Active-active                                     | Yes — the ALB routes across all healthy instances | Same as Fargate                                      |
| **Lambda**                              | Active-active across AZs, implicitly              | Yes — invocations spread across AZs               | No user-visible AZ affinity                          |
| **ALB / NLB**                           | Active-active                                     | Yes — DNS routes traffic to all AZ ENIs           | Multi-AZ is automatic                                |
| **S3**                                  | Active-active multi-AZ inside a Region            | Yes — replicated across 3+ AZs natively           | Built in                                             |
| **EBS volumes**                         | Single-AZ                                         | N/A — bound to one AZ                             | Use snapshots / EBS Multi-Attach for HA              |

**The pattern:** anything with mutable state behind a single endpoint = active-passive. Anything stateless or sharded = active-active.

## Why the difference: state ownership

**Stateful services** can't have two active writers without conflict:

- Two Postgres primaries accepting writes for the same row → which version wins?
- Two Redis primaries accepting `SET key value` → split brain
- Two Kafka brokers both thinking they own partition 0 → message duplication

To preserve consistency: **one writer at a time.** The standby exists only as a failover target.

**Stateless services** have no in-process mutable state:

- Two Fargate tasks handling HTTP requests → each request is independent, with no shared memory
- Two SQS workers pulling from a queue → SQS handles message-level ordering and locking
- Two Kafka consumers in a group → Kafka assigns disjoint partitions to each

To scale and survive failures: **all active, in parallel.**

## Cost implications

| Pattern                                             | Cost vs. a single instance | Throughput vs. a single instance |
| --------------------------------------------------- | -------------------------- | -------------------------------- |
| Single AZ (1 instance)                              | $X (baseline)              | 1x — but no HA                   |
| Multi-AZ active-passive (RDS)                       | $2X                        | 1x — the standby is dead weight  |
| Multi-AZ active-active (Fargate)                    | $2X                        | **2x** — both instances work     |
| Active-passive + Read Replica (RDS Multi-AZ + 1 RR) | $3X                        | 1x writes, 2x reads              |

Stateless services give you HA "for free", in the sense that the second instance also adds capacity. Stateful services pay for HA twice over (the standby is pure overhead).

## Worked example: 2 Fargate Kafka consumer tasks across AZs

```
Topic: refund.events (12 partitions)
Consumer Group: dashboard-service
Spring concurrency = 3 per task

Task 1 (eu-north-1a)        Task 2 (eu-north-1b)
├── Consumer 1 (partition 0,1)   ├── Consumer 4 (partition 6,7)
├── Consumer 2 (partition 2,3)   ├── Consumer 5 (partition 8,9)
└── Consumer 3 (partition 4,5)   └── Consumer 6 (partition 10,11)
```

**All 6 consumers are actively polling and processing.** Both tasks contribute to throughput; neither is a "backup".

When eu-north-1a goes down:

1. ECS detects that Task 1 is unhealthy (~30 sec)
2. Kafka detects that consumers 1, 2, and 3 have stopped heartbeating (~10 sec session timeout)
3. Kafka rebalances → consumers 4, 5, and 6 each take 4 partitions
4. Task 2 continues processing all 12 partitions (degraded throughput, ~50% of normal speed)
5. ECS launches a replacement Task 1 in another AZ (~60–90 sec)
6. Kafka rebalances again → back to 6 consumers with 2 partitions each

Throughput dips during the failover window, then recovers. **Task 2 was never idle and waiting** — it was already busy with its 6 partitions.

## When Multi-AZ is NOT enough

Multi-AZ protects against **AZ failure**. It does NOT protect against:

| Failure                               | Mitigation                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| A whole-region outage                 | Cross-region read replicas + manual promotion (RDS), or DynamoDB Global Tables  |
| Database corruption / a bad migration | Backups, point-in-time restore (corruption replicates to the standby instantly) |
| An account/security breach            | Separate AWS accounts for blast-radius isolation                                |
| A bad code deploy                     | Canary deployments, feature flags, rollback automation                          |
| DDoS / capacity exhaustion            | WAF, AWS Shield, autoscaling headroom                                           |

For most prototypes, and even most production services, Multi-AZ is enough. Region-level DR is only worth it if regional failure is in scope or the workload is genuinely critical (payments, identity, healthcare).

## Gotchas

- **"Multi-AZ" without specifying the service is ambiguous.** Always pair it with what's running: "Multi-AZ RDS" (active-passive), "Multi-AZ Fargate" (active-active). They're not the same thing.
- **The RDS Multi-AZ standby cannot be queried** — it's a common misconception that you can read from it for reporting/analytics. Use Read Replicas instead.
- **Aurora behaves differently from RDS.** Aurora is _active-active for reads_ (replicas can be queried) but still single-writer. Don't conflate Aurora with vanilla RDS.
- **EBS volumes are single-AZ.** A Fargate task using an EBS volume loses access if that AZ fails. Use EFS (a multi-AZ filesystem) or stateless tasks for portability.
- **DynamoDB Global Tables vs. Multi-AZ.** Multi-AZ inside one Region is automatic. Global Tables (multi-Region) are opt-in and add eventual-consistency complexity.
- **The cost of HA is real.** Multi-AZ doubles your bill for stateful services, with no throughput benefit. Justify it on RPO/RTO requirements, not on "we should always do HA".
- **Failover is not instant.** RDS: 60–90s. ALB + Fargate: ~30s health check + ~60s task launch = 90s+. Plan for brief downtime windows, not zero downtime.
- **Cross-AZ data transfer costs money.** ~$0.01/GB between AZs in the same Region. For chatty services (e.g. heavy DB query traffic), it can add up; for most apps, it's negligible.

## References

- Related: [Scaling the database: read replicas, partitioning, and sharding](/posts/scaling-databases-replicas-partitioning-sharding/) · [CAP, PACELC, consistency models, and consensus](/posts/cap-pacelc-consistency-and-consensus/)
- [AWS RDS Multi-AZ](https://aws.amazon.com/rds/features/multi-az/)
- [AWS ECS service auto scaling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html)
- [AWS Well-Architected Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/)
