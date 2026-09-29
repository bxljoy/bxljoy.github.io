---
title: "Postgres isolation levels, MVCC, and the two anomalies that actually bite"
description: "Isolation levels are a dial, not a guarantee. How Postgres really implements them with MVCC, and why lost updates and write skew — not the anomalies in the textbook table — are the ones that break production systems."
pubDatetime: 2026-09-29T12:00:00+02:00
tags: [postgres, transactions, mvcc, isolation-levels]
sourceNotes: [database-isolation-levels-mvcc-and-anomalies]
---

Here's a bug that ships all the time:

```sql
-- Two requests withdraw 80 from a wallet holding 100, at the same moment.
SELECT balance FROM wallet WHERE id = 1;   -- both read 100
-- application code: 100 - 80 = 20
UPDATE wallet SET balance = 20 WHERE id = 1;  -- both write 20
```

Both withdrawals succeed. The wallet ends at 20 instead of rejecting the second one. Everything ran inside a transaction, on Postgres, at the default isolation level — and it was still wrong.

The "I" in ACID isn't a guarantee you either have or don't. It's a dial, and the default setting permits this bug. To pick the right setting you need to know three things: which anomalies exist, which ones each level actually prevents _in your database_ (not in the SQL standard), and how MVCC produces that behavior.

## Table of contents

## The anomalies

An isolation level is a statement about which anomalies you're willing to tolerate in exchange for concurrency. The SQL standard names three; two more that it left out cause most real bugs.

| Anomaly                 | What happens                                                                                                                      | Example                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Dirty read**          | You read another transaction's _uncommitted_ write                                                                                | T1 debits but hasn't committed; T2 reads the lower balance; T1 rolls back. T2 acted on data that never existed |
| **Non-repeatable read** | Reading the _same row_ twice gives different values                                                                               | T1 reads balance = 100; T2 commits balance = 50; T1 re-reads and gets 50                                       |
| **Phantom read**        | Re-running the _same query_ returns a different _set of rows_                                                                     | T1 counts `OPEN` orders → 5; T2 inserts an `OPEN` order; T1 re-counts → 6                                      |
| **Lost update**         | Two read-modify-write cycles overlap; one silently overwrites the other                                                           | The wallet example above                                                                                       |
| **Write skew**          | Two transactions read overlapping data, then each writes a _different_ row. Each is valid alone; together they break an invariant | Two on-call doctors each check "someone else is on call", each goes off call → nobody is on call               |

The last two aren't in the ANSI definitions. Keep that in mind when reading the next table.

## The standard's table — and why it misleads

This is what the SQL standard says each level allows:

| Level            | Dirty read | Non-repeatable read | Phantom read |
| ---------------- | ---------- | ------------------- | ------------ |
| Read Uncommitted | possible   | possible            | possible     |
| Read Committed   | prevented  | possible            | possible     |
| Repeatable Read  | prevented  | prevented           | possible     |
| Serializable     | prevented  | prevented           | prevented    |

The problem is that this table was written with lock-based databases in mind. Modern engines use MVCC instead, so the level names end up meaning something different — usually _stronger_ than the table says, in some places weaker in ways the table can't express. It also says nothing about lost updates or write skew. This critique is well known (Berenson et al., _A Critique of ANSI SQL Isolation Levels_); in practice, reason from your engine's documented behavior, not from this table.

## What Postgres actually does

Postgres defaults to **Read Committed**.

| Postgres level   | Implemented as                                        | Dirty | Non-repeatable | Phantom | Lost update | Write skew |
| ---------------- | ----------------------------------------------------- | ----- | -------------- | ------- | ----------- | ---------- |
| Read Uncommitted | Same as Read Committed                                | no    | **yes**        | **yes** | **yes**     | **yes**    |
| Read Committed   | New snapshot **per statement**                        | no    | **yes**        | **yes** | **yes**     | **yes**    |
| Repeatable Read  | **Snapshot isolation** — one snapshot per transaction | no    | no             | no¹     | no²         | **yes**    |
| Serializable     | **SSI** — snapshot isolation plus conflict detection  | no    | no             | no      | no          | no         |

¹ Stronger than the standard requires: the snapshot hides rows inserted after it was taken.
² If two Repeatable Read transactions update the same row, the second one is aborted with a serialization error (SQLSTATE `40001`) rather than silently overwriting.

Three things stand out:

- **Postgres has no real Read Uncommitted.** Asking for it gets you Read Committed. Dirty reads can't happen.
- **"Repeatable Read" is really snapshot isolation.** No phantoms, but write skew is still allowed.
- **Serializable can abort your transaction** with `40001`. Code that uses it needs a retry loop.

MySQL's InnoDB is a useful contrast. It defaults to **Repeatable Read**, and prevents phantoms there using _next-key locks_ (row locks plus locks on the gaps between index entries) rather than pure snapshots. Same level name, different mechanism, different failure modes — gap locks are a common source of surprising deadlocks. When you talk about isolation levels, always say which engine you mean.

## How MVCC produces this behavior

MVCC stands for _multi-version concurrency control_. Instead of locking a row to change it, Postgres writes a new version of the row and keeps the old one around until nobody can see it any more.

- Every row version (a _tuple_) carries two hidden columns: **`xmin`**, the ID of the transaction that created it, and **`xmax`**, the ID of the transaction that deleted or replaced it.
- A transaction works from a **snapshot**: the set of transaction IDs it treats as committed.
- A tuple is **visible** if its `xmin` is committed and in the snapshot, and its `xmax` isn't.
- **`UPDATE` doesn't modify in place.** It inserts a new tuple and stamps the old one's `xmax`. `DELETE` just stamps `xmax`.

That one design explains the whole table above:

- **Readers never block writers, and writers never block readers.** A reader keeps seeing the version in its snapshot while a writer creates the next one. (Two writers on the _same row_ still block each other.)
- **Read Committed** takes a fresh snapshot at the start of _each statement_, so you see other transactions' commits between your statements — that's the non-repeatable read.
- **Repeatable Read** takes _one_ snapshot at the first statement and keeps it, so the whole transaction sees a stable world.

The cost is **dead tuples**. Old versions stay on disk until `VACUUM` (usually autovacuum) reclaims them. A long-running transaction holds back that cleanup for the whole database, which is why keeping transactions short matters even when they're only reading.

## The two anomalies that actually bite

### Lost update

Back to the wallet. Read Committed doesn't help here, because each statement is atomic but the read-modify-write spans two statements with application code in between. You have four options:

| Fix                  | How                                                                       | When                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Atomic update**    | `UPDATE wallet SET balance = balance - 80 WHERE id = 1 AND balance >= 80` | Simple counters and balances. The database does the check and the write in one step; zero rows affected means insufficient funds |
| **Pessimistic lock** | `SELECT … FOR UPDATE`, then `UPDATE`                                      | You need to read the row, run logic, then write. Writers queue on the row                                                        |
| **Optimistic lock**  | A version column: `UPDATE … WHERE id = ? AND version = ?`                 | Conflicts are rare; on conflict, retry                                                                                           |
| **Higher isolation** | Repeatable Read or Serializable                                           | The engine aborts the loser with `40001`; you retry                                                                              |

For the wallet, the atomic update is the simplest correct answer. It's effectively compare-and-swap, expressed in SQL.

### Write skew

This is the one snapshot isolation can't stop, and it's the classic reason to reach for Serializable.

```sql
-- Invariant: at least one doctor must stay on call.
-- Alice and Bob are both on call; each runs this in their own transaction:
SELECT count(*) FROM doctors WHERE on_call = true;       -- both see 2: safe to leave
UPDATE doctors SET on_call = false WHERE name = 'Alice'; -- Alice's transaction
UPDATE doctors SET on_call = false WHERE name = 'Bob';   -- Bob's transaction
-- Both commit. Zero doctors on call.
```

Under Repeatable Read, this goes through. The two updates touch _different_ rows, so there's no write-write conflict for Postgres to detect, and each transaction's decision was correct against its own snapshot.

Only two things prevent it:

- **Serializable.** Postgres's SSI tracks read-write dependencies between concurrent transactions, notices that this pair can't be put in any serial order, and aborts one with `40001`.
- **Making the conflict explicit.** Lock the rows you read with `SELECT … FOR UPDATE`, or have both transactions lock a shared "guard" row, so they can't both proceed.

The intuition "snapshot isolation is basically serializable" is exactly what write skew breaks.

## Choosing a level

- **Default to Read Committed** for most work, and protect every read-modify-write with an atomic update or an explicit lock. Don't rely on the isolation level for that.
- **Use Repeatable Read** when one transaction runs several reads that must agree with each other: reports, exports, consistency checks.
- **Use Serializable** when correctness depends on an invariant that spans rows and can't be expressed as a single lock — the write-skew shape — and you'd rather the database guarantee it.
- **Make Repeatable Read and Serializable transactions retryable**: short, and free of side effects outside the database, so running them twice is safe.

In Spring, that last point usually looks like this (using spring-retry):

```java
@Retryable(retryFor = CannotSerializeTransactionException.class,
           maxAttempts = 3, backoff = @Backoff(delay = 50, multiplier = 2))
@Transactional(isolation = Isolation.SERIALIZABLE)
public void scheduleShift(ShiftRequest request) { ... }
```

Spring translates Postgres's `40001` into `CannotSerializeTransactionException`, so the retry catches exactly the conflicts SSI reports.

## Gotchas

- **The standard's table is not how your database behaves.** Reason from MVCC and your engine's documentation.
- **Postgres and MySQL have different defaults** (Read Committed vs Repeatable Read), so the same code can have different bugs on each.
- **Read Committed does not prevent lost updates.** This is the most common real correctness bug in this area.
- **Higher isolation isn't free.** It trades silent corruption for visible aborts, costs throughput under contention, and needs retry logic. Use the lowest level that's correct, plus targeted locking.
- **Long transactions cost everyone.** A long Repeatable Read report pins old row versions and holds back vacuum for the whole database. Run heavy reports on a replica if you can.
- **`@Transactional(readOnly = true)` isn't an isolation level.** It's a hint to the driver and ORM; it doesn't change which anomalies you're exposed to.
- **"Phantom read" and Hibernate's "phantom write" are unrelated.** The first is the isolation anomaly above; the second is a change made outside any transaction that's silently lost. Same word, different problems.

## Further reading

- Martin Kleppmann, _Designing Data-Intensive Applications_, chapter 7 (Transactions) — the best treatment of these anomalies.
- Berenson et al., _A Critique of ANSI SQL Isolation Levels_ (1995).
- Cahill, Röhm, Fekete, _Serializable Isolation for Snapshot Databases_ (2008) — the paper behind Postgres's SSI.
- PostgreSQL documentation: [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html).
