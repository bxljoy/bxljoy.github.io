---
title: "Request-level idempotency for write/send APIs: client keys, per-tenant scoping, and computeIfAbsent semantics"
description: "How client-supplied idempotency keys make retried writes safe: per-tenant scoping, record-based composite keys, why computeIfAbsent beats check-then-act, the production move to durable uniqueness, and where the key comes from on the client — including the money-movement variant."
pubDatetime: 2026-09-30T13:33:00+02:00
tags: [idempotency, api-design, concurrency]
sourceNotes: [request-idempotency-keys-for-write-apis]
---

> A client-supplied key identifies a retried intent; safe replay also needs payload equality, durable uniqueness, and an explicit failure policy. `computeIfAbsent` is only an in-process building block. Tenant scoping prevents cross-tenant leaks; structured composite keys prevent delimiter collisions. Replay may return the current resource state rather than the original response bytes.

## Table of contents

## Overview

Senders retry. A client sees a timeout, doesn't know whether the write landed, and resends. Without idempotency you send the same SMS twice — double the bill, double the annoyance, double the downstream cost.

The fix is a **client-supplied idempotency key**: the client is the authority on "this is the same request", and the server promises that the same key produces the same outcome with exactly one side effect. This is the Stripe/AWS model, and the single most important reliability property of a message-send API. This post covers the in-process implementation, the concurrency guarantees that make it correct, and the production evolution to a durable, multi-instance store.

## Key points

- **The client supplies the key, not the server.** The key identifies a retry; it does not authorize changing the request. Stripe compares parameters and rejects conflicting reuse. Define payload equality explicitly in your own API.
- **Scope the key per tenant.** The cache key must be `(customerId, idempotencyKey)`, never the bare key. With a bare key → customer B can receive customer A's response = a cross-tenant data leak (IDOR-class) + B's message never sends.
- **`computeIfAbsent` is the atomic primitive.** The mapping function runs at most once per key, holding the bin lock. Two racing retries → one save, and both get the same response.
- **Clean-on-throw is a map behavior, not a universal API policy.** `ConcurrentHashMap.computeIfAbsent` records no mapping when its function throws. An API may deliberately retain failed outcomes: Stripe can cache the status/body, including a 500, once execution has started; validation and concurrent-execution conflicts are not saved.
- **Validate before the cache, never inside the lambda.** Fail fast, and don't run throwing logic inside the bin-locked mapping function.
- **Compose the cache key with a record, not string concatenation.** `record CacheKey(String customerId, String idempotencyKey)` — `equals`/`hashCode` cover all components, so there's no delimiter ambiguity.
- **The in-process map is the starting point; the production answer is durable.** A `ConcurrentHashMap` doesn't survive a restart or span multiple instances. Production pushes idempotency into the persistence layer (a `UNIQUE` constraint) or Redis (`SET NX EX`).

## The contract

```
send(request with idempotencyKey K):
  - validate request           (fail-fast, before any idempotency work)
  - if K is null/blank:        normal flow — generate id, save, return (opt-out)
  - else:                      return computeIfAbsent((customerId, K), doSend)
```

The same `(customerId, K)` → the same `messageId`, status `QUEUED`, and exactly one row saved.

## Why `computeIfAbsent` and not check-then-act

The naive flow is a check-then-act race:

```java
// BROKEN under concurrency
var cached = cache.get(key);
if (cached != null) return cached;     // two retries both miss here
return doSendAndCache(key);            // ...both save, one overwrites the other
```

Two retries with the same key both miss the `get`, and both save. `computeIfAbsent` collapses lookup + create into one atomic, per-bin-locked operation:

```java
return cache.computeIfAbsent(key, k -> doSend(request));   // runs at most once per key
```

The second racing thread blocks briefly on the bin lock, then receives the already-computed response. One save, two equal responses, zero races. (It's the same primitive that gives a rate limiter its atomic create-once per customer — see also [ConcurrentHashMap's atomic compound APIs](/posts/thread-safety-taxonomy-and-concurrent-collections/).)

## The clean-on-failure guarantee (the subtle, important bit)

The `ConcurrentHashMap.computeIfAbsent` Javadoc, verbatim:

> "If the mapping function itself throws an (unchecked) exception, the exception is rethrown, and **no mapping is recorded**."

So if `repository.save()` throws inside the lambda, the cache stays clean → a subsequent retry with the same key re-runs the lambda and tries again. This is exactly the behavior you want: a transient error is _not_ memoized as a permanent "result". It's also why `computeIfAbsent` beats a hand-rolled `putIfAbsent(key, placeholder)` — there's no half-finished entry to reconcile; it's all-or-nothing.

## Per-tenant scoping (the cross-tenant leak)

Keying on the bare idempotency key is a security bug in a multi-tenant system:

| customerId | idempotencyKey | Bare-key result                               |
| ---------- | -------------- | --------------------------------------------- |
| cust-1     | `"abc"`        | Saves, caches messageId X                     |
| cust-2     | `"abc"`        | **Cache HIT → returns X (cust-1's message!)** |

Customer B receives a `messageId` belonging to customer A's message, and B's own message is never sent. Stripe/AWS avoid this by scoping keys per account (every request authenticates with that account's API key, so the key space is inherently per-tenant). In code: key on `(customerId, idempotencyKey)`.

## Composite key — a record, not concatenation

String concatenation reintroduces the leak through delimiter ambiguity:

| customerId | idempotencyKey | `customerId + ":" + key` |
| ---------- | -------------- | ------------------------ |
| `"a"`      | `"b:c"`        | `"a:b:c"`                |
| `"a:b"`    | `"c"`          | `"a:b:c"` ← **collides** |

Use a record key instead — `equals`/`hashCode` compare all components structurally, with no delimiter and no ambiguity:

```java
private record CacheKey(String customerId, String idempotencyKey) {}
private final ConcurrentHashMap<CacheKey, SendMessageResponse> cache = new ConcurrentHashMap<>();
...
return cache.computeIfAbsent(new CacheKey(customerId, idempotencyKey), k -> doSend(request));
```

## Reference implementation shape

```java
public SendMessageResponse send(SendMessageRequest request) {
    requireNonBlank(request.customerId(), "customerId");
    requireNonBlank(request.recipient(),  "recipient");
    requireNonBlank(request.body(),       "body");

    String key = request.idempotencyKey();
    if (key == null || key.isBlank()) {
        return doSend(request);                                 // opt-out: not idempotent
    }
    return cache.computeIfAbsent(new CacheKey(request.customerId(), key), k -> doSend(request));
}

private SendMessageResponse doSend(SendMessageRequest request) {  // the single send seam
    String messageId = UUID.randomUUID().toString();
    repository.save(new Message(messageId, request.customerId(),
                                request.recipient(), request.body(), "QUEUED"));
    return new SendMessageResponse(messageId, "QUEUED");
}
```

Extracting `doSend` keeps the idempotency wrapper as the _only_ difference between the opt-out and dedup paths — one place owns the send logic, and the two call sites differ only in caching policy.

## Production evolution — why the in-process map isn't enough

The `ConcurrentHashMap` version is correct for a single JVM, but it:

- **Doesn't survive a restart** — the dedup table is gone, so retries after a deploy re-send.
- **Doesn't span instances** — two pods each have their own map; a retry routed to a different pod re-sends.
- **Grows without bound** — entries never expire → OOM. It needs a TTL (Caffeine `expireAfterWrite`).
- **Holds the bin lock across I/O** — `save()` inside the lambda is a DB round-trip under the CHM bin lock, blocking other threads that hash to that bin. Fine for an in-memory repository; an anti-pattern over real I/O.

The durable answers:

1. **A DB unique constraint** — `UNIQUE (customer_id, idempotency_key)`; let Postgres reject the duplicate (`ON CONFLICT DO NOTHING`, or catch the constraint violation and then read back the existing row). It survives restarts, spans instances, and needs no app-level lock.
2. **Redis `SET key value NX EX ttl`** — an atomic "set if absent" with expiry; the cross-instance equivalent of `computeIfAbsent` with a TTL.

In one sentence: _"An in-process map deduplicates only while its successful mapping remains present. For multi-instance durability I need durable identity and atomic local writes, usually backed by a unique constraint. External calls still need downstream idempotency and recovery: neither a map nor a Redis claim makes the remote side effect atomic with my result record."_

## Client side — where the idempotency key comes from (the frontend half)

The server dedupes on the key, but the key is **generated on the client**, almost always with the browser-native `crypto.randomUUID()` (a v4 UUID; it needs a secure context / HTTPS; fall back to the `uuid` package for ancient browsers). The subtlety is _when_ you generate it:

- **The key must be stable across retries of the same logical attempt, and unique per new attempt.** Regenerate it on every retry and you've defeated the whole mechanism — the server sees each retry as a brand-new write.

```tsx
// ❌ new key every call → retries are NOT deduped → double charge
fetch('/api/pay', { headers: { 'Idempotency-Key': crypto.randomUUID() }, ... });

// ✅ generated ONCE per attempt, reused on every retry of THIS attempt
const idempotencyKey = useRef(crypto.randomUUID());  // survives re-renders
const pay = async () => {
  if (status === 'submitting') return;               // double-submit guard
  await fetch('/api/pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
               'Idempotency-Key': idempotencyKey.current },  // header, not body (Stripe convention)
    body: JSON.stringify({ orderId, amount }),
  });
};
```

(Why `useRef` works here: it returns the same object on every render — see [React rendering and hooks internals](/posts/react-rendering-and-hooks-internals/).)

- **Rotate the key only on a deliberately new attempt** (the user changed the amount/cart and retries). Reuse it for network blips, timeouts, redeliveries, and button-mashing.
- **`useRef` is lost on page reload — persist the key if the flow can survive a refresh.** Use `sessionStorage` (per tab, cleared when the tab closes → it scopes the key to _this_ attempt), **not** `localStorage` (which persists across tabs and restarts forever — a stale, week-old key could be reused on an unrelated payment). If you must use `localStorage`, attach an explicit expiry and clean it up.

### Generic POST vs. money movement — two different patterns

A client-generated `Idempotency-Key` is the pattern for generic **"do this once"** POSTs (create an order, submit a form). When **actual money moves**, the client does _not_ mint the key from thin air — the backend owns a stateful payment resource, and three things change:

1. **The backend talks to the bank/PSP, not the frontend.** Frontend → your backend ("initiate payment for order X") → the backend calls the PSP server-to-server (secrets never reach the browser) and gets a redirect/hosted URL → the backend returns that URL → the frontend just does `window.location =` to it. The frontend's job is **navigation**, not an API call to the bank.
2. **What the backend returns is the deduped _resource_, not "the key".** The key — or, for checkout, the natural `UNIQUE(order_id)` anchor — is the _input_ that lets the backend dedupe; what it returns is the payment-order id + status + redirect URL. A retry or refresh recognizes "same order/key → payment order P already created with URL U" and returns the _same_ P/U — never a second payment at the bank. (Often you don't even need a client key here: the order id _is_ the idempotency anchor.)
3. **Confirmation is async via webhook — the redirect is not the source of truth.** After the user finishes at the bank, the browser returns to your return URL (which can be faked, abandoned, or lost to a network drop), but the **bank calls your backend via webhook** with the authoritative `PAID`/`FAILED`. The return page **polls your backend** and shows success only once the webhook-updated status says so. This is "pessimistic confirmation".

```text
Frontend            Your Backend               Bank / PSP
   │ 1. POST /payments     │                         │
   │    (order X)  ───────►│ 2. dedupe (UNIQUE/cache)│
   │                       │ 3. create order ───────►│
   │                       │◄── redirectUrl + id     │
   │◄ {redirectUrl, id} ───│ 4. store {id, PENDING}  │
   │ 5. window.location ────────────────────────────►│ (pick bank, auth, consent)
   │                       │◄ 6. WEBHOOK status=PAID │ ← source of truth
   │ 7. poll status ──────►│   update {id, PAID}     │
   │◄ PAID → show success ─│                         │
```

Steps 2–3 are the same server-side machinery as the rest of this post (`UNIQUE` / `computeIfAbsent`) — a retry of step 1 (a double-click, a refresh, a network blip) returns the _same_ payment order, never a duplicate at the bank. Mature PSPs (Stripe PaymentIntents, Adyen) wrap this in a resource with a **state machine** (`requires_confirmation → processing → succeeded`), so a second confirm returns the current state instead of re-charging.

Two complementary layers: the **frontend** = disable-on-submit + a stable key + polling for webhook-confirmed status (UX guards); the **backend** = everything above (the real exactly-once guarantee, the server-to-server bank integration, and webhook reconciliation).

## Gotchas

- **`computeIfAbsent` records nothing on throw — rely on it, but only for _transient_ failures.** A permanently failing request (e.g., a bad downstream config) will re-run the lambda on every retry instead of failing fast. If you need to memoize a _failure_, that's a deliberate negative cache, not the default behavior.
- **Reject conflicting key reuse.** Store and compare the relevant canonical parameters — Stripe checks parameter equality, and a 409 for a different valid payload is a reasonable response. A mismatched retry must not silently execute a second intent.
- **Validate before touching the map.** If validation lived inside the lambda, it would throw under the bin lock (ugly) — and on a key _hit_ the lambda doesn't run, so validation would be skipped on retries. Validate up front, always.
- **String-concatenated composite keys silently collide.** `a + ":" + b` is ambiguous if either part can contain the delimiter. Records (or length-prefixing) remove the ambiguity. This is the leak sneaking back in through the key construction.
- **`status="QUEUED"` is a promise about the transaction, not the physical row.** With JPA, `save()` queues an INSERT that becomes durable when the `@Transactional` boundary commits — i.e., when the method returns. For external side effects (calling a downstream provider), you need the outbox pattern, so the intent is durable before any external dispatch.
- **Idempotency key ≠ message id.** The client supplies the idempotency key; the server generates the message id. They're different identifiers with different owners. Returning the _message id_ keyed by the _idempotency key_ is the whole point.
- **Generating the key inside the fetch call defeats it.** Calling `crypto.randomUUID()` per request gives every retry a new key → no dedup. Generate it once per attempt (`useRef`), reuse it on retries, and persist it (`sessionStorage`) if the flow can survive a reload.

## References

- Earlier in this topic:
  - [At-least-once delivery → exactly-once effect](/posts/at-least-once-to-exactly-once-effect/) — the consumer-side mirror: dedup of _delivered_ events rather than _requests_.
  - [Streaming dedup + ordered emission](/posts/streaming-dedup-and-ordered-emission/) — stream-side id dedup.
- Related: [Thread-safety taxonomy and concurrent collections](/posts/thread-safety-taxonomy-and-concurrent-collections/) — `computeIfAbsent` atomicity and the cache-stampede version of the same race.
- [Stripe — Idempotent requests](https://docs.stripe.com/api/idempotent_requests) — parameter comparison and execution-dependent result retention.
