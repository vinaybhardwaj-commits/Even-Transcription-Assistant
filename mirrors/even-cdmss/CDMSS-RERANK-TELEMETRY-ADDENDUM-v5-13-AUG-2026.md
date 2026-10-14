# CDMSS rerank telemetry: addendum v5, the fixes before the measurement runs

**13 August 2026.** Eight corrections to `cdc9c34`. No new capability. The route does not
run against anything until these land.

---

## 0. Authority and preflight

Governs all work after `cdc9c34e04f4adceb06cdfb03d55fc896bae33d3` on
`exp/rerank-telemetry`.

Continues addendum v4. Every settled decision in v1 section 10 and v3 section 10 stands, and
v4's signed amendment stands.

```text
branch:  exp/rerank-telemetry
HEAD:    cdc9c34e04f4adceb06cdfb03d55fc896bae33d3
tree:    clean
```

**The pass-4 build was correct on everything it was asked to do.** These are defects an
adversarial pass found afterwards, and two of them are mine.

---

## 1. Fix 1. The 500 body leaks the database password. Severity: highest.

When `DATABASE_URL` fails `new URL` but passes guard 4's hand parse, `neon()` puts the
**entire connection string, password included**, into its thrown message. The route returns
that message, sliced to 200 characters, which is enough for user, password and host.

Three ordinary paste mistakes reach it: a dropped `postgresql://` prefix, a value still
wrapped in quotes, a leading `psql `. All three were verified against the real driver.

`lib/admin-gate.ts` returns `null` when `ADMIN_TOKEN` is unset, so the route may be open.

**The fix.** The 500 body carries a **fixed string** and nothing derived from the caught
error. Do not slice, do not truncate, do not sanitise — do not include it at all. Keep
`steps` if it is useful, and confirm no step value can carry a connection string either.

If a class name is wanted for triage, use `(e as Error).name` only, and add a test that the
body cannot contain `postgres`, `neon.tech`, `@`, or the value of `CDMSS_OVERHEAD_DB_ENDPOINT`.

## 2. Fix 2. The test for that path never runs.

`lib/__tests__/telemetry-overhead-guard.test.ts` has a case keyed on
`CDMSS_OVERHEAD_FORCE_DB_ERROR`. **Nothing in the repository reads that variable**, so the
case silently duplicates the all-pass case and the 500 shape has never been exercised.

**The fix.** Either make the route honour that variable behind the same five guards, or
drive the 500 by pointing `DATABASE_URL` at an unparseable value that still satisfies guard
4. The second is better, because it reproduces the real defect rather than a simulation of
it. The test must assert the body contains none of the strings in fix 1.

## 3. Fix 3. Guard 4 parses the wrong part of the string.

It takes the last `@` in the whole URL rather than the last `@` within the authority. So:

```
postgresql://u:pw@ep-production-999999.…/db?x=@ep-measure-000001.…
guard 4 parses  ep-measure-000001   ALLOWS
driver connects ep-production-999999
```

**The fix.** Cut the string at the first `/`, `?` or `#` after the scheme, then take the
last `@` **within that**. Three characters of code. Keep the hand parse. Do not switch to
`new URL`, whose error object retains the input — that was the right call and it stands.

Add the bypass above as a test case.

## 4. Fix 4. Guard 4 cannot tell which side is wrong. Add the denylist.

This is the one that is a design problem rather than a bug.

Guard 4 compares two variables **V sets**. It has no independent knowledge of which endpoint
is production. If `DATABASE_URL` is ever not scoped to Preview, guard 4 refuses with one
word that deliberately says nothing about which side is wrong — and the natural next move,
debugging late, is to change the variable you just added rather than the one that was
already there. One paste opens the route onto production.

**The fix.** A second clause on guard 4, from a third variable
`CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT`, holding the **production** endpoint id. Refuse if the
parsed endpoint equals it, **before** the equality check against the expected one.

Then setting the expected value to production's id still refuses, and the failure mode above
is closed. Refuse with a distinct word, `forbidden_endpoint`, and still return nothing else.

Refuse also when `CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT` is unset. A denylist that is absent is
not a denylist.

## 5. Fix 5. The p99 is the maximum.

Default `n` is 50, one sample is consumed as `first_statement_in_process`, 49 remain, and
nearest-rank p99 at n=49 returns index 48, the maximum. `p99 === max` for every n up to 99.
`p95 === max` for every n up to 10.

The route prints p95, p99 and max side by side with no floor and no warning. Addendum v4
section 4 warned about exactly this and the route does not defend against it.

**The fix.** Emit `p99` only when the surviving sample count is 200 or more, and `p95` only
at 40 or more. Below the floor emit `null` and a sibling field naming the floor that was not
met. Do not emit a number that is silently a maximum.

## 6. Fix 6. Statement 1 has no cell.

The topology is `3 + 4N` = 35 statements at N=8. Boundary 1 times `declareRetrievals`, which
is statements 2 and 3. **`startInvocation`, the `INSERT INTO opd_retrieval_invocations`, is
called untimed** at route line 227 with the comment "the counter UPDATE needs a row".

So 34 of 35 statements have a cell and the invocation insert has none, and any batch-level
figure derived from the cells is short by one statement.

**The fix.** Add a `start_invocation` cell that times it, or state in the response and in the
report that boundary 1 excludes it and that the batch total is therefore a two-statement
figure. Either is acceptable. Silence is not.

## 7. Fix 7. The shape label is false for four rows.

The response emits `shape: { max: shapeMax, conc: shapeConc }` unconditionally, but the
`terminal_*` and `settle_*` cells run exactly one run per iteration. Part XI records
`terminal_primary` and `settle_primary` at shape `8/8`. The batch was size 1.

The latency is unaffected, because these are per-note boundaries. The provenance label is
wrong.

**The fix.** Emit the true shape per cell, or omit `shape` for per-note cells and say why.
Also: `conc` never runs anything concurrently in any cell. Either implement it or remove it.

## 8. Fix 8. The real-audit arm can silently become the null arm.

If `SELECT id FROM opd_note_audits` returns nothing, `realAuditId` stays null and `auditId`
is null, but the top-level `audit_mode` still reads `"real"`. Two runs differing only in that
string would be read as the foreign-key comparison when they are the same measurement twice.

**The fix.** If `audit_mode` is `real` and no id was found, **refuse the request**. Do not
measure. The whole point of that arm is the index probe into `opd_note_audits`.

## 9. Two corrections to Part XI, no code

1. "After 2026-08-20 every request is 410 whatever else is configured" is false. Guard 5 runs
   fifth, so a request failing guards 2, 3 or 4 gets a 403 after the expiry, never a 410.
   **Move guard 5 to position two, directly after admin**, then the sentence becomes true for
   every authenticated request. Correct the sentence either way.
2. "Eight response shapes" describes eight **test cases** covering **five** shapes. Shapes 1,
   6 and 8 are unexercised. Fix 2 covers shape 8. Say plainly which remain uncovered.

---

## 10. File contract

### Edit

```text
app/api/admin/telemetry-overhead/route.ts
lib/__tests__/telemetry-overhead-guard.test.ts
.gitignore                                            add the v5 exception line
CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md    Part XII, above Part XI
```

### Add to the commit, unedited

```text
CDMSS-RERANK-TELEMETRY-ADDENDUM-v5-13-AUG-2026.md
```

### Do not touch

Everything else. No new imports, so `lib/architecture/map.generated.ts` must not change —
v1 section 9's pre-gate is **restored** for this pass. If the map moves, stop and report.

---

## 11. Attack your own work

Report every attack, including those that broke nothing.

- Point `DATABASE_URL` at each of the three unparseable shapes from fix 1. The body must
  contain no part of it. Check the body, and check child stdout and stderr, which the
  existing harness never searches.
- Run the `?x=@host` bypass from fix 3. Guard 4 must refuse.
- Set `CDMSS_OVERHEAD_DB_ENDPOINT` to the production id with
  `CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT` also set to it. Must refuse `forbidden_endpoint`.
- Unset `CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT`. Must refuse.
- Run a cell at n=50 and confirm `p99` is null with a floor field, not a number.
- Run the real-audit arm against a database with no `opd_note_audits` rows. Must refuse.
- Delete each guard in turn and confirm its tests fail, as pass 4 did.

---

## 12. Gate, report, commit

Gate: v1 section 9 in full, **including** the `map.generated.ts` pre-gate, restored.

Report a new **Part XII**, above Part XI. It carries each of the eight fixes with its test,
the attack results including failures, and a plain statement of which response shapes remain
unexercised.

Commit: one scoped commit, parent exactly `cdc9c34`, no amend, no rebase, no `git add -f`.

**Do not push. V pushes. Do not run the measurement.**

---

## 13. What V does after this lands

1. Add `CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT` in Vercel, Preview, branch
   `exp/rerank-telemetry`, set to the **production** Neon endpoint id.
2. Push, and let the Preview rebuild.
3. Run one cell per call, per Part XI section 8, saving each response body.
4. Run `settle_primary` twice, once with the real audit id and once with `?audit=null`, for
   the foreign-key comparison.
5. Send me the bodies. I will assemble the distributions and put the guardrail options to
   you.

The route expires 2026-08-20 and deletes itself from usefulness on that date whether or not
anyone remembers. `CDMSS_OVERHEAD_MEASURE`, `CDMSS_OVERHEAD_DB_ENDPOINT`,
`CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT` and the branch-scoped `DATABASE_URL` come out of Vercel
at the same time, and the Neon branch goes.
