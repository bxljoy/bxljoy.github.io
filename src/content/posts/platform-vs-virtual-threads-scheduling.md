---
title: "Platform threads vs. virtual threads: scheduling and context-switching internals"
description: "Where the queues actually live, who schedules what, what a context switch costs at the OS and JVM layers, how Linux CFS schedules threads, and why cooperative scheduling makes CPU-bound virtual threads hog their carriers."
pubDatetime: 2026-10-01T09:19:00+02:00
tags: [java, concurrency, virtual-threads, scheduling]
sourceNotes: [platform-vs-virtual-threads-scheduling-internals]
---

> Two scheduling layers, two cost regimes: the OS preempts platform threads at a cost of ~µs; the JVM cooperatively switches virtual threads at a cost of ~ns — but only at yield points, which is why CPU-bound code on virtual threads hogs carriers.

## Table of contents

## Overview

A common point of confusion when reasoning about Java concurrency is conflating _thread pool size_, _OS run queue_, and _CPU cores_ — and assuming "virtual threads = no context switching". This post nails down the precise mechanics: where the queues actually live, who schedules what, what a context switch costs at each layer, and the critical distinction between **preemptive** (platform thread) and **cooperative** (virtual thread) scheduling. This mental model is what makes pinning, runaway carriers, and CPU-bound virtual-thread pitfalls predictable instead of mysterious.

## Key points

- **Parallelism ≤ cores.** True parallel execution at any instant is bounded by physical cores, regardless of pool type. Everything else is _concurrency_, via time-slicing or mounting.
- **Pool task queue ≠ OS run queue.** A `FixedThreadPool(200)` does not "queue 192 of its 200 threads on an 8-core box" — all 200 threads are alive and runnable, sitting in the OS scheduler's run queue. The pool's _task queue_ only fills when all 200 threads are busy.
- **Two scheduling layers exist with virtual threads:** VT → carrier (cooperative, JVM, ~hundreds of ns), and carrier → core (preemptive, OS, ~µs).
- **An OS context switch ≈ 1–10 µs.** Kernel mode, register save/restore, TLB flush, cache pollution.
- **A VT mount/unmount ≈ 100–500 ns.** User mode: save the continuation to the heap, swap stack frames. ~10–100× cheaper than an OS switch — but **not zero**.
- **Platform threads are preemptively scheduled** by the OS — every ~10 ms quantum, the OS forces a switch regardless of what the thread is doing. Fairness is automatic.
- **Virtual threads are cooperatively scheduled** by the JVM — they only switch at **yield points** (blocking I/O, `Thread.sleep`, `LockSupport.park`, `synchronized`/`ReentrantLock` waits, channel ops, `Thread.yield()`).
- **A pure CPU-bound VT will hog its carrier indefinitely** — there's no preemption, so other VTs queued on that carrier wait. This is why VTs are unsuitable for CPU-bound work.
- **Platform thread pools are correct for any workload, but only efficient up to a few hundred threads** — limited by the ~1 MB stack each and non-linear context-switch overhead. VTs lift this ceiling for I/O-bound workloads.

## The "pool queue vs. OS queue" confusion

The single most common mental-model error: thinking that a `FixedThreadPool(200)` on an 8-core machine runs 8 threads and "queues" the other 192 in the pool.

What actually happens:

```
Thread pool (200 threads, all alive)
        │
        ├─ Task queue (FIFO of Runnables waiting for a free thread)
        │  → only fills when all 200 threads are busy
        │
        └─ All 200 threads are runnable from JVM's view
                ↓
        OS scheduler run queue (across all cores)
                ↓
        8 cores execute 8 threads at any single instant
        Other 192 are in OS run queue, blocked on I/O, or sleeping
        OS time-slices them in/out every ~10 ms
```

So the right answer to "what happens to threads beyond the core count?" is: **they're queued by the OS, not by the pool.** The pool's queue is for _tasks_, not threads.

## Cost of a context switch (per layer)

| Layer                          | Mechanism              | Approx. cost | What happens                                                                                                     |
| ------------------------------ | ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| OS → core (platform thread)    | Preemptive, kernel     | ~1–10 µs     | Save registers, switch page table / TLB, kernel-mode transition, cache cold on resume                            |
| JVM → carrier (virtual thread) | Cooperative, user mode | ~100–500 ns  | Save the VT's stack into a continuation (a heap object), load another VT's continuation onto the carrier's stack |

VT switches are 10–100× cheaper, but **they are still context switches**. "VTs have no context switching" is wrong — they have _cheap, user-mode_ context switches, and only at yield points.

## Inside the OS layer — what CFS actually does

The "OS scheduler" on Linux is **CFS (the Completely Fair Scheduler)**. It's worth knowing one level deeper than "preempts every ~10 ms".

**Per-CPU runqueues, not one global queue.** CFS keeps **one runqueue per core**. Each runqueue is a red-black tree of runnable threads keyed by **virtual runtime (`vruntime`)** — a per-thread counter tracking the CPU time it has consumed. The next thread to run on a core is always the one with the **smallest `vruntime`** in _that core's_ runqueue.

```
core 0 runqueue: [T_a vrt=12, T_b vrt=15, T_c vrt=18]   ← min-vruntime tree
core 1 runqueue: [T_d vrt=10, T_e vrt=14]
core 2 runqueue: [T_f vrt=9]
core 3 runqueue: [T_g vrt=11, T_h vrt=13, T_i vrt=16]

Periodic load-balancer (~4 ms): "core 2 short on work — migrate T_h from core 3"
```

**No fixed time slice — it's adaptive.** CFS doesn't use a hard "10 ms quantum". Slice size = `sched_latency_ns / runnable_threads_on_core`, floored at `sched_min_granularity_ns` (~0.75 ms). So:

- 4 runnable threads on core 0 → ~1.5 ms slices each
- 50 runnable threads on core 0 → the slice is floored at 0.75 ms → constant preemption

**The runnable-state nuance.** A blocked thread (waiting on I/O, a lock, or sleep) is **removed from the runqueue** entirely and is invisible to CFS. Its `vruntime` stays frozen. When it wakes (the I/O completes), it's re-inserted with its low `vruntime` and immediately rises to the front — which is why I/O-completing threads get scheduled fast. This is the kernel mechanism that makes the Goetz `(1 + W/C)` formula work: only the _runnable_ fraction competes.

**The `nice` value modulates fairness.** A lower `nice` (-20..+19, default 0) → `vruntime` accumulates more slowly per unit of real time consumed → the thread gets relatively more CPU. The JVM's `Thread.setPriority(...)` is mapped to `nice` non-portably and largely ignored on Linux — assume all your Java threads are `nice=0` and purely vruntime-fair.

**Cgroup interaction (containers).** When running in containers with CPU limits, CFS does **two-level scheduling**: first it picks a cgroup based on its CPU share, then it picks a thread within that cgroup. A container limited to "2 CPUs" can never use more than 2 cores' worth of time, even on a 96-core host. This is why `Runtime.availableProcessors()` returns the cgroup limit on Java 10+ — your pool sizing must match what the cgroup will actually deliver.

**In short:** _kernel context switching is the bottleneck, not memory._ A platform pool of 10k threads costs ~10 GB of stack memory (real), but the dominant operational cost is CFS bookkeeping plus cold-cache penalties on every preemption. VTs avoid the kernel scheduler entirely for the M:N portion — the kernel only sees ~Ncpu carriers, regardless of the VT count.

## The two-layer scheduling model with virtual threads

```
[VTs: thousands+]            ← JVM scheduler (ForkJoinPool), cooperative
        ↓ mount/unmount at yield points (~100–500 ns)
[Carriers: ~cores]           ← Platform threads = OS threads
        ↓ OS schedules
[Cores: physical CPUs]       ← OS scheduler, preemptive (~µs, ~10 ms quantum)
```

Two schedulers operate independently:

- The **JVM** decides which VT mounts on which carrier — cooperatively, acting only at yield points.
- The **OS** decides which carrier (and any other platform threads in the system — GC, app threads, kernel) runs on which core — preemptively, acting every quantum.

## Preemptive vs. cooperative scheduling

|                           | Platform threads                        | Virtual threads                                             |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Who schedules             | The OS kernel                           | The JVM ForkJoinPool                                        |
| When it switches          | After every ~10 ms quantum (preemptive) | Only at yield points (cooperative)                          |
| Fairness                  | Automatic — the OS forces switches      | Depends on cooperation — a runaway thread can starve others |
| Switch cost               | ~1–10 µs                                | ~100–500 ns                                                 |
| CPU-bound thread behavior | Gets a fair time slice with the others  | **Hogs its carrier until it yields**                        |

**Yield points for VTs** (anywhere the VT can unmount):

- Blocking I/O: `Socket.read`, JDBC calls, `HttpClient.send`
- `Thread.sleep`
- `LockSupport.park`, `ReentrantLock` waits, `synchronized` waits (with the pinning caveat on Java ≤23)
- Channel operations (NIO, structured concurrency)
- An explicit `Thread.yield()`

If a VT does `while(true) { compute(); }` with no yield point, it owns its carrier forever. With 8 carriers and 8 such VTs, the VT scheduler is permanently jammed, even if 10,000 other VTs are runnable.

## When platform pools "do no harm" — and when they do

For correctness, OS preemption handles both I/O-bound and CPU-bound workloads fairly on platform thread pools. The harm is in **resource cost and scalability**:

| Concern                     | At ~8 threads (cores) | At ~200 threads (Tomcat default) | At ~2,000 threads                    | At ~10,000+ threads    |
| --------------------------- | --------------------- | -------------------------------- | ------------------------------------ | ---------------------- |
| Stack memory (~1 MB/thread) | ~8 MB                 | ~200 MB                          | ~2 GB                                | ~10 GB+ (OOM)          |
| Context-switch overhead     | Negligible            | Acceptable (~250 ms per slice)   | Switching dominates, cache thrashing | Goodput collapses      |
| OS-level scheduling         | Trivial               | Manageable                       | Painful                              | Practically impossible |

For **CPU-bound work**, the right tool is a platform pool sized to the cores — VTs offer nothing and can hurt (no preemption). For **I/O-bound work at low concurrency** (<200), platform pools are fine. For **I/O-bound work at high concurrency** (1000s+), VTs are designed for exactly this — carriers stay 100% busy because blocked VTs unmount instantly.

## Worked example: 95 ms DB wait, 5 ms CPU per request

An 8-core machine; each request = 5 ms CPU + 95 ms DB wait:

| Approach                                | Max concurrent requests | Why                                                                                                          |
| --------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `FixedThreadPool(200)` platform threads | ~200                    | Hard cap by pool size; most threads sit blocked on the DB; CPUs idle ~95% of the time                        |
| Virtual threads (8 carriers)            | 10,000+, trivially      | Carriers are reused during the 95 ms wait; the bottleneck moves to actual CPU work or the DB connection pool |

Throughput on platform threads is gated by an artificial constant (the pool size). Throughput on VTs is gated by the real constraint (CPU or downstream).

## Gotchas

- **"VTs have no context switching" is wrong.** Mount/unmount is a context switch — a cheap, user-mode one. The win is the cost differential and the freed carrier during blocks, not the absence of switching.
- **Cooperative scheduling has no fairness guarantee.** A CPU-bound VT will hog its carrier when there's no `Thread.sleep` or I/O to force a yield. If you have CPU-heavy sections inside an otherwise I/O-bound VT, sprinkle in `Thread.yield()` or offload to a platform-thread pool sized to the cores.
- **Pool queue ≠ OS run queue.** This confusion leads to wrong reasoning about what "happens" to the 192 extra threads on an 8-core box. They're not queued in the pool — they're alive and getting time slices from the OS.
- **The platform pool's memory ceiling is the real limit, not throughput.** 10,000 platform threads ≈ 10 GB of stack. The OS would also spend more time switching than executing. The default Tomcat cap (200) reflects this physical reality, not a JVM limit.
- **Carriers are still OS-scheduled.** Switching the app to virtual threads doesn't eliminate OS-level context switching — it just reduces the population from N pool threads to ~8 carriers, which means far less switching at the OS layer.
- **`Runtime.availableProcessors()` returns the cgroup limit in containers, not the host's physical core count** (Java 10+ with `UseContainerSupport`, on by default). It counts logical cores (hyperthreads), not physical ones. Cache this value at startup; don't call it in hot paths.
- **CFS doesn't know or care about JVM identity.** Three JVMs on one box = three processes whose threads all compete in the same per-CPU runqueues by `vruntime`. Two-level scheduling kicks in only when those JVMs are in separate cgroups.
- **`synchronized` + blocking I/O on Java ≤23 pins the VT to its carrier**, defeating the unmount mechanism. The carrier gets stuck at the OS level, and the ForkJoinPool spawns a compensating carrier.

## References

- JEP 444 — Virtual Threads (Java 21)
- JEP 491 — Synchronize Virtual Threads without Pinning (Java 24)
- Project Loom design notes — Ron Pressler
- Related: [Node.js event loop vs. Java concurrency](/posts/nodejs-event-loop-vs-java-concurrency/)
