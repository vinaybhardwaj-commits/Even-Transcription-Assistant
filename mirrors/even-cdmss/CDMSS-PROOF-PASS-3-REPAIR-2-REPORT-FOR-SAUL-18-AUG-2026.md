# CDMSS proof pass 3 — SECOND REPAIR report for Saul (proofs 45, 47, 56 under review 37)

Date: 18 August 2026 (work executed 2026-08-18 23:36Z–23:52Z UTC).
Authority: **Saul review 37**, which closed proof 35 and held 45, 47 and 56.
Governing addendum: `CDMSS-RERANK-TELEMETRY-ADDENDUM-v26-18-AUG-2026.md`, **AUTHORIZED
by the orchestrator on V's delegation, ratified by Saul review 35**. No digest, no signature
script (v26 §0). Addenda v15 to v25 govern everything v26 does not touch. Kickoff v11 is the
numbering authority.

Base: commit 16 at `fb5e9d52e070c723c8a57c67fac970337a4fe879`. **Commits 15 and 16 stand;
the repair is forward-only.**
Commit 17 (the repair): `ac0155cda011dbac3f00410838d14990340b9287` — four paths (of the five
v26 §4 permits; proof 35 is closed, so `retrieval-telemetry-core.test.ts` was not touched).
Commit 18 is the commit carrying this report (five paths per kickoff §0); its SHA is in the
builder's covering report.

**Nothing was pushed.** `@{u}` = `01c2375` throughout; five local commits after 17, six
after 18.

---

## 1. Stop conditions 1 to 4

1. `git rev-parse HEAD` → `fb5e9d52e070c723c8a57c67fac970337a4fe879`. PASS.
2. `git status --porcelain` → empty. PASS.
3. `CDMSS-RERANK-TELEMETRY-ADDENDUM-v26-18-AUG-2026.md` exists; line 15 reads
   `STATUS: AUTHORIZED by the orchestrator on V's delegation, ratified by Saul review 35`. PASS.
4. `git rev-parse @{u}` → `01c2375b4b40dc19bc2684ae2ecfa2b9664f5638`; four commits unpushed
   (`8404029`, `a4ef66e`, `f391973`, `fb5e9d5`), as expected. Not pushed.

Addendum v24 is no longer in the worktree root (review 37: it lives outside the worktree);
the ignored check showed exactly the two expected lines — v26 and review 37 — throughout.
The ten evidence digests were verified before any change and again after the gate (§14).

---

## 2. Each repair, quoted, with the test that proves it

### 2.1 Proof 45 — validation derived from an explicit field / null / type matrix (v26 §3.1–§3.5)

`lib/retrieval-telemetry-core.ts` now exports the matrix and derives `validateManifest` from it.
The rule shape, and three representative rows:

```ts
export interface D17FieldRule {
  path: string;                    // dotted; a `[]` segment walks the array's members
  origin: 'D17' | 'D8' | 'D15' | 'D16' | 'v7 §10' | 'v25 §3.2' | 'v25 §3.3' | 'v26 §3.4' | 'v26 §3.5' | 'v26 §3.1';
  nullable: D17Nullability;        // 'never' | 'always' | 'hmac_key_absent' | 'hmac_key_absent_or_skipped' | 'skipped' | 'no_batches' | 'unless_failure' | 'primary_hmac'
  type: D17FieldType;              // 'string' | 'nonempty_string' | 'boolean' | 'finite_number' | 'nonneg_number' | 'object' | 'array' | 'id_array' | 'string_array' | 'attempts' | 'enum'
  values?: readonly unknown[];
  absent: string; nullCode: string; invalid: string; mustBeNullCode?: string;
}
export const D17_FIELD_MATRIX: readonly D17FieldRule[] = [
  …
  { path: 'hmac_key_version', origin: 'D8', nullable: 'hmac_key_absent', type: 'nonempty_string', absent: 'hmac_key_version_field_absent', nullCode: 'hmac_key_version_absent', invalid: 'hmac_key_version_absent' },
  { path: 'batches[]', origin: 'v26 §3.1', nullable: 'never', type: 'object', absent: 'batch_member_invalid', nullCode: 'batch_member_invalid', invalid: 'batch_member_invalid' },
  { path: 'batches[].candidate_start', origin: 'D17', nullable: 'never', type: 'finite_number', absent: 'batch_boundaries_absent', nullCode: 'batch_boundaries_absent', invalid: 'batch_boundaries_absent' },
  …
];
```

The engine (`nullVerdict`, `typeSatisfied`, `parentsOf`, `applyRule`) walks the matrix through
own-property lookups only: **absent → `absent` code; null → the nullability condition against
the manifest; otherwise the type predicate → `invalid`**; a `[]` member rule reports every
non-object member and the field rules skip it, so nothing is dereferenced. Relations that no
per-field rule can express (§7 reconciliation, `bad_candidate_boundaries`, ordering, the §10
served-model pairing, passage-HMAC cardinality, variant arity, the role-conditional
`multi_query` presence) remain as an explicit second pass. **Every existing defect code is
preserved**; new codes are: `hmac_key_version_field_absent`, `telemetry_error_field_absent`,
`telemetry_error_invalid`, `batch_member_invalid`, `variant_member_invalid`,
`missing_score_keys_absent`, `nonnumeric_score_keys_absent`, the
`variant_generation_{prompt,completion}_tokens_{field_absent,invalid}`,
`variant_generation_{served_model,attempts}_field_absent`, `variant_generation_served_model_invalid`,
`variant_generation_served_route_class_invalid`, `variant_{index,outcome,candidate_count}_absent_or_invalid`,
`retrieval_error_class_invalid`, `served_backend_invalid`, `scorer_context_hmac_invalid`,
`expansion_{input_hmac,served_model}_invalid`, `batch_served_model_invalid`, and the
`{trace_id,deployment_sha,active_backfill_run_id,active_backfill_target,active_lab_experiment_id,corpus_version}_invalid`
type codes for fields that previously had a presence check only.

- **2.2 `batches: [null]` returns codes, does not throw** — 45.198 (`assert.doesNotThrow` and
  `batch_member_invalid` present) and 45.197 (hostile top-level values and a hostile value at
  every matrix path — **1708 placements**, printed — none throws). Mutation rows 2 (dereference
  restored → the named tests fail, not the file) and 8 (member code removed).
- **2.3 `candidate_start`** — its own matrix row and its own hand rows 45.64/45.65/45.66
  (missing, null, numeric string), independent of `candidate_end` (45.67/45.68). Mutation
  row 3 removes the `candidate_start` row: those three fail by name while `candidate_end`'s pass.
- **2.4 The licence's fields** — 45.196: under `hmac_key_absent` the four HMAC fields may be
  null but must be **present** (`hmac_key_version_field_absent`, `expansion_input_hmac_field_absent`,
  `pre_rerank_passage_hmacs_field_absent`, `scorer_context_hmac_field_absent`) and **typed**
  (`hmac_key_version_absent`, `expansion_input_hmac_invalid`, `pre_rerank_passage_hmacs_absent`,
  `scorer_context_hmac_invalid`); `telemetry_error` itself must be present and one of its two
  values (`telemetry_error_field_absent` / `telemetry_error_invalid`). Mutation rows 4 and 10.
- **2.5 Variant-generation usage** — matrix rows for `multi_query.variant_generation.prompt_tokens`
  and `.completion_tokens` (plus `served_model`, `attempts`, and the `variants[]` member fields);
  hand rows 45.118–45.121. Mutation row 5.

**Test provenance:** the hand-written per-field rows from the previous rounds stay (45.2–45.13x,
renumbered by insertion); the matrix suite 45.200–45.421 (three generated cases per row), 45.199
(the count), 45.198/45.197 (no throw), 45.196 (licence) are new. Proof 45 now holds **355 tests**
in the validation file (`grep -c "^ok [0-9]* - 45\." ` on the run: 355).

### 2.2 Proof 47 — the executable seam (v26 §3.6)

`lib/opd-note-audit.ts`, the ONLY change to that file (12 lines: a doc block and one export):

```ts
export const retrievalTerminalsSeam: { readonly writeRetrievalTerminals: typeof writeRetrievalTerminals } = { writeRetrievalTerminals };
```

It hands a test the **same** private function production calls at step 13 — unchanged,
unwrapped. **No production call site changed** (`git diff fb5e9d5..HEAD -- lib/opd-note-audit.ts`
is those 12 added lines and nothing else; `auditOpdNote`, `writeRetrievalTerminals` and every
caller are byte-identical); **the default path is unchanged** (nothing on it reads the seam);
it exists only so a test can drive what production drives.

**Tests 47.7 and 47.8 execute through it:** real `assembleAuditContext(hits, normHits)` output →
`retrievalTerminalsSeam.writeRetrievalTerminals({ tele, handle, publishHandle, traceId, startedAt,
citedContext, primaryCapture, normativeCapture })` — the production function runs
`readBackfillActivity`, `buildRetrievalPayload` for both roles, `validateManifest`, and the two
`writeRetrievalTerminal` UPDATEs, which the DB transport stub captures with their bound
parameters. Asserted: two UPDATEs (`run-47-primary`, then `run-47-normative`); the primary
`context_hmac` bound parameter equals `telemetryHmac(KEY, citedContext)` **exactly** (not of an
appended byte, not of the raw passages); the persisted primary manifest carries the same HMAC
and validates clean; the normative parameter and manifest HMAC are null and validate clean;
the returned verdicts are `{ primary: [], normative_channel: [] }`; the handle is published
after each write with the correct snapshots and the primary revision advanced. **47.8** repeats
it for zero hits: `citedContext === ''` and the primary write carries `HMAC("")`, a defined
string. The HMAC key is a literal set in `process.env` for the call and restored. Mutation rows
6 (seam replaced by a helper that skips production → 47.7/47.8 fail) and 9 (the primary
handoff keyed with null → 47.6, 47.7, 47.8 fail).

The source pin 47.6 remains, as supporting evidence only.

### 2.3 Proof 56 — bounded, fail-loud lifecycle (v26 §3.7)

`retrieval-telemetry-canonicalization.test.ts` — the harness:

```ts
type PgRunner = (tool: string, args: string[], timeoutMs: number, input?: string) => PgRun;   // { status, stdout, stderr, timedOut }
const TIMEOUTS = { initdb: 60_000, start: 45_000, stop: 45_000, status: 10_000, sql: 20_000 };
function makeRunner(bin: string): PgRunner { … spawnSync(join(bin, tool), args, { input, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' }) … }
function must(run, tool, args, timeoutMs, input?): string   // a timeout or non-zero exit THROWS naming tool, args, stderr

function teardown(c: Cluster, run: PgRunner): { stopStatus; verifiedStopped; deleted } {
  if (c.started) { const stop = run('pg_ctl', ['-D', c.data, '-m', 'fast', '-w', '-t', '30', 'stop'], TIMEOUTS.stop); … console.warn on failure — not swallowed … }
  const status = run('pg_ctl', ['-D', c.data, 'status'], TIMEOUTS.status);            // VERIFY
  const notRunning = !status.timedOut && (status.status === 3 || status.status === 4);
  const verifiedStopped = notRunning && !existsSync(join(c.data, 'postmaster.pid'));
  if (!verifiedStopped) throw new Error(`proof 56: SHUTDOWN NOT VERIFIED — the data directory is LEFT IN PLACE for a human: ${c.dir} (…). Nothing was deleted.`);
  rmSync(c.dir, { recursive: true, force: true });                                      // only after verification
  if (existsSync(c.dir)) throw new Error(`proof 56: the cluster directory survived removal: ${c.dir}`);
  return { stopStatus, verifiedStopped, deleted: true };
}
function startCluster(run): Cluster { … must(initdb) … bounded pg_ctl start, up to five ports … } catch (e) { teardown(c, run); throw e; }
before(() => { … cluster.c = startCluster(cluster.run); … });
after(() => { … const outcome = teardown(c, cluster.run); assert.equal(outcome.verifiedStopped && outcome.deleted, true, …); });
```

**How shutdown is verified before deletion:** `pg_ctl status` on the data directory must exit
3 (no server running) or 4 (directory inaccessible), within 10 s, AND `postmaster.pid` must
be absent; only then `rmSync`, and then the directory is confirmed gone. **When verification
fails:** nothing is deleted; `teardown` throws naming the directory, the stop's exit/timeout,
the status output and the pid-file state; in `after()` that throw fails the run. A failed
startup runs the same `teardown` before rethrowing, so it cannot bypass it. Every tool call is
bounded and a timeout is a named failure. Missing binaries still fail loudly (`findPgBin`).

**Test 56.7** proves the rules with a fake runner against real temp directories: (A) stop ok +
status "no server" → deleted, confirmed gone; (B) stop exit 1 + status "server is running" →
throws `SHUTDOWN NOT VERIFIED … <dir> … Nothing was deleted`, the directory and its marker
survive, the stop failure was reported; (C) stop timed out but status "no server" → deleted
(verification decides, not the stop's exit); (D) a stale `postmaster.pid` blocks deletion; (E)
the real runner kills a 5 s `sleep` at a 200 ms timeout and `must()` names it. Mutation row 7
(verification removed, delete regardless → 56.7 fails by name).

**How the instance was created and destroyed:** `initdb` into `mkdtemp(tmpdir()/cdmss-proof56-pg-…)`
(trust auth, throwaway role `cdmss_proof56`), `pg_ctl` bound to 127.0.0.1 on a random port
20000–39999 with the socket inside the temp dir; disposable and non-production (no env
connection string, not Neon, no patient-derived value); destroyed by `teardown` in `after()`.
Verified after every run of this round: no `cdmss-proof56-pg-*` directory under the temp dir,
no `postgres -D` process. Homebrew postgresql@18 (18.4).

---

## 3. Proof 45 coverage — the number, and how it was counted

Stated numbers are **printed by the test that computes them** (test 45.199, in the run
transcript, `# proof 45:` lines):

- `D17_FIELD_MATRIX.length` = **74** matrix rows; the generated suite produced **222** cases
  (`matrixCases === 3 * D17_FIELD_MATRIX.length`, asserted); paths are unique (asserted).
- D17's required-field list, **transcribed** into the test as a literal array (`D17_LIST`,
  one entry per field named in kickoff v11 D17, grouped lines expanded), has **54** entries;
  the test asserts **53** resolve to matrix paths and **1** (`multi_query`) is the
  role-conditional presence rule enforced in the relation pass (tests 45.92/45.94).
- Matrix rows by origin, from the table: D17=57, D8=4, D16=2, D15=2, v7 §10=2,
  v25 §3.2=2, v25 §3.3=1, v26 §3.1=2, v26 §3.5=2 (sum 74, asserted).
- Hostile placements that did not throw: **1708** (45.197, counted by the loop).

Command to reproduce: `node --test --import tsx lib/__tests__/retrieval-telemetry-validation.test.ts 2>&1 | grep '# proof 45'`.
No other coverage figure is stated in this report.

---

## 4. Typecheck and tests — before, after the production changes, at the end

| When | typecheck | `npm test` |
|---|---|---|
| before writing, at `fb5e9d5` (23:36Z) | 0 | 3360 / 3360 / 0 |
| after the core rewrite alone (23:38Z) | 0 | 3360 / 3359 / **1** — see below |
| after the core rewrite, code name kept (23:39Z) | 0 | 3360 / 3360 / 0 |
| after both production changes, before any test (23:39:52Z–23:40:12Z) | 0 | **3360 / 3360 / 0 — no existing test failed** |
| after the tests (23:46:39Z–23:47:02Z) | 0 | **3607** / 3607 / 0 |
| commit 17 staging | 0 | — |
| gate command 1 (23:49:00Z–23:49:22Z) | — | 3607 / 3607 / 0 |

**The one interim failure, disclosed:** the first cut of the matrix gave `candidate_start` and
`candidate_end` new distinct codes; my own last-round row `45.64` asserted the established name
`batch_boundaries_absent` for `candidate_end` and failed. That is a code-name churn of mine, not
a test asserting a throwing or unvalidated shape; the matrix now keeps the established code for
both boundary rows (independence comes from two matrix rows and two sets of tests, not two
codes) and the suite was re-run clean before the seam was added. 3360 → **3607** (+247:
+246 in the validation file, +1 in the canonicalization file).

---

## 5. The mutation table — ten rows, before the gate

Every row's exact unified diff, exact command, exit status, STARTED/ENDED and named failures
are in `CDMSS-GATE-EVIDENCE-PASS-3-REPAIR-2-18-AUG-2026.md` Part 1. Rows 1–7 are the kickoff's
seven, in its order; 8–10 add one per further load-bearing claim. All ran with the sandbox as cwd.

| # | Mutated (sandbox copy) | Test file | Named test(s) that failed | Exit |
|---|---|---|---|---|
| 1 | core matrix: `expected_batch_count` `nullable: 'never'` → `'always'` | validation | **45.57** (the hand row) | 1 |
| 2 | core engine: members no longer filtered + `hasOwnProperty.call` dereference → a null member throws | validation | **45.198, 45.197**, 45.70, 45.123, 45.335, 45.410 | 1 |
| 3 | core matrix: the `candidate_start` row removed | validation | **45.64, 45.65, 45.66**, 45.199 (D17 list) | 1 |
| 4 | core engine: a missing `hmac_key_version` tolerated under the licence | validation | **45.196** | 1 |
| 5 | core matrix: the two variant-generation token rows removed | validation | **45.118, 45.119, 45.120, 45.121** | 1 |
| 6 | opd-note-audit: the seam hands out a stub returning clean verdicts, production skipped | validation | **47.7, 47.8** | 1 |
| 7 | canonicalization harness: teardown's verification removed, delete regardless | canonicalization | **56.7** | 1 |
| 8 | core engine: the member code removed (`batch_member_invalid` never pushed) | validation | **45.198**, 45.70, 45.71, 45.123, 45.335–45.337, 45.410–45.412 | 1 |
| 9 | opd-note-audit: the primary handoff keyed with `scorerContext: null` | validation | **47.7, 47.8**, 47.6 | 1 |
| 10 | core matrix: the `telemetry_error` row removed | validation | **45.196**, 45.74, 45.75 | 1 |

Every row failed its named test **by name**; every run finished in under three seconds; none was
accepted on a file-level timeout. **Row 1's observation, stated:** the matrix-generated null case
for `expected_batch_count` did *not* fail, because it derives its expectation from the matrix as
loaded; the hand-written row did. The generated suite guards the engine against the matrix; the
hand rows (and 45.199's transcribed D17 list, which failed under row 3) guard the matrix.

**The four hashes (four files each), all equal — hash 1 (worktree before) = hash 2 (sandbox
baseline) = hash 3 (worktree after) = hash 4 (`git show HEAD:` after commit 17):**

```text
4c30b088b5e3829f7dba102e6c71401432ce09f839eebb06f61785c843745698  lib/retrieval-telemetry-core.ts
d6ebefd9dd4356fc99c330692205f6d623d5b6fec1586bd208d5337d3f1fc88a  lib/opd-note-audit.ts
da673a7d03a6e1bace29e9a7903bb09f7c105d76b637dd99a1b9fc34b9b11b9f  lib/__tests__/retrieval-telemetry-validation.test.ts
141a56f809e8082b324994440e63af415983e6a490ffe3ffdf7b08b5fd75089e  lib/__tests__/retrieval-telemetry-canonicalization.test.ts
```

Sandbox at `/Users/vinaybhardwaj/cdmss-pass2-sandbox/repo`, shape verified, deleted after; no git
command inside it; each mutated file restored with `cp` and verified with `cmp`.

---

## 6. No row touches judge lifecycle or recorder counting

Stated plainly: **no mutation row alters judge request lifecycle or recorder counting.** Rows
mutate `lib/retrieval-telemetry-core.ts` (1, 2, 3, 4, 5, 8, 10), the seam or the primary handoff
in the sandbox copy of `lib/opd-note-audit.ts` (6, 9), and the proof 56 harness (7). Only the
validation and canonicalization test files ran; neither imports the judge stub; 47.7/47.8 drive
`writeRetrievalTerminals` against the DB transport stub only. Review 34's condition is not
triggered; the sixteen unbounded waits are untouched.

---

## 7. Commit 17

- Staging validations against `fb5e9d5`: `git status --porcelain --untracked-files=all` → `M` on
  exactly the four paths; `git diff --cached --stat fb5e9d5` → 4 files, 853 insertions, 253
  deletions; `git diff --cached --name-only fb5e9d5` → the four paths; `git diff --exit-code` → 0.
  Ignored check: exactly **two** lines (v26, review 37).
- **Commit 17: `ac0155cda011dbac3f00410838d14990340b9287`.** `git diff --name-only fb5e9d5..HEAD`
  → the four paths. `git status --porcelain` empty after.

---

## 8. The gate

Run once, from commit 17, AFTER the mutation table, strictly in order. Raw transcripts in
`CDMSS-GATE-EVIDENCE-PASS-3-REPAIR-2-18-AUG-2026.md` Part 2. Window 2026-08-18T23:48:59Z to
23:50:38Z. Capture directory `$HOME/cdmss-pass3-repair2-gate-18-aug-2026` — new, nothing
overwritten. Every command has STARTED and ENDED.

| Command | STARTED | ENDED | Exit |
|---|---|---|---|
| 1. `npm test` — 3607 / 3607 / 0 | 23:49:00Z | 23:49:22Z | 0 |
| 2. `npm run typecheck` | 23:49:22Z | 23:49:25Z | 0 |
| 3. keyed production build | 23:49:25Z | 23:50:00Z | 0 |
| 4. `npm run architecture:check` — all 8 rules + coverage green | 23:50:00Z | 23:50:01Z | 0 |
| 5. `npm run architecture:map` | 23:50:01Z | 23:50:01Z | 0 |
| 6. precondition 1 / precondition 2 | 23:50:01Z | 23:50:01Z | 0 / 0 |
| 6. line 1 map · line 2 cp · line 3 map · line 4 cmp · line 5 `git diff --exit-code` | 23:50:02Z | 23:50:02Z | 0 · 0 · 0 · 0 · 0 |
| 7. `bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'` | 23:50:03Z | 23:50:03Z | 0 |
| aux. `git diff --exit-code data/reasoning-registry/prompts.generated.json` | 23:50:03Z | 23:50:03Z | 0 |
| 8. `npm run reasoning:governance` — GREEN, 0 ungoverned | 23:50:03Z | 23:50:03Z | 0 |
| 9. `npm run changelog:coverage` — GREEN, 19 versions | 23:50:03Z | 23:50:03Z | 0 |
| Build pair 1 — refusal | 23:50:03Z | 23:50:04Z | 1 (nonzero EXPECTED; names `CDMSS_TELEMETRY_HMAC_KEY`) |
| Build pair 2 — keyed | 23:50:04Z | 23:50:38Z | 0 |

**Command 6 — the map did NOT move**, although both `lib/retrieval-telemetry-core.ts` and
`lib/opd-note-audit.ts` changed: neither gained or lost an import; both generations wrote
90492 "bytes" (UTF-16 code units; `wc -c` 90494 both times), `cmp` 0, `git diff --exit-code`
0. **No `git add`** anywhere in the gate; both preconditions 0. **Command 7's quotes** were
preserved by the heredoc method (the line written into the capture file through a
single-quoted heredoc before the identical line executed). `git status --porcelain` empty
before, around command 6, and after; the ignored list held exactly the two expected CDMSS
lines throughout.

---

## 9. The ten evidence digests

Verified before any change and again after the gate; every one matches (v20 §6.1 for six;
`f6e9188`'s message for the seventh; `01c2375`'s for the eighth; `a4ef66e`'s for the ninth;
`fb5e9d5`'s for the tenth):

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
065be6a1af1232a34de56f2b26da3aaec8a3e6e1bded0db84fb267624a0e63a3  CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
db0df1afa205535422220d250895b0d0202d0f52ed1f28858b147abb357f9e15  CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
d6a94ec9cf71b0093fa56b2432ec6c7f3668f9884f39feebb349b5c3839added  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-16-AUG-2026.md
716bd5cd8ada6091c6b1efead83554e6ebf639dbc7e62f2b1319fca6fdb32be3  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-2-16-AUG-2026.md
f80c7591ad1cdd1df7dfaebed95c1c2575c0173d93282866742d494959c89b2a  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-3-17-AUG-2026.md
a5ff9ff20cfeb449c0b2fb58b07da4f872138e1d30c4fefad9ecb82ba6b7c3e9  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-4-17-AUG-2026.md
d4eb69dac3c48770cbe807de30ce43b9799755f416ee6298b77df7fc4dd01f53  CDMSS-GATE-EVIDENCE-PASS-3-18-AUG-2026.md
1e313c937a402a8f8ac32f3f33b8d0453bb1c3e22bb9198f212fd9f8ebc02297  CDMSS-GATE-EVIDENCE-PASS-3-REPAIR-18-AUG-2026.md
```

---

## 10. Current state

- Hard proofs closed: **10 of 20** (11, 12, 17, 2, 16, 18, 70, 46, 49, 35). Proofs 45, 47, 56 are
  repaired and evidenced here — **13 of 20 if Saul closes all three**. Saul closes proofs.
- Judge proofs closed: 4 of 4.
- Nothing deployed, nothing migrated, no Cohere activation or operational benchmark, no pass 1
  retrospective sweep, no pass 4.
- The sixteen unbounded `judge.settled()` waits remain recorded test-harness debt.
- **Nothing pushed.** `@{u}` = `01c2375`. Local, unpushed after commit 18: `8404029`, `a4ef66e`,
  `f391973`, `fb5e9d5`, `ac0155c`, and commit 18 — six.

---

## 11. Disclosures — deviations and judgment calls, stated plainly

1. **The matrix widens validation beyond the four named repairs**: it adds type checks to
   fields that had only presence checks (the `*_invalid` codes listed in §2.1), validates
   `telemetry_error` as a present, typed field, the D15 score counts, the variant-generation
   `served_model`/`attempts`, and the `variants[]` member fields, and reports non-object array
   members. All follow from "an explicit matrix that is the single source of truth" (v26 §3.1);
   every existing code is preserved and no existing test failed, but this is more production
   change than the four named items alone.
2. **`batch_boundaries_absent` stays the code for both boundary fields** after the interim
   failure in §4; independence is by matrix row and by test, not by code name.
3. **Two dead helpers (`isServedRouteClass`, `isVariantStatus`) were removed** and one stale
   note on `pushAttemptOutcomeDefects` corrected in `lib/retrieval-telemetry-core.ts` — inside
   the authorized file, behaviour-free, but beyond the letter of the seven items.
4. **The seam is an exported object holding the private function**, not an injected parameter.
   The kickoff's three conditions hold (no caller passes it, default path byte-identical,
   test-only purpose); if Saul reads "seam" as requiring an optional parameter shape, that is
   a change to request.
5. **47.7/47.8 set `CDMSS_TELEMETRY_HMAC_KEY` in `process.env`** to a literal for the call and
   restore it, because the production function reads the key from the environment.
6. **The `multi_query` D17 entry is a relation-pass rule, not a matrix row** (role-conditional
   presence); 45.199 says so and counts it separately (53 + 1).
7. **Row 1's generated-suite blind spot** (a nullability flip inside the matrix) is stated in
   §5 and in the row's description; the hand rows and 45.199 are the guards for that class.
8. **Ten rows, not seven** — the kickoff's "add rows" instruction.
9. **Test count 3360 → 3607**, of which the 222 matrix-generated cases are one loop; reported as
   the runner counts them.
