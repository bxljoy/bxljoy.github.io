---
title: "Synchronized mechanics: intrinsic monitors, lock object choice, DCL, and the SimpleDateFormat trap"
description: "What synchronized actually locks, why a private lock object beats synchronized(this), why SimpleDateFormat corrupts under load, why double-checked locking needs volatile, and the JMM's guarantee for final fields."
pubDatetime: 2026-09-30T09:21:00+02:00
tags: [java, concurrency, jvm, synchronization]
sourceNotes: [synchronized-monitors-dcl-and-simpledateformat]
---

> Every Java object hides a monitor in memory; `synchronized(X)` acquires X's monitor specifically. That single fact explains why `synchronized(this)` is risky, why `SimpleDateFormat` corrupts under load, and why double-checked locking _requires_ `volatile`.

## Table of contents

## Overview

`synchronized` is the most-used and most-misunderstood primitive in Java. The keyword does two things at once — mutual exclusion and a memory barrier — but exactly _which_ monitor it acquires depends entirely on what you pass to it.

This post covers:

- the mechanics (every Object has a monitor, and what `MONITORENTER` actually does)
- the four common patterns, and why a private lock object beats `synchronized(this)`
- the canonical `SimpleDateFormat` thread-safety bug and its fixes
- the double-checked-locking pattern, with the partial-construction race that makes `volatile` mandatory
- the JMM's special guarantee for `final` fields

## Key points

- **Every Java object has a hidden monitor** — owner thread, hold count, wait queue. The JVM creates it on demand the first time the object is synchronized on.
- **`synchronized(X)` acquires X's monitor**, not the surrounding class's. The lock lives on the _object_ the field points to, not on the field name.
- **`synchronized` does two things:** mutual exclusion AND a memory barrier (flush on unlock, invalidate on lock). It solves both visibility and atomicity in one primitive.
- **Prefer `private final Object lock = new Object()`** over `synchronized(this)` or `synchronized` methods — encapsulation prevents external lock hijacking and inheritance traps.
- **`SimpleDateFormat` mutates an internal `Calendar` field on every call** → it's not thread-safe. Symptoms under load: `NumberFormatException`, `ArrayIndexOutOfBoundsException`, silently wrong dates. Replace it with `DateTimeFormatter` (immutable).
- **Double-checked locking requires `volatile`** on the singleton field. Without it, the constructor's writes can be reordered after the publication of the reference, exposing a half-constructed object to other threads.
- **`final` fields get a special JMM guarantee:** after the constructor finishes, any thread that obtains a reference is guaranteed to see correctly initialized values — no synchronization needed. Caveat: don't leak `this` from the constructor.
- **The holder idiom and enum singletons are cleaner than DCL** — the JVM already guarantees lazy, thread-safe class initialization.

## Every Object hides a monitor

In memory, every Java object has three parts:

1. **Header** — class pointer, identity hash code
2. **Fields** — your data
3. **Monitor** — a hidden mutex (owner thread + hold count + wait queue), managed by the JVM

When you write `synchronized(x)`, the JVM emits:

- `MONITORENTER x` — acquires x's monitor, parking the thread if another thread owns it
- `MONITOREXIT x` — releases it (decrements the hold count; if it reaches zero, wakes one waiter)

Re-entrancy: a thread holding the lock can re-acquire it (the hold count increments). `MONITOREXIT` is emitted even on an exception, via an implicit try/finally.

## What `synchronized` actually guarantees

Two things, both essential:

| Guarantee            | What it means                                                                           |
| -------------------- | --------------------------------------------------------------------------------------- |
| **Mutual exclusion** | At most one thread executes the synchronized block on a given monitor at a time         |
| **Memory barrier**   | On lock acquire: invalidate the cache and re-read fields. On unlock: flush dirty writes |

The memory-barrier part is what makes `synchronized` solve **both** visibility (the `volatile` problem from [the Java memory model post](/posts/java-memory-model-visibility-and-atomicity/)) and atomicity (multi-step operations). Inside a synchronized block, you see all writes any other thread made before _its_ matching unlock — this is the canonical happens-before edge.

## The four common patterns

```java
// A — instance method
public synchronized void foo() { ... }
// Lock: this object's monitor

// B — static method
public static synchronized void foo() { ... }
// Lock: MyClass.class's monitor (one global lock — bottleneck for ALL instances)

// C — explicit synchronized(this)
public void foo() { synchronized(this) { ... } }
// Same as A

// D — private lock object  ← THE GOOD ONE
private final Object lock = new Object();
public void foo() { synchronized(lock) { ... } }
```

## Why the lock lives on the _object_, not the field

`synchronized(lock)` acquires the monitor of whatever Object `lock` references — not the monitor of the surrounding class. Visualizing a `BankAccount` with a private lock:

```
BankAccount instance              Object (the private lock)
┌───────────────────────────┐     ┌──────────────────────────┐
│ [hidden monitor — UNUSED] │     │ [hidden monitor — USED]  │ ← what
│ fields:                   │     │ Owner: Thread-1          │   synchronized(lock)
│   balance = 100           │     │ hold count: 1            │   acquires
│   lock ───────────────────┼────►│ wait queue: [Thread-2]   │
└───────────────────────────┘     └──────────────────────────┘
```

Two threads on the _same_ `BankAccount` see the same `lock` field → the same Object → the same monitor → mutual exclusion ✅. Two threads on _different_ `BankAccount`s see different lock Objects → no contention ✅.

This is why a class can have multiple independent locks via multiple `Object` fields:

```java
private final Object readLock = new Object();
private final Object writeLock = new Object();
```

Two different objects, two different monitors, no cross-contention.

## Why `synchronized(this)` is worse than a private lock

Three concrete failure modes:

1. **Lock hijacking / starvation** — external code holds your reference and runs `synchronized(myService) { Thread.sleep(60_000); }`. All your synchronized methods stall for a minute.
2. **Hidden deadlock** — `synchronized(this) { libraryCall(); }`, and the library, deep inside, takes an unrelated lock that another thread takes in the opposite order.
3. **Inheritance trap** — subclasses inherit `this`. A subclass's `synchronized` methods share the _same_ monitor as the parent's → unintended contention.

A private final lock object solves all three: it's encapsulated, its name states its purpose (`balanceLock`, `cacheLock`), and it isn't inherited.

### The standard idiom

```java
public class BankAccount {
    private final Object lock = new Object();
    private long balance;

    public void deposit(long amount) {
        synchronized (lock) {
            balance += amount;
        }
    }
}
```

- `private` — encapsulated
- `final` — the reference can never be reassigned (otherwise threads might lock different objects)
- A real `Object`, not a `String` or `Integer` — string interning means `"lock"` could be shared globally

## The SimpleDateFormat trap

`SimpleDateFormat` extends `DateFormat`, which has:

```java
protected Calendar calendar;  // mutable internal state
```

Both `parse()` and `format()` mutate `calendar` as scratch space, with no locking. Two threads calling a shared instance corrupt each other's state.

Symptoms under load:

- `NumberFormatException`
- `ArrayIndexOutOfBoundsException`
- Silently wrong dates (year 0, year 14000, etc.)
- Random `null`

Reproducer: a 20-thread pool × 1000 calls to `SDF.format(SDF.parse("2026-05-01"))` reliably produces a flood of exceptions and corrupted strings within milliseconds.

**Fixes, ranked:**

| Fix                                  | When to use                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `DateTimeFormatter.ofPattern(...)`   | **Default.** Immutable, thread-safe, part of `java.time`                                    |
| `ThreadLocal<SimpleDateFormat>`      | A legacy or third-party API requires a `DateFormat`. Remember `.remove()` in pooled threads |
| `synchronized (SDF) { ... }`         | A quick patch when you can't refactor. Serializes all callers — slow under load             |
| `new SimpleDateFormat(...)` per call | Easy, but ~1KB of allocation per call → GC pressure at high QPS                             |

The same trap applies to `Calendar`, `DateFormat`, and `Random` (use `ThreadLocalRandom`). Know this list — it's a frequent code-review target.

## Double-checked locking — the case where `volatile` is mandatory

The fast-path lazy singleton:

```java
public class BrokenDCL {
    private static Database db;          // NOT volatile — BUG

    public static Database getDb() {
        if (db == null) {                   // ① first check, no lock
            synchronized (BrokenDCL.class) {
                if (db == null) {           // ② second check, with lock
                    db = new Database();    // ③ construct + assign
                }
            }
        }
        return db;
    }
}
```

The bug: `db = new Database()` is **not atomic**. The JVM compiles it as:

```
1. Allocate memory → addr
2. Run constructor — initialize fields
3. Publish: db = addr
```

The JVM is allowed to reorder steps 2 and 3 (the same thread can't observe the difference). After reordering:

```
1. Allocate → addr
3. db = addr        ← reference now visible
2. Run constructor  ← still happening!
```

Another thread on the fast path sees `db != null`, skips the lock, and returns a **half-constructed object** with default-value fields. The result is random NPEs that are nearly impossible to reproduce in tests (the reordering is rare on x86) and that blow up in production.

**The fix is one keyword:**

```java
private static volatile Database db;
```

`volatile` does two things here:

- **Forbids the reordering** — the volatile write is a release barrier; everything before it (the constructor) must commit first.
- **Makes the read see the latest value** — fast-path readers don't see a stale cached `null`.

This is the _only_ idiom where omitting `volatile` causes a real concurrency bug that's almost impossible to detect in testing.

## Better alternatives to DCL

**Holder idiom** — the JVM-managed lazy singleton:

```java
public class Service {
    private static class Holder {
        static final Database INSTANCE = new Database();
    }
    public static Database getDb() {
        return Holder.INSTANCE;
    }
}
```

Class initialization is lazy (the inner class isn't loaded until `Holder.INSTANCE` is referenced) and thread-safe (the classloader holds an internal lock during initialization). No `volatile`, no `synchronized`, no DCL — and it's _faster_ than DCL, because there's no per-call check at all.

**Enum singleton** — Joshua Bloch's preferred pattern:

```java
public enum Database {
    INSTANCE;
    public void query(String sql) { ... }
}
```

The JVM guarantees enum constants are constructed exactly once, thread-safely, even against reflection and serialization.

**`AtomicReference` + CAS** — for less critical, idempotent lazy initialization:

```java
private static final AtomicReference<Database> ref = new AtomicReference<>();

public static Database getDb() {
    Database d = ref.get();
    if (d == null) {
        Database created = new Database();
        d = ref.compareAndSet(null, created) ? created : ref.get();
    }
    return d;
}
```

It's lock-free, but multiple threads may construct an instance (only one wins the CAS). Use it when the constructor is cheap and idempotent.

## The `final` field publication guarantee

The JMM gives `final` fields a special rule: **after a constructor finishes, any thread that obtains a reference to the object will see correctly initialized values for all `final` fields — without any synchronization.**

```java
class A { final int x; A(int x) { this.x = x; } }
A a = new A(42);
otherThread.use(a);   // GUARANTEED to see x = 42

class B { int x; B(int x) { this.x = x; } }   // non-final
B b = new B(42);
otherThread.use(b);   // MIGHT see x = 0 (default), no HB edge
```

The mechanism is a freeze barrier emitted at the end of the constructor for `final` fields. This is what makes immutable classes (`String`, records, value objects) safe to share across threads with zero locking.

**The "don't leak `this`" caveat:**

```java
class Bad {
    final int x;
    Bad(int x) {
        Registry.register(this);   // ← LEAK before constructor finishes
        this.x = x;                // ← write happens AFTER the leak
    }
}
```

Other threads holding the leaked reference may see `x = 0`. Constructors must finish _before_ publishing `this` anywhere — to a static field, a registry, a started thread, an event bus, or an observer.

## Three-way comparison: volatile / synchronized / Atomic

| Guarantee                        | `volatile`             | `synchronized` | `Atomic*`                            |
| -------------------------------- | ---------------------- | -------------- | ------------------------------------ |
| Visibility                       | ✅                     | ✅             | ✅                                   |
| Single-op atomicity (one field)  | ✅ (single read/write) | ✅             | ✅                                   |
| Multi-step atomicity (one field) | ❌                     | ✅             | ✅ (CAS loop)                        |
| Multi-field consistency          | ❌                     | ✅             | ❌ (needs `AtomicReference<Record>`) |

The qualitative difference: `synchronized` **brackets code, not fields**. That's why it can protect compound invariants where multiple fields must change together.

An example where only `synchronized` works:

```java
synchronized (lock) {
    if (x > 0) {           // check
        y = x;             // act on a different field
        x = 0;             // and another
    }
}
```

Three operations on three fields, atomic as a unit. No combination of `volatile` or `Atomic*` gives you this without a lock or a single `AtomicReference<ImmutableRecord>` swap.

## Gotchas

- **`SimpleDateFormat` as a `static` field is almost always a bug.** The same goes for `Calendar`, `DateFormat`, and `Random`. Replace them with immutable counterparts (`DateTimeFormatter`, `java.time.*`, `ThreadLocalRandom`).
- **`synchronized(this)` exposes your monitor.** External code can grab it and starve your class for an arbitrary time, or trigger surprise deadlocks. Use `private final Object lock`.
- **`static synchronized` methods serialize ALL instances.** The lock is on `MyClass.class` — every instance's calls contend on one global lock. Rarely what you want.
- **DCL without `volatile` is broken.** The constructor's writes can be reordered after the reference is published, so other threads see a half-constructed object. Always include `volatile` — or just use the holder idiom.
- **Don't leak `this` from a constructor.** Don't register it, don't start a thread that uses it, don't pass it to event buses. Other threads may see uninitialized fields. Move publication to a separate `start()` or factory method.
- **`final` doesn't help with mutation through a field.** A `final List<X> list` reference can't be reassigned, but `list.add(...)` is still racy. Wrap it in `Collections.unmodifiableList` for true immutability, or use `ConcurrentHashMap` etc. for safe mutation.
- **String interning makes `synchronized("lock")` extremely dangerous.** `"lock"` is interned globally — any code anywhere doing `synchronized("lock")` shares the same monitor with you. Always synchronize on a private `new Object()`.
- **`synchronized` blocks holding I/O are contention bombs.** Holding a lock across DB, HTTP, or file I/O serializes a fast operation behind a slow one. Move the I/O outside the lock; lock only the state mutation.
- **Inheritance + `synchronized`** — a subclass's `synchronized` methods share the parent's monitor (`this`). With private locks per class, parent and subclass have independent locks.

## Code review checklist

- [ ] `static SimpleDateFormat` / `static Calendar` / `static DateFormat` field → **bug**
- [ ] `synchronized(this)` on a public class → suggest a private lock
- [ ] DCL singleton missing `volatile` on the field → **bug**
- [ ] DCL singleton at all → suggest the holder idiom or an enum
- [ ] `synchronized` block holding DB/HTTP/file I/O → contention bomb
- [ ] Constructor that calls `Registry.register(this)` or starts threads → publication race
- [ ] `static synchronized` method on a high-throughput call path → global bottleneck
- [ ] Public field `Object lock` instead of `private final` → encapsulation broken

## References

- Previous in this topic: [Java memory model: visibility, atomicity, and why JIT optimizes per-method](/posts/java-memory-model-visibility-and-atomicity/)
- Brian Goetz, _Java Concurrency in Practice_ — chapters 2–3 and 16.
- [JLS §17.4 — Memory Model](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.4)
- [JLS §17.5 — `final` Field Semantics](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.5)
- Joshua Bloch, _Effective Java_ — Item 78 (synchronize access to shared mutable data) and Item 3 (enum singleton).
