---
title: "Structured concurrency and StructuredTaskScope"
description: "How StructuredTaskScope ties task lifetime to lexical scope: the CompletableFuture.allOf problems it fixes, the three standard joiners, custom quorum joiners, cancellation mechanics, ScopedValue propagation, nesting, and when CompletableFuture is still the right tool."
pubDatetime: 2026-10-01T10:56:00+02:00
tags: [java, concurrency, virtual-threads, structured-concurrency, java-21]
sourceNotes: [structured-concurrency-and-task-scope]
---

> Task lifetime follows lexical scope, not heap allocation. `try-with-resources` + `scope.fork(...)` + `scope.join()` gives you fan-out/fan-in with automatic cancellation on first failure, parent-child thread relationships in dumps, and zero leaked tasks — replacing the four manual concerns of `CompletableFuture.allOf`.

## Table of contents

## Overview

`CompletableFuture.allOf` works, but it leaves four problems to the caller: no automatic cancellation when one branch fails, no parent-child lifetime relationship, no thread-dump introspection, and it's easy to leak work by forgetting `join()`. Structured concurrency (the JEP 453 preview → JEP 480/499/505 — still in preview as of Java 25) reframes the problem: child tasks **must** complete before the scope closes, the scope **must** be in a try-with-resources block, and a failure in one task **automatically** signals its siblings. This collapses ~30 lines of defensive `CompletableFuture` plumbing into a 6-line scope block, and makes the lifetime and error semantics legible from the code's shape alone.

This post covers the API shape, the three standard joiners, cancellation propagation, `ScopedValue` interaction, and the rare cases where `CompletableFuture` still beats `StructuredTaskScope`.

## Key points

- **Lexical scope = task lifetime.** All tasks forked inside a `try (var scope = ...)` block complete before the block exits. No orphan goroutines, no "I forgot to `join`" bugs.
- **Auto-cancellation on first failure.** The default `allSuccessfulOrThrow` joiner interrupts all sibling tasks the moment one task throws, releasing downstream connections, DB pool slots, and threads immediately, rather than letting them complete and discarding their results.
- **It replaces `CompletableFuture.allOf` for fan-out/fan-in.** The same use case (kick off N async calls, wait, aggregate), but with the four `CompletableFuture` problems solved.
- **Three standard joiners cover nearly all use cases:** `allSuccessfulOrThrow()`, `anySuccessfulResultOrThrow()`, `awaitAll()`. Custom joiners exist for partial-success or quorum patterns.
- **Tasks are virtual threads under the hood** (or whatever thread factory you configure) — one VT per `fork()`. The scope is essentially a managed VT executor with strict lifetime rules.
- **Parent-child relationships appear in thread dumps** — a critical operational improvement over `CompletableFuture`, where forked work shows up as anonymous `ForkJoinPool` threads with no scope ancestor.
- **`ScopedValue` bindings propagate** from parent to fork automatically. The thread-local-equivalent problem ("how do I pass request context to a forked task?") becomes trivial.
- **`CompletableFuture` is still right** for chained transformations (`thenApply` pipelines), reactive composition, completion callbacks, and async work that genuinely outlives the calling method. Structured concurrency replaces the `allOf` fan-out shape, not the whole API.

## The `CompletableFuture` shape it replaces

```java
// Unstructured — what most existing code looks like
ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();

CompletableFuture<User> user     = CompletableFuture.supplyAsync(() -> userSvc.fetch(id), pool);
CompletableFuture<List<Order>> o = CompletableFuture.supplyAsync(() -> orderSvc.fetch(id), pool);
CompletableFuture<Wallet> wallet = CompletableFuture.supplyAsync(() -> walletSvc.fetch(id), pool);

try {
    CompletableFuture.allOf(user, o, wallet).join();   // waits for all
    return new Profile(user.join(), o.join(), wallet.join());
} catch (CompletionException ce) {
    user.cancel(true);   // manual cancellation — and even this doesn't interrupt the running task
    o.cancel(true);
    wallet.cancel(true);
    throw ce.getCause();
}
```

Four problems are baked into this shape:

1. **No automatic cancellation** — if `userSvc.fetch` throws, `orderSvc` and `walletSvc` keep running until they finish, occupying DB connections and downstream API quota for results that get discarded.
2. **`CompletableFuture.cancel(true)` doesn't actually interrupt** — it marks the future as cancelled, but the underlying task continues to completion. The `true` parameter is misleading (see [the cancellation problem](/posts/completablefuture-async-patterns-and-cancellation/#the-cancellation-problem--the-real-gotcha)).
3. **No lifetime relationship.** The 3 futures have no parent. If the calling method's caller times out or cancels, no signal propagates to the children.
4. **Easy to leak** — forget the `join()` or fail to handle the exception, and the futures keep running in the pool indefinitely.

## The structured equivalent

```java
// Structured — Java 25 preview API (JEP 505)
try (var scope = StructuredTaskScope.open(Joiner.<Object>allSuccessfulOrThrow())) {
    Subtask<User>        userTask    = scope.fork(() -> userSvc.fetch(id));
    Subtask<List<Order>> ordersTask  = scope.fork(() -> orderSvc.fetch(id));
    Subtask<Wallet>      walletTask  = scope.fork(() -> walletSvc.fetch(id));

    scope.join();   // waits + cancels siblings on first failure

    return new Profile(userTask.get(), ordersTask.get(), walletTask.get());
}
// scope auto-closed here. All forked tasks guaranteed to be done.
```

All four problems above are gone:

1. **Auto-cancellation.** The first exception triggers `Thread.interrupt()` on all sibling subtasks, and the scope refuses further forks.
2. **A real interrupt.** Cancellation uses the standard interrupt mechanism — what `Future.cancel(true)` would _intend_, but actually delivered to the worker thread.
3. **Parent-child lifetime.** The forked VTs are children of the calling thread; thread dumps show the relationship, and cancellation from outside propagates in.
4. **No leak possible.** `try-with-resources` guarantees `scope.close()` runs, which guarantees all forked tasks are done (or cancelled).

## The three standard joiners

| Joiner                                | Behavior                                                                                     | Use case                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Joiner.allSuccessfulOrThrow()`       | Wait for all forks. If any throws, cancel the rest + rethrow.                                | Fan-out/fan-in (the common case) — page assembly, parallel enrichment, batch processing |
| `Joiner.anySuccessfulResultOrThrow()` | The first success wins; the others are cancelled. If all fail, it throws the last exception. | Hedged requests, primary + fallback, "fastest replica wins"                             |
| `Joiner.awaitAll()`                   | Wait for all to finish, regardless of outcome. No auto-cancel.                               | When you want partial results — collect successes and failures and decide later         |

Reading the result after `scope.join()`:

```java
// allSuccessfulOrThrow — get() returns the value (or throws if the task itself failed)
return userTask.get();

// awaitAll — must check state explicitly
if (userTask.state() == Subtask.State.SUCCESS) {
    return userTask.get();
} else {
    return defaultUser();
}
```

## Custom joiners for partial success / quorum

```java
// "I want at least 2 of 3 services to respond — fail otherwise"
class QuorumJoiner<T> implements Joiner<T, List<T>> {
    private final int quorum;
    private final List<T> successes = new CopyOnWriteArrayList<>();
    private final AtomicInteger remaining;

    @Override public boolean onComplete(Subtask<? extends T> subtask) {
        if (subtask.state() == Subtask.State.SUCCESS) {
            successes.add(subtask.get());
            if (successes.size() >= quorum) return true;   // signal scope to cancel rest
        }
        return remaining.decrementAndGet() == 0;
    }
    @Override public List<T> result() throws Throwable { ... }
}
```

This is the structured-concurrency equivalent of the "quorum write" pattern in distributed systems — express the lifetime requirement as a `Joiner`, and get the cancellation semantics for free.

## Cancellation mechanics — what actually happens

When any subtask in `allSuccessfulOrThrow` fails:

1. The joiner's `onComplete` returns `true` ("I'm done — cancel the rest").
2. The scope calls `Thread.interrupt()` on every other forked subtask's underlying VT.
3. The interrupted VT either:
   - throws `InterruptedException` from a blocking call → it propagates out of the task body
   - notices `Thread.currentThread().isInterrupted()` and returns early
   - **ignores the interrupt and runs to completion** — Java has no force-kill
4. The scope waits for all subtasks to actually finish before `join()` returns.
5. The original failure's exception is thrown from `scope.join()`.

**The cooperation requirement.** It's the same rule as for `shutdownNow()` — interruption is a signal, not a force. Long CPU loops without `isInterrupted()` checks won't honor cancellation. This matters most for CPU-bound subtasks; I/O-bound ones honor interrupts by default through `InterruptedException`.

## `ScopedValue` propagates through `fork()`

The thread-local-equivalent problem in async code: how do I pass the current `RequestContext` to a forked task without manually threading it through as a parameter everywhere?

```java
final static ScopedValue<RequestContext> CTX = ScopedValue.newInstance();

ScopedValue.where(CTX, requestCtx).run(() -> {
    try (var scope = StructuredTaskScope.open(Joiner.<Object>allSuccessfulOrThrow())) {
        scope.fork(() -> {
            RequestContext c = CTX.get();   // ← visible here, automatically
            return userSvc.fetchWith(c);
        });
        scope.fork(() -> downstreamSvc.callWith(CTX.get()));
        scope.join();
    }
});
// CTX is unbound here — auto-cleared at scope exit
```

This is one of the biggest practical wins. `ThreadLocal` does NOT propagate to forked tasks unless you use `InheritableThreadLocal` (which has its own problems, and doesn't work with `CompletableFuture` async chains). `ScopedValue` is designed for this — it works with structured forks out of the box. (See [ThreadLocal mechanics and cleanup](/posts/threadlocal-mechanics-and-cleanup/) for why `ScopedValue` is its successor.)

## Nesting scopes

Scopes nest naturally. Each scope has its own lifetime, joiner, and cancellation boundary:

```java
try (var outerScope = StructuredTaskScope.open(Joiner.allSuccessfulOrThrow())) {
    outerScope.fork(() -> {
        // Inner scope — independent cancellation boundary
        try (var inner = StructuredTaskScope.open(Joiner.<Object>anySuccessfulResultOrThrow())) {
            inner.fork(() -> primaryDb.query(...));
            inner.fork(() -> replicaDb.query(...));
            inner.join();
            return inner.subtasks().stream()
                       .filter(t -> t.state() == Subtask.State.SUCCESS)
                       .findFirst().get().get();
        }
    });
    outerScope.fork(() -> someOtherWork());
    outerScope.join();
}
```

Cancellation in the outer scope propagates inward (it interrupts the inner scope's forks). Failures in the inner scope only cancel the inner siblings — they bubble up as an exception from the outer fork, and the outer joiner then decides what to do with it.

## When `CompletableFuture` is still right

Structured concurrency replaces `allOf`-style fan-out/fan-in. It does **not** replace:

| Use case                                             | Prefer `CompletableFuture` because                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Chained transformations (`thenApply`, `thenCompose`) | They're pipelines, not fan-outs; `StructuredTaskScope` has no equivalent                          |
| Callbacks on completion (`whenComplete`, `handle`)   | Async hooks that fire when ready, not scope-bound                                                 |
| Work that genuinely outlives the calling method      | Background tasks, fire-and-forget; structured concurrency forbids this on purpose                 |
| Composition with reactive streams / Project Reactor  | `CompletableFuture` interops; structured scopes don't                                             |
| Pre-Java 21 codebases                                | `StructuredTaskScope` requires 21+, and is still a preview API (`--enable-preview`) as of Java 25 |

The principle: if the work has a **definite lifetime ending in the current method**, use a scope. If the work is genuinely **asynchronous / unbounded / chained**, stick with `CompletableFuture`.

## Configuration knobs

```java
StructuredTaskScope.open(
    joiner,
    cfg -> cfg
        .withName("user-profile-fetch")          // shows in thread dumps
        .withThreadFactory(virtualThreadFactory)  // override default VT factory
        .withTimeout(Duration.ofSeconds(2))       // scope-wide deadline
);
```

`withTimeout` is the big one for production code — it sets a hard deadline for the entire scope. When the timeout fires, all forks are interrupted and `scope.join()` throws `TimeoutException`. This replaces the awkward per-future `CompletableFuture.orTimeout(...)` pattern with a single scope-level setting.

## Practical shapes

**Parallel downstream enrichment** (e.g. assembling an order page):

```java
try (var scope = StructuredTaskScope.open(Joiner.<Object>allSuccessfulOrThrow())) {
    var customer  = scope.fork(() -> customerSvc.fetch(orderId));
    var inventory = scope.fork(() -> inventorySvc.fetchSkus(skuList));
    var shipping  = scope.fork(() -> shippingSvc.quote(addr));
    scope.join();
    return assemble(customer.get(), inventory.get(), shipping.get());
}
```

**A hedged request** (primary + warm replica; take whichever responds first):

```java
try (var scope = StructuredTaskScope.open(Joiner.<Order>anySuccessfulResultOrThrow())) {
    scope.fork(() -> primaryDb.findOrder(id));
    scope.fork(() -> replicaDb.findOrder(id));
    scope.join();
    return scope.subtasks().stream()
                .filter(t -> t.state() == Subtask.State.SUCCESS)
                .findFirst().orElseThrow().get();
}
```

**A batch with partial success** (collect what worked, log what didn't):

```java
try (var scope = StructuredTaskScope.open(Joiner.<Result>awaitAll())) {
    List<Subtask<Result>> tasks = items.stream()
        .map(item -> scope.fork(() -> process(item)))
        .toList();
    scope.join();

    Map<Boolean, List<Subtask<Result>>> partitioned = tasks.stream()
        .collect(Collectors.partitioningBy(t -> t.state() == Subtask.State.SUCCESS));
    return new BatchResult(partitioned.get(true), partitioned.get(false));
}
```

## Gotchas

- **The API has churned through previews.** The Java 21 preview API used `ShutdownOnFailure` / `ShutdownOnSuccess` subclasses; Java 25 (JEP 505) reshaped it into `Joiner` strategies passed to `open()`. Tutorials online may show the old API — confirm against your Java version. It's still a preview API as of Java 25, so it needs `--enable-preview` and may change again.
- **`Subtask.get()` is only safe after `scope.join()`.** Calling `get()` before the join throws `IllegalStateException`. This is structurally enforced — you can't accidentally read a future result.
- **`scope.fork()` after `scope.join()` throws.** Forks must happen before the join. Reusing a scope for "another batch of work" requires a new scope.
- **Interruption is cooperative.** A CPU-bound subtask that doesn't check `Thread.isInterrupted()` will run to completion even after `allSuccessfulOrThrow` decides to cancel. Make CPU loops interrupt-aware, or move them to a different model.
- **`CompletableFuture.cancel(true)` does NOT propagate through a scope.** `CF.cancel` only marks the future cancelled; the underlying task keeps running. Use scope cancellation (via the joiner) for actual interruption.
- **`ThreadLocal` does NOT propagate to forks.** Even though VTs inherit some thread-locals, the behavior is subtle, and `InheritableThreadLocal` is the wrong tool. Use `ScopedValue` for context propagation in structured code.
- **A scope is single-threaded for `fork`/`join` calls.** Forks must be issued from the thread that opened the scope. You can't pass the scope to other threads to fork into it.
- **No equivalent to `thenApply` chains.** Structured concurrency is fan-out/fan-in only. For chained transformations, use `CompletableFuture`, or just write sequential code inside one fork.
- **The pre-25 preview classes (`StructuredTaskScope.ShutdownOnFailure` etc.) will not work on 25+.** If you're migrating an existing 21-preview codebase, you have to rewrite the scope construction. JEP 505 changed the API surface explicitly to support `Joiner` composability.

## References

- [JEP 505 — Structured Concurrency (Fifth Preview, Java 25)](https://openjdk.org/jeps/505)
- [JEP 499 — Structured Concurrency (Fourth Preview, Java 24)](https://openjdk.org/jeps/499)
- [JEP 480 — Structured Concurrency (Third Preview, Java 23)](https://openjdk.org/jeps/480)
- [JEP 453 — Structured Concurrency (Preview, Java 21)](https://openjdk.org/jeps/453)
- Project Loom design notes — Ron Pressler
- Earlier in this topic:
  - [Platform threads vs. virtual threads](/posts/platform-vs-virtual-threads-scheduling/) — VTs back every fork; mount/unmount mechanics.
  - [CompletableFuture, async patterns, and the cancellation problem](/posts/completablefuture-async-patterns-and-cancellation/) — when CF is still the right tool.
  - [ThreadLocal mechanics and cleanup](/posts/threadlocal-mechanics-and-cleanup/) — `ScopedValue` is the partner primitive for context propagation.
