# CDMSS proof pass 3 — REPAIR report for Saul (proofs 35, 45, 47, 56 under review 36)

Date: 18 August 2026 (work executed 2026-08-18 16:01Z–16:12Z UTC).
Authority: **Saul review 36**, which closed proofs 46 and 49 and held 35, 45, 47 and 56.
Governing addendum: `CDMSS-RERANK-TELEMETRY-ADDENDUM-v25-18-AUG-2026.md`, **AUTHORIZED
by the orchestrator on V's delegation, ratified by Saul review 35**; it supersedes v23
in full. There is no digest and no signature script (v25 §0). Addenda v15 to v22 govern
everything v25 does not touch. Kickoff v11 is the numbering authority.

Base: commit 14 at `a4ef66ef5e26d4a6e19f12e08e8064f0a6a3944a`. **Commits 13 and 14
stand; the repair is forward-only.**
Commit 15 (the repair): `f391973045c70f40edc77ceeedb053310aaa1f52` — four paths.
Commit 16 is the commit carrying this report (six paths per v25 §6 / kickoff §0); its
SHA is in the builder's covering report.

**Nothing was pushed.** `@{u}` = `01c2375` throughout; three local commits after 15,
four after 16.

---

## 1. Stop conditions 1 to 4

1. `git rev-parse HEAD` → `a4ef66ef5e26d4a6e19f12e08e8064f0a6a3944a`. PASS.
2. `git status --porcelain` → empty. PASS.
3. `CDMSS-RERANK-TELEMETRY-ADDENDUM-v25-18-AUG-2026.md` exists; line 16 reads
   `STATUS: AUTHORIZED by the orchestrator on V's delegation, ratified by Saul review 35`. PASS.
4. `git rev-parse @{u}` → `01c2375b4b40dc19bc2684ae2ecfa2b9664f5638`; two commits unpushed
   (`8404029`, `a4ef66e`), as expected. Not pushed.

**Flagged at the outset, not a stop:** `CDMSS-RERANK-TELEMETRY-ADDENDUM-v24-18-AUG-2026.md`
is present in the worktree root as an ignored, untracked file. v25 §6 and kickoff §0 say it
must not be tracked. The builder neither tracked nor deleted it. Consequences: the ignored
check at commit 15 showed **four** lines (v24, v25, review 35, review 36) rather than the
three the kickoff expects, and the post-commit-16 check `! git status --porcelain --ignored
| grep -q '^!! CDMSS-'` **cannot exit zero** while v24 sits there (§16). Reported plainly.

The nine evidence digests were verified before any change and again after the gate (§14).

---

## 2. The four repairs, quoted, with the test that proves each

### 2.1 Proof 35 — more than one planned boundary (v25 §3.1)

`JUDGE_BATCH` is **read from the source text** of `lib/rerank.ts` (proof 18's standing
rule; not imported, not hard-coded):

```ts
function judgeBatchFromSource(): number {
  const m = read('lib/rerank.ts').match(/^const JUDGE_BATCH = (\d+);/m);
  assert.ok(m, 'lib/rerank.ts declares `const JUDGE_BATCH = <n>;` at column 0');
  const n = Number(m[1]);
  assert.ok(Number.isInteger(n) && n >= 2, `JUDGE_BATCH is a small positive integer, read as ${m[1]}`);
  return n;
}
```

Value read: **5**. Candidate count chosen: **`2 * JB + 1` = 11** — two full batches and one
partial. Boundaries asserted, start and end per record, in order:

```ts
  const expectedBoundaries = {
    judge: [{ start: 0, end: JB }, { start: JB, end: 2 * JB }, { start: 2 * JB, end: n }],   // [0,5) [5,10) [10,11)
    cohere: [{ start: 0, end: n }],   // Cohere is one request, one planned batch, whatever the pool
  };
  …
    assert.deepEqual(
      payload.batches.map((b) => ({ start: b.candidate_start, end: b.candidate_end })),
      expectedBoundaries[backend],
      `${backend}: one synthesised record per PLANNED boundary, with the exact boundaries`,
    );
    assert.deepEqual(payload.batches.map((b) => b.batch_index), expectedBoundaries[backend].map((_, i) => i), …);
    assert.equal(payload.expected_batch_count, expectedBoundaries[backend].length, …);
    assert.equal(payload.recorded_rerank_batches, expectedBoundaries[backend].length, …);
    for (const b of payload.batches) { … assert.equal(b.expected_score_keys, b.candidate_end - b.candidate_start, …); }
```

**Test:** `35.8 — ROW 6 AS AMENDED (v7 §6, v8 §2): … MORE THAN ONE boundary on the judge arm,
each with its exact start and end …` in `retrieval-telemetry-core.test.ts` (rewritten in
place). Proved by mutation rows 1 (one record regardless of count → fails by name) and 7
(count preserved, boundaries wrong → fails by name).

### 2.2 Proof 45 — the production validation defect that shipped in commit 13 (v25 §3.2)

`lib/retrieval-telemetry-core.ts`, inside the per-batch loop of `validateManifest`, after
the `attempts` checks — **new**:

```ts
      const usageFields: Array<'prompt_tokens' | 'completion_tokens'> = ['prompt_tokens', 'completion_tokens'];
      for (const usage of usageFields) {
        if (!has(b, usage)) { v.push(`batch_${usage}_field_absent`); continue; }
        const t = b[usage];
        if (t !== null && !(isFiniteNum(t) && t >= 0)) v.push(`batch_${usage}_invalid`);
      }
```

The pattern is the file's own (`has` → null permitted → type), as `rerank_temperature` and
`active_backfill_state` already do. Before this, a batch could omit both fields, or carry a
string, and the manifest validated clean — **a malformed manifest classified as complete;
it shipped in commit 13 and no test asked.**

**Tests:** eight new rows in `retrieval-telemetry-validation.test.ts` — `45.76`
prompt_tokens missing → `batch_prompt_tokens_field_absent`; `45.77` numeric string, `45.78`
negative, `45.79` NaN → `batch_prompt_tokens_invalid`; `45.80` completion_tokens missing;
`45.81` string, `45.82` Infinity, `45.83` object → `batch_completion_tokens_invalid` — and
`45.1` gained: null on both is clean, zero is clean, both absent is a defect. Proved by
mutation rows 2, 3 and 9.

**D17 field count (§9 item 3).** D17's required-field list names **54 fields** (counting each
field in its grouped lines: 3 in `operational.route, route_class, retrieval_role`, 2 in
`intended_backend, intended_model`, 2 in the candidate counts, 2 in the batch counts, 9 in
the first per-batch line, 4 in the second, and 34 single-field lines). Of those, **20 permit
null** (`hmac_key_version` under the licence, `trace_id`, `deployment_sha`, the four
`active_*` fields, `retrieval_error_class`, `expansion.input_hmac`/`served_route_class` on
`skipped`, `expansion.served_model`, `expansion.attempts`, `served_backend` with no batches,
`corpus_version`, `pre_rerank_passage_hmacs` under the licence, `scorer_context_hmac` off
primary, and per batch `served_model`, `attempts`, `prompt_tokens`, `completion_tokens`).
**All 54 now have at least one absent-or-invalid case, and all 20 nullable fields have a
case** — before this repair 52 of 54 and 18 of 20 did. Proof 45 now holds **111 tests**
(45.0, 45.1, 45.2–45.110: 107 per-field rows over the primary and lab_multi_query fixtures,
two fixture-clean checks, the own-property test and the HMAC-absent licence test).

### 2.3 Proof 47 — the production caller, and non-primary HMACs (v25 §3.3)

**Production**, `lib/retrieval-telemetry-core.ts` — new third branch:

```ts
  if (!has(m, 'scorer_context_hmac')) v.push('scorer_context_hmac_field_absent');
  else if (role === 'primary' && m.scorer_context_hmac === null && !keyAbsent) v.push('scorer_context_hmac_absent');
  else if (role !== 'primary' && RETRIEVAL_ROLES.some((r) => r === role) && m.scorer_context_hmac !== null) {
    v.push('scorer_context_hmac_on_non_primary_role');
  }
```

**Tests:**
- `47.4` — a non-null HMAC on each of `normative_channel`, `lvc_recall`, `lab_direct`,
  `lab_multi_query` → `scorer_context_hmac_on_non_primary_role`; primary untouched; an
  absent field is still the field-absent code. Proved by mutation row 4.
- `47.5` — **the real `assembleAuditContext`** (imported from `lib/opd-note-audit.ts`, as
  `opd-normative-channel.test.ts` already does) renders the context from literal `CiteHit`
  fixtures: literature only, literature plus the normative block (a different rendering, a
  different HMAC), and **zero hits → the empty string**, whose HMAC is a defined value the
  primary row carries and which validates clean. The payload's HMAC equals
  `telemetryHmac(KEY, citedContext)` exactly and is not the HMAC of the raw passages. Proved
  by mutation row 8 (empty string → null).
- `47.6` — **the production caller's handoff, pinned in comment-stripped source** of
  `lib/opd-note-audit.ts`: `const { sources, citedContext } = assembleAuditContext(hits, normHits);`
  precedes `writeRetrievalTerminals({ … citedContext, … })`; inside it
  `buildRetrievalPayload(args.primaryCapture, { hmacKey, scorerContext: citedContext })`,
  `buildRetrievalPayload(args.normativeCapture, { hmacKey, scorerContext: null })`, exactly
  two `scorerContext:` handoffs, and `validateManifest({ ...primaryPayload, operational:
  primaryOperational })`. Proved by mutation row 5 (assembly bypassed → fails by name).

**Stated plainly:** `writeRetrievalTerminals` is module-private and nothing in this
repository can drive `auditOpdNote` in-process (it needs a note row, retrieval, embeddings,
a live LLM leg and the audit store — recorded in `defect-map-delivery.test.ts` since pass
0b). 47.6 therefore proves the caller is **written** to hand `assembleAuditContext`'s exact
output to the payload builder; it does not prove the function **executes**. Making it
executable needs a seam in `lib/opd-note-audit.ts`, which this repair is not authorized to
add. If Saul requires execution rather than the pin, that is the change to authorize.

### 2.4 Proof 56 — a real PostgreSQL JSONB round trip (v25 §3.4)

`retrieval-telemetry-canonicalization.test.ts` was rewritten. The file **creates, uses and
destroys a disposable PostgreSQL itself**:

```ts
before(() => {
  cluster.bin = findPgBin();                                        // PGBIN, PATH, Homebrew, /usr/lib/postgresql
  cluster.dir = mkdtempSync(join(tmpdir(), 'cdmss-proof56-pg-'));   // a fresh temp directory
  execFileSync(join(cluster.bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', PGUSER, '--no-locale', '-E', 'UTF8'], …);
  … cluster.port = 20000 + Math.floor(Math.random() * 20000);       // random high port, up to five tries
  execFileSync(join(cluster.bin, 'pg_ctl'), ['-D', data, '-w', '-t', '30', '-l', …,
    '-o', `-c listen_addresses=127.0.0.1 -c port=${cluster.port} -c unix_socket_directories=${cluster.dir}`, 'start'], …);
  cluster.version = sql('SELECT version();')[0] ?? '';
  sql('CREATE TABLE proof56_docs (id integer PRIMARY KEY, doc jsonb NOT NULL);');
});
after(() => {
  … execFileSync(join(cluster.bin, 'pg_ctl'), ['-D', join(cluster.dir, 'data'), '-m', 'fast', '-w', 'stop'], …);
  if (cluster.dir) rmSync(cluster.dir, { recursive: true, force: true });
});
```

Every round trip is a real `INSERT … VALUES (:'doc'::jsonb)` and `SELECT doc::text` through
`psql` over 127.0.0.1. `56.0` asserts the server answered `SELECT version()` (PostgreSQL 18.4
here), that its data directory is under the OS temp dir, that the cluster holds nothing but
the one empty table, and `host(inet_server_addr()) = '127.0.0.1'`. `56.3` inserts the
canonical bytes, asserts what PostgreSQL returns is **visibly reordered** (`"topK"` before
`"rerank_temperature"` — jsonb's shorter-key-first order, the reverse of canonical) and that
`canonicalJson(JSON.parse(returned)) === stored`, plus jsonb equality against the original
insertion order. `56.4` is the **array-order mutation**: the stored row is round-tripped
untouched (equal) and through `jsonb_set(doc, '{ordered_final_candidate_ids}', '[11,12,13]')`
(NOT equal — the no-op check correctly sees new content), and PostgreSQL's own jsonb equality
returns `f` for `[11,12,13] = [12,11,13]` and `t` for a key permutation. `56.6` round-trips
numerics. If the binaries are missing, `before()` throws and every test in the file fails —
the round trip is not simulated and the tests are not skipped. Proved by mutation row 6.

**How the instance was created and destroyed (§9 item 4):** created by the test's `before()`
— `initdb` into `mkdtemp(tmpdir()/cdmss-proof56-pg-…)`, trust auth for a throwaway role
`cdmss_proof56`, started with `pg_ctl` bound to `127.0.0.1` on a random port 20000–39999,
Unix socket directory inside the temp dir; **disposable and non-production** — no
connection string is read from the environment, no shared server, not the Neon production
branch, no patient-derived value; **destroyed** in `after()` by `pg_ctl stop -m fast` and
`rmSync` of the directory. Verified after every run: no `cdmss-proof56-pg-*` directory
remains under the temp dir and no `postgres` process remains. The binaries used were
Homebrew's `postgresql@18` (18.4).

### 2.5 Scope

`lib/retrieval-telemetry-core.ts` is the only production file changed (21 insertions, all
inside `validateManifest`, for 2.2 and 2.3). `lib/retrieval-capture.ts` was not reopened.
No other production file changed.

---

## 3. Typecheck and tests — before, after the production changes, at the end

| When | typecheck | `npm test` |
|---|---|---|
| before writing, at `a4ef66e` (16:01:50Z–16:02:10Z) | 0 | 3348 / 3348 / 0 |
| after the two production changes, before any test (16:02:47Z–16:03:07Z) | 0 | 3348 / 3348 / 0 — **no existing test failed** |
| after the four repairs (16:07:12Z–16:07:32Z) | 0 | **3360** / 3360 / 0 |
| commit 15 staging | 0 | — |
| gate command 1 (16:09:54Z–16:10:14Z) | — | 3360 / 3360 / 0 |

3348 → **3360** (+12: 8 usage rows and 47.4/47.5/47.6 in the validation file, 56.0 in the
canonicalization file).

---

## 4. The mutation table — nine rows, before the gate

Every row's exact unified diff, exact command, exit status, STARTED/ENDED and named
failures are in `CDMSS-GATE-EVIDENCE-PASS-3-REPAIR-18-AUG-2026.md` Part 1. Rows 1–6 are
the kickoff's six, in its order; 7–9 add one row per further load-bearing claim. This round
every row ran **with the sandbox as cwd** (47.6 and 35.8 read source files relative to cwd).

| # | Mutated (sandbox copy) | Test file | Named test(s) that failed | Exit |
|---|---|---|---|---|
| 1 | `lib/rerank.ts` `recordSoftFailure`: boundaries → always one `[0, n)` | core | **35.8** | 1 |
| 2 | core: `usageFields` → `['completion_tokens']` (prompt_tokens validation dropped) | validation | **45.76, 45.77, 45.78, 45.79**, 45.1 | 1 |
| 3 | core: `usageFields` → `['prompt_tokens']` (completion_tokens validation dropped) | validation | **45.80, 45.81, 45.82, 45.83**, 45.1 | 1 |
| 4 | core: the non-primary rejection branch removed | validation | **47.4** | 1 |
| 5 | `lib/opd-note-audit.ts`: `assembleAuditContext(hits, normHits)` replaced by direct `hitsToSources`/`buildCitedContext` (assembly bypassed) | validation | **47.6** | 1 |
| 6 | core `canonicalize`: arrays sorted (`[...value].sort().map`) — reorder treated as equal | canonicalization | **56.4**, 56.1 | 1 |
| 7 | `lib/rerank.ts` `recordSoftFailure`: count kept, every record `start: 0` | core | **35.8** | 1 |
| 8 | `lib/retrieval-capture.ts`: `opts.scorerContext !== null` → truthiness (empty string → null) | validation | **47.5**, 47.2, 49.1, 49.2 | 1 |
| 9 | core: the usage TYPE check dropped (`t !== null && false`) | validation | **45.77, 45.78, 45.79, 45.81, 45.82, 45.83** | 1 |

Every row failed its named test **by name**; every run finished in under two seconds; none
was accepted on a file-level timeout. Row 9's runner expectation over-listed 45.1 (which
asserts absence/null/zero, not type); its description file records the correction.

**The four hashes (four files each), all equal — hash 1 (worktree before) = hash 2
(sandbox baseline) = hash 3 (worktree after) = hash 4 (`git show HEAD:` after commit 15):**

```text
803ad74ff38c3a6829d3450ba591aa8b063185d751b08fd7c670a08ce0107080  lib/retrieval-telemetry-core.ts
72f78341cd43c871e09d884dc3c108be2a939c4a66f16fed2699b06b83cad6a3  lib/__tests__/retrieval-telemetry-core.test.ts
fc1e311888a65dded8889489c4bc7ab55f6449f6a93591180e53f6ad2c321e79  lib/__tests__/retrieval-telemetry-validation.test.ts
0151d53fd591bda751e57a0a272a84f355d466f1552c873233112d3ae535c15e  lib/__tests__/retrieval-telemetry-canonicalization.test.ts
```

Sandbox at `/Users/vinaybhardwaj/cdmss-pass2-sandbox/repo`, shape verified (dotfiles present,
`lib/__tests__` present, `.git`/`.next` absent, `node_modules` a symlink; the four files and
`lib/rerank.ts`, `lib/opd-note-audit.ts`, `lib/retrieval-capture.ts` `cmp`-identical to the
worktree), deleted after; no git command inside it; each mutated file restored with `cp`
and verified with `cmp`.

---

## 5. No row touches judge lifecycle or recorder counting

Stated plainly: **no mutation row alters judge request lifecycle or recorder counting.**
Rows 1 and 7 mutate the soft-failure record **synthesis** in `recordSoftFailure` in the
sandbox copy of `lib/rerank.ts` — code that runs after a backend has thrown, issues no
request and touches no recorder (`judgeBatchBoundaries` and the request path are unchanged);
row 5 mutates the caller's context assembly in the sandbox copy of `lib/opd-note-audit.ts`;
row 8 the sandbox copy of `lib/retrieval-capture.ts`; rows 2, 3, 4, 6, 9
`lib/retrieval-telemetry-core.ts`. Only the three pass 3 test files ran and none imports
`lib/__tests__/judge-server-stub.ts`. Review 34's bounded-settlement condition is not
triggered; the sixteen unbounded waits are untouched.

---

## 6. Commit 15

- Staging validations against `a4ef66e`: `git status --porcelain --untracked-files=all` →
  `M` on exactly the four paths; `git diff --cached --stat a4ef66e` → 4 files, 319
  insertions, 60 deletions; `git diff --cached --name-only a4ef66e` → the four paths;
  `git diff --exit-code` → 0. Ignored check: **four** lines — v24 (see §1), v25, review 35,
  review 36.
- **Commit 15: `f391973045c70f40edc77ceeedb053310aaa1f52`.** `git diff --name-only
  a4ef66e..HEAD` → the four paths. `git status --porcelain` empty after.

---

## 7. The gate

Run once, from commit 15, AFTER the mutation table, strictly in order. Raw transcripts in
`CDMSS-GATE-EVIDENCE-PASS-3-REPAIR-18-AUG-2026.md` Part 2. Window 2026-08-18T16:09:54Z to
16:11:28Z. Capture directory `$HOME/cdmss-pass3-repair-gate-18-aug-2026` — new, nothing
overwritten. Every command has STARTED and ENDED.

| Command | STARTED | ENDED | Exit |
|---|---|---|---|
| 1. `npm test` — 3360 / 3360 / 0 | 16:09:54Z | 16:10:14Z | 0 |
| 2. `npm run typecheck` | 16:10:14Z | 16:10:17Z | 0 |
| 3. keyed production build | 16:10:17Z | 16:10:51Z | 0 |
| 4. `npm run architecture:check` — all 8 rules + coverage green | 16:10:51Z | 16:10:51Z | 0 |
| 5. `npm run architecture:map` | 16:10:51Z | 16:10:52Z | 0 |
| 6. precondition 1 / precondition 2 | 16:10:52Z | 16:10:52Z | 0 / 0 |
| 6. line 1 map · line 2 cp · line 3 map · line 4 cmp · line 5 `git diff --exit-code` | 16:10:52Z | 16:10:53Z | 0 · 0 · 0 · 0 · 0 |
| 7. `bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'` | 16:10:53Z | 16:10:53Z | 0 |
| aux. `git diff --exit-code data/reasoning-registry/prompts.generated.json` | 16:10:53Z | 16:10:54Z | 0 |
| 8. `npm run reasoning:governance` — GREEN, 0 ungoverned | 16:10:54Z | 16:10:54Z | 0 |
| 9. `npm run changelog:coverage` — GREEN, 19 versions | 16:10:54Z | 16:10:54Z | 0 |
| Build pair 1 — refusal | 16:10:54Z | 16:10:54Z | 1 (nonzero EXPECTED; names `CDMSS_TELEMETRY_HMAC_KEY`) |
| Build pair 2 — keyed | 16:10:54Z | 16:11:28Z | 0 |

**Command 6 — the map did NOT move.** `lib/retrieval-telemetry-core.ts` changed but its
imports did not: both generations wrote 90492 "bytes" (UTF-16 code units; `wc -c` 90494
both times), `cmp` 0, `git diff --exit-code` 0. **No `git add`** anywhere in the gate; both
preconditions 0. **Command 7's quotes** were preserved by the heredoc method (the line
written into the capture file through a single-quoted heredoc before the identical line
executed). `git status --porcelain` empty before, around command 6, and after; the ignored
list held the same four CDMSS lines throughout.

---

## 8. The nine evidence digests

Verified before any change and again after the gate; every one matches (v20 §6.1 for six;
commit `f6e9188`'s message for the seventh; commit `01c2375`'s for the eighth; commit
`a4ef66e`'s for the ninth):

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
```

---

## 9. Current state

- Hard proofs closed: **9 of 20** (11, 12, 17, 2, 16, 18, 70, 46, 49). Proofs 35, 45, 47, 56
  are repaired and evidenced here — **13 of 20 if Saul closes all four**. Saul closes proofs.
- Judge proofs closed: 4 of 4.
- Nothing deployed, nothing migrated, no Cohere activation or operational benchmark, no
  pass 1 retrospective sweep, no pass 4.
- The sixteen unbounded `judge.settled()` waits remain recorded test-harness debt.
- **Nothing pushed.** `@{u}` = `01c2375`. Local, unpushed after commit 16: `8404029`,
  `a4ef66e`, `f391973`, and commit 16 — four.

---

## 10. Disclosures — deviations and judgment calls, stated plainly

1. **Addendum v24 in the worktree root** — untracked, ignored, and left exactly as found; the
   commit-15 ignored check showed four lines and the post-commit-16 check cannot exit zero
   because of it (§1, §16 of the covering report). Not deleted (not authorized, not mine),
   not negated (v25 says it is not tracked).
2. **Proof 47's caller handoff is a source pin, not an execution** (§2.3). The caller is
   module-private and undrivable in-process; adding a seam would change
   `lib/opd-note-audit.ts`, which is not authorized. Stated, not papered over.
3. **Proof 56 creates the PostgreSQL cluster inside the test file** (self-contained,
   disposable, loopback, destroyed in `after()`) rather than relying on an externally
   provisioned instance, so the gate's `npm test` carries its own instance. It requires
   `initdb`/`pg_ctl`/`psql` on the machine that runs the suite (found via `PGBIN`, PATH,
   Homebrew or `/usr/lib/postgresql`); where they are absent the file **fails loudly** rather
   than skipping. GitHub's Ubuntu runners ship PostgreSQL under `/usr/lib/postgresql`, which
   the lookup covers; this branch is not pushed, so CI has not exercised it.
4. **Mutation rows ran with the sandbox as cwd** (previous rounds used the worktree as cwd)
   because two of the tests read source files relative to cwd; stated in the evidence file.
5. **Nine rows, not six** — the kickoff's "add rows" instruction; row 9's description
   records the runner's corrected expectation.
6. **The variant-generation section's own `prompt_tokens`/`completion_tokens`
   (`multi_query.variant_generation`) remain unvalidated.** D17's list names the per-BATCH
   pair; review 36's finding is the batch loop; the repair was kept to it. Flagged for a
   later addendum, not changed.
7. **The 47.6 pin and the 35.8 `JUDGE_BATCH` read** import `lib/opd-note-audit.ts` (for
   `assembleAuditContext`, as `opd-normative-channel.test.ts` already does) and read source
   text; neither opens a socket or touches the judge stub.
8. **The kickoff's §0 says commit 16 changes "exactly these five paths" and then lists six**
   (`.gitignore` plus five documents) — read as six paths, five negation lines, which is what
   v25 §6 implies and what commit 16 carries.
