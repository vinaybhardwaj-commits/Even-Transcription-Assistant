# CDMSS — Stage 0a closing ledger, v3

**Status: for signature.** Supersedes v1 and v2. Prepared under Rep 48 D1, with Rep 49's proof-70 correction applied.
**Signature:** Saul signs, or adopts these exact bytes. **V then commits the signed artefact as one forward governance commit under `docs/governance/`.** No history rewrite is authorized.
**Deployment readiness is not certified by this document.**
**Every figure was read from a document on `t4b` @ `125de9b` or from `git`. Nothing is carried from v1 or v2.**

---

## 1. Closure

```
Hard proofs closed    20 / 20
Judge proofs closed    4 /  4
Hard proofs open       none
```

Final closure: implementation **`4989fcb`**, evidence tip **`125de9b`**.

The 14 August guardrails ruling partitioned 73 numbered proofs: 57 hard pre-canary, 7 deferrable until before C0, 9 completeness-only. Of the 57, twenty were found missing or materially incomplete. Those twenty are this ledger.

Progression: 2/20 (review 27) → 7/20 (review 34) → 9/20 (review 36) → 10/20 (review 37) → 13/20 (Rep 41) → 14/20 (Rep 43) → **reopened** (proof-11 sweep) → 20/20 (Rep 45).

## 2. Affirmations

Per Rep 48's authority ruling, the ledger affirms:

- **Proofs 45, 47 and 56** closed at **`ac0155c`**, evidence through **`29572cf`**.
- **Proof 24** closed with tests at **`5e9aed5`**, green executable tree **`07452bb`**, evidence tip **`5994922`**.
- **Proofs 21, 22 and 23** closed at **`c1d7490`**, evidence through **`c47b003`**.
- **Proofs 10 and 44** closed against **`7a8b947`**, evidence tip **`cb46330`**.
- **Proof 11 was reopened before final repair.**
- **Proofs 11 and 14** closed at **`4989fcb`**, evidence tip **`125de9b`**.
- **Final status is 20/20 hard and 4/4 judge.**
- **The normal fast-forward publication through `29572cf` is retrospectively ratified. This grants no further push authority.**
- **The soft reset remains ratified exactly as recorded in §7.**
- **Deployment readiness remains uncertified.**

## 3. Closure record

| Proof | Implementation | Gate | Evidence | Authority |
|---|---|---|---|---|
| 2 | `fe59b07` (orig. `21f1194`→`fe0eedb`→`9344cdb`) | `fe59b07` | supplemental | review 30 |
| 10 | `487d807`+`820bddd`+`7a8b947` | `7a8b947` | pass 5, tip `cb46330` | Rep 44 |
| 11 | 1st `7bb52b5`; **reopened**; re-closed `4989fcb` | `7bb52b5`, then `8802684`; re-closure `4989fcb` | pass 1 corrected + v14 determinism; sweep; final repair | review 27; reopened by the sweep; **Rep 45** |
| 12 | `7bb52b5` | `7bb52b5`, then `8802684` | pass 1 corrected + v14 determinism | review 27 |
| 14 | `487d807`+`820bddd`+`7a8b947`, then `4989fcb` | `7a8b947`, then `4989fcb` | pass 5, then final repair | **Rep 45** |
| 16 | `fe59b07` | `fe59b07` | supplemental | review 30 |
| 17 | `9344cdb` | `9344cdb` | pass 2 | review 29 |
| 18 | `fe59b07` | `fe59b07` | supplemental | review 30 |
| 21 | `12a4565` + `c1d7490` | `c1d7490` | pass 4b + pass 4 correction, tip `c47b003` | Rep 44 |
| 22 | `12a4565` + `c1d7490` | `c1d7490` | as 21 | Rep 44 |
| 23 | `5e9aed5` (held) → `12a4565` → `c1d7490` | `c1d7490` | pass 4a (superseded), 4b, correction | held Rep 42, closed Rep 44 |
| 24 | tests `5e9aed5`; green tree `07452bb` | `07452bb` | pass 4a + Q1 cleanup, tip `5994922` | conditional Rep 42, confirmed Rep 43 |
| 35 | `f391973` (orig. `8404029`) | `f391973` | pass 3 repair | review 37 |
| 44 | `487d807`+`820bddd` | `7a8b947` | pass 5, tip `cb46330` | Rep 44 |
| 45 | `ac0155c` | `ac0155c` | pass 3 repair 2, through `29572cf` | Rep 41 |
| 46 | `8404029` | `8404029` | pass 3 | review 36 |
| 47 | `ac0155c` | `ac0155c` | pass 3 repair 2, through `29572cf` | Rep 41 |
| 49 | `8404029` | `8404029` | pass 3 | review 36 |
| 56 | `ac0155c` | `ac0155c` | pass 3 repair 2, through `29572cf` | Rep 41 |
| **70** | **`fe59b07` + `614da54`** | **`614da54`** — the final gate that exercised proof 70's *mutation rows* | **supplemental + supplemental 2** | review 30 "technically close; correct contradictory comments"; **administrative closure at review 34** |

**Proof 70, stated precisely.** `fe59b07` is the substantive half — real `validateManifest` output feeds `verdictForRun`, and `checkHealthy` and `judgeFn` push to a shared order log at invocation. `614da54` is comment-only in `rerank-pass-2.test.ts`: review 28's "base-to-commit production byte comparison" is recorded as **resolved**, not declined. Row 17 already ran in the original pass-2 mutation table at `fe0eedb` and was rerun in the supplementals. Row 23 appears only in supplemental and supplemental 2. Supplementals 3 and 4 ran rows 1–14 and 31–35 only. **Two qualifications:** the last gate whose `npm test` executed 70.1–70.4 is `a4d61ae`/supplemental 4, not `614da54`; and **review 34 does not name proof 70** — it closes pass 2 as a whole at `01c2375`.

## 4. Judge proofs

| Proof | Tests | File | Evidence | Authority |
|---|---|---|---|---|
| **J1** | `J1.1`, `J1.2`, `J1.3`, + comparator guard `5.9b` | `explicit-judge-equivalence.test.ts` | supplemental (`fe59b07`), **and re-run at `614da54`, `0e0503b`, `a4d61ae` with supplementals 2, 3, 4** | held review 29, closed **review 30**, administrative closure **review 34** |
| **J2** | `J2.1`, `J2.2` | `rerank-pass-2.test.ts` | supplemental, gate `fe59b07` | held review 29, closed **review 30** |
| **J3** | `J3.0`, `J3.1`, `J3.2` | `explicit-judge-retrieve.test.ts` | pass 2, gate `9344cdb` | **review 29** |
| **J4** | `J4.1`, `J4.2` | `explicit-judge-retrieve.test.ts` | pass 2, gate `9344cdb` | **review 29**, `armCaptures.length === 3` as follow-up |

**J1's later rounds, distinguished rather than merged.** Only **`614da54`** changed J1's machinery — it modified `judge-server-stub.ts`, the recorder J1's byte-identity comparison reads, and the full 30-row table was re-run for exactly that reason: a row that discriminated against the old recorder proves nothing about the new one. **`0e0503b` and `a4d61ae` did not touch J1 or the stub.** Each edited `explicit-judge-equivalence.test.ts` elsewhere — `waitForContinue`, `5.2b`, `5.2c`, the shared cleanup — and J1.1–J1.3 failed as **collateral discrimination on row 3** in supplementals 3 and 4. All four judge proofs confirmed at review 34, `01c2375`.

## 5. Tests found defective by mutation

Ten named tests, listed in full rather than counted.

| Test | Row | Campaign | Repair |
|---|---|---|---|
| `5.5b` | row 1 | pass 2 first run | `9344cdb` |
| `5.6` | rows 6 **and** 7 | pass 2 first run | `9344cdb`; its 30 ms sleep survived and was removed at `614da54` |
| `22.1` | M2 | pass 4b | `12a4565` |
| `22.2` | M2 | pass 4b | `12a4565` |
| `22.4` | M2 | pass 4b | `12a4565` |
| `14.8` | M12 | pass 5 | `7a8b947` |
| `14.10` | N2 | Stage 0a final repair | `4989fcb` |
| `14.11` | **M9** (pass 5) **and N3** (final repair) — two findings | pass 5; Stage 0a final repair | `7a8b947`, then `4989fcb` |
| `11.7` | sweep row 1 | proof-11 sweep | `4989fcb` |
| `11.3` | sweep rows **2, 3, 4 and 5** | proof-11 sweep | `4989fcb` |

**In every case the row was kept and the test was repaired, never the reverse.**

The recurring defect class, named in the evidence itself: *a test that asserts an outcome without asserting the thing that produced it.* `22.2` under M2, `14.8` under M12 and `14.11` under M9 are the same failure. `14.10`'s cause sits one layer lower — the Cohere arm made **zero** requests, because `lib/rerank.ts:214` throws on a missing key before `fetch`, so `every()` passed over an empty array; and the interceptor's `/cohere/i` filter would not have matched anyway, because the Cohere backend is OpenRouter-hosted.

Two cases are deliberately **not** counted as test defects: **45.2xx**, where the generated suite guards the engine against the matrix and the hand rows guard the matrix — both kept by design; and **N3b**, §6.

## 6. Mutation campaigns — sixteen records

**These are sixteen campaign records, not sixteen executions.** Four records contain more than one execution. The inventory below is what is signed; no headline number is.

| Record | Rows | Executions | Outcome |
|---|---|---|---|
| Pass 1b (informal) | 2 | 1 | both discriminated |
| Pass 2, first run | 22 | 1 | 19 discriminated. Row 1 → 5.5b passed; rows 6, 7 → file timed out at 60 s, no named failure |
| Pass 2, re-run | 5 | 1 | all failed by name; rows 6 and 7 by name, not by timeout |
| Pass 2 supplemental | 30 | 1 | — |
| Pass 2 supplemental 2 | 32 | 1 | all 30 re-run in full because the recorder itself changed, plus 2 new |
| Pass 2 supplemental 3 | 18 | 1 | rows 1–14 and 31–34 |
| Pass 2 supplemental 4 | 19 | 1 | rows 1–14 and 31–35 |
| Pass 3 | 16 | **2** — first run against `947d7de`, superseded; second against amended `8404029` | all failed by name. Row 11's expectation corrected: 35.8 over-listed |
| Pass 3 repair | 9 | 1 | all failed by name. Row 9's expectation corrected: 45.1 over-listed |
| Pass 3 repair 2 | 10 | 1 | all failed by name. Recorded exception: the matrix-generated NULL case (45.2xx) did not fail |
| Pass 4a | 7 | 1 | all failed by name. Recorded limit: M1's first assertion in 23.1 is not falsifiable by mutating production |
| Pass 4b | 5 | **2** — both runs recorded | all failed by name after the test repair. **The two runs are not equivalently archived:** M2's first run kept its summary line and named outcome; its full TAP was not retained |
| Pass 4 correction | 7 | 1 | fresh run in full, nothing carried forward. M2 additionally failed `4C-3` |
| Pass 5 | 14 | **2 for rows M9 and M12** — both runs recorded; the other twelve ran once | all failed by name after the repair. Rows not adjusted |
| Proof-11 sweep | 5 + 2 controls | 1 per row, bracketed by two unmutated baselines | **all five prescribed rows failed to discriminate; both controls did** |
| Stage 0a final repair | 22 counted + 2 controls + N3b | **2 for N3** — the superseded specification retained as N3b | every counted row failed by named assertion; no row timed out |

The Q1 cleanup had no mutation campaign; none was required. Pass 4 correction and supplementals 2, 3 and 4 are re-executions of already-counted row sets against new bytes, not new row sets.

## 7. The proof-11 sweep, and N3b

**The sweep.** The five prescribed rows did **not** discriminate — every row exited 0 with `ok`, no timeouts, one test per run. **Both out-of-table controls did.** C1, deleting the OpenRouter push outright, failed 11.3 with `expected: 2, actual: 1`. C2, changing what `localAttemptSuccess()` returns, failed 11.3 on the deep-equal. The contrast is the finding: both reads were live, the rows were not vacuous, and 11.3 failed when the *syntax* was removed while passing when only the *execution* was disabled.

**Gap A** — 11.7 verified a constant against itself and could not fail for any substitution of any taxonomy literal. Not weak evidence for the committed six; no evidence for them.
**Gap B** — 11.3 observed syntax, not execution. Proof 11's second half was a syntax pin wearing an execution proof's name.

The sweep's author recorded that the closing ledger should not be signed on the count as it then stood. **This ledger records the sequence rather than the endpoint alone: proof 11 was closed at review 27, reopened by the sweep, and re-closed at `4989fcb` by Rep 45.**

**C1 and C2 in the final repair** are retained routing controls, not among the 22. They exist because rows that all pass and rows that are all misrouted look identical without them. Both discriminating.

**N3b was unexpectedly non-discriminating, then deliberately retained and reported by Rep 45.** N3 as first written was the throw-point replacement and it did not discriminate; the row was mis-specified, and N3 was rewritten to replace the error at the head of the catch, which telemetry does see. The throw-point variant was kept and reported as N3b rather than deleted, because deleting it would hide a real finding: the seam has a region no consumer can observe. **One matter remains open at that seam** — if assertion 5 is intended to cover a post-telemetry replacement, that needs a production-observable channel and therefore a production change, which was not authorized and was not made.

## 8. The soft reset

```
discarded object:
6892a27c497928df8c43751e05b37a10ec9124d2

commands:
git reset --soft HEAD~1
git reset -q
```

Reflog-addressable but unreachable from refs. **Production bytes unchanged.** Final test delta: eleven lines. **Final mutation table and gate ran against `12a4565`.** Recorded, per Rep 43, as **a history rewrite in substance** — not a technicality that fell outside a list. Ratified retrospectively; no rerun required solely because of the reset.

## 9. Retrospective and late ratifications

| Item | Authority | Condition |
|---|---|---|
| Pass-1a commit split (`0c9ad85` + `75b3367`) | review 24 | acceptable retrospectively; **must not be silently treated as compliant** |
| 11.5b AST extension beyond v13's seven items | review 25 | accepted, claim narrowed |
| `.gitignore` exception inside an "evidence-only" commit | reviews 25, 26 | ratified because v13 called it evidence-only |
| Four forward-only pass-2 commits + v16/v17 | review 29 | ratified |
| Governance-only ungated-tip exception | reviews 29, 30, 34 | ratified; applies to commit 12 |
| Mutation-before-gate ordering | review 29 | approved from pass 3 onward |
| Removal of `git add` from command 6 | reviews 29, 30 | approved |
| v19 signed without prospective authorization | review 31 | preserve unchanged; **no rebuild required solely because of the signature defect** |
| Pass-3 amend `947d7de` → `8404029` | review 36 | amended bytes received a fresh mutation run and gate; no rerun required |
| Continuation after review 35's freeze instruction | review 36 | accepted for preservation and audit; **does not release the commits or push** |
| Nine-row pass-3-repair table + sandbox-cwd execution | review 37 | accepted |
| 90492-byte map pin superseded by 90409 | Rep 42 | superseded for the cleanup |
| Deletion of the expired overhead instrument | Rep 42 | GO; suppression, clock-pinning, red gate and expiry extension all ruled out and none was done |
| The soft reset | Rep 43 | ratified subject to §8 |
| Pass-4b's §2.7 primary-fixture deviation | Rep 43 | **REJECTED** — a material deviation, not a harmless reduction |
| Pass-4b evidence-archival defect | Rep 43 | the two runs were not captured equivalently and the evidence must not read as saying they were |
| Four pass-5 commits where two were specified | Rep 44 | restated as **a process breach**, not a counting deviation |
| "Documentation only" commit-message inaccuracies | Rep 44 | corrected; cause structural — `.gitignore` forces a negation line |
| N3 re-specification, N3b retained | Rep 45 | ratified because N3b was preserved, reported and brought for ruling |
| The two extra sweep controls | Rep 45 | ratified as necessary to prove the sweep was live |
| Running sweep rows 2–5 after row 1 failed | Rep 45 | ratified; the kickoff contradicted itself |
| The loopback-only proof-14 stub | Rep 45 | ratified |
| Build arm A's false green under `NODE_ENV=production` | Rep 45 | **excluded from evidence**; corrected arms accepted |
| Fast-forward publication through `29572cf` | **Rep 48** | ratified retrospectively. **Grants no further push authority.** |

**Operative authority gaps.** Original ruling files for Reps 38–47 are absent from the branch; some exist as derivative transcriptions. Per Rep 48, this ledger does not enumerate missing filenames and does not copy every ruling. **This signed ledger is the primary authority record for the closures in §2 and §3.** The gaps it stands in place of are:

1. **Proof 24's Rep-43 authority** — the closure that moved the ledger to 14/20.
2. **Rep 41's closure of proofs 45, 47 and 56.**
3. **Rep 44's closure of proofs 10, 21, 22, 23 and 44.**
4. **Rep 45's re-closure of proofs 11 and 14** and its rulings on N3b, the sweep controls, rows 2–5 and the loopback stub.
5. **The ratification of the publication through `29572cf`**, now carried by §2.

## 10. Deployment blockers

| # | Blocker | Status |
|---|---|---|
| 1 | **`CDMSS_TELEMETRY_HMAC_KEY` in Vercel Production** | **OPEN — never checked.** The key guard throws at config import in production without it, so no production deploy of this branch can start. It keys off `VERCEL === '1'` and `VERCEL_ENV === 'production'`, not `NODE_ENV`. |
| 2 | **90-day retention purge** | **Declared, NOT implemented.** All three tables carry the declaration. The route states the purge is owed and unimplemented: a scheduled delete against a table that may hold the only evidence of an unreconciled incident is a decision, not a default. |
| 3 | **Migration ordinal `0035` → `0037`** | **OWED.** `0035` and `0036` are both taken on `main`; `0037` is the first free slot. Stated precisely: **no production runner loads the reference file; tests do read it; external or manual application cannot be established from git; the ordinal collision still requires `0037`.** |
| 4 | **Route fail-closed behaviour** | **CONFIRMED FAILS OPEN.** `lib/admin-gate.ts:6` returns `null` when `ADMIN_TOKEN` is unset. `lib/admin-cookie.ts` fails **closed** on the same absent variable. Two gates, opposite defaults, joined in one route. **Being fixed for the two R3 routes under D2; other fail-open routes are separate security debt.** |
| 5 | **Database role and schema privileges** | **PARTIALLY MEASURED, still owed.** Live query 13 Aug: `db_role: neondb_owner`, `is_superuser: false`. Review 20 still requires verification of table ownership or owner-role membership and `public` schema CREATE privilege before production migration. The query proves `current_user`, not ownership. |
| 6 | **Migration atomicity** | **Per-table atomic; route-level NOT transactional.** Each table's constraint replacement is one `ALTER TABLE`. The route loops statement by statement with no `BEGIN`. Review 20: this does not make the route transactional and the report must not claim otherwise. |

**Also open on the critical path:** the five numeric overhead guardrails; the canary date and deploy authorization; whether `RERANK_BACKEND` is set for Preview (not checked); the legacy-data policy if the migration returns 409; the D13 unknown-phase check; both sql-guard gaps, logged and deliberately not acted on.

**On migration `0035`, corrected.** Earlier documents state that `migrations/*.sql` "is read by nothing." **That is false as written** — six tests read `0035`'s contents, and a parity test compares the route's emitted statements against the hand-typed mirror in both directions, deliberately making the file a liability if it is wrong. The accurate statement is the four-part one in the table above. Nothing in the repository would record an out-of-band application; establishing whether the schema exists in any database requires a platform attestation, not git.

## 11. Declared limitations

1. **Independent replay is not possible for every historical command.** Sandboxes were deleted after each table and some transcripts are summarised. Four-hash equality and pinned blobs substitute for replay.
2. **Pass 4b's two runs are not equivalently archived.** M2's first run kept its summary and named outcome; its full TAP was not retained.
3. **N3b is a disclosed non-discriminating row** with an open production-observability question at that seam. §7.
4. **Not every base URL in proof 11 is loopback.** Ollama, OpenRouter and token minting are; **Vertex carries a real-shaped Google URL.** Containment is the deny-by-default fetch installed before the dynamic import, plus prototype interception — not URL shape.
5. **The test interceptor is load-bearing for egress containment**, not only observation. `RERANK_API_URL` is module-scope and no test can override it.
6. **Two facts surfaced only when a vacuous assertion was closed**: `lib/rerank.ts:214` throws on a missing key before `fetch`, and the nominal Cohere arm uses the OpenRouter-hosted `/rerank` endpoint.
7. **One process breach** — pre-commit typecheck not run before `487d807`, corrected forward by `820bddd` rather than by amendment.
8. **One false green, excluded** — a production-build arm first run under `NODE_ENV=production` exited 0.
9. **One history operation** — §8.
10. **Documents disagree with one another** on the points in §12.

## 12. Contradictions on the record

1. **Proof 24's SHAs** — tests `5e9aed5`, green tree `07452bb`, evidence tip `5994922`. All three are true of different things; §2 says which is which.
2. **Proof 70's "final applicable gate"** — `614da54` for its mutation rows; `a4d61ae` for the last gate that executed 70.1–70.4.
3. **Review 34 never names proof 70 or any individual proof.** It closes pass 2 at `01c2375`.
4. **Proof 11's intermediate status** — the sweep said the ledger should not be signed on the count as it stood while pass 5's header still counted it inside 14/20. Resolved forward and recorded as a reopening in §2.
5. **`neondb_owner`** — measured live versus "owed / must not remain an inference."
6. **`requireAdmin` versus `admin-cookie`** — one fails open, one fails closed, in the same expression.
7. **"`migrations/*.sql` is read by nothing"** — false as written. §10.
8. **Commit-message accuracy** — `cb46330` and `ddeff1c` each said "documentation only" while carrying a `.gitignore` line. Corrected in the final repair evidence; the originals stand as the record of what was said.
9. **Map size pin** — 90492 before the Q1 cleanup, 90409 after. Superseded by Rep 42; the older figure remains in the pass-4a report.

**Closure test-count trail**, in commit order, each observed and none predeclared:

```
3178  →  3613 red  →  3582  →  3598  →  3605  →  3633
```

This is the closure trail, not every observed intermediate count. `3178` at `7bb52b5`. `3613` red at `5e9aed5`, 27 failures all in one file the unit did not touch. `3582` at `07452bb` — 3613 minus the 31 cases in the deleted guard file. `3598` at `12a4565`, the Q1 baseline plus 16. `3605` at `c1d7490`. `3633` at `7a8b947`, unmoved at `4989fcb` because 11.3 was rebuilt in place. **An earlier ask to Saul said 3,599; that number does not exist and was an Orchestrator transcription error taken from a screenshot rather than from the branch.**

## 13. What this ledger does not certify

**Closed:** the hard-proof programme.
**Not certified:** deployment readiness.

Outstanding before deployment: this ledger signed and committed under `docs/governance/` · measurement fixtures, seeds and SHA approved and frozen · old Preview variables, deployments and Neon resources removed · the qualifying guardrail suite run under Preview-only controls · forward history-preserving integration and a fresh combined-tree gate · the two-parent commit returned for review · **V's deployment authorization** · and the six blockers in §10.

**Standing clock.** The measurement instrument expires **2026-09-15T00:00:00Z**. If the qualifying SHA is not frozen by **2026-09-08T00:00:00Z**, it is deleted and disarmed and a newly dated authorization requested.

---

**Signature block**

```
Hard proofs 20/20, judge proofs 4/4, closed at 4989fcb / 125de9b.
The affirmations in §2 are adopted.
The mutation-campaign inventory in §6 is signed as sixteen RECORDS, not sixteen executions.
The ten tests found defective by mutation are listed in §5 and were repaired, not adjusted.
Limitations in §11 and contradictions in §12 read and accepted.
Operative authority gaps in §9 are carried by this ledger as the primary record.
Deployment blockers in §10 remain outstanding.
Deployment readiness is NOT certified by this document.
No further push authority is granted.

Saul                              date
```
