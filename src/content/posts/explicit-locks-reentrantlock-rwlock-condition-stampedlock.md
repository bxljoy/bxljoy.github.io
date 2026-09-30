---
title: "Explicit locks in Java: ReentrantLock, ReadWriteLock, Condition, and StampedLock"
description: "What synchronized can't do and ReentrantLock can, the lock-try-finally pattern, why Condition.await() needs while not if, when ReentrantReadWriteLock actually pays off, lock downgrade vs. the upgrade deadlock, and StampedLock's optimistic read."
pubDatetime: 2026-09-30T09:45:00+02:00
tags: [java, concurrency, locking, jvm]
sourceNotes: [explicit-locks-reentrantlock-rwlock-condition-stampedlock]
---

> `ReentrantLock` exists because `synchronized` can't do timeouts, can't be interrupted, can't try-without-blocking, and has only one wait queue. Reach for explicit locks only when one of those features is required — `synchronized` remains the simpler, leak-proof default for everything else.

## Table of contents

## Overview

`synchronized` is the simple, exception-safe, JVM-optimized default for mutual exclusion. The `java.util.concurrent.locks` package exists for the cases `synchronized` cannot serve: bounded-latency lock acquisition, deadlock-avoiding back-off, cancellable waiters, multiple wait queues, and read-heavy workloads where serializing readers is wasteful.

This post covers:

- the four features `ReentrantLock` adds
- the canonical `lock-try-finally-unlock` pattern (and why placement matters)
- the `while`-not-`if` rule for `Condition.await()`
- when `ReentrantReadWriteLock` actually pays off, vs. when `ConcurrentHashMap` is the better answer
- the lock-downgrade pattern, and the matching upgrade-deadlock trap
- where `StampedLock`'s optimistic read fits

## Key points

- **`synchronized` cannot do five things**: try without blocking, bounded wait, interruptible wait, multiple wait queues per lock, fairness ordering. `ReentrantLock` adds all five.
- **The mandatory pattern**: `lock.lock()` _outside_ `try`, `lock.unlock()` inside `finally`. Putting `lock()` inside `try` risks an `IllegalMonitorStateException` that masks the real failure.
- **`tryLock()` enables deadlock avoidance** — try-acquire-or-back-off instead of blocking forever on out-of-order lock acquisition.
- **`tryLock(timeout)` enables bounded latency** — fail the request after N seconds rather than parking a thread indefinitely.
- **`lockInterruptibly()` makes waiters cancellable** — `synchronized` ignores interrupts, leaving stuck threads unable to clean up at shutdown.
- **Multiple `Condition` objects per lock** let producers signal `notFull` without waking consumers waiting on `notEmpty`. With `synchronized` you have one wait queue, and `notify()` may wake the wrong type of waiter.
- **Always `while (!cond) cond.await()`, never `if`** — spurious wakeups exist, and a signaled thread re-acquires the lock racing other threads that may have changed the state.
- **`ReentrantReadWriteLock` pays off only when reads dominate AND read critical sections are non-trivial.** For tiny reads (`map.get`), the bookkeeping overhead exceeds the parallelism gain — `synchronized` or `ConcurrentHashMap` wins.
- **Lock downgrade (write → read while still holding the write, then release the write) is allowed and useful.** Upgrade (read → write) deadlocks, because each upgrading reader waits for all readers (including itself) to release.
- **`StampedLock` adds optimistic reads** — try a read with no lock, then validate; fall back to a real read lock if a writer interfered. It's faster for read-heavy workloads, but not reentrant and has no `Condition` support.

## What `synchronized` cannot do

| Capability                                                                       | `synchronized`                  | `ReentrantLock`                      |
| -------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------ |
| Try without blocking                                                             | ❌                              | `tryLock()`                          |
| Wait at most N seconds                                                           | ❌                              | `tryLock(t, unit)`                   |
| Cancel via `Thread.interrupt()`                                                  | ❌ (ignored)                    | `lockInterruptibly()`                |
| Multiple wait queues per lock                                                    | ❌ (one monitor → one wait set) | `lock.newCondition()` × N            |
| Fairness (FIFO ordering)                                                         | ❌ (always unfair)              | `new ReentrantLock(true)`            |
| Auto-release on exception                                                        | ✅ (JVM-emitted `MONITOREXIT`)  | ❌ (you must `try/finally` yourself) |
| JVM optimizations (lock coarsening, lightweight locking, biased locking history) | ✅ heavy                        | ⚠️ less aggressive                   |

`synchronized` is the right default. Reach for `ReentrantLock` when at least one of the five missing capabilities is actually required. If you're not using any of them, `synchronized` is simpler, (often) faster, and can't leak.

## The mandatory pattern

```java
lock.lock();      // ← outside the try
try {
    // critical section
} finally {
    lock.unlock();  // ← always in finally
}
```

Two iron rules:

1. **`unlock()` inside `finally`** — otherwise an exception in the critical section leaves the lock held forever, blocking every other thread.
2. **`lock.lock()` immediately before `try`, not inside it** — if `lock.lock()` itself throws (e.g., `lockInterruptibly()` throws `InterruptedException`, or any unchecked Error during acquisition), the `finally` block still runs and calls `unlock()` on a lock you don't hold → `IllegalMonitorStateException`, which masks the original exception and leaves a confusing stack trace.

In code review, when you see `ReentrantLock`, your eye should jump to the line right above `try` and confirm that `lock.lock()` is exactly there. Most lock-leak bugs are this exact mistake.

## The four features in detail

### `tryLock()` — non-blocking attempt

```java
if (lock.tryLock()) {
    try { /* got it */ } finally { lock.unlock(); }
} else {
    // didn't get it — back off, try later, fall through
}
```

Use case: **deadlock avoidance** via try-and-back-off when multiple locks must be acquired together.

### `tryLock(timeout, unit)` — bounded wait

```java
if (lock.tryLock(5, TimeUnit.SECONDS)) {
    try { /* got it within 5s */ } finally { lock.unlock(); }
} else {
    // timeout — return error to user instead of holding thread hostage
}
```

Use case: **bounded latency** in request-handling threads.

### `lockInterruptibly()` — cancel-aware

```java
try {
    lock.lockInterruptibly();
    try { /* critical section */ } finally { lock.unlock(); }
} catch (InterruptedException e) {
    Thread.currentThread().interrupt();   // restore status
    // abort cleanly
}
```

`synchronized` ignores `Thread.interrupt()`: a thread blocked on `MONITORENTER` stays blocked. `lockInterruptibly()` throws `InterruptedException`, allowing graceful cancellation — critical for executor shutdown, scheduled jobs, and request timeouts.

### Fairness

```java
ReentrantLock fair = new ReentrantLock(true);     // FIFO order, slow
ReentrantLock unfair = new ReentrantLock();       // default, fast
```

The default is **unfair** — newly arriving threads can barge ahead of waiters. That's counter-intuitive, but it's faster (no FIFO queue management) and reduces context switches. Use fair mode (typically 2–10× slower under contention) only when starvation is a real, demonstrated problem.

## Multiple `Condition` objects — producer/consumer

```java
class BoundedQueue<T> {
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notFull  = lock.newCondition();
    private final Condition notEmpty = lock.newCondition();
    private final Object[] items = new Object[100];
    private int count = 0;

    public void put(T item) throws InterruptedException {
        lock.lock();
        try {
            while (count == items.length) {     // while, not if
                notFull.await();
            }
            items[count++] = item;
            notEmpty.signal();                  // wake one consumer
        } finally { lock.unlock(); }
    }

    public T take() throws InterruptedException {
        lock.lock();
        try {
            while (count == 0) {
                notEmpty.await();
            }
            T item = (T) items[--count];
            notFull.signal();
            return item;
        } finally { lock.unlock(); }
    }
}
```

Two `Condition`s, one lock. `put` waits on `notFull` and signals `notEmpty`; `take` does the opposite. With `synchronized` + `Object.wait()/notify()`, all waiters share one queue — `notify()` may wake the wrong type, forcing `notifyAll()` (wasteful). With `Condition`, you signal exactly the right group.

## The `while`-not-`if` rule

```java
while (count == items.length) {
    notFull.await();
}
// NOT: if (count == items.length) notFull.await();
```

Two reasons:

1. **Spurious wakeups** — the JVM is allowed to wake a thread from `await()` for no reason. The spec permits it because efficiently preventing spurious wakeups on every OS would be expensive.
2. **The wakeup-to-acquire race** — when signaled, a thread must re-acquire the lock before continuing. Between the signal and the acquire, another thread can grab the lock and change the state. The condition was true at signal time, but may be false again by the time you actually run.

`while` re-checks after every wakeup; `if` proceeds with stale state and operates on a queue that's empty or full again.

This applies equally to `Condition.await()` and the legacy `Object.wait()`. Always `while`.

## `Condition` vs. `Object.wait()/notify()`

|                        | `synchronized` + `wait/notify`                            | `ReentrantLock` + `Condition`                   |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Wait queues per lock   | One                                                       | Many (one per Condition)                        |
| `notify()` granularity | Wakes one _arbitrary_ waiter (often forces `notifyAll()`) | `signal()` wakes only waiters on this Condition |
| Bounded wait           | `wait(timeout)` ✅                                        | `await(timeout, unit)` ✅                       |
| Interruptible          | ✅                                                        | ✅                                              |
| Cleanup on exception   | Automatic                                                 | Manual `try/finally`                            |

For a trivial single-producer/single-consumer case with one wait queue, `synchronized + wait/notify` is fine. For anything with multiple types of waiters, `Condition` is cleaner and faster (no `notifyAll()` storm).

## `ReentrantReadWriteLock` — when it pays off

It allows many readers in parallel OR one writer; readers and writers are mutually exclusive.

```java
class Cache<K, V> {
    private final Map<K, V> map = new HashMap<>();
    private final ReentrantReadWriteLock rw = new ReentrantReadWriteLock();
    private final Lock r = rw.readLock();
    private final Lock w = rw.writeLock();

    public V get(K key) {
        r.lock(); try { return map.get(key); } finally { r.unlock(); }
    }
    public void put(K key, V value) {
        w.lock(); try { map.put(key, value); } finally { w.unlock(); }
    }
}
```

**It pays off when:**

1. Reads dominate writes (≥10:1 ratio)
2. AND read critical sections are non-trivial (~µs+) — long enough to amortize the bookkeeping cost
3. AND no JDK concurrent collection fits the data shape

**It's worse than `synchronized` when:**

- The critical sections are tiny (single field reads, a simple `map.get`) — the bookkeeping overhead (~50–200ns) exceeds the parallelism gain
- Writes aren't actually rare — every writer excludes every reader anyway, so the RW lock just adds overhead
- It's in the default non-fair mode — a writer can starve under heavy read traffic

**It's often a sign you should use a concurrent collection instead:**

| Use case          | Better than an RW lock                              |
| ----------------- | --------------------------------------------------- |
| Map               | `ConcurrentHashMap` (lock-striped, lock-free reads) |
| List, rare writes | `CopyOnWriteArrayList` (lock-free reads)            |
| Set               | `ConcurrentHashMap.newKeySet()`                     |
| Counter           | `AtomicLong`, `LongAdder`                           |

`ReadWriteLock` is for genuinely custom shared state (a graph, a rule engine, a custom data structure) where no JDK concurrent collection fits.

## Lock downgrade — allowed

A thread holding the write lock can acquire the read lock _while still holding the write_, then release the write — ending up holding only the read lock. This lets you publish a write, then continue reading without blocking other readers.

```java
w.lock();
try {
    map.put(key, value);
    r.lock();              // downgrade: acquire read while holding write
} finally {
    w.unlock();            // release write — now hold only read
}
try {
    return processData(map);   // other readers can run in parallel now
} finally {
    r.unlock();
}
```

Note the **two `try/finally` blocks**. Use this only when you genuinely need to read your own write while letting others read concurrently. It's niche, but worth recognizing.

## Why upgrade is forbidden — the deadlock

```
Time    Thread A                       Thread B
----    --------                       --------
t1      r.lock() ✅                     r.lock() ✅
            (both readers — RW lock allows N readers in parallel)

t2      w.lock()  ← waits              w.lock()  ← waits
        (B holds a read; A blocks      (A holds a read; B blocks
         until ALL readers release)     until ALL readers release)
```

Both threads wait for _all_ readers to release before the write lock can be granted, but each of them _is_ a reader — neither will release until it gets the write. A classic deadlock.

`ReentrantReadWriteLock` simply throws or blocks indefinitely if you attempt this. The safe alternative is **release-acquire-recheck**:

```java
r.lock();
boolean needsWrite = checkSomething();
r.unlock();              // ← release first

if (needsWrite) {
    w.lock();
    try {
        if (stillNeedsWrite()) {   // re-check! state may have changed
            doTheWrite();
        }
    } finally { w.unlock(); }
}
```

Re-checking after re-acquiring is essential — between releasing the read lock and acquiring the write lock, another writer may have done what you intended. It's the same shape as [double-checked locking](/posts/synchronized-monitors-dcl-and-simpledateformat/): release the cheap lock, take the expensive one, re-validate the precondition.

## `StampedLock` (Java 8+) — optimistic read

`ReadWriteLock` is still pessimistic — readers acquire a real lock. `StampedLock` adds an **optimistic read** mode that does no locking at all:

```java
class Point {
    private double x, y;
    private final StampedLock sl = new StampedLock();

    public double distance() {
        long stamp = sl.tryOptimisticRead();   // no lock
        double currentX = x, currentY = y;
        if (!sl.validate(stamp)) {              // was there a write meanwhile?
            stamp = sl.readLock();              // fall back to real read lock
            try {
                currentX = x;
                currentY = y;
            } finally {
                sl.unlockRead(stamp);
            }
        }
        return Math.sqrt(currentX * currentX + currentY * currentY);
    }
}
```

Read the fields into locals, then `validate(stamp)`. If a write happened in between, the read is invalid → fall back. It's faster than an RW lock for read-heavy workloads with rare writes.

Drawbacks:

- Not reentrant (re-acquiring the same lock from the holding thread deadlocks)
- No `Condition` support
- Easy to misuse — you must read into local variables; never operate on shared state during the optimistic read
- Mostly used in JDK internals (`ConcurrentHashMap` resize, etc.)

## Decision tree

```
Need a lock?
├── No special needs (no timeout, no tryLock, no fairness, single wait queue)
│   └── synchronized — simpler, JVM-optimized, no leak risk
│
├── Need timeout / interruptible / tryLock / fairness / multiple Conditions
│   └── ReentrantLock
│
├── Read-heavy + non-trivial critical section + custom data structure
│   └── ReentrantReadWriteLock (verify ConcurrentHashMap doesn't fit first)
│
├── Read-heavy + tiny critical sections + rare writes + advanced
│   └── StampedLock (optimistic read) — only if you understand it
│
└── Producer/consumer or coordinating multiple wait conditions
    └── ReentrantLock + multiple Conditions
```

Most production code only needs the first two.

## Gotchas

- **`lock.lock()` inside the `try` block** — if acquisition throws, `finally` calls `unlock()` on a lock that isn't held → an `IllegalMonitorStateException` masks the real exception. Always put `lock()` immediately before `try`.
- **Forgetting `finally`** — an exception in the critical section leaves the lock held forever, and every other thread blocks. The single most common `ReentrantLock` bug.
- **`if (cond) cond.await()` instead of `while`** — a spurious wakeup or the wakeup race makes the thread proceed with stale state. Always `while`.
- **`ReentrantReadWriteLock` around tiny critical sections** — the bookkeeping overhead exceeds the parallelism gain; `synchronized` or `ConcurrentHashMap` is faster.
- **Trying to upgrade read → write** — deadlocks under contention. Release the read lock, acquire the write lock, re-check.
- **Lock downgrade with one `try/finally`** — it must be two: one for the write (with `r.lock()` inside, before `w.unlock()`), and one for the subsequent read.
- **Re-entering a `StampedLock`** — re-acquiring the same write lock from the holding thread deadlocks. `StampedLock` is non-reentrant by design.
- **An optimistic read operating on shared state directly** — you must read into local variables before validating. If you traverse shared state during the optimistic read, you may follow a stale pointer to garbage.
- **Fair mode by default** — almost always wrong. The default unfair mode is faster, and starvation is rarely a real problem. Use `(true)` only when you have evidence of starvation.
- **Switching from `notifyAll()` to `signal()`** — it's easy to assume `signal()` wakes all waiters on the lock; it wakes only one waiter on _this_ Condition. Use `signalAll()` if you actually need everyone.

## Code review checklist

- [ ] `ReentrantLock` without `lock.lock()` immediately before `try` → flag
- [ ] `unlock()` not inside `finally` → potential lock leak
- [ ] `if (cond) cond.await()` instead of `while` → bug
- [ ] `ReentrantReadWriteLock` around `map.get(k)` → likely wrong; recommend `ConcurrentHashMap`
- [ ] Trying to acquire the write lock while holding the read lock → deadlock; release-acquire-recheck instead
- [ ] `synchronized` block holding I/O where `tryLock(timeout)` would degrade gracefully → recommend `ReentrantLock`
- [ ] Fair mode chosen without justification → the default unfair mode is almost always right
- [ ] `Condition.signal()` where the design needs all waiters woken → should be `signalAll()`

## References

- Earlier in this topic: [Java memory model: visibility, atomicity, and why JIT optimizes per-method](/posts/java-memory-model-visibility-and-atomicity/)
- Earlier in this topic: [Synchronized mechanics: intrinsic monitors, lock object choice, DCL, and the SimpleDateFormat trap](/posts/synchronized-monitors-dcl-and-simpledateformat/)
- Brian Goetz, _Java Concurrency in Practice_, chapters 13–14 — explicit locks and non-blocking algorithms.
- JDK Javadoc: [`java.util.concurrent.locks`](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/package-summary.html) (`ReentrantLock`, `ReentrantReadWriteLock`, `StampedLock`, `Condition`).
