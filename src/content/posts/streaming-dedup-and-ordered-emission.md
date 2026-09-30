---
title: "Streaming dedup + ordered emission (the Set + TreeMap pattern)"
description: "A stateful streaming processor that dedups events by id and emits them in sequence order despite out-of-order arrival — the Set + TreeMap + high-water-mark pattern, why it pairs with Kafka's single-threaded per-partition consumers, and how to bound its memory."
pubDatetime: 2026-09-30T12:01:00+02:00
tags: [java, streaming, kafka, design-pattern, idempotency]
sourceNotes: [streaming-dedup-and-ordered-emission]
---

> A stateful streaming processor that deduplicates incoming events by id and emits them downstream in producer-assigned sequence order, tolerating out-of-order arrival. It uses a `Set` for dedup, a `TreeMap` as the ordering buffer, and a high-water-mark `long`. It pairs naturally with Kafka's single-threaded, per-partition consumer model.

## Table of contents

## Overview

The batch version of idempotent dedup (`List<Event> process(List<Event>)`) is a one-shot operation: take a finite list, dedup, sort, return. But real event-driven systems don't deliver finite lists — they deliver a continuous stream where events arrive one at a time, possibly duplicated (retries) and possibly out of order (network jitter, producer retries).

This post documents the canonical pattern for turning the batch design into a streaming one, why the two data structures solve two separate concerns, and why the usual "single-threaded accept" assumption comes from Kafka's consumer model rather than from a deliberate design choice. It's the in-process algorithm behind the resequencer in [the previous post](/posts/at-least-once-to-exactly-once-effect/).

## Key points

- **Two concerns, two structures.** `Set<String> seenIds` for dedup (by id), `TreeMap<Long, Event> buffer` for ordering (by sequence number), and `long lastEmittedSeq` as the high-water mark. Each handles one concern independently.
- **TreeMap, not HashMap, for the buffer.** A TreeMap gives O(log n) access to the smallest key — needed to emit in ascending sequence order. Every `accept` call checks the buffer's `firstKey` to decide whether to drain.
- **`accept` triggers the drain.** Each incoming event may fill a gap, enabling a cascade of emissions. The drain loop pulls contiguous events starting at `lastEmittedSeq + 1` until it hits a gap or empties the buffer.
- **Dedup and buffering are sequential, not interleaved.** The dedup check runs first (skip duplicates before touching the buffer), then the buffer insert, then the drain. This keeps the data structures' concerns clean.
- **The single-threaded assumption comes from Kafka.** The canonical Kafka consumer runs `poll()` on a single thread, because `KafkaConsumer` is not thread-safe and because partition order must be preserved. Each partition is consumed by exactly one consumer in a group, and that consumer uses one thread.
- **Unbounded memory is the main failure mode.** A persistent gap (seq=5 never arrives) makes the buffer grow forever. Mitigations: timeout-based gap skipping, producer watermarks, or a bounded buffer with a drop/spill policy.
- **One processor instance per partition, not a global one.** In a multi-partition Kafka topic, each partition gets its own `StreamingEventProcessor` instance. Since producers partition by event key, duplicates land in the same partition, and dedup works correctly without cross-partition coordination.

## Data structures — what each one stores

```
Set<String> seenIds          → { "A", "B", "C" }                 (eventIds, for dedup only)

TreeMap<Long, Event> buffer  → {                                  (events waiting to be emitted,
    1 → Event(id="B", seq=1, payload=...),                         keyed by sequenceNumber,
    2 → Event(id="C", seq=2, payload=...),                         naturally sorted)
    3 → Event(id="A", seq=3, payload=...)
  }

long lastEmittedSeq          → 0 (initial)                        (high-water mark;
                             → 3 (after emission)                  next expected = lastEmittedSeq + 1)
```

**The TreeMap doesn't know about eventIds.** It's keyed on `sequenceNumber`. The eventId is stored inside the Event value but doesn't affect the buffer's behavior. Dedup is handled by the Set _before_ any event touches the buffer.

## The algorithm

On every `accept(event)`:

1. **Dedup check:** if `event.eventId()` is already in `seenIds`, skip and return. A duplicate never enters the buffer.
2. **Add to the seen set:** `seenIds.add(event.eventId())`.
3. **Add to the buffer:** `buffer.put(event.sequenceNumber(), event)`.
4. **Drain:** while `buffer.firstKey() == lastEmittedSeq + 1`:
   - Emit the event via `downstream.accept(event)`.
   - Remove it from the buffer (`pollFirstEntry`).
   - Advance `lastEmittedSeq`.

   Stop when there's a gap or the buffer is empty.

Emission happens inside `accept`, not as a separate call — each incoming event is the trigger. If the new event is the missing piece that fills a gap, the drain cascades through multiple emissions in one call.

### Trace — 5 events arriving

Events in arrival order: `A-3, B-1, A-3 (dup), C-2, B-1 (dup)`.

| Step    | Input     | seenIds   | buffer   | lastEmittedSeq | Emitted this step  |
| ------- | --------- | --------- | -------- | -------------- | ------------------ |
| Initial | —         | {}        | {}       | 0              | —                  |
| 1       | A-3       | {A}       | {3: A-3} | 0              | — (gap at 1)       |
| 2       | B-1       | {A, B}    | {3: A-3} | 1              | B-1                |
| 3       | A-3 (dup) | {A, B}    | {3: A-3} | 1              | — (skipped)        |
| 4       | C-2       | {A, B, C} | {}       | 3              | C-2, A-3 (cascade) |
| 5       | B-1 (dup) | {A, B, C} | {}       | 3              | — (skipped)        |

The final emitted sequence is `[B-1, C-2, A-3]`: three unique events, in ascending seq order.

### Minimal implementation

```java
public class StreamingEventProcessor {
    private final Consumer<Event> downstream;
    private final Set<String> seenIds = new HashSet<>();
    private final TreeMap<Long, Event> buffer = new TreeMap<>();
    private long lastEmittedSeq = 0;

    public StreamingEventProcessor(Consumer<Event> downstream) {
        this.downstream = downstream;
    }

    public void accept(Event event) {
        // 1. Dedup
        if (!seenIds.add(event.eventId())) {
            return;   // already seen
        }

        // 2. Buffer
        buffer.put(event.sequenceNumber(), event);

        // 3. Drain in order
        while (!buffer.isEmpty() && buffer.firstKey() == lastEmittedSeq + 1) {
            Event next = buffer.pollFirstEntry().getValue();
            downstream.accept(next);
            lastEmittedSeq = next.sequenceNumber();
        }
    }
}
```

- `Set.add(x)` returns `true` if x was new and `false` if it was already present, so `!seenIds.add(...)` reads as "was already seen".
- `TreeMap.pollFirstEntry()` atomically removes and returns the smallest-keyed entry.
- The drain loop may emit zero, one, or many events per `accept` call — depending on whether this event filled a gap.

## Why TreeMap over HashMap for the buffer

The hot operation is "give me the smallest key". A TreeMap does this in O(log n) via `firstKey()`. A HashMap would require scanning all entries — O(n) per check. For a buffer of thousands of pending events, the difference is significant.

A TreeMap also iterates in natural key order, which makes log and debug output immediately useful.

## Kafka consumer threading — where "single-threaded accept" comes from

The Kafka consumer loop is single-threaded by design, not by choice:

1. **`KafkaConsumer` is not thread-safe.** The Java client API rejects multi-threaded access to the same consumer instance. You cannot call `poll()` from two threads.
2. **One partition → one consumer per group.** Within a consumer group, each partition is assigned to exactly one consumer. This preserves partition order.
3. **The canonical loop is sequential.** Poll → iterate records → process each → commit offsets → repeat. All on one thread.

```java
try (var consumer = new KafkaConsumer<String, Event>(props)) {
    consumer.subscribe(List.of("events"));
    while (running) {
        var records = consumer.poll(Duration.ofSeconds(1));
        for (var record : records) {
            processor.accept(record.value());   // single-threaded entry point
        }
        consumer.commitSync();
    }
}
```

Because this pattern is canonical, streaming designs often assume "`accept` is called from one thread". You inherit thread safety structurally from the upstream consumer model.

## Kafka scaling model

Parallelism in Kafka = the number of partitions. A topic with 16 partitions supports up to 16 concurrent consumers per group; adding more consumers than partitions wastes resources (the extras sit idle). See [Kafka core architecture](/posts/kafka-core-architecture/) for the partition and consumer-group model.

```
Topic (16 partitions) with consumer group of 4:
  Consumer A ← partitions [0, 1, 2, 3]    (4 partitions, processed sequentially in A)
  Consumer B ← partitions [4, 5, 6, 7]
  Consumer C ← partitions [8, 9, 10, 11]
  Consumer D ← partitions [12, 13, 14, 15]

Scale to 16 consumers → each gets 1 partition → max parallelism reached.
Scale to 32 consumers → 16 sit idle.
```

To scale further, re-partition the topic with more partitions. Kafka rebalances automatically.

## One processor instance per partition

When a consumer is assigned multiple partitions, maintain separate `StreamingEventProcessor` state per partition:

```java
private final Map<Integer, StreamingEventProcessor> perPartition = new HashMap<>();

for (var record : records) {
    var processor = perPartition.computeIfAbsent(
        record.partition(),
        p -> new StreamingEventProcessor(this::emit));
    processor.accept(record.value());
}
```

Why: each partition has independent sequence numbers (in most designs the producer assigns them per partition). Mixing state across partitions corrupts the ordering.

## Why dedup works at partition scope

Producers typically partition by event key:

```java
producer.send(new ProducerRecord<>("events", event.eventId(), event));
//                                             ^^^^^^^^^^^^^^^ key → partition
```

Same eventId → `hash(eventId) % numPartitions` → same partition → same consumer thread → same processor instance → the dedup Set sees both copies. **Kafka's partitioning naturally aligns with your dedup key, so per-partition dedup equals global dedup.**

If the producer doesn't partition by event key, you'd need distributed dedup (Redis, DynamoDB) — a different problem.

## Bounded memory — three gap-handling policies

An unbounded buffer is a production risk. If seq=5 never arrives, 6, 7, 8… accumulate forever. Mitigations:

| Policy                 | How                                                                                                                                     | Trade-off                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Timeout**            | After N seconds of waiting for the next seq, emit buffered events despite the gap.                                                      | Loses strict ordering during gaps. Simple and local.                                            |
| **Producer watermark** | The producer periodically emits a "completed up to N" signal. On receiving a watermark, emit everything below N, skipping missing seqs. | The cleanest semantics, but requires producer cooperation.                                      |
| **Bounded buffer**     | Cap the buffer size. When it's full, drop or spill to disk.                                                                             | A simple failsafe, but loses data. Useful as a last-resort guard on top of a timeout/watermark. |

State the trade-off explicitly: "Which can the downstream tolerate — strict ordering with a bounded wait, or eventual emission with potential reordering during gaps?"

## Gotchas

- **The TreeMap has no concept of eventIds.** If two different eventIds arrive with the same sequenceNumber (a producer bug), `buffer.put(seq, event)` silently overwrites the first. The seen-set won't catch this, because the eventIds are different. Log a warning for same-seq-different-eventId as a producer-bug signal.
- **Dedup state grows forever without eviction.** `seenIds` never shrinks. For a long-running stream you need either TTL-based eviction or a bounded seen-set (LRU). In Kafka specifically, events beyond the topic's retention window can't be redelivered — so you can safely evict seenIds older than the retention period.
- **`accept` is not thread-safe as written.** The single-threaded assumption works for Kafka consumers, but breaks if you parallelize processing with a thread pool. If you shard by event key to enable parallelism while preserving per-key ordering, you need either one `StreamingEventProcessor` per shard, or explicit synchronization.
- **`TreeMap.pollFirstEntry()` is atomic per call, but the `while` loop condition (`firstKey() == lastEmittedSeq + 1`) is not.** In a multi-threaded context, another thread could modify the buffer between the condition check and the poll. Wrap the whole drain in `synchronized(this)` if you ever break the single-threaded assumption.
- **`KafkaConsumer` is not thread-safe — do not share instances.** Each thread that wants to poll needs its own consumer (which must then subscribe separately and gets its own partition assignment). "One consumer per thread" is the rule.
- **Scaling beyond the partition count doesn't help.** If a topic has 4 partitions and you deploy 8 consumers in a group, 4 sit idle. The partition count is the ceiling on consumer parallelism.

## References

- Previous in this topic: [At-least-once delivery → exactly-once effect](/posts/at-least-once-to-exactly-once-effect/) — where this resequencer fits among the dedup, completeness, and ordering concerns.
- Related: [Kafka core architecture](/posts/kafka-core-architecture/) — the partition model, offset storage, and consumer groups.
- [Kafka documentation — Consumer API](https://kafka.apache.org/documentation/#consumerapi)
- [`KafkaConsumer` Javadoc](https://kafka.apache.org/39/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html) — "The consumer is not thread-safe".
