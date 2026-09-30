---
title: "At-least-once delivery → exactly-once effect: idempotent consumers, status convergence vs. ordered processing, and resequencers"
description: "Why delivery can't be exactly-once but the effect can: the atomic dedup transaction, the convergence-vs-ordered-processing fork, partition-key ordering, application-level resequencers, and head-of-line blocking."
pubDatetime: 2026-09-30T11:47:00+02:00
tags: [idempotency, messaging, distributed-systems]
sourceNotes: [at-least-once-to-exactly-once-effect-and-ordered-processing]
---

> You can't make delivery exactly-once — that's physically impossible over an unreliable network. You make the _effect_ exactly-once. The right mechanism forks on one question: do you only need the final state (convergence → guard with a rank), or must every event run in order (ordered processing → resequencer)? Dedup, completeness, and ordering are three orthogonal concerns.

## Table of contents

## Overview

Webhook, Pub/Sub, and Kafka consumers receive events under at-least-once delivery, so duplicates and out-of-order arrival are _guaranteed_, not exceptional. This post is the consumer-side reliability playbook: how to turn at-least-once delivery into an exactly-once effect, and — critically — how the solution differs depending on whether you need _state convergence_ (only the final value matters) or _ordered processing_ (every event has its own side effects and must run in sequence).

It came out of building an idempotent delivery-event processor, and then realizing the harder variant where each event does distinct work.

## Key points

- **Delivery can't be exactly-once; the effect can.** Frame the job as "exactly-once effect", not "perfect dedup".
- **Three orthogonal concerns:** dedup (process at _most_ once), completeness (process at _least_ once), ordering (process in sequence). Dedup + completeness = exactly-once. Add ordering and you're in the hardest tier.
- **Convergence vs. ordered processing is the key fork.** If only the final state matters → drop stale events with a monotonic _rank guard_ (last-writer-wins). If every event has side effects and all must run in order → never drop; _buffer and resequence_.
- **The production exactly-once effect = one atomic transaction.** `INSERT event_id (UNIQUE)` + the effect, committed together. The unique constraint is the dedup; the shared transaction closes the crash-after-claim gap that an in-process `Set` cannot.
- **For per-entity ordering, push ordering into the transport.** Partition by entity id (Kafka partition key / Pub/Sub ordering key) → in-order, single-consumer delivery per key, parallel across keys. Build an app-level resequencer only when you can't control transport order.
- **Strict ordering implies head-of-line blocking on failure.** A failed event blocks its key; that's correct, but the poison-message policy (block-and-alert vs. skip-to-DLQ) is a product decision to surface, not to pick silently.
- **Compare by source timestamp / sequence, never by receive time.** Receive time is corrupted by the very reordering you're defending against.

## The framing

> "At-least-once delivery means duplicates and reordering are guaranteed. I can't make delivery exactly-once over an unreliable network — what I make exactly-once is the _effect_: the work happens once, in the right order, no matter how the events arrive."

## The in-process baseline and its gap

The minimal idempotent consumer: dedup by `eventId` with an atomic claim, then do the side effect.

```java
public boolean process(DeliveryEvent event) {
    validate(event);                         // fail-fast, BEFORE dedup (don't poison the set)
    if (seen.add(event.eventId())) {         // ConcurrentHashMap.newKeySet(); add() == "I won the race"
        store.updateStatus(event.messageId(), event.status());
        return true;
    }
    return false;                            // duplicate
}
```

Two shapes — one is wrong:

| Order                      | Race-safe?                                         | Crash-safe?                                                                       |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| **add → effect** (correct) | ✅ only one thread claims                          | ❌ if the effect throws after the claim, a retry is deduped and the event is lost |
| **check → effect → add**   | ❌ two threads both pass the check → double effect | ✅-ish                                                                            |

You cannot get both with a plain `Set` — which is exactly why the production answer is different. The in-process patch is a compensating `seen.remove(eventId)` in a catch block (which still has a race window). The real fix is a single transaction (below).

Also, an in-process `Set` doesn't survive a restart and doesn't span instances, so it can never be the source of truth for a multi-pod fleet.

## Production exactly-once effect: one atomic transaction

```sql
BEGIN
  INSERT INTO processed_events (event_id) VALUES (:eventId);   -- UNIQUE(event_id) == dedup
  -- ... the effect (UPDATE / INSERT / etc.) ...
COMMIT
```

- The `UNIQUE(event_id)` constraint **is** the dedup — a duplicate violates it and rolls the whole transaction back. It's the SQL form of `computeIfAbsent`; `INSERT ... ON CONFLICT DO NOTHING` is the same idea.
- Claim + effect in **one** transaction closes the crash-after-claim gap: if the effect fails, the claim rolls back too, so the event is _not_ marked processed and a retry re-runs cleanly.
- **Ack only after commit.** On Pub/Sub: ack after the transaction commits; on failure, nack or let the deadline lapse so it's redelivered. At-least-once is the substrate the exactly-once effect is built on.
- Idempotent ⇒ safe to retry aggressively. Transient failure → retry with backoff; poison message → DLQ (don't retry forever — that's a head-of-line block). Emit a **duplicate-count metric**: a low, steady rate is healthy (it proves at-least-once works); a _spike_ is a leading indicator of an upstream redelivery problem (a stuck consumer, an ack-deadline misconfiguration, a provider incident).

This is also the answer for the case [Kafka exactly-once](/posts/kafka-exactly-once-transactions-and-schema-evolution/) can't cover: Kafka → Postgres.

## The fork: status convergence vs. ordered processing

This is the decision that changes everything.

**Convergence — only the final state matters** (e.g., a `status` column). Stale events are _correct to drop_. Guard the update with a monotonic rank so it only moves forward:

```sql
UPDATE messages SET status = :s, status_rank = :r
WHERE message_id = :id AND status_rank < :r;   -- atomic conditional CAS in the DB
```

With `queued=0, sent=1, delivered=2`: a late `sent` (1) arriving after `delivered` (2) → `2 < 1` is false → 0 rows → no-op. The final state stays `delivered`, and the order of arrival stops mattering. (It's the high-water-mark idea, pushed into SQL.) For _branching_ lifecycles (`delivered` and `failed` both terminal and incomparable), use an explicit state machine (terminal states reject all transitions) guarded by an optimistic `version`, or last-writer-wins by **source timestamp**.

**Ordered processing — every event has its own side effects, and ALL must run, in order** (e.g., `queued` reserves credit, `sent` decrements a balance + emits a metric, `delivered` finalizes + notifies). Here dropping is _wrong_ — you need exactly-once + complete + ordered, the hardest tier. Don't guard-and-drop; **buffer and resequence**.

> "This isn't last-writer-wins — every event has side effects and must run, in order. So I don't drop the early event; I buffer it and process it once the gap fills. That's a resequencer, not a status guard."

## Ordered processing — best solution: push ordering into the transport

First decide the **scope of ordering**. `queued/sent/delivered` belong to one entity → you need _per-entity_ order, not global order. (A global total order forces single-threaded processing and doesn't scale — push back on that requirement.)

Per-entity ordering unlocks the clean answer: **partition by entity id.**

- **Kafka:** `messageId` as the partition key → Kafka guarantees offset order within a partition, with one consumer thread per partition (see [Kafka core architecture](/posts/kafka-core-architecture/)). Events for one message are processed in sequence automatically; different messages parallelize across partitions.
- **Pub/Sub:** ordering keys, with `messageId` as the key → in-publish-order delivery per key.

On top of that you still need **dedup** by `(messageId, seq)` (at-least-once duplicates within a partition) and a **failure policy** (next section). This avoids building and maintaining a stateful resequencer at all — preferred whenever the transport supports it.

## Ordered processing — fallback: an application-level resequencer (reorder buffer)

When you can't control transport order, build it yourself: a `Set` (dedup) + a sorted buffer (reorder) + a high-water mark (next expected). The core loop:

```
state per entity:
  nextExpectedSeq = 0
  buffer = sorted map<seq → event>      // early arrivals, parked

on event(seq, payload):
  if seq < nextExpectedSeq:   drop                 // already processed (dedup)
  else if seq > nextExpectedSeq: buffer.put(seq)   // EARLY — gap ahead, wait
  else:                                            // seq == nextExpected — in order
      process(event); nextExpectedSeq++
      while buffer.containsKey(nextExpectedSeq):   // drain contiguous run
          process(buffer.remove(nextExpectedSeq)); nextExpectedSeq++
```

If events arrive as `queued(0), delivered(2), sent(1)`: process `queued`, buffer `delivered`, then `sent` fills the gap and drains `delivered`. Every event runs once, in the order `queued, sent, delivered`.

**Crash-safety is the catch** — the in-memory buffer and `nextExpectedSeq` evaporate on restart. Two options:

1. **Lean on redelivery:** don't ack buffered (early) events → the broker redelivers them later. Simple, but churny.
2. **Durable buffer (recommended):** persist events to a DB table keyed by `(entityId, seq)`, ack the broker immediately, and advance `nextExpectedSeq` by reading the contiguous prefix. The DB _is_ the reorder buffer — it survives restarts and spans instances. This is the **inbox pattern**, the receive-side mirror of [the outbox pattern](/posts/outbox-pattern-and-dual-write-problem/).

## Failure under strict ordering — head-of-line blocking

> "Strict order means a failed event head-of-line-blocks its key. If `sent` (seq 1) fails, I must NOT process `delivered` (seq 2) — that could corrupt state. So I stop advancing _that key_ and retry `sent`; only that one entity is blocked, and others flow on different keys."

The poison policy is a deliberate choice:

- **Block-and-alert** — safe; that entity is stuck. Correct when ordering is sacred.
- **Skip-to-DLQ and advance** — violates "every event processed"; only acceptable if downstream tolerates a gap.

Surface this; don't pick silently.

## The three concerns, separated

| Concern          | Guarantee     | Mechanism                                          |
| ---------------- | ------------- | -------------------------------------------------- |
| **Dedup**        | At most once  | `(entityId, seq)` unique / `seen` set              |
| **Completeness** | At least once | Retry; don't drop (buffer, not discard)            |
| **Ordering**     | In sequence   | Partition key **or** resequencer + high-water mark |

Dedup + completeness = exactly-once. Add ordering = ordered exactly-once.

## Gotchas

- **Dedup ≠ ordering.** A _redelivered_ `sent` is caught by the eventId/seq dedup. A _distinct but late_ `sent` arriving after `delivered` passes dedup (it's new) and must be caught by the ordering mechanism. Different problems, different tools — conflating them is the classic miss.
- **A convergence guard drops events on purpose.** Using a rank guard (`WHERE status_rank < r`) when every event actually has side effects silently loses work. Confirm "do all events need to run, or only the final state?" before choosing.
- **`Objects.requireNonNull` throws `NullPointerException`, not `IllegalArgumentException`.** If the contract says "reject null with IAE", you must write the explicit `if (x == null) throw new IllegalArgumentException(...)` — the convenience method throws the wrong type.
- **Validate before the dedup claim.** Validating after `seen.add` (or inside a `computeIfAbsent` lambda) can mark a bad event "seen" and then throw, so a corrected retry is wrongly deduped. Fail fast first.
- **Compare by source time, not receive time.** Provider-assigned timestamps/sequences reflect the true order; your receive time is scrambled by the network and retries you're defending against.
- **An unbounded reorder buffer = OOM.** A gap that never fills (seq 5 is lost) grows the buffer forever. It needs a gap timeout, a watermark, or a bounded buffer with a spill/skip policy — and skipping re-opens the completeness question.
- **`status="QUEUED"` / "saved" is a promise about the transaction, not the physical row.** With JPA, the INSERT becomes durable at commit (method return under `@Transactional`), not at the `save()` call.

## References

- Related: [Kafka exactly-once semantics (transactions) and schema evolution](/posts/kafka-exactly-once-transactions-and-schema-evolution/) — where Kafka's own EOS stops, and why this pattern picks up from there.
- Related: [Kafka core architecture](/posts/kafka-core-architecture/) — per-partition ordering.
