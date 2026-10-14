# CDMSS rerank telemetry: addendum v4, the real-database measurement pass

**13 August 2026. Revision 2**, after an adversarial pass found three blockers and one
unguarded path to the production database. Section 14 lists them.

---

## 0. Authority and preflight

Governs all work after `d452fecca6851ede6bb34a524bee22f664b76407` on
`exp/rerank-telemetry`.

**Supersedes** addendum v3 where they conflict. The settled decisions that stand are
**v1 section 10** and **v3 section 10**, plus v2's amendments in **v2 section 12**.
Revision 1 of this document cited v2 §10 and v3 §9. Both were wrong: v2 §10 is a gate and
v3 §9 is a findings list.

**Amends v1 decision 10.** That decision fixed the migration ordering as key, then deploy,
then migrate. It never contemplated a migration against a Neon branch from a Preview.
Section 3 sets that ordering, and it does not touch the production ordering, which stands
unchanged.

**Depends on the amendment in section 1.** V signs it before this pass starts. If it is
unsigned, stop and report.

```text
branch:  exp/rerank-telemetry
HEAD:    d452fecca6851ede6bb34a524bee22f664b76407
tree:    clean
```

---

## 1. The amendment V must sign

PRD v2.1 line 267 requires numeric overhead guardrails before a canary. Kickoff D18 line
1032 forbids deploying to measure and confines measurement to a local or test database.
Those two cannot both hold. D18's method excludes the term that decides PRD line 268's
acceptance criterion.

> **Amendment 1 to PRD v2.1 section 6.5 and kickoff D18, made before any canary opens.**
>
> Synthetic microbenchmark evidence, as D18 specifies it, establishes the absence of an
> algorithmic blow-up. It does not set production timing guardrails and may not be used to
> approve a deployment.
>
> A second measurement is authorised and required: a production-shaped run against a
> non-production Neon branch, from a Vercel Preview deployment in the deployment's own
> region. D18's prohibition on deploying to measure is lifted for Preview only. **The
> prohibition on the production database stands without exception, and section 3's
> database-identity guard is the mechanism, not a promise.**
>
> Numeric pre-canary guardrails are set from the second measurement. Canary rollback
> triggers are a separate instrument, preregistered before exposure, and are not a
> substitute for pre-canary evidence.

PRD line 298: an amendment made before a canary opens is not a waiver. This is before.

---

## 2. What is already established

`lab_sql_audit`, 3,250 statements timed inside the app around the database call, 3 July to
13 August:

```
p05 68 ms    p25 112 ms    p50 200 ms    p95 871 ms
```

```
vercel.json:4        "regions": ["bom1"]     Mumbai
Neon project region  ap-southeast-1          Singapore
```

Every statement crosses Mumbai to Singapore. **Two caveats found by attack, both of which
strengthen the case and neither of which the earlier draft carried.** The six sub-10 ms
samples are `lab_source` filesystem reads that never touched Postgres, so the round-trip
floor is cleaner than 68 ms suggested. And every row in that table is an ad-hoc analyst
`SELECT`, not a single-row primary-key `UPDATE`, so using its p05 as the telemetry floor is
an inference and must be labelled as one.

Step 21 measured the same class of operation at 0.1415 ms with the database stubbed.

---

## 3. The route, and its five guards

Create `app/api/admin/telemetry-overhead/route.ts`. **POST only.** `runtime = 'nodejs'`,
`maxDuration = 800`.

This is the only production file this pass adds. Every guard below must be proven by a test
in section 6, in a child process. A guard that exists only in source is not a guard.

**Guard 1. Admin.** `requireAdmin(req)` **alone**. Do **not** copy the migration route's
`|| isAdminUnlocked()` clause. That turns a credential into a browser session. Note that
`lib/admin-gate.ts` returns `null` when `ADMIN_TOKEN` is unset, so this guard is open by
default. It is the weakest of the five and is not load-bearing.

**Guard 2. Preview only.** Refuse unless `process.env.VERCEL_ENV === 'preview'`, **and**
`process.env.VERCEL_GIT_COMMIT_REF === 'exp/rerank-telemetry'`. The second clause is
required because a Preview build carries `VERCEL_ENV=preview` baked in and can later be
promoted to Production, which would serve production traffic from a build this predicate
alone would admit.

**Guard 3. Explicit arming.** Refuse unless `process.env.CDMSS_OVERHEAD_MEASURE === '1'`.

**Guard 4. DATABASE IDENTITY. This is the one that matters.** Revision 1 had no equivalent
and would have permitted a run against production.

Parse the host from `process.env.DATABASE_URL`, extract the Neon endpoint id — the leading
`ep-...` label — and refuse unless it equals `process.env.CDMSS_OVERHEAD_DB_ENDPOINT`,
which V sets to the branch endpoint. Compare the endpoint id only. **Never log, echo or
return any part of the connection string, including in an error message.** On mismatch
return 403 with the word `endpoint_mismatch` and nothing else.

Content cannot substitute for this check. The branch is a copy-on-write clone, so row
counts and schema are identical to production. The host is the only discriminator.

**Guard 5. Expiry.** Hard-code a UTC expiry no later than **2026-08-20** and return 410
after it. Section 12 asks for this route to be deleted before any merge, and a note in a
report is not a mechanism. This is.

### Then, and only then, the route creates its own tables

The Neon branch was cloned from `main`, and `main` has none of the three telemetry tables.
Verified in production: `opd_audit_retrieval_telemetry`, `opd_retrieval_invocations` and
`opd_retrieval_telemetry_failures` are all absent. **So the branch has nothing to write to,
and revision 1 never mentioned it.**

After all five guards pass, the route calls `retrievalTelemetryDdl()` itself and applies it,
exactly as the migration route does, including the stop rule.

**Do not tell V to POST the migration route at the preview.** That is a separate endpoint a
human aims by hand, and the failure mode is aiming it at production. The measurement route
creates what it needs, behind guard 4, or it does nothing.

---

## 4. What to measure

Revision 1 asked for ON versus OFF with seeded ABBA ordering. **Both are withdrawn, and the
reason matters.** Every boundary below is a telemetry statement. With instrumentation off
they do not execute at all, so the OFF arm costs zero and `ON − OFF` reduces to `ON`. That
machinery was inherited from step 21, which wrapped retrieval — something that runs either
way. Here it measures nothing.

**This pass measures the absolute cost of each added statement against the real database.**

### The boundaries

| # | Boundary | Note |
|---|---|---|
| 1 | Declaration insert plus invocation counter update | **Per batch, not per note.** Build report §8 shows both are batch-level |
| 2 | Terminal update, per role | Per note |
| 3 | Settlement read plus update, per role | Per note |
| 4 | `activeRun('opd')` | Per note, plus DDL on the first call in a process |

### One cell per invocation

`maxDuration` is 800 s. At a 68 ms floor that buys roughly 11,700 serial statements in a
perfect case, and section 4's full matrix with p99 needs far more. **So the route takes a
`cell` parameter and measures one cell per invocation.** A cell is one boundary at one batch
shape. Report `n` per cell and justify it. A p99 printed from an `n` that cannot support it
is a maximum wearing a percentile's name.

### Batch shapes

```text
max=8,  conc=8     the production default
max=1,  conc=1     single note
max=30, conc=8     the manual maximum
```

### Settlement must use a real audit id

`audit_id` is `REFERENCES opd_note_audits(id)`. Production always settles with a real one,
so the `UPDATE` carries an index probe into the largest table in the schema. Passing `null`
is the path of least resistance and it produces a number that is real, network-bounded, and
systematically low with nothing in the output to show it.

The branch is a clone, so real `opd_note_audits` ids exist on it. **Select one and use it.**
Report the id you used and state that it is a branch row.

### "Cold" is one sample, and must be labelled as one

`ensured` in `lib/backfill-runs.ts:36` is module state with no reset and no export. One
request is one process, so the first statement of the request absorbs TLS setup and, if the
branch compute has scaled to zero, a resume of hundreds of milliseconds. **Report the first
sample of each invocation separately, labelled `first-statement-in-process`, with `n = 1`.**
Do not call it cold and do not put it in a percentile column.

### Reporting

Minimum, median, maximum, `n`, **p95 and p99**, per cell. Distributions, never means. Every
number labelled synthetic-against-a-branch, with its batch shape.

**Do not propose thresholds.**

---

## 5. SQL accounting, narrowed because the full version is not legal here

Revision 1 required capture of every statement at the transport boundary. **That is not
achievable without a change this pass forbids.** `lib/db.ts` exports `sql` as a `const`
Proxy, the three stores import it at module scope, and there is no injection seam. The
remaining routes are all worse: editing `lib/db.ts`, adding a deps parameter to the stores,
or patching `globalThis.fetch` — the last being the process-global mutation that
`lib/retrieval-telemetry-core.ts:230` records as forbidden under fluid compute.

**Instead:** derive the topology from the source, verify it against row counts in the branch
tables after each run, and report both. State plainly that reads, DDL and retries are not
counted, and that this is a narrowing.

Also correct the arithmetic. Saul's `3 + 5N` gives 43 for N=8. The committed build report
§8 shows the declaration insert and counter update are **per batch**, which makes the real
shape `4 + 4N`, or **36 for N=8**. Verify against the branch and report the true figure.

---

## 6. File contract

Revision 1 had none. That was the structural defect.

### Create

```text
app/api/admin/telemetry-overhead/route.ts        the measurement route
lib/__tests__/telemetry-overhead-guard.test.ts   the five-guard test
```

The test must live under `lib/**/__tests__/*.test.ts` or `npm test` will not collect it, and
`npm test` is gate 1.

### Edit

```text
.gitignore                                            add the v4 exception line
CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md    Part XI, above Part X
lib/architecture/map.generated.ts                     ONLY if regeneration changes it
```

### Add to the commit, unedited

```text
CDMSS-RERANK-TELEMETRY-ADDENDUM-v4-13-AUG-2026.md
```

`.gitignore` line 73 is `/*.md` with an allow-list. v1, v2 and v3 have `!` lines. **v4 does
not.** Add `!/CDMSS-RERANK-TELEMETRY-ADDENDUM-v4-13-AUG-2026.md`. Do not use `git add -f`.

### The architecture map, which will change

Building a `RetrievalPayload` for `writeRetrievalTerminal` requires `createTelemetryCapture`
and `buildRetrievalPayload` from `lib/retrieval-capture.ts`. There is currently **no
`app/api` to `retrieval-capture` edge** in `map.generated.ts`. The import adds one.

**So v1 section 9's pre-gate is suspended for this pass only.** Regenerate the map, commit
it, and report the exact edge added. If any edge other than
`app/api → retrieval-capture` appears, stop and report.

### The evidence archive is NOT committed

v3 decided the output is not committed and Part X carries the numbers. That stands. A
p99-capable archive is megabytes of JSONL, `.gitignore` has no rule for it, and it would
commit silently. Part XI carries the numbers. Report where the raw samples were written and
their SHA-256.

### Do not touch

Everything in v11 section 4 stands. In addition: no change to `lib/db.ts`, the three stores,
`lib/retrieval-telemetry-core.ts`, or any file under `lib/` or `app/` other than the two
files named above.

---

## 7. The route enum problem

`declareRetrievals` takes a `TelemetryRequestContext` whose `route` is `InvocationRoute`, a
closed union at `lib/retrieval-telemetry-core.ts:197`. **`/api/admin/telemetry-overhead` is
not a member, and adding one is forbidden by section 6.**

**Use `'script'`.** It is an existing member, it is honest about what this is, and it keeps
every synthetic row separable from real traffic by a single predicate. Report that every row
this pass wrote carries `route = 'script'`, and that the rows live only on the branch.

---

## 8. Context V judges the numbers against

```text
worker function box        800 s   (lib/opd-audit-runtime-config.ts:22)
observed opd_note_audit    median 60 252 ms   p99 384 360 ms   max 908 045 ms   n 36 595
traces over 800 s          1
notes audited nightly      approximately 425
```

`n 36 595` is the timed subset. A further 1,565 traces are `running` with null timing.

One trace has already exceeded the function box. The risk is the tail and cron overlap, not
the median.

---

## 9. What this pass must not do

- No production deployment, no production database, no migration aimed by hand.
- No canary, no C0, no load control, no ranking change.
- No threshold proposed.
- No file touched outside section 6.
- The route must be unreachable from a production deployment, and section 6's test must
  prove it.

---

## 10. Attack your own work

Report every attack, including those that broke nothing.

- Set `CDMSS_OVERHEAD_DB_ENDPOINT` to the production endpoint id. Guard 4 must refuse.
- Unset `CDMSS_OVERHEAD_DB_ENDPOINT` entirely. Guard 4 must refuse, not pass.
- Set `VERCEL_ENV=production` with everything else correct. Guard 2 must refuse.
- Set `VERCEL_ENV=preview` with `VERCEL_GIT_COMMIT_REF=main`. Guard 2 must refuse.
- Move the clock past the expiry. Guard 5 must return 410.
- Run settlement with `auditId: null` and with a real id. Report both numbers and the gap.
- Run the same cell twice in one invocation. Report whether sample 1 differs from the rest.
- Confirm no error path returns any substring of `DATABASE_URL`.

---

## 11. Gate, report, commit

Gate: v1 section 9, plus v2 section 10's three additions and v3 section 12's one, **except**
the `map.generated.ts` pre-gate, suspended per section 6.

Report a new **Part XI**, above Part X, summary header updated. It carries: the signed
amendment text, every number with its cell, shape and percentiles, the true SQL topology,
the archive location and hash, the five-guard test results, the settlement FK comparison,
the map edge added, and the owed deletion line.

Commit: one scoped commit, parent exactly `d452fec`, no amend, no rebase, **no `git add -f`**.

**Do not push. V pushes.**

---

## 12. Owed, and enforced

The route is deleted before `exp/rerank-telemetry` merges anywhere. Guard 5's expiry is the
enforcement, because nothing in CI enumerates routes. Record the deletion as its own
numbered owed line in Part XI, and record that `CDMSS_OVERHEAD_MEASURE`,
`CDMSS_OVERHEAD_DB_ENDPOINT` and the branch-scoped `DATABASE_URL` must be removed from
Vercel at the same time.

---

## 13. The finding that reframes this

Corrected arithmetic. The per-note serial chain is **three** statements, not five — the
declaration insert and counter update are per batch. At the 68 ms floor that is roughly
**204 ms added per note**, plus about 17 ms of amortised batch cost at N=8, best case,
before any query work and against an idle branch with no contention.

If the measurement confirms it, the cheapest intervention is not in the remediation plan.
**Colocating the Vercel region and the Neon region removes most of the term**, and it
shortens every note's wall time rather than only the telemetry's share — which acts directly
on the throttling this programme exists to fix.

Outside this workstream. V's call. A finding in the report, flagged and not acted on.

---

## 14. What the attack on revision 1 found

| # | Defect | Fixed in |
|---|---|---|
| 1 | **No guard checked which database was connected.** Admin, environment label and feature flag all pass while pointed at production | guard 4, section 3 |
| 2 | **The branch has no telemetry tables** and revision 1 never said to create them. Three of four boundaries had nothing to write to | section 3 |
| 3 | Revision 1 would have had a human POST the migration route at a preview. The failure mode is aiming it at production, closing v1 decision 8's window | section 3, route self-migrates |
| 4 | **No file contract**, and the addendum itself is `.gitignore`d with no `!` line, while the `no git add -f` clause had been dropped | section 6 |
| 5 | Section 8 forbade the test section 3 required, and the seam section 5 required | section 6 |
| 6 | ON/OFF and ABBA measure nothing here: with instrumentation off these statements do not run | section 4 |
| 7 | `maxDuration` 800 cannot fund the full matrix at p99 | one cell per invocation |
| 8 | Settlement with `auditId: null` omits the foreign-key probe and reads systematically low | section 4 |
| 9 | "Cold" cannot be forced in-process and would have been one sample in a percentile column | section 4 |
| 10 | `InvocationRoute` is a closed union that cannot name the new route | section 7 |
| 11 | The import adds a `map.generated.ts` edge that v1's pre-gate would halt on | section 6 |
| 12 | Deletion was enforced by a note in a report | guard 5, hard expiry |
| 13 | §0 mis-cited v2 §10 and v3 §9 as settled-decision sections | section 0 |
| 14 | v1 decision 10's ordering never contemplated a branch migration and was declared to stand | section 0 |
| 15 | `3 + 5N` = 43 was wrong; batch-level statements make it `4 + 4N` = 36 | sections 5, 13 |
| 16 | HTTP method, guard order and status codes unspecified | section 3 |
| 17 | The six sub-10 ms `lab_sql_audit` rows are filesystem reads, not database calls | section 2 |
