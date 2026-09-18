# ETA-E31 — ATOMICITY PRD · BATCH 1 · 16 Sep 2026 · Orchestrator

Evidence: `ETA-E31-ATOMICITY-SURVEY-16-SEP-2026.md` (commit `c5b892b`). Read it first; this document does not
repeat its findings, it decides what to do about seven of them.

**ALL DESIGN DECISIONS BELOW ARE SETTLED. A builder must not re-open one. Anything this PRD genuinely does not
settle is flagged in the report, never decided silently.**

---

## 0. DECISIONS LOG — ratified by V, 16 Sep 2026

| # | Decision | Rejected alternatives |
|---|---|---|
| D-1 | **Batch 1 is seven sites**: A1, A2, A4, A7, A12, D3, D1 — the patient-audio pipeline's two CRITICALs and three HIGHs, plus the security one and the audit-trail one. | All 12 of group A; all 19 "reader cannot tell"; A1+A2 only. |
| D-2 | **The default cure is ONE STATEMENT (a CTE) wherever the effect is expressible as one.** Atomic under autocommit, no transaction, no driver dependency — it cannot half-land by construction. `sql.transaction([...])` is the fallback, used only where one statement is genuinely impossible, and the report must say why. | transaction-array by default; per-site builder judgement. |
| D-3 | **Where atomicity is out of reach (two connections / an HTTP hop), make the half-state LEGIBLE** — intent before the act, outcome after, and never report success the database does not support. The model is `lib/bench-reaper.ts:80` (D8), the survey's best-behaved site. | Reconciliation sweeper; moving connections now. |
| D-4 | **All ten unpinned order-dependent sites get pinned**, R52-style. Those inside batch 1 are pinned by batch 1; the other eight are a separate mechanical pass. | Pin only what is touched; skip on the grounds that atomicity moots order. |

**The constraint every cure must survive (survey §2a):** the Neon HTTP handle's `sql.transaction()` is
**non-interactive** — an array of queries fixed before the first runs, with **no application logic between
them**. 36 of 40 sites use that handle. Any cure that needs to read a service, branch on a result, or loop
between its writes cannot be a transaction array and must become one statement or be restructured.

**The precedent:** `lib/stt/silence.ts:509` (E18's bulk apply) already does exactly what D-2 asks — one
`WITH bound/picked/moved/stamped` CTE that moves the rows and writes the ledger together. Copy that shape.

---

## 1. THE PRINCIPLE THIS BATCH ENFORCES

> **A write that half-lands must never read as success, and must never read as never-started.**

Nineteen sites currently break that. Seven of them are fixed here. The failure we keep meeting — proven once in
production as A1 — is not "a statement failed". It is **a statement failed and the statement that was supposed
to record the failure failed too, for the same reason**. A cure that only wraps the happy path is not a cure.

---

## 2. THE SEVEN SITES — WHAT TO BUILD

### A1 · CRITICAL · the span rows and the window row land together
`lib/emotion/store.ts:79`, `lib/jobs/kinds/emotion-window.ts:221/267`

**Cure (D-2).** One statement. The per-segment `INSERT INTO room_span_emotion` loop becomes a **single multi-row
insert**, and that insert and the `room_emotion_window` row become **one CTE**: spans inserted in a CTE whose
result feeds the window-row write. Either both land or neither does.

**And the part that actually bit us.** The failure path must be able to record its own failure. `fail()` must be
**one statement** that records the failed state AND counts the attempt. If that single statement itself throws,
the catch must not let the original error escape unrecorded: log it and rethrow a **distinct named error**
(`emotion_bookkeeping_failed`) carrying both causes, so the window is never retried for ever with an attempt
count that never moves.

**Do not** change `EMOTION_MAX_ATTEMPTS`, the enqueue scan's predicate, or the prefilter.

### A2 · CRITICAL · stop deleting spans before the replacement exists
`lib/emotion/store.ts:57` (`clearWindowSegments`), called from `emotion-window.ts:160`

**Cure (D-2).** **Move the DELETE out of the `prepare` step.** It currently runs a whole job step — a durable
crash boundary — before the replacement rows exist. The delete of the previous run's spans becomes part of the
**same CTE that writes the window row at finish** (`finishEmotionWindow`, `store.ts:320`). Until finish, the
window keeps the previous run's spans and the previous window row: a consistent earlier state, not a lie.

**Accepted and NOT in scope:** the enqueue scan still cannot detect an `ok` row over a disagreeing span count.
That detection gap is deferred to batch 2 and must be named in the report, not fixed here.

### A4 · HIGH · the window state and the job state land together
`lib/stt/room-drain.ts:1299` `[HTTP-shaped]`

**Cure (D-2).** One CTE: the guarded `bench_window` update and the `stt_subject_job` update in a single
statement, the job update conditional on the window update having matched. Preserve the existing guards
(`AND state = 'transcribing'`) exactly. **Pin the order** (D-4) with a test.

### A7 · HIGH · never delete a transcript before its replacement exists
`lib/stt/room-drain.ts:1013` `[HTTP-shaped]`

**Cure (D-2).** One CTE: `DELETE FROM transcription_run …` and the `INSERT` of the new run in one statement, the
delete expressed so it cannot commit without the insert. A window must never pass through a state with no run
row at all.

### A12 · HIGH · closing a window and queueing it are one act
`lib/bench-window.ts:378/399`

**Cure (D-2).** One CTE: the guarded close (`AND state = 'open' RETURNING id`) and the `enqueueSubject` insert in
one statement, the insert fed by the close's RETURNING so it cannot happen without it.

**Also: delete the silent swallow.** The `try { } catch { }` at `:399` has no log line at all. After the cure it
should not exist; if any residual best-effort write remains, it logs like every other one in the file. **Pin the
order** (D-4).

### D3 · HIGH · SECURITY · a lockout must never report a lock it did not take
`lib/lockout.ts:87-150`

**Cure (D-2 + D-3).** The decision returned to the caller must be **derived from what the database actually
did**, never from in-memory state. Collapse the attempt insert and the clinician update into **one statement
with `RETURNING`**, and compute the returned `{kind}` from the returned row. If the statement fails, the
function returns a failure — it must be impossible to answer `{kind:"locked"}` or `{kind:"disabled"}` when no
row changed.

**This is the one site where being wrong is a security outcome, not a bookkeeping one. If the cure forces a
behaviour change at a caller, STOP and report rather than choosing.**

### D1 · HIGH · AUDIT · `audited` must mean the audit row exists
`lib/brain/fuse/visit-update.ts:143/189`, `lib/mcp/tools/fuse.ts:243/290`

**Cure (D-3), not D-2** — this spans two roles and atomicity is out of reach.
1. `fuse.ts:290` currently returns `audited: postClose` — a boolean computed from *state*, so a caller is told
   `audited: true` when the audit write failed. **It must report what actually happened**: audited only if the
   `audit_log` insert returned a row.
2. Write **intent before the act and outcome after**, D8-style, so a reader can always distinguish a crash from
   success.
3. The existing `console.warn` at `:194` stays, but it is no longer the only evidence.

**Do not** attempt to move these onto one connection. That is a later decision, now known to be possible
(survey §2b: one database, two roles), and it is out of scope here.

---

## 3. WHAT MUST NOT CHANGE

- Any guard predicate on an existing UPDATE (`AND state = …`). Collapsing statements must preserve every guard.
- `EMOTION_MAX_ATTEMPTS`, the enqueue scan predicates, the auto-drain cooldown, `AUTO_DRAIN_MAX_AGE_HOURS`.
- The E16 line (`d861abf`), the E18 line, migration 0101, the eleven id tokens in public history.
- The keep-rule at `lib/stt/diarize-window.ts:285` (R10).
- No new migration in batch 1. If a cure appears to need one, STOP and report.

---

## 4. VERIFICATION — WHAT A CURE MUST PROVE

Per site, and this is the bar:

1. **A failure-injection test.** Make the statement fail and assert the database is in the *earlier* state, not a
   half-state. Asserting the happy path proves nothing about atomicity.
2. **A mutant that splits the statement back into two** must go RED. That is the only test that proves the
   atomicity rather than the behaviour — if splitting the CTE keeps the suite green, nothing has been pinned.
3. **For A1 specifically:** a test where the primary write AND the bookkeeping write both fail, asserting the
   attempt is still counted and a named error surfaces.
4. **For D3:** a test where the update affects zero rows, asserting the caller is NOT told a lock was taken.
5. **Order pins (D-4)** for A4 and A12: reverse the production order and confirm RED.
6. Full gate, Docker up, no exclusions. Mutation check with caught-of-run and equivalents named honestly.

---

## 5. FLAG, DO NOT IMPROVISE

If a site cannot be expressed as one statement, say so and say **why**, then use `sql.transaction([...])` and
state whether the sequence is `[HTTP-shaped]`. If it is `[interleaved]` and restructuring it would change
behaviour a caller can observe, **STOP and report** — that is a design decision and it is not the builder's.


---

## ADDENDUM 1 — 16 Sep 2026, after the half-B refutation. **D-2 WAS INCOMPLETE.**

The Refuter measured a regression half B introduced and did not flag: `pin_attempt` was **two things at once** —
the lockout's counter *and* the rate limiter's evidence (`preAttemptCheck`, 1/sec and 60/hr, counts those rows).
The old attempt INSERT was its own statement, so it survived a `clinician` failure. Collapsing it into the CTE
means it now rolls back with the clinician update. Measured under an injected clinician failure, 12 wrong pins:
**NEW → 0 attempt rows, no throttle. OLD → 12 rows, rate_limited.** The cure disarmed the last throttle that
still worked while the clinician table was degraded.

**D-5 — THE COUPLING-SCOPE CHECK. Mandatory before collapsing any two writes into one statement:**

> **Who else reads these rows, and do they want the same failure domain?**

Collapsing is right when the two writes are **two halves of one fact** (A4's window+job, A7's delete+insert).
It is **wrong when one of the writes is also independent evidence for a third party** — atomicity then merges
failure domains that were deliberately separate, and disarms the other reader silently, with every test green.

This check applies to **every site in this programme, including the ones already built**. A site that fails it
does not get a CTE; it keeps its writes separate and gets legibility (D-3) instead.

**D-2 is amended:** one statement is the default cure *for writes that are two halves of one fact*. It is not
the default for a write that anything else depends on independently.
