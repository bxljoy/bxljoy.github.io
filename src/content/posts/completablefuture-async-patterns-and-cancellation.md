---
title: "CompletableFuture, async patterns, and the cancellation problem"
description: "The CompletableFuture mental model, creating and composing futures, fan-out with allOf, why cancel(true) and orTimeout don't stop the underlying work, three real cancellation paths including StructuredTaskScope, and how virtual threads simplify async Java."
pubDatetime: 2026-10-01T10:09:00+02:00
tags:
  [
    java,
    concurrency,
    completablefuture,
    async,
    virtual-threads,
    structured-concurrency,
  ]
sourceNotes: [completablefuture-async-patterns-and-cancellation]
---

> A `CompletableFuture<T>` is a "box" that will eventually hold a value of `T`. Create one with `runAsync` / `supplyAsync` (always pass your own executor — the default ForkJoinPool is wrong for I/O), compose with `thenApply` / `thenCompose`, and fan out and wait with `allOf`. **The killer gotcha:** `orTimeout` only fails the wrapper future — it does **not** cancel the underlying tasks. Threads keep running, `executor.close()` blocks waiting for them anyway, and the next scheduled run gets delayed. `CompletableFuture` was never designed for cancellation. The modern fix in Java 21+ is **`StructuredTaskScope` with `withTimeout`**, which actually interrupts unfinished forks. With virtual threads, blocking is cheap again — most of the time you don't need CF; a plain `executor.submit()` + `Future.get()` is simpler.

## Table of contents

## Overview

`CompletableFuture` (CF) is Java's main async building block, used to fan out work, wait for batches, and pipeline async operations. It looks simple, but it has subtle behaviors that bite people: where the work actually runs, what happens when you ignore the executor, and especially what `orTimeout` and `cancel` actually do (almost nothing useful). This post covers the mental model, the API surface that matters, the cancellation problem and the structured-concurrency fix, and how virtual threads simplify the whole picture. The examples are built around an outbox dispatcher, with HTTP timeouts and resilience layers (circuit breakers, retries, bulkheads) around the async calls.

## Key points

- **A `CompletableFuture<T>` is a box that will eventually hold a value of `T`.** It has three states: pending, completed-with-value, and completed-with-exception.
- **`runAsync(Runnable)` returns `CF<Void>`; `supplyAsync(Supplier<T>)` returns `CF<T>`.** The same difference as `Runnable` vs. `Callable` — a value or no value.
- **Always pass your own executor.** Without one, work runs on the JVM's common ForkJoinPool — small, shared, and designed for CPU work. It's disastrous for I/O. Always write `supplyAsync(() -> ..., myExecutor)`.
- **`join()` blocks until the future completes** (and throws an unchecked `CompletionException` on failure). `get()` is the same, but throws checked exceptions. Use `join()` in modern code.
- **`allOf(futures...)` waits for all to complete; `anyOf(...)` for the first.** `allOf` returns `CF<Void>` — to collect the results, you map back over the original list afterwards.
- **Composition: `thenApply` (sync transform), `thenCompose` (chain another async op), `thenCombine` (merge two CFs).** Pipeline-style code without blocking.
- **The cancellation gotcha:** `CompletableFuture.cancel(true)` does **not** interrupt the running task — it only marks the future as cancelled. The underlying work keeps running. `CompletableFuture` was never designed for cancellation.
- **`orTimeout(d, unit)` only fails the wrapper future.** It doesn't cancel the underlying tasks. The 500 virtual threads keep running; `executor.close()` then blocks waiting for them anyway. The timeout often saves nothing.
- **Real cancellation paths:** drop to `Future.cancel(true)` from `executor.submit()` (interrupts the thread; works for I/O code that respects interrupts), or use `StructuredTaskScope` (Java 21+).
- **`StructuredTaskScope.withTimeout(...)` (a preview API since Java 21, still in preview as of Java 25) is the modern fix.** When the scope's deadline hits, all unfinished forks are automatically interrupted. This is the future of structured async in Java.
- **With virtual threads, you often don't need `CompletableFuture` at all.** A plain `executor.submit()` + `Future.get()` is simpler. CF earned its keep when blocking was expensive (pre-Loom); now it's mostly for composition (`thenCompose`, `allOf`).
- **Don't call `join()` inside a stream pipeline** — it serializes the futures one by one. Build the list of futures first (parallel kickoff), then call `allOf().join()` once at the end.
- **Errors propagate via `CompletionException`**, wrapping the original exception. `exceptionally(fn)` recovers; `handle(biFn)` gets both success and failure.
- **The "common pool" trap:** `CF.runAsync(task)` without an executor argument uses the common ForkJoinPool, sized to `Runtime.availableProcessors() - 1`. On a 4-core machine that's 3 threads — your 500 async HTTP calls are processed 3 at a time.

## The mental model — the box

A `CompletableFuture<T>` is a box that will eventually contain a value of type `T`. Right now it might be empty. Later, someone fills it in.

```
Time:    t=0           t=1s          t=2s
         ┌─────┐       ┌─────┐       ┌──────────┐
         │  ?  │  →    │  ?  │  →    │ "result" │
         └─────┘       └─────┘       └──────────┘
        (pending)    (pending)      (completed)
```

Three states:

- **Pending** — work in progress
- **Completed (success)** — has a value
- **Completed (failure)** — has an exception

The key insight: while the box is pending, **the calling thread is free to do other things**. You can hand it 500 boxes, then come back later and ask "are you all done yet?"

## Creating a CompletableFuture

There are three common ways.

**A. You already have a value:**

```java
CompletableFuture<String> done = CompletableFuture.completedFuture("hello");
```

**B. Run something async that returns a value:**

```java
CompletableFuture<String> future = CompletableFuture.supplyAsync(
    () -> slowApiCall(),
    executor                       // ← always pass an executor
);
```

**C. Run something async that returns nothing:**

```java
CompletableFuture<Void> future = CompletableFuture.runAsync(
    () -> sendEmail(),
    executor
);
```

`supplyAsync` is for "give me a value back"; `runAsync` is for "do this work, no value needed". That's the only difference.

### The "common pool" trap — always pass your executor

If you don't pass an executor, the work runs on the **common ForkJoinPool**:

```java
// ❌ Don't do this for I/O work
CompletableFuture.supplyAsync(() -> httpClient.get(...));

// ✅ Always pass your own executor
CompletableFuture.supplyAsync(() -> httpClient.get(...), executor);
```

The common pool is:

- Shared across the whole JVM
- Sized to `Runtime.availableProcessors() - 1` (small)
- Designed for CPU-bound divide-and-conquer (the `parallelStream` use case)
- **Disastrous for blocking I/O** — a few slow HTTP calls saturate the whole pool

On a 4-core machine, the common pool has 3 threads. 500 `runAsync` calls without an executor → 3 at a time → the rest queue. A silent throughput killer.

## Getting the result

```java
String result = future.join();    // blocks until completed; throws CompletionException
String result = future.get();     // same, but with checked exceptions
```

Both block. Use `join()` in modern code — `CompletionException` is unchecked, so it doesn't force ugly try/catch blocks.

If the future failed, `join()` throws a `CompletionException` wrapping the original exception. To unwrap it:

```java
try {
    return future.join();
} catch (CompletionException ce) {
    Throwable cause = ce.getCause();
    if (cause instanceof IOException ioe) throw ioe;
    throw ce;
}
```

## A complete tiny example

```java
ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

System.out.println("Submitting at t=0");
CompletableFuture<String> future = CompletableFuture.supplyAsync(() -> {
    Thread.sleep(2000);
    return "done";
}, executor);

System.out.println("Doing other things at t=0");   // prints IMMEDIATELY

String result = future.join();                      // blocks until t=2s
System.out.println("Got: " + result + " at t=2s");
```

"Doing other things" prints **immediately** — the calling thread didn't wait. `join()` is where it finally waits.

## Fan-out: `allOf`

The pattern for batch work — submit N independent tasks, then wait for all of them:

```java
List<CompletableFuture<Void>> futures = events.stream()
    .map(e -> CompletableFuture.runAsync(() -> processEvent(e), executor))
    .toList();
// At this point all N tasks are running in parallel.

CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
// Blocks until all N complete.
```

Total wall-clock time ≈ the time of the **slowest** task, not the sum.

To collect results from `CF<T>`:

```java
List<CompletableFuture<Order>> futures = ...;

List<Order> results = futures.stream()
    .map(CompletableFuture::join)   // safe AFTER allOf has completed
    .toList();
```

Or:

```java
CompletableFuture<List<Order>> combined = CompletableFuture
    .allOf(futures.toArray(new CompletableFuture[0]))
    .thenApply(v -> futures.stream().map(CompletableFuture::join).toList());
```

### Don't `join()` inside a stream

```java
// ❌ Serializes the work — defeats the parallelism
events.stream()
    .map(e -> CompletableFuture.supplyAsync(() -> processEvent(e), executor).join())
    .toList();

// ✅ Build futures, then wait once
List<CompletableFuture<Result>> futures = events.stream()
    .map(e -> CompletableFuture.supplyAsync(() -> processEvent(e), executor))
    .toList();
CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
List<Result> results = futures.stream().map(CompletableFuture::join).toList();
```

The first version blocks on each future inside `.map()` — every call runs sequentially. The second kicks all of them off, then blocks once.

## Composition (briefly)

| Method                          | What it does                                                         |
| ------------------------------- | -------------------------------------------------------------------- |
| `thenApply(fn)`                 | "When this completes, transform it with `fn`" — returns a new future |
| `thenCompose(fn)`               | "When this completes, run another async op" — for chaining           |
| `thenCombine(other, biFn)`      | "When both complete, combine them"                                   |
| `exceptionally(fn)`             | "If this fails, recover with `fn`"                                   |
| `handle(biFn)`                  | "Handle success or failure with one function"                        |
| `orTimeout(d, unit)`            | "Fail with `TimeoutException` if not done within `d`"                |
| `completeOnTimeout(v, d, unit)` | "Use the default value `v` if not done within `d`"                   |

A pipeline example:

```java
CompletableFuture<String> pipeline = CompletableFuture
    .supplyAsync(() -> fetchUserId(), executor)        // CF<String>
    .thenApply(id -> "user:" + id)                     // String → String
    .thenCompose(key -> redisGetAsync(key))            // String → CF<UserData>
    .thenApply(user -> user.email())                   // UserData → String
    .exceptionally(ex -> "unknown@example.com");       // recover from failures
```

The whole pipeline is non-blocking until you call `join()` at the end.

## The cancellation problem — the real gotcha

This is the part most people miss.

### What `cancel(true)` actually does on a `CompletableFuture`

```java
CompletableFuture<String> cf = CompletableFuture.supplyAsync(() -> {
    Thread.sleep(60_000);   // long-running
    return "done";
}, executor);

cf.cancel(true);   // ???
```

`CompletableFuture.cancel(true)` **does not interrupt the running task**. It only marks the future as cancelled (so `join()` throws `CancellationException`). The underlying work keeps running to completion, holding its thread the whole time.

This is a fundamental limitation, not a bug. `CompletableFuture` doesn't track the executor's `Future<?>` — there's no channel to send a cancellation signal back to the running task. The CF abstraction is **forward-only**: completion flows from the task to the future, not the other way.

### What `orTimeout` actually does

```java
all.orTimeout(30, TimeUnit.SECONDS).join();
```

`orTimeout` schedules a JVM timer. After 30 seconds:

- If `all` has already completed → no-op
- If it's still pending → it completes `all` with a `TimeoutException`

But "completing the wrapper future with `TimeoutException`" doesn't reach into the executor and stop the work. **The 500 underlying threads have no idea this happened.** They keep running, calling APIs, and marking events as processed in the database — completely unaware that the caller has given up.

### The cascade at t=30s

Suppose 350 of 500 events are done at t=30s:

```
t=29.9s   350 done. 150 still in-flight.
t=30.0s   orTimeout's timer fires.
          → all completes with TimeoutException
          → join() unblocks, throws CompletionException
          → dispatch() exits via exception path
          → BUT: 150 virtual threads are still running!

t=30.0s   try-with-resources exits because of exception
          → executor.close() is called
          → close() on virtual-thread executor WAITS for submitted tasks
          → close() now blocks waiting for the 150 tasks

t=??s     Tasks finish (or hang on stuck downstream)
          → close() unblocks → dispatch() returns
          → next @Scheduled run blocked behind close()
```

**The timeout doesn't free you from waiting — it just changes the exception you get.** Worse, the next scheduled run is delayed: cascading delays, without anyone realizing it.

This is the most common bug in `orTimeout`-based code.

## Real cancellation — three paths

### Path A: Don't try to cancel — bound each call instead

For HTTP work, the right answer is usually: don't add a fake batch deadline. Bound each individual call with HTTP read timeouts + a Resilience4j `TimeLimiter`. The batch is then mathematically bounded by `(events / concurrency) × max-per-call`.

```java
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<CompletableFuture<Void>> futures = events.stream()
        .map(e -> CompletableFuture.runAsync(() -> processEvent(e), executor))
        .toList();
    CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
}
// No batch-level orTimeout. Bounds come from HTTP layer.
```

For an outbox dispatcher, this is usually correct.

### Path B: Drop to `Future.cancel(true)` for real interrupts

If you genuinely need a batch deadline that takes effect:

```java
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<?>> futures = events.stream()
        .map(e -> executor.submit(() -> processEvent(e)))
        .toList();

    long deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos();

    for (Future<?> f : futures) {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) {
            f.cancel(true);   // ◄── interrupts the running thread
            continue;
        }
        try {
            f.get(remaining, TimeUnit.NANOSECONDS);
        } catch (TimeoutException e) {
            f.cancel(true);
        }
    }
}
```

`cancel(true)` on a `Future` (returned by `executor.submit()`) sends an **interrupt** to the running thread. Whether that stops the work depends on whether the code respects interrupts:

- ✅ An HTTP read on the JDK `HttpClient` — yes, it throws `InterruptedException`
- ✅ JDBC waits, `Thread.sleep`, `Object.wait` — yes
- ❌ Tight CPU loops with no I/O — no, they run to completion
- ❌ Some libraries swallow `InterruptedException` — no

For HTTP-heavy code, `cancel(true)` does work, and the threads will unwind.

### Path C: `StructuredTaskScope` (preview since Java 21, still preview in Java 25)

The modern, clean answer:

```java
try (var scope = StructuredTaskScope.open(
        StructuredTaskScope.Joiner.awaitAll(),
        cfg -> cfg.withTimeout(Duration.ofSeconds(30)))) {

    for (OutboxEvent e : events) {
        scope.fork(() -> {
            processEvent(e);
            return null;
        });
    }
    scope.join();   // returns when all done OR at deadline (whichever first)
                    // → automatically cancels (interrupts) any unfinished forks
}
```

When the scope's deadline hits, or you exit the try block, **all unfinished forks are automatically cancelled** via interrupt. It's designed for exactly this scenario — **the future of structured async in Java.**

Other features:

- `Joiner.anySuccessfulResultOrThrow()` — fail fast on the first error, or take the first success
- `Joiner.allSuccessfulOrThrow()` — collect all results, failing on the first error
- Forks share a hierarchical lifecycle with the parent — no orphan tasks

## Handling failures

```java
CompletableFuture<String> cf = CompletableFuture.supplyAsync(() -> riskyCall(), executor)
    .exceptionally(ex -> {
        log.warn("Failed: {}", ex.getMessage());
        return "fallback";
    });
```

Or handle both success and failure in one place:

```java
.handle((value, ex) -> {
    if (ex != null) return "fallback";
    return value.toUpperCase();
});
```

For batches, failures in `allOf` propagate as `CompletionException`. Decide between:

- **Fail fast** — let the first failure propagate, and abandon the rest
- **Per-task error handling** — wrap each task's body in a try/catch so one failure doesn't sink the batch (this is what an outbox dispatcher should do — mark the bad event as failed and continue)

```java
private void processEvent(OutboxEvent e) {
    try {
        chargeStripe(e);
        sendNotification(e);
        outbox.markProcessed(e.id());
    } catch (Exception ex) {
        outbox.markFailed(e.id(), ex.getMessage());
        // Doesn't propagate; the batch keeps going.
    }
}
```

## Virtual threads simplify a lot of this

Pre-Loom, blocking a thread was expensive (a ~1MB stack, an OS thread). `CompletableFuture` was the way to express "do many I/O calls without burning many OS threads" — chain async operations with `thenCompose`, and never block.

Post-Loom (Java 21+), virtual threads are cheap (a few hundred bytes, JVM-managed). Blocking is fine again. Most of the time you don't need `CompletableFuture`'s composition — a plain `executor.submit()` + `Future.get()` is simpler:

```java
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<?>> futures = events.stream()
        .map(e -> executor.submit(() -> processEvent(e)))
        .toList();
    for (Future<?> f : futures) f.get();   // simple, blocking, fine
}
```

When CF still earns its keep:

- **`allOf` / `anyOf`** — the convenience of one-shot batch waits, with `orTimeout` etc.
- **`thenCompose` chains** — when an async result feeds into another async call
- **Combining heterogeneous results** — `thenCombine` to merge two different futures
- **APIs that already return a `CF`** (`HttpClient.sendAsync`, etc.) — work with what you've got

For "fire 500 tasks and wait" with virtual threads, **a plain `Future` is honestly cleaner.** Use CF when you need its composition power.

## The complete outbox dispatcher example

Pulling it all together with the corrected patterns:

```java
@Service
public class OutboxDispatcher {

    private final OutboxClaimer claimer;            // own bean, short claim TX
    private final OutboxUpdater updater;            // own bean, per-event short TX
    private final RestClient stripeClient;
    private final RestClient notificationClient;

    @Scheduled(fixedDelay = 5_000)                  // ◄── NO @Transactional
    public void dispatch() {
        List<OutboxEvent> events = claimer.claimPending(500);
        if (events.isEmpty()) return;

        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<CompletableFuture<Void>> futures = events.stream()
                .map(e -> CompletableFuture.runAsync(() -> processEvent(e), executor))
                .toList();
            CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
        }
    }

    private void processEvent(OutboxEvent e) {
        try {
            chargeStripe(e);                        // HTTP, between TXes
            sendNotification(e);                    // HTTP, between TXes
            updater.markProcessed(e.id());          // short TX inside
        } catch (Exception ex) {
            updater.markFailed(e.id(), ex.getMessage());   // short TX
            log.error("Event {} failed", e.id(), ex);
        }
    }

    @Bulkhead(name = "stripe", type = Bulkhead.Type.SEMAPHORE)
    @CircuitBreaker(name = "stripe", fallbackMethod = "stripeFallback")
    @Retry(name = "stripe")
    private void chargeStripe(OutboxEvent e) {
        stripeClient.post().uri("/charges")
            .header("Idempotency-Key", e.id().toString())
            .body(e.payload())
            .retrieve()
            .toBodilessEntity();
    }

    @Bulkhead(name = "notification", type = Bulkhead.Type.SEMAPHORE)
    @CircuitBreaker(name = "notification", fallbackMethod = "notificationFallback")
    private void sendNotification(OutboxEvent e) {
        notificationClient.post().uri("/notify")
            .body(e.payload())
            .retrieve()
            .toBodilessEntity();
    }
}
```

Notice:

- **No `@Transactional` on `dispatch()`.** Spring's `@Transactional` is thread-bound — it doesn't extend to async tasks on virtual threads anyway. Putting it here would only hold a DB connection for the full 30+ second batch without protecting any of the async work. See [outbox publishers and parallel dispatch](/posts/outbox-publishers-and-parallel-dispatch/) for the full three-TX explanation.
- **Three separate transaction scopes:** (1) a short claim TX in `OutboxClaimer.claimPending`, (2) NO TX during the async batch, (3) a short per-event TX in `OutboxUpdater.markProcessed/markFailed`. HTTP calls happen _between_ transactions, never inside them.
- **`OutboxClaimer` and `OutboxUpdater` are separate `@Service` beans**, so Spring's proxy fires when `dispatch()` / `processEvent()` invokes them. Self-invocation (calling a `@Transactional` method from another method of the same class) bypasses the proxy and silently disables the transaction.
- **No `orTimeout` on the batch.** Each call is bounded by the HTTP read timeout + Resilience4j retries; the batch is bounded by `(events / concurrency) × max-per-call`.
- **A per-event try/catch** in `processEvent`. One bad event doesn't kill the batch.
- **The bulkhead caps actual concurrency** per downstream (50). Pool sizing is irrelevant with HTTP/2.
- **An Idempotency-Key on Stripe** — retries can't double-charge.
- **`@CircuitBreaker` with a fallback** — an outage doesn't cascade into the dispatcher itself.

## Gotchas

- **`CompletableFuture.cancel(true)` does NOT interrupt the running task.** It only marks the future cancelled; the thread keeps running. CF was never designed for cancellation.
- **`orTimeout` only fails the wrapper future.** The underlying tasks continue, and `executor.close()` then blocks waiting for them anyway. Often the timeout saves nothing.
- **Forgetting to pass an executor** → the work runs on the common ForkJoinPool (~3 threads on a 4-core machine). 500 async I/O tasks → 3 at a time. A silent throughput disaster.
- **Calling `join()` inside a stream `.map()`** serializes the work. Build the list of futures first, then call `allOf().join()` once.
- **Errors are wrapped in `CompletionException`** — use `getCause()` to unwrap, or `handle((v, ex) -> ...)` to deal with them in place.
- **`allOf` returns `CF<Void>`** — to collect results, map back over the original future list with `.join()` (safe after `allOf` has completed).
- **`thenApply` runs synchronously** on the thread that completed the previous stage. Heavy work in `thenApply` can block your I/O threads. Use `thenApplyAsync(fn, executor)` for heavy CPU work.
- **`CompletableFuture` exceptions don't print stack traces unless you handle them.** A failed CF that nobody calls `join()` on is silently lost. Always `handle` or `exceptionally` the terminal stage.
- **Mixing CF and reactive code** creates blocking-in-reactive bugs. Pick one async model per call chain.
- **`get()` throws the checked `ExecutionException` and `InterruptedException`** — most modern code uses `join()` instead.
- **Try-with-resources on the `executor` waits for tasks to finish.** If you want to abandon a batch, use `executor.shutdownNow()` (which sends interrupts) instead of relying on `close()`.
- **`@Scheduled(fixedDelay)` waits for the previous run to fully return** before scheduling the next. If `dispatch()` blocks for 60s on the executor close, the next run is delayed by 60s.
- **`StructuredTaskScope` is a preview API** (since Java 21, and still in preview as of Java 25). Use it with the `--enable-preview` flag. The shape of the API may shift slightly between versions.
- **`Future.cancel(true)` returns a `boolean`** — only meaningful if you check it. It returns false if the task has already completed or was already cancelled.
- **`@Transactional` does NOT extend to `CompletableFuture` tasks.** Spring's transaction context is thread-bound (it uses [`ThreadLocal`](/posts/threadlocal-mechanics-and-cleanup/)); when `runAsync(..., executor)` submits work to a virtual thread, that thread starts with empty `ThreadLocal` state and sees no transaction. Putting `@Transactional` on a method that fans out async work only wraps the synchronous prelude (the fetch, the kickoff) — the actual async tasks run outside it. Use separate `@Transactional` methods on injected beans for the work the async tasks need to do transactionally. See [outbox publishers and parallel dispatch](/posts/outbox-publishers-and-parallel-dispatch/) for the canonical example.

## Decision tree — async patterns in Java 21+

```
Need to run multiple things in parallel?
│
├─ Independent tasks, just want them all done?
│   │
│   ├─ Simple "do N things, wait for all"
│   │       → executor.submit() + Future.get() loop  (simplest)
│   │       → CompletableFuture.allOf(...).join()    (idiomatic)
│   │
│   ├─ Need a batch deadline that actually cancels?
│   │       → StructuredTaskScope with withTimeout    (Java 21+)
│   │       → Or Future.cancel(true) loop             (older Java)
│   │
│   └─ Need to fail fast on first error?
│           → StructuredTaskScope.Joiner.anySuccessfulResultOrThrow
│           → Or first-failed CF detection (verbose)
│
├─ Pipeline: result of A feeds into B feeds into C?
│       → CompletableFuture.thenCompose / thenApply chain
│
├─ Combine two heterogeneous results?
│       → CompletableFuture.thenCombine
│
└─ Just one thing that takes a while?
        → executor.submit + Future.get          (simplest)
        → @Async method (Spring)                (declarative)
```

## References

- [The outbox pattern and the dual-write problem](/posts/outbox-pattern-and-dual-write-problem/) · [Outbox publishers and parallel dispatch](/posts/outbox-publishers-and-parallel-dispatch/) — the dispatcher pattern; idempotency on retries.
- [JEP 444: Virtual Threads](https://openjdk.org/jeps/444)
- [JEP 453: Structured Concurrency (Preview)](https://openjdk.org/jeps/453)
- [`CompletableFuture` Javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CompletableFuture.html)
- Stuart Marks on cancellation in CF — discussions on the OpenJDK mailing lists (multiple threads over the years).
- [Heinz Kabutz on `CompletableFuture` traps](https://www.javaspecialists.eu/archive/Issue263-CompletableFuture-Misuse.html)
- Next in this topic: [Structured concurrency and StructuredTaskScope](/posts/structured-concurrency-and-task-scope/)
