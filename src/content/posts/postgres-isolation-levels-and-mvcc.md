---
title: "Database isolation levels, MVCC, and the anomalies each prevents"
description: "The four ANSI isolation levels, the anomalies each one permits, how Postgres actually implements them with MVCC, and why lost update and write skew are the anomalies that matter most."
pubDatetime: 2026-09-29T12:00:00+02:00
tags: [postgres, transactions, mvcc, isolation-levels]
sourceNotes: [database-isolation-levels-mvcc-and-anomalies]
---

> The "I" in ACID is a dial, not a guarantee. The four ANSI levels (Read Uncommitted → Read Committed → Repeatable Read → Serializable) each permit a shrinking set of anomalies — dirty read, non-repeatable read, phantom — plus two the standard forgot: **lost update** and **write skew**. Real databases implement isolation with **MVCC** (snapshots over row versions), not locks. So Postgres's "Repeatable Read" is actually _snapshot isolation_: stronger than ANSI (no phantoms), yet it still allows **write skew**, which only `SERIALIZABLE` (SSI) or explicit locking closes. Postgres defaults to **Read Committed**; MySQL InnoDB defaults to **Repeatable Read**.

## Table of contents

## Overview

Isolation is the single-node consistency layer: it sits underneath locking patterns (pessimistic, optimistic, ledger-based) and is the single-node counterpart of _serializability_ in distributed systems. Correctness of anything involving money or shared counters lives here.

The trap is that the ANSI standard's definitions are famously imprecise. Real engines use MVCC, so the level names mean different — usually _stronger_ — things than the standard says, and they differ between Postgres and MySQL. This post pins down:

- the anomalies,
- the real (not ANSI-theoretical) behavior of each level in Postgres and MySQL,
- how MVCC produces that behavior,
- the two anomalies that bite production systems: **lost update** and **write skew**.

## Key points

- **Isolation level = which anomalies you tolerate** in exchange for concurrency. Stronger isolation means more serialization, which means less throughput and more aborted transactions to retry.
- **The three ANSI anomalies:** _dirty read_ (you see uncommitted data), _non-repeatable read_ (a row's value changes within your transaction), _phantom read_ (a row set changes within your transaction — new rows match a re-run query).
- **Two anomalies ANSI omitted but that matter most:** _lost update_ (two read-modify-writes, one silently overwrites the other) and _write skew_ (two transactions read an overlapping set, write disjoint rows, and together break an invariant).
- **ANSI's level definitions are flawed.** Real engines implement MVCC / snapshot isolation, which doesn't map cleanly onto the lock-based ANSI table. Use the _real_ behavior, not the textbook table.
- **MVCC = readers don't block writers, writers don't block readers.** Each row has multiple versions, and each transaction reads from a consistent _snapshot_. This is why Postgres, Oracle, and MySQL InnoDB scale reads.
- **Postgres defaults to Read Committed; MySQL InnoDB to Repeatable Read.** Know your engine's default — it decides which anomalies are live out of the box.
- **Postgres "Repeatable Read" _is_ snapshot isolation.** It prevents phantoms (stronger than ANSI RR) but still allows **write skew**.
- **Postgres "Serializable" = SSI** (Serializable Snapshot Isolation). It monitors read-write dependencies and _aborts_ offending transactions with SQLSTATE `40001` — so you **must** be ready to retry.
- **Read Committed does NOT prevent lost update.** A naive read-modify-write is unsafe at the default level. Fix it with an atomic `UPDATE … SET x = x - n`, `SELECT … FOR UPDATE`, a version column, or `SERIALIZABLE`.

## The anomalies

| Anomaly                 | What happens                                                                                                                           | Example                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Dirty read**          | Read another transaction's _uncommitted_ write                                                                                         | T1 debits, not yet committed; T2 reads the lower balance; T1 rolls back → T2 acted on data that never existed |
| **Non-repeatable read** | Re-reading the _same row_ gives a different value (another transaction committed an UPDATE between your reads)                         | T1 reads balance = 100; T2 commits balance = 50; T1 re-reads → 50                                             |
| **Phantom read**        | Re-running the _same query_ returns a different _set of rows_ (another transaction committed an INSERT/DELETE matching your predicate) | T1: `SELECT count(*) WHERE status = 'OPEN'` → 5; T2 inserts an OPEN row; T1 re-runs → 6                       |
| **Lost update**         | Two read-modify-write cycles overlap; one overwrites the other                                                                         | Both read balance = 100, both write 100 − 80; final = 20 instead of rejecting the second debit                |
| **Write skew**          | Two transactions read an overlapping set, each writes a _different_ row; individually valid, together they break a cross-row invariant | Two on-call doctors each check "≥ 1 other on call" (true), each marks self off-call → zero on call            |
| **Read skew**           | A multi-statement read sees an inconsistent picture (row A from before a transaction, row B from after)                                | Reporting a transfer mid-flight: you see the debit but not the matching credit                                |

## ANSI levels vs. reality

The ANSI table — what the standard _says_:

| Level            | Dirty read | Non-repeatable | Phantom   |
| ---------------- | ---------- | -------------- | --------- |
| Read Uncommitted | possible   | possible       | possible  |
| Read Committed   | prevented  | possible       | possible  |
| Repeatable Read  | prevented  | prevented      | possible  |
| Serializable     | prevented  | prevented      | prevented |

**Why this table is misleading:** it was written for _lock-based_ concurrency. MVCC engines behave differently — usually _stronger_ than the row promises — and the table says nothing about lost update or write skew, which is where real bugs live (Berenson et al., _A Critique of ANSI SQL Isolation Levels_).

### What the levels actually do in Postgres

Postgres defaults to **Read Committed**.

| Postgres level   | Implemented as                                        | Dirty | Non-repeatable | Phantom | Lost update | Write skew |
| ---------------- | ----------------------------------------------------- | ----- | -------------- | ------- | ----------- | ---------- |
| Read Uncommitted | = Read Committed (no dirty reads, ever)               | ✅ no | ❌ yes         | ❌ yes  | ❌ yes      | ❌ yes     |
| Read Committed   | new snapshot **per statement**                        | ✅ no | ❌ yes         | ❌ yes  | ❌ yes      | ❌ yes     |
| Repeatable Read  | **snapshot isolation** (one snapshot per transaction) | ✅ no | ✅ no          | ✅ no¹  | ✅ no²      | ❌ **yes** |
| Serializable     | **SSI** (snapshot + read-write conflict detection)    | ✅ no | ✅ no          | ✅ no   | ✅ no       | ✅ **no**  |

¹ Stronger than ANSI RR — Postgres RR prevents phantoms via the snapshot.
² Postgres RR aborts a conflicting overwrite with a serialization error ("first committer wins"), so simple lost updates surface as `40001` instead of silently corrupting data.

### MySQL InnoDB

MySQL InnoDB defaults to **Repeatable Read**:

- It uses **next-key locks (record + gap locks)** to prevent phantoms in RR — a _lock-based_ mechanism, not pure MVCC. This is also why InnoDB can deadlock on gap locks in ways Postgres doesn't.
- RR uses a consistent snapshot for plain `SELECT`, but locking reads (`FOR UPDATE`) and writes see the latest committed row.

> **Takeaway:** the same level name behaves differently across engines. "Repeatable Read" in Postgres = snapshot isolation; in MySQL = snapshot reads + gap locks. Always state the engine.

## How MVCC works in Postgres

MVCC = **Multi-Version Concurrency Control**. Instead of locking a row to update it, the engine writes a _new version_ and keeps the old one until no transaction can see it any more.

- Every row version (a _tuple_) carries hidden columns **`xmin`** (the transaction id that created it) and **`xmax`** (the transaction id that deleted or superseded it).
- A transaction takes a **snapshot**: the set of transaction ids it considers committed and visible.
- A tuple is **visible** to a transaction if its `xmin` is committed and in the snapshot, and its `xmax` is not (the tuple hasn't been deleted yet, or was deleted by a transaction that is still in flight or started after the snapshot).
- **`UPDATE` is not in-place:** it inserts a new tuple (new `xmin`) and stamps the old tuple's `xmax`. **`DELETE`** only stamps `xmax`.

Consequences:

- **Readers never block writers; writers never block readers.** A reader sees its snapshot's version while a writer creates a newer one. (Writers still block _writers_ on the same row.)
- **Read Committed** takes a _fresh snapshot at the start of each statement_ → you see other transactions' commits between statements, hence non-repeatable reads.
- **Repeatable Read** takes _one snapshot at the first statement_ and keeps it for the whole transaction → a stable view, with no non-repeatable or phantom reads.
- **Dead tuples accumulate.** Old versions become invisible to every snapshot but still occupy pages → **bloat**. `VACUUM` / autovacuum reclaims them; transaction-id wraparound is the extreme failure if vacuum falls too far behind.

## The two anomalies that actually bite

### Lost update

```sql
-- Read Committed (the default). Both sessions:
SELECT balance FROM wallet WHERE id = 1;   -- both read 100
-- the application computes 100 - 80 = 20
UPDATE wallet SET balance = 20 WHERE id = 1;  -- both write 20 → one update lost
```

Read Committed does **not** prevent this. Each statement is atomic, but the read-modify-write spans two statements with application logic in between. The fixes:

| Fix                                | How                                                                       | Note                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Atomic UPDATE**                  | `UPDATE wallet SET balance = balance - 80 WHERE id = 1 AND balance >= 80` | Best for simple counters: the database does the read and write atomically — a compare-and-swap expressed in SQL |
| **Pessimistic lock**               | `SELECT … FOR UPDATE`, then `UPDATE`                                      | Serializes writers on the row                                                                                   |
| **Optimistic lock**                | A version column (`WHERE version = ?`, JPA `@Version`)                    | Fails on conflict → retry                                                                                       |
| **Repeatable Read / Serializable** | The engine aborts the loser with `40001`                                  | Requires retry logic                                                                                            |

### Write skew — what snapshot isolation can't stop

Two transactions read an overlapping dataset, then write **different** rows. Each write is valid against the snapshot it read, but together they violate an invariant that spans rows.

```sql
-- Invariant: at least one doctor must remain on call.
-- T1 (Alice) and T2 (Bob), both currently on call:
SELECT count(*) FROM doctors WHERE on_call = true;         -- both see 2 (≥ 1, safe)
UPDATE doctors SET on_call = false WHERE name = 'Alice';   -- T1
UPDATE doctors SET on_call = false WHERE name = 'Bob';     -- T2
-- Both commit. Now zero doctors are on call. Invariant broken.
```

Snapshot isolation (Postgres Repeatable Read) **allows this**: the two UPDATEs touch different rows, so there is no write-write conflict to detect. Only these prevent write skew:

- **`SERIALIZABLE` (SSI)** — Postgres detects the read-write dependency cycle and aborts one transaction with `40001`, **or**
- **Explicit locking / materializing the conflict** — `SELECT … FOR UPDATE` on the rows you read, or lock a shared "guard" row that both transactions must take.

This is the canonical reason to reach for `SERIALIZABLE`, and it defeats the intuitive assumption that "snapshot isolation is basically serializable."

## Choosing a level

- **Default to Read Committed for most workloads.** Pair every read-modify-write with an atomic UPDATE or an explicit lock — don't lean on the isolation level for that.
- **Repeatable Read** when a transaction runs _multiple reads that must agree_ — reports, exports, consistency checks across statements.
- **Serializable** when correctness depends on an invariant across rows that a single lock can't express (write-skew risk) and you want the database to _guarantee_ it. Budget for retries on `40001`.
- **Always make `SERIALIZABLE` / `REPEATABLE READ` transactions retryable**, short, and free of external side effects, so a retry is safe.

### Spring / JPA

```java
@Retryable(retryFor = CannotSerializeTransactionException.class,
           maxAttempts = 3, backoff = @Backoff(delay = 50, multiplier = 2))
@Transactional(isolation = Isolation.SERIALIZABLE)
public void scheduleShift(...) { ... }
```

`@Transactional(isolation = …)` maps to `SET TRANSACTION ISOLATION LEVEL`. Spring surfaces Postgres `40001` as `CannotSerializeTransactionException` (a `ConcurrencyFailureException`), so the retry (here from spring-retry) catches exactly the conflicts SSI reports.

## Disambiguation: "phantom read" vs. "phantom write"

- **Phantom _read_** = the SQL isolation anomaly above: a re-run query sees newly committed rows. Prevented at Repeatable Read (Postgres) or Serializable.
- **Phantom _write_** = a Hibernate problem: a mutation made _outside_ any transaction (for example with Open Session In View) is silently lost, while the HTTP response still reports success. It has nothing to do with isolation levels — it's about `@Transactional` boundaries.

Same word, unrelated problems.

## Gotchas

- **The ANSI table is not how your database behaves.** It's lock-theoretic and omits lost update and write skew. Reason from MVCC and your engine's real semantics.
- **Postgres has no real Read Uncommitted.** Requesting it gives you Read Committed; dirty reads are impossible in Postgres.
- **Postgres and MySQL pick different defaults** (RC vs. RR). A query that's safe on one can show a different anomaly on the other.
- **"Repeatable Read" means different things per engine.** Postgres = snapshot isolation (no phantoms, allows write skew). MySQL = snapshot reads + next-key/gap locks (prevents phantoms by locking, with deadlock risk on gaps).
- **Read Committed does not prevent lost update.** The most common production correctness bug in this area.
- **Snapshot isolation ≠ serializable.** Write skew is the gap. If an invariant spans multiple rows, RR won't protect it — use `SERIALIZABLE` or explicit locks.
- **`SERIALIZABLE` introduces serialization failures (`40001`).** Without a retry loop, every conflict becomes a user-facing 500. Higher isolation trades silent corruption for visible-but-retryable aborts.
- **Higher isolation is not "just safer, turn it on."** It costs throughput and creates abort/retry load; SSI's predicate tracking can be expensive under contention. Use the _lowest level that's correct_, plus targeted locking.
- **MVCC bloat is the hidden cost.** Every UPDATE leaves a dead tuple; long-running transactions hold back the vacuum horizon, causing bloat and, in the worst case, transaction-id wraparound risk. Keep transactions short.
- **Long-running `REPEATABLE READ` / `SERIALIZABLE` reporting transactions pin old row versions**, blocking vacuum across the whole cluster. Run heavy reports against a replica when possible.
- **`@Transactional(readOnly = true)` is not an isolation level.** It hints the driver and ORM (Postgres can route to a replica, Hibernate skips dirty checking) but doesn't change anomaly exposure.

## References

- Martin Kleppmann, _Designing Data-Intensive Applications_, chapter 7 (Transactions) — the definitive treatment of these anomalies.
- Berenson et al., _A Critique of ANSI SQL Isolation Levels_ (1995).
- Cahill, Röhm, Fekete, _Serializable Isolation for Snapshot Databases_ (2008) — the basis of Postgres SSI.
- PostgreSQL documentation: [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html).
