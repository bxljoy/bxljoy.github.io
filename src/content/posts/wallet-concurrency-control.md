---
title: "Wallet concurrency control: pessimistic lock, optimistic lock, append-only ledger"
description: "The TOCTOU race in every balance update, three ways to fix it — SELECT FOR UPDATE, @Version, and an append-only ledger — their trade-offs and when to use each, and why lock retries and network retries are orthogonal concerns."
pubDatetime: 2026-10-02T13:17:00+02:00
tags: [jpa, concurrency, locking, idempotency]
sourceNotes: [wallet-concurrency-control-pessimistic-optimistic-ledger]
---

> Three strategies handle concurrent writes to money/balance state, each with very different trade-offs. Pessimistic = "lock first, work later" (`SELECT FOR UPDATE`). Optimistic = "work first, check at commit" (`@Version`). Ledger = "don't update, append" (INSERT-only; balance = `SUM`). Lock strategy and idempotency are **orthogonal** — network retries are an idempotency-key concern, not a lock-strategy concern.

## Table of contents

## Overview

Any code that updates a balance — a wallet debit, a pooled contribution, a transfer, a withdrawal — has a Time-Of-Check-To-Time-Of-Use (TOCTOU) race: two concurrent threads read the same balance, both pass the "sufficient funds" check, and both write. The DB is honest and commits both UPDATEs, leaving the account negative. This is THE bug to look for in any fintech wallet review. Three patterns fix it; the right choice depends on the contention level, audit requirements, and read/write ratio. This post also covers the most common conceptual mix-up: confusing **lock retry** (a server-side conflict) with **network retry** (a client-side timeout) — these need different solutions and are orthogonal.

## Key points

- **The race is in the read-then-check-then-write pattern.** Read the balance → check it's sufficient → write the new balance. Without protection, two threads can interleave and both succeed.
- **Pessimistic lock** = take a row lock at read time (`SELECT ... FOR UPDATE`). Other writers block. Simple and correct, but it serializes hot rows.
- **Optimistic lock** = no lock is taken; every row carries a `@Version`, and the UPDATE succeeds only if the version is unchanged. It throws `OptimisticLockException` on conflict → the application retries.
- **Append-only ledger** = never UPDATE the balance. INSERT every debit/credit. Balance = `SUM(amount)`. Audit comes for free, regulators love it, and there's no row contention on writes.
- **At high transaction volumes, locks become bottlenecks on hot rows.** A ledger + Kafka-partitioned writers is the canonical pattern.
- **Lock strategy and idempotency are orthogonal.** Network retries (client-side flakiness) are solved by idempotency keys, not by picking pessimistic locks.
- **No external API calls inside `@Transactional`.** That's the dual-write problem — see [the outbox pattern](/posts/outbox-pattern-and-dual-write-problem/).

## The race condition

```java
@Transactional
public void transfer(Long from, Long to, BigDecimal amount) {
    var sender = walletRepo.findById(from).orElseThrow();   // READ
    if (sender.getBalance().compareTo(amount) < 0) {        // CHECK
        throw new InsufficientFundsException();
    }
    sender.debit(amount);                                    // WRITE
    walletRepo.findById(to).orElseThrow().credit(amount);
}
```

Two concurrent transfers from the same account, with balance = 100 and amount = 80 each:

```
Thread A: read balance = 100
Thread B: read balance = 100
Thread A: check 100 >= 80 ✓
Thread B: check 100 >= 80 ✓
Thread A: debit → balance = 20
Thread B: debit → balance = 20  ← should be -60!
```

Both UPDATEs commit, and the account has just gone 60 negative. Wrapping it in `@Transactional` doesn't help — the transaction commits cleanly; the bug is in the application logic, not the DB.

## Option 1 — Pessimistic lock

**Mental model:** "I'm going to use this row. Nobody else touches it until I'm done."

### At the SQL level

```sql
BEGIN;
SELECT balance FROM wallet WHERE id=1 FOR UPDATE;  -- acquires row-level X lock
UPDATE wallet SET balance = 20 WHERE id=1;
COMMIT;  -- lock released
```

Other transactions doing `SELECT ... FOR UPDATE` or `UPDATE` on the same row **block** until your transaction ends. A plain `SELECT` (without `FOR UPDATE`) can still proceed, depending on the isolation level.

### JPA / Spring Data

```java
public interface WalletRepository extends JpaRepository<Wallet, Long> {
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT w FROM Wallet w WHERE w.id = :id")
    Optional<Wallet> findByIdForUpdate(@Param("id") Long id);
}

@Transactional
public void transfer(Long from, Long to, BigDecimal amount) {
    var sender = walletRepo.findByIdForUpdate(from).orElseThrow();  // row locked
    if (sender.getBalance().compareTo(amount) < 0) throw new InsufficientFundsException();
    sender.debit(amount);
    var receiver = walletRepo.findByIdForUpdate(to).orElseThrow();
    receiver.credit(amount);
}  // commit → both locks released
```

### Pros and cons

- ✅ Simple to reason about. Reads see the committed truth; no surprise rollbacks.
- ✅ Correct under all isolation levels.
- ✅ No entity changes needed.
- ❌ A row lock = serialized contention. Hot accounts (e.g. a shared pool account that receives credits from every user) become a bottleneck.
- ❌ Deadlock risk if multiple rows are locked in an inconsistent order. Mitigation: always lock in a deterministic order (e.g. sort wallet IDs ascending).
- ❌ It holds a DB connection for the whole transaction → connection pool exhaustion under long transactions.
- ❌ Lock waits can pile up — set `javax.persistence.lock.timeout` so threads fail fast instead of hanging.

### When to use it

- Few concurrent writers per row
- Operations are short
- You can't tolerate retries (the logic isn't easily retried)
- The default for "boring" CRUD where contention is low

## Option 2 — Optimistic lock

**Mental model:** "I bet nobody else is touching this row. If I'm wrong, I'll find out at commit time and retry."

### At the SQL level

```sql
SELECT id, balance, version FROM wallet WHERE id=1;       -- balance=100, version=7
-- ... business logic ...
UPDATE wallet
   SET balance=20, version=8
 WHERE id=1 AND version=7;
-- rows_affected = 1 → success
-- rows_affected = 0 → someone else won, throw OptimisticLockException
```

The `WHERE version=7` clause is the magic. If another transaction committed `version=8` first, your UPDATE matches zero rows.

### JPA

```java
@Entity
public class Wallet {
    @Id Long id;
    BigDecimal balance;

    @Version
    Long version;   // ← that's it. JPA handles the rest.
}
```

The concurrent transfer scenario:

```
Thread A: read wallet 1, balance=100, version=7
Thread B: read wallet 1, balance=100, version=7
Thread A: commit → UPDATE ... WHERE version=7 → success, version now 8
Thread B: commit → UPDATE ... WHERE version=7 → 0 rows → OptimisticLockException
                                                        → application retries
```

Thread B re-reads, sees `balance=20`, and correctly fails the check.

### A retry wrapper (Spring Retry)

```java
@Retryable(
    retryFor = ObjectOptimisticLockingFailureException.class,
    maxAttempts = 3,
    backoff = @Backoff(delay = 50, multiplier = 2)
)
@Transactional
public void transfer(...) { ... }
```

### Pros and cons

- ✅ No locks held → high throughput when contention is low.
- ✅ The connection is released between the read and conflict detection → the connection pool stays healthy.
- ✅ Scales horizontally better than pessimistic locking.
- ❌ You must handle the retry logic. Forget it, and every conflict becomes a failed user request.
- ❌ Wasted work on conflict — Thread B did all the JPA loading and business logic for nothing.
- ❌ A bad fit for hot rows — 50 threads on one row → most retry, fail, and retry again, and throughput collapses.
- ❌ Side effects in the retried block must be idempotent (don't send an email mid-method — you'll send it twice).
- ❌ Subtle: dirty-checking only triggers the version check if the entity is actually modified. Pure-read code paths won't detect concurrent changes.

### When to use it

- Low-to-medium contention per row
- Read-heavy workloads with occasional writes
- Microservices where holding DB connections is expensive
- **The default choice for most modern Spring + JPA apps**

## Option 3 — Append-only ledger

**Mental model:** "Don't update the balance. Record every movement, and compute the balance from the movements."

### Schema

```sql
CREATE TABLE wallet_entries (
    id           BIGINT PRIMARY KEY AUTO_INCREMENT,
    wallet_id    BIGINT NOT NULL,
    amount       DECIMAL(19,4) NOT NULL,    -- positive = credit, negative = debit
    reason       VARCHAR(50)  NOT NULL,     -- 'PURCHASE', 'REFUND', 'DEPOSIT', etc.
    txn_id       VARCHAR(64)  NOT NULL,     -- idempotency key
    created_at   TIMESTAMP    NOT NULL,

    UNIQUE KEY uniq_txn (txn_id),           -- ← idempotency built in
    INDEX idx_wallet_created (wallet_id, created_at)
);
```

The balance is derived:

```sql
SELECT COALESCE(SUM(amount), 0) FROM wallet_entries WHERE wallet_id = 1;
```

### Code

```java
@Transactional
public void transfer(Long from, Long to, BigDecimal amount, String txnId) {
    var balance = ledgerRepo.balanceOf(from);
    if (balance.compareTo(amount) < 0) throw new InsufficientFundsException();

    ledgerRepo.save(new WalletEntry(from, amount.negate(), "TRANSFER_OUT", txnId + "-out"));
    ledgerRepo.save(new WalletEntry(to,   amount,          "TRANSFER_IN",  txnId + "-in"));
}
```

### Race protection — three options, often combined

The TOCTOU race still exists at the read-then-check step. The solutions:

1. **A DB-level constraint** — a stored procedure or `CHECK` constraint that rejects writes leading to a negative balance.
2. **An optimistic lock on a `wallet_summary` row** — a denormalized `(wallet_id, current_balance, version)` row, version-checked on each transfer. The ledger is the source of truth; the summary is for fast reads + concurrency control.
3. **A single writer per account via a Kafka partition** — events for `wallet_id=1` always go to the same partition and are processed serially by one consumer. This removes the race entirely, without DB locks.

### Pros and cons

- ✅ The audit trail is the data model. Every movement has an immutable row — critical in regulated domains.
- ✅ No UPDATE → fewer write conflicts (inserts on different rows don't fight).
- ✅ Idempotency for free via `UNIQUE(txn_id)` — a duplicate INSERT throws a constraint violation; treat it as success.
- ✅ Time-travel queries: "What was the balance on 2025-12-31?" → `SELECT SUM(amount) WHERE created_at <= '2025-12-31'`.
- ✅ Easy to replay / rebuild state from the log.
- ❌ The balance query is a `SUM` over potentially millions of rows. Reads slow down over time without a snapshot/cache.
- ❌ Mitigation: periodic snapshots — `wallet_balance_snapshots(wallet_id, balance, as_of_entry_id)`. Compute the balance as `snapshot.balance + SUM(amount) WHERE id > snapshot.as_of_entry_id`.
- ❌ More tables, more queries, more code. Higher initial complexity.
- ❌ The race still exists at the application level — it needs one of the strategies above.

### When to use it

- Money / balances / regulated state
- Audit requirements (legal, financial)
- Event-sourced systems
- High-throughput systems where you need to scale writes horizontally

## Decision framework

| Question                                                               | If yes                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Is contention on the row very low?                                     | Optimistic lock                                                      |
| Is contention very high (a hot, shared row)?                           | Append-only ledger + a partitioned writer                            |
| Do regulators or auditors require a movement history?                  | Append-only ledger                                                   |
| Is the operation short, conflicts rare, and you want zero retry logic? | Pessimistic lock                                                     |
| Many readers, few writers?                                             | Optimistic lock                                                      |
| Multiple rows updated together (a transfer)?                           | Lock all of them in a deterministic order (pessimistic), OR a ledger |

## Worked scenarios

### Scenario A — Order checkout (mostly cold accounts, flaky network)

> An optimistic lock + an idempotency key. The wallet is mostly cold — concurrent writes are rare — so optimistic locking gives high throughput without holding a row lock. Network flakiness is a _separate_ concern: require an `Idempotency-Key` header on the checkout endpoint, and dedupe via a `UNIQUE(idempotency_key)` constraint on a request-log table. A second mobile retry hits the unique constraint, is treated as success, and returns the original response.

### Scenario B — A shared pool account (5000 contributions/sec, single shared account)

> An append-only ledger as the source of truth. Partition the contribution stream in Kafka by `pool_id`, so all writes for one pool go to one consumer — that serializes them at the application level, with no row lock needed. For UI display, maintain a denormalized `pool_balance(pool_id, current_balance)` row updated by the same consumer; UI reads accept slight staleness, which is fine for a display figure.

Locking would have been a disaster — pessimistic = 5000 threads queuing on one row; optimistic = a retry storm on every contribution.

### Scenario C — A withdrawal to a bank account (rare, regulatory audit, external API)

> An append-only ledger for audit (non-negotiable, given 7-year retention). But the _real_ concern is the external API call — never call the payment processor from inside `@Transactional` (the dual-write trap). Use [the outbox pattern](/posts/outbox-pattern-and-dual-write-problem/): in one transaction, append the ledger entry, insert the withdrawal request as PENDING, and insert an outbox row. A separate worker reads the outbox, calls the processor with an idempotency key, and marks the row dispatched.

## The two-orthogonal-concerns rule

The most common conceptual mix-up: confusing **lock retry** with **network retry**.

| Type              | Cause                                                                     | Solution                                   |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| **Lock retry**    | The server detects a concurrent conflict (e.g. `OptimisticLockException`) | Spring `@Retryable`                        |
| **Network retry** | The client resends because of a timeout / flaky connection                | An idempotency key + a `UNIQUE` constraint |

These are **independent**. A pessimistic-locked endpoint still needs an idempotency key if clients can retry. An optimistic-locked endpoint needs one too. So does the ledger pattern. **Always think about both; never substitute one for the other.** (See [request idempotency keys](/posts/request-idempotency-keys-for-write-apis/) for the client-retry side.)

## Anchor mnemonic

- **Pessimistic = "lock first, work later"** → `SELECT FOR UPDATE` → blocks others
- **Optimistic = "work first, check at commit"** → `@Version` → throws on conflict, retry
- **Ledger = "don't update, append"** → INSERT-only → `SUM` for the balance, free audit

When you can recite those three lines from memory, you've internalized it.

## Gotchas

- **`@Transactional` alone does not prevent the race.** Transactions ensure ACID at commit time, but the read-check-write race happens within a single transaction's logical operations. You need locking or app-level serialization on top.
- **`SELECT ... FOR UPDATE` on a non-existent row in MySQL** uses gap locks under REPEATABLE READ → it can deadlock with INSERTs into the gap. Either use READ COMMITTED, or `INSERT ... ON DUPLICATE KEY UPDATE`, to avoid the gap.
- **An optimistic lock with no retry** = every conflict surfaces as a 500 to the user. Always pair `@Version` with retry logic.
- **An optimistic lock + non-idempotent side effects in the retried block** = duplicate emails / duplicate webhooks / duplicate metrics. The retried block must be safe to re-run.
- **Pessimistic locking holds the connection for the whole transaction.** Combined with long transactions, this exhausts HikariCP fast. See [connection pool starvation vs. DB contention](/posts/connection-pool-vs-database-contention/).
- **The ledger SUM grows unbounded.** Without snapshots, reads degrade as `wallet_entries` grows. Snapshot periodically (e.g. daily per wallet, or every 1000 entries).
- **Network retry isn't a lock-strategy decision.** Don't pick pessimistic locking just because the network is flaky — pick the right lock for the contention, and add an idempotency key for the network.
- **Deadlock detection isn't free.** MySQL/Postgres detect and kill one transaction → `DeadlockLoserDataAccessException`. Always lock multiple rows in a deterministic order to minimize this.
- **`@Version` on an entity that's only ever read** does nothing. Only INSERTs/UPDATEs to that entity check the version.
- **The isolation level matters for pessimistic locking.** Under READ UNCOMMITTED you can still read uncommitted data, even with a `FOR UPDATE` held by another tx. The default REPEATABLE READ (MySQL) or READ COMMITTED (Postgres) is what you want.

## References

- Earlier in this topic:
  - [Connection pool starvation vs. DB resource contention](/posts/connection-pool-vs-database-contention/) — why long-held pessimistic locks exhaust HikariCP.
  - [Postgres write performance: batching and ON CONFLICT idempotency](/posts/postgres-write-batching-and-idempotency/) — the `ON CONFLICT DO NOTHING` pattern that makes ledger inserts idempotent at scale.
- Related: [The outbox pattern and the dual-write problem](/posts/outbox-pattern-and-dual-write-problem/) — what to do when wallet writes also need to call external systems.
- [Spring Data JPA locking](https://docs.spring.io/spring-data/jpa/reference/jpa/locking.html)
- [Hibernate optimistic locking](https://docs.jboss.org/hibernate/orm/current/userguide/html_single/Hibernate_User_Guide.html#locking-optimistic)
