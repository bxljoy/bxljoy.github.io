---
title: "Java memory model: visibility, atomicity, and why JIT optimizes per-method"
description: "The three concurrency problems (visibility, atomicity, ordering), happens-before, why the JIT assumes single-threaded code, and what volatile, synchronized, AtomicInteger, and LongAdder each actually guarantee."
pubDatetime: 2026-09-30T08:47:00+02:00
tags: [java, concurrency, jvm, memory-model]
sourceNotes: [java-memory-model-visibility-and-atomicity]
---

> Concurrency bugs come from three orthogonal problems — visibility, atomicity, ordering — and Java primitives (`volatile`, `synchronized`, `Atomic*`) are contracts that solve specific subsets. `volatile` gives visibility but not atomicity; that one rule explains why `volatile counter++` is broken.

## Table of contents

## Overview

Before reaching for `synchronized`, `volatile`, or `ReentrantLock`, you need to understand _why_ concurrency is hard at the JVM level. The memory model describes what guarantees the JVM gives you in the absence of synchronization (almost none), and how each primitive establishes a _happens-before_ relationship that restores those guarantees.

This post covers the foundation: the three problems, how the JIT optimizes per method assuming single-threaded execution, and how `volatile`, `synchronized`, `AtomicInteger`, and `LongAdder` differ — including the surprising result that `AtomicInteger` is often slower than `synchronized` under heavy single-field contention.

## Key points

- **Three concurrency problems:** visibility (other threads don't see your write), atomicity (a read-modify-write can interleave), ordering (the JVM/CPU reorder instructions).
- **Happens-before is the only formal guarantee.** Without a happens-before edge between two threads' actions, the JVM is free to assume no other thread is reading or writing a field.
- **The JIT compiles per method** and assumes single-threaded execution by default. It does not analyze whether other threads might modify a field; without `volatile`/`synchronized`, it can hoist reads into registers, eliminate them, or reorder them.
- **`volatile` is a contract with the JIT:** "this field can change from outside; don't cache it; emit memory barriers." It applies to _the field_, not individual accesses — every read and write goes through main memory.
- **`volatile` gives visibility + ordering. It does NOT give atomicity.** `volatile counter++` is a read-modify-write — three operations, not one — and is broken under concurrency.
- **Three fixes for atomicity:** `synchronized` (mutual exclusion + memory barrier), `AtomicInteger` (CAS-based, lock-free), `LongAdder` (per-thread cells, summed on read).
- **Modern HotSpot optimizes `synchronized` aggressively** — lock coarsening, lightweight locking, lock elision. In tight loops `synchronized` can match or beat `AtomicInteger`.
- **`AtomicInteger` is NOT always faster than `synchronized`.** Under heavy single-field contention, CAS-retry storms make it slower. `LongAdder` was designed for exactly this case.

## The three problems

**Visibility — thread A writes, thread B doesn't see it.** Causes:

- CPU cores have private L1/L2 caches; A's write lives in A's cache, and B reads from B's cache.
- The JIT may load a field into a register _once_ and never re-read it.
- The JIT may eliminate "redundant" reads that it thinks single-threaded code wouldn't notice.

**Atomicity — `counter++` is three operations.**

```
1. READ  counter from memory   →  register
2. ADD   1 to register
3. WRITE register back to counter
```

Two threads can both do step 1 (read 5), both compute step 2 (6), and both write 6. Expected 7, got 6 — one increment lost.

**Ordering — the JVM/CPU reorder instructions.**

```java
x = 1;
flag = true;
```

Another thread observing this might see `flag = true` _before_ `x = 1`. Single-threaded code can't tell the difference — the final state is the same.

## Happens-before

The only formal guarantee. If action A happens-before action B, then B is guaranteed to see A's writes. Happens-before is established by:

| Source                          | What it establishes                                              |
| ------------------------------- | ---------------------------------------------------------------- |
| Program order (within a thread) | Each statement happens-before the next                           |
| `synchronized` unlock           | Happens-before the next lock on the same monitor                 |
| `volatile` write                | Happens-before any subsequent read of the same field             |
| `Thread.start()`                | Happens-before everything the new thread does                    |
| `Thread.join()`                 | Everything in the joined thread happens-before the join's return |
| Constructor finish              | Happens-before any read of a `final` field                       |

**No happens-before edge → no guarantee.** The other thread might see your write, or it might never see it.

## Why the JIT optimizes per method

When the JIT compiles a method, it analyzes that method's bytecode in isolation. It does **not** scan the rest of the program to check whether some other thread might write a field. Two reasons:

1. Whole-program analysis is intractable — your code calls libraries that call libraries.
2. Knowing which methods will run on which threads is undecidable in general.

The JIT's contract is: _"I will optimize as if this method runs alone. If a field is shared with other threads, the developer must declare it with `volatile`/`synchronized`/atomic."_

This is intentional. If every field read had to go to main memory "just in case", Java would be 10× slower. The cost of safety falls on the _small fraction_ of fields that are actually shared.

## Demo 1: visibility failure (StopFlagBug)

```java
public class StopFlagBug {
    static boolean stop = false;  // NOT volatile

    public static void main(String[] args) throws Exception {
        Thread worker = new Thread(() -> {
            long count = 0;
            while (!stop) { count++; }
            System.out.println("Worker exited, count = " + count);
        });
        worker.start();
        Thread.sleep(1000);
        stop = true;
        System.out.println("Main: set stop=true");
        worker.join(5000);
        if (worker.isAlive()) System.out.println("BUG: worker still running");
    }
}
```

Run it with `java -server`. The worker loops forever: the JIT looked at `while (!stop) { count++; }`, saw that nobody in _this method_ writes `stop`, and hoisted the read into a register:

```
// Without volatile (JIT-compiled):
mov  eax, [stop]    ; read ONCE before loop
loop:
  test eax, eax     ; check cached register
  jz   loop         ; eax never changes → infinite loop
```

The `println` after the loop is **unreachable**.

**Fix:** `static volatile boolean stop = false;` Now the JIT must emit a memory read on every iteration:

```
loop:
  mov  eax, [stop]  ; READ FROM MEMORY every iteration
  test eax, eax
  jz   loop
```

## Demo 2: atomicity failure even with volatile (LostUpdates)

```java
public class LostUpdates {
    static volatile int counter = 0;  // volatile — but still broken

    public static void main(String[] args) throws Exception {
        Thread[] threads = new Thread[10];
        for (int i = 0; i < 10; i++) {
            threads[i] = new Thread(() -> {
                for (int j = 0; j < 100_000; j++) counter++;
            });
            threads[i].start();
        }
        for (Thread t : threads) t.join();
        System.out.println(counter);  // expect 1_000_000 — get ~350_000
    }
}
```

`volatile` ensured both threads see the same starting value (5). That's exactly the problem — both compute from 5, and both write 6. About 65% of the increments were lost.

## The visibility-vs-atomicity table

| Property       | What it means                                                    | Provided by                           |
| -------------- | ---------------------------------------------------------------- | ------------------------------------- |
| **Visibility** | Writes propagate; readers don't see stale values                 | `volatile`, `synchronized`, `Atomic*` |
| **Atomicity**  | A multi-step operation completes as a unit, with no interleaving | `synchronized`, `Atomic*`             |
| **Ordering**   | Instructions don't get reordered across happens-before edges     | `volatile`, `synchronized`, `Atomic*` |

`volatile` covers visibility + ordering, _not_ atomicity. That single rule explains:

| Pattern                               | Safe with `volatile` alone?                              |
| ------------------------------------- | -------------------------------------------------------- |
| `volatile boolean stop; stop = true;` | ✅ single write                                          |
| `volatile int x; int v = x;`          | ✅ single read                                           |
| `volatile long x; x = newVal;`        | ✅ also fixes 32-bit tearing                             |
| `volatile int counter; counter++;`    | ❌ read-modify-write                                     |
| `volatile int x; if (x == 5) x = 6;`  | ❌ check-then-act                                        |
| `volatile Map m = ...; m.put(k, v);`  | ❌ `volatile` only protects the _reference_, not the map |

**Rule:** anything beyond a single read or a single write needs `synchronized` or an atomic.

## Three fixes for the counter

**Fix 1 — `synchronized`:**

```java
static int counter = 0;
static final Object lock = new Object();
synchronized (lock) { counter++; }
```

**Fix 2 — `AtomicInteger`:**

```java
static AtomicInteger counter = new AtomicInteger(0);
counter.incrementAndGet();  // CAS internally
```

**Fix 3 — `LongAdder`:**

```java
static LongAdder counter = new LongAdder();
counter.increment();   // writes to per-thread cell
counter.sum();         // sums all cells on read
```

## Performance under heavy contention (10 threads × 100k increments)

Measured on a typical laptop with modern HotSpot:

| Tool            | Time (~ms) | Why                                                                       |
| --------------- | ---------- | ------------------------------------------------------------------------- |
| `synchronized`  | ~60        | JIT lock coarsening + lightweight locking — modern HotSpot is _very_ fast |
| `LongAdder`     | ~60        | Splits across cells → minimal cross-thread contention                     |
| `AtomicInteger` | ~80        | All threads CAS the _same_ field → a CAS retry storm under contention     |

This contradicts the popular intuition that "lock-free is faster". Under high single-field contention, `AtomicInteger.incrementAndGet()` does:

```java
do {
    current = get();
    next = current + 1;
} while (!compareAndSet(current, next));  // retry on collision
```

With many threads colliding, each `incrementAndGet` may CAS-retry 5–10 times. `LongAdder` was designed specifically to fix this — it splits contention across multiple memory locations.

## Choosing the right tool (semantically, not by guessed performance)

| Need                                                             | Use                                      |
| ---------------------------------------------------------------- | ---------------------------------------- |
| Stop flag, single writer                                         | `volatile boolean`                       |
| Counter, low/medium contention                                   | `AtomicInteger`                          |
| Counter, very high write rate, infrequent reads (metrics)        | `LongAdder`                              |
| Compound operation (more than a single increment)                | `synchronized` or `ReentrantLock`        |
| Atomic decision based on the value ("increment only if < limit") | `synchronized` or a `compareAndSet` loop |
| Atomic compound state change                                     | `AtomicReference<ImmutableRecord>`       |

In code review, defend the choice by _what you're doing_, not by _guessed performance_. Modern JVMs make the performance differences smaller than people think — and microbenchmarks lie.

## Mental model: every primitive is a contract

| Primitive      | What it tells the JIT/CPU                                                    |
| -------------- | ---------------------------------------------------------------------------- |
| `volatile`     | Don't cache this field; emit memory barriers on each access                  |
| `synchronized` | Flush caches on lock entry/exit; emit full memory barriers; mutual exclusion |
| `Atomic*`      | Use CPU atomic instructions (CAS) for read-modify-write                      |
| `final`        | Safe to publish to other threads after the constructor finishes              |

Without a contract, there's no guarantee. The JIT assumes single-threaded code.

## Gotchas

- **`volatile counter++` is broken.** This is the most common confusion. `volatile` solves visibility, not atomicity. Use `AtomicInteger`.
- **`volatile Map m = new HashMap<>();`** — `volatile` protects the _reference assignment_, not operations on the map. `m.put(k, v)` is still racy. Use `ConcurrentHashMap`.
- **The JIT optimizes per method.** It does not "know" that `main()` writes a field that the worker reads. Without `volatile`, the worker can loop forever. Reproducible with `java -server` on a tight loop.
- **Long/double tearing** — on 32-bit JVMs, non-volatile `long`/`double` writes can split into two 32-bit writes, so readers can see half-written values. `volatile long` fixes it.
- **`AtomicInteger` is slower than `synchronized` under heavy contention.** CAS-retry storms happen when many threads hit one field. `LongAdder` is the answer for hot counters.
- **Microbenchmarks lie.** JIT warmup, lock coarsening, biased locking history (removed in Java 15+), GC pauses, and CPU cache topology all distort small benchmarks. Textbook orderings (`LongAdder > AtomicInteger > synchronized`) hold only under specific extreme conditions.
- **Constructor escape.** Storing `this` in a field or passing it to another thread before the constructor finishes can publish a partially constructed object — the receiving thread sees default values for `final` fields. Don't leak `this` from a constructor.
- **Common non-thread-safe classes to know:** `HashMap`, `ArrayList`, `LinkedList`, `TreeMap`, `StringBuilder`, `SimpleDateFormat`, `Calendar`, `Random`. Use the concurrent variants, or `java.time` / `ThreadLocalRandom`.

## References

- Brian Goetz, _Java Concurrency in Practice_ — chapters 2–3 (still the canonical JMM reference).
- [JLS §17 — Threads and Locks](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html) (the Java Memory Model).
- [JEP 188 — Java Memory Model Update](https://openjdk.org/jeps/188).
