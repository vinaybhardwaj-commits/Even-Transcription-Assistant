# CDMSS proof pass 2 — supplemental report for Saul

Date: 17 August 2026 (work executed against the 16 August kickoff)
Authority: **Saul review 29.** Governing addendum:
`CDMSS-RERANK-TELEMETRY-ADDENDUM-v18-16-AUG-2026.md`, signed by V
(`STATUS: SIGNED by V, 16 August 2026` — read, not grepped).
Kickoff: `CDMSS-PASS-2-PROOF-REPAIRS-CC-KICKOFF-16-AUG-2026.md`; kickoff v3 and
addenda v15/v16/v17 stay in force where v18 does not touch them.

Base: commit 4 at `d69a11d7c57c18157b371b9079ffd2a00f466ce6`.
Commit 5 (the corrective implementation commit):
`fe59b07657d50553f9d535e989b42b92032cf604` — exactly the four test paths.
Commit 6 is the commit that carries this report; its SHA is stated in the
builder's covering report, since a commit cannot contain its own hash.

Review 29 closed proofs 17, J3 and J4 and held **2, 16, 18, 70, J1 and J2** on
seven blocking findings. All seven are repaired here, test-only. Commits 1 to 4
stand untouched.

---

## 1. Stop conditions

1. Addendum v18 §0 read in full: exactly one `STATUS:` line —
   `STATUS: SIGNED by V, 16 August 2026`. It names V. PASS.
2. `git rev-parse HEAD` printed `d69a11d7c57c18157b371b9079ffd2a00f466ce6`. PASS.
3. `git status --porcelain` printed nothing. PASS.
4. `git rev-parse @{u}` equalled HEAD. PASS.

---

## 2. Proofs 2, 16, 18 and 70, quoted VERBATIM

Source: `CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md`, section
6, the numbering authority (tests 1 to 73). Review 29 found these were asserted
to match but not quoted; they are quoted here, byte for byte as they appear in
that file's numbered list:

> 2. The `cohereFn` adapter passes the capture as capture and not as `fetch`, and the Cohere path still works with an injected `fetchImpl`.

> 16. **Cohere soft failure.** More than one candidate, Cohere selected, an untyped throw, `inputOrder()` returned, one synthesised `terminal_failure` batch per planned boundary, expected equals recorded, `rerank_soft_failed` true, and the row not partial.

> 18. `expected_batch_count` equals `ceil(retained_pool / JUDGE_BATCH)` when the **judge served** and 1 when **Cohere served**. It is always derived from `served_backend`, never from `intended_backend`; test 70 covers the case where they differ. **The test reads `JUDGE_BATCH` out of the source text of `lib/rerank.ts`** and computes the expectation from what it read. It does not import the constant and does not hard-code its value.

> 70. **The Cohere-to-judge downgrade.** Backend Cohere by environment default, `checkHealthy` throws `RerankBackendError`, the judge serves. `intended_backend` is Cohere, `served_backend` is the judge, `rerank_backend_downgraded` is true, `expected_batch_count` matches the judge's batches, and the row is `persisted_complete`. **Also assert that provider selection and fallback order are byte-identical to today**, since PRD section 4.4 forbids changing them.

---

## 3. The seven repairs

### 3.1 Repair one — proofs 16 and 70: real manifest validation (finding 1)

**Was:** both tests called `verdictForRun({ primary: [] }, 'primary', true)` — a
stipulated defect list. 70.3 additionally computed real defects, filtered
`index_version_absent` out, then discarded the result and supplied
`{ primary: [] }` anyway.

**Now:** in `rerank-pass-2.test.ts`, both 16.1 and 70.3 run the real chain,
unbroken:

```ts
const defects = core.validateManifest({ ...m, operational });
const verdict = settlement.verdictForRun({ primary: defects }, 'primary', true);
const outcome = settlement.upgradeForDefects(settlement.outcomeForSaveResult('inserted'), verdict);
assert.equal(core.stateForSettlement(outcome), 'persisted_complete', 'the row is not partial');
```

The `operational` block mirrors production's assembly in `lib/opd-note-audit.ts`
(the `operationalFor` helper inside `writeRetrievalTerminals` — the function
addendum v18 names `finaliseTelemetry`), typed as the real `OperationalTelemetry`
with no cast. No `?? {}` anywhere; the `primary` key is present and carries
exactly what `validateManifest` returned.

**The fixture was completed, not the code filtered.** The captures never pass
through `retrieve()`, production's `index_version` stamp site, so both fixtures
now set `capture.indexVersion = 'embedding|nomic-embed-text'` — the value
production stamps for the default embedding column
(`lib/retrieve.ts`: `` capture.indexVersion = `${embCol}|${...EMBED_MODEL}` ``).
With the fixture complete, real `validateManifest` returned `[]` — no code other
than the formerly-filtered `index_version_absent` ever appeared, and with the
fixture complete none appears at all.

**Both arms, per v18 §3.1b.** Each test asserts the actual array contents:

- Clean arm: `validateManifest` returned `[]` (asserted with `deepEqual`), the
  verdict is `[]`, the outcome is `persisted_clean`, the state is
  `persisted_complete`.
- Dirty arm: one payload field deliberately broken —
  `recorded_rerank_batches` off by one against the batches array — and the real
  validator returned exactly `['recorded_batch_count_mismatch']` (asserted with
  `deepEqual`); the same chain settles `persisted_dirty` →
  `persisted_partial`.

No defect list was hand-written, filtered, masked or subtracted in either test.
Guarded by mutation row 23.

### 3.2 Repair two — J1's comparator keeps the tuple together (finding 2)

`sameWireObservations` in `judge-server-stub.ts`: the group key stays the marker
set; the group value is now ONE Buffer, `method` + `path` + NUL + `body`, sorted
within its group by `Buffer.compare` and compared byte-exactly. The separate
method/path multiset is deleted. `groupByMarkerSet` is unchanged — the tuple is
built inside the comparator — because two existing tests assert on that helper's
output as body bytes.

```ts
const tuple = Buffer.concat([Buffer.from(o.method, 'utf8'), Buffer.from(o.path, 'utf8'), Buffer.from([0]), o.body]);
```

**The guard:** new test 5.9b in `explicit-judge-equivalence.test.ts` swaps paths
between two marker groups (and, symmetrically, methods) and shows the comparator
reports a difference, plus a positive control that identical tuples in a
different arrival order still compare equal. Guarded by mutation row 24.

### 3.3 Repair three — proof 18's Cohere arm runs the real function (finding 3)

18.2's injected `cohereFn` now DELEGATES to the real `rerankCohere` with an
injected fetch in position 3 (the proof 2.1 shape), `async () => {}` as
`recordCost`:

```ts
cohereFn: async <U extends RerankCandidate>(q: string, c: U[], cap?: TelemetryCapture) =>
  rerankCohere(q, c, fetchImpl, async () => {}, cap),
```

The injected fetch returns a well-formed Cohere reply (status 200,
index-aligned `relevance_score`s, `usage.cost`). `OPENROUTER_API_KEY` is saved,
set to `proof-18-key-not-a-secret`, and restored-or-deleted in `finally`. The
stamps under assertion (`servedBackend`, `expectedBatchCount = 1`, one `success`
batch, the manifest's `expected_batch_count`) are now the production function's
own. Guarded by mutation row 25.

### 3.4 Repair four — proof 2.2's discriminator (finding 4)

The `TypeError` claim is gone: `cohereRelevanceScores` wraps ANY error from the
fetch call as `RerankBackendUnreachable`, so `instanceof` held in both the
correct and the swapped case and discriminated nothing. Test 2.2 now carries the
two assertions together:

1. **Failure variant** (guard refuses the real outbound fetch):
   `assert.doesNotMatch((thrown as Error).message, /is not a function/)` — a
   capture in the fetch slot is called as a function and produces exactly that
   text inside the same wrap.
2. **Success variant with `deps.cohereFn` OMITTED**, so the module-built default
   adapter runs. There is no seam to inject a fetch through it — the adapter is
   `rerankCohere(q, c, undefined, undefined, cap)` and the default parameter
   resolves the global at call time — so `globalThis.fetch` is replaced for the
   duration of the call and restored in `finally` (the connection guard patches
   `net.Socket.prototype.connect`, not fetch, so the replaced global dials
   nothing). Assertions: `capture2.servedBackend === 'cohere'` and
   `capture2.batches.length === 1` — stamps only `rerankCohere`'s `if (capture)`
   block can produce, which is unreachable if the capture sat in the fetch slot.

The existing source-text check is kept and relabelled in a comment as a
**source pin, not a behavioral discriminator**; it is not described as one
anywhere. Guarded by mutation row 26.

### 3.5 Repair five — proof 70 observes order during the call (finding 5)

`downgradeRun` now gives both injectable collaborators a shared ordered log that
each pushes to AT INVOCATION; the injected `judgeFn` then delegates to the real
`rerankJudge`, so the judge still serves on the wire:

```ts
checkHealthy: async () => { order.push('checkHealthy'); throw new RerankBackendUnreachable('cohere', 'rerank-v3.5', 'probe refused by design'); },
judgeFn: async <U extends RerankCandidate>(q: string, c: U[], cap?: TelemetryCapture) => {
  order.push('judgeFn');
  return rerankJudge(q, c, cap);
},
```

70.1 asserts `assert.deepEqual(order, ['checkHealthy', 'judgeFn'])` — proved
during the call, not reconstructed afterwards — plus the wire count (2 batches)
and the reordered output. The backend argument stays `undefined` (the resilient
arm; explicit `'cohere'` would take the strict arm, which never downgrades).
`_resetRerankHealth()` runs before the call and in `finally`. The judge arrow's
parameters are annotated explicitly; no cast. The manifest assertions (70.2),
the settlement assertions (70.3, per repair one), and the source-parity
assertion (70.4) all stay. Covered by re-run mutation row 17, which now fails
70.1's order assertion.

### 3.6 Repair six — J2's hostile-default arms prove the failure (finding 6)

J2.2's two failure arms keep their captures and pin the outcome:

- **Real batch parse failure** (real `rerankJudge`,
  `judge.setRawContent(() => 'not json')`, usage turned ON for the arm):
  `servedBackend === 'judge'`, `rerankSoftFailed === false`, every batch outcome
  `'parse_failure'`, evidence non-null with non-null servedProvider and
  servedModel, `finiteScoreKeys === 0`,
  `missingScoreKeys === bt.end - bt.start`, numeric `promptTokens` and
  `completionTokens`. Judge-call count for this arm comes from the STUB's
  recorded request list (`judge.requests`, kind `'judge'`, count 2) — the real
  `rerankJudge` is not injected, so counters cannot see it.
- **Generic outer judge failure** (injected `judgeFn` throws):
  `rerankSoftFailed === true`, every batch outcome `'terminal_failure'`,
  evidence `servedProvider/servedModel/attempts` all null,
  `provenNotServed === false`, tokens null, result rows
  `rerank_backend === 'none'`, and the wrapped counter `n.judge === 1`.

A zero-Cohere pass can no longer be a no-call pass on either arm. Guarded by
mutation row 27 (and rows 15/16 for the zero-counter claims).

### 3.7 Repair seven — the recorder guards (finding 7)

**Socket reuse (v18 §3.7a).** The stub gains a module-level
`WeakMap<net.Socket, number>` plus counter; a socket identity is assigned at
acceptance, beside `seq`, and recorded on the observation as `socketId` — the
one field addendum v18 §4.2 permits (recorded only while recording is enabled;
`JudgeRequest` gains no field, so v15 §5.11 is untouched). Test 5.5b now pins
both requests to ONE socket via a keep-alive agent (`maxSockets: 1`) and asserts
different `seq`, same `socketId` — reuse proven, not inferred. Test 5.3's
exhaustive field list was updated to six fields in the same commit. Guarded by
mutation row 28.

**Exhaustive own keys (v18 §3.7b).** `Reflect.ownKeys` replaced `Object.keys`
at all four sites — 5.3's field-set `deepEqual` and regex loop, and 5.11's
field-set `deepEqual`s and regex loop — with every key wrapped in `String(k)`
before any regex or `deepEqual`. Guarded by mutation row 29, whose symbol
carries the description `x-authorization-header`, which the no-headers regex
matches.

**5.4's timing assumption (v18 §3.7c).** The
`await new Promise((r) => setTimeout(r, 30));` is replaced by a deterministic
acceptance signal: the test waits until `judge.inFlight() === 1` —
`seq` is assigned at acceptance and acceptance is where the in-flight counter
increments, so this waits for exactly the event that assigns A's sequence
number. The comment records that the previous version carried an unacknowledged
30 millisecond assumption. Covered by re-run mutation row 5.

### 3.8 J4's arm-count follow-up (carried with J4's closure)

J4.2 in `explicit-judge-retrieve.test.ts` now asserts both sides of the seam,
with the required comments:

```ts
assert.equal(armCaptures.length, 3);        // calls observed at the seam
assert.ok(capture.children, 'retrieveMultiQuery assigned the children array');
assert.equal(capture.children.length, 3);   // the array production built
```

Guarded by mutation row 30.

---

## 4. The mutation table — run BEFORE the gate

Per v18 §4.3: repairs → typecheck → `npm test` → the COMPLETE table → commit →
gate. All thirty rows ran — the twenty-two existing rows (row 5 explicitly
re-run, which addendum v17 §4 omitted) and the eight new rows. Every row failed
its named test BY NAME; no row was accepted on a file-level timeout; every
row's exact unified diff and exact command are recorded in
`CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-16-AUG-2026.md` Part 1.

| # | Named test that failed | Also failed (collateral) |
|---|---|---|
| 1 | 5.5b (1048577 rejection) | 5.5a (the source pin on the constant) |
| 2 | 5.5a | — |
| 3 | 5.7 | J1.1, J1.2, J1.3 (snapshot poisoned for the wire compare) |
| 4 | 5.7 | — |
| 5 | 5.4 | — |
| 6 | 5.6 | — |
| 7 | 5.6 | — |
| 8 | 5.10 | J1.1 |
| 9 | 5.8 | — |
| 10 | 5.5b | — |
| 11 | 5.2 | — |
| 12 | 5.3 | — |
| 13 | 5.9 | 5.9b |
| 14 | 5.11 | — |
| 15 | J2.1, J2.2 | 17.1, 18.1, 18.3, 70.1, 70.2, 70.3 |
| 16 | J2.1, J2.2 | 17.1, 18.1 |
| 17 | 70.1 (the order assertion) | 70.2, 70.3 |
| 18 | 18.3 | 70.2, 70.3 |
| 19 | 17.1 | J2.2 |
| 20 | J3.2 | — |
| 21 | J4.1 | J4.2 |
| 22 | J4.1, J4.2 | — |
| 23 | 16.1 and 70.3 (the DIRTY arms) | — |
| 24 | 5.9b | — |
| 25 | 18.2 | 2.1 |
| 26 | 2.2 | — |
| 27 | J2.2 (parse-failure arm) | 17.1 |
| 28 | 5.5b (socket reuse) | — |
| 29 | 5.3 (no-headers check) | — |
| 30 | J4.2 | J4.1 |

Design notes honoured: row 23 discriminates only against the dirty arms (the
clean fixture makes `[]` legitimate); no new row for proof 70's order — re-run
row 17 covers 70.1, where the order assertion now lives; row 29's symbol
description matches the no-headers regex.

Sandbox: built per kickoff v3 §9.1, shape verified (dotfiles and `lib/`
present, `.git` absent — the gitdir pointer file was removed), node_modules
symlinked, deleted after the table. No git command ran inside the sandbox: each
row ran with cwd at the WORKTREE and the sandbox test file's absolute path, so
imports resolved to mutated sandbox modules while source-text reads
(`JUDGE_BATCH`, 70.4's parity read) and `git show` stayed on the unmutated
worktree.

---

## 5. Typecheck, test counts, commit 5

- `npm run typecheck`: exit 0 (before the table and again before commit 5).
- `npm test`: 3212 at `d69a11d` (baseline) → **3213** after the repairs
  (the one addition is 5.9b). 0 failures both times.
- Commit 5: `fe59b07657d50553f9d535e989b42b92032cf604`, exactly the four paths:

```text
lib/__tests__/explicit-judge-equivalence.test.ts | 136 ++++++---
lib/__tests__/explicit-judge-retrieve.test.ts    |  13 +-
lib/__tests__/judge-server-stub.ts               |  82 ++++--
lib/__tests__/rerank-pass-2.test.ts              | 350 ++++++++++++++++++-----
4 files changed, 452 insertions(+), 129 deletions(-)
```

- `git diff --cached --name-only d69a11d` listed exactly the four paths;
  `git diff --exit-code` exited 0 (nothing unstaged); the ignored check showed
  exactly the two expected lines (v18 addendum + review 29). Not pushed.

---

## 6. The gate

Run once, from commit 5, AFTER the mutation table (v18 §4.3), strictly in
order — no command started until the previous one had exited. Raw transcripts,
with per-command timestamps, are in
`CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-16-AUG-2026.md` Part 2. Run window:
2026-08-17T03:27:33Z to 2026-08-17T03:29:09Z.

| Command | Exit |
|---|---|
| 1. `npm test` — 3213 tests, 3213 pass, 0 fail | 0 |
| 2. `npm run typecheck` | 0 |
| 3. keyed production build (`env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build`) | 0 |
| 4. `npm run architecture:check` | 0 |
| 5. `npm run architecture:map` | 0 |
| 6. see below — two preconditions and five lines, `git add` removed (v18 §4.1) | all 0 |
| 7. `bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'` — recorded WITH its quotes | 0 |
| 8. `npm run reasoning:governance` | 0 |
| 9. `npm run changelog:coverage` | 0 |
| Build pair 1 — refusal (`CDMSS_TELEMETRY_HMAC_KEY=`) | 1 (nonzero EXPECTED; error names the key) |
| Build pair 2 — keyed | 0 |

**Command 6, the v18 §4.1 replacement.** Preconditions
`git diff --exit-code -- lib/architecture/map.generated.ts` and
`git diff --cached --exit-code -- lib/architecture/map.generated.ts` both
exited 0. Then, each exiting 0:

```text
npm run architecture:map        exit 0   (generator printed 90492 "bytes" — UTF-16 code units)
cp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"    exit 0
npm run architecture:map        exit 0   (generator printed 90492 again — the two runs agree)
cmp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"   exit 0   (determinism)
git diff --exit-code -- lib/architecture/map.generated.ts  exit 0   (currency; NO git write)
```

`wc -c` read 90494 bytes after each generation; the generator's 90492 is a
count of UTF-16 code units labelled "bytes", and the two differ by design.
`git status --porcelain` was empty before the gate, before and after command
6's block, and after the whole gate; `--ignored` showed only the two expected
CDMSS lines (the v18 addendum and review 29) plus standard build artifacts.

**Command 7's quotes.** The command line was written into the capture through a
single-quoted heredoc before executing the identical line, so the quotes
survive byte-for-byte; the evidence states this beside the transcript. The
auxiliary `git diff --exit-code data/reasoning-registry/prompts.generated.json`
also exited 0.

**The refusal build** exited 1 with:

```text
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3). Set it in Vercel Production before deploying.
```

Two build modes, three invocations (command 3, then the pair). No third mode,
no disarmed control.

---

## 7. Evidence integrity

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
065be6a1af1232a34de56f2b26da3aaec8a3e6e1bded0db84fb267624a0e63a3  CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
db0df1afa205535422220d250895b0d0202d0f52ed1f28858b147abb357f9e15  CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
```

The first three match the values pinned in the kickoff exactly. The fourth —
the pass 2 evidence file, which this pass does NOT edit — is computed and
recorded here as required. The existing pass 2 evidence file and report are
untouched.

---

## 8. Disclosures — deviations and judgment calls, stated plainly

1. **Mutation row 19 is implemented as a rethrow, not a literal try/catch
   deletion.** The row says "remove the per-batch try/catch inside
   `rerankJudge`". Deleting the block braces cleanly by automated edit risks an
   incoherent sandbox file; the mutation applied replaces the catch's
   containment (`console.warn(...)`) with `throw e;`, which removes the
   containment property the row exists to test — a per-batch throw escapes to
   `rerank`'s outer catch. 17.1 failed by name. The exact diff is in the
   evidence.
2. **Two existing observation literals gained the `socketId` field**
   (5.7's tamper literal and 5.9's `mk` helper, plus the new 5.9b's `mk`).
   This is forced fallout of the v18 §4.2 field on `JudgeObservation` — the
   typed literals would not compile without it. Test 5.3's expected list was
   updated in the same commit, as v18 §3.7a instructs.
3. **Addendum v18 names the production assembly site `finaliseTelemetry`; the
   symbol in `lib/opd-note-audit.ts` is `writeRetrievalTerminals`** (its
   internal helper is `operationalFor`). The assembly line the addendum quotes —
   `defectsByRole.primary = validateManifest({ ...primaryPayload, operational: primaryOperational })` —
   exists verbatim at that site, so this is a naming discrepancy only, not a
   governing difference; noted rather than stopped on.
4. **The mutation capture lives inside the new capture directory**
   (`$HOME/cdmss-pass2-gate-supplemental-16-aug-2026/mutation/`). The directory
   did not previously exist; no existing capture directory was overwritten.
5. **Command 7's quotes** were preserved by writing the command line into the
   capture file via a single-quoted heredoc before executing the identical
   line; the evidence states this beside the transcript.
6. **The 30 ms sleep in test 5.6 remains.** Review 29 and v18 name only 5.4's
   sleep; 5.6's is fail-loud (a race there fails the test rather than passing
   it), and repairing it was not authorized. Recorded for a future pass.
