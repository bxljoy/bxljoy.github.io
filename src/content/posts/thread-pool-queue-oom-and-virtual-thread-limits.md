---
title: "Thread pool queue OOM and virtual-thread concurrency limits"
description: "Why newFixedThreadPool's unbounded queue grows until heap OOM, the memory math behind it, bounded queues and CallerRunsPolicy as back-pressure, graceful shutdown, and why virtual threads still need an explicit concurrency limit."
pubDatetime: 2026-10-01T11:12:00+02:00
tags: [java, concurrency, virtual-threads, memory]
sourceNotes: [thread-pool-queue-oom-and-virtual-thread-concurrency-limits]
---

> `FixedThreadPool` ships with an unbounded `LinkedBlockingQueue`; under load, the queue grows until heap OOM. Virtual threads remove the _thread-stack_ memory ceiling, but do **not** remove the _task-payload_ memory ceiling — you need an explicit semaphore or queue cap regardless of the threading model.

## Table of contents

## Overview

It's well known that `Executors.newFixedThreadPool` is dangerous, but it's less often explained _why_, precisely — and it's easy to assume virtual threads make the problem go away. This post nails down (a) the exact mechanics of how the unbounded queue fills and what dies first, (b) the memory math that decides between heap OOM and native OOM, and (c) the mental shift required after Loom: pool size used to conflate _worker count_ and _concurrency limit_, and with virtual threads you have to separate them with an explicit limiter.

## Key points

- `Executors.newFixedThreadPool(N)` uses a `LinkedBlockingQueue` with **`Integer.MAX_VALUE` capacity** — practically unbounded. The convenience factory hides this footgun.
- `submit()` on this pool **always returns immediately** — no backpressure, no rejection, no blocking of the caller. The producer has no signal that the system is overloaded until the OOM.
- Task payload (captured fields, buffers) lives on the **heap**, in the queued `Runnable`s. Queue depth × payload size = heap consumed. With 1 MB payloads, 10k waiting tasks = ~10 GB of heap pressure.
- Producer/consumer math: if `arrival_rate > 200 / avg_task_duration`, the queue depth grows linearly forever. There is no equilibrium.
- Virtual threads solve **thread-stack OOM** (no more 1 MB native stack per thread). They do **not** solve **task-payload OOM** — payload memory is independent of who runs it.
- The pre-Loom mental model: pool size = worker count = concurrency limit (the same number). Post-Loom, workers are free, so you need a **separate, explicit limiter** — a `Semaphore`, a bounded queue, a rate limiter, or an upstream cap (Kafka `max.poll.records`, an HTTP connection pool, etc.).
- "The threading model controls scheduling cost; bounded concurrency controls memory cost." Two different knobs, and both are required.

## What `Executors.newFixedThreadPool(200)` actually creates

```java
public static ExecutorService newFixedThreadPool(int nThreads) {
    return new ThreadPoolExecutor(
        nThreads, nThreads,             // core = max = 200
        0L, TimeUnit.MILLISECONDS,
        new LinkedBlockingQueue<Runnable>()   // ⚠️ unbounded (Integer.MAX_VALUE)
    );
}
```

The no-arg `LinkedBlockingQueue()` constructor defaults to `Integer.MAX_VALUE` (~2.1 billion). This is the single most consequential line in the JDK's convenience factories.

## The `ThreadPoolExecutor.execute()` decision flow

```
1. workers < corePoolSize?  → addWorker(task)              // first 200 start threads
2. queue.offer(task)?        → enqueued                    // 201..N go here
3. workers < maxPoolSize?    → addWorker(task)             // never reached (core=max=200)
4. else                      → RejectedExecutionHandler    // never reached (queue unbounded)
```

Because core = max = 200, branch (3) is dead. Because the queue is unbounded, branch (4) is dead. Every task either runs immediately or queues — **rejection is unreachable**.

## Memory math for 10k tasks × 1 MB payload

| Region                                        | Cost                   | Notes                                        |
| --------------------------------------------- | ---------------------- | -------------------------------------------- |
| 200 native thread stacks (off-heap)           | ~200 MB                | Default `-Xss1m`; outside `-Xmx`             |
| 200 running task objects retained on the heap | ~200 MB                | Held by running stack frames                 |
| 9,800 queued task objects                     | **~9.8 GB**            | Each `Runnable` retains its captured payload |
| `LinkedBlockingQueue` node overhead           | ~48 B × 9,800 ≈ 470 KB | Negligible                                   |

With `-Xmx4g`, the heap fills long before the queue drains. The expected failure: `java.lang.OutOfMemoryError: Java heap space`, or, earlier, `GC overhead limit exceeded` (G1 spending >98% of CPU in GC while reclaiming <2% of the heap).

If the task objects were tiny but the thread count huge, you'd hit a **native** OOM (`unable to create new native thread`) instead. In this scenario, the heap is the binding constraint.

## Why the queue grows without bound

`LinkedBlockingQueue` uses two separate `ReentrantLock`s (`putLock`, `takeLock`) — producers and consumers never contend with each other, so there's no implicit slowdown from contention. If consumer throughput is `C = 200 / avg_task_duration` tasks/sec and the arrival rate is `P > C`, the queue grows at `(P − C)` tasks/sec until the heap dies.

## The right fixes for platform-thread pools

```java
new ThreadPoolExecutor(
    200, 200, 0L, TimeUnit.MILLISECONDS,
    new LinkedBlockingQueue<>(1000),                  // bounded
    new ThreadPoolExecutor.CallerRunsPolicy()         // natural backpressure
);
```

`CallerRunsPolicy` runs the rejected task on the **submitting thread**, which blocks the producer until it finishes — backpressure without explicit coordination. The other policies: `AbortPolicy` (the default; it throws), `DiscardPolicy` (silent drop), `DiscardOldestPolicy` (drops the head of the queue). For paid work, prefer `CallerRunsPolicy` or `AbortPolicy`; for low-value telemetry, `DiscardOldestPolicy` is reasonable.

Operationally: export the queue depth as a Micrometer gauge (`executor.queued`) and alert before saturation.

## Where virtual threads change the picture — and where they don't

```java
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (var task : tenThousandTasks) executor.submit(task);
}
```

What changes:

- **No pool, no task queue.** Every submit spawns a virtual thread immediately.
- Each VT carries a heap-allocated `StackChunk` (a few KB shallow, growing on demand) — not a 1 MB native stack.
- 10k VTs ≈ tens of MB of stack-chunk overhead. Negligible next to the payload.

What does **not** change:

- The 1 MB payload still lives on the heap in each task. 10k × 1 MB = 10 GB of heap pressure, whether you run them on 200 platform threads, 10k VTs, or 10k goroutines.
- **Heap pressure is independent of the threading model.**

## The mental-model shift

Pre-Loom:

> "Threads are expensive → use a pool → the pool size IS my concurrency limit."

Pool size silently conflated _worker count_ and _in-flight work count_. They had to be the same number because you couldn't afford to spawn more workers.

Post-Loom:

> "Threads are cheap → I need a SEPARATE concurrency limit for in-flight work."

```java
ExecutorService exec = Executors.newVirtualThreadPerTaskExecutor();
Semaphore inFlightLimit = new Semaphore(200);    // <-- the real cap

for (var task : tasks) {
    inFlightLimit.acquire();
    exec.submit(() -> {
        try { task.run(); } finally { inFlightLimit.release(); }
    });
}
```

The semaphore (or a bounded upstream queue, or a rate limiter) is what actually protects the heap. The executor only decides _how_ the work runs. Pulling these apart is the design change Loom forces on you.

## `CallerRunsPolicy` as a back-pressure pattern (not just a rejection handler)

`CallerRunsPolicy` is usually introduced as "what to do when the queue is full", but its real value is **propagating back-pressure upstream without dropping work**. When the queue is full, the _submitting_ thread (the caller — usually the producer of the work) is conscripted to run the task itself:

```
Kafka consumer thread → pool.submit(task)
                           ↓ (queue full)
                     CallerRunsPolicy fires
                           ↓
                     Kafka consumer thread runs task synchronously
                           ↓
                     Consumer thread busy → can't call poll() again
                           ↓
                     Kafka stops delivering records → broker buffers
                           ↓
                     Back-pressure now visible at the source ✓
```

Comparing the four policies on the back-pressure question:

| Policy                  | What happens when the queue is full        | Effect upstream                                                                   |
| ----------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| `AbortPolicy` (default) | Throws `RejectedExecutionException`        | The caller must catch it and decide — easy to handle wrong                        |
| `DiscardPolicy`         | Silently drops the task                    | **Silent data loss** — no upstream signal                                         |
| `DiscardOldestPolicy`   | Drops the queue head, retries the new task | A different data loss; OK for telemetry, never for paid work                      |
| **`CallerRunsPolicy`**  | **The caller thread runs the task itself** | **A natural throttle** — the submission rate auto-aligns with the processing rate |

**Why this is the right default for Kafka consumers / Pub-Sub workers / HTTP webhooks:** every upstream system _already has_ its own buffering and back-pressure mechanism (Kafka broker buffers, Pub/Sub flow control, the HTTP server queue). `CallerRunsPolicy` reaches into those upstream mechanisms by making the source thread "busy", forcing the system to throttle at the right layer. `AbortPolicy` requires you to hand-write the same logic, and it easily devolves into silent drops or thundering retries.

## Graceful shutdown — `shutdown()` vs. `shutdownNow()`

**`shutdown()`** — soft. It stops accepting new submissions; in-flight and queued tasks finish; threads die when the queue drains. It returns immediately and doesn't wait.

**`shutdownNow()`** — hard:

- Sets the pool state to `STOP` — `submit()` now throws `RejectedExecutionException`
- Drains the queue and returns the queued (un-run) tasks as its return value — **they will not run**
- Calls `Thread.interrupt()` on every worker thread

What `shutdownNow()` does **not** guarantee:

- **Running tasks may keep running.** An interrupt is a _cooperative_ signal — Java has no force-kill (`Thread.stop()` was deprecated for good reasons: it leaves locks held and objects in an inconsistent state). A task ignoring the interrupt flag continues until it's done.
- **The task must honor the interrupt.** Either:
  - be in an interruptible blocking call (`Thread.sleep`, `Object.wait`, `lockInterruptibly`, `BlockingQueue.take`, `Future.get`, NIO channel ops) → it throws `InterruptedException`
  - or periodically poll `Thread.currentThread().isInterrupted()` inside CPU loops
- **Some I/O is NOT interruptible.** `InputStream.read()` on a `java.io.Socket` does not throw on interrupt — you must call `socket.close()` to unblock it. NIO channels (`java.nio.channels.*`) throw `ClosedByInterruptException` cleanly; legacy `java.io` does not.

The full graceful-shutdown idiom (use this verbatim):

```java
pool.shutdown();
try {
    if (!pool.awaitTermination(30, TimeUnit.SECONDS)) {
        List<Runnable> dropped = pool.shutdownNow();
        log.warn("Forced shutdown; {} tasks dropped, interrupting workers", dropped.size());
        if (!pool.awaitTermination(10, TimeUnit.SECONDS)) {
            log.error("Pool did not terminate even after interrupt — workers ignoring interrupt flag");
        }
    }
} catch (InterruptedException ie) {
    pool.shutdownNow();
    Thread.currentThread().interrupt();   // restore the flag on the current thread
}
```

**Why the second `awaitTermination` matters in production:** if even `shutdownNow` doesn't terminate the pool within a second timeout, you have a bug — a worker thread that ignores interrupts. Logging this is the only chance to find the offender before SIGKILL ends the JVM at the Fargate / K8s grace-period boundary.

**Spring Boot specifics:** `ThreadPoolTaskExecutor` runs this idiom automatically on `@PreDestroy` via `awaitTerminationSeconds` (set it; the default is 0 = no wait). A raw `ThreadPoolExecutor` you instantiated yourself has no lifecycle hook — you must register a `@PreDestroy` or a JVM shutdown hook yourself. This is why Spring's executor wrappers are usually the right choice over the `Executors.*` factories.

## Decision table

| Threading model                                             | Stack cost         | OOM via stacks? | OOM via payload?                        |
| ----------------------------------------------------------- | ------------------ | --------------- | --------------------------------------- |
| `FixedThreadPool(200)` + unbounded queue                    | ~200 MB native     | No              | **YES — the queue grows forever**       |
| `FixedThreadPool(200)` + bounded queue + `CallerRunsPolicy` | ~200 MB native     | No              | No (backpressure)                       |
| `newVirtualThreadPerTaskExecutor()` (naïve)                 | Tens of MB of heap | No              | **YES if payload × concurrency > heap** |
| Virtual threads + `Semaphore(N)`                            | Tens of MB of heap | No              | No (bounded in-flight)                  |

## Gotchas

- **`Executors.newFixedThreadPool` and `newSingleThreadExecutor` both ship with unbounded queues.** Treat both factory methods as production hazards, and construct a `ThreadPoolExecutor` directly with an explicit capacity.
- **`submit()` has no backpressure on an unbounded queue.** Producers don't slow down and callers don't block — until the heap OOM. Discovery is late and catastrophic.
- **`LinkedBlockingQueue` does not implicitly throttle producers.** Its split `putLock` / `takeLock` design specifically avoids producer/consumer contention. Don't expect contention to act as a soft limiter.
- **VTs do not solve task-payload OOM.** The common "VTs fix concurrency" assumption is wrong. VTs solve thread-stack OOM, which is a _different_ failure mode. Naïvely fanning out 1M VTs with heavy payloads still kills you on the heap.
- **`Executors.newVirtualThreadPerTaskExecutor()` has no concurrency cap.** It will start as many VTs as you ask it to. The lack of a built-in limit is the new footgun that replaces the old "queue grows forever" one.
- **The concurrency limiter must wrap the _work_, not just the _submit_.** Releasing the semaphore in a try/finally inside the task is correct — releasing it before the submit defeats the cap.
- **Heap pressure is independent of the threading model.** That one sentence crystallizes the whole insight.
- **CPU-bound tasks: VTs do not help.** Whether memory or CPU is the binding constraint, the threading model isn't the lever. Match the lever to the constraint.
- **`shutdownNow()` is a polite request, not an order.** Tasks ignoring interrupts will run past it. Always pair it with `awaitTermination` _and_ an error log if termination times out — the log is your only signal that a worker is uninterruptible before SIGKILL ends the JVM.
- **`InputStream.read()` on a legacy `java.io.Socket` does not throw on interrupt.** You have to call `socket.close()` to unblock it. NIO channels throw `ClosedByInterruptException` correctly; plain `java.io` does not.
- **A missing `pool.shutdown()` leaks threads on app stop.** Pools created outside Spring's lifecycle (a raw `new ThreadPoolExecutor`) need a `@PreDestroy` hook, or shutdown will run to the SIGKILL grace period and drop in-flight work. Prefer `ThreadPoolTaskExecutor` with `awaitTerminationSeconds` for a managed lifecycle.

## References

- Earlier in this topic:
  - [Platform threads vs. virtual threads](/posts/platform-vs-virtual-threads-scheduling/) — scheduling cost, mount/unmount, pool queue vs. OS run queue.
  - [CompletableFuture, async patterns, and the cancellation problem](/posts/completablefuture-async-patterns-and-cancellation/)
- JDK source: `java.util.concurrent.Executors#newFixedThreadPool`, `java.util.concurrent.LinkedBlockingQueue`
- [JEP 444 — Virtual Threads (Java 21)](https://openjdk.org/jeps/444)
