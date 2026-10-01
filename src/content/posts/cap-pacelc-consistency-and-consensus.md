---
title: "Distributed systems theory: CAP, PACELC, consistency models, and consensus"
description: "What CAP actually says (and why 'pick 2 of 3' is a myth), what PACELC adds, the consistency-model spectrum, linearizability vs. serializability, and how Raft and quorums build CP systems."
pubDatetime: 2026-09-30T19:55:00+02:00
tags: [distributed-systems, consistency, consensus, system-design]
sourceNotes: [distributed-systems-cap-pacelc-consistency-and-consensus]
---

> CAP is misremembered as "pick 2 of 3" — really it says that _during a network partition_ you must choose Consistency **or** Availability (P is not optional in a distributed system). PACELC extends it: **E**lse (no partition), you still trade **L**atency against **C**onsistency. "Consistency" here means **linearizability**, the strongest point on a spectrum running down to eventual consistency — and it is _not_ the C in ACID, nor the same as serializability. You _build_ a strongly consistent (CP) system with **consensus** (Raft/Paxos) over a majority **quorum**; you keep an available (AP) system correct with convergence plus conflict resolution.

## Table of contents

## Overview

This is the theory layer beneath patterns covered in practice elsewhere — [the outbox pattern](/posts/outbox-pattern-and-dual-write-problem/), [sagas](/posts/saga-choreography-orchestration-and-compensation/), idempotency, and [multi-AZ active-active vs. active-passive](/posts/multi-az-active-active-vs-active-passive/) deployments. The goal is precise vocabulary: most confusion here comes not from not knowing the ideas, but from stating CAP loosely or conflating the two "consistencies".

## Key points

- **CAP is a partition-time choice.** Networks _will_ partition, so partition tolerance (P) is mandatory. The real decision is **CP vs. AP** — what you do _when a partition happens_. "Pick 2 of 3" is a myth.
- **A "CA system" doesn't exist across a network.** CA only describes a single node (a lone Postgres). The moment you replicate over a network, P is forced.
- **PACELC is the better framing.** Partition → A or C; **Else** → **L**atency or **C**onsistency. Strong consistency costs coordination latency _even when nothing is broken_.
- **CAP's "C" = linearizability**, not ACID consistency. ACID's C is "transactions preserve invariants" — a totally different meaning of the same word.
- **Consistency is a spectrum**, from strongest to weakest: linearizable → sequential → causal → (session guarantees) → eventual. Weaker = cheaper and more available.
- **Linearizability ≠ serializability.** Linearizability is a _recency/real-time_ guarantee on a single object; serializability is a _transaction-isolation_ guarantee over many objects. **Strict serializability** = both (Spanner's gold standard).
- **Consensus builds CP systems.** Raft/Paxos get a **majority quorum** to agree on an ordered log. A majority is needed because any two majorities overlap, so they can't commit conflicting decisions → no split-brain.
- **Quorum math:** N nodes tolerate ⌊(N−1)/2⌋ failures (3 → 1, 5 → 2). Even-sized clusters waste a node (4 tolerates the same as 3). In leaderless replication, **R + W > N** makes a read overlap the latest write.
- **Eventual consistency is a deliberate trade, not "broken".** Correctness comes from replicas _converging_ once writes stop, plus conflict resolution (LWW / vector clocks / CRDTs).

## CAP theorem (Gilbert & Lynch, 2002)

Three properties:

- **Consistency (C)** — every read sees the most recent completed write (this _is_ linearizability).
- **Availability (A)** — every request to a non-failed node gets a non-error response (with no guarantee that it's the latest).
- **Partition tolerance (P)** — the system keeps operating despite arbitrarily dropped or delayed messages between nodes.

The theorem: **when a partition occurs, you cannot have both C and A.** Since real networks partition, P isn't negotiable — so the design choice is:

| Choice | Behavior during a partition                                                            | Examples                                                 |
| ------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **CP** | Refuse requests on the minority side to preserve consistency → sacrifices availability | etcd, ZooKeeper, HBase, Spanner, consensus-backed stores |
| **AP** | Serve on both sides, reconcile later → may return stale or conflicting data            | Cassandra, DynamoDB (eventual mode), Riak                |
| **CA** | Only coherent for a _single node_ — not achievable across a network                    | A single-instance RDBMS                                  |

**The "pick 2 of 3" trap:** you don't get to drop P. You pick C or A, and only _during the partition_ — when the network is healthy, a CP system is both consistent and available.

## PACELC (Abadi, 2012) — what CAP omits

CAP only describes the partition case. PACELC adds the normal case:

```
if (Partition):  choose Availability or Consistency      ← CAP
else:            choose Latency or Consistency           ← the part CAP ignores
```

Strong consistency requires coordination (quorum round trips, leader hops) → latency, even with zero partitions. So:

| Class     | Partition behavior          | Normal behavior                  | Examples                             |
| --------- | --------------------------- | -------------------------------- | ------------------------------------ |
| **PC/EC** | Consistent (less available) | Consistent (higher latency)      | etcd, Spanner, sync-replicated RDBMS |
| **PA/EL** | Available                   | Low latency (weaker consistency) | Cassandra, DynamoDB (defaults), Riak |
| **PC/EL** | Consistent                  | Low latency in normal ops        | MongoDB (primary reads, default-ish) |
| **PA/EC** | Available                   | Consistent normally              | Rare                                 |

PACELC is the more useful framing — it captures that consistency has a cost even when the network is fine.

## Consistency models — the spectrum

Strongest at the top. Each is implementable; the weaker ones are cheaper and more available.

| Model                                   | Guarantee                                                                                                                                     | Cost                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Linearizability** (atomic / "strong") | A single real-time order exists; once a write returns, every later read (by wall clock) sees it. Ops appear instantaneous. **Single-object.** | Highest — needs coordination      |
| **Sequential consistency**              | All nodes agree on _one_ order of ops, but not necessarily the real-time order                                                                | High                              |
| **Causal consistency**                  | Causally related ops are seen in the same order everywhere; concurrent ops may differ. ("If A caused B, no one sees B before A.")             | Moderate — no global clock needed |
| **Session guarantees**                  | Per client: **read-your-writes**, **monotonic reads** (never go backwards), **monotonic writes**, **writes-follow-reads**                     | Low                               |
| **Eventual consistency**                | If writes stop, all replicas converge. No recency or order guarantee meanwhile                                                                | Lowest — most available           |

## Linearizability vs. serializability (the classic confusion)

- **Linearizability** — a _consistency_ model for single objects/registers. It's about **recency and real-time order**: "the latest write is immediately visible".
- **Serializability** — an _isolation_ level for _transactions_ over multiple objects. Transactions appear to run in _some_ serial order. It says **nothing about real time** — the serial order can differ from wall-clock order.
- **Strict serializability** = serializability **+** linearizability: transactions in a serial order that also respects real time. This is the gold standard (Google Spanner, via TrueTime).

> Mnemonic: _linearizability is about a single object being up to date; serializability is about a set of transactions not interleaving badly._ They're orthogonal guarantees that compose into strict serializability.

Serializability as an isolation level inside a single database — Read Committed → Repeatable Read → Serializable, write skew, MVCC — pairs with this section; see [Postgres isolation levels and MVCC](/posts/postgres-isolation-levels-and-mvcc/).

## Consensus — how a CP system actually agrees

**The problem:** make a set of nodes agree on a single value, or on an ordered _log_ of operations, despite crashes and message loss. **It's used for:** leader election, replicated state machines, distributed locks, cluster config (etcd/ZooKeeper), the Kafka controller (KRaft), and DB replication topology.

**Quorum = majority (⌊N/2⌋ + 1).** Any two majorities share at least one node, so two conflicting decisions can't both reach a majority → safety. Fault tolerance:

| N nodes | Majority | Failures tolerated                             |
| ------- | -------- | ---------------------------------------------- |
| 3       | 2        | 1                                              |
| 5       | 3        | 2                                              |
| 4       | 3        | 1 (no better than 3 — even sizes waste a node) |

### Raft (the understandable one)

- **Roles:** leader, follower, candidate. One leader per term.
- **Term:** a logical clock that increments with each election; there's at most one leader per term.
- **Leader election:** a follower that hears nothing for an election timeout becomes a candidate, increments the term, and requests votes. Winning a majority → leader. Randomized timeouts make split votes rare.
- **Log replication:** clients send commands to the leader; it appends them to its log and replicates to followers. An entry is **committed** once a majority has it; committed entries are applied to the state machine in order.
- **Safety (the election restriction):** a node won't vote for a candidate whose log is less up to date, so a new leader always has all committed entries — committed data is never lost.
- **Split-brain prevention:** only the majority side of a partition can elect a leader or commit. The minority side can't make progress → no divergence.

**Paxos** is the original (correct, and famously hard to follow); **Multi-Paxos** handles a log. **Raft** was designed as an equivalent that humans can actually implement. **ZAB** (ZooKeeper) and **Viewstamped Replication** are siblings.

## Leaderless / quorum replication (Dynamo-style)

There's no single leader; clients write to many replicas. It's tunable with **N** (replicas), **W** (write quorum), and **R** (read quorum):

- **R + W > N** ⇒ any read quorum overlaps any write quorum ⇒ reads see the latest write (strong-ish consistency).
- `W=N, R=1` → fast reads, slow and fragile writes. `W=1, R=N` → the opposite. `W=R=⌈(N+1)/2⌉` → balanced.
- **Sloppy quorum + hinted handoff** trade strict overlap for availability under partition (Cassandra/Dynamo).
- **Conflict resolution** when replicas diverge: last-write-wins (simple, but can silently drop data), **vector clocks** (detect concurrent writes), **CRDTs** (data types that merge deterministically).

## Split-brain and fencing

Two nodes both believing they're the leader → conflicting writes → corruption. The defenses:

- **Quorum** — only the majority partition can act (the primary mechanism above).
- **Fencing tokens** — each leadership grant carries a monotonically increasing token; storage rejects writes carrying a stale token, so a zombie old leader can't corrupt state.
- **STONITH** ("shoot the other node in the head") — forcibly power off the suspected-dead node before failover.

## How this connects to other topics

- [Multi-AZ active-active vs. active-passive](/posts/multi-az-active-active-vs-active-passive/) — active-active is an AP/availability lean; active-passive with synchronous replication leans CP. CAP/PACELC is the formal lens for that choice.
- [The outbox pattern](/posts/outbox-pattern-and-dual-write-problem/) and [at-least-once delivery → exactly-once effect](/posts/at-least-once-to-exactly-once-effect/) — how you stay _correct_ in an eventually consistent (AP) world: idempotency plus convergence.
- [Kafka core architecture](/posts/kafka-core-architecture/) — partitions have a leader plus follower replicas with an **ISR** (in-sync replicas) set; `acks=all` + `min.insync.replicas` is a quorum-style durability knob; the controller is consensus-elected (KRaft).
- **Compare-and-swap** is the single-object primitive that linearizability is defined around.

## Gotchas

- **"Pick 2 of 3" is wrong.** P is mandatory in any networked system; you choose C or A, and only during a partition. A healthy CP system is both C and A.
- **CAP's C is not ACID's C.** CAP-C = linearizability (recency). ACID-C = "transactions preserve invariants". Same word, unrelated meanings — say which one you mean.
- **"We're a CA system" is a red flag.** CA = a single node. Claiming CA for a distributed store signals a misunderstanding of CAP.
- **Linearizability ≠ serializability.** Mixing these up is the most common slip here: single-object recency vs. multi-object transaction isolation.
- **Eventual consistency isn't "weak" or "broken".** It's a deliberate availability/latency trade; correctness is recovered by convergence plus conflict resolution. Don't disparage it — articulate the trade.
- **Strong consistency isn't free even without partitions** (PACELC's E). Every linearizable read or write pays coordination latency. People forget the "Else".
- **Even-numbered clusters waste a node.** 4 tolerates the same single failure as 3, but needs more acks. Run odd sizes (3, 5, 7).
- **A 2-node cluster has no quorum fault tolerance.** A majority of 2 is 2 — lose one and you can't form a majority. For consensus, two nodes give you _less_ availability than one, not more.
- **Spanner doesn't "beat CAP".** It's CP: under a partition it still chooses consistency over availability. TrueTime just shrinks the uncertainty window so that the consistency cost is tiny in practice.
- **Beware the fallacies of distributed computing** — "the network is reliable / latency is zero / bandwidth is infinite". Every guarantee above exists _because_ those are false.
- **Read-your-writes is often what users actually demand**, not full linearizability. A user editing their profile must see their own change; they don't care about global real-time order. Picking the _weakest sufficient_ model is the right call.

## References

- Earlier in this topic:
  - [The outbox pattern and the dual-write problem](/posts/outbox-pattern-and-dual-write-problem/) · [At-least-once delivery → exactly-once effect](/posts/at-least-once-to-exactly-once-effect/) — staying correct under eventual consistency.
- Related: [Kafka core architecture](/posts/kafka-core-architecture/) — ISR, `acks=all`, and the KRaft controller as applied quorum/consensus.
- _Designing Data-Intensive Applications_ (Kleppmann) — ch. 5 (replication) and ch. 9 (consistency and consensus), the canonical treatment.
- Raft: "In Search of an Understandable Consensus Algorithm" (Ongaro & Ousterhout); a visual walkthrough at [thesecretlivesofdata.com/raft](http://thesecretlivesofdata.com/raft/).
- Gilbert & Lynch — the formal CAP proof; Abadi — the PACELC paper.
- Jepsen's consistency-model map: [jepsen.io/consistency](https://jepsen.io/consistency).
