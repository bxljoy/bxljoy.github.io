---
title: "Java atomics: CAS contention, LongAdder mechanics, AtomicReference for compound state, and ABA"
description: "How CAS works and why it slows down under contention, how LongAdder's padded cells fix hot counters, lock-free compound updates with AtomicReference, the updateAndGet side-effect trap, ABA, and when not to use atomics."
pubDatetime: 2026-09-30T09:27:00+02:00
tags: [java, concurrency, atomics, jvm]
sourceNotes: [java-atomics-cas-contention-and-aba]
---

> Atomics are CPU-level lock-free operations, but "lock-free" doesn't mean "free" — under heavy contention they pay in cache-line ping-pong and CAS retry storms. `AtomicInteger`, `LongAdder`, and `AtomicReference<Record>` solve different shapes of single-value, single-reference, and compound-state updates; ABA bites pointer-based structures but never simple counters.

## Table of contents

## Overview

Java's `java.util.concurrent.atomic` package wraps the CPU's compare-and-swap instruction in usable Java types. They're the foundation of every other concurrent primitive (locks, queues, concurrent maps), but they're easy to misuse — choosing `AtomicInteger` where `LongAdder` would scale better, chaining multiple atomics where a single `AtomicReference<Record>` would preserve invariants, putting side effects inside `updateAndGet` lambdas.

This post covers the Java atomic types in operational depth:

- how `AtomicInteger.incrementAndGet` becomes a CAS retry storm under contention
- how `LongAdder`'s padded cells and thread-probe hashing eliminate the ping-pong
- how `AtomicReference<ImmutableRecord>` enables lock-free compound updates
- the side-effect trap in `updateAndGet`
- the ABA problem and `AtomicStampedReference`
- the five cases where atomics are the wrong tool

## Key points

- **CAS is one CPU instruction** (`LOCK CMPXCHG` on x86) — atomic, no OS involvement, no thread parking.
- **The CAS retry loop is the canonical lock-free pattern**: read → compute → CAS → retry on failure.
- **Under heavy contention, the cost is cache-line ping-pong**, not the CAS instruction itself. Each successful write invalidates the other cores' cache lines.
- **`synchronized` can beat `AtomicInteger` under heavy contention**, thanks to JIT lock coarsening (holding the lock across many iterations of a tight loop).
- **`LongAdder` reduces contention** by spreading writes across `@Contended`-padded cells, allocated lazily when CAS contention is detected and addressed by a per-thread probe hash.
- **`LongAdder` loses to `AtomicLong`** at low contention (cell overhead), with frequent reads (it must walk all cells), or when an atomic snapshot is needed (`sum()` is not instantaneous).
- **`AtomicReference<ImmutableRecord>` enables lock-free compound updates** — wrap multiple fields in a record and atomically swap the reference. Readers always see a consistent snapshot.
- **`updateAndGet`'s lambda may run multiple times under contention** — keep it pure: no logging, no metrics, no I/O.
- **ABA matters for pointer/structural state**, not for primitive counters. Lock-free linked structures need `AtomicStampedReference` or version monotonicity.
- **Don't use atomics when:** there's high contention with simple ops (use `LongAdder` or `synchronized`), there are compound multi-step invariants (use `synchronized`/`ReentrantLock`), you need to wait for a condition (no `await`/`signal`), the critical section spans I/O (atomics protect single ops, not blocks), or the update lambda has side effects.

## CAS — the underlying CPU instruction

```
CAS(memory_location, expected, new):
    if memory_location == expected:
        memory_location = new
        return SUCCESS
    else:
        return FAILURE (with the actual current value)
```

It's one indivisible CPU instruction. On x86: `LOCK CMPXCHG`. On ARM: `LDXR/STXR` (load-exclusive/store-exclusive — slightly different, same effect). The CPU guarantees atomicity via cache-line locking at the memory controller. Every Java atomic, every `synchronized` lock acquisition, and every `ConcurrentHashMap` bin update is built on this instruction.

## `AtomicInteger` — CAS exposed in Java

```java
AtomicInteger counter = new AtomicInteger(0);

counter.incrementAndGet();          // ++counter
counter.getAndIncrement();          // counter++
counter.compareAndSet(5, 6);        // raw CAS
counter.updateAndGet(x -> x * 2);   // function-driven update
counter.accumulateAndGet(10, Integer::sum);
```

Under the hood, `incrementAndGet()` is the canonical retry loop:

```java
public int incrementAndGet() {
    int current, next;
    do {
        current = get();              // read
        next = current + 1;           // compute
    } while (!compareAndSet(current, next));
    return next;
}
```

No thread blocks. Every thread is either making progress or about to retry.

## Why CAS slows down under heavy contention

When N cores hammer one atomic field, two costs add up:

1. **CAS retry storm** — most threads' CAS attempts fail because someone else won. Each failure is a wasted memory barrier. With 10 threads contending, each logical increment may take 5–10 CAS attempts.
2. **Cache-line ping-pong** — each successful write invalidates the cache line in every other core. Subsequent reads on those cores miss and fetch from the writer's cache (~100–200 cycles). The cache line bounces between cores; this is the dominant cost, not the CAS itself.

Modern HotSpot's `synchronized` actually beats `AtomicInteger` under heavy contention, because the JIT can apply **lock coarsening**:

```java
// What you wrote
for (int i = 0; i < 1_000_000; i++) {
    synchronized (lock) { counter++; }
}

// What JIT may compile (lock coarsened across iterations)
synchronized (lock) {
    for (int i = 0; i < 1_000_000; i++) { counter++; }
}
```

`AtomicInteger.incrementAndGet()` can't be coarsened — each call is a separately visible volatile-style operation.

This is why the benchmark in [the Java memory model post](/posts/java-memory-model-visibility-and-atomicity/) showed (10 threads × 100k increments):

- `synchronized`: ~60 ms (lock coarsening helps)
- `LongAdder`: ~60 ms (per-cell, no contention)
- `AtomicInteger`: ~80 ms (CAS retry storm + ping-pong)

## `LongAdder` — splitting contention across padded cells

`LongAdder` (Java 8+) was designed for the high-contention counter case.

The internal model (simplified):

```
LongAdder:
  base: long              // single shared counter — fast path
  cells: Cell[]           // null initially; allocated on contention
                          // each Cell padded with @Contended onto its own cache line

increment() flow:
  1. If cells == null, try CAS(base, base+1)
       success → done (uncontended fast path)
       failure → contention detected; switch to cell mode

  2. cells == null → allocate (size 2, grows up to ~CPU count)

  3. Pick cell via thread's probe hash → CAS that cell
       failure → re-hash probe and retry; eventually grow cells array

sum() flow:
  total = base
  for each cell: total += cell.value
  return total           // not an atomic snapshot
```

Two key optimizations:

- **`@Contended` padding** — each `Cell` sits alone on its own ~128-byte cache line, so different threads writing different cells don't trigger coherence traffic on each other.
- **Thread-probe hashing** — each thread has a `threadLocalRandomProbe` field used to pick a cell, so different threads land on different cells most of the time.

### `LongAdder` vs. `AtomicLong`

| Scenario                                       | Pick                                                    |
| ---------------------------------------------- | ------------------------------------------------------- |
| Low contention (≤2 writer threads)             | `AtomicLong` — the cell overhead doesn't pay off        |
| Heavy contention, write-only counter (metrics) | `LongAdder`                                             |
| Need atomic, exact reads                       | `AtomicLong` — `sum()` walks cells; it's not a snapshot |
| Need the `compareAndSet` API                   | `AtomicLong` — `LongAdder` has no CAS                   |
| Sequence ID generation                         | `AtomicLong.getAndIncrement` — `sum()` isn't unique     |
| Memory-constrained service with many counters  | `AtomicLong` — `LongAdder` is ~10× larger               |

The "sum is not atomic" gotcha:

```java
LongAdder requests = new LongAdder();
LongAdder errors = new LongAdder();
double errorRate = (double) errors.sum() / requests.sum();   // ⚠ different snapshot times
```

Each `sum()` walks ~16 cells over ~1µs. Between the two calls, more requests and errors land, so the numerator and denominator are taken at different logical times. For metrics, this is fine. For a circuit-breaker decision, it can flicker.

`LongAccumulator` is the generalized version with a custom merge function (max, min, etc.), with the same caveats as `LongAdder`.

## `AtomicReference<Record>` — compound state via immutability

`AtomicInteger` handles a single int. For multiple fields that change together, wrap them in an immutable record and atomically swap the reference:

```java
record Position(int x, int y) {}

class MovablePoint {
    private final AtomicReference<Position> pos =
        new AtomicReference<>(new Position(0, 0));

    public void move(int dx, int dy) {
        Position current, next;
        do {
            current = pos.get();
            next = new Position(current.x() + dx, current.y() + dy);
        } while (!pos.compareAndSet(current, next));
    }

    public Position position() {
        return pos.get();   // always a consistent (x, y) snapshot
    }
}
```

Three reasons this is powerful:

1. **Atomic across multiple fields** — which `volatile int x; volatile int y` cannot give you.
2. **Lock-free readers** — `pos.get()` is a single volatile read; no parking, no contention.
3. **No observable half-states** — the record is immutable, so a paused reader holding the old reference still sees a fully formed object.

The cost is one allocation per update. Modern allocators (TLAB) make this ~5 ns, but on critical paths with high contention, allocation pressure can dominate — then fall back to `synchronized` over mutable fields.

The `updateAndGet` shortcut:

```java
pos.updateAndGet(current -> new Position(current.x() + dx, current.y() + dy));
```

## The `updateAndGet` side-effect trap

The lambda passed to `updateAndGet`/`accumulateAndGet` is **invoked once per CAS attempt** — and may be retried. Side effects multiply.

```java
// ❌ Logs and metrics fire 2-10× under contention
ref.updateAndGet(current -> {
    log.info("Updating from {}", current);
    metrics.counter("updates").increment();
    return new State(...);
});

// ✅ Side effects outside the CAS
State newState = ref.updateAndGet(current -> new State(...));
log.info("Updated to {}", newState);
metrics.counter("updates").increment();
```

The same rule applies to any CAS retry loop you write by hand: compute pure values inside the loop; do side effects after it exits.

## The ABA problem

CAS only checks the _value_, not whether the value changed and then changed back. If a memory location goes `A → B → A`, a CAS against `A` succeeds — even though the structural state changed underneath.

| Question                                                                        | If yes | ABA risk |
| ------------------------------------------------------------------------------- | ------ | -------- |
| Does the CAS'd value carry all its meaning by itself? (counter, version int)    | Yes    | None     |
| Or is it a reference into a structure with invariants? (Node ref, head pointer) | Yes    | High     |

**Counter-style values** (`5`, `6`, `7`) are self-contained. Going `5 → 6 → 5` is genuinely no different from never changing.

**Pointer-style values** are just memory addresses. They reference _external state_ — a Node has a `next` pointer, sits in a chain, and may be allocated and re-allocated. The pointer alone tells you nothing.

The classic broken lock-free stack:

```java
public T pop() {
    Node<T> oldHead, newHead;
    do {
        oldHead = top.get();
        if (oldHead == null) return null;
        newHead = oldHead.next;
    } while (!top.compareAndSet(oldHead, newHead));
    return oldHead.value;
}
```

The stack is `[A → B → C]`. Thread 1 reads `oldHead=A`, computes `newHead=B`, and pauses. Thread 2 pops A, pops B, and pushes A back — the stack is now `[A → C]`. Thread 1 resumes: `compareAndSet(A, B)` succeeds because `top` is still `A` — but now `top = B`, which is no longer in the stack. The reachability invariant is broken.

### `AtomicStampedReference` — ABA-safe pointer swaps

```java
AtomicStampedReference<Node<T>> top = new AtomicStampedReference<>(initial, 0);

int[] stampHolder = new int[1];
Node<T> oldHead = top.get(stampHolder);
int oldStamp = stampHolder[0];
// compute newHead
top.compareAndSet(oldHead, newHead, oldStamp, oldStamp + 1);
```

This adds a version stamp that's incremented on every change. Even if the value comes back to the same object, the stamp differs. CAS checks both the value AND the stamp — `A → B → A` becomes `A/v1 → B/v2 → A/v3`, and stale CAS attempts fail.

There's also `AtomicMarkableReference`, for one-bit "deleted" flags on pointer-based structures.

In practice, ABA rarely bites application code — Java's GC prevents some forms (a freed node can't be reused while it's still referenced), and the JDK already provides `ConcurrentLinkedQueue`, `ConcurrentSkipListMap`, etc., which handle ABA internally. Roll your own lock-free data structure only when there's no alternative — and expect to use `AtomicStampedReference`.

## Five cases NOT to use atomics

| Case                                 | Reason                                             | Use instead                                                           |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------- |
| Heavy contention on a single counter | CAS retry storm + cache-line ping-pong             | `LongAdder` or `synchronized` (coarsenable)                           |
| Multi-step compound updates          | Atomics are per-operation, not transactional spans | `synchronized` / `ReentrantLock`                                      |
| Side effects in the update function  | `updateAndGet` may invoke it 2–10×                 | A `synchronized` block (runs once)                                    |
| Need to wait for a condition         | Atomics have no `await/signal`                     | `ReentrantLock + Condition` or a `BlockingQueue`                      |
| Critical section spans I/O           | Atomics protect single operations, not blocks      | `ReentrantLock` (with a timeout) — or refactor to not lock across I/O |

The deeper rule: **atomics are for single-value or single-reference state changes**. If you can describe what changes in one sentence with no "and", atomics fit. If your sentence has "and" or "then", you need a lock or a single `AtomicReference<Record>`.

## Decision tree

```
Need atomic operations on shared state?
├── Single counter, low/medium contention
│   └── AtomicInteger / AtomicLong
│
├── High-throughput counter (metrics), reads rare
│   └── LongAdder
│
├── Need max/min/custom-merge instead of sum
│   └── LongAccumulator
│
├── Multiple fields that change together
│   └── AtomicReference<ImmutableRecord> + retry loop / updateAndGet
│
├── Boolean flag (race-free check-and-set)
│   └── AtomicBoolean (or volatile boolean for single-writer)
│
├── Lock-free data structure (rare in app code)
│   └── AtomicStampedReference for ABA-safe pointer swaps — or use ConcurrentLinkedQueue
│
└── Compound state with allocation cost too high, or contention extreme
    └── synchronized / ReentrantLock (mutable state, no allocation, lock coarsening)
```

## Gotchas

- **Chained atomics ≠ one atomic operation.** `count.incrementAndGet(); status.set(ACTIVE);` lets another thread observe the incremented count with the old status. Wrap related fields in a record and use a single `AtomicReference<Record>`.
- **Side effects in `updateAndGet` lambdas multiply** under contention. Move logging, metrics, and external calls outside the CAS.
- **`LongAdder.sum()` is not a snapshot.** Two `sum()` calls in sequence don't give you values from the same logical instant. Bad for ratios used in decisions; fine for monitoring.
- **`AtomicInteger` is slower than `synchronized` under contention.** Counter-intuitive but real — JIT lock coarsening + lightweight locking, plus avoiding cache-line ping-pong on the atomic field. Measure before assuming "lock-free is faster".
- **CAS retry loops with no upper bound** can spin forever under extreme contention. Add a back-off, or fall back to a lock-based path when the retry count exceeds a threshold (rarely needed, but a real concern in pathological workloads).
- **`AtomicReference<Record>` allocation pressure** on hot paths. If the record is large or the update rate is millions per second, allocations can dominate; consider `synchronized` over a single mutable object.
- **ABA in `AtomicReference<Mutable>`** — if you mutate the referenced object instead of swapping in a new immutable one, ABA is back as a concern. Always swap immutable references; never mutate the pointed-at object.
- **`AtomicInteger` as a "did anything change?" flag with reset to 0** — an ABA bug. Use a monotonically increasing version (an `AtomicLong` that never resets).
- **The `@Contended` annotation** is JVM-internal (`jdk.internal.vm.annotation.Contended`). To use it on your own classes, you need `-XX:-RestrictContended` and the right module exports. `LongAdder` uses it internally; you usually don't.

## Code review checklist

- [ ] Multiple `Atomic*` fields used together where one `AtomicReference<Record>` would express the invariant
- [ ] `updateAndGet` lambda containing logging, metrics, or external calls
- [ ] `AtomicInteger` reset to 0 used as a "did anything change?" version → ABA risk
- [ ] Custom lock-free linked structure rolled by hand → suggest `ConcurrentLinkedQueue` etc.
- [ ] Atomic operations spanning a DB or HTTP call (the atomicity scope is in-memory only)
- [ ] `LongAdder.sum()` used for sequence IDs or atomic decisions
- [ ] `synchronized { counter++ }` for a hot single-field counter at low contention → suggest `AtomicLong`
- [ ] `AtomicInteger` for a metrics counter under heavy write traffic → suggest `LongAdder`
- [ ] CAS retry loop with no bounded back-off in a pathologically contended workload

## References

- Earlier in this topic: [Java memory model: visibility, atomicity, and why JIT optimizes per-method](/posts/java-memory-model-visibility-and-atomicity/)
- Earlier in this topic: [Synchronized mechanics: intrinsic monitors, lock object choice, DCL, and the SimpleDateFormat trap](/posts/synchronized-monitors-dcl-and-simpledateformat/)
- Brian Goetz, _Java Concurrency in Practice_, chapter 15 — atomics and non-blocking algorithms.
- [JEP 142 — Reduce Cache Contention on Specified Fields](https://openjdk.org/jeps/142) (`@Contended`).
- JDK Javadoc: [`java.util.concurrent.atomic`](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/package-summary.html).
- Maurice Herlihy & Nir Shavit, _The Art of Multiprocessor Programming_ — for the ABA problem and lock-free data structures.
