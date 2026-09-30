---
title: "Sagas: choreography vs. orchestration, compensation, and why they need the outbox"
description: "How a saga replaces a distributed transaction with local transactions plus compensations, why it gives up isolation, choreography vs. a persisted orchestrator, the saga-vs-lifecycle distinction, pivot ordering, and why every saga step needs an outbox."
pubDatetime: 2026-09-30T17:55:00+02:00
tags: [saga, distributed-systems, microservices, outbox]
sourceNotes: [saga-choreography-orchestration-and-compensation]
---

> A saga replaces a distributed ACID transaction with a **sequence of local transactions plus compensating actions** — trading isolation for availability, since 2PC is blocking, lock-heavy, and unsupported by most modern participants. There are two flavours: **choreography** (services react to each other's events; no coordinator, but the workflow exists nowhere and there's no state to query) and **orchestration** (a persisted state machine drives the steps — one readable artifact and queryable progress, but an extra component to run). The precise property given up is **I**: a saga is A, C, D _without_ isolation, so intermediate states are visible and need countermeasures like semantic locks. And every saga step is itself a **dual write** (commit state + tell the next participant), which is why a saga without an outbox has silently broken steps.

## Table of contents

## Overview

A saga answers: _"One business operation spans several services, each with its own database — how do I make it all-or-nothing without a distributed transaction?"_

It is **not** a fix for cache/DB inconsistency. Both descend from "no atomic commit across boundaries", but a saga won't invalidate a cache, and a TTL won't refund a payment. Keep the two distinct — say _which_ distributed-consistency problem you're solving.

The pairing with [the outbox pattern](/posts/outbox-pattern-and-dual-write-problem/) is not a stylistic choice; it's structural. A saga gives consistency **across services**; the outbox gives consistency between **one service's database and its messages**. Each saga step needs the second to be reliable at all.

## Key points

- **A saga = local transactions T1..Tn, each with a compensating transaction C1..Cn.** On failure at Ti, run Ci-1 … C1 (backward recovery).
- **Compensation is semantic, not a rollback.** You don't erase the charge; you issue a refund. The original effect was visible, and it stays in the history.
- **Two types: choreography** (event-driven, no coordinator) **and orchestration** (a persisted state machine drives the participants). Choreography for 2–3 simple steps; orchestration once you have branching, 4+ steps, or anyone asks _"where is this order stuck?"_.
- **A saga is a _window_ in an aggregate's life, not its lifecycle.** There are two distinct state machines: the saga tracks _coordination progress_ (seconds, and it ends definitely); the aggregate tracks _business facts_ (months). Modelling the whole lifecycle as one long saga is the most common design error. A transition driven by a real-world event, with nothing to coordinate and no compensation — shipped, delivered — is not a saga step; it's event handling. And a "saga" that waits days is a **workflow** (Temporal/Camunda), not a saga.
- **Keep `order.status` and `saga_instance.step` separate**, with one deliberate overlap: the business status reflecting an in-flight saga _is_ the semantic lock. Coordination states like `COMPENSATING` must never leak into the domain model.
- **A saga sacrifices Isolation specifically — it is ACD without the I.** Intermediate states are visible, producing dirty reads and lost updates.
- **`status = *_PENDING` is a semantic lock** — the most common isolation countermeasure, and you've probably already written one without naming it.
- **Order the steps compensatable → pivot → retriable.** After the pivot there is no going back, so post-pivot steps must be retried to success rather than compensated. Irreversible actions (an email sent, a package dispatched) belong after the pivot.
- **Every saga step is a dual write**, so `@Transactional { save(); kafkaSend(); }` is broken in both directions — a stalled saga or phantom downstream work. The outbox makes the state change and the handoff atomic.
- **The orchestrator has the dual-write problem too** — its state transition and the next command must commit in one transaction, so there are outboxes on _both_ sides. One outbox table routed by a `destination` column covers commands, replies, and domain events; split it only when ordering, volume, relay, or retention demand it.
- **Host the orchestrator in the service that owns the initiating aggregate.** Not merely to avoid a deployable: a separate orchestrator DB could never commit `saga_instance` and `orders` together, so you'd need a saga to coordinate your saga. Co-location also makes that service's own steps a plain local transaction — genuinely ACID, with no compensation needed.
- **The outbox publishes at-least-once ⇒ every participant AND every compensation must be idempotent.**
- **Sagas need timeouts and a stuck-saga path.** A participant that never replies hangs the saga forever; a compensation that fails needs retries plus a human escape hatch.

## Why not 2PC

The textbook answer to a cross-service transaction is two-phase commit, which is rejected in microservices because:

- **It blocks.** If the coordinator dies mid-commit → participants hold their locks, waiting.
- **Locks span network round trips** — throughput collapses under latency.
- **Most participants don't support XA** — HTTP services, Kafka, most NoSQL stores.
- **It picks C over A** in CAP terms: a partition means unavailability.

A saga takes the opposite trade — stay available, give up isolation, and reconcile with compensation.

## Compensation is semantic, not rollback

| Action                    | Compensation              | Why it isn't a rollback               |
| ------------------------- | ------------------------- | ------------------------------------- |
| Charge a card             | Issue a refund            | The charge is on their statement      |
| Send a confirmation email | Send a cancellation email | The email was read                    |
| Reserve stock             | Release the stock         | Other orders saw reduced availability |
| Dispatch a package        | _(none)_                  | Physically irreversible               |

The bottom row is the design constraint: **some actions cannot be compensated at all**, which forces the step ordering described below.

## Two state machines: the saga is not the lifecycle

The most common modelling mistake is treating an aggregate's whole lifecycle as one long saga. They are **two different state machines** that happen to touch the same entity.

|          | Saga state machine                           | Aggregate lifecycle                                        |
| -------- | -------------------------------------------- | ---------------------------------------------------------- |
| Scope    | One business transaction across services     | The entity's whole life                                    |
| Lifetime | Seconds to minutes                           | Days to months                                             |
| States   | `AWAITING_PAYMENT`, `COMPENSATING`, `DONE`   | `PENDING`, `CONFIRMED`, `SHIPPED`, `DELIVERED`, `RETURNED` |
| Meaning  | **Coordination progress**                    | **Business facts**                                         |
| Ends     | Definitely — at success or full compensation | When the entity is archived                                |
| Owned by | The orchestrator                             | The aggregate                                              |

A saga covers a **window**, not the timeline:

```
PENDING ──┐
          │  ← saga runs here (seconds): charge, reserve, confirm
CONFIRMED ┘
   │
SHIPPED      ← warehouse/carrier webhook. Not a saga.
   │
DELIVERED    ← carrier webhook. Not a saga.
   │
RETURNED     ← customer action → triggers a DIFFERENT saga
```

### Why later transitions aren't saga steps

There are three tests, any one of which disqualifies a transition from being a saga step:

- **Nothing is being coordinated.** The warehouse reports a dispatch; you record it. No other service must agree for the fact to be true.
- **There is no compensation.** You cannot un-ship a package. A transition with no compensating action can't be a compensatable step — at best it lives after the pivot.
- **It's driven by the real world, not by your transaction.** A carrier scan arrives days later. **A "saga" that waits days is a workflow**, and you'd reach for a durable workflow engine (Temporal, Camunda, Step Functions) rather than hand-rolled compensation.

Those transitions are ordinary event handling: consume the webhook → validate the transition → update the status → emit a domain event.

### Which later transitions _are_ sagas

The genuinely multi-service ones with undo semantics — **return/refund** (refund the payment + restock + update the order + notify) and **cancellation before dispatch** (release the stock + refund + mark cancelled). But these are **separate saga instances of separate saga types**, possibly orchestrated by a different service. One lifecycle; several independent sagas at different points, plus many transitions that are just events.

### Invariants belong to the aggregate, not the saga

_"You can't cancel a dispatched order"_ is an **aggregate invariant**, enforced inside the aggregate — the same boundary as "the orchestrator sequences, participants decide":

```
returns-saga ──CancelOrder──▶ order-service
                                checks its own lifecycle state machine
                                status = SHIPPED ⇒ transition illegal
             ◀──CancellationRejected──
   compensate
```

The saga _requests_ a transition; the aggregate _decides_ whether it's legal and reports back. Put the invariant in the orchestrator, and every saga touching that aggregate has to reimplement it — and they will drift.

### Don't collapse them into one field

Using `order.status` as the saga's state breaks in three ways: the saga has states with no business meaning (`COMPENSATING`, `AWAITING_STOCK_REPLY`), coordination mechanics leak into the domain model, and two concurrent sagas touching the entity fight over one column.

Keep them separate, with exactly one deliberate overlap:

```
order.status       = 'PENDING_PAYMENT'          ← business state, AND the semantic lock
saga_instance.step = 'AWAITING_PAYMENT_REPLY'   ← coordination detail, invisible to the domain
```

The business status _reflecting_ an in-flight saga is precisely the semantic lock from the isolation countermeasures below — that's the legitimate connection. The saga's internal bookkeeping stays in the orchestrator's own table.

## Type 1 — Choreography

Services react to each other's events. There's no coordinator.

```
OrderService     : create order (PENDING)         → emit OrderCreated
PaymentService   : on OrderCreated → charge       → emit PaymentCompleted | PaymentFailed
InventoryService : on PaymentCompleted → reserve  → emit StockReserved | StockUnavailable
OrderService     : on StockReserved    → CONFIRMED
                   on PaymentFailed    → CANCELLED
                   on StockUnavailable → emit RefundRequested
PaymentService   : on RefundRequested → refund    → emit Refunded
```

**For:** nothing extra to build or operate; loose coupling; minimal ceremony on short flows.

**Against:**

- **The workflow exists nowhere.** Answering "what happens when an order is placed?" means reading five services and reconstructing it mentally. There's no artifact to point at, review, or test as a unit.
- **There's no saga state to query.** _"Where is order 42 stuck?"_ has no direct answer — you correlate logs across services.
- Changing the flow touches every participant.
- Cyclic event dependencies emerge quietly as the flow grows.

## Type 2 — Orchestration

A coordinator holds the workflow as a **persisted state machine**, with one instance per saga.

```
OrderSagaOrchestrator

  step 1  PaymentService.charge()      ── fail → FAILED
  step 2  InventoryService.reserve()   ── fail → C1 refund            → FAILED
  step 3  ShippingService.schedule()   ── fail → C2 release, C1 refund → FAILED
  all ok                                                              → CONFIRMED
```

**For:** the workflow is one readable, testable artifact; the saga state is persisted, so progress is queryable and monitorable; the compensation order is explicit; adding a step is a local change.

**Against:** a new component to build and operate, and it drifts toward a god service if business rules migrate into it. Keep the orchestrator to **sequencing and compensation**; keep decisions inside the participants.

### How an orchestrator actually runs

**Participants never call the orchestrator — they _reply_ to it.** The orchestrator issues commands and consumes replies; a participant receives one instruction, runs one local transaction, and reports the outcome. It never decides what comes next.

**What's persisted** — the thing choreography has no equivalent of:

```sql
CREATE TABLE saga_instance (
    saga_id        UUID PRIMARY KEY,
    saga_type      TEXT        NOT NULL,   -- 'CREATE_ORDER'
    current_step   TEXT        NOT NULL,   -- 'RESERVE_STOCK'
    status         TEXT        NOT NULL,   -- RUNNING | COMPENSATING | DONE | FAILED
    context        JSONB       NOT NULL,   -- ids/amounts returned by earlier steps
    reply_deadline TIMESTAMPTZ,            -- drives the timeout scan
    version        INT         NOT NULL,   -- optimistic locking
    updated_at     TIMESTAMPTZ NOT NULL
);
```

`context` is what lets participants stay stateless about the saga — step 3 often needs the `payment_id` that step 1 returned, and the orchestrator accumulates that as it goes.

**The loop:**

```
① orchestrator                        ② payment-service
   BEGIN                                 (consumes ChargePayment)
     INSERT saga_instance                  BEGIN
        step='CHARGE_PAYMENT'                INSERT payment (...)
     INSERT outbox                           INSERT outbox
        → ChargePayment{saga_id}                → PaymentCharged{saga_id, payment_id}
   COMMIT                                  COMMIT
   relay publishes                         relay publishes reply

③ orchestrator consumes PaymentCharged
   BEGIN
     UPDATE saga_instance
        SET step='RESERVE_STOCK',
            context = context || '{"payment_id":...}',
            version = version + 1
      WHERE saga_id = ? AND version = ?
     INSERT outbox → ReserveStock{saga_id, sku, qty}
   COMMIT
```

> **The load-bearing detail:** in ③, the state transition and the next command commit in **one local transaction**. Otherwise the orchestrator can advance and fail to send (the saga stalls silently), or send and forget that it did (double execution). **The orchestrator has the dual-write problem internally** — so there are outboxes on _both_ sides: participants for replies, the orchestrator for commands.

**Correlation.** Every command carries `saga_id`, and every reply echoes it. That's how a reply finds its state machine among thousands in flight.

**Duplicate and out-of-order replies.** At-least-once delivery means a reply can arrive twice, or late. The transition is made idempotent by the state machine itself:

```sql
UPDATE saga_instance
   SET step = 'RESERVE_STOCK', version = version + 1
 WHERE saga_id = ? AND step = 'CHARGE_PAYMENT';   -- only if still awaiting THIS step
```

A duplicate matches zero rows and is discarded; `version` settles two replies racing.

**Timeouts** — what orchestration gives you that choreography structurally cannot. The orchestrator records `reply_deadline` when it sends a command, and a background scan does the rest:

```sql
SELECT * FROM saga_instance
 WHERE status = 'RUNNING' AND reply_deadline < NOW();
```

Expired → retry the command, or begin compensating. In choreography there's nowhere to put this, because nothing owns the flow.

**Compensation is the same loop, backwards.** It's not a special-cased rollback: the status flips to `COMPENSATING`, and the orchestrator walks the completed steps in reverse, issuing compensation commands and awaiting _their_ replies — each with its own timeout and idempotency requirement.

**Crash recovery** is the real payoff: the orchestrator is stateless in memory and stateful in Postgres, so a pod dying mid-saga costs nothing. On restart, the timeout scan finds every saga past its deadline and resumes or compensates it.

**Two transports:**

|            | Async command/reply                              | Sync RPC                                                          |
| ---------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| Mechanism  | Commands and replies over Kafka/Pub-Sub          | The orchestrator calls the participant and gets the result inline |
| Coupling   | Temporal decoupling; the participant can be down | Participant down ⇒ the step fails now                             |
| Complexity | Outboxes, correlation, reply channels            | Far simpler to write and debug                                    |
| Fit        | Long-running steps, unreliable participants      | Fast steps, small flows                                           |

The async form is canonical, but a **synchronous orchestrator with persisted state and compensation is legitimate** and much easier to start with — you still get queryable state, timeouts, and crash recovery, which are the main wins.

### Where the orchestrator lives

It need **not** be a new deployable. Commonly it's a component inside the service that owns the initiating aggregate — `order-service` hosting the order saga — using that service's existing database and outbox.

The real reason this is good design, beyond "one fewer service": if the orchestrator had its own database, `saga_instance` and `orders` could never commit together, and you'd need a saga to coordinate your saga. Co-locating them collapses that problem.

It also means the service plays **two roles**: orchestrator (owns `saga_instance`, sends commands, consumes replies) and participant (owns `orders`, executes order-related steps). For steps that are its _own_ work, short-circuit rather than round-tripping through the broker to talk to yourself:

```sql
BEGIN;
  UPDATE orders        SET status = 'CONFIRMED' WHERE id = 42;
  UPDATE saga_instance SET step = 'DONE', status = 'DONE' WHERE saga_id = ?;
COMMIT;
```

That step is now genuinely ACID and needs no compensation, because it cannot half-happen. The trade-off: it doesn't appear as a message, so the saga's audit trail isn't uniform — write a step-log row in the same transaction if you need one.

### One outbox table, routed by destination

Saga commands, replies, and domain events all share one table. The outbox is a **transport mechanism, not a semantic category**:

```sql
CREATE TABLE outbox (
    id           BIGSERIAL PRIMARY KEY,
    destination  TEXT NOT NULL,   -- 'payment.commands' | 'order-saga.replies' | 'order.events'
    type         TEXT NOT NULL,
    aggregate_id TEXT,
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);
```

Split it only when something hurts: **ordering isolation** (a high-volume event stream head-of-line-blocking saga commands), **volume asymmetry** (retention and poll tuning pulled in opposite directions), **different relays** (CDC for events, a poller for commands), or **different retention** (keep command history for audit, drop projection events daily).

**Topic layout:** commands get one channel per participant (`payment.commands`), since each service owns its inbox; replies get one channel per saga type (`order-saga.replies`), with only that orchestrator consuming. Partition replies by `saga_id`, so one saga's transitions stay sequential without extra locking.

## Choosing

> Choreography for 2–3 steps with no branching. Orchestration once there is branching, 4+ steps, or anyone needs to ask _"where is this stuck?"_

Most production order flows end up orchestrated — because that operational question shows up about a week after launch, and choreography has no answer to it.

## The property you give up: Isolation

> **A saga is A, C, D — but not I.** Intermediate states are visible to everyone.

Between T1 and T3, an order exists that is paid for but has no stock reserved, and other transactions can see it. The resulting anomalies are the familiar ones from [database isolation levels](/posts/postgres-isolation-levels-and-mvcc/), now at service scope:

- **Dirty reads** — another process reads the half-finished state and acts on it
- **Lost updates** — a concurrent saga overwrites your intermediate write

**Countermeasures:**

| Countermeasure          | What it does                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Semantic lock**       | Mark the record `*_PENDING` so others know a saga owns it and can wait, reject, or handle it. By far the most common — `order.status = PAYMENT_PENDING` _is_ one. |
| **Commutative updates** | Design operations so order doesn't matter (debit/credit)                                                                                                          |
| **Pessimistic view**    | Reorder steps so the risky or visible ones happen last                                                                                                            |
| **Reread value**        | Re-read and verify before updating, catching lost updates (a compare-and-swap)                                                                                    |
| **By value**            | Route on risk — sagas for normal requests, 2PC for the rare high-stakes ones                                                                                      |

## Step classification: compensatable → pivot → retriable

Order the steps so that:

1. **Compensatable** — everything that's still undoable goes first.
2. **Pivot** — the point of no return.
3. **Retriable** — after the pivot, steps _must_ eventually succeed, so retry them indefinitely instead of compensating.

```
[ charge card ] [ reserve stock ] │ PIVOT │ [ send email ] [ dispatch package ]
   compensatable   compensatable  │       │   retriable      retriable
```

Getting this backwards is how you end up needing to un-send an email. **Retrofitting the ordering means redesigning the flow**, so decide it up front.

## Why the outbox is mandatory

Every saga step does two things: **commit local state** and **tell the next participant**. That's a dual write, and the naive version is broken:

```java
@Transactional
void handleOrderCreated(OrderCreated evt) {
    orderRepo.save(order);          // Postgres
    kafkaTemplate.send(nextEvent);  // broker — NOT part of the transaction
}
```

- The DB commits, the send fails → **the saga stalls forever**; the order sits in `PENDING` and nothing retries it.
- The send succeeds, the transaction rolls back → downstream acts on a state that doesn't exist.

Both fail silently, and neither shows up in tests. The outbox makes the handoff atomic with the state change:

```sql
BEGIN;
  UPDATE orders SET status = 'PAYMENT_PENDING' WHERE id = 42;
  INSERT INTO outbox (aggregate_id, type, payload)
    VALUES (42, 'OrderCreated', '{...}');
COMMIT;
-- a relay (poller or CDC) publishes the outbox row afterwards
```

This applies to the **orchestrator** too: its saga-state update and the command it emits must commit together, or the orchestrator can lose track of where it is. (For the relay options, see [outbox publishers](/posts/outbox-publishers-and-parallel-dispatch/).)

## The consequence: idempotency everywhere

The outbox relay publishes **at-least-once** — it can crash after publishing and before marking the row sent — so duplicates are guaranteed, eventually. Therefore:

- every participant must be idempotent (charge twice → charge once)
- **every compensation must be idempotent too** (refund twice → refund once), which is the half people forget

The mechanisms: [idempotency keys](/posts/request-idempotency-keys-for-write-apis/), dedup tables keyed by event ID, or version checks. See [at-least-once delivery → exactly-once effect](/posts/at-least-once-to-exactly-once-effect/) for the general treatment.

## Operational reality: timeouts and stuck sagas

Two things the pattern descriptions skip, and production doesn't:

- **A participant that never replies hangs the saga indefinitely.** Sagas need step-level timeouts with a defined action on expiry — usually compensate, sometimes retry. Without them, a silently dead consumer produces orders frozen in `PENDING` forever.
- **Compensations can fail.** `C2` failing during rollback leaves genuinely inconsistent state that no automated path resolves. Real systems need compensation retries, alerting on saga age, and a **manual intervention path** — a stuck-saga view and the ability to drive a saga to a terminal state by hand. Design it before you need it, because you will need it during an incident.

## Gotchas

- **"The saga rolls back the transaction" is wrong** — and it's the most common misconception. There is no rollback: compensation is a _new business action offsetting a visible one_, and some actions cannot be compensated at all.
- **Say "sacrifices Isolation", not "sacrifices ACID".** A saga preserves atomicity (eventually), consistency, and durability. Only the I goes.
- **Choreography's real cost is operational, not architectural.** It looks elegant on a whiteboard; the bill arrives when someone asks where an order is stuck and there's no state to query.
- **The orchestrator becoming a god service** is the standard failure mode. Sequencing and compensation belong there; business decisions belong in the participants.
- **`@Transactional` + `kafkaTemplate.send()` inside a saga step is broken in both directions** — the same dual-write trap as in [the outbox pattern](/posts/outbox-pattern-and-dual-write-problem/), just distributed across every step of the flow.
- **Compensations need idempotency too.** Retried refunds double-refunding is a real incident class — and it's the half that gets skipped, because attention goes to the forward path.
- **Irreversible actions must sit after the pivot.** If an email or a dispatch happens early, you have no valid compensation, and the design is wrong regardless of implementation quality.
- **Modelling the entire aggregate lifecycle as one saga** is the most common structural mistake. The saga ends at CONFIRMED; the order lives on for months afterwards on ordinary event handling. If your "saga" has no definite end, it isn't one.
- **Invariants placed in the orchestrator instead of the aggregate** guarantee drift — every saga touching that entity reimplements the rule. The saga _requests_ a transition; the aggregate _decides_ whether it's legal.
- **Saga ≠ cache consistency ≠ read-model projection.** All three use outboxes; they solve different problems. A one-way projection (like a CQRS read model) is _not_ a saga — there's no multi-service transaction and nothing to compensate.
- **Without step timeouts, a saga has no liveness guarantee** — only a safety one. A dead participant means orders frozen indefinitely.

## References

- Earlier in this topic:
  - [The outbox pattern and the dual-write problem](/posts/outbox-pattern-and-dual-write-problem/) — the mandatory partner; every saga step's handoff depends on it.
  - [Outbox publishers and parallel dispatch](/posts/outbox-publishers-and-parallel-dispatch/) — how the outbox rows get published.
  - [At-least-once delivery → exactly-once effect](/posts/at-least-once-to-exactly-once-effect/) — the idempotency and dedup that at-least-once delivery forces on every participant.
  - [Request-level idempotency for write/send APIs](/posts/request-idempotency-keys-for-write-apis/) — the concrete idempotency-key mechanism.
- Related: [Database isolation levels, MVCC, and the anomalies each prevents](/posts/postgres-isolation-levels-and-mvcc/) — the anomalies that reappear at service scope once the I is gone.
- Garcia-Molina & Salem, "Sagas" (1987) — the original paper, on long-lived transactions in a single DB.
- Chris Richardson, _Microservices Patterns_ — the source of the compensatable/pivot/retriable classification and the countermeasure set: [microservices.io — Saga](https://microservices.io/patterns/data/saga.html).
