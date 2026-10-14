# CDMSS proof pass 3 — report for Saul (the two D16 payload corrections and proofs 35, 45, 46, 47, 49, 56)

Date: 18 August 2026
Authority: **Saul review 34**, which closed pass 2 at `01c2375` and released pass 3.
Governing addendum: `CDMSS-RERANK-TELEMETRY-ADDENDUM-v23-18-AUG-2026.md`, **AUTHORIZED
by the orchestrator on V's explicit delegation** (v23 §0; the digest ritual of v20 to v22
is withdrawn, so there was no signature to verify — the builder checked the status line
and proceeded, per the kickoff). Addenda v15 to v22 govern everything v23 does not touch.
Kickoff v11 is the numbering authority; addendum v11 §6 prospectively authorized the two
payload corrections and pinned them to land before proof 35.

Base: commit 12 at `01c2375b4b40dc19bc2684ae2ecfa2b9664f5638`.
Commit 13 (implementation): `84040291ca9fcede333d0373c749d97ae58723e2` — four paths
(amended once from `947d7de`, before the gate; §14 item 12).
Commit 14 is the commit carrying this report (five paths per v23 §10.2); its SHA is in the
builder's covering report.

**Nothing was pushed in this pass.** `@{u}` = `01c2375` throughout (pass 2's eight commits
were pushed by V under review 34's release before this pass began; that is the state the
kickoff's stop condition 4 accepts either way).

---

## 1. Stop conditions 1 to 4

1. `git rev-parse HEAD` → `01c2375b4b40dc19bc2684ae2ecfa2b9664f5638`. PASS.
2. `git status --porcelain` → empty. PASS.
3. Addendum v23 line 14: `STATUS: AUTHORIZED by the orchestrator on V's explicit delegation, 18 August 2026`. PASS.
4. `git rev-parse @{u}` → `01c2375b4b40dc19bc2684ae2ecfa2b9664f5638`; `## exp/rerank-telemetry...origin/exp/rerank-telemetry`
   (pass 2 pushed, in sync). Not a stop; nothing pushed by this pass.

The eight evidence digests were verified before the corrections were made and again after
the gate (§9); every one matched.

**One observation, not a stop:** v23 §12 ("Order of work") still lists steps 1–5 of the
digest ritual (compute digest, V approves naming it, change the status line, verify the
signature). v23 §0.1 withdraws that ritual and the kickoff says plainly there is no script
to run. The two sections of v23 disagree with each other; the kickoff §0 restatement does
not disagree with v23. The builder followed §0 and the kickoff, and reports the internal
inconsistency here.

---

## 2. The two corrections — `lib/retrieval-capture.ts`, located by symbol

### 2.1 A skipped stage records `attempts: []`, not `null` (v11 §6.1)

Two sites, both named by v11 §6.1.

**Site 1 — `buildRetrievalPayload`, the `expansion` block. Before:**
```ts
      attempts: expansionSkipped ? null : manifestAttempts(expansion!.evidence),
```
**After:**
```ts
      // ⚠️ CORRECTED IN PASS 3 (v11 §6.1 / v23 §3, D16 row 5): a SKIPPED stage records `attempts: []`,
      // never null. The stage made no request, so the honest list of attempts is EMPTY — not "not
      // collected". Only the served class carries the stage-level null above.
      attempts: expansionSkipped ? [] : manifestAttempts(expansion?.evidence ?? null),
```
(The pre-existing `expansion!` non-null assertion on that line was not carried into the
new line; the neighbouring `input_hmac` / `served_route_class` / `served_model` lines,
which are not part of the correction, keep theirs untouched.)

**Site 2 — `manifestAttempts`. Before:**
```ts
function manifestAttempts(ev: TransportEvidence | null): ManifestAttempt[] | null {
  if (!ev || ev.attempts == null) return null;
  return ev.attempts.map((a) => ({ … }));
}
```
**After:**
```ts
function manifestAttempts(ev: TransportEvidence | null): ManifestAttempt[] | null {
  if (!ev) return [];
  if (ev.attempts == null) return null;
  return ev.attempts.map((a) => ({ … }));
}
```
Absent evidence — no dispatch recorded, so nothing to list — is `[]`. `null` is kept for
exactly one case: the transport itself reported `attempts: null`, meaning it did not
**collect** a sequence, which D17 names ("null permitted, meaning not collected") and §4.4
forbids reconstructing. Before the correction those two facts shared one value. This
reaches all three attempt locations: expansion (skipped → `[]`), rerank batches (absent
evidence → `[]`), and variant generation (absent evidence → `[]`).

### 2.2 A variant-generation stage that ran and failed records `unattributed` (v11 §6.2)

**`buildMultiQuerySection`. Before:**
```ts
      served_route_class: vg && ev ? servedClassOf(ev) : null,
```
**After:**
```ts
      served_route_class: vg ? servedClassOf(ev) : null,
```
`vg` present means the stage ran (`lib/multi-query.ts` sets `capture.variantGeneration`
after every generation, `failed_open` included, with `evidenceFromError(e)` — null when
no attribution is attached). Its class is now `servedClassOf(ev)`, whose honest floor
without evidence is `unattributed`; `not_served` still requires proof (`provenNotServed`).
`vg` absent — the stage did not run — is the explicit stage-level null.

**Also in the file:** the caller-citation comment above `servedClassOf`, which quoted the
old expression `vg && ev ? servedClassOf(ev) : null`, was updated to the new one so the
file does not describe itself falsely. Nothing else in `lib/retrieval-capture.ts` changed,
and no other production file changed. Neither correction touches ranking, provider
selection, fallback order or backend resolution.

**Left stale on purpose (out of scope):** the doc-comment on
`pushAttemptOutcomeDefects` in `lib/retrieval-telemetry-core.ts` still says the `null → []`
correction is "deferred to pass 3". Core is not an authorized path this pass; the comment
is now historical and is flagged, not edited.

---

## 3. Typecheck and tests after the corrections, before any proof

- `npm run typecheck` → exit 0.
- `npm test` → **3217 tests, 3217 pass, 0 fail** (2026-08-18T13:46:58Z–13:47:18Z).
  **No existing test asserted the old shape.** `attempt-taxonomy.test.ts` 11.9 tolerates
  null, undefined and `[]` alike at all three locations, so it stayed green; nothing else
  read those values.

---

## 4. The six proofs, as found in kickoff v11 §6, and their match with v23 §4

Kickoff v11 §6 (flat list, arabic numeral, period, one space):

> 35. Every row of the D16 stage mapping table, including `parse_failure` preserving provider, model, attempts and token usage, and `failed_open` mapping to `unattributed` without proof.
> 45. Every required field in D17, one absent-or-invalid test each, with own-property checks distinguishing missing, null, empty array, empty string and invalid number.
> 46. `expansion.served_route_class` null with status `skipped` is valid, so a `normative_channel` row is not partial.
> 47. The scorer-context HMAC by role: required on `primary`, null on the other four, and those nulls not partial. Computed over the exact `citedContext`, including the empty-string case.
> 49. All four edge cases in D17, including the two zero-candidate shapes producing different `fused_candidate_count` and `hydrated_candidate_count`.
> 56. Recursive canonicalization, nested-key permutation, JSONB round trip, array reorder not equal, undefined array element rejected.

Compared word for word (ignoring emphasis and wrapping) against v23 §4: **all six match.**
No line number is cited for any proof.

---

## 5. Every test, with provenance

Convention: `'<proof>.<n> — <sentence>'`, flat top-level `test(...)`, `node:test` +
`node:assert/strict`, no `describe`. Sources referenced by name. No cast, non-null
assertion, `@ts-ignore` or `@ts-expect-error` in anything added (an initial draft of the
new files used `as` type assertions and `as const`; every one was removed before commit
in favour of typed fixtures and user-defined type guards). No fixture input is derived from
the constant it tests.

### Proof 35 — `lib/__tests__/retrieval-telemetry-core.test.ts` (existing file)

| Test | Provenance |
|---|---|
| 35.1 — every served class increments its OWN counter, and a null increments none | **RETITLED** — pre-existing (11 Aug 2026, "every served class increments its OWN counter, and a null increments none"); assertions byte-identical, title only. |
| 35.2 — ROW 1, provider success: vertex/openrouter/ollama→local, route counter, model and attempts preserved | NEW |
| 35.3 — ROW 2, PROVEN terminal failure: not_served += 1, failed += 1, served_model null | NEW |
| 35.4 — ROW 3, attribution unavailable: unattributed += 1, failed follows outcome | NEW |
| 35.5 — ROW 4, timeout: attempt outcome timeout, batch outcome timeout, class follows the proof rule | NEW |
| 35.6 — ROW 5 + the v11 §6.1 correction: skipped stage → served_route_class null (not not_served), no counter, **attempts []** | NEW (the 2.1 correction's test) |
| 35.7 — the v11 §6.1 correction at the other two sites: absent evidence → [] on a batch and on variant generation; transport "not collected" keeps null | NEW (the 2.1 correction's test) |
| 35.8 — ROW 6 AS AMENDED (v7 §6, v8 §2): Cohere/judge soft failure without proof → one terminal_failure record per planned boundary, class UNATTRIBUTED, soft_failed true; not_served only with proof | NEW |
| 35.9 — ROW 7, intended local: exactly one ollama attempt; local on success, not_served on proven failure | NEW |
| 35.10 — ROW 8, variant parse_failure preserves provider, model, attempts and both token counts; never not_served (and the batch parse_failure likewise) | NEW |
| 35.11 — ROW 9, parsed_empty / all_invalid / not_an_array preserve provider, model and usage | NEW |
| 35.12 — ROW 10 + the v11 §6.2 correction: failed_open → not_served only with proof, otherwise unattributed; only a stage that did not run records null | NEW (the 2.2 correction's test) |
| 35.13 — D16 Bedrock defensively: unattributed, no served model | NEW |

Proof 35: **1 retitled, 12 new.** No test was "completed" (nothing pre-existing was
extended in place).

### Proofs 45, 46, 47, 49 — `lib/__tests__/retrieval-telemetry-validation.test.ts` (NEW file)

| Test | Provenance |
|---|---|
| 45.0 — the fixture is CLEAN | NEW |
| 45.2 – 45.92 — one absent-or-invalid test per required D17 field (91 rows over the primary fixture: every field in D17's list, plus the per-batch fields, the v7 §10 decode fields, and the §10 `unattributed_with_model` / `not_served_with_model` pair) | NEW |
| 45.93 — the lab_multi_query fixture is CLEAN | NEW |
| 45.94 – 45.101 — the multi_query block, eight rows | NEW |
| 45.1 — OWN-PROPERTY CHECKS: missing / null / [] / '' / invalid number are five different answers | NEW |
| 45.102 — the HMAC-absent licence covers exactly the four D8 fields, only when declared | NEW |
| 46.1 — served_route_class null with status skipped validates clean; the same null on an expanded stage is a defect; an absent field is never a declaration | NEW |
| 46.2 — through the REAL builder: a normative_channel capture validates clean (and its attempts are []) | NEW |
| 47.1 — primary: REQUIRED, computed over the EXACT citedContext (trailing newline kept; trimmed / normalised / one-byte-appended all differ) | NEW |
| 47.2 — the EMPTY-STRING case: HMAC("") is a defined value; the zero-candidate primary row is not partial | NEW |
| 47.3 — the other FOUR roles: null, and NOT partial; a context handed to a non-primary role is not keyed | NEW |
| 49.1 — EMPTY FUSION (0/0) | NEW |
| 49.2 — HYDRATE EMPTIED (3/0): the two counts DIFFER | NEW |
| 49.3 — the two zero-candidate shapes are distinguishable | NEW |
| 49.4 — ONE HYDRATED CANDIDATE | NEW |
| 49.5 — RERANKER DISABLED (normative_channel and lab_direct) | NEW |

(45.1 sits out of sequence — it is the summary own-property test — so the per-field rows
could be generated in D17 order; the licence test takes the next number after the last
generated row, 45.102. Every title is unique; the runner lists no duplicate.) 113 tests. **All new.** The kickoff's "45 is partial —
complete it": the pre-existing partial coverage (§6) was not moved or retitled because it
belongs to a different proof; 45 is completed by this file.

### Proof 56 — `lib/__tests__/retrieval-telemetry-canonicalization.test.ts` (NEW file)

56.1 recursive at every depth · 56.2 nested-key permutation · 56.3 JSONB round trip
(jsonb's own key order — length then bytes — reproduced in memory, recursively) · 56.4
array reorder not equal · 56.5 undefined array element rejected, undefined in objects
omitted · 56.6 non-finite rejected. **All new**, 6 tests.

**Totals:** 3217 → **3348** tests (+131: 12 in the core file, 113, 6). One retitle. No
retitled test is reported as a new proof.

---

## 6. Where the pre-existing 35, 45 and 46 coverage was found

The 11 August build report records 35 "written and green", 45 "written but partial", 46
"written and green", without naming files. At `90d8db1` (the 11 Aug build) the only
telemetry test file touching these subjects was `retrieval-telemetry-core.test.ts`. What is
actually there, and what came later:

- **35** — `retrieval-telemetry-core.test.ts`: "every served class increments its OWN
  counter, and a null increments none" (the D16 counter rows) — **this is the 11 Aug
  coverage, now retitled 35.1**. Related, later, and NOT retitled because they carry their
  own proof or correction numbers: `pass-0a-corrections.test.ts` §2.3 (four tests: the
  judge arm's unproven not_served, the Cohere arm, the regression guard, and
  `servedClassOf` with real proof), `intended-attribution.test.ts` v7 §6 (a generic Cohere
  failure records unattributed), `batch-outcome-precedence.test.ts` 12.3 (a batch
  parse_failure preserves provider and usage), `rerank-pass-2.test.ts` 16.1 (Cohere untyped
  throw: synthesised terminal_failure batches, expected == recorded, soft_failed), and the
  core file's own "local, not-served and skipped stages are UNPRICED; unattributed and parse
  failures are not". None of those is titled by proof number and none was retitled.
- **45** — the only `validateManifest` coverage at `90d8db1` is inside "batch order is a
  property of candidate boundaries, never of completion order (constraint 7)": a clean
  fixture validates to `[]` and an overlap yields `overlapping_batches`. That is the
  "partial" 45. It is constraint 7's test and stays where it is, untitled by 45. Later,
  scattered per-field coverage exists in `pass-0a-corrections.test.ts` §2.2 (the two v7 §10
  decode fields: absent-vs-null and type), `attempt-taxonomy.test.ts` 11.6–11.10 (attempt
  outcomes at three locations), `rejected-terminal-and-backfill-target.test.ts` v7 §7
  (`active_backfill_target` present-and-null clean, absent a defect). All left in place and
  cited; 45 is completed by the new file.
- **46** — **no discoverable test asserted it.** The closest are `role-keyed-defects.test.ts`
  (uses the string `'expansion_served_route_class_absent'` as a fixture defect, asserting
  nothing about `skipped`) and `attempt-taxonomy.test.ts` 11.9 (a default built manifest —
  which has a skipped expansion — is counted only for attempt defects). The build report's
  "46 written and green" is not reproducible from the tree; 46.1 and 46.2 are new.

---

## 7. Proof 35 was built from addendum v7 §6 and v8 §2, not from D16 row 6

D16 row 6, as kickoff v11 writes it, says a Cohere soft failure records
`served_route_class 'not_served'` and `rerank_not_served_batches += that count`.
Addendum v7 §6 ruled: "A generic Cohere failure without transport proof records
`unattributed`, never an inferred `not_served`" — the proof rule governs, and D16's table is
amended to that extent. Addendum v8 §2 extended the identical rule to the judge arm
(`provenNotServed: false`, class `unattributed`). Where transport proof exists, `not_served`
stands on either arm.

Test 35.8 therefore asserts, for BOTH `cohere` and `judge` under an injected generic throw:
one synthesised `terminal_failure` record per planned boundary, `rerank_soft_failed`
true, expected == recorded, **`served_route_class 'unattributed'` on every record,
`rerank_not_served_batches` 0, `rerank_unattributed_batches` = the count** — and, with real
proof, `servedClassOf` → `not_served`. **35.8 would fail against D16 row 6's original
wording**, and it fails by name under mutation row 10 (the proof rule flipped) and row 12
(the counter flipped). The kickoff's D16 row 6 text was not built from.

---

## 8. The mutation table — sixteen rows, before the gate

Every row's exact unified diff, exact command, exit status, STARTED/ENDED and named
failures are in `CDMSS-GATE-EVIDENCE-PASS-3-18-AUG-2026.md` Part 1. Rows 1–8 are the
kickoff's eight, in its order; 9–16 add one row per further load-bearing claim.

| # | Mutated (sandbox) | Test file run | Named test(s) that failed | Exit |
|---|---|---|---|---|
| 1 | capture: skipped stage `attempts: []` → `null` | core | **35.6** | 1 |
| 2 | capture: `vg ? servedClassOf(ev) : null` → `vg && ev ? … : null` | core | **35.12** | 1 |
| 3 | capture: `case 'ollama': return 'local'` → `'openrouter'` | core | **35.2**, 35.9 | 1 |
| 4 | core: `trace_id_field_absent` check removed | validation | **45.14** (trace_id missing), 45.1 | 1 |
| 5 | core: `expansion_served_route_class_absent` no longer conditional on `skipped` | validation | **46.1, 46.2** (+47.2, 47.3, 49.1, 49.2, 49.4, 49.5 — every skipped-expansion payload) | 1 |
| 6 | core: scorer HMAC required on `lvc_recall` too | validation | **47.3** (+45.0's lvc_recall fixture) | 1 |
| 7 | capture: `fused_candidate_count` taken from the hydrated list | validation | **49.2, 49.3** | 1 |
| 8 | core: undefined array element nulled instead of thrown | canonicalization | **56.5** | 1 |
| 9 | capture: `manifestAttempts` absent evidence → `null` again | core | **35.7** | 1 |
| 10 | capture: PROVEN non-delivery → `'unattributed'` | core | **35.3**, 35.5, 35.8, 35.9, 35.12 | 1 |
| 11 | capture: absent evidence → inferred `'not_served'` | core | **35.4**, 35.12 | 1 |
| 12 | core: `not_served` counter increments `unattributed` | core | **35.1**, 35.3, 35.9 | 1 |
| 13 | core: canonicalize stops recursing (`out[k] = el`) | canonicalization | **56.1, 56.2, 56.3**, 56.5, 56.6 | 1 |
| 14 | capture: HMAC over `scorerContext.trim()` | validation | **47.1** | 1 |
| 15 | capture: `opts.scorerContext !== null` → truthiness (empty string → null) | validation | **47.2**, 49.1, 49.2 | 1 |
| 16 | core: negative `fused_candidate_count` accepted | validation | **45.41** (negative), 45.1 | 1 |

Every row failed its named test **by name**; every run finished in under two seconds; no
row was accepted on a file-level timeout. Row 11's runner expectation over-listed 35.8
(its synthesised evidence is a non-null object, unreachable by that mutation); the
description file records the correction. Rows 3, 10, 11, 12 together are proof 35's
"more than one load-bearing claim" rows; 14 and 15 are 47's; 9 is the second half of
correction 2.1; 13 is 56's second clause; 16 is 45's invalid-number clause.

**The four hashes (four files each), all equal — hash 1 (worktree before) = hash 2
(sandbox baseline) = hash 3 (worktree after) = hash 4 (`git show HEAD:` after commit 13):**

```text
b39b15f45b7f4b0657e91353052049ce60b638d2513b2ebffce3e67503308bf6  lib/retrieval-capture.ts
13de25781785b3f27df25a505727f0e4c0f22171e45638b0150d597419d8ef41  lib/__tests__/retrieval-telemetry-core.test.ts
496d445557b433e2a61a0e136d8a9349b1369a400ffc7232c0174207f59f5fe9  lib/__tests__/retrieval-telemetry-validation.test.ts
08633d47ed01a59dd9e56249e1f762aceb94029cbfeddce6872ebd8e1ca74884  lib/__tests__/retrieval-telemetry-canonicalization.test.ts
```

(The superseded first run's validation-file hash was `269551a5…`; the other three files were byte-identical across both runs.)

Sandbox at `/Users/vinaybhardwaj/cdmss-pass2-sandbox/repo`, shape verified, deleted after;
no git command inside it; each mutated file restored with `cp` and verified with `cmp`.

---

## 9. No row touches judge lifecycle or recorder counting

Stated plainly: **no mutation row alters judge request lifecycle or recorder counting.**
Rows mutate only `lib/retrieval-capture.ts` (1, 2, 3, 7, 9, 10, 11, 14, 15) and
`lib/retrieval-telemetry-core.ts` (4, 5, 6, 8, 12, 13, 16). No row touches `lib/rerank.ts`,
`lib/multi-query.ts` or `lib/__tests__/judge-server-stub.ts`. Each row ran only its named
test file, and none of the three imports the judge stub. Review 34's bounded-settlement
condition is not triggered; the sixteen unbounded waits are untouched.

---

## 10. Typecheck, test count, commit 13

- `npm run typecheck` → 0 (after the corrections, after the proofs, and again before staging).
- `npm test`: **3217** at `01c2375` → **3348** after commit 13, 0 failures.
- Staging validations against `01c2375`: `git status --porcelain --untracked-files=all` →
  `A`/`M`/`A`/`M` on exactly the four paths; `git diff --cached --stat 01c2375` → 4 files,
  956 insertions, 5 deletions; `git diff --cached --name-only 01c2375` → the four paths;
  `git diff --exit-code` → 0. Ignored check: exactly two lines (v23, review 34).
- **Commit 13: `84040291ca9fcede333d0373c749d97ae58723e2`** (amended once from `947d7de`,
  §14 item 12; `git diff --cached --stat 01c2375` for the amended commit → 4 files, 957
  insertions, 5 deletions). `git diff --name-only 01c2375..HEAD` → the four paths.
  `git status --porcelain` empty after.

---

## 11. The gate

Run from commit 13 (`8404029`), AFTER the mutation table, strictly in order. Raw
transcripts in `CDMSS-GATE-EVIDENCE-PASS-3-18-AUG-2026.md` Part 2. Window
2026-08-18T14:05:26Z to 14:07:04Z. (The superseded first run, from `947d7de`, was
13:58:12Z–13:59:50Z with identical results; preserved under `superseded-first-run/`.) Capture directory `$HOME/cdmss-pass3-gate-18-aug-2026` — new, nothing
overwritten. Every command has STARTED and ENDED.

| Command | STARTED | ENDED | Exit |
|---|---|---|---|
| 1. `npm test` — 3348 / 3348 / 0 | 14:05:26Z | 14:05:46Z | 0 |
| 2. `npm run typecheck` | 14:05:46Z | 14:05:49Z | 0 |
| 3. keyed production build | 14:05:49Z | 14:06:24Z | 0 |
| 4. `npm run architecture:check` — all 8 rules + coverage green | 14:06:24Z | 14:06:24Z | 0 |
| 5. `npm run architecture:map` | 14:06:24Z | 14:06:24Z | 0 |
| 6. precondition 1 / precondition 2 | 14:06:24Z | 14:06:25Z | 0 / 0 |
| 6. line 1 map · line 2 cp · line 3 map · line 4 cmp · line 5 `git diff --exit-code` | 14:06:25Z | 14:06:26Z | 0 · 0 · 0 · 0 · 0 |
| 7. `bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'` | 14:06:26Z | 14:06:26Z | 0 |
| aux. `git diff --exit-code data/reasoning-registry/prompts.generated.json` | 14:06:26Z | 14:06:26Z | 0 |
| 8. `npm run reasoning:governance` — GREEN, 0 ungoverned | 14:06:26Z | 14:06:27Z | 0 |
| 9. `npm run changelog:coverage` — GREEN, 19 versions | 14:06:27Z | 14:06:27Z | 0 |
| Build pair 1 — refusal | 14:06:27Z | 14:06:27Z | 1 (nonzero EXPECTED; names `CDMSS_TELEMETRY_HMAC_KEY`) |
| Build pair 2 — keyed | 14:06:27Z | 14:07:04Z | 0 |

**Command 6 — the map did NOT move.** `lib/retrieval-capture.ts` is in the import graph and
changed, but its imports did not: both generations wrote 90492 "bytes" (UTF-16 code units;
`wc -c` 90494 both times), `cmp` 0, `git diff --exit-code` 0. **No `git add`** anywhere in
the gate; the two preconditions passed. **Command 7's quotes** were preserved by the
heredoc method (the line written into the capture file through a single-quoted heredoc
before the identical line executed). `git status --porcelain` empty before, around
command 6, and after; the ignored list held exactly the two expected CDMSS lines
throughout.

---

## 12. The eight evidence digests

Verified before the corrections and again after the gate; every one matches (v20 §6.1 for
six; commit `f6e9188`'s message for the seventh; commit `01c2375`'s message for the eighth):

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
065be6a1af1232a34de56f2b26da3aaec8a3e6e1bded0db84fb267624a0e63a3  CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
db0df1afa205535422220d250895b0d0202d0f52ed1f28858b147abb357f9e15  CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
d6a94ec9cf71b0093fa56b2432ec6c7f3668f9884f39feebb349b5c3839added  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-16-AUG-2026.md
716bd5cd8ada6091c6b1efead83554e6ebf639dbc7e62f2b1319fca6fdb32be3  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-2-16-AUG-2026.md
f80c7591ad1cdd1df7dfaebed95c1c2575c0173d93282866742d494959c89b2a  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-3-17-AUG-2026.md
a5ff9ff20cfeb449c0b2fb58b07da4f872138e1d30c4fefad9ecb82ba6b7c3e9  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-4-17-AUG-2026.md
```

---

## 13. Current state

- Hard proofs: **7 of 20 closed** (11, 12, 17, 2, 16, 18, 70); **six more written and
  evidenced here** (35, 45, 46, 47, 49, 56) — **13 of 20 if Saul closes all six**. Saul
  closes proofs; the builder does not.
- Judge proofs closed: 4 of 4.
- Nothing deployed, nothing migrated, no Cohere activation, no pass 1 retrospective sweep,
  no pass 4. Pass 4 carries 21, 22, 23, 24; pass 5 carries 10, 14, 44 (v23 §2).
- The sixteen unbounded `judge.settled()` waits remain recorded test-harness debt.
- **Nothing was pushed in this pass.** `@{u}` = `01c2375`. Local, unpushed after commit 14:
  `8404029` (13) and commit 14 — two.

---

## 14. Disclosures — deviations and judgment calls, stated plainly

1. **v23 §12 vs §0.** v23's order-of-work section still describes the withdrawn signature
   ritual; §0 withdraws it and the kickoff says there is no script. Followed §0; reported.
2. **v23 §10.1 says "the kickoff names [the existing test files] exactly"; the kickoff §3.3
   instead asks the builder to find them.** The builder located them (§6) and chose the
   consolidated home for proof 35: `retrieval-telemetry-core.test.ts`, because that is
   where the 11 Aug "35 written and green" test lives. Commit 13's file set follows from
   that choice.
3. **Proof 35's numbered tests import `lib/rerank.ts` dynamically (35.8)** with injected
   throwers and a no-op health check, the same pattern `pass-0a-corrections.test.ts` uses;
   no socket, no judge stub, no lifecycle change. `retrieval-telemetry-core.test.ts` now
   imports from `../retrieval-capture` and `type`-imports from `../rerank`, which its header
   (not edited) does not mention.
4. **The pre-existing partial 45 and the related 35 coverage were cited, not retitled**
   (§6): they carry other proofs' or corrections' numbers. Only 35.1 was retitled.
5. **46's "written and green" (11 Aug) could not be located**; 46.1/46.2 are new. Reported
   as found, not as the build report claimed.
6. **Test numbering:** 45.1 sits out of sequence so the 99 per-field rows could be generated
   in D17 order, and the licence test takes the number after the last generated row
   (45.102); every title is unique (see item 12 for the duplicate that was caught and fixed).
7. **Sixteen rows, not eight.** The kickoff's eight are rows 1–8; the extra eight are per
   its own instruction to add rows for further load-bearing claims. Row 11's description
   records the runner's corrected expectation.
8. **A first draft of the new test files used `as` assertions.** All were removed before
   any hash was taken or anything staged; the committed files carry none in added code.
9. **One caller-citation comment in `lib/retrieval-capture.ts`** (above `servedClassOf`)
   was updated to quote the corrected expression — inside the authorized file, in service
   of the correction, but a line beyond the two expressions themselves.
10. **`D17 says retrieval_config "{} permitted"`; v7 §10 made two fields inside it required.**
    45 pins today's contract (the two field-absent codes on `{}`) and names the amendment
    in the file header rather than restoring D17's older wording.
11. **`pushAttemptOutcomeDefects`'s doc-comment in core is now stale** ("deferred to pass 3").
    Core is not an authorized path; flagged for a later pass.
12. **Commit 13 was amended once, before the gate that counts.** The first cut (`947d7de`)
    carried two tests titled `45.99`; the builder found it while writing this report, fixed
    the numbering (the licence test is `45.102`), amended commit 13 to `8404029`, and
    **re-ran the whole sixteen-row table from a fresh sandbox and the whole gate** against
    the amended bytes. Commits 1–12 are untouched; the amended commit is this pass's own and
    was never pushed. The first run's captures are preserved under the capture directory's
    `superseded-first-run/` (nothing overwritten) and are not the evidence. During the
    second table and gate the report draft was parked outside the worktree so the ignored
    check stayed at exactly the two expected lines.
13. **Order of writing.** The evidence file was generated after each gate run and the report
    written after it; the first evidence draft (never staged, never committed) was replaced
    by the regenerated one.
