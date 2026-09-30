---
title: "Thread-safety taxonomy and concurrent collections (Goetz framework)"
description: "Goetz's five thread-safety categories and what each means for callers, then the concurrent collections that implement them: ConcurrentHashMap's atomic compound APIs and cache stampede, CopyOnWriteArrayList, bounded BlockingQueues, the Executors trap, and the legacy synchronized wrappers."
pubDatetime: 2026-09-30T09:55:00+02:00
tags: [java, concurrency, collections, jvm]
sourceNotes: [thread-safety-taxonomy-and-concurrent-collections]
---

> Brian Goetz classifies thread-safety into five categories — immutable / thread-safe / conditionally thread-safe / thread-compatible / thread-hostile — and every shared field falls into one. Knowing the category tells you exactly which locking responsibility falls on the caller, and which JDK concurrent collection (CHM, COW list, BlockingQueue) implements each level.

## Table of contents

## Overview

"Is this thread-safe?" is the wrong question — the right one is "which of the five categories is this?". Each category has a precise contract about what the caller must do (often nothing, sometimes external synchronization, sometimes "give up and replace it").

This post covers the Goetz taxonomy, then applies it to the concurrent collections you actually use:

- `ConcurrentHashMap`'s atomic compound APIs (and the cache stampede that hides behind every `containsKey + put`)
- `CopyOnWriteArrayList`'s read-fast / write-disaster trade-off
- the `BlockingQueue` family, where bounded vs. unbounded is the only decision that matters
- the legacy `Collections.synchronizedXxx` wrappers

Finally, a correction: `SimpleDateFormat` is actually thread-compatible, not thread-hostile — truly hostile classes are rare (`System.runFinalizersOnExit`).

## Key points

- **Five thread-safety categories** map the contract between a class and its callers. Know the names — they're the vocabulary of code review.
- **Thread-safe = no caller responsibility.** Conditionally thread-safe = the caller must add external synchronization for specific operations (typically iteration).
- **`ConcurrentHashMap` operations are individually atomic; sequences are NOT.** `containsKey + put` is a race window; use `computeIfAbsent`/`putIfAbsent`/`compute`/`merge`/`replace` instead.
- **Cache stampede** is the real-world cost of the check-then-act race — many threads pass the `containsKey` check on a cold cache and all do the expensive fetch in parallel.
- **CHM compound APIs hold a per-bin lock during the lambda** — don't modify the same map from inside `computeIfAbsent`, and don't do slow I/O inside the lambda.
- **CHM iterators are weakly consistent** — they never throw `ConcurrentModificationException`, and may or may not see concurrent updates.
- **`CopyOnWriteArrayList` wins at read-heavy / write-rare** — every write reallocates the entire array. Use it for listener lists and config snapshots; avoid it for general-purpose lists.
- **The COW iterator captures a snapshot** at the start of iteration — predictable for listener fan-out; concurrent writes don't affect an in-flight iteration.
- **For `BlockingQueue`, bounded vs. unbounded is the only decision that matters.** Unbounded = latent OOM. Bounded = backpressure.
- **`Executors.newFixedThreadPool(n)` uses an unbounded queue by default** — a hidden OOM bug in code that "just works in staging".
- **`Collections.synchronizedXxx` is legacy** — every one has a better modern concurrent alternative.
- **`SimpleDateFormat` is thread-compatible, not thread-hostile** — `synchronized(sdf)` does work, but it's the wrong fix. The right fix is `DateTimeFormatter` (immutable).

## The Goetz taxonomy

| Category                      | Caller responsibility                                                                                                      | Examples                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Immutable**                 | None — share freely                                                                                                        | `String`, `Integer`, `LocalDate`, `DateTimeFormatter`, records with all-final fields                       |
| **Thread-safe**               | None for single operations; compound atomicity via class-provided APIs                                                     | `ConcurrentHashMap`, `AtomicInteger`, `BlockingQueue`, `CopyOnWriteArrayList`                              |
| **Conditionally thread-safe** | Single operations are safe automatically; the caller must add external synchronization for iteration / compound operations | `Collections.synchronizedMap`, `Collections.synchronizedList`                                              |
| **Thread-compatible**         | The caller must add external synchronization for _all_ access                                                              | `HashMap`, `ArrayList`, `LinkedList`, `TreeMap`, `StringBuilder`, `SimpleDateFormat`, `Calendar`, `Random` |
| **Thread-hostile**            | Cannot be made safe even with external synchronization — mutates global state outside any lock discipline                  | `System.runFinalizersOnExit`, `System.setOut/Err`, legacy mutable globals                                  |

**The contract difference between thread-safe and conditionally thread-safe:** a thread-safe class is safe by default — you don't need to look at its _callers_ to verify safety. A conditionally thread-safe class is safe only if every caller follows the extra protocol; it's only as safe as its worst caller.

## Why the corrected `SimpleDateFormat` classification matters

`SimpleDateFormat` is often colloquially called "thread-hostile" — but strictly, it's **thread-compatible**. External synchronization works:

```java
synchronized (sdf) {
    sdf.parse("2026-05-09");   // safe — one thread at a time
}
```

This genuinely fixes the corruption. People call it "hostile" because its surface API looks immutable (just `format` / `parse` methods), so engineers share instances assuming they're safe. The hidden mutable `Calendar` field then breaks under load.

The right reaction in code review isn't "add locking" — it's "replace it with `DateTimeFormatter`". The class is fixable, but the fix (serializing all date parsing in the JVM) is poor compared to the immutable alternative.

Truly thread-hostile classes are rare:

- `System.runFinalizersOnExit()` — schedules global finalizer behavior; no caller lock helps
- `System.setOut() / setErr()` — globally swaps streams; affects every thread
- Some legacy mutable singletons that mutate on read

## ConcurrentHashMap — atomic operations, non-atomic sequences

CHM guarantees that each individual method call is atomic. **Sequences of method calls are NOT.**

```java
// ❌ Compound op — racy
if (!map.containsKey(id)) {
    map.put(id, fetch(id));   // two threads can both pass the check
}

// ✅ Atomic compound API
map.computeIfAbsent(id, this::fetch);   // CHM holds per-bin lock; fetch runs at most once per key
```

CHM provides a full set of atomic compound APIs:

| API                         | Atomicity guarantee                                         |
| --------------------------- | ----------------------------------------------------------- |
| `putIfAbsent(k, v)`         | Insert only if absent                                       |
| `computeIfAbsent(k, fn)`    | Lazily compute and insert if absent; `fn` runs at most once |
| `computeIfPresent(k, fn)`   | Update only if present                                      |
| `compute(k, fn)`            | Always compute, presence-agnostic                           |
| `merge(k, v, fn)`           | Insert `v` if absent, else merge with `fn(old, v)`          |
| `replace(k, expected, new)` | CAS — replace only if the current value matches             |

**The code-review reflex:** any `get` / `containsKey` / `put` sequence on a CHM → replace it with the atomic compound API.

### Cache stampede — the real-world cost

The `containsKey + put` race isn't theoretical. On a cold cache under load:

```java
public User getUser(String id) {
    if (!cache.containsKey(id)) {
        User u = db.fetchUser(id);   // 200 ms
        cache.put(id, u);
    }
    return cache.get(id);
}
```

With 100 concurrent requests for the same uncached `id`:

- All 100 threads pass `containsKey` (they all see it absent)
- All 100 threads call `db.fetchUser(id)` → **100× the DB load**
- All 100 `put` (the last one wins, but they all paid)

A common production incident pattern: cold cache + concurrent traffic = a stampede that takes down the DB.

The fix:

```java
return cache.computeIfAbsent(id, db::fetchUser);   // 1 DB query instead of 100
```

### CHM gotchas

- **Don't modify the map inside the compute lambda** — CHM holds a per-bin lock; recursive modification can deadlock or throw `IllegalStateException` (Java 9+).
- **Keep compute lambdas short** — long-running lambdas (DB calls, HTTP fetches) serialize all threads hitting the same bin. For real caching with single-flight semantics, prefer Caffeine's `LoadingCache`.
- **Iterators are weakly consistent** — they reflect the map at some point during iteration, never throw CME, and may or may not see concurrent updates. For a snapshot: `new HashMap<>(chm)`.

## CopyOnWriteArrayList — the opposite trade-off

Every write reallocates the entire array:

```java
// Conceptually
public synchronized void add(E e) {
    Object[] old = elements;
    Object[] copy = new Object[old.length + 1];
    System.arraycopy(old, 0, copy, 0, old.length);
    copy[old.length] = e;
    this.elements = copy;   // atomic reference swap
}

public E get(int i) {
    return (E) elements[i];   // no lock at all
}
```

**It wins at read-heavy / write-rare workloads (100:1 or better).** Reads are completely lock-free, and iteration sees a consistent snapshot of the array as of the start of iteration.

**Canonical uses:**

- Listener / observer registries (Spring's `ApplicationEventMulticaster`, AWT/Swing)
- Configuration snapshots (set rarely at startup, read constantly)
- Subscriber lists in event-driven code
- gRPC interceptor chains

**Catastrophic for:**

- General-purpose lists with regular writes (every add = a full reallocation)
- Large lists with periodic writes (10k elements × 100 writes/sec = 1M array elements/sec of churn)
- Memory-constrained services (GC pressure from constant garbage)
- Bulk inserts with element-at-a-time `add()` (use `addAll` for one reallocation, not N)

**The iterator snapshot guarantee** is the underrated win:

```java
for (Listener l : listeners) {
    l.onEvent(e);    // safe even if another thread adds/removes during iteration
}
```

The iterator captured the array reference at the start; writes go to a new array, so the iterator never breaks and never errors. A listener registered mid-dispatch isn't seen by the in-flight iteration — it gets the next event. Predictable.

### Decision rule for COW

| Reads:Writes     | Size          | Use                                                           |
| ---------------- | ------------- | ------------------------------------------------------------- |
| 1000:1 or higher | Any           | `CopyOnWriteArrayList`                                        |
| 100:1            | Small (<100)  | `CopyOnWriteArrayList` (OK)                                   |
| 100:1            | Large (>1000) | Reconsider — maybe `ConcurrentLinkedQueue`                    |
| <10:1            | Any           | NOT COW — a synchronized list, a queue, or rethink the design |

## BlockingQueue — bounded is non-negotiable

The producer-consumer foundation. **The one decision that matters**: bounded vs. unbounded.

```java
// ❌ DANGEROUS — silent OOM bug
BlockingQueue<Job> queue = new LinkedBlockingQueue<>();
// Default capacity: Integer.MAX_VALUE — effectively unbounded

// ✅ SAFE — backpressure
BlockingQueue<Job> queue = new LinkedBlockingQueue<>(1000);
```

**The failure mode:**

1. Producer rate: 1000/sec. Consumer rate: 800/sec.
2. Downstream slows (a DB hiccup, GC, the network). The consumer drops to 100/sec.
3. The queue grows by 900/sec → 3 GB in 1 hour → OOM.

**With a bounded queue**, the producer blocks on `put()` → backpressure propagates upstream → graceful 503s instead of JVM death.

### The `Executors` trap

`Executors.newFixedThreadPool(n)` looks safe — it isn't. Under the hood:

```java
new ThreadPoolExecutor(n, n, 0L, TimeUnit.MILLISECONDS,
                       new LinkedBlockingQueue<Runnable>());   // ← UNBOUNDED
```

10 threads, but an **unbounded queue**. Under a burst, tasks pile up. The pool isn't the backpressure — it just caps concurrent execution. The queue is the unbounded buffer in front of it.

The same problem applies to `newSingleThreadExecutor()` (unbounded queue) and `newCachedThreadPool()` (unbounded threads).

**The safe alternative:**

```java
new ThreadPoolExecutor(
    10, 10, 0L, TimeUnit.MILLISECONDS,
    new ArrayBlockingQueue<>(1000),
    new ThreadPoolExecutor.CallerRunsPolicy()
);
```

`CallerRunsPolicy`: when the queue is full, the submitting thread runs the task itself → a natural slowdown of the producer → elegant backpressure in one line.

Other rejection policies:

- `AbortPolicy` (the default) — throws `RejectedExecutionException`. OK for request handlers; bad for fire-and-forget.
- `DiscardPolicy` — silently drops. Almost never right.
- `DiscardOldestPolicy` — drops the oldest queued task. Sometimes right for "latest wins" telemetry.

### The BlockingQueue family

| Implementation          | When to use                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `LinkedBlockingQueue`   | **The default.** Optional bound. Separate head/tail locks → higher throughput              |
| `ArrayBlockingQueue`    | Bounded, fixed capacity. Single lock. Predictable memory                                   |
| `PriorityBlockingQueue` | Unbounded heap, sorted                                                                     |
| `DelayQueue`            | Items become available at scheduled times (used by `ScheduledThreadPoolExecutor`)          |
| `SynchronousQueue`      | Zero capacity — the producer waits for a consumer hand-off (used by `newCachedThreadPool`) |
| `LinkedTransferQueue`   | LBQ + `transfer()`, to block until a consumer takes this specific element                  |

The textbook producer-consumer pattern in 5 lines:

```java
BlockingQueue<Order> queue = new LinkedBlockingQueue<>(1000);

// Producer (one thread)
queue.put(order);   // blocks if full

// Consumer (another thread)
while (true) {
    Order o = queue.take();   // blocks if empty
    process(o);
}
```

No `wait/notify`, no `synchronized`, no locks in your code. The queue handles all the coordination.

## Collections.synchronizedXxx — legacy

These pre-`java.util.concurrent` wrappers put every method inside `synchronized(this)`:

```java
Map<String, User> map = Collections.synchronizedMap(new HashMap<>());

// ❌ Iteration throws ConcurrentModificationException
for (User u : map.values()) { ... }

// ✅ External sync required — caller's responsibility (the "conditional" part)
synchronized (map) {
    for (User u : map.values()) { ... }
}
```

Modern replacements:

| Legacy                                               | Modern                              |
| ---------------------------------------------------- | ----------------------------------- |
| `Collections.synchronizedMap(new HashMap<>())`       | `ConcurrentHashMap`                 |
| `Collections.synchronizedList(new ArrayList<>())`    | `CopyOnWriteArrayList` (read-heavy) |
| `Collections.synchronizedSet(new HashSet<>())`       | `ConcurrentHashMap.newKeySet()`     |
| `Collections.synchronizedSortedMap(new TreeMap<>())` | `ConcurrentSkipListMap`             |

In code review: `synchronizedXxx` in new code → ask "why not the concurrent variant?"

## Decision tree

```
Need a thread-safe collection?
├── Map → ConcurrentHashMap (sorted: ConcurrentSkipListMap)
├── List
│   ├── Read-heavy / write-rare → CopyOnWriteArrayList
│   ├── Producer-consumer → BlockingQueue (not a List)
│   └── General → reconsider design
├── Set → ConcurrentHashMap.newKeySet() (sorted: ConcurrentSkipListSet)
├── Queue
│   ├── Bounded blocking → ArrayBlockingQueue / LinkedBlockingQueue
│   ├── Priority → PriorityBlockingQueue
│   ├── Scheduled → DelayQueue
│   ├── Hand-off → SynchronousQueue
│   └── Lock-free unbounded → ConcurrentLinkedQueue
└── Counter → AtomicLong / LongAdder
```

## Gotchas

- **`if (!map.containsKey(k)) map.put(k, v)` on a `ConcurrentHashMap` is a race.** Use `computeIfAbsent` / `putIfAbsent`.
- **Cache stampede** — `containsKey + fetch + put` on a cold cache under load → many parallel fetches. The atomic compound API fixes it.
- **Modifying a CHM inside a compute lambda** → deadlock or `IllegalStateException`. The lambda must be pure with respect to the map.
- **Long compute lambdas serialize a bin** — keep lambdas short, and don't do DB/HTTP calls inside them.
- **`Executors.newFixedThreadPool(n)` uses an unbounded `LinkedBlockingQueue`** — a silent OOM under burst. Construct a `ThreadPoolExecutor` directly, with a bounded queue + `CallerRunsPolicy`.
- **`Executors.newCachedThreadPool()` uses unbounded threads** — a different failure with the same root cause: thread explosion instead of memory explosion.
- **Iterating a `Collections.synchronizedXxx` without an external `synchronized(coll)`** → `ConcurrentModificationException`.
- **`CopyOnWriteArrayList` for a write-heavy workload** → memory churn, slow writes, GC pressure. The "registered once at startup" use case can silently morph into "updated every minute" — re-evaluate when the workload changes.
- **`CopyOnWriteArrayList` bulk `add()` in a loop** → O(N²) work. Use `addAll`.
- **`SimpleDateFormat` is thread-compatible, not thread-hostile** — the fix is `DateTimeFormatter`, not `synchronized(sdf)`.
- **A static `SimpleDateFormat` field** on a Spring singleton service → shared across all request threads → corruption. The most common form of this bug.
- **`AtomicReference<HashMap>`** ≠ thread-safe — the _reference_ is atomic; mutating the map through the reference is still racy. Use a concurrent collection or an immutable snapshot.

## Code review checklist

- [ ] Shared `HashMap` / `ArrayList` / `TreeMap` field on a singleton service → race
- [ ] `if (!chm.containsKey(k)) chm.put(...)` → not atomic; use `computeIfAbsent`
- [ ] `chm.get(k)` then `chm.put(k, fn(value))` → use `compute` / `merge`
- [ ] `Collections.synchronizedXxx` in new code → suggest the concurrent variant
- [ ] Iterating a `Collections.synchronizedList` without `synchronized(list)` → CME risk
- [ ] `CopyOnWriteArrayList` for a write-heavy or large-write workload → memory churn
- [ ] `Executors.newFixedThreadPool` / `newSingleThreadExecutor` / `newCachedThreadPool` for user-facing load → unbounded queue/threads
- [ ] `LinkedBlockingQueue` without a size bound → OOM risk
- [ ] CHM `computeIfAbsent` lambda doing I/O or touching the same map → flag
- [ ] Static `SimpleDateFormat` / `Calendar` / `DateFormat` field → replace with `DateTimeFormatter`
- [ ] `AtomicReference<MutableMap>` → atomicity is on the reference only

## References

- Earlier in this topic:
  - [Java memory model: visibility, atomicity, and why JIT optimizes per-method](/posts/java-memory-model-visibility-and-atomicity/)
  - [Synchronized mechanics: intrinsic monitors, lock object choice, DCL, and the SimpleDateFormat trap](/posts/synchronized-monitors-dcl-and-simpledateformat/)
  - [Java atomics: CAS contention, LongAdder mechanics, AtomicReference for compound state, and ABA](/posts/java-atomics-cas-contention-and-aba/)
  - [Explicit locks in Java: ReentrantLock, ReadWriteLock, Condition, and StampedLock](/posts/explicit-locks-reentrantlock-rwlock-condition-stampedlock/)
- Brian Goetz, _Java Concurrency in Practice_, chapters 4–5 — composition and concurrent collections.
- Joshua Bloch, _Effective Java_, Item 79 — avoid excessive synchronization.
- JDK Javadoc: [`java.util.concurrent`](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/package-summary.html).
