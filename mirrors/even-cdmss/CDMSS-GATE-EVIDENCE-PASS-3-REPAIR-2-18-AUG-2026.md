# CDMSS gate evidence — pass 3 REPAIR 2 (proofs 45, 47, 56 under Saul review 37), 18 August 2026
Authority: Saul review 37 (closed 35; held 45, 47, 56). Addendum v26, AUTHORIZED by the orchestrator on V's delegation,
ratified by Saul review 35. No digest, no signature script; stop condition 3 — the v26 status line reads AUTHORIZED by the
orchestrator — was checked instead.
The repair commit (commit 17): ac0155cda011dbac3f00410838d14990340b9287 — four paths (of the five v26 §4 permits; proof 35
closed, so lib/__tests__/retrieval-telemetry-core.test.ts was not touched): lib/retrieval-telemetry-core.ts (the D17 field
matrix and the derived validator, v26 §3.1–§3.5), lib/opd-note-audit.ts (the executable seam only, v26 §3.6),
lib/__tests__/retrieval-telemetry-validation.test.ts (proofs 45, 47), lib/__tests__/retrieval-telemetry-canonicalization.test.ts
(proof 56, the bounded lifecycle, v26 §3.7). Forward-only from fb5e9d5; commits 15 and 16 stand.
Gate run: 2026-08-18T23:48:59Z to 2026-08-18T23:50:38Z UTC, from commit 17.
Mutation table (TEN rows) run BEFORE the gate, completed before commit 17 was created; the gate then ran once, from
commit 17. Upstream throughout: 01c2375; nothing pushed.

Raw capture directory: $HOME/cdmss-pass3-repair2-gate-18-aug-2026
(a NEW directory; no existing capture directory was overwritten).
In every command transcript below, stdout and stderr are MERGED (2>&1).

⚠️ TIMESTAMP COMPLETENESS. EVERY command in Part 2 carries a STARTED and an ENDED timestamp: the nine numbered commands,
both command-6 preconditions and all five command-6 lines, command 7 itself, the auxiliary check, and both build-pair
runs, the refusal included. Every mutation row in Part 1 carries STARTED and ENDED as well.

The three .env.local guard facts (these three lines and nothing else from that file — no value and no other name is printed):

```text
VERCEL=1: true
VERCEL_ENV=production: true
HMAC assignment: false
```

## Part 1 — the mutation table: ten rows, BEFORE the gate (kickoff §6; v26 §5)

The kickoff's seven required rows are rows 1 to 7, in its order. Rows 8 to 10 add one row per further load-bearing claim
(kickoff §6: "Add rows wherever a repair carries more than one load-bearing claim"). Sandbox per the established shape
(addendum v15 §7.3): a full copy of the worktree at /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo with `.next`,
`node_modules` and `.git` absent and `node_modules` symlinked from the worktree; shape verified before use (dotfiles present,
`lib/__tests__` present, `.git` absent, `.next` absent, `node_modules` a symlink; the four changed files AND
lib/__tests__/retrieval-telemetry-core.test.ts, lib/rerank.ts, lib/retrieval-capture.ts `cmp`-identical to the worktree);
deleted after the table. No git command inside the sandbox. Each row applies its exact string replacement(s) to the sandbox
copy of the named file, records `diff -u` of the worktree original against the mutated sandbox copy, runs ONLY its named
test file with the SANDBOX AS cwd (as last round, accepted by review 37), and restores the file with `cp`, verified with
`cmp`.

⚠️ RECORDER GUARDRAIL (review 34's standing condition; kickoff §6). NO ROW alters judge request lifecycle or recorder
counting. Rows mutate only `lib/retrieval-telemetry-core.ts` (1, 2, 3, 4, 5, 8, 10), the seam or the primary handoff in the
sandbox copy of `lib/opd-note-audit.ts` (6, 9), and the proof 56 harness in the sandbox copy of its own test file (7). Only
`retrieval-telemetry-validation.test.ts` and `retrieval-telemetry-canonicalization.test.ts` ran, and neither imports
`lib/__tests__/judge-server-stub.ts`. (47.7/47.8 drive `writeRetrievalTerminals` against the DB transport stub with real
`assembleAuditContext` output; no judge request, no recorder. Proof 56 opens a loopback socket to its own disposable
PostgreSQL only.)

### The byte-equality proof (kickoff §6) — four files, four hashes each

Hash 1 (worktree, before the table) · Hash 2 (sandbox baseline) · Hash 3 (worktree, after the table) · Hash 4
(`git show HEAD:<path> | shasum -a 256` after commit 17):

```text
# hash 1 — worktree, before the table
4c30b088b5e3829f7dba102e6c71401432ce09f839eebb06f61785c843745698  lib/retrieval-telemetry-core.ts
d6ebefd9dd4356fc99c330692205f6d623d5b6fec1586bd208d5337d3f1fc88a  lib/opd-note-audit.ts
da673a7d03a6e1bace29e9a7903bb09f7c105d76b637dd99a1b9fc34b9b11b9f  lib/__tests__/retrieval-telemetry-validation.test.ts
141a56f809e8082b324994440e63af415983e6a490ffe3ffdf7b08b5fd75089e  lib/__tests__/retrieval-telemetry-canonicalization.test.ts
# hash 2 — sandbox baseline
4c30b088b5e3829f7dba102e6c71401432ce09f839eebb06f61785c843745698  lib/retrieval-telemetry-core.ts
d6ebefd9dd4356fc99c330692205f6d623d5b6fec1586bd208d5337d3f1fc88a  lib/opd-note-audit.ts
da673a7d03a6e1bace29e9a7903bb09f7c105d76b637dd99a1b9fc34b9b11b9f  lib/__tests__/retrieval-telemetry-validation.test.ts
141a56f809e8082b324994440e63af415983e6a490ffe3ffdf7b08b5fd75089e  lib/__tests__/retrieval-telemetry-canonicalization.test.ts
# hash 3 — worktree, after the table
4c30b088b5e3829f7dba102e6c71401432ce09f839eebb06f61785c843745698  lib/retrieval-telemetry-core.ts
d6ebefd9dd4356fc99c330692205f6d623d5b6fec1586bd208d5337d3f1fc88a  lib/opd-note-audit.ts
da673a7d03a6e1bace29e9a7903bb09f7c105d76b637dd99a1b9fc34b9b11b9f  lib/__tests__/retrieval-telemetry-validation.test.ts
141a56f809e8082b324994440e63af415983e6a490ffe3ffdf7b08b5fd75089e  lib/__tests__/retrieval-telemetry-canonicalization.test.ts
# hash 4 — git show HEAD:<path> after commit 17
4c30b088b5e3829f7dba102e6c71401432ce09f839eebb06f61785c843745698  lib/retrieval-telemetry-core.ts
d6ebefd9dd4356fc99c330692205f6d623d5b6fec1586bd208d5337d3f1fc88a  lib/opd-note-audit.ts
da673a7d03a6e1bace29e9a7903bb09f7c105d76b637dd99a1b9fc34b9b11b9f  lib/__tests__/retrieval-telemetry-validation.test.ts
141a56f809e8082b324994440e63af415983e6a490ffe3ffdf7b08b5fd75089e  lib/__tests__/retrieval-telemetry-canonicalization.test.ts
```

All four agree for every file. The tested bytes are the committed bytes. The ten rows were run ONCE, against these bytes.

### Row 1 — break one field's entry in the D17 matrix: expected_batch_count becomes nullable ('never' → 'always')

mutated file: lib/retrieval-telemetry-core.ts (sandbox copy). test file: lib/__tests__/retrieval-telemetry-validation.test.ts (run with the sandbox as cwd). must fail by name: 45.57 (the hand-written 'expected_batch_count: null' row).  NOTE, stated: the runner also listed the matrix-generated NULL case (45.2xx), which did NOT fail — it derives its expectation from the matrix as loaded, so a nullability flip INSIDE the matrix is invisible to it. The generated suite guards the ENGINE against the matrix; the hand-written rows guard the MATRIX against a wrong entry. Both kinds are kept for that reason..

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/retrieval-telemetry-core.ts	2026-08-19 05:09:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/retrieval-telemetry-core.ts	2026-08-19 05:17:46
@@ -750,7 +750,7 @@
   { path: 'intended_model', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'intended_model_absent', nullCode: 'intended_model_absent', invalid: 'intended_model_absent' },
   { path: 'served_backend', origin: 'D17', nullable: 'no_batches', type: 'nonempty_string', absent: 'served_backend_field_absent', nullCode: 'served_backend_absent_with_batches', invalid: 'served_backend_invalid' },
   { path: 'rerank_backend_downgraded', origin: 'D17', nullable: 'never', type: 'boolean', absent: 'rerank_backend_downgraded_absent', nullCode: 'rerank_backend_downgraded_absent', invalid: 'rerank_backend_downgraded_absent' },
-  { path: 'expected_batch_count', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'expected_batch_count_absent', nullCode: 'expected_batch_count_absent', invalid: 'expected_batch_count_absent' },
+  { path: 'expected_batch_count', origin: 'D17', nullable: 'always', type: 'nonneg_number', absent: 'expected_batch_count_absent', nullCode: 'expected_batch_count_absent', invalid: 'expected_batch_count_absent' },
   { path: 'recorded_rerank_batches', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'recorded_rerank_batches_absent', nullCode: 'recorded_rerank_batches_absent', invalid: 'recorded_rerank_batches_absent' },
   { path: 'rerank_soft_failed', origin: 'D17', nullable: 'never', type: 'boolean', absent: 'rerank_soft_failed_absent', nullCode: 'rerank_soft_failed_absent', invalid: 'rerank_soft_failed_absent' },
   { path: 'ordered_final_candidate_ids', origin: 'D17', nullable: 'never', type: 'id_array', absent: 'ordered_final_candidate_ids_absent', nullCode: 'ordered_final_candidate_ids_absent', invalid: 'ordered_final_candidate_ids_absent' },
```

Command, exit status, and timestamps:

```text
cd /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo && node --test --import tsx lib/__tests__/retrieval-telemetry-validation.test.ts
exit=1
STARTED: 2026-08-18T23:47:46Z
ENDED: 2026-08-18T23:47:47Z
```

Failing tests, by name:

```text
not ok 57 - 45.57 — expected_batch_count: null → expected_batch_count_absent
```

Run summary:

```text
# tests 370
# pass 369
# fail 1
# cancelled 0
# duration_ms 1479.728459
```

### Row 2 — remove null-array-member handling: parentsOf hands every member through and applyRule dereferences it — a null batch member THROWS again

mutated file: lib/retrieval-telemetry-core.ts (sandbox copy). test file: lib/__tests__/retrieval-telemetry-validation.test.ts (run with the sandbox as cwd). must fail by name: 45.198, 45.197.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/retrieval-telemetry-core.ts	2026-08-19 05:09:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/retrieval-telemetry-core.ts	2026-08-19 05:17:47
@@ -862,7 +862,7 @@
     for (const parent of current) {
       const value = get(parent, key);
       if (walksArray) {
-        if (Array.isArray(value)) for (const member of value) if (isPlainObject(member)) next.push(member);
+        if (Array.isArray(value)) for (const member of value) next.push(member);
       } else if (isPlainObject(value)) {
         next.push(value);
       }
@@ -888,7 +888,7 @@
     return;
   }
   for (const parent of parents) {
-    if (!has(parent, last)) { v.push(rule.absent); continue; }
+    if (!Object.prototype.hasOwnProperty.call(parent, last)) { v.push(rule.absent); continue; }
     const value = parent[last];
     const verdict = nullVerdict(rule, ctx);
     if (value === null) {
```

Command, exit status, and timestamps:

```text
cd /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo && node --test --import tsx lib/__tests__/retrieval-telemetry-validation.test.ts
exit=1
STARTED: 2026-08-18T23:47:47Z
ENDED: 2026-08-18T23:47:49Z
```

Failing tests, by name:

```text
not ok 70 - 45.70 — batch (member): a null member — reported, never dereferenced (v26 §3.2) → batch_member_invalid
not ok 123 - 45.123 — multi_query.variants (member): a null member (v26 §3.2) → variant_member_invalid
not ok 265 - 45.335 — matrix batches[] (v26 §3.1): a null member → batch_member_invalid, without throwing
not ok 340 - 45.410 — matrix multi_query.variants[] (v26 §3.1): a null member → variant_member_invalid, without throwing
not ok 353 - 45.198 — batches: [null] returns CODES, it does not throw; and every other malformed member shape is classified the same way
not ok 354 - 45.197 — validateManifest is STABLE on unknown input: hostile top-level values and a hostile value at every matrix path return string codes and never throw
```

Run summary:

```text
# tests 370
# pass 364
# fail 6
# cancelled 0
# duration_ms 1492.3185
```

### Row 3 — drop candidate_start validation: its matrix row removed (candidate_end keeps its own)

mutated file: lib/retrieval-telemetry-core.ts (sandbox copy). test file: lib/__tests__/retrieval-telemetry-validation.test.ts (run with the sandbox as cwd). must fail by name: batch.candidate_start: missing, batch.candidate_start: null, batch.candidate_start: invalid.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/retrieval-telemetry-core.ts	2026-08-19 05:09:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/retrieval-telemetry-core.ts	2026-08-19 05:17:49
@@ -766,7 +766,6 @@
   { path: 'batches[].batch_index', origin: 'D17', nullable: 'never', type: 'finite_number', absent: 'batch_index_absent', nullCode: 'batch_index_absent', invalid: 'batch_index_absent' },
   // Two INDEPENDENT rows (v26 §3.3): each boundary is present, non-null and a finite number on its own;
   // they share the established code, and `bad_candidate_boundaries` below relates the two.
-  { path: 'batches[].candidate_start', origin: 'D17', nullable: 'never', type: 'finite_number', absent: 'batch_boundaries_absent', nullCode: 'batch_boundaries_absent', invalid: 'batch_boundaries_absent' },
   { path: 'batches[].candidate_end', origin: 'D17', nullable: 'never', type: 'finite_number', absent: 'batch_boundaries_absent', nullCode: 'batch_boundaries_absent', invalid: 'batch_boundaries_absent' },
   { path: 'batches[].intended_provider', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'batch_intended_provider_absent', nullCode: 'batch_intended_provider_absent', invalid: 'batch_intended_provider_absent' },
   { path: 'batches[].intended_model', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'batch_intended_model_absent', nullCode: 'batch_intended_model_absent', invalid: 'batch_intended_model_absent' },
```

Command, exit status, and timestamps:

```text
cd /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo && node --test --import tsx lib/__tests__/retrieval-telemetry-validation.test.ts
exit=1
STARTED: 2026-08-18T23:47:49Z
ENDED: 2026-08-18T23:47:50Z
```

Failing tests, by name:

```text
not ok 64 - 45.64 — batch.candidate_start: missing (v26 §3.3, its own row) → batch_boundaries_absent
not ok 65 - 45.65 — batch.candidate_start: null (v26 §3.3, its own row) → batch_boundaries_absent
not ok 66 - 45.66 — batch.candidate_start: invalid: a numeric STRING (v26 §3.3, its own row) → batch_boundaries_absent
not ok 349 - 45.199 — THE COUNT, computed not recalled: the matrix length, the generated cases, unique paths, and D17's transcribed field list all resolved into the matrix
```

Run summary:

```text
# tests 367
# pass 363
# fail 4
# cancelled 0
# duration_ms 1445.882583
```

### Row 4 — accept a MISSING hmac_key_version while the HMAC-absent licence is active

mutated file: lib/retrieval-telemetry-core.ts (sandbox copy). test file: lib/__tests__/retrieval-telemetry-validation.test.ts (run with the sandbox as cwd). must fail by name: 45.196.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/retrieval-telemetry-core.ts	2026-08-19 05:09:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/retrieval-telemetry-core.ts	2026-08-19 05:17:50
@@ -888,7 +888,7 @@
     return;
   }
   for (const parent of parents) {
-    if (!has(parent, last)) { v.push(rule.absent); continue; }
+    if (!has(parent, last)) { if (!(rule.path === 'hmac_key_version' && ctx.keyAbsent)) v.push(rule.absent); continue; }
     const value = parent[last];
     const verdict = nullVerdict(rule, ctx);
     if (value === null) {
```

Command, exit status, and timestamps:

```text
cd /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo && node --test --import tsx lib/__tests__/retrieval-telemetry-validation.test.ts
exit=1
STARTED: 2026-08-18T23:47:51Z
ENDED: 2026-08-18T23:47:52Z
```

Failing tests, by name:

```text
not ok 355 - 45.196 — THE LICENCE'S FIELDS (v26 §3.4): under hmac_key_absent the four HMAC fields may be NULL but must be PRESENT and correctly TYPED — a missing hmac_key_version no longer validates clean
```

Run summary:

```text
# tests 370
# pass 369
# fail 1
# cancelled 0
# duration_ms 1530.448417
```

### Row 5 — drop variant-generation usage validation: the two multi_query.variant_generation token rows removed from the matrix

mutated file: lib/retrieval-telemetry-core.ts (sandbox copy). test file: lib/__tests__/retrieval-telemetry-validation.test.ts (run with the sandbox as cwd). must fail by name: multi_query.variant_generation.prompt_tokens: missing, multi_query.variant_generation.completion_tokens: missing.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/retrieval-telemetry-core.ts	2026-08-19 05:09:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/retrieval-telemetry-core.ts	2026-08-19 05:17:52
@@ -789,8 +789,6 @@
   { path: 'multi_query.variant_generation.served_route_class', origin: 'D16', nullable: 'always', type: 'enum', values: SERVED_ROUTE_CLASSES, absent: 'variant_generation_served_route_class_field_absent', nullCode: 'variant_generation_served_route_class_field_absent', invalid: 'variant_generation_served_route_class_invalid' },
   { path: 'multi_query.variant_generation.served_model', origin: 'D17', nullable: 'always', type: 'string', absent: 'variant_generation_served_model_field_absent', nullCode: 'variant_generation_served_model_field_absent', invalid: 'variant_generation_served_model_invalid' },
   { path: 'multi_query.variant_generation.attempts', origin: 'D17', nullable: 'always', type: 'attempts', absent: 'variant_generation_attempts_field_absent', nullCode: 'variant_generation_attempts_field_absent', invalid: 'attempt_outcome_absent_or_invalid' },
-  { path: 'multi_query.variant_generation.prompt_tokens', origin: 'v26 §3.5', nullable: 'always', type: 'nonneg_number', absent: 'variant_generation_prompt_tokens_field_absent', nullCode: 'variant_generation_prompt_tokens_field_absent', invalid: 'variant_generation_prompt_tokens_invalid' },
-  { path: 'multi_query.variant_generation.completion_tokens', origin: 'v26 §3.5', nullable: 'always', type: 'nonneg_number', absent: 'variant_generation_completion_tokens_field_absent', nullCode: 'variant_generation_completion_tokens_field_absent', invalid: 'variant_generation_completion_tokens_invalid' },
   { path: 'multi_query.variant_generation.generated_variant_count', origin: 'D17', nullable: 'never', type: 'nonneg_number', absent: 'generated_variant_count_absent', nullCode: 'generated_variant_count_absent', invalid: 'generated_variant_count_absent' },
   { path: 'multi_query.variants', origin: 'D17', nullable: 'never', type: 'array', absent: 'variants_absent', nullCode: 'variants_absent', invalid: 'variants_absent' },
   { path: 'multi_query.variants[]', origin: 'v26 §3.1', nullable: 'never', type: 'object', absent: 'variant_member_invalid', nullCode: 'variant_member_invalid', invalid: 'variant_member_invalid' },
```

Command, exit status, and timestamps:

```text
cd /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo && node --test --import tsx lib/__tests__/retrieval-telemetry-validation.test.ts
exit=1
STARTED: 2026-08-18T23:47:52Z
ENDED: 2026-08-18T23:47:54Z
```

Failing tests, by name:

```text
not ok 118 - 45.118 — multi_query.variant_generation.prompt_tokens: missing (v26 §3.5, null is permitted) → variant_generation_prompt_tokens_field_absent
not ok 119 - 45.119 — multi_query.variant_generation.prompt_tokens: invalid: a numeric STRING (v26 §3.5) → variant_generation_prompt_tokens_invalid
not ok 120 - 45.120 — multi_query.variant_generation.completion_tokens: missing (v26 §3.5, null is permitted) → variant_generation_completion_tokens_field_absent
not ok 121 - 45.121 — multi_query.variant_generation.completion_tokens: invalid: negative (v26 §3.5) → variant_generation_completion_tokens_invalid
```

Run summary:

```text
# tests 364
# pass 360
# fail 4
# cancelled 0
# duration_ms 1661.659
```

### Row 6 — bypass the seam so a test-helper path runs instead of production: retrievalTerminalsSeam hands out a stub that returns clean verdicts without building, validating or writing anything

mutated file: lib/opd-note-audit.ts (sandbox copy). test file: lib/__tests__/retrieval-telemetry-validation.test.ts (run with the sandbox as cwd). must fail by name: 47.7, 47.8.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/opd-note-audit.ts	2026-08-19 05:09:48
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/opd-note-audit.ts	2026-08-19 05:17:54
@@ -828,7 +828,7 @@
  * nothing on the default path reads it, `auditOpdNote` and every call site are byte-identical to
  * before it existed, and it exists only so a test can drive what production drives.
  */
-export const retrievalTerminalsSeam: { readonly writeRetrievalTerminals: typeof writeRetrievalTerminals } = { writeRetrievalTerminals };
+export const retrievalTerminalsSeam: { readonly writeRetrievalTerminals: typeof writeRetrievalTerminals } = { writeRetrievalTerminals: async () => ({ primary: [], normative_channel: [] }) };
 
 /** The additive block's framing. Lives in the USER-message context only — OPD_AUDIT_SYSTEM is frozen. */
 export const NORMATIVE_CHANNEL_HEADER =
```

Command, exit status, and timestamps:

```text
cd /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo && node --test --import tsx lib/__tests__/retrieval-telemetry-validation.test.ts
exit=1
STARTED: 2026-08-18T23:47:54Z
ENDED: 2026-08-18T23:47:55Z
```

Failing tests, by name:

```text
not ok 364 - 47.7 — EXECUTED through the production terminal-payload path: real assembleAuditContext output → writeRetrievalTerminals (the seam) → the PRIMARY terminal write carries the keyed HMAC of exactly those bytes, the NORMATIVE write carries null, both manifests validate clean, and the handle is published after each
not ok 365 - 47.8 — EXECUTED, the EMPTY-STRING case: zero hits render an empty citedContext through the production path, and the primary write carries HMAC(""), a defined value — never null
```

Run summary:

```text
# tests 370
# pass 368
# fail 2
# cancelled 0
# duration_ms 1505.108792
```

### Row 7 — swallow a pg_ctl stop failure and delete anyway: teardown's verification removed, the directory is deleted regardless

mutated file: lib/__tests__/retrieval-telemetry-canonicalization.test.ts (sandbox copy). test file: lib/__tests__/retrieval-telemetry-canonicalization.test.ts (run with the sandbox as cwd). must fail by name: 56.7.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/__tests__/retrieval-telemetry-canonicalization.test.ts	2026-08-19 05:15:46
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/retrieval-telemetry-canonicalization.test.ts	2026-08-19 05:17:55
@@ -122,7 +122,7 @@
   const notRunning = !status.timedOut && (status.status === 3 || status.status === 4);
   const pidFile = join(c.data, 'postmaster.pid');
   const verifiedStopped = notRunning && !existsSync(pidFile);
-  if (!verifiedStopped) {
+  if (false) {
     throw new Error(
       `proof 56: SHUTDOWN NOT VERIFIED — the data directory is LEFT IN PLACE for a human: ${c.dir} `
       + `(pg_ctl stop → ${stopStatus === null ? 'timed out / not run' : `exit ${stopStatus}`}; `
```

Command, exit status, and timestamps:

```text
cd /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo && node --test --import tsx lib/__tests__/retrieval-telemetry-canonicalization.test.ts
exit=1
STARTED: 2026-08-18T23:47:55Z
ENDED: 2026-08-18T23:47:57Z
```

Failing tests, by name:

```text
not ok 8 - 56.7 — THE LIFECYCLE RULES, proved against a fake runner (v26 §3.7): deletion follows VERIFIED shutdown; a stop failure with the server still running LEAVES the directory in place and fails by name; a bounded timeout is a named failure, not a hang
```

Run summary:

```text
# tests 8
# pass 7
# fail 1
# cancelled 0
# duration_ms 1617.208667
```

### Row 8 — the null-member CODE removed: a non-object array member is silently skipped instead of reported as batch_member_invalid

mutated file: lib/retrieval-telemetry-core.ts (sandbox copy). test file: lib/__tests__/retrieval-telemetry-validation.test.ts (run with the sandbox as cwd). must fail by name: 45.198, batch (member).

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/retrieval-telemetry-core.ts	2026-08-19 05:09:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/retrieval-telemetry-core.ts	2026-08-19 05:17:57
@@ -883,7 +883,7 @@
     for (const parent of parents) {
       const arr = get(parent, key);
       if (!Array.isArray(arr)) continue;              // the array's own rule reports a missing/invalid array
-      for (const member of arr) if (!isPlainObject(member)) v.push(rule.invalid);
+      void arr;
     }
     return;
   }
```

Command, exit status, and timestamps:

```text
cd /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo && node --test --import tsx lib/__tests__/retrieval-telemetry-validation.test.ts
exit=1
STARTED: 2026-08-18T23:47:57Z
ENDED: 2026-08-18T23:47:58Z
```

Failing tests, by name:

```text
not ok 70 - 45.70 — batch (member): a null member — reported, never dereferenced (v26 §3.2) → batch_member_invalid
not ok 71 - 45.71 — batch (member): a numeric member → batch_member_invalid
not ok 123 - 45.123 — multi_query.variants (member): a null member (v26 §3.2) → variant_member_invalid
not ok 265 - 45.335 — matrix batches[] (v26 §3.1): a null member → batch_member_invalid, without throwing
not ok 266 - 45.336 — matrix batches[] (v26 §3.1): a numeric member → batch_member_invalid
not ok 267 - 45.337 — matrix batches[] (v26 §3.1): an array member → batch_member_invalid
not ok 340 - 45.410 — matrix multi_query.variants[] (v26 §3.1): a null member → variant_member_invalid, without throwing
not ok 341 - 45.411 — matrix multi_query.variants[] (v26 §3.1): a numeric member → variant_member_invalid
not ok 342 - 45.412 — matrix multi_query.variants[] (v26 §3.1): an array member → variant_member_invalid
not ok 353 - 45.198 — batches: [null] returns CODES, it does not throw; and every other malformed member shape is classified the same way
```

Run summary:

```text
# tests 370
# pass 360
# fail 10
# cancelled 0
# duration_ms 1087.992
```

### Row 9 — the production handoff broken behind the seam: the PRIMARY payload is keyed with scorerContext: null instead of citedContext

mutated file: lib/opd-note-audit.ts (sandbox copy). test file: lib/__tests__/retrieval-telemetry-validation.test.ts (run with the sandbox as cwd). must fail by name: 47.7, 47.8.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/opd-note-audit.ts	2026-08-19 05:09:48
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/opd-note-audit.ts	2026-08-19 05:17:58
@@ -782,7 +782,7 @@
     // PRIMARY carries the scorer-context HMAC, computed over the EXACT rendered citedContext bytes.
     // With zero candidates that string is empty, and the HMAC of the empty string is a defined
     // value — never null because reranking was skipped or failed (A2).
-    const primaryPayload = buildRetrievalPayload(args.primaryCapture, { hmacKey, scorerContext: citedContext });
+    const primaryPayload = buildRetrievalPayload(args.primaryCapture, { hmacKey, scorerContext: null });
     const primaryOperational = operationalFor('primary');
     defectsByRole.primary = validateManifest({ ...primaryPayload, operational: primaryOperational });
     handle = await writeRetrievalTerminal(handle, 'primary', {
```

Command, exit status, and timestamps:

```text
cd /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo && node --test --import tsx lib/__tests__/retrieval-telemetry-validation.test.ts
exit=1
STARTED: 2026-08-18T23:47:58Z
ENDED: 2026-08-18T23:47:59Z
```

Failing tests, by name:

```text
not ok 363 - 47.6 — the PRODUCTION CALLER handoff, pinned in comment-stripped source: lib/opd-note-audit.ts destructures citedContext from assembleAuditContext(hits, normHits), passes it into writeRetrievalTerminals, keys the PRIMARY payload with scorerContext: citedContext, the NORMATIVE payload with scorerContext: null, and validates the stamped primary manifest
not ok 364 - 47.7 — EXECUTED through the production terminal-payload path: real assembleAuditContext output → writeRetrievalTerminals (the seam) → the PRIMARY terminal write carries the keyed HMAC of exactly those bytes, the NORMATIVE write carries null, both manifests validate clean, and the handle is published after each
not ok 365 - 47.8 — EXECUTED, the EMPTY-STRING case: zero hits render an empty citedContext through the production path, and the primary write carries HMAC(""), a defined value — never null
```

Run summary:

```text
# tests 370
# pass 367
# fail 3
# cancelled 0
# duration_ms 605.849917
```

### Row 10 — the licence declaration itself unvalidated: the telemetry_error matrix row removed

mutated file: lib/retrieval-telemetry-core.ts (sandbox copy). test file: lib/__tests__/retrieval-telemetry-validation.test.ts (run with the sandbox as cwd). must fail by name: 45.196, telemetry_error: missing.

Mutation diff (worktree original vs mutated sandbox copy):

```diff
--- /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry/lib/retrieval-telemetry-core.ts	2026-08-19 05:09:10
+++ /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/retrieval-telemetry-core.ts	2026-08-19 05:17:59
@@ -718,7 +718,6 @@
   { path: 'manifest_schema_version', origin: 'D17', nullable: 'never', type: 'enum', values: [MANIFEST_SCHEMA_VERSION], absent: 'manifest_version_unrecognized', nullCode: 'manifest_version_unrecognized', invalid: 'manifest_version_unrecognized' },
   // D8: the licence lets the HMAC BE null; it does not let the field be absent or wrongly typed (v26 §3.4).
   { path: 'hmac_key_version', origin: 'D8', nullable: 'hmac_key_absent', type: 'nonempty_string', absent: 'hmac_key_version_field_absent', nullCode: 'hmac_key_version_absent', invalid: 'hmac_key_version_absent' },
-  { path: 'telemetry_error', origin: 'D8', nullable: 'always', type: 'enum', values: [TELEMETRY_ERROR_HMAC_KEY_ABSENT], absent: 'telemetry_error_field_absent', nullCode: 'telemetry_error_invalid', invalid: 'telemetry_error_invalid' },
   { path: 'operational', origin: 'D17', nullable: 'never', type: 'object', absent: 'operational_absent', nullCode: 'operational_absent', invalid: 'operational_absent' },
   { path: 'operational.route', origin: 'D17', nullable: 'never', type: 'enum', values: RETRIEVAL_ROUTES, absent: 'route_absent_or_invalid', nullCode: 'route_absent_or_invalid', invalid: 'route_absent_or_invalid' },
   { path: 'operational.route_class', origin: 'D17', nullable: 'never', type: 'nonempty_string', absent: 'route_class_absent', nullCode: 'route_class_absent', invalid: 'route_class_absent' },
```

Command, exit status, and timestamps:

```text
cd /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo && node --test --import tsx lib/__tests__/retrieval-telemetry-validation.test.ts
exit=1
STARTED: 2026-08-18T23:47:59Z
ENDED: 2026-08-18T23:48:00Z
```

Failing tests, by name:

```text
not ok 74 - 45.74 — telemetry_error: missing (D8 — the licence declaration must be a present field) → telemetry_error_field_absent
not ok 75 - 45.75 — telemetry_error: invalid: an unknown error string → telemetry_error_invalid
not ok 352 - 45.196 — THE LICENCE'S FIELDS (v26 §3.4): under hmac_key_absent the four HMAC fields may be NULL but must be PRESENT and correctly TYPED — a missing hmac_key_version no longer validates clean
```

Run summary:

```text
# tests 367
# pass 364
# fail 3
# cancelled 0
# duration_ms 852.110625
```

Every row failed its named test by name; every run completed in under three seconds; no row was accepted on a file-level
timeout. Row 1's description file records an observation worth keeping: a nullability flip INSIDE the matrix is caught by
the hand-written row (45.57), not by the matrix-generated null case, which derives its expectation from the matrix as
loaded — the generated suite guards the ENGINE against the matrix, the hand rows guard the MATRIX. Both are kept.

---

## Part 2 — the gate, nine numbered commands and the build pair

Commands ran STRICTLY in order; no command started until the previous one had exited (a single sequential shell script
enforced this; the per-command STARTED/ENDED timestamps in each transcript show it). Command 6 is the APPROVED no-`git add`
form (addendum v18 §4.1, adopted by every addendum since): the five-line block proves determinism (`cmp` of generation
two against generation one) and currency (`git diff --exit-code` of the committed map) with no git write. No `git add` was
used anywhere in the gate. ⚠️ `lib/retrieval-telemetry-core.ts` AND `lib/opd-note-audit.ts` are in the import graph and both changed in this
commit; the map did NOT move — both generations wrote 90492 "bytes" (UTF-16 code units; `wc -c` 90494) and `git diff --exit-code` exited 0.

### git status before the gate

```text
COMMAND: git status --porcelain
EXIT: 0
COMMAND: git status --porcelain --ignored
!! .env.local
!! .next/
!! .vercel/
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v26-18-AUG-2026.md
!! CDMSS-SAUL-REVIEW-37-18-AUG-2026.md
!! next-env.d.ts
!! node_modules/
!! tsconfig.tsbuildinfo
EXIT: 0
```

### Command 1 — npm test

```text
COMMAND: npm test
STARTED: 2026-08-18T23:49:00Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 test
> node --test --import tsx "lib/**/__tests__/*.test.ts"

TAP version 13
# Subtest: verdict normalization maps each store vocab into the right family; needs_action & faithful-as-TP are refused
ok 1 - verdict normalization maps each store vocab into the right family; needs_action & faithful-as-TP are refused
  ---
  duration_ms: 1.383167
  type: 'test'
  ...
# Subtest: precision = (TP+ValidExtra)/(TP+ValidExtra+False); Nitpick/Contested excluded from the denominator
ok 2 - precision = (TP+ValidExtra)/(TP+ValidExtra+False); Nitpick/Contested excluded from the denominator
  ---
  duration_ms: 0.394958
  type: 'test'
  ...
# Subtest: precision groups by SURFACE (headline); engine version is the drill-in — same convention
ok 3 - precision groups by SURFACE (headline); engine version is the drill-in — same convention
  ---
  duration_ms: 15.375709
  type: 'test'
  ...
# Subtest: two-page split at the DATA layer: selectFinding drops fidelity; selectFidelity drops finding
ok 4 - two-page split at the DATA layer: selectFinding drops fidelity; selectFidelity drops finding
  ---
  duration_ms: 0.553542
  type: 'test'
  ...
# Subtest: fidelity is NEVER folded into precision — separate rollup, own family
ok 5 - fidelity is NEVER folded into precision — separate rollup, own family
  ---
  duration_ms: 0.571
  type: 'test'
  ...
# Subtest: GUARDRAIL: no machine/judge verdict store is in the federation set
ok 6 - GUARDRAIL: no machine/judge verdict store is in the federation set
  ---
  duration_ms: 0.703375
  type: 'test'
  ...
# Subtest: ADVISORY: no rollup keys by reviewer — two reviewers on the same (surface,engine) collapse
ok 7 - ADVISORY: no rollup keys by reviewer — two reviewers on the same (surface,engine) collapse
  ---
  duration_ms: 0.473667
  type: 'test'
  ...
# Subtest: ADVISORY: neither the core nor the surface aggregates a per-reviewer accuracy scorecard
ok 8 - ADVISORY: neither the core nor the surface aggregates a per-reviewer accuracy scorecard
  ---
  duration_ms: 1.669375
  type: 'test'
  ...
# Subtest: the two-page split is enforced in the SOURCE — ledger renders no fidelity, fidelity renders no precision
ok 9 - the two-page split is enforced in the SOURCE — ledger renders no fidelity, fidelity renders no precision
  ---
  duration_ms: 0.362
  type: 'test'
  ...
# Subtest: a name is required and must survive a trim at >= 2 characters
ok 10 - a name is required and must survive a trim at >= 2 characters
  ---
  duration_ms: 1.316291
  type: 'test'
  ...
# Subtest: PERSISTED VERBATIM — trimmed and capped, never title-cased or matched to a roster
ok 11 - PERSISTED VERBATIM — trimmed and capped, never title-cased or matched to a roster
  ---
  duration_ms: 0.117666
  type: 'test'
  ...
# Subtest: THE RULE: no browser storage API is referenced from ANY of the three surfaces
ok 12 - THE RULE: no browser storage API is referenced from ANY of the three surfaces
  ---
  duration_ms: 0.54425
  type: 'test'
  ...
# Subtest: the storage helpers and the key are GONE from the shared module
ok 13 - the storage helpers and the key are GONE from the shared module
  ---
  duration_ms: 0.117292
  type: 'test'
  ...
# Subtest: EACH FIELD RENDERS EMPTY ON MOUNT — no default, no "last used" hint
ok 14 - EACH FIELD RENDERS EMPTY ON MOUNT — no default, no "last used" hint
  ---
  duration_ms: 0.514333
  type: 'test'
  ...
# Subtest: the name is still typed fresh and still sent by all three surfaces
ok 15 - the name is still typed fresh and still sent by all three surfaces
  ---
  duration_ms: 0.093
  type: 'test'
  ...
# Subtest: THE SAFETY PROPERTY: every route rejects a missing name, not just the UI
ok 16 - THE SAFETY PROPERTY: every route rejects a missing name, not just the UI
  ---
  duration_ms: 0.073291
  type: 'test'
  ...
# Subtest: the routes persist the CLEANED value, not the raw body field
ok 17 - the routes persist the CLEANED value, not the raw body field
  ---
  duration_ms: 0.062042
  type: 'test'
  ...
# Subtest: the UI disables the action until BOTH rationale and name are filled
ok 18 - the UI disables the action until BOTH rationale and name are filled
  ---
  duration_ms: 0.203708
  type: 'test'
  ...
# Subtest: the name is actually SENT by all three surfaces
ok 19 - the name is actually SENT by all three surfaces
  ---
  duration_ms: 0.386834
  type: 'test'
  ...
# Subtest: the round-trip guarantee is NOT weakened — a zero-diff re-upload still demands nothing
ok 20 - the round-trip guarantee is NOT weakened — a zero-diff re-upload still demands nothing
  ---
  duration_ms: 0.053041
  type: 'test'
  ...
# Subtest: THE LABEL IS HONEST: "Your name", and the helper text says it is self-declared
ok 21 - THE LABEL IS HONEST: "Your name", and the helper text says it is self-declared
  ---
  duration_ms: 0.051584
  type: 'test'
  ...
# Subtest: nothing anywhere implies authentication
ok 22 - nothing anywhere implies authentication
  ---
  duration_ms: 0.798791
  type: 'test'
  ...
# Subtest: NO MIGRATION WAS CREATED for Phase D
ok 23 - NO MIGRATION WAS CREATED for Phase D
  ---
  duration_ms: 1.050834
  type: 'test'
  ...
# Subtest: NO BACKFILL — existing Unknown/null rows are never rewritten or substituted on read
ok 24 - NO BACKFILL — existing Unknown/null rows are never rewritten or substituted on read
  ---
  duration_ms: 0.333
  type: 'test'
  ...
# Subtest: D-3 KEPT: a name-only edit is savable, so an old review can gain an author
ok 25 - D-3 KEPT: a name-only edit is savable, so an old review can gain an author
  ---
  duration_ms: 0.053959
  type: 'test'
  ...
# Subtest: the shared error message is the one users actually see, and names no roster
ok 26 - the shared error message is the one users actually see, and names no roster
  ---
  duration_ms: 0.090334
  type: 'test'
  ...
# Subtest: semantics \#4: a DOWNGRADE adjudication preserves every original evidence field
ok 27 - semantics \#4: a DOWNGRADE adjudication preserves every original evidence field
  ---
  duration_ms: 0.74625
  type: 'test'
  ...
# Subtest: semantics \#4: a DROP adjudication still records the original finding_ref in the ledger (auditability)
ok 28 - semantics \#4: a DROP adjudication still records the original finding_ref in the ledger (auditability)
  ---
  duration_ms: 0.140583
  type: 'test'
  ...
# Subtest: semantics \#4: adjudication never MUTATES the original finding object
ok 29 - semantics \#4: adjudication never MUTATES the original finding object
  ---
  duration_ms: 0.140083
  type: 'test'
  ...
# Subtest: semantics \#5a: the advisory CONTEXT_STYLE palette is disjoint from the scored-band palette
ok 30 - semantics \#5a: the advisory CONTEXT_STYLE palette is disjoint from the scored-band palette
  ---
  duration_ms: 0.889208
  type: 'test'
  ...
# Subtest: semantics \#5b: no advisory render line reaches for bandColor/scoreColor (source assertion)
ok 31 - semantics \#5b: no advisory render line reaches for bandColor/scoreColor (source assertion)
  ---
  duration_ms: 0.111083
  type: 'test'
  ...
# Subtest: semantics \#5c: the scored-band palette itself is intact (guards against gaming 5a by editing the bands)
ok 32 - semantics \#5c: the scored-band palette itself is intact (guards against gaming 5a by editing the bands)
  ---
  duration_ms: 0.06975
  type: 'test'
  ...
# Subtest: semantics \#3: a finding-shaped object mints NO MedicationAssertion
ok 33 - semantics \#3: a finding-shaped object mints NO MedicationAssertion
  ---
  duration_ms: 0.420084
  type: 'test'
  ...
# Subtest: semantics \#3: a finding-shaped row through assemble→build mints no problem/medication/investigation
ok 34 - semantics \#3: a finding-shaped row through assemble→build mints no problem/medication/investigation
  ---
  duration_ms: 0.778292
  type: 'test'
  ...
# Subtest: semantics: inquiry output never carries scored-band language
ok 35 - semantics: inquiry output never carries scored-band language
  ---
  duration_ms: 2.495167
  type: 'test'
  ...
# Subtest: semantics: scored cores do not import lib/inquiry (rule 5 reverse direction, source-pinned)
ok 36 - semantics: scored cores do not import lib/inquiry (rule 5 reverse direction, source-pinned)
  ---
  duration_ms: 1.598625
  type: 'test'
  ...
# Subtest: map generation is deterministic and the committed map is current
ok 37 - map generation is deterministic and the committed map is current
  ---
  duration_ms: 574.76675
  type: 'test'
  ...
# Subtest: coverage is a true partition and matches the UNREGISTERED allowlist
ok 38 - coverage is a true partition and matches the UNREGISTERED allowlist
  ---
  duration_ms: 0.489333
  type: 'test'
  ...
# Subtest: the governed modules appear on the map with their INVENTORY planes
ok 39 - the governed modules appear on the map with their INVENTORY planes
  ---
  duration_ms: 0.153542
  type: 'test'
  ...
# Subtest: version registry: declared *_VERSION constants only, live value round-trips
ok 40 - version registry: declared *_VERSION constants only, live value round-trips
  ---
  duration_ms: 0.249292
  type: 'test'
  ...
# Subtest: edges: no self-loops, and the map shows the Slice-1 boundaries clean
ok 41 - edges: no self-loops, and the map shows the Slice-1 boundaries clean
  ---
  duration_ms: 0.308917
  type: 'test'
  ...
# Subtest: ChangeEntry is a true superset: the audit changelog conforms with no data change
ok 42 - ChangeEntry is a true superset: the audit changelog conforms with no data change
  ---
  duration_ms: 0.064542
  type: 'test'
  ...
# Subtest: semantics \#1: silence in a later encounter NEVER resolves a problem (→ uncertain, not resolved)
ok 43 - semantics \#1: silence in a later encounter NEVER resolves a problem (→ uncertain, not resolved)
  ---
  duration_ms: 1.401708
  type: 'test'
  ...
# Subtest: semantics \#1: only an EXPLICIT documented-resolved occurrence flips the status
ok 44 - semantics \#1: only an EXPLICIT documented-resolved occurrence flips the status
  ---
  duration_ms: 0.1795
  type: 'test'
  ...
# Subtest: semantics \#1: a problem documented ON the as-of day stays active — never inferred beyond the evidence
ok 45 - semantics \#1: a problem documented ON the as-of day stays active — never inferred beyond the evidence
  ---
  duration_ms: 0.0805
  type: 'test'
  ...
# Subtest: semantics \#2: a med line maps to status "prescribed" — never a taking/adherence status
ok 46 - semantics \#2: a med line maps to status "prescribed" — never a taking/adherence status
  ---
  duration_ms: 0.474083
  type: 'test'
  ...
# Subtest: semantics \#2: EVERY line of a prescription maps to "prescribed" (bulk path)
ok 47 - semantics \#2: EVERY line of a prescription maps to "prescribed" (bulk path)
  ---
  duration_ms: 0.147167
  type: 'test'
  ...
# Subtest: D2 cut: strict prior-day — same-day and future excluded, prior included
ok 48 - D2 cut: strict prior-day — same-day and future excluded, prior included
  ---
  duration_ms: 3.865541
  type: 'test'
  ...
# Subtest: D2 cut: the audited encounterRef is always dropped even if prior-dated
ok 49 - D2 cut: the audited encounterRef is always dropped even if prior-dated
  ---
  duration_ms: 1.9405
  type: 'test'
  ...
# Subtest: D2 cut: applies identically to care_call / PROM-fold kinds
ok 50 - D2 cut: applies identically to care_call / PROM-fold kinds
  ---
  duration_ms: 0.319084
  type: 'test'
  ...
# Subtest: D2 cut: empty when nothing survives (no-prior-history honesty)
ok 51 - D2 cut: empty when nothing survives (no-prior-history honesty)
  ---
  duration_ms: 1.061708
  type: 'test'
  ...
# Subtest: D2 cut: ISO timestamps are compared at day precision
ok 52 - D2 cut: ISO timestamps are compared at day precision
  ---
  duration_ms: 0.06975
  type: 'test'
  ...
# Subtest: D2 cut: does not mutate the input array
ok 53 - D2 cut: does not mutate the input array
  ---
  duration_ms: 0.050333
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: aspirinMaxDailyMg: scheduled regimens sum to perUnitMg × units × doses/day
ok 54 - aspirinMaxDailyMg: scheduled regimens sum to perUnitMg × units × doses/day
  ---
  duration_ms: 3.473291
  type: 'test'
  ...
# Subtest: aspirinMaxDailyMg: D-2 — any unparseable contributing line makes the whole total null
ok 55 - aspirinMaxDailyMg: D-2 — any unparseable contributing line makes the whole total null
  ---
  duration_ms: 0.431375
  type: 'test'
  ...
# Subtest: acetylsalicylic acid is the same molecule as aspirin
ok 56 - acetylsalicylic acid is the same molecule as aspirin
  ---
  duration_ms: 0.883125
  type: 'test'
  ...
# Subtest: §2.3 row 1 — aspirin 75 mg OD + telmisartan: NOTHING fires (was Interaction (moderate))
ok 57 - §2.3 row 1 — aspirin 75 mg OD + telmisartan: NOTHING fires (was Interaction (moderate))
  ---
  duration_ms: 0.132417
  type: 'test'
  ...
# Subtest: §2.3 row 2 — aspirin 75 mg OD + clopidogrel: DAPT (moderate) still fires, unchanged
ok 58 - §2.3 row 2 — aspirin 75 mg OD + clopidogrel: DAPT (moderate) still fires, unchanged
  ---
  duration_ms: 4.041916
  type: 'test'
  ...
# Subtest: §2.3 row 3 — aspirin 75 mg OD + enoxaparin: major still fires, unchanged
ok 59 - §2.3 row 3 — aspirin 75 mg OD + enoxaparin: major still fires, unchanged
  ---
  duration_ms: 0.695792
  type: 'test'
  ...
# Subtest: §2.3 row 4 — aspirin 75 mg OD + diclofenac: Antiplatelet + NSAID (moderate) fires instead of Two NSAIDs
ok 60 - §2.3 row 4 — aspirin 75 mg OD + diclofenac: Antiplatelet + NSAID (moderate) fires instead of Two NSAIDs
  ---
  duration_ms: 0.368208
  type: 'test'
  ...
# Subtest: §2.3 row 5 — aspirin 650 mg TDS + telmisartan: unchanged, 1950 mg/day > 100
ok 61 - §2.3 row 5 — aspirin 650 mg TDS + telmisartan: unchanged, 1950 mg/day > 100
  ---
  duration_ms: 0.178375
  type: 'test'
  ...
# Subtest: §2.3 row 6 — aspirin with an unreadable strength + telmisartan: NOTHING fires (D-2)
ok 62 - §2.3 row 6 — aspirin with an unreadable strength + telmisartan: NOTHING fires (D-2)
  ---
  duration_ms: 0.364916
  type: 'test'
  ...
# Subtest: §2.3 row 7 — aspirin 150 mg OD + telmisartan: unchanged, 150 > 100 (D-1 accepted consequence)
ok 63 - §2.3 row 7 — aspirin 150 mg OD + telmisartan: unchanged, 150 > 100 (D-1 accepted consequence)
  ---
  duration_ms: 0.372916
  type: 'test'
  ...
# Subtest: the threshold is INCLUSIVE at 100 mg/day and exclusive above it
ok 64 - the threshold is INCLUSIVE at 100 mg/day and exclusive above it
  ---
  duration_ms: 0.244208
  type: 'test'
  ...
# Subtest: med-order invariance: the aspirin class does not depend on meds[] order (G-1 stays green)
ok 65 - med-order invariance: the aspirin class does not depend on meds[] order (G-1 stays green)
  ---
  duration_ms: 0.534416
  type: 'test'
  ...
# Subtest: scope guard: a non-aspirin NSAID pair is byte-identical to before the change
ok 66 - scope guard: a non-aspirin NSAID pair is byte-identical to before the change
  ---
  duration_ms: 0.208541
  type: 'test'
  ...
# Subtest: a combination line carrying a NON-aspirin NSAID is never de-classed by the aspirin rule
ok 67 - a combination line carrying a NON-aspirin NSAID is never de-classed by the aspirin rule
  ---
  duration_ms: 0.099625
  type: 'test'
  ...
# Subtest: tagInteractions: suppressNsaid drops only the nsaid tag; antiplatelet survives
ok 68 - tagInteractions: suppressNsaid drops only the nsaid tag; antiplatelet survives
  ---
  duration_ms: 0.108916
  type: 'test'
  ...
# Subtest: 11.1 — the six outcomes are the runtime authority, in the committed order
ok 69 - 11.1 — the six outcomes are the runtime authority, in the committed order
  ---
  duration_ms: 1.210125
  type: 'test'
  ...
# Subtest: 11.2 — `classifyAttemptOutcome` produces five of the six and NEVER `success`
ok 70 - 11.2 — `classifyAttemptOutcome` produces five of the six and NEVER `success`
  ---
  duration_ms: 0.280167
  type: 'test'
  ...
# Subtest: 11.3 — all four success sites record `success`, two of them through localAttemptSuccess()
ok 71 - 11.3 — all four success sites record `success`, two of them through localAttemptSuccess()
  ---
  duration_ms: 71.170375
  type: 'test'
  ...
# Subtest: 11.4 — detector one: a declared timeout kind classifies `timeout`, not `transport_error`
ok 72 - 11.4 — detector one: a declared timeout kind classifies `timeout`, not `transport_error`
  ---
  duration_ms: 1.3015
  type: 'test'
  ...
# Subtest: 11.5 — detector two: a REAL SDK timeout classifies `timeout`
ok 73 - 11.5 — detector two: a REAL SDK timeout classifies `timeout`
  ---
  duration_ms: 0.466583
  type: 'test'
  ...
# Subtest: 11.5b — REQUIREMENT 3: neither read may throw, on any hostile input
ok 74 - 11.5b — REQUIREMENT 3: neither read may throw, on any hostile input
  ---
  duration_ms: 3.612875
  type: 'test'
  ...
# Subtest: 11.6 — an outcome OUTSIDE the six is a manifest defect, in all three locations
ok 75 - 11.6 — an outcome OUTSIDE the six is a manifest defect, in all three locations
  ---
  duration_ms: 8.397
  type: 'test'
  ...
# Subtest: 11.7 — an outcome INSIDE the six is not a defect, in all three locations
ok 76 - 11.7 — an outcome INSIDE the six is not a defect, in all three locations
  ---
  duration_ms: 6.175583
  type: 'test'
  ...
# Subtest: 11.8 — an ABSENT outcome, a wrong-shaped attempts value, and a mixed array are all defects
ok 77 - 11.8 — an ABSENT outcome, a wrong-shaped attempts value, and a mixed array are all defects
  ---
  duration_ms: 11.651208
  type: 'test'
  ...
# Subtest: 11.9 — `attempts: null` is LEGAL at all three locations and must NOT be flagged
ok 78 - 11.9 — `attempts: null` is LEGAL at all three locations and must NOT be flagged
  ---
  duration_ms: 0.860625
  type: 'test'
  ...
# Subtest: 11.10 — the defect name is the SAME stable string at all three locations
ok 79 - 11.10 — the defect name is the SAME stable string at all three locations
  ---
  duration_ms: 0.207417
  type: 'test'
  ...
# Subtest: SQL twin and canonicalByUid select the SAME row — all traps
ok 80 - SQL twin and canonicalByUid select the SAME row — all traps
  ---
  duration_ms: 1.504125
  type: 'test'
  ...
# Subtest: the ordering is the one THE RULE states — reverting it fails this test
ok 81 - the ordering is the one THE RULE states — reverting it fails this test
  ---
  duration_ms: 0.296959
  type: 'test'
  ...
# Subtest: §6 — SCAN lib/ and app/: nobody hand-writes a note-identity dedup on opd_note_audits
ok 82 - §6 — SCAN lib/ and app/: nobody hand-writes a note-identity dedup on opd_note_audits
  ---
  duration_ms: 84.754834
  type: 'test'
  ...
# Subtest: no doctor-facing surface writes its own NOTE-IDENTITY dedup
ok 83 - no doctor-facing surface writes its own NOTE-IDENTITY dedup
  ---
  duration_ms: 0.261625
  type: 'test'
  ...
# Subtest: ONE RULE across every surface — governance and stewardship included (addendum D)
ok 84 - ONE RULE across every surface — governance and stewardship included (addendum D)
  ---
  duration_ms: 0.304583
  type: 'test'
  ...
# Subtest: a non-numeric tail that is NOT -mini cannot reach the cast — shape, not suffix (learning.ts)
ok 85 - a non-numeric tail that is NOT -mini cannot reach the cast — shape, not suffix (learning.ts)
  ---
  duration_ms: 0.639833
  type: 'test'
  ...
# Subtest: canonicalDistinctOnSql composes the identity, the columns and the rank tail
ok 86 - canonicalDistinctOnSql composes the identity, the columns and the rank tail
  ---
  duration_ms: 0.070958
  type: 'test'
  ...
# Subtest: the migration adds provider to BOTH audit tables
ok 87 - the migration adds provider to BOTH audit tables
  ---
  duration_ms: 0.497667
  type: 'test'
  ...
# Subtest: IT IS IDEMPOTENT — running it twice is a no-op
ok 88 - IT IS IDEMPOTENT — running it twice is a no-op
  ---
  duration_ms: 0.182083
  type: 'test'
  ...
# Subtest: NO index, NO default, NO backfill — a null provider must stay distinguishable
ok 89 - NO index, NO default, NO backfill — a null provider must stay distinguishable
  ---
  duration_ms: 0.120833
  type: 'test'
  ...
# Subtest: the migration records WHY the column exists
ok 90 - the migration records WHY the column exists
  ---
  duration_ms: 0.063291
  type: 'test'
  ...
# Subtest: a saved OPD row carries BOTH provider and model
ok 91 - a saved OPD row carries BOTH provider and model
  ---
  duration_ms: 0.090875
  type: 'test'
  ...
# Subtest: OPD: a re-audit RE-ATTRIBUTES — provider is in the conflict SET, like model
ok 92 - OPD: a re-audit RE-ATTRIBUTES — provider is in the conflict SET, like model
  ---
  duration_ms: 0.041
  type: 'test'
  ...
# Subtest: OPD: the column is PROBED, so the deploy is safe before the migration runs
ok 93 - OPD: the column is PROBED, so the deploy is safe before the migration runs
  ---
  duration_ms: 0.094208
  type: 'test'
  ...
# Subtest: a saved IPD row carries BOTH provider and model
ok 94 - a saved IPD row carries BOTH provider and model
  ---
  duration_ms: 0.047667
  type: 'test'
  ...
# Subtest: IPD: the column is PROBED too, against its OWN table
ok 95 - IPD: the column is PROBED too, against its OWN table
  ---
  duration_ms: 0.182334
  type: 'test'
  ...
# Subtest: both workers read model AND provider from ONE row of ONE query
ok 96 - both workers read model AND provider from ONE row of ONE query
  ---
  duration_ms: 0.286708
  type: 'test'
  ...
# Subtest: THE MINI PATH RECORDS ollama
ok 97 - THE MINI PATH RECORDS ollama
  ---
  duration_ms: 0.047792
  type: 'test'
  ...
# Subtest: NEVER FROM A CONSTANT — the D-D defect that bit twice
ok 98 - NEVER FROM A CONSTANT — the D-D defect that bit twice
  ---
  duration_ms: 0.0945
  type: 'test'
  ...
# Subtest: a NULL provider is accepted and stored as null, not the string "null"
ok 99 - a NULL provider is accepted and stored as null, not the string "null"
  ---
  duration_ms: 0.073166
  type: 'test'
  ...
# Subtest: lib/audit-canonical.ts is UNTOUCHED — the grader tier is Unit C
ok 100 - lib/audit-canonical.ts is UNTOUCHED — the grader tier is Unit C
  ---
  duration_ms: 0.198333
  type: 'test'
  ...
# Subtest: applyDemotes: match → informational + quieted_by; stored fields untouched; non-match untouched
ok 101 - applyDemotes: match → informational + quieted_by; stored fields untouched; non-match untouched
  ---
  duration_ms: 0.702459
  type: 'test'
  ...
# Subtest: applyDemotes: lvc_category is exact + case-insensitive; subject_contains reuses the matcher
ok 102 - applyDemotes: lvc_category is exact + case-insensitive; subject_contains reuses the matcher
  ---
  duration_ms: 0.144417
  type: 'test'
  ...
# Subtest: applyDemotes: proposed / retired / inactive rules quiet NOTHING (a proposal scores nothing)
ok 103 - applyDemotes: proposed / retired / inactive rules quiet NOTHING (a proposal scores nothing)
  ---
  duration_ms: 0.068208
  type: 'test'
  ...
# Subtest: applyDemotes: already-informational findings are left alone (never re-badged as quieted)
ok 104 - applyDemotes: already-informational findings are left alone (never re-badged as quieted)
  ---
  duration_ms: 0.048709
  type: 'test'
  ...
# Subtest: severity floor, store half: a rule on ANY deterministic safety signal type is refused, for EVERY action
ok 105 - severity floor, store half: a rule on ANY deterministic safety signal type is refused, for EVERY action
  ---
  duration_ms: 0.171
  type: 'test'
  ...
# Subtest: severity floor, engine half (drop/downgrade): a drop rule can NEVER remove a banned_fdc finding
ok 106 - severity floor, engine half (drop/downgrade): a drop rule can NEVER remove a banned_fdc finding
  ---
  duration_ms: 0.0845
  type: 'test'
  ...
# Subtest: severity floor, engine half (drop/downgrade): a downgrade rule can NEVER informational-ise a high-alert finding
ok 107 - severity floor, engine half (drop/downgrade): a downgrade rule can NEVER informational-ise a high-alert finding
  ---
  duration_ms: 0.088458
  type: 'test'
  ...
# Subtest: severity floor does not over-reach: a drop rule on a NON-safety type still drops (regression guard)
ok 108 - severity floor does not over-reach: a drop rule on a NON-safety type still drops (regression guard)
  ---
  duration_ms: 0.049875
  type: 'test'
  ...
# Subtest: zero-delta: applySuppressions with no rules returns the input findings unchanged
ok 109 - zero-delta: applySuppressions with no rules returns the input findings unchanged
  ---
  duration_ms: 0.24475
  type: 'test'
  ...
# Subtest: severity floor, engine half: safety findings are skipped even when a rule somehow matches them
ok 110 - severity floor, engine half: safety findings are skipped even when a rule somehow matches them
  ---
  duration_ms: 0.290208
  type: 'test'
  ...
# Subtest: demote rules never flow through applySuppressions semantics (quieting is its own seam)
ok 111 - demote rules never flow through applySuppressions semantics (quieting is its own seam)
  ---
  duration_ms: 0.08125
  type: 'test'
  ...
# Subtest: §8.1 paired scoring: same note, rule active vs not — demoted finding contributes exactly zero
ok 112 - §8.1 paired scoring: same note, rule active vs not — demoted finding contributes exactly zero
  ---
  duration_ms: 0.598584
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: store half: a drop/downgrade/demote rule on ANY safety signal type is refused before the INSERT
ok 113 - store half: a drop/downgrade/demote rule on ANY safety signal type is refused before the INSERT
  ---
  duration_ms: 1.459708
  type: 'test'
  ...
# Subtest: store half: the floor does not over-reach — a non-safety type gets past validation
ok 114 - store half: the floor does not over-reach — a non-safety type gets past validation
  ---
  duration_ms: 0.427625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: a run names bedrock or vertex — qwen is retired from backfill, and the refusal says so
ok 115 - a run names bedrock or vertex — qwen is retired from backfill, and the refusal says so
  ---
  duration_ms: 2.017666
  type: 'test'
  ...
# Subtest: the cursor STARTS at day_to and the range is validated
ok 116 - the cursor STARTS at day_to and the range is validated
  ---
  duration_ms: 0.59625
  type: 'test'
  ...
# Subtest: n_per_tick clamps to 1..8 and junk becomes the default, never 0
ok 117 - n_per_tick clamps to 1..8 and junk becomes the default, never 0
  ---
  duration_ms: 0.173666
  type: 'test'
  ...
# Subtest: §4.3.1 — one active run per worker, and it is a typed refusal not a queue
ok 118 - §4.3.1 — one active run per worker, and it is a typed refusal not a queue
  ---
  duration_ms: 0.2025
  type: 'test'
  ...
# Subtest: no active run ⇒ IDLE, which is a normal state and not an error
ok 119 - no active run ⇒ IDLE, which is a normal state and not an error
  ---
  duration_ms: 0.174708
  type: 'test'
  ...
# Subtest: a non-active run is skipped, and a spent cursor reads as done
ok 120 - a non-active run is skipped, and a spent cursor reads as done
  ---
  duration_ms: 0.213584
  type: 'test'
  ...
# Subtest: a run whose cursor was lost resumes at day_to instead of stalling
ok 121 - a run whose cursor was lost resumes at day_to instead of stalling
  ---
  duration_ms: 0.112833
  type: 'test'
  ...
# Subtest: ⚠️ THE CURSOR ONLY MOVES ON A COMPLETE DAY
ok 122 - ⚠️ THE CURSOR ONLY MOVES ON A COMPLETE DAY
  ---
  duration_ms: 0.305959
  type: 'test'
  ...
# Subtest: the run is DONE when the cursor passes below day_from — inclusive at both ends
ok 123 - the run is DONE when the cursor passes below day_from — inclusive at both ends
  ---
  duration_ms: 0.501125
  type: 'test'
  ...
# Subtest: prevDay is UTC date arithmetic — no timezone drift across a month or year boundary
ok 124 - prevDay is UTC date arithmetic — no timezone drift across a month or year boundary
  ---
  duration_ms: 0.642042
  type: 'test'
  ...
# Subtest: a failed NOTE is counted and the run continues; a failed TICK errors the run
ok 125 - a failed NOTE is counted and the run continues; a failed TICK errors the run
  ---
  duration_ms: 0.253459
  type: 'test'
  ...
# Subtest: accounting never poisons a total with NaN, and never runs backwards
ok 126 - accounting never poisons a total with NaN, and never runs backwards
  ---
  duration_ms: 0.256833
  type: 'test'
  ...
# Subtest: an errored run is RESUMABLE — the whole point of erroring rather than stopping
ok 127 - an errored run is RESUMABLE — the whole point of erroring rather than stopping
  ---
  duration_ms: 0.305625
  type: 'test'
  ...
# Subtest: the DDL is the PRD’s, idempotent, with a partial unique index behind the one-run rule
ok 128 - the DDL is the PRD’s, idempotent, with a partial unique index behind the one-run rule
  ---
  duration_ms: 0.917666
  type: 'test'
  ...
# Subtest: run accounting is an in-SQL increment, so overlapping ticks cannot lose counts
ok 129 - run accounting is an in-SQL increment, so overlapping ticks cannot lose counts
  ---
  duration_ms: 0.29525
  type: 'test'
  ...
# Subtest: ⚠️ FILL-ONLY: the skip rule is unchanged, and it is what makes a prod-line label safe
ok 130 - ⚠️ FILL-ONLY: the skip rule is unchanged, and it is what makes a prod-line label safe
  ---
  duration_ms: 2.495625
  type: 'test'
  ...
# Subtest: the row is PROD-LINE and stamped with WHAT SERVED, never MINI_MODEL
ok 131 - the row is PROD-LINE and stamped with WHAT SERVED, never MINI_MODEL
  ---
  duration_ms: 1.367834
  type: 'test'
  ...
# Subtest: scheduling: the night window and the lab-batch yield are gone, the soft lock stays
ok 132 - scheduling: the night window and the lab-batch yield are gone, the soft lock stays
  ---
  duration_ms: 1.818459
  type: 'test'
  ...
# Subtest: reachability is re-checked EVERY tick, for the RUN’S provider, so unsetting a var is a clean rollback
ok 133 - reachability is re-checked EVERY tick, for the RUN’S provider, so unsetting a var is a clean rollback
  ---
  duration_ms: 0.120916
  type: 'test'
  ...
# Subtest: the control endpoint speaks the five actions, on this route
ok 134 - the control endpoint speaks the five actions, on this route
  ---
  duration_ms: 0.106375
  type: 'test'
  ...
# Subtest: a bedrock row is a CLOUD grader and a CANDIDATE model — for EVERY id the transport accepts
ok 135 - a bedrock row is a CLOUD grader and a CANDIDATE model — for EVERY id the transport accepts
  ---
  duration_ms: 0.153125
  type: 'test'
  ...
# Subtest: a bedrock row beats a qwen row, and loses to Gemini at the same version
ok 136 - a bedrock row beats a qwen row, and loses to Gemini at the same version
  ---
  duration_ms: 0.197875
  type: 'test'
  ...
# Subtest: cost_usd is real dollars, and costInr composes from it
ok 137 - cost_usd is real dollars, and costInr composes from it
  ---
  duration_ms: 0.113708
  type: 'test'
  ...
# Subtest: C2: a vertex run is refused unless it names the Gemini this deployment will actually use
ok 138 - C2: a vertex run is refused unless it names the Gemini this deployment will actually use
  ---
  duration_ms: 0.083042
  type: 'test'
  ...
# Subtest: C2: cost accrues on a vertex run through the SAME pricing path as a bedrock one
ok 139 - C2: cost accrues on a vertex run through the SAME pricing path as a bedrock one
  ---
  duration_ms: 0.04675
  type: 'test'
  ...
# Subtest: C4: a STOP issued mid-tick survives the tick’s completion write
ok 140 - C4: a STOP issued mid-tick survives the tick’s completion write
  ---
  duration_ms: 0.289084
  type: 'test'
  ...
# Subtest: C3: pace is weighted by notes, and only this run’s productive ticks count
ok 141 - C3: pace is weighted by notes, and only this run’s productive ticks count
  ---
  duration_ms: 0.095666
  type: 'test'
  ...
# Subtest: C3: the ETA says what it is BASED on, and stays null rather than guessing
ok 142 - C3: the ETA says what it is BASED on, and stays null rather than guessing
  ---
  duration_ms: 0.159167
  type: 'test'
  ...
# Subtest: C3: a stall is 300s of silence on an ACTIVE worker — never on a paused or idle one
ok 143 - C3: a stall is 300s of silence on an ACTIVE worker — never on a paused or idle one
  ---
  duration_ms: 0.069334
  type: 'test'
  ...
# Subtest: C3: the monitor exposes ETA + stall for BOTH arms of the bake-off
ok 144 - C3: the monitor exposes ETA + stall for BOTH arms of the bake-off
  ---
  duration_ms: 0.143459
  type: 'test'
  ...
# Subtest: C1: the batch accepts bedrock, refuses every other provider, and no model ⇒ the mini path
ok 145 - C1: the batch accepts bedrock, refuses every other provider, and no model ⇒ the mini path
  ---
  duration_ms: 0.182875
  type: 'test'
  ...
# Subtest: C1: a bedrock batch is TRACED and verified against that trace — a paid claim must be provable
ok 146 - C1: a bedrock batch is TRACED and verified against that trace — a paid claim must be provable
  ---
  duration_ms: 0.104959
  type: 'test'
  ...
# Subtest: C1: the row carries who SERVED, and that is what makes the paid ceiling count it
ok 147 - C1: the row carries who SERVED, and that is what makes the paid ceiling count it
  ---
  duration_ms: 0.179125
  type: 'test'
  ...
# Subtest: C1: the bedrock arm does not yield to the Mac-mini it never touches
ok 148 - C1: the bedrock arm does not yield to the Mac-mini it never touches
  ---
  duration_ms: 0.08375
  type: 'test'
  ...
# Subtest: C1: the poison-note budget covers the PAID arm, or a bad note retries for ever at a price
ok 149 - C1: the poison-note budget covers the PAID arm, or a bad note retries for ever at a price
  ---
  duration_ms: 0.115916
  type: 'test'
  ...
# Subtest: C1: lab_batch_start writes the model key on EVERY start, so a paid arm cannot leak forward
ok 150 - C1: lab_batch_start writes the model key on EVERY start, so a paid arm cannot leak forward
  ---
  duration_ms: 0.36525
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the five membership cases from the kickoff, exactly
ok 151 - the five membership cases from the kickoff, exactly
  ---
  duration_ms: 1.368125
  type: 'test'
  ...
# Subtest: a future version does not sneak in via its tag either
ok 152 - a future version does not sneak in via its tag either
  ---
  duration_ms: 0.173042
  type: 'test'
  ...
# Subtest: the engine NAME keeps its own hyphens — a naive split on "-" would be wrong
ok 153 - the engine NAME keeps its own hyphens — a naive split on "-" would be wrong
  ---
  duration_ms: 0.228166
  type: 'test'
  ...
# Subtest: stripping takes the FIRST hyphen after the version, however many follow
ok 154 - stripping takes the FIRST hyphen after the version, however many follow
  ---
  duration_ms: 0.115708
  type: 'test'
  ...
# Subtest: an untagged string is returned unchanged, and the helper is total
ok 155 - an untagged string is returned unchanged, and the helper is total
  ---
  duration_ms: 0.245583
  type: 'test'
  ...
# Subtest: EVERY member of the family list is in its own line, tagged or not
ok 156 - EVERY member of the family list is in its own line, tagged or not
  ---
  duration_ms: 0.194666
  type: 'test'
  ...
# Subtest: auditedUidsForDay is UNCHANGED — still the exact-version, unfiltered read (DEC-3)
ok 157 - auditedUidsForDay is UNCHANGED — still the exact-version, unfiltered read (DEC-3)
  ---
  duration_ms: 0.304625
  type: 'test'
  ...
# Subtest: the day filter on the new read is byte-identical to auditedUidsForDay
ok 158 - the day filter on the new read is byte-identical to auditedUidsForDay
  ---
  duration_ms: 0.123625
  type: 'test'
  ...
# Subtest: the new read does NOT swallow its own errors — an empty skip list would re-audit everything
ok 159 - the new read does NOT swallow its own errors — an empty skip list would re-audit everything
  ---
  duration_ms: 0.505292
  type: 'test'
  ...
# Subtest: the four mini-backfill call sites use the line rule; the Gemini worker is untouched
ok 160 - the four mini-backfill call sites use the line rule; the Gemini worker is untouched
  ---
  duration_ms: 1.943792
  type: 'test'
  ...
# Subtest: the work selection and the day-complete decision use the SAME rule
ok 161 - the work selection and the day-complete decision use the SAME rule
  ---
  duration_ms: 0.320833
  type: 'test'
  ...
# Subtest: superset fires: the banned pair plus one extra molecule
ok 162 - superset fires: the banned pair plus one extra molecule
  ---
  duration_ms: 0.836333
  type: 'test'
  ...
# Subtest: subset-missing-one fires: two of a banned three
ok 163 - subset-missing-one fires: two of a banned three
  ---
  duration_ms: 0.101709
  type: 'test'
  ...
# Subtest: an exact match does NOT also near-miss — and neither does the entry it matched
ok 164 - an exact match does NOT also near-miss — and neither does the entry it matched
  ---
  duration_ms: 6.139375
  type: 'test'
  ...
# Subtest: missing TWO molecules is silent (|E| − |S| = 1 only)
ok 165 - missing TWO molecules is silent (|E| − |S| = 1 only)
  ---
  duration_ms: 0.215792
  type: 'test'
  ...
# Subtest: a single-molecule product is silent — |S| ≥ 2, inherited from the exact-match check
ok 166 - a single-molecule product is silent — |S| ≥ 2, inherited from the exact-match check
  ---
  duration_ms: 0.290084
  type: 'test'
  ...
# Subtest: overlap without containment is silent (neither superset nor subset)
ok 167 - overlap without containment is silent (neither superset nor subset)
  ---
  duration_ms: 0.157375
  type: 'test'
  ...
# Subtest: cap: at most 3 near-miss findings per note, in ENTRY order
ok 168 - cap: at most 3 near-miss findings per note, in ENTRY order
  ---
  duration_ms: 0.462041
  type: 'test'
  ...
# Subtest: one finding per ENTRY even when several products near-miss it
ok 169 - one finding per ENTRY even when several products near-miss it
  ---
  duration_ms: 0.120542
  type: 'test'
  ...
# Subtest: malformed / empty tables and meds are silent — never throw (§7 posture, inherited)
ok 170 - malformed / empty tables and meds are silent — never throw (§7 posture, inherited)
  ---
  duration_ms: 0.481625
  type: 'test'
  ...
# Subtest: the finding is non-scoring by construction: informational + confidence 0 + uncertain
ok 171 - the finding is non-scoring by construction: informational + confidence 0 + uncertain
  ---
  duration_ms: 0.654333
  type: 'test'
  ...
# Subtest: signal_type resolves to banned_fdc_near_miss (and does not collide with banned_fdc)
ok 172 - signal_type resolves to banned_fdc_near_miss (and does not collide with banned_fdc)
  ---
  duration_ms: 3.335209
  type: 'test'
  ...
# Subtest: tier resolves to 3 — log only, never an action row (D-3)
ok 173 - tier resolves to 3 — log only, never an action row (D-3)
  ---
  duration_ms: 3.598958
  type: 'test'
  ...
# Subtest: 12.0 — the precedence list is a VOCABULARY, not an implementation
ok 174 - 12.0 — the precedence list is a VOCABULARY, not an implementation
  ---
  duration_ms: 41.192541
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank judge] batch failed 0 - 2 Unexpected token 'h', "this is not"... is not valid JSON
# Subtest: 12.3 — ROW 3: a malformed completion is `parse_failure`
ok 175 - 12.3 — ROW 3: a malformed completion is `parse_failure`
  ---
  duration_ms: 68.474958
  type: 'test'
  ...
# Subtest: 12.4 — ROW 4: missing AND nonnumeric keys give `missing_score_key`, and BOTH counts survive
ok 176 - 12.4 — ROW 4: missing AND nonnumeric keys give `missing_score_key`, and BOTH counts survive
  ---
  duration_ms: 7.136834
  type: 'test'
  ...
# Subtest: 12.5 — ROW 5: finite AND nonnumeric keys give `nonnumeric_score`
ok 177 - 12.5 — ROW 5: finite AND nonnumeric keys give `nonnumeric_score`
  ---
  duration_ms: 2.493
  type: 'test'
  ...
# [rerank judge] batch failed 0 - 2 Request timed out.
# [rerank judge] batch failed 0 - 2 socket hang up
# [rerank judge] batch failed 0 - 2 timed out
# [rerank judge] batch failed 0 - 2 socket hang up
# Subtest: 12.6 — ROW 6: all finite keys give `success`
ok 178 - 12.6 — ROW 6: all finite keys give `success`
  ---
  duration_ms: 1.241333
  type: 'test'
  ...
# Subtest: 12.1 — ROW 1: a REAL SDK TIMEOUT is `timeout`, not terminal_failure
ok 179 - 12.1 — ROW 1: a REAL SDK TIMEOUT is `timeout`, not terminal_failure
  ---
  duration_ms: 0.600375
  type: 'test'
  ...
# Subtest: 12.2 — ROW 2: a generic exhausted transport is `terminal_failure`
ok 180 - 12.2 — ROW 2: a generic exhausted transport is `terminal_failure`
  ---
  duration_ms: 0.237875
  type: 'test'
  ...
# [rerank judge] batch failed 0 - 2 Unexpected token 'h', "this is not"... is not valid JSON
# Subtest: 12.7 — the outcomes the six rows ACTUALLY produced are six distinct committed values
ok 181 - 12.7 — the outcomes the six rows ACTUALLY produced are six distinct committed values
  ---
  duration_ms: 17.407208
  type: 'test'
  ...
# Subtest: ⚠️ THE MINT IS THE IAM CREDENTIALS API, NOT THE JWT-BEARER TOKEN ENDPOINT
ok 182 - ⚠️ THE MINT IS THE IAM CREDENTIALS API, NOT THE JWT-BEARER TOKEN ENDPOINT
  ---
  duration_ms: 0.626292
  type: 'test'
  ...
# Subtest: step 1 is the EXISTING access-token flow, reused rather than duplicated
ok 183 - step 1 is the EXISTING access-token flow, reused rather than duplicated
  ---
  duration_ms: 0.07775
  type: 'test'
  ...
# Subtest: step 2 is :generateIdToken with {audience, includeEmail}, and reads `token`
ok 184 - step 2 is :generateIdToken with {audience, includeEmail}, and reads `token`
  ---
  duration_ms: 0.149958
  type: 'test'
  ...
# Subtest: the failure carries the BODY and both identities — a 403 here is ambiguous without them
ok 185 - the failure carries the BODY and both identities — a 403 here is ambiguous without them
  ---
  duration_ms: 0.047792
  type: 'test'
  ...
# Subtest: cached per audience, 55 minutes of usable life, exp never decoded
ok 186 - cached per audience, 55 minutes of usable life, exp never decoded
  ---
  duration_ms: 0.083333
  type: 'test'
  ...
# Subtest: no log line in the auth chain can print a token, key or credential
ok 187 - no log line in the auth chain can print a token, key or credential
  ---
  duration_ms: 0.202041
  type: 'test'
  ...
# Subtest: the refresh decision: fresh reuses, inside-the-skew re-mints, expired re-mints
ok 188 - the refresh decision: fresh reuses, inside-the-skew re-mints, expired re-mints
  ---
  duration_ms: 0.093958
  type: 'test'
  ...
# Subtest: VERIFICATION 8, without a warm instance: two calls 61 minutes apart cannot share credentials
ok 189 - VERIFICATION 8, without a warm instance: two calls 61 minutes apart cannot share credentials
  ---
  duration_ms: 0.097917
  type: 'test'
  ...
# Subtest: an undatable credential is UNUSABLE — never reused on the benefit of the doubt
ok 190 - an undatable credential is UNUSABLE — never reused on the benefit of the doubt
  ---
  duration_ms: 0.208125
  type: 'test'
  ...
# Subtest: the STS call is the reference’s call: role, session name, 60 minutes, unsigned client
ok 191 - the STS call is the reference’s call: role, session name, 60 minutes, unsigned client
  ---
  duration_ms: 0.283375
  type: 'test'
  ...
# Subtest: bedrockConfigured needs all four vars — and never gates on AWS_REGION
ok 192 - bedrockConfigured needs all four vars — and never gates on AWS_REGION
  ---
  duration_ms: 0.500917
  type: 'test'
  ...
# Subtest: exactly three model ids, and an unlisted one is REFUSED rather than sent
ok 193 - exactly three model ids, and an unlisted one is REFUSED rather than sent
  ---
  duration_ms: 0.272583
  type: 'test'
  ...
# Subtest: OpenAI chat params → Converse: system split out, roles mapped, inferenceConfig built
ok 194 - OpenAI chat params → Converse: system split out, roles mapped, inferenceConfig built
  ---
  duration_ms: 0.179666
  type: 'test'
  ...
# Subtest: consecutive same-role turns MERGE — Converse rejects them and dropping one would edit the prompt
ok 195 - consecutive same-role turns MERGE — Converse rejects them and dropping one would edit the prompt
  ---
  duration_ms: 0.073833
  type: 'test'
  ...
# Subtest: mapping degrades safely on shapes the repo does not send today
ok 196 - mapping degrades safely on shapes the repo does not send today
  ---
  duration_ms: 0.141875
  type: 'test'
  ...
# Subtest: Converse response → the OpenAI shape every consumer in this repo already reads
ok 197 - Converse response → the OpenAI shape every consumer in this repo already reads
  ---
  duration_ms: 0.157875
  type: 'test'
  ...
# Subtest: ⚠️ stopReason → finish_reason is load-bearing: end_turn MUST become stop
ok 198 - ⚠️ stopReason → finish_reason is load-bearing: end_turn MUST become stop
  ---
  duration_ms: 0.043708
  type: 'test'
  ...
# Subtest: usage degrades safely: a missing total is derived, a missing usage is zero (never null cost)
ok 199 - usage degrades safely: a missing total is derived, a missing usage is zero (never null cost)
  ---
  duration_ms: 0.234917
  type: 'test'
  ...
# Subtest: the stream shim satisfies a `for await` caller and carries the usage chunk
ok 200 - the stream shim satisfies a `for await` caller and carries the usage chunk
  ---
  duration_ms: 0.268959
  type: 'test'
  ...
# Subtest: an explicit bedrock target OUTRANKS both cloud tiers and has no ladder behind it
ok 201 - an explicit bedrock target OUTRANKS both cloud tiers and has no ladder behind it
  ---
  duration_ms: 0.372375
  type: 'test'
  ...
# Subtest: ⚠️ the bedrock target reaches BOTH governedChat arms — the traceless one cannot drop it
ok 202 - ⚠️ the bedrock target reaches BOTH governedChat arms — the traceless one cannot drop it
  ---
  duration_ms: 0.15925
  type: 'test'
  ...
# Subtest: the budget reaches the transport, and its default is READ FROM THE TABLE
ok 203 - the budget reaches the transport, and its default is READ FROM THE TABLE
  ---
  duration_ms: 0.221125
  type: 'test'
  ...
# Subtest: the provider_error record names BOTH identities in the chain
ok 204 - the provider_error record names BOTH identities in the chain
  ---
  duration_ms: 0.283
  type: 'test'
  ...
# Subtest: the override gate and the routing map carry bedrock end to end
ok 205 - the override gate and the routing map carry bedrock end to end
  ---
  duration_ms: 0.154541
  type: 'test'
  ...
# Subtest: each model prices at its published global-endpoint rate, and never at a Gemini rate
ok 206 - each model prices at its published global-endpoint rate, and never at a Gemini rate
  ---
  duration_ms: 0.335333
  type: 'test'
  ...
# Subtest: ⚠️ the cost tracker actually SELECTS Bedrock rows — rates alone would have shown ₹0
ok 207 - ⚠️ the cost tracker actually SELECTS Bedrock rows — rates alone would have shown ₹0
  ---
  duration_ms: 0.077375
  type: 'test'
  ...
# Subtest: with no bedrock target the dispatch is the pre-existing one, line for line
ok 208 - with no bedrock target the dispatch is the pre-existing one, line for line
  ---
  duration_ms: 0.501
  type: 'test'
  ...
# Subtest: labRoutingOpts is still {} with no override — the spread stays byte-identical
ok 209 - labRoutingOpts is still {} with no override — the spread stays byte-identical
  ---
  duration_ms: 0.1
  type: 'test'
  ...
# Subtest: mini_analyze refuses a provider its seam cannot serve, instead of stamping the row anyway
ok 210 - mini_analyze refuses a provider its seam cannot serve, instead of stamping the row anyway
  ---
  duration_ms: 0.503417
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: default BM25 SQL is byte-identical to the shipped plainto-AND leg
ok 211 - default BM25 SQL is byte-identical to the shipped plainto-AND leg
  ---
  duration_ms: 0.464541
  type: 'test'
  ...
# Subtest: discriminating selection drops common terms (DF > dfMax) and OR-joins the rare ones
ok 212 - discriminating selection drops common terms (DF > dfMax) and OR-joins the rare ones
  ---
  duration_ms: 0.415917
  type: 'test'
  ...
# Subtest: parseTsqueryLexemes extracts bare lexemes from a plainto ::text
ok 213 - parseTsqueryLexemes extracts bare lexemes from a plainto ::text
  ---
  duration_ms: 0.191708
  type: 'test'
  ...
# Subtest: discriminating BM25 SQL always caps the candidate set before ranking
ok 214 - discriminating BM25 SQL always caps the candidate set before ranking
  ---
  duration_ms: 0.074916
  type: 'test'
  ...
# Subtest: only-common-terms yields no discriminating lexemes ⇒ empty tsquery ⇒ BM25 leg is skipped
ok 215 - only-common-terms yields no discriminating lexemes ⇒ empty tsquery ⇒ BM25 leg is skipped
  ---
  duration_ms: 0.117042
  type: 'test'
  ...
# Subtest: the DF-estimate SQL is the bounded planner EXPLAIN, never a COUNT over the corpus
ok 216 - the DF-estimate SQL is the bounded planner EXPLAIN, never a COUNT over the corpus
  ---
  duration_ms: 0.087834
  type: 'test'
  ...
# Subtest: buildAskSet: high-alert med first
ok 217 - buildAskSet: high-alert med first
  ---
  duration_ms: 1.186667
  type: 'test'
  ...
# Subtest: buildAskSet: med cap 3 (4th med → overflow)
ok 218 - buildAskSet: med cap 3 (4th med → overflow)
  ---
  duration_ms: 0.146292
  type: 'test'
  ...
# Subtest: buildAskSet: overall cap 5, rest overflow
ok 219 - buildAskSet: overall cap 5, rest overflow
  ---
  duration_ms: 0.156333
  type: 'test'
  ...
# Subtest: buildAskSet: follow-up keyword extraction (advice "repeat")
ok 220 - buildAskSet: follow-up keyword extraction (advice "repeat")
  ---
  duration_ms: 0.168625
  type: 'test'
  ...
# Subtest: buildAskSet: no follow-up when no keyword and no followUpType
ok 221 - buildAskSet: no follow-up when no keyword and no followUpType
  ---
  duration_ms: 0.108791
  type: 'test'
  ...
# Subtest: buildAskSet: followUpType real + no date → follow-up ask
ok 222 - buildAskSet: followUpType real + no date → follow-up ask
  ---
  duration_ms: 0.068375
  type: 'test'
  ...
# Subtest: buildAskSet: complaint cap 2
ok 223 - buildAskSet: complaint cap 2
  ---
  duration_ms: 0.100125
  type: 'test'
  ...
# Subtest: buildAskSet: allergy only when the note field is blank
ok 224 - buildAskSet: allergy only when the note field is blank
  ---
  duration_ms: 0.137875
  type: 'test'
  ...
# Subtest: buildAskSet: outside-records is generated last if room
ok 225 - buildAskSet: outside-records is generated last if room
  ---
  duration_ms: 0.194958
  type: 'test'
  ...
# Subtest: buildAskSet: empty-ish case → just the outside-records ask
ok 226 - buildAskSet: empty-ish case → just the outside-records ask
  ---
  duration_ms: 0.271208
  type: 'test'
  ...
# Subtest: buildAskSet: deterministic ask ids + deep-equal on re-run
ok 227 - buildAskSet: deterministic ask ids + deep-equal on re-run
  ---
  duration_ms: 0.404417
  type: 'test'
  ...
# Subtest: deriveAssertions: med chips → statuses; stopped carries reason; parse generic/brand
ok 228 - deriveAssertions: med chips → statuses; stopped carries reason; parse generic/brand
  ---
  duration_ms: 0.208334
  type: 'test'
  ...
# Subtest: deriveAssertions: skip produces NO assertion
ok 229 - deriveAssertions: skip produces NO assertion
  ---
  duration_ms: 0.039666
  type: 'test'
  ...
# Subtest: deriveAssertions: complaint + follow-up + allergy chips
ok 230 - deriveAssertions: complaint + follow-up + allergy chips
  ---
  duration_ms: 0.115833
  type: 'test'
  ...
# Subtest: deriveAssertions: reported_allergy carries the free-text substance
ok 231 - deriveAssertions: reported_allergy carries the free-text substance
  ---
  duration_ms: 0.331875
  type: 'test'
  ...
# Subtest: deriveAssertions: every derived assertion carries valid clinical-state/1.2 patient-reported Provenance
ok 232 - deriveAssertions: every derived assertion carries valid clinical-state/1.2 patient-reported Provenance
  ---
  duration_ms: 0.051125
  type: 'test'
  ...
# Subtest: deriveAssertions: deterministic (twice → deep-equal)
ok 233 - deriveAssertions: deterministic (twice → deep-equal)
  ---
  duration_ms: 0.125083
  type: 'test'
  ...
# Subtest: escalationFlag: complaint worse → symptom_worse
ok 234 - escalationFlag: complaint worse → symptom_worse
  ---
  duration_ms: 0.057958
  type: 'test'
  ...
# Subtest: escalationFlag: high-alert med stopped → high_alert_med_stopped
ok 235 - escalationFlag: high-alert med stopped → high_alert_med_stopped
  ---
  duration_ms: 0.033958
  type: 'test'
  ...
# Subtest: escalationFlag: non-high-alert stopped → null
ok 236 - escalationFlag: non-high-alert stopped → null
  ---
  duration_ms: 0.0295
  type: 'test'
  ...
# Subtest: escalationFlag: not_taking high-alert → escalation
ok 237 - escalationFlag: not_taking high-alert → escalation
  ---
  duration_ms: 0.029542
  type: 'test'
  ...
# Subtest: validateOutcome: illegal disposition · foreign askId · legal partial
ok 238 - validateOutcome: illegal disposition · foreign askId · legal partial
  ---
  duration_ms: 0.080542
  type: 'test'
  ...
# Subtest: validateOutcome: illegal enum answer rejected
ok 239 - validateOutcome: illegal enum answer rejected
  ---
  duration_ms: 0.032292
  type: 'test'
  ...
# Subtest: version constants
ok 240 - version constants
  ---
  duration_ms: 0.031125
  type: 'test'
  ...
# Subtest: trackFromReasonType maps reasons + type precedence
ok 241 - trackFromReasonType maps reasons + type precedence
  ---
  duration_ms: 0.520792
  type: 'test'
  ...
# Subtest: healthFormsSql is injection-safe and targets the right table/key
ok 242 - healthFormsSql is injection-safe and targets the right table/key
  ---
  duration_ms: 0.258667
  type: 'test'
  ...
# Subtest: parseStrArray handles JS arrays, JSON text, and Postgres {a,b} text
ok 243 - parseStrArray handles JS arrays, JSON text, and Postgres {a,b} text
  ---
  duration_ms: 0.39025
  type: 'test'
  ...
# Subtest: parseFollowups normalizes booked/completed from real jsonb shape
ok 244 - parseFollowups normalizes booked/completed from real jsonb shape
  ---
  duration_ms: 0.212083
  type: 'test'
  ...
# Subtest: parseFollowups dedupes repeated orders (best status wins)
ok 245 - parseFollowups dedupes repeated orders (best status wins)
  ---
  duration_ms: 0.111333
  type: 'test'
  ...
# Subtest: parseNextFollowup handles date object, reason object, and bare string
ok 246 - parseNextFollowup handles date object, reason object, and bare string
  ---
  duration_ms: 0.122875
  type: 'test'
  ...
# Subtest: posthosp: "not required" reason → next-followup met, not garbage
ok 247 - posthosp: "not required" reason → next-followup met, not garbage
  ---
  duration_ms: 0.266584
  type: 'test'
  ...
# Subtest: autoTrack reads the most recent form (rows DESC)
ok 248 - autoTrack reads the most recent form (rows DESC)
  ---
  duration_ms: 0.088125
  type: 'test'
  ...
# Subtest: fever: context + expectations (day ≥5, danger sign, disposition gap)
ok 249 - fever: context + expectations (day ≥5, danger sign, disposition gap)
  ---
  duration_ms: 0.356083
  type: 'test'
  ...
# Subtest: fever recovered → mostly met
ok 250 - fever recovered → mostly met
  ---
  duration_ms: 0.344416
  type: 'test'
  ...
# Subtest: posthosp: unbooked items → gap; next follow-up met
ok 251 - posthosp: unbooked items → gap; next follow-up met
  ---
  duration_ms: 0.102083
  type: 'test'
  ...
# Subtest: aihs: HbA1c recency drives the marker expectation
ok 252 - aihs: HbA1c recency drives the marker expectation
  ---
  duration_ms: 0.129791
  type: 'test'
  ...
# Subtest: registry has the three deep tracks
ok 253 - registry has the three deep tracks
  ---
  duration_ms: 0.038666
  type: 'test'
  ...
# Subtest: extractJson strips code fences and parses
ok 254 - extractJson strips code fences and parses
  ---
  duration_ms: 0.987792
  type: 'test'
  ...
# Subtest: normalizeFinding ENFORCES cite-or-label: corpus_cited without citations is downgraded
ok 255 - normalizeFinding ENFORCES cite-or-label: corpus_cited without citations is downgraded
  ---
  duration_ms: 0.201667
  type: 'test'
  ...
# Subtest: parseClinical clamps citation ids to [1..max] and de-dupes finding ids
ok 256 - parseClinical clamps citation ids to [1..max] and de-dupes finding ids
  ---
  duration_ms: 0.13825
  type: 'test'
  ...
# Subtest: pitchGate opens ONLY on a specific, cited, high-confidence surgical_indication
ok 257 - pitchGate opens ONLY on a specific, cited, high-confidence surgical_indication
  ---
  duration_ms: 0.913792
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT for an uncited surgical indication
ok 258 - pitchGate stays SHUT for an uncited surgical indication
  ---
  duration_ms: 0.108667
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT for a cited NON-surgical finding
ok 259 - pitchGate stays SHUT for a cited NON-surgical finding
  ---
  duration_ms: 0.100625
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT with no findings
ok 260 - pitchGate stays SHUT with no findings
  ---
  duration_ms: 0.040875
  type: 'test'
  ...
# Subtest: pitchGate stays SHUT on generic/conditional textbook "indications" (the ~80% false positives)
ok 261 - pitchGate stays SHUT on generic/conditional textbook "indications" (the ~80% false positives)
  ---
  duration_ms: 0.636375
  type: 'test'
  ...
# Subtest: isSpecificSurgicalIndication accepts an assertive member-specific indication
ok 262 - isSpecificSurgicalIndication accepts an assertive member-specific indication
  ---
  duration_ms: 0.336667
  type: 'test'
  ...
# Subtest: the tightened patterns catch the residual generics seen in the backtest
ok 263 - the tightened patterns catch the residual generics seen in the backtest
  ---
  duration_ms: 0.292125
  type: 'test'
  ...
# Subtest: pitchGate enforces the confidence floor
ok 264 - pitchGate enforces the confidence floor
  ---
  duration_ms: 0.06125
  type: 'test'
  ...
# Subtest: pitchGate opts reproduce the OLD (pre-calibration) gate for the backtest
ok 265 - pitchGate opts reproduce the OLD (pre-calibration) gate for the backtest
  ---
  duration_ms: 0.045166
  type: 'test'
  ...
# Subtest: buildCommercial: walled-off when not allowed; default priority follows referral
ok 266 - buildCommercial: walled-off when not allowed; default priority follows referral
  ---
  duration_ms: 0.122042
  type: 'test'
  ...
# Subtest: groundingSummary counts by grounding and distinct cited sources
ok 267 - groundingSummary counts by grounding and distinct cited sources
  ---
  duration_ms: 0.086334
  type: 'test'
  ...
# Subtest: parseCommercial defaults priority to med and coerces script
ok 268 - parseCommercial defaults priority to med and coerces script
  ---
  duration_ms: 0.062291
  type: 'test'
  ...
# Subtest: parseExtractedReport keeps clinical content only
ok 269 - parseExtractedReport keeps clinical content only
  ---
  duration_ms: 0.172584
  type: 'test'
  ...
# Subtest: composeEpisodeText is de-identified and notes order-only coverage
ok 270 - composeEpisodeText is de-identified and notes order-only coverage
  ---
  duration_ms: 0.17975
  type: 'test'
  ...
# Subtest: retrievalQuery surfaces the clinical content
ok 271 - retrievalQuery surfaces the clinical content
  ---
  duration_ms: 0.087875
  type: 'test'
  ...
# Subtest: assembleEnvelope carries member_ref for join-back + the disclaimer
ok 272 - assembleEnvelope carries member_ref for join-back + the disclaimer
  ---
  duration_ms: 1.306208
  type: 'test'
  ...
# Subtest: isSnapshotFresh: just inside the TTL is fresh
ok 273 - isSnapshotFresh: just inside the TTL is fresh
  ---
  duration_ms: 0.565
  type: 'test'
  ...
# Subtest: isSnapshotFresh: exactly at the TTL is NOT fresh (strict <)
ok 274 - isSnapshotFresh: exactly at the TTL is NOT fresh (strict <)
  ---
  duration_ms: 0.061125
  type: 'test'
  ...
# Subtest: isSnapshotFresh: just outside the TTL is stale
ok 275 - isSnapshotFresh: just outside the TTL is stale
  ---
  duration_ms: 0.042292
  type: 'test'
  ...
# Subtest: isSnapshotFresh: zero age is fresh
ok 276 - isSnapshotFresh: zero age is fresh
  ---
  duration_ms: 0.039917
  type: 'test'
  ...
# Subtest: isSnapshotFresh: negative age (clock skew, refreshed in the future) is fresh
ok 277 - isSnapshotFresh: negative age (clock skew, refreshed in the future) is fresh
  ---
  duration_ms: 0.040958
  type: 'test'
  ...
# Subtest: isSnapshotFresh: a non-positive TTL means never fresh, not unbounded
ok 278 - isSnapshotFresh: a non-positive TTL means never fresh, not unbounded
  ---
  duration_ms: 0.034291
  type: 'test'
  ...
# Subtest: isSnapshotFresh: non-finite inputs are never fresh
ok 279 - isSnapshotFresh: non-finite inputs are never fresh
  ---
  duration_ms: 0.094417
  type: 'test'
  ...
# Subtest: isSnapshotFresh: a sub-hour TTL still works
ok 280 - isSnapshotFresh: a sub-hour TTL still works
  ---
  duration_ms: 0.042833
  type: 'test'
  ...
# Subtest: snapshotTtlHours: parses a valid value
ok 281 - snapshotTtlHours: parses a valid value
  ---
  duration_ms: 0.157375
  type: 'test'
  ...
# Subtest: snapshotTtlHours: unset / junk / non-positive fall back to the default
ok 282 - snapshotTtlHours: unset / junk / non-positive fall back to the default
  ---
  duration_ms: 0.327208
  type: 'test'
  ...
# Subtest: snapshotTtlHours default is 24
ok 283 - snapshotTtlHours default is 24
  ---
  duration_ms: 0.0515
  type: 'test'
  ...
# Subtest: toEpochMs accepts Date, ISO string, and epoch number
ok 284 - toEpochMs accepts Date, ISO string, and epoch number
  ---
  duration_ms: 1.156375
  type: 'test'
  ...
# Subtest: toEpochMs rejects everything else
ok 285 - toEpochMs rejects everything else
  ---
  duration_ms: 0.180292
  type: 'test'
  ...
# Subtest: mapSnapshotRow maps a jsonb object row
ok 286 - mapSnapshotRow maps a jsonb object row
  ---
  duration_ms: 0.476792
  type: 'test'
  ...
# Subtest: mapSnapshotRow maps a row whose snapshot arrived as a JSON string
ok 287 - mapSnapshotRow maps a row whose snapshot arrived as a JSON string
  ---
  duration_ms: 0.49025
  type: 'test'
  ...
# Subtest: mapSnapshotRow returns null for a missing row (cache miss)
ok 288 - mapSnapshotRow returns null for a missing row (cache miss)
  ---
  duration_ms: 0.177959
  type: 'test'
  ...
# Subtest: mapSnapshotRow returns null for an unparseable or non-object snapshot
ok 289 - mapSnapshotRow returns null for an unparseable or non-object snapshot
  ---
  duration_ms: 0.160667
  type: 'test'
  ...
# Subtest: mapSnapshotRow returns null when refreshed_at is unreadable
ok 290 - mapSnapshotRow returns null when refreshed_at is unreadable
  ---
  duration_ms: 0.108083
  type: 'test'
  ...
# Subtest: mapSnapshotRow never throws on hostile input
ok 291 - mapSnapshotRow never throws on hostile input
  ---
  duration_ms: 0.175625
  type: 'test'
  ...
# Subtest: SNAPSHOT_SCHEMA_VERSION is 2 (v1 = P1 rows, unstamped)
ok 292 - SNAPSHOT_SCHEMA_VERSION is 2 (v1 = P1 rows, unstamped)
  ---
  duration_ms: 0.072917
  type: 'test'
  ...
# Subtest: a P1 bundle (no _schemaVersion) is a MISS, so the enriched timeline appears without waiting out the TTL
ok 293 - a P1 bundle (no _schemaVersion) is a MISS, so the enriched timeline appears without waiting out the TTL
  ---
  duration_ms: 0.09075
  type: 'test'
  ...
# Subtest: a bundle stamped with any other version is a MISS (older or newer)
ok 294 - a bundle stamped with any other version is a MISS (older or newer)
  ---
  duration_ms: 0.123166
  type: 'test'
  ...
# Subtest: a correctly stamped bundle is servable, and the stamp rides along harmlessly
ok 295 - a correctly stamped bundle is servable, and the stamp rides along harmlessly
  ---
  duration_ms: 0.086875
  type: 'test'
  ...
# Subtest: the version guard also applies to a snapshot that arrived as a JSON string
ok 296 - the version guard also applies to a snapshot that arrived as a JSON string
  ---
  duration_ms: 0.103125
  type: 'test'
  ...
# Subtest: docSha is deterministic
ok 297 - docSha is deterministic
  ---
  duration_ms: 0.163625
  type: 'test'
  ...
# Subtest: docSha diverges for different URLs
ok 298 - docSha diverges for different URLs
  ---
  duration_ms: 0.119
  type: 'test'
  ...
# Subtest: docSha is 64 lowercase hex chars
ok 299 - docSha is 64 lowercase hex chars
  ---
  duration_ms: 0.198417
  type: 'test'
  ...
# Subtest: docSha matches the known SHA-256 of a fixed string
ok 300 - docSha matches the known SHA-256 of a fixed string
  ---
  duration_ms: 0.22175
  type: 'test'
  ...
# Subtest: docSha does NOT normalise — a byte of difference is a different document
ok 301 - docSha does NOT normalise — a byte of difference is a different document
  ---
  duration_ms: 0.157
  type: 'test'
  ...
# Subtest: docSha handles the empty string and unicode without throwing
ok 302 - docSha handles the empty string and unicode without throwing
  ---
  duration_ms: 0.136209
  type: 'test'
  ...
# Subtest: builders target the right tables and validate ids
ok 303 - builders target the right tables and validate ids
  ---
  duration_ms: 0.752834
  type: 'test'
  ...
# Subtest: builders reject junk ids (injection guard)
ok 304 - builders reject junk ids (injection guard)
  ---
  duration_ms: 0.156125
  type: 'test'
  ...
# Subtest: parseSpeciality pulls the trailing parens; prettyPrescriptionType humanizes
ok 305 - parseSpeciality pulls the trailing parens; prettyPrescriptionType humanizes
  ---
  duration_ms: 0.1535
  type: 'test'
  ...
# Subtest: mapEpisodeRow validates + coerces
ok 306 - mapEpisodeRow validates + coerces
  ---
  duration_ms: 0.075583
  type: 'test'
  ...
# Subtest: parseDiagnosisNames extracts readable names from the dpipe JSON array
ok 307 - parseDiagnosisNames extracts readable names from the dpipe JSON array
  ---
  duration_ms: 0.437666
  type: 'test'
  ...
# Subtest: cleanComplaint collapses whitespace and truncates
ok 308 - cleanComplaint collapses whitespace and truncates
  ---
  duration_ms: 0.09275
  type: 'test'
  ...
# Subtest: opdTimeline folds clean complaint + parsed dx names into the subtitle (no raw JSON leak)
ok 309 - opdTimeline folds clean complaint + parsed dx names into the subtitle (no raw JSON leak)
  ---
  duration_ms: 0.15525
  type: 'test'
  ...
# Subtest: reportTimeline falls back to a generic label and appends vendor
ok 310 - reportTimeline falls back to a generic label and appends vendor
  ---
  duration_ms: 0.081708
  type: 'test'
  ...
# Subtest: ipdTimeline computes LOS and labels discharge vs admission
ok 311 - ipdTimeline computes LOS and labels discharge vs admission
  ---
  duration_ms: 0.273417
  type: 'test'
  ...
# Subtest: mergeTimeline sorts newest-first and sinks undated rows
ok 312 - mergeTimeline sorts newest-first and sinks undated rows
  ---
  duration_ms: 6.687458
  type: 'test'
  ...
# Subtest: computeSnapshot counts + lastContact + medsLastVisit
ok 313 - computeSnapshot counts + lastContact + medsLastVisit
  ---
  duration_ms: 0.113584
  type: 'test'
  ...
# Subtest: buildMember shapes identity + age + allergies
ok 314 - buildMember shapes identity + age + allergies
  ---
  duration_ms: 0.144875
  type: 'test'
  ...
# Subtest: prescription comes first and is labelled "Encounter note"
ok 315 - prescription comes first and is labelled "Encounter note"
  ---
  duration_ms: 0.663042
  type: 'test'
  ...
# Subtest: reports keep bundle order after the prescription
ok 316 - reports keep bundle order after the prescription
  ---
  duration_ms: 1.59075
  type: 'test'
  ...
# Subtest: labels derive from kind + IST day
ok 317 - labels derive from kind + IST day
  ---
  duration_ms: 0.273375
  type: 'test'
  ...
# Subtest: an unknown report kind falls back to a generic label, never blank
ok 318 - an unknown report kind falls back to a generic label, never blank
  ---
  duration_ms: 0.182292
  type: 'test'
  ...
# Subtest: an unparseable date yields no date suffix rather than a broken label
ok 319 - an unparseable date yields no date suffix rather than a broken label
  ---
  duration_ms: 0.402084
  type: 'test'
  ...
# Subtest: documents with no url are dropped — there is nothing to frame
ok 320 - documents with no url are dropped — there is nothing to frame
  ---
  duration_ms: 0.096875
  type: 'test'
  ...
# Subtest: an order-only episode (no prescription pdf, no reports) yields an empty list
ok 321 - an order-only episode (no prescription pdf, no reports) yields an empty list
  ---
  duration_ms: 0.102
  type: 'test'
  ...
# Subtest: duplicate urls collapse to the first occurrence
ok 322 - duplicate urls collapse to the first occurrence
  ---
  duration_ms: 0.068959
  type: 'test'
  ...
# Subtest: processedUrl is present in the shape and null today (ReportDoc carries no such column)
ok 323 - processedUrl is present in the shape and null today (ReportDoc carries no such column)
  ---
  duration_ms: 0.196834
  type: 'test'
  ...
# Subtest: a null / undefined / malformed bundle yields [] and never throws
ok 324 - a null / undefined / malformed bundle yields [] and never throws
  ---
  duration_ms: 0.739333
  type: 'test'
  ...
# Subtest: validators accept real ids/days and reject junk
ok 325 - validators accept real ids/days and reject junk
  ---
  duration_ms: 1.305375
  type: 'test'
  ...
# Subtest: dayOf truncates a timestamp to the IST calendar day; bad input throws
ok 326 - dayOf truncates a timestamp to the IST calendar day; bad input throws
  ---
  duration_ms: 0.399
  type: 'test'
  ...
# Subtest: bundleWindow is asymmetric (reports land after the visit) and crosses month boundaries
ok 327 - bundleWindow is asymmetric (reports land after the visit) and crosses month boundaries
  ---
  duration_ms: 2.086208
  type: 'test'
  ...
# Subtest: SQL builders target the right tables/keys and embed only validated values
ok 328 - SQL builders target the right tables/keys and embed only validated values
  ---
  duration_ms: 0.551667
  type: 'test'
  ...
# Subtest: SQL builders refuse injection (throw, never interpolate)
ok 329 - SQL builders refuse injection (throw, never interpolate)
  ---
  duration_ms: 0.2715
  type: 'test'
  ...
# Subtest: specialityFromLabel parses the trailing-parens speciality
ok 330 - specialityFromLabel parses the trailing-parens speciality
  ---
  duration_ms: 0.28275
  type: 'test'
  ...
# Subtest: mapPrescription extracts keys + coerces array/json fields
ok 331 - mapPrescription extracts keys + coerces array/json fields
  ---
  duration_ms: 0.563833
  type: 'test'
  ...
# Subtest: mapPrescription prefers the clean CleanCase content when supplied
ok 332 - mapPrescription prefers the clean CleanCase content when supplied
  ---
  duration_ms: 0.192417
  type: 'test'
  ...
# Subtest: mapReports filters null urls; episodeCoverage flips on PDF presence
ok 333 - mapReports filters null urls; episodeCoverage flips on PDF presence
  ---
  duration_ms: 0.546
  type: 'test'
  ...
# Subtest: buildBundle assembles + sets coverage
ok 334 - buildBundle assembles + sets coverage
  ---
  duration_ms: 0.747
  type: 'test'
  ...
# Subtest: member ID (12 digits) routes to member-id + phone probes, not name
ok 335 - member ID (12 digits) routes to member-id + phone probes, not name
  ---
  duration_ms: 0.699792
  type: 'test'
  ...
# Subtest: individual UID (Firestore doc id) routes to a uid probe, not name/phone
ok 336 - individual UID (Firestore doc id) routes to a uid probe, not name/phone
  ---
  duration_ms: 0.165917
  type: 'test'
  ...
# Subtest: 10-digit phone and +91/spaced variants all normalize to +91XXXXXXXXXX
ok 337 - 10-digit phone and +91/spaced variants all normalize to +91XXXXXXXXXX
  ---
  duration_ms: 0.124542
  type: 'test'
  ...
# Subtest: UHID routes to a uhid probe
ok 338 - UHID routes to a uhid probe
  ---
  duration_ms: 0.045667
  type: 'test'
  ...
# Subtest: a name phrase routes to name tokens (and not to a uid probe)
ok 339 - a name phrase routes to name tokens (and not to a uid probe)
  ---
  duration_ms: 0.425333
  type: 'test'
  ...
# Subtest: a single plain word is a name, not an id
ok 340 - a single plain word is a name, not an id
  ---
  duration_ms: 0.054375
  type: 'test'
  ...
# Subtest: too-short / empty queries yield no probe
ok 341 - too-short / empty queries yield no probe
  ---
  duration_ms: 0.102708
  type: 'test'
  ...
# Subtest: name builder can not break out of its string literal (quotes balanced, no statement break)
ok 342 - name builder can not break out of its string literal (quotes balanced, no statement break)
  ---
  duration_ms: 0.126167
  type: 'test'
  ...
# Subtest: sanitizeNameToken removes metacharacters but keeps real names
ok 343 - sanitizeNameToken removes metacharacters but keeps real names
  ---
  duration_ms: 0.188625
  type: 'test'
  ...
# Subtest: id/phone builders reject junk and embed only validated values
ok 344 - id/phone builders reject junk and embed only validated values
  ---
  duration_ms: 0.453042
  type: 'test'
  ...
# Subtest: individualsByUidsSql batches identity by uid and validates
ok 345 - individualsByUidsSql batches identity by uid and validates
  ---
  duration_ms: 0.080667
  type: 'test'
  ...
# Subtest: episodes builder targets prescriptions with validated uids + types
ok 346 - episodes builder targets prescriptions with validated uids + types
  ---
  duration_ms: 0.133875
  type: 'test'
  ...
# Subtest: computeAge / fullName behave
ok 347 - computeAge / fullName behave
  ---
  duration_ms: 0.115125
  type: 'test'
  ...
# Subtest: buildHits groups episodes, ranks has-episodes first, and picks the latest
ok 348 - buildHits groups episodes, ranks has-episodes first, and picks the latest
  ---
  duration_ms: 0.16625
  type: 'test'
  ...
# Subtest: mapIndividualRow validates the uid and coerces arrays
ok 349 - mapIndividualRow validates the uid and coerces arrays
  ---
  duration_ms: 0.073416
  type: 'test'
  ...
# Subtest: every builder rejects a junk individual_uid
ok 350 - every builder rejects a junk individual_uid
  ---
  duration_ms: 0.846958
  type: 'test'
  ...
# Subtest: the kx order builder rejects a junk uhid
ok 351 - the kx order builder rejects a junk uhid
  ---
  duration_ms: 0.157708
  type: 'test'
  ...
# Subtest: no builder ever emits a quote from a rejected id (nothing interpolates before validation)
ok 352 - no builder ever emits a quote from a rejected id (nothing interpolates before validation)
  ---
  duration_ms: 0.099083
  type: 'test'
  ...
# Subtest: kx order builders key on uhid — NOT individual_uid — and hit the right table
ok 353 - kx order builders key on uhid — NOT individual_uid — and hit the right table
  ---
  duration_ms: 0.115875
  type: 'test'
  ...
# Subtest: the radiology order builder selects body_part + laterality; the lab one does not
ok 354 - the radiology order builder selects body_part + laterality; the lab one does not
  ---
  duration_ms: 0.098208
  type: 'test'
  ...
# Subtest: surgery keys on individual_uid; hcu keys on _parent_id; ip_events keys on individual_uid
ok 355 - surgery keys on individual_uid; hcu keys on _parent_id; ip_events keys on individual_uid
  ---
  duration_ms: 0.044125
  type: 'test'
  ...
# Subtest: hyphenated table names are double-quoted
ok 356 - hyphenated table names are double-quoted
  ---
  duration_ms: 0.086958
  type: 'test'
  ...
# Subtest: every builder renders its date to the IST calendar day
ok 357 - every builder renders its date to the IST calendar day
  ---
  duration_ms: 0.050708
  type: 'test'
  ...
# Subtest: _create_time is cast to timestamptz before the timezone shift (column may be text)
ok 358 - _create_time is cast to timestamptz before the timezone shift (column may be text)
  ---
  duration_ms: 0.184208
  type: 'test'
  ...
# Subtest: every builder caps its result set, and the cap is clamped
ok 359 - every builder caps its result set, and the cap is clamped
  ---
  duration_ms: 0.272
  type: 'test'
  ...
# Subtest: hcu selects all three url columns so the mapper can coalesce them
ok 360 - hcu selects all three url columns so the mapper can coalesce them
  ---
  duration_ms: 0.046584
  type: 'test'
  ...
# Subtest: ip_events selects only the verified column (no guessed label column)
ok 361 - ip_events selects only the verified column (no guessed label column)
  ---
  duration_ms: 0.039292
  type: 'test'
  ...
# Subtest: kxOrderTimeline shapes a lab order
ok 362 - kxOrderTimeline shapes a lab order
  ---
  duration_ms: 0.107125
  type: 'test'
  ...
# Subtest: kxOrderTimeline folds body_part + laterality into a radiology order
ok 363 - kxOrderTimeline folds body_part + laterality into a radiology order
  ---
  duration_ms: 0.0415
  type: 'test'
  ...
# Subtest: kxOrderTimeline tolerates every field being null
ok 364 - kxOrderTimeline tolerates every field being null
  ---
  duration_ms: 0.036042
  type: 'test'
  ...
# Subtest: furthestSurgeryStage prefers ot > clinical > status
ok 365 - furthestSurgeryStage prefers ot > clinical > status
  ---
  duration_ms: 0.084708
  type: 'test'
  ...
# Subtest: surgeryTimeline titles from procedure_name and subtitles the furthest stage
ok 366 - surgeryTimeline titles from procedure_name and subtitles the furthest stage
  ---
  duration_ms: 0.065542
  type: 'test'
  ...
# Subtest: surgeryTimeline falls back to a generic title when procedure_name is missing
ok 367 - surgeryTimeline falls back to a generic title when procedure_name is missing
  ---
  duration_ms: 0.034
  type: 'test'
  ...
# Subtest: hcuDocUrl coalesces processed → consolidated → report
ok 368 - hcuDocUrl coalesces processed → consolidated → report
  ---
  duration_ms: 0.044958
  type: 'test'
  ...
# Subtest: hcuTimeline attaches docUrl when a report exists, and OMITS the key when it does not
ok 369 - hcuTimeline attaches docUrl when a report exists, and OMITS the key when it does not
  ---
  duration_ms: 0.066542
  type: 'test'
  ...
# Subtest: ipEventTimeline titles generically when no label column was selected
ok 370 - ipEventTimeline titles generically when no label column was selected
  ---
  duration_ms: 0.047167
  type: 'test'
  ...
# Subtest: ipEventTimeline uses a label opportunistically if one ever appears in the row
ok 371 - ipEventTimeline uses a label opportunistically if one ever appears in the row
  ---
  duration_ms: 0.033084
  type: 'test'
  ...
# Subtest: every mapper returns [] for empty input and never throws
ok 372 - every mapper returns [] for empty input and never throws
  ---
  duration_ms: 0.311792
  type: 'test'
  ...
# Subtest: flaggedListSql keeps every normative fragment of the page query
ok 373 - flaggedListSql keeps every normative fragment of the page query
  ---
  duration_ms: 1.281083
  type: 'test'
  ...
# Subtest: flaggedListSql preserves both ORDER BY clauses exactly
ok 374 - flaggedListSql preserves both ORDER BY clauses exactly
  ---
  duration_ms: 0.153375
  type: 'test'
  ...
# Subtest: flaggedListSql mirrors the jsonb_typeof guards on both coalesce branches
ok 375 - flaggedListSql mirrors the jsonb_typeof guards on both coalesce branches
  ---
  duration_ms: 0.238334
  type: 'test'
  ...
# Subtest: flaggedListSql takes the engine version as $1 and never interpolates it
ok 376 - flaggedListSql takes the engine version as $1 and never interpolates it
  ---
  duration_ms: 0.069083
  type: 'test'
  ...
# Subtest: flaggedListSql is a constant — no argument can change the text
ok 377 - flaggedListSql is a constant — no argument can change the text
  ---
  duration_ms: 0.048834
  type: 'test'
  ...
# Subtest: pickSignal: a gated_on claim beats the surgical_indication fallback
ok 378 - pickSignal: a gated_on claim beats the surgical_indication fallback
  ---
  duration_ms: 0.096
  type: 'test'
  ...
# Subtest: pickSignal: falls back to surgical_indication when nothing is gated
ok 379 - pickSignal: falls back to surgical_indication when nothing is gated
  ---
  duration_ms: 0.113625
  type: 'test'
  ...
# Subtest: pickSignal: falls back to speciality when no surgical_indication exists
ok 380 - pickSignal: falls back to speciality when no surgical_indication exists
  ---
  duration_ms: 0.046875
  type: 'test'
  ...
# Subtest: pickSignal: gated_on picks the FIRST matching finding in array order
ok 381 - pickSignal: gated_on picks the FIRST matching finding in array order
  ---
  duration_ms: 0.186291
  type: 'test'
  ...
# Subtest: pickSignal: a gated hit with a null claim coalesces to branch 2, not to the next gated hit
ok 382 - pickSignal: a gated hit with a null claim coalesces to branch 2, not to the next gated hit
  ---
  duration_ms: 0.308208
  type: 'test'
  ...
# Subtest: pickSignal: no qualifying finding returns null
ok 383 - pickSignal: no qualifying finding returns null
  ---
  duration_ms: 0.08975
  type: 'test'
  ...
# Subtest: pickSignal: malformed and non-array envelope shapes degrade to null, never throw
ok 384 - pickSignal: malformed and non-array envelope shapes degrade to null, never throw
  ---
  duration_ms: 0.203
  type: 'test'
  ...
# Subtest: pickSignal: non-string gated_on entries are ignored, not coerced
ok 385 - pickSignal: non-string gated_on entries are ignored, not coerced
  ---
  duration_ms: 0.039166
  type: 'test'
  ...
# Subtest: boundedRace returns the fallback when the inner promise never resolves
ok 386 - boundedRace returns the fallback when the inner promise never resolves
  ---
  duration_ms: 34.76975
  type: 'test'
  ...
# Subtest: boundedRace passes a fast result straight through
ok 387 - boundedRace passes a fast result straight through
  ---
  duration_ms: 0.14875
  type: 'test'
  ...
# Subtest: boundedRace resolves the fallback when the inner promise rejects — never rejects
ok 388 - boundedRace resolves the fallback when the inner promise rejects — never rejects
  ---
  duration_ms: 0.1465
  type: 'test'
  ...
# Subtest: boundedRace resolves the fallback on a synchronous throw inside the promise
ok 389 - boundedRace resolves the fallback on a synchronous throw inside the promise
  ---
  duration_ms: 0.066375
  type: 'test'
  ...
# Subtest: boundedRace does not hold the event loop open after a fast win
ok 390 - boundedRace does not hold the event loop open after a fast win
  ---
  duration_ms: 0.054917
  type: 'test'
  ...
# Subtest: boundedRace preserves falsy results rather than substituting the fallback
ok 391 - boundedRace preserves falsy results rather than substituting the fallback
  ---
  duration_ms: 0.125708
  type: 'test'
  ...
# Subtest: identity failure ⇒ the page still renders, with {} identities (uhid-only labels)
ok 392 - identity failure ⇒ the page still renders, with {} identities (uhid-only labels)
  ---
  duration_ms: 31.665167
  type: 'test'
  ...
# Subtest: a healthy identity lookup still labels the row
ok 393 - a healthy identity lookup still labels the row
  ---
  duration_ms: 0.219833
  type: 'test'
  ...
# Subtest: exact two-molecule match fires: confidence 1.0, det shape, gazette ref + date in rationale
ok 394 - exact two-molecule match fires: confidence 1.0, det shape, gazette ref + date in rationale
  ---
  duration_ms: 0.936875
  type: 'test'
  ...
# Subtest: C5 boundary: superset does NOT fire (banned core + one extra molecule)
ok 395 - C5 boundary: superset does NOT fire (banned core + one extra molecule)
  ---
  duration_ms: 0.127083
  type: 'test'
  ...
# Subtest: C5 boundary: subset does NOT fire (single molecule of a banned pair; 2 of a banned 3)
ok 396 - C5 boundary: subset does NOT fire (single molecule of a banned pair; 2 of a banned 3)
  ---
  duration_ms: 0.117208
  type: 'test'
  ...
# Subtest: order-independence + separator variants + case: ["b","a"] matches an entry stored ["a","b"]
ok 397 - order-independence + separator variants + case: ["b","a"] matches an entry stored ["a","b"]
  ---
  duration_ms: 0.133583
  type: 'test'
  ...
# Subtest: unresolved brand (no resolvedGeneric, no generic) → no finding, no throw — the accepted miss
ok 398 - unresolved brand (no resolvedGeneric, no generic) → no finding, no throw — the accepted miss
  ---
  duration_ms: 0.096917
  type: 'test'
  ...
# Subtest: empty / malformed table → empty array, never a throw (§7 fail-safe)
ok 399 - empty / malformed table → empty array, never a throw (§7 fail-safe)
  ---
  duration_ms: 0.06125
  type: 'test'
  ...
# Subtest: same banned combination in two products → ONE finding (per-entry dedupe)
ok 400 - same banned combination in two products → ONE finding (per-entry dedupe)
  ---
  duration_ms: 0.096583
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 15 (v2.0): loaded seed is v2.0 with 308 firing entries; withheld/rescinded/not_representable never fire
ok 401 - 0.81.14 Ruling 15 (v2.0): loaded seed is v2.0 with 308 firing entries; withheld/rescinded/not_representable never fire
  ---
  duration_ms: 27.432
  type: 'test'
  ...
# Subtest: stampFindingIdentity: banned-FDC keeps banned_fdc (C4 protection holds under the 0.81.10 generalisation)
ok 402 - stampFindingIdentity: banned-FDC keeps banned_fdc (C4 protection holds under the 0.81.10 generalisation)
  ---
  duration_ms: 1.474167
  type: 'test'
  ...
# Subtest: severity floor: banned_fdc is protected — store half refuses, engine half skips a hostile rule
ok 403 - severity floor: banned_fdc is protected — store half refuses, engine half skips a hostile rule
  ---
  duration_ms: 1.763
  type: 'test'
  ...
# Subtest: tierForCareSetting maps free-text care settings to a tariff tier
ok 404 - tierForCareSetting maps free-text care settings to a tariff tier
  ---
  duration_ms: 1.425084
  type: 'test'
  ...
# Subtest: priceAtTier reads the right column and falls back when a tier is absent
ok 405 - priceAtTier reads the right column and falls back when a tier is absent
  ---
  duration_ms: 0.311625
  type: 'test'
  ...
# Subtest: roomCategoryInflation = extra cost vs general ward; 0 at general/opd
ok 406 - roomCategoryInflation = extra cost vs general ward; 0 at general/opd
  ---
  duration_ms: 0.114917
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: §6.8 BUG 9a: the citation is stripped and evidence moves to estimates
ok 407 - §6.8 BUG 9a: the citation is stripped and evidence moves to estimates
  ---
  duration_ms: 1.045292
  type: 'test'
  ...
# Subtest: §6.7 THE 700-CHAR REASON: support beyond character 600 still counts
ok 408 - §6.7 THE 700-CHAR REASON: support beyond character 600 still counts
  ---
  duration_ms: 0.2135
  type: 'test'
  ...
# Subtest: a supporting excerpt naming the molecule keeps the citation
ok 409 - a supporting excerpt naming the molecule keeps the citation
  ---
  duration_ms: 0.055958
  type: 'test'
  ...
# Subtest: CONSERVATIVE: an undeterminable molecule ⇒ do nothing
ok 410 - CONSERVATIVE: an undeterminable molecule ⇒ do nothing
  ---
  duration_ms: 0.149
  type: 'test'
  ...
# Subtest: CONSERVATIVE: a cited excerpt with no text available ⇒ do nothing
ok 411 - CONSERVATIVE: a cited excerpt with no text available ⇒ do nothing
  ---
  duration_ms: 0.125792
  type: 'test'
  ...
# Subtest: deterministic findings and uncited findings are untouched
ok 412 - deterministic findings and uncited findings are untouched
  ---
  duration_ms: 0.060167
  type: 'test'
  ...
# Subtest: §6.9: the check does NOT run on the reuse path — empty hits, untouched findings
ok 413 - §6.9: the check does NOT run on the reuse path — empty hits, untouched findings
  ---
  duration_ms: 0.105458
  type: 'test'
  ...
# Subtest: the guard is structural in the engine: latestHits is set ONLY on the generation path
ok 414 - the guard is structural in the engine: latestHits is set ONLY on the generation path
  ---
  duration_ms: 0.401208
  type: 'test'
  ...
# Subtest: §6.10: stripping a citation does NOT change the index
ok 415 - §6.10: stripping a citation does NOT change the index
  ---
  duration_ms: 0.649334
  type: 'test'
  ...
# Subtest: §6.11: groundingKind, SEVERITY, PENALTY_BASE and findingPenalty are BYTE-IDENTICAL
ok 416 - §6.11: groundingKind, SEVERITY, PENALTY_BASE and findingPenalty are BYTE-IDENTICAL
  ---
  duration_ms: 0.465542
  type: 'test'
  ...
# Subtest: a stripped finding really does render as no_source
ok 417 - a stripped finding really does render as no_source
  ---
  duration_ms: 6.706208
  type: 'test'
  ...
# Subtest: the 600 and 700 constants are byte-identical — the gap this design exists for
ok 418 - the 600 and 700 constants are byte-identical — the gap this design exists for
  ---
  duration_ms: 0.264959
  type: 'test'
  ...
# Subtest: sourceUrl links journal PMIDs but not textbook item numbers
ok 419 - sourceUrl links journal PMIDs but not textbook item numbers
  ---
  duration_ms: 1.895292
  type: 'test'
  ...
# Subtest: hitsToSources numbers, previews, derives url, rounds similarity
ok 420 - hitsToSources numbers, previews, derives url, rounds similarity
  ---
  duration_ms: 0.177167
  type: 'test'
  ...
# Subtest: sourceLabel shows PMID for journals, item id for textbooks
ok 421 - sourceLabel shows PMID for journals, item id for textbooks
  ---
  duration_ms: 0.122292
  type: 'test'
  ...
# Subtest: buildCitedContext emits [n] provenance + full text
ok 422 - buildCitedContext emits [n] provenance + full text
  ---
  duration_ms: 0.0815
  type: 'test'
  ...
# Subtest: validateCitationIds clamps to [1..max], dedupes, drops junk
ok 423 - validateCitationIds clamps to [1..max], dedupes, drops junk
  ---
  duration_ms: 0.370625
  type: 'test'
  ...
# Subtest: usedSources filters to cited n only
ok 424 - usedSources filters to cited n only
  ---
  duration_ms: 0.07275
  type: 'test'
  ...
# Subtest: sourceUrl derives a live NBK link for Bookshelf, not PubMed
ok 425 - sourceUrl derives a live NBK link for Bookshelf, not PubMed
  ---
  duration_ms: 0.122208
  type: 'test'
  ...
# Subtest: a Bookshelf citation renders with a working NBK link + NBK label (not PMID)
ok 426 - a Bookshelf citation renders with a working NBK link + NBK label (not PMID)
  ---
  duration_ms: 0.06275
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: BUG 8: 17 and 18 ng/mL land in the SAME band — the acceptance test for this batch
ok 427 - BUG 8: 17 and 18 ng/mL land in the SAME band — the acceptance test for this batch
  ---
  duration_ms: 0.550916
  type: 'test'
  ...
# Subtest: §6.1: the full band table, boundaries exact and CONTIGUOUS
ok 428 - §6.1: the full band table, boundaries exact and CONTIGUOUS
  ---
  duration_ms: 0.132625
  type: 'test'
  ...
# Subtest: the boundary constants and the standard are named, verbatim
ok 429 - the boundary constants and the standard are named, verbatim
  ---
  duration_ms: 0.051958
  type: 'test'
  ...
# Subtest: an unusable level yields NO band — never a guess
ok 430 - an unusable level yields NO band — never a guess
  ---
  duration_ms: 0.045292
  type: 'test'
  ...
# Subtest: the level is read only when BOTH a vitamin-D token and ng/mL are present
ok 431 - the level is read only when BOTH a vitamin-D token and ng/mL are present
  ---
  duration_ms: 0.2675
  type: 'test'
  ...
# Subtest: FAIL-SAFE: a bare number, a different unit, or no vitamin-D token reads as NOTHING
ok 432 - FAIL-SAFE: a bare number, a different unit, or no vitamin-D token reads as NOTHING
  ---
  duration_ms: 0.05175
  type: 'test'
  ...
# Subtest: §6.2/§6.3: the matrix holds EXACTLY the two ratified rows
ok 433 - §6.2/§6.3: the matrix holds EXACTLY the two ratified rows
  ---
  duration_ms: 0.334834
  type: 'test'
  ...
# Subtest: row 1: deficient + 60,000 IU weekly × 8 weeks is concordant
ok 434 - row 1: deficient + 60,000 IU weekly × 8 weeks is concordant
  ---
  duration_ms: 0.104
  type: 'test'
  ...
# Subtest: row 2: insufficient + the same regimen is concordant (Dr Zaki, Indian context)
ok 435 - row 2: insufficient + the same regimen is concordant (Dr Zaki, Indian context)
  ---
  duration_ms: 0.193917
  type: 'test'
  ...
# Subtest: §6.4: EVERY unratified pair yields null — and null means EMIT NOTHING, never discordance
ok 436 - §6.4: EVERY unratified pair yields null — and null means EMIT NOTHING, never discordance
  ---
  duration_ms: 0.300708
  type: 'test'
  ...
# Subtest: §6.5: the retest prompt fires for INSUFFICIENT as well as deficient, still informational
ok 437 - §6.5: the retest prompt fires for INSUFFICIENT as well as deficient, still informational
  ---
  duration_ms: 0.465208
  type: 'test'
  ...
# Subtest: the prompt keeps signal_type vitamin_d_repletion_duration through stampFindingIdentity
ok 438 - the prompt keeps signal_type vitamin_d_repletion_duration through stampFindingIdentity
  ---
  duration_ms: 11.947542
  type: 'test'
  ...
# Subtest: a SUFFICIENT level with the same regimen emits nothing — silence is the default
ok 439 - a SUFFICIENT level with the same regimen emits nothing — silence is the default
  ---
  duration_ms: 0.102708
  type: 'test'
  ...
# Subtest: NO BAND (unreadable level) emits nothing for an 8-week course — never band on a guess
ok 440 - NO BAND (unreadable level) emits nothing for an 8-week course — never band on a guess
  ---
  duration_ms: 0.117
  type: 'test'
  ...
# Subtest: the >8-week Ruling 13 prompt is UNCHANGED and still band-independent
ok 441 - the >8-week Ruling 13 prompt is UNCHANGED and still band-independent
  ---
  duration_ms: 0.064542
  type: 'test'
  ...
# Subtest: FAIL-SAFE doctrine intact: an unparseable duration emits NOTHING in either mode
ok 442 - FAIL-SAFE doctrine intact: an unparseable duration emits NOTHING in either mode
  ---
  duration_ms: 0.123334
  type: 'test'
  ...
# Subtest: the system prompt names vitamin D dose adequacy beside muscle relaxants
ok 443 - the system prompt names vitamin D dose adequacy beside muscle relaxants
  ---
  duration_ms: 0.239666
  type: 'test'
  ...
# Subtest: the engine version is current and the read family keeps the older versions
ok 444 - the engine version is current and the read family keeps the older versions
  ---
  duration_ms: 3.372083
  type: 'test'
  ...
# Subtest: auditShadowReport: full + minimal findings round-trip byte-lossless
ok 445 - auditShadowReport: full + minimal findings round-trip byte-lossless
  ---
  duration_ms: 1.061792
  type: 'test'
  ...
# Subtest: auditShadowReport: empty findings → vacuously ok, zero counts
ok 446 - auditShadowReport: empty findings → vacuously ok, zero counts
  ---
  duration_ms: 0.073791
  type: 'test'
  ...
# Subtest: flag-OFF byte-identical: the shadow never mutates the persisted findings array
ok 447 - flag-OFF byte-identical: the shadow never mutates the persisted findings array
  ---
  duration_ms: 0.285542
  type: 'test'
  ...
# Subtest: auditShadowReport: flags a lossy finding (missing verdict/domain gain empty-string keys)
ok 448 - auditShadowReport: flags a lossy finding (missing verdict/domain gain empty-string keys)
  ---
  duration_ms: 0.092042
  type: 'test'
  ...
# Subtest: lossyKeys: detects dropped, added, and value-changed keys; empty on identity
ok 449 - lossyKeys: detects dropped, added, and value-changed keys; empty on identity
  ---
  duration_ms: 0.074875
  type: 'test'
  ...
# Subtest: demographics: structured input wins; band derived
ok 450 - demographics: structured input wins; band derived
  ---
  duration_ms: 4.354084
  type: 'test'
  ...
# Subtest: "No fever" → absent; "fever not mentioned" → unknown (the two are DIFFERENT)
ok 451 - "No fever" → absent; "fever not mentioned" → unknown (the two are DIFFERENT)
  ---
  duration_ms: 0.992708
  type: 'test'
  ...
# Subtest: "Denies vomiting" is a negation too; complaint carries its duration
ok 452 - "Denies vomiting" is a negation too; complaint carries its duration
  ---
  duration_ms: 0.131166
  type: 'test'
  ...
# Subtest: accepted complaint field names are pinned — a rename at a call site is a silent positives:0
ok 453 - accepted complaint field names are pinned — a rename at a call site is a silent positives:0
  ---
  duration_ms: 0.230958
  type: 'test'
  ...
# Subtest: vitals: parsed reads + instability from adult thresholds
ok 454 - vitals: parsed reads + instability from adult thresholds
  ---
  duration_ms: 0.223916
  type: 'test'
  ...
# Subtest: instability three-state: no vitals → not_assessable, all 5 channels missing
ok 455 - instability three-state: no vitals → not_assessable, all 5 channels missing
  ---
  duration_ms: 0.079958
  type: 'test'
  ...
# Subtest: instability three-state: full normal vitals → no_instability_detected, all 5 assessed
ok 456 - instability three-state: full normal vitals → no_instability_detected, all 5 assessed
  ---
  duration_ms: 0.148292
  type: 'test'
  ...
# Subtest: instability three-state: partial vitals (temperature only) → assessed [T], rest missing
ok 457 - instability three-state: partial vitals (temperature only) → assessed [T], rest missing
  ---
  duration_ms: 0.079042
  type: 'test'
  ...
# Subtest: instability three-state: breach → unstable, reasons byte-identical to unchanged logic
ok 458 - instability three-state: breach → unstable, reasons byte-identical to unchanged logic
  ---
  duration_ms: 0.279583
  type: 'test'
  ...
# Subtest: instability invariant: unstable === (assessment === "unstable"); emptyClinicalState passes updated zod
ok 459 - instability invariant: unstable === (assessment === "unstable"); emptyClinicalState passes updated zod
  ---
  duration_ms: 0.539167
  type: 'test'
  ...
# Subtest: normalizeWithLlm: verified spans accepted with offsets; unverifiable spans REJECTED
ok 460 - normalizeWithLlm: verified spans accepted with offsets; unverifiable spans REJECTED
  ---
  duration_ms: 0.23
  type: 'test'
  ...
# Subtest: mergeLlmFindings: resolves checklist unknowns, dedupes, sorts absent into negatives
ok 461 - mergeLlmFindings: resolves checklist unknowns, dedupes, sorts absent into negatives
  ---
  duration_ms: 0.417334
  type: 'test'
  ...
# Subtest: polarity MARKER: a negation-headed span labelled present is MARKED and KEPT — the live case
ok 462 - polarity MARKER: a negation-headed span labelled present is MARKED and KEPT — the live case
  ---
  duration_ms: 0.350583
  type: 'test'
  ...
# Subtest: polarity MARKER: the bank cases that killed the FILTER are kept, and merely annotated
ok 463 - polarity MARKER: the bank cases that killed the FILTER are kept, and merely annotated
  ---
  duration_ms: 0.219167
  type: 'test'
  ...
# Subtest: polarity MARKER: cue immediately LEFT of the span marks too
ok 464 - polarity MARKER: cue immediately LEFT of the span marks too
  ---
  duration_ms: 0.130709
  type: 'test'
  ...
# Subtest: polarity MARKER: head-governed ONLY — a mid-span cue is a modifier, and absent/historical are untouched
ok 465 - polarity MARKER: head-governed ONLY — a mid-span cue is a modifier, and absent/historical are untouched
  ---
  duration_ms: 0.082458
  type: 'test'
  ...
# Subtest: polarity MARKER: a marked finding still validates against the .strict() schema
ok 466 - polarity MARKER: a marked finding still validates against the .strict() schema
  ---
  duration_ms: 4.4475
  type: 'test'
  ...
# Subtest: applyParsedInvestigations: rows land verbatim; only abnormals become positive findings
ok 467 - applyParsedInvestigations: rows land verbatim; only abnormals become positive findings
  ---
  duration_ms: 0.492125
  type: 'test'
  ...
# Subtest: buildDdxClinicalState composes stage 1 + investigations; floor + priors wire through
ok 468 - buildDdxClinicalState composes stage 1 + investigations; floor + priors wire through
  ---
  duration_ms: 0.508416
  type: 'test'
  ...
# Subtest: runGuards: clean deterministic state — every asserted rawText verbatim, sentinel exempt
ok 469 - runGuards: clean deterministic state — every asserted rawText verbatim, sentinel exempt
  ---
  duration_ms: 0.810417
  type: 'test'
  ...
# Subtest: runGuards: a finding whose rawText is NOT in its field is caught as fabricated
ok 470 - runGuards: a finding whose rawText is NOT in its field is caught as fabricated
  ---
  duration_ms: 0.202375
  type: 'test'
  ...
# Subtest: runGuards: sentinel unknown is never a fabrication even though "(not mentioned)" is not in the text
ok 471 - runGuards: sentinel unknown is never a fabrication even though "(not mentioned)" is not in the text
  ---
  duration_ms: 0.075292
  type: 'test'
  ...
# Subtest: runGuards: offset validation flags a wrong span; correct offsets pass
ok 472 - runGuards: offset validation flags a wrong span; correct offsets pass
  ---
  duration_ms: 0.080208
  type: 'test'
  ...
# Subtest: parseJudgeResponse: fenced JSON, clamps out-of-range, defaults bad verdict, keeps missed[]
ok 473 - parseJudgeResponse: fenced JSON, clamps out-of-range, defaults bad verdict, keeps missed[]
  ---
  duration_ms: 0.461292
  type: 'test'
  ...
# Subtest: summarizePath: guard means aggregate; judge is ALWAYS calibrated:false
ok 474 - summarizePath: guard means aggregate; judge is ALWAYS calibrated:false
  ---
  duration_ms: 0.207458
  type: 'test'
  ...
# Subtest: headToHead: llm − det deltas; judge deltas null when a path lacks judge
ok 475 - headToHead: llm − det deltas; judge deltas null when a path lacks judge
  ---
  duration_ms: 0.253375
  type: 'test'
  ...
# Subtest: proposePromotionThreshold: never armed; floor = det baseline + noise margin
ok 476 - proposePromotionThreshold: never armed; floor = det baseline + noise margin
  ---
  duration_ms: 0.2405
  type: 'test'
  ...
# Subtest: scoreExtractorVsGold: recall/status matched; word-boundary match avoids ces⊂abscess
ok 477 - scoreExtractorVsGold: recall/status matched; word-boundary match avoids ces⊂abscess
  ---
  duration_ms: 1.246209
  type: 'test'
  ...
# Subtest: scoreExtractorVsGold: vitals granularity fold — HR/BP names+split match gold abbrev+value
ok 478 - scoreExtractorVsGold: vitals granularity fold — HR/BP names+split match gold abbrev+value
  ---
  duration_ms: 1.814709
  type: 'test'
  ...
# Subtest: calibrateJudge: low MAE ⇒ trustworthy; high MAE ⇒ retune
ok 479 - calibrateJudge: low MAE ⇒ trustworthy; high MAE ⇒ retune
  ---
  duration_ms: 0.405333
  type: 'test'
  ...
# Subtest: buildJudgeUser / judgeStateView: present the state without ids or offsets
ok 480 - buildJudgeUser / judgeStateView: present the state without ids or offsets
  ---
  duration_ms: 0.459292
  type: 'test'
  ...
# Subtest: adaptGoldSeed: flattens present/absent/unknown lanes; excludes riskFactors/investigations
ok 481 - adaptGoldSeed: flattens present/absent/unknown lanes; excludes riskFactors/investigations
  ---
  duration_ms: 0.342916
  type: 'test'
  ...
# Subtest: EXTRACTION_BANK is pinned to the frozen bank
ok 482 - EXTRACTION_BANK is pinned to the frozen bank
  ---
  duration_ms: 0.89575
  type: 'test'
  ...
# Subtest: medicationLineToAssertion: real db13 line → prescribed assertion with mapped fields + provenance
ok 483 - medicationLineToAssertion: real db13 line → prescribed assertion with mapped fields + provenance
  ---
  duration_ms: 0.612791
  type: 'test'
  ...
# Subtest: medicationLineToAssertion: DFO + Optiqmega → brand/generic mapped; generic optional
ok 484 - medicationLineToAssertion: DFO + Optiqmega → brand/generic mapped; generic optional
  ---
  duration_ms: 0.083084
  type: 'test'
  ...
# Subtest: medicationLineToAssertion: both brand + generic empty → null (skip the line)
ok 485 - medicationLineToAssertion: both brand + generic empty → null (skip the line)
  ---
  duration_ms: 0.095
  type: 'test'
  ...
# Subtest: allergyTextToAssertions: NKA notations → one denied; empty → []; substantive → reported_allergy
ok 486 - allergyTextToAssertions: NKA notations → one denied; empty → []; substantive → reported_allergy
  ---
  duration_ms: 0.4255
  type: 'test'
  ...
# Subtest: allergyTextToAssertions: "NK" (not-known) → denied; substantive text containing nk is NOT swept
ok 487 - allergyTextToAssertions: "NK" (not-known) → denied; substantive text containing nk is NOT swept
  ---
  duration_ms: 0.067875
  type: 'test'
  ...
# Subtest: allergyTextToAssertions: substantive text → one reported_allergy, raw preserved, reaction null
ok 488 - allergyTextToAssertions: substantive text → one reported_allergy, raw preserved, reaction null
  ---
  duration_ms: 0.083625
  type: 'test'
  ...
# Subtest: prescriptionToAssertions: full 2-line array + "No" allergy → 2 med + 1 denied
ok 489 - prescriptionToAssertions: full 2-line array + "No" allergy → 2 med + 1 denied
  ---
  duration_ms: 0.147834
  type: 'test'
  ...
# Subtest: prescriptionToAssertions: accepts a JSON string array; skips empty lines
ok 490 - prescriptionToAssertions: accepts a JSON string array; skips empty lines
  ---
  duration_ms: 0.06825
  type: 'test'
  ...
# Subtest: prescriptionToAssertions: malformed / non-array input → empty, never throws
ok 491 - prescriptionToAssertions: malformed / non-array input → empty, never throws
  ---
  duration_ms: 0.340916
  type: 'test'
  ...
# Subtest: id determinism: same input → same id across calls (both assertion kinds)
ok 492 - id determinism: same input → same id across calls (both assertion kinds)
  ---
  duration_ms: 0.314042
  type: 'test'
  ...
# Subtest: schema: emptyClinicalState is 1.1 with empty assertion arrays and passes the updated zod
ok 493 - schema: emptyClinicalState is 1.1 with empty assertion arrays and passes the updated zod
  ---
  duration_ms: 1.477791
  type: 'test'
  ...
# Subtest: Provenance trust axis (1.2): optional reporter/trust validate; absent still validates
ok 494 - Provenance trust axis (1.2): optional reporter/trust validate; absent still validates
  ---
  duration_ms: 2.442625
  type: 'test'
  ...
# Subtest: MedicationAssertion.stopReason enum validates through the state
ok 495 - MedicationAssertion.stopReason enum validates through the state
  ---
  duration_ms: 0.394167
  type: 'test'
  ...
# Subtest: zComplaintStatusAssertion validates ComplaintStatus, rejects bogus
ok 496 - zComplaintStatusAssertion validates ComplaintStatus, rejects bogus
  ---
  duration_ms: 0.160875
  type: 'test'
  ...
# Subtest: zFollowUpAssertion validates FollowUpAction (+ optional targetDate), rejects bogus
ok 497 - zFollowUpAssertion validates FollowUpAction (+ optional targetDate), rejects bogus
  ---
  duration_ms: 0.221292
  type: 'test'
  ...
# Subtest: emptyClinicalState validates and carries the version literal
ok 498 - emptyClinicalState validates and carries the version literal
  ---
  duration_ms: 1.629959
  type: 'test'
  ...
# Subtest: a populated state validates: findings, audit ext, timeline, adminFacts
ok 499 - a populated state validates: findings, audit ext, timeline, adminFacts
  ---
  duration_ms: 0.958083
  type: 'test'
  ...
# Subtest: validation rejects a bad finding status, a missing provenance, an unknown ext kind
ok 500 - validation rejects a bad finding status, a missing provenance, an unknown ext kind
  ---
  duration_ms: 0.486167
  type: 'test'
  ...
# Subtest: mkFindingId is deterministic and status-sensitive
ok 501 - mkFindingId is deterministic and status-sensitive
  ---
  duration_ms: 0.141208
  type: 'test'
  ...
# Subtest: stateCounts mirrors the arrays
ok 502 - stateCounts mirrors the arrays
  ---
  duration_ms: 0.071083
  type: 'test'
  ...
# Subtest: formatClinicalState renders every populated section, skips empty ones
ok 503 - formatClinicalState renders every populated section, skips empty ones
  ---
  duration_ms: 0.23575
  type: 'test'
  ...
# Subtest: clinicalStateResultField: flag OFF returns {} — result payload byte-identical
ok 504 - clinicalStateResultField: flag OFF returns {} — result payload byte-identical
  ---
  duration_ms: 0.847167
  type: 'test'
  ...
# Subtest: clinicalStateResultField: null/undefined state returns {} even when enabled
ok 505 - clinicalStateResultField: null/undefined state returns {} even when enabled
  ---
  duration_ms: 0.075041
  type: 'test'
  ...
# Subtest: clinicalStateResultField: flag ON attaches the trimmed view
ok 506 - clinicalStateResultField: flag ON attaches the trimmed view
  ---
  duration_ms: 0.181583
  type: 'test'
  ...
# Subtest: toClinicalStateUiView: counts mirror stateCounts; provenance preserved for hover
ok 507 - toClinicalStateUiView: counts mirror stateCounts; provenance preserved for hover
  ---
  duration_ms: 0.072833
  type: 'test'
  ...
# Subtest: the production exhibit shape: "Diagnosis documented without a code" → coding_completeness
ok 508 - the production exhibit shape: "Diagnosis documented without a code" → coding_completeness
  ---
  duration_ms: 0.747875
  type: 'test'
  ...
# Subtest: the regex catches the documented phrasings
ok 509 - the regex catches the documented phrasings
  ---
  duration_ms: 0.430333
  type: 'test'
  ...
# Subtest: a CLINICAL diagnosis-missing finding is NOT a coding gap and passes through
ok 510 - a CLINICAL diagnosis-missing finding is NOT a coding gap and passes through
  ---
  duration_ms: 0.217375
  type: 'test'
  ...
# Subtest: deterministic findings pass through the metadata neutralizer untouched
ok 511 - deterministic findings pass through the metadata neutralizer untouched
  ---
  duration_ms: 0.04575
  type: 'test'
  ...
# Subtest: CODING_GAP_RE is byte-identical — the batch changed nothing
ok 512 - CODING_GAP_RE is byte-identical — the batch changed nothing
  ---
  duration_ms: 0.298167
  type: 'test'
  ...
# Subtest: branchForVerdict maps verdicts to branches
ok 513 - branchForVerdict maps verdicts to branches
  ---
  duration_ms: 0.554
  type: 'test'
  ...
# Subtest: floorFor detects in-scope analytes and dedups
ok 514 - floorFor detects in-scope analytes and dedups
  ---
  duration_ms: 0.195833
  type: 'test'
  ...
# Subtest: prompt injects the cannot-miss floor for the analyte
ok 515 - prompt injects the cannot-miss floor for the analyte
  ---
  duration_ms: 0.624958
  type: 'test'
  ...
# Subtest: parser extracts a single committed verdict
ok 516 - parser extracts a single committed verdict
  ---
  duration_ms: 0.447166
  type: 'test'
  ...
# Subtest: parser flags multiple verdicts (the A1 mini failure mode)
ok 517 - parser flags multiple verdicts (the A1 mini failure mode)
  ---
  duration_ms: 0.247333
  type: 'test'
  ...
# Subtest: scoreCase: correct branch-A verdict + gap hit + cannot-miss covered
ok 518 - scoreCase: correct branch-A verdict + gap hit + cannot-miss covered
  ---
  duration_ms: 0.119417
  type: 'test'
  ...
# Subtest: scoreCase: control marked discordant is over-flagged
ok 519 - scoreCase: control marked discordant is over-flagged
  ---
  duration_ms: 0.11075
  type: 'test'
  ...
# Subtest: inferUnit picks the unit by magnitude and flags the ambiguous zone
ok 520 - inferUnit picks the unit by magnitude and flags the ambiguous zone
  ---
  duration_ms: 0.088292
  type: 'test'
  ...
# Subtest: resultHasUnit / unitAnnotations only annotate when no unit is typed
ok 521 - resultHasUnit / unitAnnotations only annotate when no unit is typed
  ---
  duration_ms: 0.26725
  type: 'test'
  ...
# Subtest: unitContext flags ambiguity for a clarifying question, assumes otherwise
ok 522 - unitContext flags ambiguity for a clarifying question, assumes otherwise
  ---
  duration_ms: 0.326792
  type: 'test'
  ...
# Subtest: populationLines flags an extreme value against real base rates
ok 523 - populationLines flags an extreme value against real base rates
  ---
  duration_ms: 0.179583
  type: 'test'
  ...
# Subtest: populationLines handles comma numbers and returns nothing off-scope
ok 524 - populationLines handles comma numbers and returns nothing off-scope
  ---
  duration_ms: 0.060958
  type: 'test'
  ...
# Subtest: POPULATION_PRIORS covers the tight analyte set
ok 525 - POPULATION_PRIORS covers the tight analyte set
  ---
  duration_ms: 0.095292
  type: 'test'
  ...
# Subtest: normalizeBelief sums to 1 and topBelief picks the leader
ok 526 - normalizeBelief sums to 1 and topBelief picks the leader
  ---
  duration_ms: 0.096417
  type: 'test'
  ...
# Subtest: isUnknownAnswer recognises "I don't have this" variants
ok 527 - isUnknownAnswer recognises "I don't have this" variants
  ---
  duration_ms: 0.272667
  type: 'test'
  ...
# Subtest: shouldStop fires on cap, confidence, unknown-streak, and belief threshold
ok 528 - shouldStop fires on cap, confidence, unknown-streak, and belief threshold
  ---
  duration_ms: 0.086666
  type: 'test'
  ...
# Subtest: recordTurn tracks unknown streak (resets on an answer) and lifts leadConfidence
ok 529 - recordTurn tracks unknown streak (resets on an answer) and lifts leadConfidence
  ---
  duration_ms: 0.093917
  type: 'test'
  ...
# Subtest: recordTurn logs an open gap on "I don't have this" and increments count
ok 530 - recordTurn logs an open gap on "I don't have this" and increments count
  ---
  duration_ms: 0.050833
  type: 'test'
  ...
# Subtest: toVerdictContext folds transcript + open gaps into the context
ok 531 - toVerdictContext folds transcript + open gaps into the context
  ---
  duration_ms: 0.099959
  type: 'test'
  ...
# Subtest: parseSeed reads branch|weight|cause lines and normalises
ok 532 - parseSeed reads branch|weight|cause lines and normalises
  ---
  duration_ms: 0.159
  type: 'test'
  ...
# Subtest: parseSeed tolerates a stray leading label (BRANCH|B|0.4|cause)
ok 533 - parseSeed tolerates a stray leading label (BRANCH|B|0.4|cause)
  ---
  duration_ms: 0.04775
  type: 'test'
  ...
# Subtest: parseNextQuestion parses a question and detects STOP
ok 534 - parseNextQuestion parses a question and detects STOP
  ---
  duration_ms: 0.216042
  type: 'test'
  ...
# Subtest: extractDemographics reads compact and worded forms, else null
ok 535 - extractDemographics reads compact and worded forms, else null
  ---
  duration_ms: 0.347125
  type: 'test'
  ...
# Subtest: coarseBand maps age to the mined bands
ok 536 - coarseBand maps age to the mined bands
  ---
  duration_ms: 0.035958
  type: 'test'
  ...
# Subtest: effectivePrior uses the sex cell (Hb F<M) and falls back when a cell is sparse/missing
ok 537 - effectivePrior uses the sex cell (Hb F<M) and falls back when a cell is sparse/missing
  ---
  duration_ms: 0.135458
  type: 'test'
  ...
# Subtest: populationLines is sex-stratified when the context gives age/sex
ok 538 - populationLines is sex-stratified when the context gives age/sex
  ---
  duration_ms: 0.088958
  type: 'test'
  ...
# Subtest: buildRunRecord is de-identified: analytes + verdict + counts, no raw text
ok 539 - buildRunRecord is de-identified: analytes + verdict + counts, no raw text
  ---
  duration_ms: 0.176292
  type: 'test'
  ...
# Subtest: summarize aggregates the bank
ok 540 - summarize aggregates the bank
  ---
  duration_ms: 0.11625
  type: 'test'
  ...
# Subtest: (1) SEPARATION: the consensus store is ipd_gold_adjudication, never ipd_audit_feedback
ok 541 - (1) SEPARATION: the consensus store is ipd_gold_adjudication, never ipd_audit_feedback
  ---
  duration_ms: 0.5945
  type: 'test'
  ...
# Subtest: (2) VOCABULARY: exactly tp | valid_extra | false | nitpick | contested
ok 542 - (2) VOCABULARY: exactly tp | valid_extra | false | nitpick | contested
  ---
  duration_ms: 0.456541
  type: 'test'
  ...
# Subtest: (3a) DE-IDENTIFICATION: the harness gates finding text against URLs and PHI
ok 543 - (3a) DE-IDENTIFICATION: the harness gates finding text against URLs and PHI
  ---
  duration_ms: 1.026167
  type: 'test'
  ...
# Subtest: (3b) DE-IDENTIFICATION: the store schema carries no name/UHID column
ok 544 - (3b) DE-IDENTIFICATION: the store schema carries no name/UHID column
  ---
  duration_ms: 0.409166
  type: 'test'
  ...
# Subtest: (4) ONE MATCHER: rescore + harness share the matcher, neither keeps a copy
ok 545 - (4) ONE MATCHER: rescore + harness share the matcher, neither keeps a copy
  ---
  duration_ms: 0.525375
  type: 'test'
  ...
# Subtest: TarReader emits regular files with exact bytes, ignores dirs, across arbitrary chunk splits
ok 546 - TarReader emits regular files with exact bytes, ignores dirs, across arbitrary chunk splits
  ---
  duration_ms: 11.858667
  type: 'test'
  ...
# Subtest: TarReader honours an early stop (onFile → false) and drops the rest
ok 547 - TarReader honours an early stop (onFile → false) and drops the rest
  ---
  duration_ms: 0.485
  type: 'test'
  ...
# Subtest: parseCsv handles quoted fields with embedded commas
ok 548 - parseCsv handles quoted fields with embedded commas
  ---
  duration_ms: 0.091541
  type: 'test'
  ...
# Subtest: parseOaManifest reads File/Title/Publisher/Accession by header position
ok 549 - parseOaManifest reads File/Title/Publisher/Accession by header position
  ---
  duration_ms: 0.142125
  type: 'test'
  ...
# Subtest: selectSeedBooks resolves the allowlist, excludes StatPearls, surfaces missing ids
ok 550 - selectSeedBooks resolves the allowlist, excludes StatPearls, surfaces missing ids
  ---
  duration_ms: 0.185333
  type: 'test'
  ...
# Subtest: sanitizeBookChunk strips NCBI cross-link label runs but keeps prose
ok 551 - sanitizeBookChunk strips NCBI cross-link label runs but keeps prose
  ---
  duration_ms: 0.459542
  type: 'test'
  ...
# Subtest: parseVerdict is fail-safe: valid → verdict; junk/empty/invalid → not_assessable, never a guess
ok 552 - parseVerdict is fail-safe: valid → verdict; junk/empty/invalid → not_assessable, never a guess
  ---
  duration_ms: 1.229375
  type: 'test'
  ...
# Subtest: support rate = directly / assessable; not_assessable excluded from the denominator
ok 553 - support rate = directly / assessable; not_assessable excluded from the denominator
  ---
  duration_ms: 0.321416
  type: 'test'
  ...
# Subtest: Wilson CI: sane bounds, tightens with n, all-supports stays < 1
ok 554 - Wilson CI: sane bounds, tightens with n, all-supports stays < 1
  ---
  duration_ms: 0.923375
  type: 'test'
  ...
# Subtest: cite-or-label fraction
ok 555 - cite-or-label fraction
  ---
  duration_ms: 0.18075
  type: 'test'
  ...
# Subtest: coverage-deficit histogram: deciles + median/p90, clamped
ok 556 - coverage-deficit histogram: deciles + median/p90, clamped
  ---
  duration_ms: 0.336708
  type: 'test'
  ...
# Subtest: the verifier prompt is registry-named + judges from excerpts alone (no patient record)
ok 557 - the verifier prompt is registry-named + judges from excerpts alone (no patient record)
  ---
  duration_ms: 0.545167
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: (a) priced output is total − prompt (reasoning-inclusive), never completion alone
ok 558 - (a) priced output is total − prompt (reasoning-inclusive), never completion alone
  ---
  duration_ms: 0.584292
  type: 'test'
  ...
# Subtest: (a) the rule degrades safely: no total ⇒ completion; never negative; missing usage ⇒ 0
ok 559 - (a) the rule degrades safely: no total ⇒ completion; never negative; missing usage ⇒ 0
  ---
  duration_ms: 0.074792
  type: 'test'
  ...
# Subtest: (b) a multimodal event’s envelope carries the model and reasoning-inclusive tokens_out
ok 560 - (b) a multimodal event’s envelope carries the model and reasoning-inclusive tokens_out
  ---
  duration_ms: 0.092583
  type: 'test'
  ...
# Subtest: (b) the multimodal transport passes an envelope with the reasoning-inclusive rule
ok 561 - (b) the multimodal transport passes an envelope with the reasoning-inclusive rule
  ---
  duration_ms: 0.242125
  type: 'test'
  ...
# Subtest: (c) the multimodal read is logged exactly once — no double count
ok 562 - (c) the multimodal read is logged exactly once — no double count
  ---
  duration_ms: 0.317042
  type: 'test'
  ...
# Subtest: (3) the IPD extract call passes traceId — without it the read self-logs nothing at all
ok 563 - (3) the IPD extract call passes traceId — without it the read self-logs nothing at all
  ---
  duration_ms: 0.130417
  type: 'test'
  ...
# Subtest: the historic backfill touches ONLY the four cost columns, and never re-derives the rule
ok 564 - the historic backfill touches ONLY the four cost columns, and never re-derives the rule
  ---
  duration_ms: 0.459084
  type: 'test'
  ...
# Subtest: the column path and the payload path state the SAME rule (they must never drift)
ok 565 - the column path and the payload path state the SAME rule (they must never drift)
  ---
  duration_ms: 0.314292
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: orderPair: canonical order on the normalised lowercase name; original names preserved; same norm as pairKey
ok 566 - orderPair: canonical order on the normalised lowercase name; original names preserved; same norm as pairKey
  ---
  duration_ms: 0.922792
  type: 'test'
  ...
# Subtest: all three construction sites emit the canonical order regardless of input order
ok 567 - all three construction sites emit the canonical order regardless of input order
  ---
  duration_ms: 0.649208
  type: 'test'
  ...
# Subtest: ddiFindings: the same two drugs in either meds[] order produce an identical finding_ref and stable_ref
ok 568 - ddiFindings: the same two drugs in either meds[] order produce an identical finding_ref and stable_ref
  ---
  duration_ms: 2.253833
  type: 'test'
  ...
# Subtest: ddiFindings: a three-drug script is ref-stable under full reversal (multiple pairs at once)
ok 569 - ddiFindings: a three-drug script is ref-stable under full reversal (multiple pairs at once)
  ---
  duration_ms: 5.612083
  type: 'test'
  ...
# Subtest: involvesTopical (ddiToFinding): topical de-escalation identical in either order
ok 570 - involvesTopical (ddiToFinding): topical de-escalation identical in either order
  ---
  duration_ms: 0.9085
  type: 'test'
  ...
# Subtest: bothNsaid (Ruling 1 suppression): topical NSAID–NSAID suppressed entirely in either order
ok 571 - bothNsaid (Ruling 1 suppression): topical NSAID–NSAID suppressed entirely in either order
  ---
  duration_ms: 0.249042
  type: 'test'
  ...
# Subtest: scope guard: canonicalisation changed no firing decision — pair count and content match a reversed run everywhere
ok 572 - scope guard: canonicalisation changed no firing decision — pair count and content match a reversed run everywhere
  ---
  duration_ms: 13.686
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: THE PREMISE: resolveMedRoute returns null for the real gel — its name has no form word
ok 573 - THE PREMISE: resolveMedRoute returns null for the real gel — its name has no form word
  ---
  duration_ms: 1.347333
  type: 'test'
  ...
# Subtest: a med with dosageForm topical and a NULL resolveMedRoute now enters the topical set
ok 574 - a med with dosageForm topical and a NULL resolveMedRoute now enters the topical set
  ---
  duration_ms: 2.113083
  type: 'test'
  ...
# Subtest: THE REAL CASE: oral NSAID + the gel with dosageForm topical produces NO drug_interaction
ok 575 - THE REAL CASE: oral NSAID + the gel with dosageForm topical produces NO drug_interaction
  ---
  duration_ms: 0.322833
  type: 'test'
  ...
# Subtest: THE CONTROL: the same pair with dosageForm UNSET still leaks — so the test measures the new path
ok 576 - THE CONTROL: the same pair with dosageForm UNSET still leaks — so the test measures the new path
  ---
  duration_ms: 0.275375
  type: 'test'
  ...
# Subtest: two ORAL NSAIDs still produce the finding, unchanged
ok 577 - two ORAL NSAIDs still produce the finding, unchanged
  ---
  duration_ms: 0.222292
  type: 'test'
  ...
# Subtest: drops, inhaler and injection do NOT enter the topical set (DEC-4 keeps this narrow)
ok 578 - drops, inhaler and injection do NOT enter the topical set (DEC-4 keeps this narrow)
  ---
  duration_ms: 2.554792
  type: 'test'
  ...
# Subtest: resolveMedRoute === topical still qualifies on its own — the original path is intact
ok 579 - resolveMedRoute === topical still qualifies on its own — the original path is intact
  ---
  duration_ms: 0.343
  type: 'test'
  ...
# Subtest: the NSAID–NSAID restriction holds: a topical NSAID + a NON-NSAID still fires
ok 580 - the NSAID–NSAID restriction holds: a topical NSAID + a NON-NSAID still fires
  ---
  duration_ms: 0.131584
  type: 'test'
  ...
# Subtest: a non-NSAID pair is unaffected — the QT rule still fires
ok 581 - a non-NSAID pair is unaffected — the QT rule still fires
  ---
  duration_ms: 0.431042
  type: 'test'
  ...
# Subtest: fewer than two eligible meds still returns nothing
ok 582 - fewer than two eligible meds still returns nothing
  ---
  duration_ms: 0.364333
  type: 'test'
  ...
# Subtest: the topical set reads BOTH sources, and Ruling 1 is byte-identical
ok 583 - the topical set reads BOTH sources, and Ruling 1 is byte-identical
  ---
  duration_ms: 5.050875
  type: 'test'
  ...
# Subtest: matchDx: normalized substring match, tolerant of qualifiers and punctuation
ok 584 - matchDx: normalized substring match, tolerant of qualifiers and punctuation
  ---
  duration_ms: 1.164875
  type: 'test'
  ...
# Subtest: matchDx: synonyms match when the literal expected string does not
ok 585 - matchDx: synonyms match when the literal expected string does not
  ---
  duration_ms: 0.148208
  type: 'test'
  ...
# Subtest: matchDx: negatives — unrelated diagnoses and short-token false hits rejected
ok 586 - matchDx: negatives — unrelated diagnoses and short-token false hits rejected
  ---
  duration_ms: 0.118792
  type: 'test'
  ...
# Subtest: matchDx v3: INTERIOR mid-word hit rejected, but boundary-anchored matches preserved
ok 587 - matchDx v3: INTERIOR mid-word hit rejected, but boundary-anchored matches preserved
  ---
  duration_ms: 0.069417
  type: 'test'
  ...
# Subtest: rankedDifferential is most_likely order; allEntries spans the three axes
ok 588 - rankedDifferential is most_likely order; allEntries spans the three axes
  ---
  duration_ms: 0.360833
  type: 'test'
  ...
# Subtest: fabricated-finding heuristic: flags asserted-but-unstated findings only
ok 589 - fabricated-finding heuristic: flags asserted-but-unstated findings only
  ---
  duration_ms: 0.1685
  type: 'test'
  ...
# Subtest: scoreDdxCase: clean fixture — top-1 hit, cannot-miss covered, nothing flagged
ok 590 - scoreDdxCase: clean fixture — top-1 hit, cannot-miss covered, nothing flagged
  ---
  duration_ms: 0.238792
  type: 'test'
  ...
# Subtest: scoreDdxCase: dirty fixture — every failure mode fires
ok 591 - scoreDdxCase: dirty fixture — every failure mode fires
  ---
  duration_ms: 0.157167
  type: 'test'
  ...
# Subtest: scoreDdxCase: synonym match covers cannot-miss ("AAA rupture" counts as ruptured AAA)
ok 592 - scoreDdxCase: synonym match covers cannot-miss ("AAA rupture" counts as ruptured AAA)
  ---
  duration_ms: 0.201125
  type: 'test'
  ...
# Subtest: scoreDdxCase: empty result — misses everything, never throws
ok 593 - scoreDdxCase: empty result — misses everything, never throws
  ---
  duration_ms: 0.300584
  type: 'test'
  ...
# Subtest: summarizeDdx: rates over the right denominators, incl. the null cannot-miss path
ok 594 - summarizeDdx: rates over the right denominators, incl. the null cannot-miss path
  ---
  duration_ms: 0.195416
  type: 'test'
  ...
# Subtest: summarizeDdx: no case specifies cannot-miss → recall defaults to 1; empty bank never divides by 0
ok 595 - summarizeDdx: no case specifies cannot-miss → recall defaults to 1; empty bank never divides by 0
  ---
  duration_ms: 0.058458
  type: 'test'
  ...
# Subtest: A1 matcher v2: British↔American spelling variants now match
ok 596 - A1 matcher v2: British↔American spelling variants now match
  ---
  duration_ms: 0.081542
  type: 'test'
  ...
# Subtest: A1 matcher v2: does NOT over-match unrelated diagnoses (containment unchanged)
ok 597 - A1 matcher v2: does NOT over-match unrelated diagnoses (containment unchanged)
  ---
  duration_ms: 0.043417
  type: 'test'
  ...
# Subtest: A2 lane coverage: covered iff ≥1 lane dx matches any engine axis
ok 598 - A2 lane coverage: covered iff ≥1 lane dx matches any engine axis
  ---
  duration_ms: 0.143584
  type: 'test'
  ...
# Subtest: A2 lane coverage: null (skipped) when a case defines no expectedLanes
ok 599 - A2 lane coverage: null (skipped) when a case defines no expectedLanes
  ---
  duration_ms: 0.080542
  type: 'test'
  ...
# Subtest: A2 laneCoverageRate: mean per-case rate over labelled cases only; null when none labelled
ok 600 - A2 laneCoverageRate: mean per-case rate over labelled cases only; null when none labelled
  ---
  duration_ms: 0.110875
  type: 'test'
  ...
# Subtest: A3 negative misuse: fires when a considered dx asserts a documented-negative finding
ok 601 - A3 negative misuse: fires when a considered dx asserts a documented-negative finding
  ---
  duration_ms: 0.26325
  type: 'test'
  ...
# Subtest: A3 cannot-miss over-flag: fires when an unsupported cannot-miss dx is surfaced
ok 602 - A3 cannot-miss over-flag: fires when an unsupported cannot-miss dx is surfaced
  ---
  duration_ms: 0.1365
  type: 'test'
  ...
# Subtest: A3 summary rates: denominated over labelled cases; null when none labelled
ok 603 - A3 summary rates: denominated over labelled cases; null when none labelled
  ---
  duration_ms: 0.063042
  type: 'test'
  ...
# Subtest: A4 latency: nearest-rank P50/P90 from supplied ms; null when none
ok 604 - A4 latency: nearest-rank P50/P90 from supplied ms; null when none
  ---
  duration_ms: 0.1065
  type: 'test'
  ...
# Subtest: A6 version stamping: summary carries matcher + bank versions
ok 605 - A6 version stamping: summary carries matcher + bank versions
  ---
  duration_ms: 0.049792
  type: 'test'
  ...
# Subtest: A6 freeze guard: dormant passes; active passes on match, fails on mismatch
ok 606 - A6 freeze guard: dormant passes; active passes on match, fails on mismatch
  ---
  duration_ms: 0.072
  type: 'test'
  ...
# Subtest: A5 scoreFromResultsJson: re-scores a saved results file with no network
ok 607 - A5 scoreFromResultsJson: re-scores a saved results file with no network
  ---
  duration_ms: 2.618708
  type: 'test'
  ...
# Subtest: FREEZE: pinned pair is ddx-eval/3 + ddx-case-bank/1.0 and matches the committed bank
ok 608 - FREEZE: pinned pair is ddx-eval/3 + ddx-case-bank/1.0 and matches the committed bank
  ---
  duration_ms: 1.032083
  type: 'test'
  ...
# Subtest: F3 collision guard: no two cannot-miss dx in any case collapse under matcher + synonyms
ok 609 - F3 collision guard: no two cannot-miss dx in any case collapse under matcher + synonyms
  ---
  duration_ms: 0.813458
  type: 'test'
  ...
# Subtest: existing 7 summary metrics are byte-identical on an unchanged score set
ok 610 - existing 7 summary metrics are byte-identical on an unchanged score set
  ---
  duration_ms: 0.064625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: r1 — the callback type carries the map, and it is TRAILING and OPTIONAL
ok 611 - r1 — the callback type carries the map, and it is TRAILING and OPTIONAL
  ---
  duration_ms: 3.098833
  type: 'test'
  ...
# Subtest: r2 — the two DECLARATION publications pass no map
ok 612 - r2 — the two DECLARATION publications pass no map
  ---
  duration_ms: 0.675458
  type: 'test'
  ...
# Subtest: r3 — BOTH terminal publications pass a SHALLOW SNAPSHOT, never the live object
ok 613 - r3 — BOTH terminal publications pass a SHALLOW SNAPSHOT, never the live object
  ---
  duration_ms: 0.56025
  type: 'test'
  ...
# Subtest: r3b — a shallow snapshot really is immune to the mutation that follows it
ok 614 - r3b — a shallow snapshot really is immune to the mutation that follows it
  ---
  duration_ms: 0.431334
  type: 'test'
  ...
# Subtest: r5 — NO owner reads `?? {}` any more, anywhere in the repository
ok 615 - r5 — NO owner reads `?? {}` any more, anywhere in the repository
  ---
  duration_ms: 1.610792
  type: 'test'
  ...
# Subtest: r4 — every owner prefers the ATTACHED map, then the CALLBACK map, then undefined
ok 616 - r4 — every owner prefers the ATTACHED map, then the CALLBACK map, then undefined
  ---
  duration_ms: 1.278417
  type: 'test'
  ...
# Subtest: r4b — the selection order, exercised against the REAL attach and read
ok 617 - r4b — the selection order, exercised against the REAL attach and read
  ---
  duration_ms: 0.12175
  type: 'test'
  ...
# Subtest: r4c — the two callback sites that read NO map were not changed
ok 618 - r4c — the two callback sites that read NO map were not changed
  ---
  duration_ms: 0.558542
  type: 'test'
  ...
# Subtest: r11 — line 1723 is not wrapped, not rewritten, and still the only unattached return
ok 619 - r11 — line 1723 is not wrapped, not rewritten, and still the only unattached return
  ---
  duration_ms: 0.71675
  type: 'test'
  ...
# Subtest: §4.1 CHECK 1: the prefix alone does NOT set direction when class-absence objects
ok 620 - §4.1 CHECK 1: the prefix alone does NOT set direction when class-absence objects
  ---
  duration_ms: 0.759792
  type: 'test'
  ...
# Subtest: with no objection, the prefix sets direction — both values
ok 621 - with no objection, the prefix sets direction — both values
  ---
  duration_ms: 0.183084
  type: 'test'
  ...
# Subtest: an absent/blank/foreign concept_id yields NO direction — undetermined is the honest default
ok 622 - an absent/blank/foreign concept_id yields NO direction — undetermined is the honest default
  ---
  duration_ms: 0.067584
  type: 'test'
  ...
# Subtest: deterministic findings are never stamped
ok 623 - deterministic findings are never stamped
  ---
  duration_ms: 0.047875
  type: 'test'
  ...
# Subtest: the class-absence predicate has ONE implementation
ok 624 - the class-absence predicate has ONE implementation
  ---
  duration_ms: 0.651917
  type: 'test'
  ...
# Subtest: §4.3: an underuse finding scores IDENTICALLY to a note with no finding at all
ok 625 - §4.3: an underuse finding scores IDENTICALLY to a note with no finding at all
  ---
  duration_ms: 0.381875
  type: 'test'
  ...
# Subtest: …while the SAME finding marked overuse (or unmarked) still penalises — the control
ok 626 - …while the SAME finding marked overuse (or unmarked) still penalises — the control
  ---
  duration_ms: 0.159875
  type: 'test'
  ...
# Subtest: §4.4: SEVERITY and PENALTY_BASE are BYTE-IDENTICAL — no new member, no re-weighting
ok 627 - §4.4: SEVERITY and PENALTY_BASE are BYTE-IDENTICAL — no new member, no re-weighting
  ---
  duration_ms: 0.484625
  type: 'test'
  ...
# Subtest: NetValue is untouched — no member meaning underuse was added
ok 628 - NetValue is untouched — no member meaning underuse was added
  ---
  duration_ms: 0.41125
  type: 'test'
  ...
# Subtest: §4.5: an underuse finding receives NO lvc_category
ok 629 - §4.5: an underuse finding receives NO lvc_category
  ---
  duration_ms: 0.8575
  type: 'test'
  ...
# Subtest: §4.5: an underuse finding does not keep signal_type low_value_care
ok 630 - §4.5: an underuse finding does not keep signal_type low_value_care
  ---
  duration_ms: 0.442666
  type: 'test'
  ...
# Subtest: §4.6 THE REGRESSION THAT MATTERS: an OVERUSE finding is stamped exactly as before
ok 631 - §4.6 THE REGRESSION THAT MATTERS: an OVERUSE finding is stamped exactly as before
  ---
  duration_ms: 0.468125
  type: 'test'
  ...
# Subtest: finding ORDER is preserved by the gate — the report numbers findings by position
ok 632 - finding ORDER is preserved by the gate — the report numbers findings by position
  ---
  duration_ms: 0.348417
  type: 'test'
  ...
# Subtest: direction is stamped BEFORE stampLvcMetadata
ok 633 - direction is stamped BEFORE stampLvcMetadata
  ---
  duration_ms: 0.391042
  type: 'test'
  ...
# Subtest: the contradicted-by-structure neutraliser is GONE (0.81.19) and CODING_GAP_RE is byte-identical
ok 634 - the contradicted-by-structure neutraliser is GONE (0.81.19) and CODING_GAP_RE is byte-identical
  ---
  duration_ms: 0.680333
  type: 'test'
  ...
# Subtest: (1) ADAPTER: dischargeToEncounter → admission encounter, provenance preserved, no fabrication
ok 635 - (1) ADAPTER: dischargeToEncounter → admission encounter, provenance preserved, no fabrication
  ---
  duration_ms: 0.800458
  type: 'test'
  ...
# Subtest: (2) COMPOSITION: flag ON appends the admission at the tail
ok 636 - (2) COMPOSITION: flag ON appends the admission at the tail
  ---
  duration_ms: 0.452458
  type: 'test'
  ...
# Subtest: (3) BYTE-IDENTICAL: the OPD+labs encounters are EXACTLY the frozen output; admission is additive
ok 637 - (3) BYTE-IDENTICAL: the OPD+labs encounters are EXACTLY the frozen output; admission is additive
  ---
  duration_ms: 0.332959
  type: 'test'
  ...
# Subtest: (3) DEFAULT-OFF: flag off (or no episode) ⇒ deep-equal to the frozen assembleEvidence
ok 638 - (3) DEFAULT-OFF: flag off (or no episode) ⇒ deep-equal to the frozen assembleEvidence
  ---
  duration_ms: 0.3265
  type: 'test'
  ...
# Subtest: the adapter reads the spine by TYPE only + composes, never edits (structural)
ok 639 - the adapter reads the spine by TYPE only + composes, never edits (structural)
  ---
  duration_ms: 0.249125
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: a write degrades to "skipped" and a read to null — never a throw
ok 640 - a write degrades to "skipped" and a read to null — never a throw
  ---
  duration_ms: 0.524417
  type: 'test'
  ...
# Subtest: absent and unreachable are the same answer to the reader: extract it yourself
ok 641 - absent and unreachable are the same answer to the reader: extract it yourself
  ---
  duration_ms: 0.063375
  type: 'test'
  ...
# Subtest: rowToStoredCase round-trips a stored row
ok 642 - rowToStoredCase round-trips a stored row
  ---
  duration_ms: 0.378583
  type: 'test'
  ...
# Subtest: a jsonb column handed back as TEXT is tolerated; unusable payloads are refused, not guessed
ok 643 - a jsonb column handed back as TEXT is tolerated; unusable payloads are refused, not guessed
  ---
  duration_ms: 0.139625
  type: 'test'
  ...
# Subtest: the extraction version is a shared constant both readers move on together
ok 644 - the extraction version is a shared constant both readers move on together
  ---
  duration_ms: 0.052833
  type: 'test'
  ...
# [doc-audit-core] normNetValue: unparseable verdict "nonsense" → 'uncertain' (parse fallback, not a clinical judgment)
# Subtest: normDocType maps synonyms + defaults to discharge_summary
ok 645 - normDocType maps synonyms + defaults to discharge_summary
  ---
  duration_ms: 0.60375
  type: 'test'
  ...
# Subtest: normFieldStatus + normNetValue map + default
ok 646 - normFieldStatus + normNetValue map + default
  ---
  duration_ms: 0.562875
  type: 'test'
  ...
# Subtest: parseExtraction reads a fenced extraction, honours docTypeHint, de-id age/sex only, + completeness/adminFacts
ok 647 - parseExtraction reads a fenced extraction, honours docTypeHint, de-id age/sex only, + completeness/adminFacts
  ---
  duration_ms: 0.411375
  type: 'test'
  ...
# Subtest: parseExtraction docTypeHint overrides detected
ok 648 - parseExtraction docTypeHint overrides detected
  ---
  duration_ms: 0.067042
  type: 'test'
  ...
# Subtest: parseExtraction returns null when nothing was read
ok 649 - parseExtraction returns null when nothing was read
  ---
  duration_ms: 0.051917
  type: 'test'
  ...
# Subtest: parseAnalysis parses findings/diff/suggestions (no completeness); maps diff kinds; sorts suggestions
ok 650 - parseAnalysis parses findings/diff/suggestions (no completeness); maps diff kinds; sorts suggestions
  ---
  duration_ms: 0.495375
  type: 'test'
  ...
# Subtest: parseAnalysis returns null on empty/garbage; survives on idealised-only
ok 651 - parseAnalysis returns null on empty/garbage; survives on idealised-only
  ---
  duration_ms: 0.056916
  type: 'test'
  ...
# Subtest: parseStatusList + normAdminFacts: status-only, day-count not dates
ok 652 - parseStatusList + normAdminFacts: status-only, day-count not dates
  ---
  duration_ms: 0.080416
  type: 'test'
  ...
# Subtest: assembleCompleteness scores present/partial/na/missing over non-conditional mandatory fields
ok 653 - assembleCompleteness scores present/partial/na/missing over non-conditional mandatory fields
  ---
  duration_ms: 0.284834
  type: 'test'
  ...
# Subtest: assembleCompleteness counts partial as 0.5 and includes an applicable conditional field
ok 654 - assembleCompleteness counts partial as 0.5 and includes an applicable conditional field
  ---
  duration_ms: 0.289958
  type: 'test'
  ...
# Subtest: PX-R3: OLD-shape extraction (no risk_factors/aftercare) parses with every pre-existing field unchanged + safe defaults for the new keys
ok 655 - PX-R3: OLD-shape extraction (no risk_factors/aftercare) parses with every pre-existing field unchanged + safe defaults for the new keys
  ---
  duration_ms: 0.108708
  type: 'test'
  ...
# Subtest: PX-G2 pin: buildAnalyzeUser includes stated risk factors so safety findings (e.g. allergy breaches) stay visible to the analyze pass
ok 656 - PX-G2 pin: buildAnalyzeUser includes stated risk factors so safety findings (e.g. allergy breaches) stay visible to the analyze pass
  ---
  duration_ms: 0.162
  type: 'test'
  ...
# Subtest: PX-R3: NEW-shape extraction parses risk_factors + aftercare; empty aftercare collapses to undefined
ok 657 - PX-R3: NEW-shape extraction parses risk_factors + aftercare; empty aftercare collapses to undefined
  ---
  duration_ms: 0.116292
  type: 'test'
  ...
# Subtest: enrichQueryForFinding joins subject + evidence + rationale, trims blanks, length-bounds
ok 658 - enrichQueryForFinding joins subject + evidence + rationale, trims blanks, length-bounds
  ---
  duration_ms: 0.078834
  type: 'test'
  ...
# Subtest: unionEnrichedHits keeps base as an identity prefix, dedupes by id, appends net-new, respects cap
ok 659 - unionEnrichedHits keeps base as an identity prefix, dedupes by id, appends net-new, respects cap
  ---
  duration_ms: 0.20775
  type: 'test'
  ...
# Subtest: unionEnrichedHits keys by String(id) — DB returns bigint chunk ids as STRINGS (regression)
ok 660 - unionEnrichedHits keys by String(id) — DB returns bigint chunk ids as STRINGS (regression)
  ---
  duration_ms: 0.108834
  type: 'test'
  ...
# Subtest: SL2: AUDIT_REVISE_SYSTEM carries the empty-citation→estimates discipline for the enriched pool
ok 661 - SL2: AUDIT_REVISE_SYSTEM carries the empty-citation→estimates discipline for the enriched pool
  ---
  duration_ms: 0.066875
  type: 'test'
  ...
# Subtest: applyCitationGate: partial drop keeps evidence + surviving citations
ok 662 - applyCitationGate: partial drop keeps evidence + surviving citations
  ---
  duration_ms: 0.110833
  type: 'test'
  ...
# Subtest: applyCitationGate: dropping ALL citations relabels evidence→estimates (cite-or-label)
ok 663 - applyCitationGate: dropping ALL citations relabels evidence→estimates (cite-or-label)
  ---
  duration_ms: 0.047458
  type: 'test'
  ...
# Subtest: applyCitationGate: no drops → untouched; multi-finding indices are respected
ok 664 - applyCitationGate: no drops → untouched; multi-finding indices are respected
  ---
  duration_ms: 0.048666
  type: 'test'
  ...
# Subtest: applyCitationGate: emptying a finding with NO evidence drops cites without relabel
ok 665 - applyCitationGate: emptying a finding with NO evidence drops cites without relabel
  ---
  duration_ms: 0.092916
  type: 'test'
  ...
# Subtest: §2.3: magic numbers identify the document
ok 666 - §2.3: magic numbers identify the document
  ---
  duration_ms: 1.032708
  type: 'test'
  ...
# Subtest: §2.3: an unsupported body returns NULL — the old code guessed application/pdf
ok 667 - §2.3: an unsupported body returns NULL — the old code guessed application/pdf
  ---
  duration_ms: 0.137084
  type: 'test'
  ...
# Subtest: §2.3: the URL-extension guess is GONE from ccb-brief; the bytes decide and null ⇒ unreadable
ok 668 - §2.3: the URL-extension guess is GONE from ccb-brief; the bytes decide and null ⇒ unreadable
  ---
  duration_ms: 0.092708
  type: 'test'
  ...
# Subtest: §2.3: the Record-audit upload sniffs too — the client mime is only a hint
ok 669 - §2.3: the Record-audit upload sniffs too — the client mime is only a hint
  ---
  duration_ms: 0.045709
  type: 'test'
  ...
# Subtest: §2.1: EXTRACT_SYSTEM demands an explicit marker and FORBIDS empty-fields-as-signal
ok 670 - §2.1: EXTRACT_SYSTEM demands an explicit marker and FORBIDS empty-fields-as-signal
  ---
  duration_ms: 0.0625
  type: 'test'
  ...
# Subtest: §2.1: the marker is honoured, in either shape
ok 671 - §2.1: the marker is honoured, in either shape
  ---
  duration_ms: 0.163
  type: 'test'
  ...
# Subtest: §2.1 THE MEASURED FAILURE: a well-formed all-empty extract is a FAILED READ, not a report
ok 672 - §2.1 THE MEASURED FAILURE: a well-formed all-empty extract is a FAILED READ, not a report
  ---
  duration_ms: 0.155875
  type: 'test'
  ...
# Subtest: §2.1 control: ANY real clinical content survives — one field is enough
ok 673 - §2.1 control: ANY real clinical content survives — one field is enough
  ---
  duration_ms: 0.065875
  type: 'test'
  ...
# Subtest: §2.2: putExtract REFUSES an empty extract, at the write, before the immutable insert
ok 674 - §2.2: putExtract REFUSES an empty extract, at the write, before the immutable insert
  ---
  duration_ms: 0.203958
  type: 'test'
  ...
# Subtest: §1: the PDF engine is native, pinned explicitly — never the default that falls to mistral-ocr
ok 675 - §1: the PDF engine is native, pinned explicitly — never the default that falls to mistral-ocr
  ---
  duration_ms: 0.653458
  type: 'test'
  ...
# Subtest: §4: mistral-ocr appears NOWHERE in the shipped transport
ok 676 - §4: mistral-ocr appears NOWHERE in the shipped transport
  ---
  duration_ms: 0.254584
  type: 'test'
  ...
# Subtest: §3: the Google-only provider pin rides EVERY document call
ok 677 - §3: the Google-only provider pin rides EVERY document call
  ---
  duration_ms: 0.073333
  type: 'test'
  ...
# Subtest: §3: PDFs ride type:file; images ride type:image_url (built, but UNEXERCISED by production traffic)
ok 678 - §3: PDFs ride type:file; images ride type:image_url (built, but UNEXERCISED by production traffic)
  ---
  duration_ms: 0.106458
  type: 'test'
  ...
# Subtest: §3: token headroom — Pro spends output budget on reasoning first
ok 679 - §3: token headroom — Pro spends output budget on reasoning first
  ---
  duration_ms: 0.038583
  type: 'test'
  ...
# Subtest: §3: a TIMEOUT bounds the read — its absence is why Record audit HUNG instead of failing
ok 680 - §3: a TIMEOUT bounds the read — its absence is why Record audit HUNG instead of failing
  ---
  duration_ms: 0.04925
  type: 'test'
  ...
# Subtest: §3: failures surface as provider_error AND as unreadable (null), never as an empty extract
ok 681 - §3: failures surface as provider_error AND as unreadable (null), never as an empty extract
  ---
  duration_ms: 0.058583
  type: 'test'
  ...
# Subtest: §4: the Vertex path is untouched and is what runs with the flag unset
ok 682 - §4: the Vertex path is untouched and is what runs with the flag unset
  ---
  duration_ms: 0.051709
  type: 'test'
  ...
# Subtest: normalizeDoctorName: order-independent, Dr/punct stripped
ok 683 - normalizeDoctorName: order-independent, Dr/punct stripped
  ---
  duration_ms: 0.480958
  type: 'test'
  ...
# Subtest: mobileLast4
ok 684 - mobileLast4
  ---
  duration_ms: 0.107334
  type: 'test'
  ...
# Subtest: isGenericDoctorRow: system/placeholder rows dropped
ok 685 - isGenericDoctorRow: system/placeholder rows dropped
  ---
  duration_ms: 0.167875
  type: 'test'
  ...
# Subtest: buildRoster: drops generics, dedupes same-person by mobile, folds activity
ok 686 - buildRoster: drops generics, dedupes same-person by mobile, folds activity
  ---
  duration_ms: 9.605125
  type: 'test'
  ...
# Subtest: buildRoster: no-mobile rows are never merged with each other
ok 687 - buildRoster: no-mobile rows are never merged with each other
  ---
  duration_ms: 1.853625
  type: 'test'
  ...
# Subtest: parseFrequency: dosing grid sums slots
ok 688 - parseFrequency: dosing grid sums slots
  ---
  duration_ms: 0.876708
  type: 'test'
  ...
# Subtest: parseFrequency: spoken/abbreviated frequencies
ok 689 - parseFrequency: spoken/abbreviated frequencies
  ---
  duration_ms: 0.637792
  type: 'test'
  ...
# Subtest: parseFrequency: SOS is a ceiling, not a fixed dose
ok 690 - parseFrequency: SOS is a ceiling, not a fixed dose
  ---
  duration_ms: 0.129792
  type: 'test'
  ...
# Subtest: parseFrequency: empty/garbage → unknown
ok 691 - parseFrequency: empty/garbage → unknown
  ---
  duration_ms: 0.047542
  type: 'test'
  ...
# Subtest: unitsPerDose
ok 692 - unitsPerDose
  ---
  duration_ms: 0.198708
  type: 'test'
  ...
# Subtest: strengthTokenToMg: unit conversion
ok 693 - strengthTokenToMg: unit conversion
  ---
  duration_ms: 0.12125
  type: 'test'
  ...
# Subtest: canonicalMolecule maps synonyms + ignores non-ceiling co-molecules
ok 694 - canonicalMolecule maps synonyms + ignores non-ceiling co-molecules
  ---
  duration_ms: 0.448625
  type: 'test'
  ...
# Subtest: moleculesOf zips + aligns per-molecule strengths in a combo
ok 695 - moleculesOf zips + aligns per-molecule strengths in a combo
  ---
  duration_ms: 0.224875
  type: 'test'
  ...
# Subtest: moleculesOf: parenthetical strength list in the generic name does not misalign (real EMR shape)
ok 696 - moleculesOf: parenthetical strength list in the generic name does not misalign (real EMR shape)
  ---
  duration_ms: 0.208416
  type: 'test'
  ...
# Subtest: CASE A — paracetamol stacking across products flags an exceedance
ok 697 - CASE A — paracetamol stacking across products flags an exceedance
  ---
  duration_ms: 0.973209
  type: 'test'
  ...
# Subtest: CASE B — a single correctly-dosed NSAID + a different-indication drug does NOT flag
ok 698 - CASE B — a single correctly-dosed NSAID + a different-indication drug does NOT flag
  ---
  duration_ms: 0.085375
  type: 'test'
  ...
# Subtest: single product over its own ceiling still flags (no stacking required)
ok 699 - single product over its own ceiling still flags (no stacking required)
  ---
  duration_ms: 0.134458
  type: 'test'
  ...
# Subtest: SOS-only exceedance is a softer, lower-confidence advisory
ok 700 - SOS-only exceedance is a softer, lower-confidence advisory
  ---
  duration_ms: 0.076375
  type: 'test'
  ...
# Subtest: paediatric liquid/suspension (concentration strength, ml dose) is excluded — no false flag
ok 701 - paediatric liquid/suspension (concentration strength, ml dose) is excluded — no false flag
  ---
  duration_ms: 0.062083
  type: 'test'
  ...
# Subtest: same molecule in two products but within ceiling → informational only
ok 702 - same molecule in two products but within ceiling → informational only
  ---
  duration_ms: 0.061791
  type: 'test'
  ...
# Subtest: BUG-0.8-13: a syrup dosed "10ml (2 tsp)" is volumetric and its volume is never a tablet count
ok 703 - BUG-0.8-13: a syrup dosed "10ml (2 tsp)" is volumetric and its volume is never a tablet count
  ---
  duration_ms: 0.039417
  type: 'test'
  ...
# Subtest: §3.1 parseDurationDays (moved to the pure core) parses days/weeks/months, null for chronic/unparseable
ok 704 - §3.1 parseDurationDays (moved to the pure core) parses days/weeks/months, null for chronic/unparseable
  ---
  duration_ms: 0.216667
  type: 'test'
  ...
# Subtest: Decision 5 — naproxen: 1250 mg over a 1-day course does NOT fire; over 5 days it fires
ok 705 - Decision 5 — naproxen: 1250 mg over a 1-day course does NOT fire; over 5 days it fires
  ---
  duration_ms: 0.179375
  type: 'test'
  ...
# Subtest: Decision 6 — etoricoxib: 120 with gout → no finding; 120 without → fires; 90 without → no finding
ok 706 - Decision 6 — etoricoxib: 120 with gout → no finding; 120 without → fires; 90 without → no finding
  ---
  duration_ms: 0.13275
  type: 'test'
  ...
# Subtest: §4 fail-safe — omitting ctx is identical to passing it for molecules without conditional fields
ok 707 - §4 fail-safe — omitting ctx is identical to passing it for molecules without conditional fields
  ---
  duration_ms: 0.507666
  type: 'test'
  ...
# Subtest: Decision 7/8 — metformin: 500+500 within ceiling → informational (conf 0); 1500+2000 → scoring exceedance (clinician-signed)
ok 708 - Decision 7/8 — metformin: 500+500 within ceiling → informational (conf 0); 1500+2000 → scoring exceedance (clinician-signed)
  ---
  duration_ms: 0.1535
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the 1-Aug regression shape: L-3 with no base praise is VACUOUS, not HOLDS
ok 709 - the 1-Aug regression shape: L-3 with no base praise is VACUOUS, not HOLDS
  ---
  duration_ms: 0.564541
  type: 'test'
  ...
# Subtest: every Part C relation is VACUOUS in the state that makes IT untestable
ok 710 - every Part C relation is VACUOUS in the state that makes IT untestable
  ---
  duration_ms: 0.09875
  type: 'test'
  ...
# Subtest: L-1/L-2 precondition is base fires; L-3 precondition is base praise, not base fires
ok 711 - L-1/L-2 precondition is base fires; L-3 precondition is base praise, not base fires
  ---
  duration_ms: 0.063333
  type: 'test'
  ...
# Subtest: with the precondition met, the verdicts are the relation's own — HOLDS and FAILS both reachable
ok 712 - with the precondition met, the verdicts are the relation's own — HOLDS and FAILS both reachable
  ---
  duration_ms: 0.1295
  type: 'test'
  ...
# Subtest: RATIFIED_AT_ENGINE is pinned to the version the map was measured at — now 0.81.21
ok 713 - RATIFIED_AT_ENGINE is pinned to the version the map was measured at — now 0.81.21
  ---
  duration_ms: 0.047959
  type: 'test'
  ...
# Subtest: the drift warning is null at the deployed engine, and exact when a version differs
ok 714 - the drift warning is null at the deployed engine, and exact when a version differs
  ---
  duration_ms: 0.049917
  type: 'test'
  ...
# Subtest: the panel renders the constant, not a hard-coded version string
ok 715 - the panel renders the constant, not a hard-coded version string
  ---
  duration_ms: 0.240583
  type: 'test'
  ...
# Subtest: RATIFIED_RELATION_STATUS: D-5 stays a pinned failure; D-7 was FIXED and re-ratified
ok 716 - RATIFIED_RELATION_STATUS: D-5 stays a pinned failure; D-7 was FIXED and re-ratified
  ---
  duration_ms: 0.045583
  type: 'test'
  ...
# Subtest: §4.7: opts.engineVersion threads through on the PRODUCTION path, verbatim per the kickoff
ok 717 - §4.7: opts.engineVersion threads through on the PRODUCTION path, verbatim per the kickoff
  ---
  duration_ms: 0.545375
  type: 'test'
  ...
# Subtest: §4.8: absent opts.engineVersion, the production path still yields OPD_ENGINE_VERSION
ok 718 - §4.8: absent opts.engineVersion, the production path still yields OPD_ENGINE_VERSION
  ---
  duration_ms: 0.105875
  type: 'test'
  ...
# Subtest: the MINI path is untouched by the override — and always writes -<tag> (D1, 2 Aug 2026)
ok 719 - the MINI path is untouched by the override — and always writes -<tag> (D1, 2 Aug 2026)
  ---
  duration_ms: 0.127458
  type: 'test'
  ...
# Subtest: AuditOpdOpts declares engineVersion as an optional string
ok 720 - AuditOpdOpts declares engineVersion as an optional string
  ---
  duration_ms: 0.061708
  type: 'test'
  ...
# Subtest: §4.10 THE INVARIANT: updateOpdAudit keys engine_version in WHERE and never SETs it
ok 721 - §4.10 THE INVARIANT: updateOpdAudit keys engine_version in WHERE and never SETs it
  ---
  duration_ms: 0.082083
  type: 'test'
  ...
# Subtest: the re-score path is an UPDATE, never an INSERT — no second row, no double counting
ok 722 - the re-score path is an UPDATE, never an INSERT — no second row, no double counting
  ---
  duration_ms: 0.057666
  type: 'test'
  ...
# Subtest: the doctor read really has no per-uid dedup — which is WHY the invariant matters
ok 723 - the doctor read really has no per-uid dedup — which is WHY the invariant matters
  ---
  duration_ms: 0.176792
  type: 'test'
  ...
# Subtest: §4.9: ?engine= defaults to OPD_ENGINE_VERSION when absent
ok 724 - §4.9: ?engine= defaults to OPD_ENGINE_VERSION when absent
  ---
  duration_ms: 0.036542
  type: 'test'
  ...
# Subtest: the SELECT targets the SOURCE version as a BOUND parameter — unknown ⇒ zero rows, never a throw
ok 725 - the SELECT targets the SOURCE version as a BOUND parameter — unknown ⇒ zero rows, never a throw
  ---
  duration_ms: 0.188125
  type: 'test'
  ...
# Subtest: the same version threads into the audit call, so the UPDATE finds its row
ok 726 - the same version threads into the audit call, so the UPDATE finds its row
  ---
  duration_ms: 0.269792
  type: 'test'
  ...
# Subtest: ?apply=1 remains the ONLY write switch — read-only without it
ok 727 - ?apply=1 remains the ONLY write switch — read-only without it
  ---
  duration_ms: 0.0555
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: toKxEnvelope drops ALL PHI — no sentinel value survives anywhere in the output
ok 728 - toKxEnvelope drops ALL PHI — no sentinel value survives anywhere in the output
  ---
  duration_ms: 0.50375
  type: 'test'
  ...
# Subtest: toKxEnvelope is a WHITELIST — output keys are exactly the non-PHI set
ok 729 - toKxEnvelope is a WHITELIST — output keys are exactly the non-PHI set
  ---
  duration_ms: 0.382583
  type: 'test'
  ...
# Subtest: toKxEnvelope keys on any available link-back id, and returns null when there is none
ok 730 - toKxEnvelope keys on any available link-back id, and returns null when there is none
  ---
  duration_ms: 0.106166
  type: 'test'
  ...
# Subtest: the mapper never spreads the header (a structural guard against future PHI fields)
ok 731 - the mapper never spreads the header (a structural guard against future PHI fields)
  ---
  duration_ms: 0.239792
  type: 'test'
  ...
# Subtest: persist is BEST-EFFORT: never throws, and runs AFTER the audit is saved
ok 732 - persist is BEST-EFFORT: never throws, and runs AFTER the audit is saved
  ---
  duration_ms: 0.264083
  type: 'test'
  ...
# Subtest: the store is idempotent + de-identified (UPSERT on document_id+version, no PHI columns)
ok 733 - the store is idempotent + de-identified (UPSERT on document_id+version, no PHI columns)
  ---
  duration_ms: 0.403958
  type: 'test'
  ...
# Subtest: EpisodeState stays STANDALONE — the namespace never imports ipd-audit
ok 734 - EpisodeState stays STANDALONE — the namespace never imports ipd-audit
  ---
  duration_ms: 0.231375
  type: 'test'
  ...
# Subtest: (timeline reuse) admission events become TimelineItem[] ordered by mergeTimeline (discharge first)
ok 735 - (timeline reuse) admission events become TimelineItem[] ordered by mergeTimeline (discharge first)
  ---
  duration_ms: 8.730834
  type: 'test'
  ...
# Subtest: (timeline reuse) no admission dates ⇒ no timeline rows (undated facts are not forced onto it)
ok 736 - (timeline reuse) no admission dates ⇒ no timeline rows (undated facts are not forced onto it)
  ---
  duration_ms: 0.370125
  type: 'test'
  ...
# Subtest: (facts-only) the render introduces no band/CVI/scored/predicted field or palette
ok 737 - (facts-only) the render introduces no band/CVI/scored/predicted field or palette
  ---
  duration_ms: 0.284667
  type: 'test'
  ...
# Subtest: (read-only) the store read is a SELECT; the page renders it best-effort
ok 738 - (read-only) the store read is a SELECT; the page renders it best-effort
  ---
  duration_ms: 0.200167
  type: 'test'
  ...
# Subtest: projectOpdLinkage is a WHITELIST — no PHI value survives; only ICD/drug/date reach the facts
ok 739 - projectOpdLinkage is a WHITELIST — no PHI value survives; only ICD/drug/date reach the facts
  ---
  duration_ms: 0.811209
  type: 'test'
  ...
# Subtest: the projector never reads a PHI field name (structural guard against a future column)
ok 740 - the projector never reads a PHI field name (structural guard against a future column)
  ---
  duration_ms: 0.250875
  type: 'test'
  ...
# Subtest: the builder fills pre/post from the OPD linkage — reported facts, no fabrication
ok 741 - the builder fills pre/post from the OPD linkage — reported facts, no fabrication
  ---
  duration_ms: 1.943042
  type: 'test'
  ...
# Subtest: the unlinked tail is graceful — null/empty OPD linkage ⇒ empty pre/post, never an error
ok 742 - the unlinked tail is graceful — null/empty OPD linkage ⇒ empty pre/post, never an error
  ---
  duration_ms: 1.396709
  type: 'test'
  ...
# Subtest: the committed recon gold is frozen, ratified, and hash-pinned
ok 743 - the committed recon gold is frozen, ratified, and hash-pinned
  ---
  duration_ms: 0.650167
  type: 'test'
  ...
# Subtest: the gold carries V's genuine verdicts: all 70 faithful, NO negative examples (CC test posts excluded)
ok 744 - the gold carries V's genuine verdicts: all 70 faithful, NO negative examples (CC test posts excluded)
  ---
  duration_ms: 0.484041
  type: 'test'
  ...
# Subtest: the gold spans strata (speciality + linked/intra-only)
ok 745 - the gold spans strata (speciality + linked/intra-only)
  ---
  duration_ms: 0.104666
  type: 'test'
  ...
# Subtest: the recon gold is de-identified: no UHID / phone / honorific-name / URL anywhere
ok 746 - the recon gold is de-identified: no UHID / phone / honorific-name / URL anywhere
  ---
  duration_ms: 0.320708
  type: 'test'
  ...
# Subtest: loadEpisodeReconGold rejects drift: edited verdict, wrong version/status/validator, dup id, bad verdict/phase
ok 747 - loadEpisodeReconGold rejects drift: edited verdict, wrong version/status/validator, dup id, bad verdict/phase
  ---
  duration_ms: 0.40825
  type: 'test'
  ...
# Subtest: (1) SEPARATION: ratings go to episode_recon_ratings, never the other adjudication stores
ok 748 - (1) SEPARATION: ratings go to episode_recon_ratings, never the other adjudication stores
  ---
  duration_ms: 0.554875
  type: 'test'
  ...
# Subtest: (2) VOCABULARY: exactly the four fidelity verdicts and three phases
ok 749 - (2) VOCABULARY: exactly the four fidelity verdicts and three phases
  ---
  duration_ms: 0.474792
  type: 'test'
  ...
# Subtest: (3) READ-ONLY: the queue reads the persisted episode, never re-builds/re-extracts
ok 750 - (3) READ-ONLY: the queue reads the persisted episode, never re-builds/re-extracts
  ---
  duration_ms: 0.888125
  type: 'test'
  ...
# Subtest: (4) DE-IDENTIFIED: the store has no PHI/URL column; the PDF is read-time only
ok 751 - (4) DE-IDENTIFIED: the store has no PHI/URL column; the PDF is read-time only
  ---
  duration_ms: 0.774958
  type: 'test'
  ...
# Subtest: (1) SCHEMA: the built object validates as the current version; pre/post empty without OPD
ok 752 - (1) SCHEMA: the built object validates as the current version; pre/post empty without OPD
  ---
  duration_ms: 2.717458
  type: 'test'
  ...
# Subtest: (2) NO FABRICATION: every emitted fact traces to a verbatim substring of its source
ok 753 - (2) NO FABRICATION: every emitted fact traces to a verbatim substring of its source
  ---
  duration_ms: 0.2575
  type: 'test'
  ...
# Subtest: (2b) NO FABRICATION: a fact whose rawText is NOT in its source is DROPPED, never invented
ok 754 - (2b) NO FABRICATION: a fact whose rawText is NOT in its source is DROPPED, never invented
  ---
  duration_ms: 0.207375
  type: 'test'
  ...
# Subtest: (3) DETERMINISM: identical inputs give byte-identical output
ok 755 - (3) DETERMINISM: identical inputs give byte-identical output
  ---
  duration_ms: 0.118833
  type: 'test'
  ...
# Subtest: (4) FACTS-ONLY + DE-IDENTIFIED: no score/prediction field, no PHI, no URL anywhere
ok 756 - (4) FACTS-ONLY + DE-IDENTIFIED: no score/prediction field, no PHI, no URL anywhere
  ---
  duration_ms: 0.140792
  type: 'test'
  ...
# Subtest: the schema source itself carries no score/prediction vocabulary (facts-only by construction)
ok 757 - the schema source itself carries no score/prediction vocabulary (facts-only by construction)
  ---
  duration_ms: 0.309292
  type: 'test'
  ...
# Subtest: counts helper reflects the populated intra + empty pre/post
ok 758 - counts helper reflects the populated intra + empty pre/post
  ---
  duration_ms: 0.09675
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: error_type reads the response body error taxonomy — type beats code beats metadata
ok 759 - error_type reads the response body error taxonomy — type beats code beats metadata
  ---
  duration_ms: 0.662333
  type: 'test'
  ...
# Subtest: error_type is null when absent, and envelope capture is still TOTAL on junk
ok 760 - error_type is null when absent, and envelope capture is still TOTAL on junk
  ---
  duration_ms: 0.195583
  type: 'test'
  ...
# Subtest: withEnvelope attaches both envelope and error_type; null-safe
ok 761 - withEnvelope attaches both envelope and error_type; null-safe
  ---
  duration_ms: 0.082625
  type: 'test'
  ...
# Subtest: 3× EMPTY CONTENT: the final throw carries the last real envelope, not a truncated string
ok 762 - 3× EMPTY CONTENT: the final throw carries the last real envelope, not a truncated string
  ---
  duration_ms: 11.5265
  type: 'test'
  ...
# Subtest: non-retryable HTTP: the envelope is read FROM THE ERROR BODY, taxonomy included
ok 763 - non-retryable HTTP: the envelope is read FROM THE ERROR BODY, taxonomy included
  ---
  duration_ms: 0.75675
  type: 'test'
  ...
# Subtest: 3× transport failure: envelope attached (empty is honest — nothing came off the wire)
ok 764 - 3× transport failure: envelope attached (empty is honest — nothing came off the wire)
  ---
  duration_ms: 0.766167
  type: 'test'
  ...
# Subtest: deadline throws carry the envelope too — the tombstone must never lose the R2 evidence
ok 765 - deadline throws carry the envelope too — the tombstone must never lose the R2 evidence
  ---
  duration_ms: 0.991667
  type: 'test'
  ...
# Subtest: the success path is untouched — no envelope property on a returned string
ok 766 - the success path is untouched — no envelope property on a returned string
  ---
  duration_ms: 0.507917
  type: 'test'
  ...
# Subtest: the guard messages are EXACTLY the §4 normative strings
ok 767 - the guard messages are EXACTLY the §4 normative strings
  ---
  duration_ms: 0.22825
  type: 'test'
  ...
# Subtest: the guards sit at the CALL SITE, gated on opts.evalModel, in the §4 order
ok 768 - the guards sit at the CALL SITE, gated on opts.evalModel, in the §4 order
  ---
  duration_ms: 0.368208
  type: 'test'
  ...
# Subtest: PRODUCTION IS BYTE-IDENTICAL: evalModel absent keeps the lenient parse exactly
ok 769 - PRODUCTION IS BYTE-IDENTICAL: evalModel absent keeps the lenient parse exactly
  ---
  duration_ms: 0.188708
  type: 'test'
  ...
# Subtest: parseAttemptsState: absent, malformed, or another experiment ⇒ EMPTY, never an error
ok 770 - parseAttemptsState: absent, malformed, or another experiment ⇒ EMPTY, never an error
  ---
  duration_ms: 0.494041
  type: 'test'
  ...
# Subtest: parseAttemptsState round-trips a real map and sanitises junk counters
ok 771 - parseAttemptsState round-trips a real map and sanitises junk counters
  ---
  duration_ms: 0.136333
  type: 'test'
  ...
# Subtest: THE D4 RULE: a deadline abandonment increments deadline_abandons and NEVER failures
ok 772 - THE D4 RULE: a deadline abandonment increments deadline_abandons and NEVER failures
  ---
  duration_ms: 0.138
  type: 'test'
  ...
# Subtest: terminal failures budget to the tombstone at exactly 3, evidence carried
ok 773 - terminal failures budget to the tombstone at exactly 3, evidence carried
  ---
  duration_ms: 0.072417
  type: 'test'
  ...
# Subtest: mixed history: abandons interleaved with failures — only the failures count
ok 774 - mixed history: abandons interleaved with failures — only the failures count
  ---
  duration_ms: 0.108792
  type: 'test'
  ...
# Subtest: the budget is PAID-BRANCH ONLY and its read degrades to empty, never throws
ok 775 - the budget is PAID-BRANCH ONLY and its read degrades to empty, never throws
  ---
  duration_ms: 0.077791
  type: 'test'
  ...
# Subtest: doneUids has NO kind filter — a tombstone row makes the uid done, so the batch can finish
ok 776 - doneUids has NO kind filter — a tombstone row makes the uid done, so the batch can finish
  ---
  duration_ms: 0.039583
  type: 'test'
  ...
# Subtest: the tombstone is written INSTEAD of attempting, with the D5 payload, kind eval_failed
ok 777 - the tombstone is written INSTEAD of attempting, with the D5 payload, kind eval_failed
  ---
  duration_ms: 0.059708
  type: 'test'
  ...
# Subtest: the summary gains tombstoned + failed_uids, inside the eval-only spread
ok 778 - the summary gains tombstoned + failed_uids, inside the eval-only spread
  ---
  duration_ms: 0.044833
  type: 'test'
  ...
# Subtest: lab-batch-core is untouched: constants, drainPlan, locks all stand
ok 779 - lab-batch-core is untouched: constants, drainPlan, locks all stand
  ---
  duration_ms: 0.0545
  type: 'test'
  ...
# Subtest: the attempts key is the documented name and OPENROUTER_TIMEOUT_MS did not move
ok 780 - the attempts key is the documented name and OPENROUTER_TIMEOUT_MS did not move
  ---
  duration_ms: 0.132584
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: remainingBudgetMs is pure, floors at 0, and never returns a negative
ok 781 - remainingBudgetMs is pure, floors at 0, and never returns a negative
  ---
  duration_ms: 0.565833
  type: 'test'
  ...
# Subtest: EVAL_TICK_DEADLINE_MS defaults to 240s and is env-overridable
ok 782 - EVAL_TICK_DEADLINE_MS defaults to 240s and is env-overridable
  ---
  duration_ms: 0.10425
  type: 'test'
  ...
# Subtest: the two tuned numbers are consistent: a note can spend its whole retry budget inside a tick
ok 783 - the two tuned numbers are consistent: a note can spend its whole retry budget inside a tick
  ---
  duration_ms: 0.069666
  type: 'test'
  ...
# Subtest: THE FIX: an already-blown deadline throws BEFORE attempt 1 — no fetch, no sleep
ok 784 - THE FIX: an already-blown deadline throws BEFORE attempt 1 — no fetch, no sleep
  ---
  duration_ms: 0.7415
  type: 'test'
  ...
# Subtest: the deadline is checked before EVERY attempt, not just the first
ok 785 - the deadline is checked before EVERY attempt, not just the first
  ---
  duration_ms: 97.646333
  type: 'test'
  ...
# Subtest: a note that FINISHES inside its budget is completely unaffected
ok 786 - a note that FINISHES inside its budget is completely unaffected
  ---
  duration_ms: 2.125791
  type: 'test'
  ...
# Subtest: a backoff that would cross the deadline throws NOW rather than sleeping through it
ok 787 - a backoff that would cross the deadline throws NOW rather than sleeping through it
  ---
  duration_ms: 0.560167
  type: 'test'
  ...
# Subtest: the deadline error carries the LAST envelope — it is the only surviving record
ok 788 - the deadline error carries the LAST envelope — it is the only surviving record
  ---
  duration_ms: 0.32425
  type: 'test'
  ...
# Subtest: with no envelope yet, every field reads null rather than the message failing to build
ok 789 - with no envelope yet, every field reads null rather than the message failing to build
  ---
  duration_ms: 0.164916
  type: 'test'
  ...
# Subtest: the deadline message is EXACTLY the three normative lines
ok 790 - the deadline message is EXACTLY the three normative lines
  ---
  duration_ms: 0.281708
  type: 'test'
  ...
# Subtest: the prefix the tick counts on is defined once, beside the builder
ok 791 - the prefix the tick counts on is defined once, beside the builder
  ---
  duration_ms: 0.068625
  type: 'test'
  ...
# Subtest: a deadline hit is NOT confused with the empty-content failure — they are different faults
ok 792 - a deadline hit is NOT confused with the empty-content failure — they are different faults
  ---
  duration_ms: 0.620375
  type: 'test'
  ...
# Subtest: the AbortController timeout is clamped to the remaining budget when a deadline is present
ok 793 - the AbortController timeout is clamped to the remaining budget when a deadline is present
  ---
  duration_ms: 0.167167
  type: 'test'
  ...
# Subtest: the clamped timeout is REPORTED in the timeout message, so the log is truthful
ok 794 - the clamped timeout is REPORTED in the timeout message, so the log is truthful
  ---
  duration_ms: 55.080292
  type: 'test'
  ...
# Subtest: THE SAFETY PROPERTY: with deadlineAt absent, nothing about the retry loop changes
ok 795 - THE SAFETY PROPERTY: with deadlineAt absent, nothing about the retry loop changes
  ---
  duration_ms: 1.675667
  type: 'test'
  ...
# Subtest: deadlineAt is APPENDED — every existing positional call site still binds correctly
ok 796 - deadlineAt is APPENDED — every existing positional call site still binds correctly
  ---
  duration_ms: 1.486292
  type: 'test'
  ...
# Subtest: auditOpdNote threads opts.deadlineAt and nothing else changed on the call
ok 797 - auditOpdNote threads opts.deadlineAt and nothing else changed on the call
  ---
  duration_ms: 0.363459
  type: 'test'
  ...
# Subtest: batchTick computes the deadline ONCE, from tickStart, and only in eval mode
ok 798 - batchTick computes the deadline ONCE, from tickStart, and only in eval mode
  ---
  duration_ms: 0.365167
  type: 'test'
  ...
# Subtest: THE MINI BRANCH IS BYTE-IDENTICAL — it never receives a deadline
ok 799 - THE MINI BRANCH IS BYTE-IDENTICAL — it never receives a deadline
  ---
  duration_ms: 0.187375
  type: 'test'
  ...
# Subtest: D3: the bounded pool is AWAITED, never raced — racing recreates the bed1449 duplicate rows
ok 800 - D3: the bounded pool is AWAITED, never raced — racing recreates the bed1449 duplicate rows
  ---
  duration_ms: 0.122916
  type: 'test'
  ...
# Subtest: deadline_hits counts deadline errors and nothing else
ok 801 - deadline_hits counts deadline errors and nothing else
  ---
  duration_ms: 0.137584
  type: 'test'
  ...
# Subtest: drainPlan, labLockHeld, ttlBreach and LB_LOCK_TTL_MS are untouched
ok 802 - drainPlan, labLockHeld, ttlBreach and LB_LOCK_TTL_MS are untouched
  ---
  duration_ms: 0.166625
  type: 'test'
  ...
# Subtest: the eval deadline never reaches a production audit path
ok 803 - the eval deadline never reaches a production audit path
  ---
  duration_ms: 2.878083
  type: 'test'
  ...
# Subtest: normalizeConceptSubject is byte-identical to the house normalizeSubject
ok 804 - normalizeConceptSubject is byte-identical to the house normalizeSubject
  ---
  duration_ms: 0.724542
  type: 'test'
  ...
# Subtest: normalizeSlot strips inner colons so a slot can never inject an extra id segment
ok 805 - normalizeSlot strips inner colons so a slot can never inject an extra id segment
  ---
  duration_ms: 0.112209
  type: 'test'
  ...
# Subtest: composeConceptId builds direction:action:target and refuses a bad direction or blank action
ok 806 - composeConceptId builds direction:action:target and refuses a bad direction or blank action
  ---
  duration_ms: 0.092333
  type: 'test'
  ...
# Subtest: §3.1 sentinel: an empty target composes to :regimen with a valid direction + action
ok 807 - §3.1 sentinel: an empty target composes to :regimen with a valid direction + action
  ---
  duration_ms: 0.08325
  type: 'test'
  ...
# Subtest: §3.1 the named case: overuse:polypharmacy: ⇒ overuse:polypharmacy:regimen
ok 808 - §3.1 the named case: overuse:polypharmacy: ⇒ overuse:polypharmacy:regimen
  ---
  duration_ms: 0.050375
  type: 'test'
  ...
# Subtest: §3.1 the sentinel is NOT a catch-all: exclude_test_note is still rejected, never routed to it
ok 809 - §3.1 the sentinel is NOT a catch-all: exclude_test_note is still rejected, never routed to it
  ---
  duration_ms: 0.165167
  type: 'test'
  ...
# Subtest: §3.1 the sentinel is NOT a catch-all: an out-of-vocabulary direction is still rejected
ok 810 - §3.1 the sentinel is NOT a catch-all: an out-of-vocabulary direction is still rejected
  ---
  duration_ms: 0.107958
  type: 'test'
  ...
# Subtest: §3.1 the sentinel recovers ONLY an empty target — a blank ACTION is still a reject
ok 811 - §3.1 the sentinel recovers ONLY an empty target — a blank ACTION is still a reject
  ---
  duration_ms: 0.04925
  type: 'test'
  ...
# Subtest: §3.1 an extraction with an empty target validates to the sentinel, slots and id agreeing
ok 812 - §3.1 an extraction with an empty target validates to the sentinel, slots and id agreeing
  ---
  duration_ms: 0.212125
  type: 'test'
  ...
# Subtest: §3.1 review_lane computes normally for a sentinel concept
ok 813 - §3.1 review_lane computes normally for a sentinel concept
  ---
  duration_ms: 0.276833
  type: 'test'
  ...
# Subtest: baseConceptId folds a context-qualified id onto its base
ok 814 - baseConceptId folds a context-qualified id onto its base
  ---
  duration_ms: 0.04875
  type: 'test'
  ...
# Subtest: the direction vocabulary is closed to exactly the four structural values
ok 815 - the direction vocabulary is closed to exactly the four structural values
  ---
  duration_ms: 0.329958
  type: 'test'
  ...
# Subtest: §7 formulary guard: a "cbc" brand-TOKEN match does not resolve to pralidoxime
ok 816 - §7 formulary guard: a "cbc" brand-TOKEN match does not resolve to pralidoxime
  ---
  duration_ms: 0.154167
  type: 'test'
  ...
# Subtest: §7 stage order: the collapse rule runs AFTER formulary resolution
ok 817 - §7 stage order: the collapse rule runs AFTER formulary resolution
  ---
  duration_ms: 0.050833
  type: 'test'
  ...
# Subtest: a resolver that throws never loses the literal target
ok 818 - a resolver that throws never loses the literal target
  ---
  duration_ms: 0.050958
  type: 'test'
  ...
# Subtest: §9 known-answer: every montelukast-bearing string resolves to overuse:rx:montelukast_containing
ok 819 - §9 known-answer: every montelukast-bearing string resolves to overuse:rx:montelukast_containing
  ---
  duration_ms: 0.121167
  type: 'test'
  ...
# Subtest: §9 review_lane: clean for montelukast (0 contexts), context for antibiotic (163 contexts)
ok 820 - §9 review_lane: clean for montelukast (0 contexts), context for antibiotic (163 contexts)
  ---
  duration_ms: 0.033833
  type: 'test'
  ...
# Subtest: review_lane is a deterministic threshold on the context-free VOLUME share
ok 821 - review_lane is a deterministic threshold on the context-free VOLUME share
  ---
  duration_ms: 0.036042
  type: 'test'
  ...
# Subtest: §9: a valid extraction composes; context is optional and normalised
ok 822 - §9: a valid extraction composes; context is optional and normalised
  ---
  duration_ms: 0.051584
  type: 'test'
  ...
# Subtest: §9: unparseable extraction ⇒ reject, no stamp
ok 823 - §9: unparseable extraction ⇒ reject, no stamp
  ---
  duration_ms: 0.071375
  type: 'test'
  ...
# Subtest: §9: a direction outside the closed vocabulary is rejected, never coerced
ok 824 - §9: a direction outside the closed vocabulary is rejected, never coerced
  ---
  duration_ms: 0.034125
  type: 'test'
  ...
# Subtest: a missing ACTION is a reject, not a partial stamp; a missing TARGET takes the §3.1 sentinel
ok 825 - a missing ACTION is a reject, not a partial stamp; a missing TARGET takes the §3.1 sentinel
  ---
  duration_ms: 0.039375
  type: 'test'
  ...
# Subtest: a ```json fence is tolerated; nothing else is repaired
ok 826 - a ```json fence is tolerated; nothing else is repaired
  ---
  duration_ms: 0.037417
  type: 'test'
  ...
# Subtest: §9 exact-lookup hit stamps the seeded concept with ZERO model calls
ok 827 - §9 exact-lookup hit stamps the seeded concept with ZERO model calls
  ---
  duration_ms: 0.097791
  type: 'test'
  ...
# Subtest: a lookup miss leaves the finding byte-identical (PRD §7 fail-safe)
ok 828 - a lookup miss leaves the finding byte-identical (PRD §7 fail-safe)
  ---
  duration_ms: 1.788542
  type: 'test'
  ...
# Subtest: an already-coded finding is never re-stamped (a string is extracted once, ever)
ok 829 - an already-coded finding is never re-stamped (a string is extracted once, ever)
  ---
  duration_ms: 0.070625
  type: 'test'
  ...
# Subtest: only low-value, non-informational findings are codable
ok 830 - only low-value, non-informational findings are codable
  ---
  duration_ms: 0.130083
  type: 'test'
  ...
# Subtest: a throwing lookup never throws out of stampConcepts
ok 831 - a throwing lookup never throws out of stampConcepts
  ---
  duration_ms: 0.054625
  type: 'test'
  ...
# Subtest: pendingSubjects dedupes, skips coded/uncodable, and honours the known-set
ok 832 - pendingSubjects dedupes, skips coded/uncodable, and honours the known-set
  ---
  duration_ms: 0.089541
  type: 'test'
  ...
# Subtest: §9 cache miss → extract once → cached; a repeated string makes NO second call
ok 833 - §9 cache miss → extract once → cached; a repeated string makes NO second call
  ---
  duration_ms: 0.227875
  type: 'test'
  ...
# Subtest: CONCEPT_CRON_MIN matches the schedule in vercel.json (the panel renders this number)
ok 834 - CONCEPT_CRON_MIN matches the schedule in vercel.json (the panel renders this number)
  ---
  duration_ms: 0.408667
  type: 'test'
  ...
# Subtest: deriveConceptState: disabled outranks paused outranks pending work
ok 835 - deriveConceptState: disabled outranks paused outranks pending work
  ---
  duration_ms: 0.052625
  type: 'test'
  ...
# Subtest: codedPct is a clamped percentage, null when the denominator is unknown or zero
ok 836 - codedPct is a clamped percentage, null when the denominator is unknown or zero
  ---
  duration_ms: 0.048791
  type: 'test'
  ...
# Subtest: cacheHitPct is the share of stamps needing no model call; null before anything is stamped
ok 837 - cacheHitPct is the share of stamps needing no model call; null before anything is stamped
  ---
  duration_ms: 0.081333
  type: 'test'
  ...
# Subtest: rejectedRecent sums across ticks and is 0 (never null) so the tile always renders a number
ok 838 - rejectedRecent sums across ticks and is 0 (never null) so the tile always renders a number
  ---
  duration_ms: 0.045375
  type: 'test'
  ...
# Subtest: buildConceptStatus shapes the payload and carries all four per-tick counts through
ok 839 - buildConceptStatus shapes the payload and carries all four per-tick counts through
  ---
  duration_ms: 0.095209
  type: 'test'
  ...
# Subtest: ZERO-STATE renders honestly: seed loaded, no ticks, nothing stamped
ok 840 - ZERO-STATE renders honestly: seed loaded, no ticks, nothing stamped
  ---
  duration_ms: 0.057333
  type: 'test'
  ...
# Subtest: a fully-degraded payload (every aggregate null) still shapes without throwing
ok 841 - a fully-degraded payload (every aggregate null) still shapes without throwing
  ---
  duration_ms: 0.03825
  type: 'test'
  ...
# Subtest: the disabled state is reachable and keeps its counts (the panel explains itself)
ok 842 - the disabled state is reachable and keeps its counts (the panel explains itself)
  ---
  duration_ms: 0.035916
  type: 'test'
  ...
# Subtest: §9 score-invariance: stamping 240 audits changes no headline, band, domain score or confidence
ok 843 - §9 score-invariance: stamping 240 audits changes no headline, band, domain score or confidence
  ---
  duration_ms: 7.91925
  type: 'test'
  ...
# Subtest: §3 score-invariance, structurally: stamping adds exactly two keys and mutates nothing else
ok 844 - §3 score-invariance, structurally: stamping adds exactly two keys and mutates nothing else
  ---
  duration_ms: 0.339208
  type: 'test'
  ...
# Subtest: findingKey is deterministic + stable across normalized subject variants; distinct on real change
ok 845 - findingKey is deterministic + stable across normalized subject variants; distinct on real change
  ---
  duration_ms: 0.7555
  type: 'test'
  ...
# Subtest: subjectHash is subject-sensitive (cache miss on a re-worded finding)
ok 846 - subjectHash is subject-sensitive (cache miss on a re-worded finding)
  ---
  duration_ms: 0.126584
  type: 'test'
  ...
# Subtest: isNoteStale: no watermark OR watermark < epoch ⇒ stale
ok 847 - isNoteStale: no watermark OR watermark < epoch ⇒ stale
  ---
  duration_ms: 0.056583
  type: 'test'
  ...
# Subtest: stripRetiredEvenCitations drops retired even-lvc citations, renumbers refs, keeps CW/guideline/other intact
ok 848 - stripRetiredEvenCitations drops retired even-lvc citations, renumbers refs, keeps CW/guideline/other intact
  ---
  duration_ms: 0.477
  type: 'test'
  ...
# Subtest: stripRetiredEvenCitations is a byte-identical no-op when nothing is retired / no retired source present
ok 849 - stripRetiredEvenCitations is a byte-identical no-op when nothing is retired / no retired source present
  ---
  duration_ms: 0.061583
  type: 'test'
  ...
# Subtest: stripRetiredEvenCitations never touches non-even citations even if their id collides numerically
ok 850 - stripRetiredEvenCitations never touches non-even citations even if their id collides numerically
  ---
  duration_ms: 0.099458
  type: 'test'
  ...
# Subtest: deriveGroundState precedence: disabled > paused > draining > idle
ok 851 - deriveGroundState precedence: disabled > paused > draining > idle
  ---
  duration_ms: 0.059334
  type: 'test'
  ...
# Subtest: drainPct + drainEtaMinutes
ok 852 - drainPct + drainEtaMinutes
  ---
  duration_ms: 0.064083
  type: 'test'
  ...
# Subtest: buildGroundStatus shapes the payload + derives state/drain_pct
ok 853 - buildGroundStatus shapes the payload + derives state/drain_pct
  ---
  duration_ms: 0.179834
  type: 'test'
  ...
# Subtest: formatAgo: seconds / minutes / hours / days; UTC-assumed; malformed ⇒ —
ok 854 - formatAgo: seconds / minutes / hours / days; UTC-assumed; malformed ⇒ —
  ---
  duration_ms: 0.351333
  type: 'test'
  ...
# Subtest: nextTickInSec: (0, everyMin*60]; wraps at the boundary
ok 855 - nextTickInSec: (0, everyMin*60]; wraps at the boundary
  ---
  duration_ms: 0.106084
  type: 'test'
  ...
# Subtest: score-invariance: stripRetiredEvenCitations preserves every non-citation finding field
ok 856 - score-invariance: stripRetiredEvenCitations preserves every non-citation finding field
  ---
  duration_ms: 0.080042
  type: 'test'
  ...
# Subtest: buildDigest qualifies at the CATEGORY grain (≥ CAT_MIN total), drops singletons, emits ONLY {subject,count} + total
ok 857 - buildDigest qualifies at the CATEGORY grain (≥ CAT_MIN total), drops singletons, emits ONLY {subject,count} + total
  ---
  duration_ms: 0.999666
  type: 'test'
  ...
# Subtest: buildDigest: a FRAGMENTED category qualifies on TOTAL even when no single subject hits the old ≥20 floor (§1.1 core fix)
ok 858 - buildDigest: a FRAGMENTED category qualifies on TOTAL even when no single subject hits the old ≥20 floor (§1.1 core fix)
  ---
  duration_ms: 6.966375
  type: 'test'
  ...
# Subtest: buildDigest: topK truncates to the highest-count exemplars
ok 859 - buildDigest: topK truncates to the highest-count exemplars
  ---
  duration_ms: 0.132333
  type: 'test'
  ...
# Subtest: normalizeSubject collapses casing/whitespace/trailing period
ok 860 - normalizeSubject collapses casing/whitespace/trailing period
  ---
  duration_ms: 0.120375
  type: 'test'
  ...
# Subtest: isDuplicateCandidate drops same-category text-eq / cosine≥0.90, incl. against rejected; keeps cross-category
ok 861 - isDuplicateCandidate drops same-category text-eq / cosine≥0.90, incl. against rejected; keeps cross-category
  ---
  duration_ms: 0.216958
  type: 'test'
  ...
# Subtest: dedupeCandidates removes intra-batch dupes and caps
ok 862 - dedupeCandidates removes intra-batch dupes and caps
  ---
  duration_ms: 0.191208
  type: 'test'
  ...
# Subtest: rollupContests counts per assertion and flips ONLY active→contested at ≥ flag; never auto-retires
ok 863 - rollupContests counts per assertion and flips ONLY active→contested at ≥ flag; never auto-retires
  ---
  duration_ms: 0.212917
  type: 'test'
  ...
# Subtest: computeOwnCases true only when ratifier name is among the supporting doctor_uids
ok 864 - computeOwnCases true only when ratifier name is among the supporting doctor_uids
  ---
  duration_ms: 0.061958
  type: 'test'
  ...
# Subtest: id-ordinal: elv-<category>-<padded>, per-category, monotone; batch ids do not collide
ok 865 - id-ordinal: elv-<category>-<padded>, per-category, monotone; batch ids do not collide
  ---
  duration_ms: 0.347625
  type: 'test'
  ...
# Subtest: parseCandidatesJson: tolerant of fences/prose/object-wrap; drops malformed + hallucinated categories
ok 866 - parseCandidatesJson: tolerant of fences/prose/object-wrap; drops malformed + hallucinated categories
  ---
  duration_ms: 2.421125
  type: 'test'
  ...
# Subtest: evenGenUserMessage only references shown categories/subjects + surfaces the category total (§1.1)
ok 867 - evenGenUserMessage only references shown categories/subjects + surfaces the category total (§1.1)
  ---
  duration_ms: 0.163208
  type: 'test'
  ...
# Subtest: isRunStale: a fresh run is not stale; a >10-min run is; a malformed timestamp is safe-false (§1.2)
ok 868 - isRunStale: a fresh run is not stale; a >10-min run is; a malformed timestamp is safe-false (§1.2)
  ---
  duration_ms: 0.080042
  type: 'test'
  ...
# Subtest: evenChunkSection / normalizeAssertionText helpers
ok 869 - evenChunkSection / normalizeAssertionText helpers
  ---
  duration_ms: 0.05525
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: guard.1 — the connection guard refuses a non-loopback host, synchronously, naming the host
ok 870 - guard.1 — the connection guard refuses a non-loopback host, synchronously, naming the host
  ---
  duration_ms: 123.069542
  type: 'test'
  ...
# Subtest: 5.2 — recording is OFF by default: no observation is stored and the counter does not advance
ok 871 - 5.2 — recording is OFF by default: no observation is stored and the counter does not advance
  ---
  duration_ms: 2.781708
  type: 'test'
  ...
# Subtest: 5.2b — MID-FLIGHT TOGGLE off→on: a request accepted while recording was off produces NO observation, and the in-flight count returns to zero
ok 872 - 5.2b — MID-FLIGHT TOGGLE off→on: a request accepted while recording was off produces NO observation, and the in-flight count returns to zero
  ---
  duration_ms: 2.758041
  type: 'test'
  ...
# Subtest: 5.2b-fail — 5.2b's FAILURE PATH: when the acceptance wait rejects, the SHARED bounded cleanup destroys the request, awaits its termination, rethrows the original wait error, and the NEXT shared-server request succeeds
ok 873 - 5.2b-fail — 5.2b's FAILURE PATH: when the acceptance wait rejects, the SHARED bounded cleanup destroys the request, awaits its termination, rethrows the original wait error, and the NEXT shared-server request succeeds
  ---
  duration_ms: 5.863125
  type: 'test'
  ...
# Subtest: 5.2c — MID-FLIGHT TOGGLE on→off: a request accepted while recording was on produces a COMPLETE observation with a real seq, and the in-flight count returns to zero
ok 874 - 5.2c — MID-FLIGHT TOGGLE on→off: a request accepted while recording was on produces a COMPLETE observation with a real seq, and the in-flight count returns to zero
  ---
  duration_ms: 1.014208
  type: 'test'
  ...
# Subtest: 5.2d — OVERSIZED MID-FLIGHT TOGGLE on→off: 1048577 bytes, one before acceptance and 1048576 after recording is turned off, is still REJECTED with 413 and recorded as one overflowed observation
ok 875 - 5.2d — OVERSIZED MID-FLIGHT TOGGLE on→off: 1048577 bytes, one before acceptance and 1048576 after recording is turned off, is still REJECTED with 413 and recorded as one overflowed observation
  ---
  duration_ms: 1.364292
  type: 'test'
  ...
# Subtest: 5.3 — one observation holds seq, socketId, method, path, and the exact body bytes; nothing else
ok 876 - 5.3 — one observation holds seq, socketId, method, path, and the exact body bytes; nothing else
  ---
  duration_ms: 1.083958
  type: 'test'
  ...
# Subtest: 5.4 — sequence numbers are assigned at ACCEPTANCE, monotonic from 0, and never reused
ok 877 - 5.4 — sequence numbers are assigned at ACCEPTANCE, monotonic from 0, and never reused
  ---
  duration_ms: 6.043709
  type: 'test'
  ...
# Subtest: 5.5a — the boundary: 1048576 bytes is ACCEPTED and recorded in full
ok 878 - 5.5a — the boundary: 1048576 bytes is ACCEPTED and recorded in full
  ---
  duration_ms: 3.078917
  type: 'test'
  ...
# Subtest: 5.5b — the boundary: 1048577 bytes is REJECTED with 413, an empty JSON body, an overflowed observation, and the SAME undestroyed socket carries the next request
ok 879 - 5.5b — the boundary: 1048577 bytes is REJECTED with 413, an empty JSON body, an overflowed observation, and the SAME undestroyed socket carries the next request
  ---
  duration_ms: 4.729333
  type: 'test'
  ...
# Subtest: 5.6 — while a request is in flight, BOTH snapshot and resetObservations throw, naming the count
ok 880 - 5.6 — while a request is in flight, BOTH snapshot and resetObservations throw, naming the count
  ---
  duration_ms: 0.920209
  type: 'test'
  ...
# Subtest: 5.6b — the in-flight counter decrements on a 413 response too
ok 881 - 5.6b — the in-flight counter decrements on a 413 response too
  ---
  duration_ms: 0.947334
  type: 'test'
  ...
# Subtest: 5.7 — snapshot is DEFENSIVE: mutating the array, an object, or a Buffer leaves recorder state unchanged
ok 882 - 5.7 — snapshot is DEFENSIVE: mutating the array, an object, or a Buffer leaves recorder state unchanged
  ---
  duration_ms: 0.431834
  type: 'test'
  ...
# Subtest: 5.8 — two identical requests produce two observations; the recorder never deduplicates
ok 883 - 5.8 — two identical requests produce two observations; the recorder never deduplicates
  ---
  duration_ms: 1.684875
  type: 'test'
  ...
# Subtest: 5.9 — comparison groups by marker SET, not arrival order
ok 884 - 5.9 — comparison groups by marker SET, not arrival order
  ---
  duration_ms: 0.319
  type: 'test'
  ...
# Subtest: 5.9b — the comparator keeps method, path and body as ONE tuple: a swap between marker groups is a difference
ok 885 - 5.9b — the comparator keeps method, path and body as ONE tuple: a swap between marker groups is a difference
  ---
  duration_ms: 0.201209
  type: 'test'
  ...
# Subtest: 5.10 — resetObservations clears observations and the counter and NOTHING in responder configuration
ok 886 - 5.10 — resetObservations clears observations and the counter and NOTHING in responder configuration
  ---
  duration_ms: 5.69375
  type: 'test'
  ...
# Subtest: 5.11 — the parsed `requests` API is unchanged: same fields, same push sites, same arrival order, and JudgeRequest gains no field
ok 887 - 5.11 — the parsed `requests` API is unchanged: same fields, same push sites, same arrival order, and JudgeRequest gains no field
  ---
  duration_ms: 5.295792
  type: 'test'
  ...
# Subtest: J1.1 — SUCCESS: explicit judge and env-default judge are byte-identical on the wire, in results, and in payload
ok 888 - J1.1 — SUCCESS: explicit judge and env-default judge are byte-identical on the wire, in results, and in payload
  ---
  duration_ms: 19.861375
  type: 'test'
  ...
# [rerank judge] batch failed 0 - 5 Unexpected token 'h', "this is not"... is not valid JSON
# [rerank judge] batch failed 5 - 6 Unexpected token 'h', "this is not"... is not valid JSON
# [rerank judge] batch failed 0 - 5 Unexpected token 'h', "this is not"... is not valid JSON
# [rerank judge] batch failed 5 - 6 Unexpected token 'h', "this is not"... is not valid JSON
# Subtest: J1.2 — REAL BATCH PARSE FAILURE: both arms receive the same malformed completion and record it identically
ok 889 - J1.2 — REAL BATCH PARSE FAILURE: both arms receive the same malformed completion and record it identically
  ---
  duration_ms: 4.999958
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic outer judge failure, after the call
# [rerank] backend failed, returning input order generic outer judge failure, after the call
# Subtest: J1.3 — GENERIC OUTER JUDGE FAILURE, produced by CALL-THEN-THROW: nonempty and byte-identical wire observations on both arms
ok 890 - J1.3 — GENERIC OUTER JUDGE FAILURE, produced by CALL-THEN-THROW: nonempty and byte-identical wire observations on both arms
  ---
  duration_ms: 10.014
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (cohere/rerank-v3.5): OPENROUTER_API_KEY not set
# Subtest: J3.0 — the fixture is live: retrieve with the reranker OFF returns the fused order and dials no judge
ok 891 - J3.0 — the fixture is live: retrieve with the reranker OFF returns the fused order and dials no judge
  ---
  duration_ms: 158.679542
  type: 'test'
  ...
# Subtest: J3.1 — OMITTED-BACKEND CONTROL: the resilient arm runs; under a Cohere env default it shows Cohere intent AND downgrade
ok 892 - J3.1 — OMITTED-BACKEND CONTROL: the resilient arm runs; under a Cohere env default it shows Cohere intent AND downgrade
  ---
  duration_ms: 61.819625
  type: 'test'
  ...
# Subtest: J3.2 — EXPLICIT-JUDGE ARM: zero Cohere outbound requests, judge intent, judge service, no downgrade, nonzero batches, actual reordering
ok 893 - J3.2 — EXPLICIT-JUDGE ARM: zero Cohere outbound requests, judge intent, judge service, no downgrade, nonzero batches, actual reordering
  ---
  duration_ms: 3.482625
  type: 'test'
  ...
# Subtest: J4.1 — every retrieval arm is called with useReranker OFF; exactly ONE fusion-level rerank; its third argument is the value passed as opts.rerankBackend
ok 894 - J4.1 — every retrieval arm is called with useReranker OFF; exactly ONE fusion-level rerank; its third argument is the value passed as opts.rerankBackend
  ---
  duration_ms: 4.742875
  type: 'test'
  ...
# Subtest: J4.2 — the fusion rerank happens ONCE even when the arms return overlapping pools; no arm-level rerank stamps a batch
ok 895 - J4.2 — the fusion rerank happens ONCE even when the arms return overlapping pools; no arm-level rerank stamps a batch
  ---
  duration_ms: 6.912417
  type: 'test'
  ...
# Subtest: §4.2 every read of opd_audit_feedback is study-filtered — three D12-allowlisted, commented
ok 896 - §4.2 every read of opd_audit_feedback is study-filtered — three D12-allowlisted, commented
  ---
  duration_ms: 181.566583
  type: 'test'
  ...
# Subtest: §4.2 the write paths: main INSERT names study; assertion_contest and doctor-response never set it
ok 897 - §4.2 the write paths: main INSERT names study; assertion_contest and doctor-response never set it
  ---
  duration_ms: 0.237
  type: 'test'
  ...
# Subtest: 8.3 the predicate is parameterised IS NOT DISTINCT FROM — never = or a hardcoded IS NULL
ok 898 - 8.3 the predicate is parameterised IS NOT DISTINCT FROM — never = or a hardcoded IS NULL
  ---
  duration_ms: 0.498167
  type: 'test'
  ...
# Subtest: buildFindingAuthorCurrentSql: DISTINCT ON (audit_id, finding_ref, author), order leads with the same three
ok 899 - buildFindingAuthorCurrentSql: DISTINCT ON (audit_id, finding_ref, author), order leads with the same three
  ---
  duration_ms: 0.181042
  type: 'test'
  ...
# Subtest: §8.5 rollup finding builder: study absent ⇒ SAME SQL text, param NULL — NULL matches NULL
ok 900 - §8.5 rollup finding builder: study absent ⇒ SAME SQL text, param NULL — NULL matches NULL
  ---
  duration_ms: 0.404291
  type: 'test'
  ...
# Subtest: §8.5 parseFeedbackBody: study absent ⇒ behaviour identical, study null; D8 author rule enforced
ok 901 - §8.5 parseFeedbackBody: study absent ⇒ behaviour identical, study null; D8 author rule enforced
  ---
  duration_ms: 0.249167
  type: 'test'
  ...
# Subtest: jaccard basics + empty-set guard
ok 902 - jaccard basics + empty-set guard
  ---
  duration_ms: 1.071209
  type: 'test'
  ...
# Subtest: exact finding_ref match when both stamped — regardless of subject
ok 903 - exact finding_ref match when both stamped — regardless of subject
  ---
  duration_ms: 0.341958
  type: 'test'
  ...
# Subtest: fuzzy match needs signal_type equality AND Jaccard ≥ threshold
ok 904 - fuzzy match needs signal_type equality AND Jaccard ≥ threshold
  ---
  duration_ms: 0.396041
  type: 'test'
  ...
# Subtest: tie-break prefers the domain-equal student at equal Jaccard
ok 905 - tie-break prefers the domain-equal student at equal Jaccard
  ---
  duration_ms: 0.159542
  type: 'test'
  ...
# Subtest: disagreementsOf classifies tier-differs / teacher-only / student-only with reasons
ok 906 - disagreementsOf classifies tier-differs / teacher-only / student-only with reasons
  ---
  duration_ms: 0.869167
  type: 'test'
  ...
# Subtest: agreeing matched pairs are NOT disagreements
ok 907 - agreeing matched pairs are NOT disagreements
  ---
  duration_ms: 0.140833
  type: 'test'
  ...
# Subtest: every measured target resolves to a class containing Antibiotic, with the [0] invariant
ok 908 - every measured target resolves to a class containing Antibiotic, with the [0] invariant
  ---
  duration_ms: 2.071459
  type: 'test'
  ...
# Subtest: the cefpodoxime line: ester + salt variants both resolve — one entry per resolving fragment
ok 909 - the cefpodoxime line: ester + salt variants both resolve — one entry per resolving fragment
  ---
  duration_ms: 0.386209
  type: 'test'
  ...
# Subtest: the three-molecule kit resolves per fragment: Antifungal + Antibiotic (Secnidazole absent from the formulary)
ok 910 - the three-molecule kit resolves per fragment: Antifungal + Antibiotic (Secnidazole absent from the formulary)
  ---
  duration_ms: 0.129416
  type: 'test'
  ...
# Subtest: a bracketed strength group can never split the line
ok 911 - a bracketed strength group can never split the line
  ---
  duration_ms: 0.049583
  type: 'test'
  ...
# Subtest: the four regression lines keep resolving exactly as today
ok 912 - the four regression lines keep resolving exactly as today
  ---
  duration_ms: 0.151292
  type: 'test'
  ...
# Subtest: a line resolving to no class anywhere carries neither field
ok 913 - a line resolving to no class anywhere carries neither field
  ---
  duration_ms: 0.055125
  type: 'test'
  ...
# Subtest: noAntibioticClassOnNote (its own logic UNCHANGED) now sees the cefpodoxime antibiotic
ok 914 - noAntibioticClassOnNote (its own logic UNCHANGED) now sees the cefpodoxime antibiotic
  ---
  duration_ms: 0.232042
  type: 'test'
  ...
# Subtest: this build's bump (0.81.20) stays in the read family, and the engine is current
ok 915 - this build's bump (0.81.20) stays in the read family, and the engine is current
  ---
  duration_ms: 0.051791
  type: 'test'
  ...
# Subtest: normalizeDosageForm: parses raw formulary form (strength/junk stripped) to the coarse vocabulary
ok 916 - normalizeDosageForm: parses raw formulary form (strength/junk stripped) to the coarse vocabulary
  ---
  duration_ms: 1.326667
  type: 'test'
  ...
# Subtest: normalizeDrugName strips dose, form and marketing tail; keeps product-distinguishing suffix
ok 917 - normalizeDrugName strips dose, form and marketing tail; keeps product-distinguishing suffix
  ---
  duration_ms: 0.085917
  type: 'test'
  ...
# Subtest: brand-exact resolves the molecule + class + schedule (confident)
ok 918 - brand-exact resolves the molecule + class + schedule (confident)
  ---
  duration_ms: 0.436417
  type: 'test'
  ...
# Subtest: brand-token resolves an unambiguous brand family with no exact row (Wysolone → Prednisolone)
ok 919 - brand-token resolves an unambiguous brand family with no exact row (Wysolone → Prednisolone)
  ---
  duration_ms: 0.133291
  type: 'test'
  ...
# Subtest: embedded-generic recovers a molecule named verbatim — and NOT a combination canon
ok 920 - embedded-generic recovers a molecule named verbatim — and NOT a combination canon
  ---
  duration_ms: 0.063708
  type: 'test'
  ...
# Subtest: brand-prefix is an APPROX match (not confident) — combo suffix may drop a molecule
ok 921 - brand-prefix is an APPROX match (not confident) — combo suffix may drop a molecule
  ---
  duration_ms: 0.424
  type: 'test'
  ...
# Subtest: an ambiguous brand family (different canons) does NOT brand-token; exact still wins
ok 922 - an ambiguous brand family (different canons) does NOT brand-token; exact still wins
  ---
  duration_ms: 0.163166
  type: 'test'
  ...
# Subtest: source-generic is trusted as-is (confident)
ok 923 - source-generic is trusted as-is (confident)
  ---
  duration_ms: 0.231542
  type: 'test'
  ...
# Subtest: high-alert + schedule X carried through
ok 924 - high-alert + schedule X carried through
  ---
  duration_ms: 0.224584
  type: 'test'
  ...
# Subtest: unmatched returns null and classifies nutraceutical/cosmetic vs off-formulary
ok 925 - unmatched returns null and classifies nutraceutical/cosmetic vs off-formulary
  ---
  duration_ms: 0.7125
  type: 'test'
  ...
# Subtest: BUG-0.8-15: a single molecule wins its class over a combination that contains it (any array order)
ok 926 - BUG-0.8-15: a single molecule wins its class over a combination that contains it (any array order)
  ---
  duration_ms: 0.139041
  type: 'test'
  ...
# Subtest: flag unset ⇒ undefined, ALWAYS — the bridge does not exist without GEMINI_VIA_OPENROUTER=1
ok 927 - flag unset ⇒ undefined, ALWAYS — the bridge does not exist without GEMINI_VIA_OPENROUTER=1
  ---
  duration_ms: 0.5475
  type: 'test'
  ...
# Subtest: flag=1 ⇒ the OpenRouter slug, google/-prefixed exactly once; no model ⇒ undefined
ok 928 - flag=1 ⇒ the OpenRouter slug, google/-prefixed exactly once; no model ⇒ undefined
  ---
  duration_ms: 0.129541
  type: 'test'
  ...
# Subtest: trap 1: a Gemini slug NEVER receives reasoning:{enabled:false} — the A-12 400 destroyed a diagnosis for 36h
ok 929 - trap 1: a Gemini slug NEVER receives reasoning:{enabled:false} — the A-12 400 destroyed a diagnosis for 36h
  ---
  duration_ms: 0.148834
  type: 'test'
  ...
# Subtest: trap 1 control: a NON-Gemini slug reproduces the pre-bridge behaviour byte-for-byte
ok 930 - trap 1 control: a NON-Gemini slug reproduces the pre-bridge behaviour byte-for-byte
  ---
  duration_ms: 0.391125
  type: 'test'
  ...
# Subtest: trap 2: a Gemini slug gets baseMax + 8192 — Pro spends output budget on reasoning FIRST
ok 931 - trap 2: a Gemini slug gets baseMax + 8192 — Pro spends output budget on reasoning FIRST
  ---
  duration_ms: 0.078458
  type: 'test'
  ...
# Subtest: trap 3: the Vertex thinking budget is TRANSLATED to reasoning.max_tokens, and `google` never travels
ok 932 - trap 3: the Vertex thinking budget is TRANSLATED to reasoning.max_tokens, and `google` never travels
  ---
  duration_ms: 0.061958
  type: 'test'
  ...
# Subtest: trap 3: NO DEFAULT IS INVENTED — no budget in, no reasoning out (byte-identical to before)
ok 933 - trap 3: NO DEFAULT IS INVENTED — no budget in, no reasoning out (byte-identical to before)
  ---
  duration_ms: 0.194917
  type: 'test'
  ...
# Subtest: trap 3: the reader is pure and total — any shape yields a budget or undefined
ok 934 - trap 3: the reader is pure and total — any shape yields a budget or undefined
  ---
  duration_ms: 0.05625
  type: 'test'
  ...
# Subtest: trap 3: an explicit OpenRouter reasoning block WINS — translation never overwrites it
ok 935 - trap 3: an explicit OpenRouter reasoning block WINS — translation never overwrites it
  ---
  duration_ms: 0.196167
  type: 'test'
  ...
# Subtest: trap 3: the VERTEX path is untouched — it still sends the google form and no reasoning block
ok 936 - trap 3: the VERTEX path is untouched — it still sends the google form and no reasoning block
  ---
  duration_ms: 0.322917
  type: 'test'
  ...
# Subtest: the pin: Google-operated providers only, no fallbacks — slugs read off the endpoints listing 30 Jul 2026
ok 937 - the pin: Google-operated providers only, no fallbacks — slugs read off the endpoints listing 30 Jul 2026
  ---
  duration_ms: 0.065084
  type: 'test'
  ...
# Subtest: both transports derive the slug centrally; a caller-supplied openrouter slug takes precedence
ok 938 - both transports derive the slug centrally; a caller-supplied openrouter slug takes precedence
  ---
  duration_ms: 0.066333
  type: 'test'
  ...
# Subtest: the Ollama last-leg fallback is untouched in both transports
ok 939 - the Ollama last-leg fallback is untouched in both transports
  ---
  duration_ms: 0.092042
  type: 'test'
  ...
# Subtest: T-5: the hardcoded 'gemini-2.5-pro' literal is GONE from the worker — it hid this incident for four days
ok 940 - T-5: the hardcoded 'gemini-2.5-pro' literal is GONE from the worker — it hid this incident for four days
  ---
  duration_ms: 0.048667
  type: 'test'
  ...
# Subtest: T-5: servedCallFor reads the POST-fallback model from the audit trace, null when unknown
ok 941 - T-5: servedCallFor reads the POST-fallback model from the audit trace, null when unknown
  ---
  duration_ms: 0.046583
  type: 'test'
  ...
# Subtest: changelog: the bridge entry exists, scoring:false, and names the step change as a provider restoration
ok 942 - changelog: the bridge entry exists, scoring:false, and names the step change as a provider restoration
  ---
  duration_ms: 0.132333
  type: 'test'
  ...
# Subtest: GATE: a cloud row at 0.81.17 beats a qwen row at 0.81.20 — the exact live shape
ok 943 - GATE: a cloud row at 0.81.17 beats a qwen row at 0.81.20 — the exact live shape
  ---
  duration_ms: 0.592666
  type: 'test'
  ...
# Subtest: GATE: two cloud rows at different versions ⇒ the HIGHER version still wins
ok 944 - GATE: two cloud rows at different versions ⇒ the HIGHER version still wins
  ---
  duration_ms: 0.159625
  type: 'test'
  ...
# Subtest: isLocalGrader catches BOTH signals: the qwen model and the -mini suffix
ok 945 - isLocalGrader catches BOTH signals: the qwen model and the -mini suffix
  ---
  duration_ms: 0.063875
  type: 'test'
  ...
# Subtest: the grader tier is a SEPARATE question from REFERENCE_MODELS — neither list is overloaded
ok 946 - the grader tier is a SEPARATE question from REFERENCE_MODELS — neither list is overloaded
  ---
  duration_ms: 0.206542
  type: 'test'
  ...
# Subtest: CANONICAL_RANK_SQL leads with the grader tier, then version, then reference, then audited_at
ok 947 - CANONICAL_RANK_SQL leads with the grader tier, then version, then reference, then audited_at
  ---
  duration_ms: 0.061292
  type: 'test'
  ...
# Subtest: D1: prodTag and the mini_backfill_prod settings keys are DELETED repo-wide
ok 948 - D1: prodTag and the mini_backfill_prod settings keys are DELETED repo-wide
  ---
  duration_ms: 0.468416
  type: 'test'
  ...
# Subtest: the trap comment no longer claims a guard is unnecessary
ok 949 - the trap comment no longer claims a guard is unnecessary
  ---
  duration_ms: 0.146291
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: stripEvenNonProse removes base64 blobs and image refs, keeps prose
ok 950 - stripEvenNonProse removes base64 blobs and image refs, keeps prose
  ---
  duration_ms: 0.67925
  type: 'test'
  ...
# Subtest: parseEvenProtocols splits on H1/H2/H3 with group-prefixed section paths + slug anchors
ok 951 - parseEvenProtocols splits on H1/H2/H3 with group-prefixed section paths + slug anchors
  ---
  duration_ms: 0.295709
  type: 'test'
  ...
# Subtest: chunkSections drops < 120-char chunks, stamps guideline type + section anchor
ok 952 - chunkSections drops < 120-char chunks, stamps guideline type + section anchor
  ---
  duration_ms: 0.23875
  type: 'test'
  ...
# Subtest: each built row re-chunks to exactly one piece (per-row insert stays 1:1)
ok 953 - each built row re-chunks to exactly one piece (per-row insert stays 1:1)
  ---
  duration_ms: 0.395584
  type: 'test'
  ...
# Subtest: parseIcmr yields page-anchored sections with detected chapter headings
ok 954 - parseIcmr yields page-anchored sections with detected chapter headings
  ---
  duration_ms: 7.068834
  type: 'test'
  ...
# Subtest: detectIcmrHeading: title/upper headings yes, sentences no
ok 955 - detectIcmrHeading: title/upper headings yes, sentences no
  ---
  duration_ms: 0.107584
  type: 'test'
  ...
# Subtest: slugify → stable kebab anchor fragment
ok 956 - slugify → stable kebab anchor fragment
  ---
  duration_ms: 0.118416
  type: 'test'
  ...
# Subtest: CORPUS_QUARANTINE_INSERT_SQL — item_number is still column $5; F13 provenance appended ONLY
ok 957 - CORPUS_QUARANTINE_INSERT_SQL — item_number is still column $5; F13 provenance appended ONLY
  ---
  duration_ms: 0.117542
  type: 'test'
  ...
# Subtest: the artifact is the full master: version, size, key shape
ok 958 - the artifact is the full master: version, size, key shape
  ---
  duration_ms: 115.964875
  type: 'test'
  ...
# Subtest: PRD spot-checks resolve to real master labels
ok 959 - PRD spot-checks resolve to real master labels
  ---
  duration_ms: 3.867417
  type: 'test'
  ...
# Subtest: override precedence: a code in both layers renders the curated phrasing
ok 960 - override precedence: a code in both layers renders the curated phrasing
  ---
  duration_ms: 0.196792
  type: 'test'
  ...
# Subtest: category fallback is EXACT-KEY only; junk still gets the neutral fallback
ok 961 - category fallback is EXACT-KEY only; junk still gets the neutral fallback
  ---
  duration_ms: 43.658791
  type: 'test'
  ...
# Subtest: Decision-D order unchanged: source display text still wins over every bundled layer
ok 962 - Decision-D order unchanged: source display text still wins over every bundled layer
  ---
  duration_ms: 0.1515
  type: 'test'
  ...
# Subtest: slice-2 payload: META carries duration + high-risk in the ratified shape (not consumed yet)
ok 963 - slice-2 payload: META carries duration + high-risk in the ratified shape (not consumed yet)
  ---
  duration_ms: 218.096167
  type: 'test'
  ...
# Subtest: a formulary-resolved combination missing ONLY strength → NO finding
ok 964 - a formulary-resolved combination missing ONLY strength → NO finding
  ---
  duration_ms: 1.147083
  type: 'test'
  ...
# Subtest: a formulary-resolved combination missing strength AND frequency → finding, gaps list frequency ONLY
ok 965 - a formulary-resolved combination missing strength AND frequency → finding, gaps list frequency ONLY
  ---
  duration_ms: 1.720792
  type: 'test'
  ...
# Subtest: a combination with nonFormulary set → finding, strength gap STILL present (DEC-2)
ok 966 - a combination with nonFormulary set → finding, strength gap STILL present (DEC-2)
  ---
  duration_ms: 0.848084
  type: 'test'
  ...
# Subtest: a single-molecule drug missing strength → finding, unchanged
ok 967 - a single-molecule drug missing strength → finding, unchanged
  ---
  duration_ms: 0.453042
  type: 'test'
  ...
# Subtest: the combination exemption needs BOTH conditions — a "+" alone is not enough
ok 968 - the combination exemption needs BOTH conditions — a "+" alone is not enough
  ---
  duration_ms: 0.154417
  type: 'test'
  ...
# Subtest: dosageForm 'topical' missing strength AND route → NO finding
ok 969 - dosageForm 'topical' missing strength AND route → NO finding
  ---
  duration_ms: 0.985042
  type: 'test'
  ...
# Subtest: dosageForm 'topical' missing duration → finding, duration ONLY
ok 970 - dosageForm 'topical' missing duration → finding, duration ONLY
  ---
  duration_ms: 0.100208
  type: 'test'
  ...
# Subtest: dosageForm 'drops' behaves exactly like topical
ok 971 - dosageForm 'drops' behaves exactly like topical
  ---
  duration_ms: 0.075041
  type: 'test'
  ...
# Subtest: dosageForm 'inhaler' and 'injection' are UNCHANGED — strength and route still gap
ok 972 - dosageForm 'inhaler' and 'injection' are UNCHANGED — strength and route still gap
  ---
  duration_ms: 1.119417
  type: 'test'
  ...
# Subtest: the other four DosageForm members are untouched: tablet, capsule, syrup, other
ok 973 - the other four DosageForm members are untouched: tablet, capsule, syrup, other
  ---
  duration_ms: 0.332917
  type: 'test'
  ...
# Subtest: a complete line emits nothing, before and after
ok 974 - a complete line emits nothing, before and after
  ---
  duration_ms: 0.06225
  type: 'test'
  ...
# Subtest: the existing isDoseExempt cases behave exactly as before — wholesale suppression intact
ok 975 - the existing isDoseExempt cases behave exactly as before — wholesale suppression intact
  ---
  duration_ms: 0.121583
  type: 'test'
  ...
# Subtest: the rationale wording is byte-identical — only the gap list inside it changes
ok 976 - the rationale wording is byte-identical — only the gap list inside it changes
  ---
  duration_ms: 0.045833
  type: 'test'
  ...
# Subtest: the emitted rationale still parses for severity-tier-core (the tier keys on this string)
ok 977 - the emitted rationale still parses for severity-tier-core (the tier keys on this string)
  ---
  duration_ms: 0.086375
  type: 'test'
  ...
# Subtest: the four contested subjects produce NO strength gap
ok 978 - the four contested subjects produce NO strength gap
  ---
  duration_ms: 0.073417
  type: 'test'
  ...
# Subtest: …but each of the four still fires when a REAL gap is present (DEC-1)
ok 979 - …but each of the four still fires when a REAL gap is present (DEC-1)
  ---
  duration_ms: 0.093375
  type: 'test'
  ...
# Subtest: a topical combination gets BOTH exemptions and still fires on frequency
ok 980 - a topical combination gets BOTH exemptions and still fires on frequency
  ---
  duration_ms: 0.0375
  type: 'test'
  ...
# Subtest: version constants match the PRD exactly
ok 981 - version constants match the PRD exactly
  ---
  duration_ms: 0.626625
  type: 'test'
  ...
# Subtest: candidate mapping per kind (PRD §5 table) — family and skeleton per kind
ok 982 - candidate mapping per kind (PRD §5 table) — family and skeleton per kind
  ---
  duration_ms: 3.990542
  type: 'test'
  ...
# Subtest: baseline buildAskSet asks are also candidates (why baseline, unknownIds [])
ok 983 - baseline buildAskSet asks are also candidates (why baseline, unknownIds [])
  ---
  duration_ms: 1.493042
  type: 'test'
  ...
# Subtest: instability_input / unmappable unknowns produce no candidate and land in dropped
ok 984 - instability_input / unmappable unknowns produce no candidate and land in dropped
  ---
  duration_ms: 0.377167
  type: 'test'
  ...
# Subtest: same-id candidates merge (allergy unknown merges into the baseline allergy ask)
ok 985 - same-id candidates merge (allergy unknown merges into the baseline allergy ask)
  ---
  duration_ms: 0.4285
  type: 'test'
  ...
# Subtest: validateSelection (B6 numbers, B7 phrase-all): out-of-range / non-integer n rejected; duplicate rejected; NO pick cap
ok 986 - validateSelection (B6 numbers, B7 phrase-all): out-of-range / non-integer n rejected; duplicate rejected; NO pick cap
  ---
  duration_ms: 1.5485
  type: 'test'
  ...
# Subtest: validateSelection: rewritten family/subject never survive — candidate fields win
ok 987 - validateSelection: rewritten family/subject never survive — candidate fields win
  ---
  duration_ms: 0.248458
  type: 'test'
  ...
# Subtest: validateSelection: over-length and empty questions are rejected
ok 988 - validateSelection: over-length and empty questions are rejected
  ---
  duration_ms: 0.305083
  type: 'test'
  ...
# Subtest: validateSelection: a generic question (no subject token) is replaced by the candidate skeleton
ok 989 - validateSelection: a generic question (no subject token) is replaced by the candidate skeleton
  ---
  duration_ms: 0.541042
  type: 'test'
  ...
# Subtest: assembly: every high-alert MED_STATUS ask is ALWAYS first (ladder rank 0), regardless of picks
ok 990 - assembly: every high-alert MED_STATUS ask is ALWAYS first (ladder rank 0), regardless of picks
  ---
  duration_ms: 1.243833
  type: 'test'
  ...
# Subtest: K2 ladder (B5 ranks): rungs serve in order 0<1<3<4<5<6<7<8 regardless of the pick order fed in
ok 991 - K2 ladder (B5 ranks): rungs serve in order 0<1<3<4<5<6<7<8 regardless of the pick order fed in
  ---
  duration_ms: 1.049958
  type: 'test'
  ...
# Subtest: B5 new-med rung: a med absent from a NON-EMPTY snapshot ranks 2 and leads over a care-gap; empty/absent snapshot stays routine 5
ok 992 - B5 new-med rung: a med absent from a NON-EMPTY snapshot ranks 2 and leads over a care-gap; empty/absent snapshot stays routine 5
  ---
  duration_ms: 10.614208
  type: 'test'
  ...
# Subtest: assembly: total cap stays 5 and the overflow list is preserved
ok 993 - assembly: total cap stays 5 and the overflow list is preserved
  ---
  duration_ms: 0.2205
  type: 'test'
  ...
# Subtest: K2: zero-valid-picks (parsed) is NOT a fallback — ladder assembles with skeleton phrasing, source inquiry
ok 994 - K2: zero-valid-picks (parsed) is NOT a fallback — ladder assembles with skeleton phrasing, source inquiry
  ---
  duration_ms: 0.9335
  type: 'test'
  ...
# Subtest: K2: transport failure retries ONCE, then falls back byte-identical to buildAskSet
ok 995 - K2: transport failure retries ONCE, then falls back byte-identical to buildAskSet
  ---
  duration_ms: 23.040625
  type: 'test'
  ...
# Subtest: runInquirySelection happy path: validated picks served as ask-set/0.2 with askMeta derivation
ok 996 - runInquirySelection happy path: validated picks served as ask-set/0.2 with askMeta derivation
  ---
  duration_ms: 0.797333
  type: 'test'
  ...
# Subtest: B7 phrase-all: with a phrasing for EVERY candidate, all 5 ladder-served asks carry Gemini phrasing (no skeleton)
ok 997 - B7 phrase-all: with a phrasing for EVERY candidate, all 5 ladder-served asks carry Gemini phrasing (no skeleton)
  ---
  duration_ms: 1.281541
  type: 'test'
  ...
# Subtest: parseSelection tolerates prose around the JSON and rejects malformed shapes
ok 998 - parseSelection tolerates prose around the JSON and rejects malformed shapes
  ---
  duration_ms: 0.15575
  type: 'test'
  ...
# Subtest: B6: parseSelection strips markdown code fences (the live-prod fallback root cause)
ok 999 - B6: parseSelection strips markdown code fences (the live-prod fallback root cause)
  ---
  duration_ms: 0.146375
  type: 'test'
  ...
# Subtest: B6 end-to-end: a fenced, number-based Gemini response serves source inquiry with Gemini phrasing
ok 1000 - B6 end-to-end: a fenced, number-based Gemini response serves source inquiry with Gemini phrasing
  ---
  duration_ms: 0.45475
  type: 'test'
  ...
# Subtest: fallbackAskSet is buildAskSet verbatim (deep-equal asks + overflow)
ok 1001 - fallbackAskSet is buildAskSet verbatim (deep-equal asks + overflow)
  ---
  duration_ms: 0.194333
  type: 'test'
  ...
# Subtest: scorer is deterministic and the metric arithmetic is exact
ok 1002 - scorer is deterministic and the metric arithmetic is exact
  ---
  duration_ms: 1.867875
  type: 'test'
  ...
# Subtest: A1 split: family-legality is vocabulary-only; legalSlots23 lands in slotAppropriate, not the gate
ok 1003 - A1 split: family-legality is vocabulary-only; legalSlots23 lands in slotAppropriate, not the gate
  ---
  duration_ms: 0.548333
  type: 'test'
  ...
# Subtest: baseline harness runs on the shipped RATIFIED bank (deterministic arm, no LLM)
ok 1004 - baseline harness runs on the shipped RATIFIED bank (deterministic arm, no LLM)
  ---
  duration_ms: 15.597083
  type: 'test'
  ...
# Subtest: askset route: INQUIRY_ENABLED unset ⇒ byte-identical deterministic path
ok 1005 - askset route: INQUIRY_ENABLED unset ⇒ byte-identical deterministic path
  ---
  duration_ms: 0.478791
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: insert is idempotent on id (ON CONFLICT (id) DO NOTHING) and repeat saves succeed
ok 1006 - insert is idempotent on id (ON CONFLICT (id) DO NOTHING) and repeat saves succeed
  ---
  duration_ms: 1.320333
  type: 'test'
  ...
# Subtest: reads soft-fail to empty when the table is missing / DB is down
ok 1007 - reads soft-fail to empty when the table is missing / DB is down
  ---
  duration_ms: 0.24025
  type: 'test'
  ...
# Subtest: K1.1: recomputeOutcomes preserves each row's served ask_set_version (ask-set/0.2 survives)
ok 1008 - K1.1: recomputeOutcomes preserves each row's served ask_set_version (ask-set/0.2 survives)
  ---
  duration_ms: 7.511833
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] backend failed, returning input order generic
# Subtest: 1a — retrieve: no capture, and two uninstrumented runs are identical statement for statement
ok 1009 - 1a — retrieve: no capture, and two uninstrumented runs are identical statement for statement
  ---
  duration_ms: 109.862125
  type: 'test'
  ...
# Subtest: 1a' — and adding a capture to ONE side only leaves the returned value identical
ok 1010 - 1a' — and adding a capture to ONE side only leaves the returned value identical
  ---
  duration_ms: 0.799334
  type: 'test'
  ...
# Subtest: 2 — rerank: undefined reaches judgeFn and cohereFn as the third argument, and soft failure returns early
ok 1011 - 2 — rerank: undefined reaches judgeFn and cohereFn as the third argument, and soft failure returns early
  ---
  duration_ms: 0.468125
  type: 'test'
  ...
# Subtest: 3 — rerankJudge: identical array and identical request bodies, with and without a capture
ok 1012 - 3 — rerankJudge: identical array and identical request bodies, with and without a capture
  ---
  duration_ms: 17.266417
  type: 'test'
  ...
# Subtest: 4 — rerankCohere: the CapturedBatch literal at :162-174 is never constructed
ok 1013 - 4 — rerankCohere: the CapturedBatch literal at :162-174 is never constructed
  ---
  duration_ms: 0.484042
  type: 'test'
  ...
# Subtest: 5 — expandQuery: capture.expansion is never set, and here evidenceFromCompletion is INSIDE the guard
ok 1014 - 5 — expandQuery: capture.expansion is never set, and here evidenceFromCompletion is INSIDE the guard
  ---
  duration_ms: 9.395417
  type: 'test'
  ...
# Subtest: 6 — retrieveMultiQuery: armCaptures undefined, arms called with undefined, children never set
ok 1015 - 6 — retrieveMultiQuery: armCaptures undefined, arms called with undefined, children never set
  ---
  duration_ms: 1.227166
  type: 'test'
  ...
# Subtest: 7 — the MatchInput seam: no telemetry field means no capture, no declaration and no write
ok 1016 - 7 — the MatchInput seam: no telemetry field means no capture, no declaration and no write
  ---
  duration_ms: 10.26675
  type: 'test'
  ...
# Subtest: v7 §5 — Vertex is the first target when Gemini is on and the bridge flag is off
ok 1017 - v7 §5 — Vertex is the first target when Gemini is on and the bridge flag is off
  ---
  duration_ms: 305.123958
  type: 'test'
  ...
# Subtest: v7 §5 — OpenRouter is the first target when the bridge flag produces a slug
ok 1018 - v7 §5 — OpenRouter is the first target when the bridge flag produces a slug
  ---
  duration_ms: 345.664709
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: v7 §5 — Ollama with JUDGE_MODEL when no cloud tier is available, and that pair IS sanctioned
ok 1019 - v7 §5 — Ollama with JUDGE_MODEL when no cloud tier is available, and that pair IS sanctioned
  ---
  duration_ms: 94.45325
  type: 'test'
  ...
# Subtest: v7 §5 — LLM_PIPELINE=mini forces local, whatever the Gemini flags say
ok 1020 - v7 §5 — LLM_PIPELINE=mini forces local, whatever the Gemini flags say
  ---
  duration_ms: 3.423667
  type: 'test'
  ...
# Subtest: v7 §5 — Gemini flags with NO provider configuration still resolve local, not Vertex
ok 1021 - v7 §5 — Gemini flags with NO provider configuration still resolve local, not Vertex
  ---
  duration_ms: 0.965
  type: 'test'
  ...
# Subtest: v7 §5 — Cohere resolves to OpenRouter with the effective Cohere model
ok 1022 - v7 §5 — Cohere resolves to OpenRouter with the effective Cohere model
  ---
  duration_ms: 25.190167
  type: 'test'
  ...
# Subtest: v7 §5 — the guard rejects the exact pair that reached the manifest, and accepts all four sanctioned ones
ok 1023 - v7 §5 — the guard rejects the exact pair that reached the manifest, and accepts all four sanctioned ones
  ---
  duration_ms: 3.207375
  type: 'test'
  ...
# Subtest: v7 §5 — EVERY target the resolver can produce is a sanctioned pairing, across the matrix
ok 1024 - v7 §5 — EVERY target the resolver can produce is a sanctioned pairing, across the matrix
  ---
  duration_ms: 4.726916
  type: 'test'
  ...
# Subtest: v7 §5 — no site hardcodes the impossible pair any more, and the correct Cohere site is pinned
ok 1025 - v7 §5 — no site hardcodes the impossible pair any more, and the correct Cohere site is pinned
  ---
  duration_ms: 0.270667
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# Subtest: v7 §6 — a generic Cohere failure records unattributed, because the proof rule governs
ok 1026 - v7 §6 — a generic Cohere failure records unattributed, because the proof rule governs
  ---
  duration_ms: 13.379334
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic
# Subtest: v7 §6 — the resolved intended pairing survives on the soft-failure record too
ok 1027 - v7 §6 — the resolved intended pairing survives on the soft-failure record too
  ---
  duration_ms: 7.494167
  type: 'test'
  ...
# Subtest: v7 §10 — a fresh capture carries the no-rerank values, not zeros
ok 1028 - v7 §10 — a fresh capture carries the no-rerank values, not zeros
  ---
  duration_ms: 2.82075
  type: 'test'
  ...
# Subtest: v7 §10 — Cohere records neither a temperature nor a seed, because it takes neither
ok 1029 - v7 §10 — Cohere records neither a temperature nor a seed, because it takes neither
  ---
  duration_ms: 6.24575
  type: 'test'
  ...
# Subtest: v7 §10 — the judge records its real temperature and `unseeded`, and the call uses the same constant
ok 1030 - v7 §10 — the judge records its real temperature and `unseeded`, and the call uses the same constant
  ---
  duration_ms: 0.118917
  type: 'test'
  ...
# Subtest: v7 §10 — the seed status vocabulary distinguishes a stripped seed from an applied one
ok 1031 - v7 §10 — the seed status vocabulary distinguishes a stripped seed from an applied one
  ---
  duration_ms: 2.45825
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: PHI: the billing reader never names a PHI column from kx_billing_records
ok 1032 - PHI: the billing reader never names a PHI column from kx_billing_records
  ---
  duration_ms: 0.863708
  type: 'test'
  ...
# Subtest: semantics: the ₹ panel never touches the scored-band palette
ok 1033 - semantics: the ₹ panel never touches the scored-band palette
  ---
  duration_ms: 0.249375
  type: 'test'
  ...
# Subtest: recon: a billed clinical category whose NABH field is missing is a gap
ok 1034 - recon: a billed clinical category whose NABH field is missing is a gap
  ---
  duration_ms: 0.320917
  type: 'test'
  ...
# Subtest: recon: present/partial/na/absent are NOT gaps — only an explicit missing is
ok 1035 - recon: present/partial/na/absent are NOT gaps — only an explicit missing is
  ---
  duration_ms: 1.583375
  type: 'test'
  ...
# Subtest: recon: documented-but-not-billed is the other direction, at the same coarseness
ok 1036 - recon: documented-but-not-billed is the other direction, at the same coarseness
  ---
  duration_ms: 1.010041
  type: 'test'
  ...
# Subtest: recon: a PACKAGE-billed admission suppresses documented-but-not-billed (bundling artefact)
ok 1037 - recon: a PACKAGE-billed admission suppresses documented-but-not-billed (bundling artefact)
  ---
  duration_ms: 0.471125
  type: 'test'
  ...
# Subtest: recon: a documented kind of care that IS billed raises nothing in either direction
ok 1038 - recon: a documented kind of care that IS billed raises nothing in either direction
  ---
  duration_ms: 0.275792
  type: 'test'
  ...
# Subtest: bill match: only POSITIVE matches are asserted — by molecule or by drug class
ok 1039 - bill match: only POSITIVE matches are asserted — by molecule or by drug class
  ---
  duration_ms: 0.591042
  type: 'test'
  ...
# Subtest: bill match: the panel never asserts the negative (the measured false-"script?" trap)
ok 1040 - bill match: the panel never asserts the negative (the measured false-"script?" trap)
  ---
  duration_ms: 0.706458
  type: 'test'
  ...
# Subtest: moleculeOf: db13 pharmacy item names are MOLECULE-FORM-STRENGTH-BRAND-PACK
ok 1041 - moleculeOf: db13 pharmacy item names are MOLECULE-FORM-STRENGTH-BRAND-PACK
  ---
  duration_ms: 0.636208
  type: 'test'
  ...
# Subtest: categories: the clinical/facility split is the reconciliation boundary
ok 1042 - categories: the clinical/facility split is the reconciliation boundary
  ---
  duration_ms: 0.163959
  type: 'test'
  ...
# Subtest: billed_total: the row assembler carries the ₹ scalar and it is still not PHI
ok 1043 - billed_total: the row assembler carries the ₹ scalar and it is still not PHI
  ---
  duration_ms: 0.462834
  type: 'test'
  ...
# Subtest: the committed gold artifact is frozen, ratified, and hash-pinned
ok 1044 - the committed gold artifact is frozen, ratified, and hash-pinned
  ---
  duration_ms: 1.964625
  type: 'test'
  ...
# Subtest: K=5 distribution block (carried from 1.1): every case has the modal band + ranges; S4 drift cases ratified
ok 1045 - K=5 distribution block (carried from 1.1): every case has the modal band + ranges; S4 drift cases ratified
  ---
  duration_ms: 0.576083
  type: 'test'
  ...
# Subtest: 2.0 theme upgrade: material themes expanded via V-ratified extras; nitpick sits in a separate minor tier
ok 1046 - 2.0 theme upgrade: material themes expanded via V-ratified extras; nitpick sits in a separate minor tier
  ---
  duration_ms: 0.518416
  type: 'test'
  ...
# Subtest: the gold is de-identified: no UHID / phone / honorific-name patterns anywhere
ok 1047 - the gold is de-identified: no UHID / phone / honorific-name patterns anywhere
  ---
  duration_ms: 0.738708
  type: 'test'
  ...
# Subtest: loadIpdAuditGold rejects drift: edited case, wrong version/status, dup id, bad verdict
ok 1048 - loadIpdAuditGold rejects drift: edited case, wrong version/status, dup id, bad verdict
  ---
  duration_ms: 3.326541
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: semantics: the adjudication component never touches the scored-band palette
ok 1049 - semantics: the adjudication component never touches the scored-band palette
  ---
  duration_ms: 0.601417
  type: 'test'
  ...
# Subtest: semantics: the LVC summary strip renders without band language; the finding list exists once
ok 1050 - semantics: the LVC summary strip renders without band language; the finding list exists once
  ---
  duration_ms: 0.206875
  type: 'test'
  ...
# Subtest: CaseAuditReport: the findingActions slot is optional — absent means unchanged for other callers
ok 1051 - CaseAuditReport: the findingActions slot is optional — absent means unchanged for other callers
  ---
  duration_ms: 0.558875
  type: 'test'
  ...
# Subtest: PHI posture: the row assembler cannot place a name/UHID on the audit row
ok 1052 - PHI posture: the row assembler cannot place a name/UHID on the audit row
  ---
  duration_ms: 0.597834
  type: 'test'
  ...
# Subtest: PHI posture: neither the table nor the store INSERT carries a name/UHID column
ok 1053 - PHI posture: neither the table nor the store INSERT carries a name/UHID column
  ---
  duration_ms: 0.761459
  type: 'test'
  ...
# Subtest: PHI posture: db13 PHI fields are read-time only — never passed to the row assembler
ok 1054 - PHI posture: db13 PHI fields are read-time only — never passed to the row assembler
  ---
  duration_ms: 0.149959
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: IPNO-229: the Internal Medicine audit resolves to Dr Darshana R, NOT Dr Vinod Kumar
ok 1055 - IPNO-229: the Internal Medicine audit resolves to Dr Darshana R, NOT Dr Vinod Kumar
  ---
  duration_ms: 1.56175
  type: 'test'
  ...
# Subtest: IPNO-229: the Orthopedics audit resolves to Dr Vinod Kumar
ok 1056 - IPNO-229: the Orthopedics audit resolves to Dr Vinod Kumar
  ---
  duration_ms: 0.166459
  type: 'test'
  ...
# Subtest: NEVER take the first row — order of the input must not change the answer
ok 1057 - NEVER take the first row — order of the input must not change the answer
  ---
  duration_ms: 0.294375
  type: 'test'
  ...
# Subtest: step 2 — still ambiguous after the speciality match ⇒ most recent discharge_date_time wins
ok 1058 - step 2 — still ambiguous after the speciality match ⇒ most recent discharge_date_time wins
  ---
  duration_ms: 0.183083
  type: 'test'
  ...
# Subtest: step 3 — a null audit speciality (4 of 345) takes the most recent and marks it unconfirmed
ok 1059 - step 3 — a null audit speciality (4 of 345) takes the most recent and marks it unconfirmed
  ---
  duration_ms: 0.255042
  type: 'test'
  ...
# Subtest: a speciality that matches NOTHING falls back to recency and is marked unconfirmed
ok 1060 - a speciality that matches NOTHING falls back to recency and is marked unconfirmed
  ---
  duration_ms: 0.177541
  type: 'test'
  ...
# Subtest: step 4 — a null treating doctor falls back to admitting
ok 1061 - step 4 — a null treating doctor falls back to admitting
  ---
  duration_ms: 0.214542
  type: 'test'
  ...
# Subtest: step 5 — nothing usable ⇒ Unattributed, never a guess and never a throw
ok 1062 - step 5 — nothing usable ⇒ Unattributed, never a guess and never a throw
  ---
  duration_ms: 0.665292
  type: 'test'
  ...
# Subtest: speciality matching tolerates case and whitespace but nothing more
ok 1063 - speciality matching tolerates case and whitespace but nothing more
  ---
  duration_ms: 0.628083
  type: 'test'
  ...
# Subtest: rows with no timestamp sort last and never win over a dated row
ok 1064 - rows with no timestamp sort last and never win over a dated row
  ---
  duration_ms: 0.43775
  type: 'test'
  ...
# Subtest: groupByDoctor aggregates count, mean completeness and band distribution
ok 1065 - groupByDoctor aggregates count, mean completeness and band distribution
  ---
  duration_ms: 0.3725
  type: 'test'
  ...
# Subtest: groupByDoctor: unknown ip_uids become Unattributed, and it always sorts LAST
ok 1066 - groupByDoctor: unknown ip_uids become Unattributed, and it always sorts LAST
  ---
  duration_ms: 0.081625
  type: 'test'
  ...
# Subtest: groupByDoctor: a null completeness does not poison the mean
ok 1067 - groupByDoctor: a null completeness does not poison the mean
  ---
  duration_ms: 0.06325
  type: 'test'
  ...
# Subtest: a group is only "speciality unconfirmed" if EVERY member is
ok 1068 - a group is only "speciality unconfirmed" if EVERY member is
  ---
  duration_ms: 0.046292
  type: 'test'
  ...
# Subtest: groupByDoctor never throws on rubbish input
ok 1069 - groupByDoctor never throws on rubbish input
  ---
  duration_ms: 0.042334
  type: 'test'
  ...
# Subtest: the DEFAULT is Last 3 months (§6.2)
ok 1070 - the DEFAULT is Last 3 months (§6.2)
  ---
  duration_ms: 0.183667
  type: 'test'
  ...
# Subtest: This month / Last month
ok 1071 - This month / Last month
  ---
  duration_ms: 0.090792
  type: 'test'
  ...
# Subtest: Last month across a year boundary, and February leap-year length
ok 1072 - Last month across a year boundary, and February leap-year length
  ---
  duration_ms: 0.095917
  type: 'test'
  ...
# Subtest: Last 3 months across a year boundary
ok 1073 - Last 3 months across a year boundary
  ---
  duration_ms: 0.038833
  type: 'test'
  ...
# Subtest: custom: both bounds, one bound, or neither
ok 1074 - custom: both bounds, one bound, or neither
  ---
  duration_ms: 0.110666
  type: 'test'
  ...
# Subtest: the IST boundary is respected — 23:00 UTC is already tomorrow in Kolkata
ok 1075 - the IST boundary is respected — 23:00 UTC is already tomorrow in Kolkata
  ---
  duration_ms: 0.038333
  type: 'test'
  ...
# Subtest: THE DEFECT, reproduced: counting rows gives 27 orthopaedic, counting documents gives 22
ok 1076 - THE DEFECT, reproduced: counting rows gives 27 orthopaedic, counting documents gives 22
  ---
  duration_ms: 0.385667
  type: 'test'
  ...
# Subtest: ACCEPTANCE: the speciality chip and the list total are EQUAL for every speciality
ok 1077 - ACCEPTANCE: the speciality chip and the list total are EQUAL for every speciality
  ---
  duration_ms: 6.808083
  type: 'test'
  ...
# Subtest: ACCEPTANCE holds for every range × speciality combination
ok 1078 - ACCEPTANCE holds for every range × speciality combination
  ---
  duration_ms: 0.282417
  type: 'test'
  ...
# Subtest: the winner is the HIGHEST engine version, ties broken by latest audited_at
ok 1079 - the winner is the HIGHEST engine version, ties broken by latest audited_at
  ---
  duration_ms: 0.120625
  type: 'test'
  ...
# Subtest: input order never changes the winner
ok 1080 - input order never changes the winner
  ---
  duration_ms: 0.090916
  type: 'test'
  ...
# Subtest: version comparison is NUMERIC, so 0.10 beats 0.2 (a plain DESC sort gets this wrong)
ok 1081 - version comparison is NUMERIC, so 0.10 beats 0.2 (a plain DESC sort gets this wrong)
  ---
  duration_ms: 0.081416
  type: 'test'
  ...
# Subtest: mini/Qwen backfill rows never win a document
ok 1082 - mini/Qwen backfill rows never win a document
  ---
  duration_ms: 0.047959
  type: 'test'
  ...
# Subtest: canonicalByDocument is a READ FILTER — it never mutates the rows it is given
ok 1083 - canonicalByDocument is a READ FILTER — it never mutates the rows it is given
  ---
  duration_ms: 0.075458
  type: 'test'
  ...
# Subtest: rows with no document_id are PASSED THROUGH, never silently dropped
ok 1084 - rows with no document_id are PASSED THROUGH, never silently dropped
  ---
  duration_ms: 0.042792
  type: 'test'
  ...
# Subtest: canonicalByDocument preserves the SQL ordering of the survivors
ok 1085 - canonicalByDocument preserves the SQL ordering of the survivors
  ---
  duration_ms: 0.068
  type: 'test'
  ...
# Subtest: canonicalByDocument never throws on rubbish
ok 1086 - canonicalByDocument never throws on rubbish
  ---
  duration_ms: 0.038
  type: 'test'
  ...
# Subtest: specialityCounts buckets blank/null speciality as Unassigned and sorts by count desc
ok 1087 - specialityCounts buckets blank/null speciality as Unassigned and sorts by count desc
  ---
  duration_ms: 0.066792
  type: 'test'
  ...
# Subtest: every read surface goes through the ONE rule — no surface writes its own DISTINCT ON
ok 1088 - every read surface goes through the ONE rule — no surface writes its own DISTINCT ON
  ---
  duration_ms: 1.647708
  type: 'test'
  ...
# Subtest: NOTHING IS WRITTEN OR DELETED — this is a read filter only
ok 1089 - NOTHING IS WRITTEN OR DELETED — this is a read filter only
  ---
  duration_ms: 0.822542
  type: 'test'
  ...
# Subtest: the migration runner applies 0028 too, idempotently (§1.2 B-3)
ok 1090 - the migration runner applies 0028 too, idempotently (§1.2 B-3)
  ---
  duration_ms: 0.43875
  type: 'test'
  ...
# Subtest: the runner and 0028_review_notes.sql agree on every object
ok 1091 - the runner and 0028_review_notes.sql agree on every object
  ---
  duration_ms: 0.548792
  type: 'test'
  ...
# Subtest: the doctor lookup uses the VALIDATED table and join key, and none of the three rejected ones
ok 1092 - the doctor lookup uses the VALIDATED table and join key, and none of the three rejected ones
  ---
  duration_ms: 0.256291
  type: 'test'
  ...
# Subtest: the doctor lookup is BATCHED — one call per page, never one per row
ok 1093 - the doctor lookup is BATCHED — one call per page, never one per row
  ---
  duration_ms: 0.146875
  type: 'test'
  ...
# Subtest: the doctor lookup FAILS SOFT — the catch returns Unattributed, never throws
ok 1094 - the doctor lookup FAILS SOFT — the catch returns Unattributed, never throws
  ---
  duration_ms: 0.144709
  type: 'test'
  ...
# Subtest: inputs are validated and escaped before interpolation (no bound params in a native query)
ok 1095 - inputs are validated and escaped before interpolation (no bound params in a native query)
  ---
  duration_ms: 0.100667
  type: 'test'
  ...
# Subtest: migration 0028 is additive and idempotent; existing rows keep reading
ok 1096 - migration 0028 is additive and idempotent; existing rows keep reading
  ---
  duration_ms: 0.19425
  type: 'test'
  ...
# Subtest: the review route writes kind=review with a null finding_ref, and overwrites in place
ok 1097 - the review route writes kind=review with a null finding_ref, and overwrites in place
  ---
  duration_ms: 0.114291
  type: 'test'
  ...
# Subtest: the list query degrades when 0028 has not run — it never 500s
ok 1098 - the list query degrades when 0028 has not run — it never 500s
  ---
  duration_ms: 0.171125
  type: 'test'
  ...
# Subtest: the speciality filter renders RAW values and offers Unassigned for the nulls (§6.1)
ok 1099 - the speciality filter renders RAW values and offers Unassigned for the nulls (§6.1)
  ---
  duration_ms: 0.224167
  type: 'test'
  ...
# Subtest: the shared report renderer stays byte-identical for callers that pass no Phase B props
ok 1100 - the shared report renderer stays byte-identical for callers that pass no Phase B props
  ---
  duration_ms: 0.261583
  type: 'test'
  ...
# Subtest: vercel.json HAS an /api/ipd-audit/worker cron again
ok 1101 - vercel.json HAS an /api/ipd-audit/worker cron again
  ---
  duration_ms: 1.207125
  type: 'test'
  ...
# Subtest: THE COUPLING: the cron interval EXCEEDS the route maxDuration, so runs cannot overlap
ok 1102 - THE COUPLING: the cron interval EXCEEDS the route maxDuration, so runs cannot overlap
  ---
  duration_ms: 0.316625
  type: 'test'
  ...
# Subtest: restoring the cron did not disturb any other schedule
ok 1103 - restoring the cron did not disturb any other schedule
  ---
  duration_ms: 0.121833
  type: 'test'
  ...
# Subtest: the route records the correction, not the withdrawn claim
ok 1104 - the route records the correction, not the withdrawn claim
  ---
  duration_ms: 0.119458
  type: 'test'
  ...
# Subtest: the defaults are max 3 and conc 3 — ONE wave, not three
ok 1105 - the defaults are max 3 and conc 3 — ONE wave, not three
  ---
  duration_ms: 0.128834
  type: 'test'
  ...
# Subtest: THE ARITHMETIC the defaults rest on: one wave fits 800 s, three do not
ok 1106 - THE ARITHMETIC the defaults rest on: one wave fits 800 s, three do not
  ---
  duration_ms: 0.138041
  type: 'test'
  ...
# Subtest: the ?max= and ?conc= overrides and their caps still work
ok 1107 - the ?max= and ?conc= overrides and their caps still work
  ---
  duration_ms: 0.358541
  type: 'test'
  ...
# Subtest: servedCallFor queries stage doc_audit_analyze — NOT opd_audit_analyze
ok 1108 - servedCallFor queries stage doc_audit_analyze — NOT opd_audit_analyze
  ---
  duration_ms: 0.725583
  type: 'test'
  ...
# Subtest: the model column is no longer a constant on the cloud path
ok 1109 - the model column is no longer a constant on the cloud path
  ---
  duration_ms: 0.359375
  type: 'test'
  ...
# Subtest: THE MINI PATH IS UNCHANGED — it still records MINI_MODEL
ok 1110 - THE MINI PATH IS UNCHANGED — it still records MINI_MODEL
  ---
  duration_ms: 0.620833
  type: 'test'
  ...
# Subtest: servedCallFor soft-fails: null on a missing traceId, null on a query failure, never throws
ok 1111 - servedCallFor soft-fails: null on a missing traceId, null on a query failure, never throws
  ---
  duration_ms: 0.409666
  type: 'test'
  ...
# [lab-override] route=app/api/ask provider=bedrock model=global.anthropic.claude-haiku-4-5-20251001-v1:0 paid=true caller=lab-mcp
# [lab-override] route=app/api/ask REFUSED reason=not_admin
# [lab-override] route=app/api/ask REFUSED reason=not_admin
# [lab-override] route=app/api/ask REFUSED reason=clinician_session
# Subtest: AN MCP-ORIGIN OVERRIDE NOW PASSES THE GATE — the 7 Aug run, with the credential
ok 1112 - AN MCP-ORIGIN OVERRIDE NOW PASSES THE GATE — the 7 Aug run, with the credential
  ---
  duration_ms: 1.335708
  type: 'test'
  ...
# Subtest: THE SAME REQUEST WITHOUT THE CREDENTIAL STILL REFUSES — nothing was widened
ok 1113 - THE SAME REQUEST WITHOUT THE CREDENTIAL STILL REFUSES — nothing was widened
  ---
  duration_ms: 0.545375
  type: 'test'
  ...
# Subtest: a WRONG credential is refused, and a right one is compared timing-safely
ok 1114 - a WRONG credential is refused, and a right one is compared timing-safely
  ---
  duration_ms: 0.27625
  type: 'test'
  ...
# Subtest: ADMIN_TOKEN UNSET ⇒ refusal stays the default, on BOTH sides independently
ok 1115 - ADMIN_TOKEN UNSET ⇒ refusal stays the default, on BOTH sides independently
  ---
  duration_ms: 0.382167
  type: 'test'
  ...
# Subtest: the credential never logs, never echoes into a row, never reaches a trace
ok 1116 - the credential never logs, never echoes into a row, never reaches a trace
  ---
  duration_ms: 0.609208
  type: 'test'
  ...
# Subtest: the header unlocks the F11 gate ONLY — isAdminUnlocked gains no new caller
ok 1117 - the header unlocks the F11 gate ONLY — isAdminUnlocked gains no new caller
  ---
  duration_ms: 0.132708
  type: 'test'
  ...
# Subtest: the credential rides TLS or loopback only — never plain http to a foreign host
ok 1118 - the credential rides TLS or loopback only — never plain http to a foreign host
  ---
  duration_ms: 0.429542
  type: 'test'
  ...
# Subtest: only the two WIRED probes send it, and only when an override is requested
ok 1119 - only the two WIRED probes send it, and only when an override is requested
  ---
  duration_ms: 0.431666
  type: 'test'
  ...
# Subtest: decideOverride is untouched — the gate still DEMANDS isAdmin, it is only satisfiable now
ok 1120 - decideOverride is untouched — the gate still DEMANDS isAdmin, it is only satisfiable now
  ---
  duration_ms: 0.275625
  type: 'test'
  ...
# Subtest: a real clinician session refuses the MCP credential too (end to end)
ok 1121 - a real clinician session refuses the MCP credential too (end to end)
  ---
  duration_ms: 0.4125
  type: 'test'
  ...
# Subtest: the deps seam defaults to the real guards — production passes nothing
ok 1122 - the deps seam defaults to the real guards — production passes nothing
  ---
  duration_ms: 0.587292
  type: 'test'
  ...
# Subtest: ⚠️ THE 7 AUG RUN: a bedrock-target ask whose legs resolved to ollama is REFUSED, not stored
ok 1123 - ⚠️ THE 7 AUG RUN: a bedrock-target ask whose legs resolved to ollama is REFUSED, not stored
  ---
  duration_ms: 0.681542
  type: 'test'
  ...
# Subtest: the refused row stops asserting the model, and keeps the evidence
ok 1124 - the refused row stops asserting the model, and keeps the evidence
  ---
  duration_ms: 0.373708
  type: 'test'
  ...
# Subtest: a genuinely-served run verifies, and is stored as what SERVED
ok 1125 - a genuinely-served run verifies, and is stored as what SERVED
  ---
  duration_ms: 0.113083
  type: 'test'
  ...
# Subtest: vertex ≡ gemini across the seam — the two vocabularies are one provider
ok 1126 - vertex ≡ gemini across the seam — the two vocabularies are one provider
  ---
  duration_ms: 0.058584
  type: 'test'
  ...
# Subtest: a legitimate V-a2 ladder hop is not an error — but the row records who ANSWERED
ok 1127 - a legitimate V-a2 ladder hop is not an error — but the row records who ANSWERED
  ---
  duration_ms: 0.103708
  type: 'test'
  ...
# Subtest: utility legs are out of scope — only the legs an override steers are judged
ok 1128 - utility legs are out of scope — only the legs an override steers are judged
  ---
  duration_ms: 0.334583
  type: 'test'
  ...
# Subtest: THE LIST MUST NOT FALL BEHIND THE ROUTES: every `...LAB` traced leg is judged
ok 1129 - THE LIST MUST NOT FALL BEHIND THE ROUTES: every `...LAB` traced leg is judged
  ---
  duration_ms: 0.335292
  type: 'test'
  ...
# Subtest: a PAID claim with no recorded call is refused; a free one stores unverified
ok 1130 - a PAID claim with no recorded call is refused; a free one stores unverified
  ---
  duration_ms: 0.079
  type: 'test'
  ...
# Subtest: empty/garbage legs are treated as no evidence, never as agreement
ok 1131 - empty/garbage legs are treated as no evidence, never as agreement
  ---
  duration_ms: 0.200042
  type: 'test'
  ...
# Subtest: both F11-wired probes carry the attribution config, and the unwired ones do not
ok 1132 - both F11-wired probes carry the attribution config, and the unwired ones do not
  ---
  duration_ms: 0.452542
  type: 'test'
  ...
# Subtest: the refusal happens BEFORE the row is stored as done, or it is not a refusal
ok 1133 - the refusal happens BEFORE the row is stored as done, or it is not a refusal
  ---
  duration_ms: 0.201459
  type: 'test'
  ...
# Subtest: the probe no longer echoes the REQUESTED model into the stored output or summary
ok 1134 - the probe no longer echoes the REQUESTED model into the stored output or summary
  ---
  duration_ms: 0.1345
  type: 'test'
  ...
# Subtest: the trace id reaches the probe: routes emit it, the reducers keep it
ok 1135 - the trace id reaches the probe: routes emit it, the reducers keep it
  ---
  duration_ms: 0.174833
  type: 'test'
  ...
# Subtest: clampN clamps to 1..LB_MAX_N and floors garbage to 1
ok 1136 - clampN clamps to 1..LB_MAX_N and floors garbage to 1
  ---
  duration_ms: 0.558375
  type: 'test'
  ...
# Subtest: sanitizeUids: id-safe, de-duped, capped
ok 1137 - sanitizeUids: id-safe, de-duped, capped
  ---
  duration_ms: 1.805459
  type: 'test'
  ...
# Subtest: remainingUids removes the done-set, order preserved
ok 1138 - remainingUids removes the done-set, order preserved
  ---
  duration_ms: 0.107125
  type: 'test'
  ...
# Subtest: parseBatchState parses settings map
ok 1139 - parseBatchState parses settings map
  ---
  duration_ms: 0.181833
  type: 'test'
  ...
# Subtest: parseBatchState defaults
ok 1140 - parseBatchState defaults
  ---
  duration_ms: 0.125
  type: 'test'
  ...
# Subtest: evalRerankBackend (Addendum C): exact match only — judge/cohere parse, everything else is null
ok 1141 - evalRerankBackend (Addendum C): exact match only — judge/cohere parse, everything else is null
  ---
  duration_ms: 0.160208
  type: 'test'
  ...
# Subtest: evalRerankBackend threads batch state → evalCfg → runMiniOpdToLab (source-pinned)
ok 1142 - evalRerankBackend threads batch state → evalCfg → runMiniOpdToLab (source-pinned)
  ---
  duration_ms: 0.391875
  type: 'test'
  ...
# Subtest: batchGate precedence
ok 1143 - batchGate precedence
  ---
  duration_ms: 0.066833
  type: 'test'
  ...
# Subtest: LB_LOCK_TTL_MS is 900s and is NOT the prod worker's TTL (D1)
ok 1144 - LB_LOCK_TTL_MS is 900s and is NOT the prod worker's TTL (D1)
  ---
  duration_ms: 0.177708
  type: 'test'
  ...
# Subtest: labLockHeld mirrors mini-backfill.lockHeld exactly, differing ONLY in the TTL
ok 1145 - labLockHeld mirrors mini-backfill.lockHeld exactly, differing ONLY in the TTL
  ---
  duration_ms: 1.231166
  type: 'test'
  ...
# Subtest: THE DEFECT, reproduced: the average note outlived the old TTL
ok 1146 - THE DEFECT, reproduced: the average note outlived the old TTL
  ---
  duration_ms: 0.059583
  type: 'test'
  ...
# Subtest: ttlBreach reports the max observed ms and whether it reached the TTL
ok 1147 - ttlBreach reports the max observed ms and whether it reached the TTL
  ---
  duration_ms: 0.137208
  type: 'test'
  ...
# Subtest: ttlBreach is pure observation: never throws, ignores non-numeric ms, empty ⇒ 0
ok 1148 - ttlBreach is pure observation: never throws, ignores non-numeric ms, empty ⇒ 0
  ---
  duration_ms: 0.116958
  type: 'test'
  ...
# Subtest: the breach message is verbatim per PRD §5, with both numbers interpolated
ok 1149 - the breach message is verbatim per PRD §5, with both numbers interpolated
  ---
  duration_ms: 0.042166
  type: 'test'
  ...
# Subtest: batchGate ordering is UNCHANGED by this build
ok 1150 - batchGate ordering is UNCHANGED by this build
  ---
  duration_ms: 0.062209
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: mini path (no evalModel): n≤2, serial (concurrency 1), mini-yield honoured
ok 1151 - mini path (no evalModel): n≤2, serial (concurrency 1), mini-yield honoured
  ---
  duration_ms: 0.829792
  type: 'test'
  ...
# Subtest: eval path (evalModel set): drains exactly ONE WAVE and skips the mini-yield
ok 1152 - eval path (evalModel set): drains exactly ONE WAVE and skips the mini-yield
  ---
  duration_ms: 0.122208
  type: 'test'
  ...
# Subtest: eval sliceSize == concurrency across the whole clamped range (1..EVAL_CONCURRENCY_MAX)
ok 1153 - eval sliceSize == concurrency across the whole clamped range (1..EVAL_CONCURRENCY_MAX)
  ---
  duration_ms: 0.171958
  type: 'test'
  ...
# Subtest: THE DEFECT: the old slice was ~890s of work in one invocation; the new one is one audit
ok 1154 - THE DEFECT: the old slice was ~890s of work in one invocation; the new one is one audit
  ---
  duration_ms: 0.054875
  type: 'test'
  ...
# Subtest: EVAL_TICK_MAX remains a hard ceiling on the slice (D2)
ok 1155 - EVAL_TICK_MAX remains a hard ceiling on the slice (D2)
  ---
  duration_ms: 0.096875
  type: 'test'
  ...
# Subtest: the mini branch of drainPlan is UNTOUCHED by the one-wave change
ok 1156 - the mini branch of drainPlan is UNTOUCHED by the one-wave change
  ---
  duration_ms: 0.106042
  type: 'test'
  ...
# Subtest: clampEvalConcurrency: default 10, clamp 1..25
ok 1157 - clampEvalConcurrency: default 10, clamp 1..25
  ---
  duration_ms: 0.048
  type: 'test'
  ...
# Subtest: boundedPool never exceeds its concurrency limit and preserves result order
ok 1158 - boundedPool never exceeds its concurrency limit and preserves result order
  ---
  duration_ms: 20.168625
  type: 'test'
  ...
# Subtest: boundedPool handles limit > items and empty input
ok 1159 - boundedPool handles limit > items and empty input
  ---
  duration_ms: 0.338542
  type: 'test'
  ...
# Subtest: openRouterGenerate retries 429 then succeeds; sleeps between attempts
ok 1160 - openRouterGenerate retries 429 then succeeds; sleeps between attempts
  ---
  duration_ms: 15.320333
  type: 'test'
  ...
# Subtest: openRouterGenerate throws after OPENROUTER_MAX_TRIES persistent 5xx — no silent fallback
ok 1161 - openRouterGenerate throws after OPENROUTER_MAX_TRIES persistent 5xx — no silent fallback
  ---
  duration_ms: 1.874542
  type: 'test'
  ...
# Subtest: non-transient status (400) throws immediately — no retry
ok 1162 - non-transient status (400) throws immediately — no retry
  ---
  duration_ms: 0.50825
  type: 'test'
  ...
# Subtest: retryable statuses are exactly 429 + 5xx; backoff is jittered-exponential and positive
ok 1163 - retryable statuses are exactly 429 + 5xx; backoff is jittered-exponential and positive
  ---
  duration_ms: 0.150125
  type: 'test'
  ...
# Subtest: the eval drain still writes lab_analyses only — never opd_note_audits
ok 1164 - the eval drain still writes lab_analyses only — never opd_note_audits
  ---
  duration_ms: 0.485791
  type: 'test'
  ...
# Subtest: the tick summary carries tick_ms / slice_planned / slice_drained (D3)
ok 1165 - the tick summary carries tick_ms / slice_planned / slice_drained (D3)
  ---
  duration_ms: 0.471625
  type: 'test'
  ...
# Subtest: the D3 fields are OBSERVATION ONLY — never branched on, never thrown from
ok 1166 - the D3 fields are OBSERVATION ONLY — never branched on, never thrown from
  ---
  duration_ms: 0.951625
  type: 'test'
  ...
# Subtest: LB_LOCK_TTL_MS / labLockHeld / ttlBreach survive this build unchanged
ok 1167 - LB_LOCK_TTL_MS / labLockHeld / ttlBreach survive this build unchanged
  ---
  duration_ms: 0.45825
  type: 'test'
  ...
# Subtest: parseBatchState reads evalConcurrency; absent ⇒ default 10
ok 1168 - parseBatchState reads evalConcurrency; absent ⇒ default 10
  ---
  duration_ms: 0.297833
  type: 'test'
  ...
# Subtest: parseNdjson tolerates blank + garbled lines
ok 1169 - parseNdjson tolerates blank + garbled lines
  ---
  duration_ms: 1.1445
  type: 'test'
  ...
# Subtest: reduceDdxEvents folds a full stream
ok 1170 - reduceDdxEvents folds a full stream
  ---
  duration_ms: 0.95175
  type: 'test'
  ...
# Subtest: reduceDdxEvents surfaces an error stream as not-ok
ok 1171 - reduceDdxEvents surfaces an error stream as not-ok
  ---
  duration_ms: 0.344917
  type: 'test'
  ...
# Subtest: extractCitationIds pulls distinct sorted numeric ids
ok 1172 - extractCitationIds pulls distinct sorted numeric ids
  ---
  duration_ms: 0.274417
  type: 'test'
  ...
# Subtest: reduceAskEvents keeps the revised answer, flags uncited
ok 1173 - reduceAskEvents keeps the revised answer, flags uncited
  ---
  duration_ms: 0.3005
  type: 'test'
  ...
# Subtest: reduceAskEvents flags a long uncited answer (cite-or-label canary)
ok 1174 - reduceAskEvents flags a long uncited answer (cite-or-label canary)
  ---
  duration_ms: 0.150042
  type: 'test'
  ...
# Subtest: reduceAppropriatenessEvents captures fired CW statements (over-flag surface)
ok 1175 - reduceAppropriatenessEvents captures fired CW statements (over-flag surface)
  ---
  duration_ms: 0.297542
  type: 'test'
  ...
# Subtest: reduceAppropriatenessEvents handles the empty (nothing-fired) case
ok 1176 - reduceAppropriatenessEvents handles the empty (nothing-fired) case
  ---
  duration_ms: 0.149916
  type: 'test'
  ...
# Subtest: reduceDocAuditEvents pulls the scorecard headline/band
ok 1177 - reduceDocAuditEvents pulls the scorecard headline/band
  ---
  duration_ms: 0.59025
  type: 'test'
  ...
# Subtest: reduceDocAuditEvents surfaces a stream error
ok 1178 - reduceDocAuditEvents surfaces a stream error
  ---
  duration_ms: 0.634625
  type: 'test'
  ...
# Subtest: labSelfBaseUrl prefers explicit, then VERCEL_URL, then localhost
ok 1179 - labSelfBaseUrl prefers explicit, then VERCEL_URL, then localhost
  ---
  duration_ms: 0.24825
  type: 'test'
  ...
# Subtest: labLabel sanitises to a safe slug
ok 1180 - labLabel sanitises to a safe slug
  ---
  duration_ms: 0.4455
  type: 'test'
  ...
# Subtest: chunkText splits on paragraphs, drops tiny fragments, respects the window
ok 1181 - chunkText splits on paragraphs, drops tiny fragments, respects the window
  ---
  duration_ms: 0.1975
  type: 'test'
  ...
# Subtest: chunkText hard-splits a single monster paragraph
ok 1182 - chunkText hard-splits a single monster paragraph
  ---
  duration_ms: 0.091458
  type: 'test'
  ...
# Subtest: chunkText returns empty for whitespace-only input
ok 1183 - chunkText returns empty for whitespace-only input
  ---
  duration_ms: 0.989
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: quarantine INSERT carries visible in the columns and false in the values
ok 1184 - quarantine INSERT carries visible in the columns and false in the values
  ---
  duration_ms: 0.539334
  type: 'test'
  ...
# Subtest: activation UPDATE sets both source and visible = true
ok 1185 - activation UPDATE sets both source and visible = true
  ---
  duration_ms: 0.061958
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: G2/A10.3: the two SCOPES constants differ and are NOT unified
ok 1186 - G2/A10.3: the two SCOPES constants differ and are NOT unified
  ---
  duration_ms: 0.981708
  type: 'test'
  ...
# Subtest: F6: parseFeedbackBody REFUSES scope=missed without a category
ok 1187 - F6: parseFeedbackBody REFUSES scope=missed without a category
  ---
  duration_ms: 0.211625
  type: 'test'
  ...
# Subtest: F6: accepts every whitelisted category, rejects an unknown one
ok 1188 - F6: accepts every whitelisted category, rejects an unknown one
  ---
  duration_ms: 0.172041
  type: 'test'
  ...
# Subtest: F6: the required-category change touches ONLY scope=missed
ok 1189 - F6: the required-category change touches ONLY scope=missed
  ---
  duration_ms: 0.14175
  type: 'test'
  ...
# Subtest: F6: rollup groups missed by CATEGORY and reports recall_proxy as a lower bound
ok 1190 - F6: rollup groups missed by CATEGORY and reports recall_proxy as a lower bound
  ---
  duration_ms: 0.477625
  type: 'test'
  ...
# Subtest: F6: recall_proxy is null on a zero denominator, never NaN
ok 1191 - F6: recall_proxy is null on a zero denominator, never NaN
  ---
  duration_ms: 0.079666
  type: 'test'
  ...
# Subtest: F6: the category→signal map is deliberately partial
ok 1192 - F6: the category→signal map is deliberately partial
  ---
  duration_ms: 0.1015
  type: 'test'
  ...
# Subtest: F17: impact fold reports both tags and coverage_of_tp
ok 1193 - F17: impact fold reports both tags and coverage_of_tp
  ---
  duration_ms: 0.110709
  type: 'test'
  ...
# Subtest: F17: absent impact rows degrade to zeroes and a null coverage, never a throw
ok 1194 - F17: absent impact rows degrade to zeroes and a null coverage, never a throw
  ---
  duration_ms: 0.183209
  type: 'test'
  ...
# Subtest: F11: resolver maps all three prefixes and marks paid correctly
ok 1195 - F11: resolver maps all three prefixes and marks paid correctly
  ---
  duration_ms: 0.346375
  type: 'test'
  ...
# Subtest: F11: omitted model = the local mini, behaviour unchanged
ok 1196 - F11: omitted model = the local mini, behaviour unchanged
  ---
  duration_ms: 0.046167
  type: 'test'
  ...
# Subtest: F11: an unknown provider ERRORS LOUD and never falls back to the mini
ok 1197 - F11: an unknown provider ERRORS LOUD and never falls back to the mini
  ---
  duration_ms: 0.054584
  type: 'test'
  ...
# Subtest: F11: paid ceiling defaults to 250, stops at N and reports
ok 1198 - F11: paid ceiling defaults to 250, stops at N and reports
  ---
  duration_ms: 0.073083
  type: 'test'
  ...
# Subtest: F12b: allowlisted source files are readable
ok 1199 - F12b: allowlisted source files are readable
  ---
  duration_ms: 0.352958
  type: 'test'
  ...
# Subtest: F12b: ../ traversal cannot escape, even disguised behind an allowed prefix
ok 1200 - F12b: ../ traversal cannot escape, even disguised behind an allowed prefix
  ---
  duration_ms: 0.071125
  type: 'test'
  ...
# Subtest: F12b: denylisted names are refused wherever they sit, including under lib/
ok 1201 - F12b: denylisted names are refused wherever they sit, including under lib/
  ---
  duration_ms: 0.103917
  type: 'test'
  ...
# Subtest: F12b: absolute paths, non-source files and anything outside the seam are refused
ok 1202 - F12b: absolute paths, non-source files and anything outside the seam are refused
  ---
  duration_ms: 0.043916
  type: 'test'
  ...
# Subtest: F13: corpus_add refuses a chunk with no citation
ok 1203 - F13: corpus_add refuses a chunk with no citation
  ---
  duration_ms: 0.092416
  type: 'test'
  ...
# Subtest: F13: accepts any ONE of url/doi/pmid with year + licence
ok 1204 - F13: accepts any ONE of url/doi/pmid with year + licence
  ---
  duration_ms: 0.053917
  type: 'test'
  ...
# Subtest: F13: the internal-protocol escape bypasses the gate entirely
ok 1205 - F13: the internal-protocol escape bypasses the gate entirely
  ---
  duration_ms: 0.036917
  type: 'test'
  ...
# Subtest: F13: year and licence are validated, not merely present
ok 1206 - F13: year and licence are validated, not merely present
  ---
  duration_ms: 0.046917
  type: 'test'
  ...
# Subtest: F14: lvc_propose refuses an uncited proposal
ok 1207 - F14: lvc_propose refuses an uncited proposal
  ---
  duration_ms: 0.129875
  type: 'test'
  ...
# Subtest: F14 (A10.4): lvc_propose REFUSES a near-duplicate unless supersedes_id is supplied
ok 1208 - F14 (A10.4): lvc_propose REFUSES a near-duplicate unless supersedes_id is supplied
  ---
  duration_ms: 0.285917
  type: 'test'
  ...
# Subtest: F14: a genuinely distinct cited statement is accepted
ok 1209 - F14: a genuinely distinct cited statement is accepted
  ---
  duration_ms: 0.119833
  type: 'test'
  ...
# Subtest: F14: the duplicate detector recognises the measured rulebook variants
ok 1210 - F14: the duplicate detector recognises the measured rulebook variants
  ---
  duration_ms: 0.067875
  type: 'test'
  ...
# Subtest: F14: lvc_ratify refuses without confirm, with the default author, or without a rationale
ok 1211 - F14: lvc_ratify refuses without confirm, with the default author, or without a rationale
  ---
  duration_ms: 0.089625
  type: 'test'
  ...
# Subtest: F14: lvc_ratify is PROMOTE-ONLY — it cannot create de novo
ok 1212 - F14: lvc_ratify is PROMOTE-ONLY — it cannot create de novo
  ---
  duration_ms: 0.034292
  type: 'test'
  ...
# Subtest: F14: only a proposed row is promotable; rejection is first-class, never a delete
ok 1213 - F14: only a proposed row is promotable; rejection is first-class, never a delete
  ---
  duration_ms: 0.060875
  type: 'test'
  ...
# Subtest: F14: lvc_gaps calls a never-fired rule a RETIREMENT candidate, not a citation candidate
ok 1214 - F14: lvc_gaps calls a never-fired rule a RETIREMENT candidate, not a citation candidate
  ---
  duration_ms: 0.111959
  type: 'test'
  ...
# Subtest: F14: gaps rank by fires within class
ok 1215 - F14: gaps rank by fires within class
  ---
  duration_ms: 0.035875
  type: 'test'
  ...
# Subtest: F16: lab:/labq: weights are clamped at 0.855 until promoted
ok 1216 - F16: lab:/labq: weights are clamped at 0.855 until promoted
  ---
  duration_ms: 0.060041
  type: 'test'
  ...
# Subtest: F17: feedback_detail ADMITS scope=impact (it was write-only) and validates its tags
ok 1217 - F17: feedback_detail ADMITS scope=impact (it was write-only) and validates its tags
  ---
  duration_ms: 0.353416
  type: 'test'
  ...
# Subtest: F6 UI: SavedEvent carries category; applySaved dedupe semantics are unchanged
ok 1218 - F6 UI: SavedEvent carries category; applySaved dedupe semantics are unchanged
  ---
  duration_ms: 0.088583
  type: 'test'
  ...
# Subtest: F6 UI: every category the controls offer is one the write path accepts
ok 1219 - F6 UI: every category the controls offer is one the write path accepts
  ---
  duration_ms: 0.05625
  type: 'test'
  ...
# Subtest: wiring: the four new tools are registered with their required args
ok 1220 - wiring: the four new tools are registered with their required args
  ---
  duration_ms: 0.124791
  type: 'test'
  ...
# Subtest: wiring: corpus_add exposes all six F13 provenance fields
ok 1221 - wiring: corpus_add exposes all six F13 provenance fields
  ---
  duration_ms: 0.037709
  type: 'test'
  ...
# Subtest: wiring: F13 provenance reaches the INSERT, and quarantine stays invisible
ok 1222 - wiring: F13 provenance reaches the INSERT, and quarantine stays invisible
  ---
  duration_ms: 0.04975
  type: 'test'
  ...
# Subtest: wiring: every new tool description states its WRITE-CLASS (F3 discipline held)
ok 1223 - wiring: every new tool description states its WRITE-CLASS (F3 discipline held)
  ---
  duration_ms: 0.042292
  type: 'test'
  ...
# Subtest: wiring: lvc_propose never claims to write the rulebook; lvc_ratify is promote-only
ok 1224 - wiring: lvc_propose never claims to write the rulebook; lvc_ratify is promote-only
  ---
  duration_ms: 0.05325
  type: 'test'
  ...
# Subtest: F14 faults 1a + 7: ALL THREE lvc_recommendations query sites use `society`, never `source`
ok 1225 - F14 faults 1a + 7: ALL THREE lvc_recommendations query sites use `society`, never `source`
  ---
  duration_ms: 0.31675
  type: 'test'
  ...
# Subtest: F14 fault 6: region is supplied — the NOT NULL set is exactly id, region, society, statement
ok 1226 - F14 fault 6: region is supplied — the NOT NULL set is exactly id, region, society, statement
  ---
  duration_ms: 0.081833
  type: 'test'
  ...
# Subtest: F14 fault 1b: the promoted row is society=EHRC, UPPERCASE
ok 1227 - F14 fault 1b: the promoted row is society=EHRC, UPPERCASE
  ---
  duration_ms: 0.136417
  type: 'test'
  ...
# Subtest: F14 faults 2-4: the promotion INSERT names the three audit columns 0024 adds
ok 1228 - F14 faults 2-4: the promotion INSERT names the three audit columns 0024 adds
  ---
  duration_ms: 0.119709
  type: 'test'
  ...
# Subtest: F14 fault 5: `id` is supplied explicitly, matching the ehrc-<uuid> convention
ok 1229 - F14 fault 5: `id` is supplied explicitly, matching the ehrc-<uuid> convention
  ---
  duration_ms: 0.11875
  type: 'test'
  ...
# Subtest: F14: migration 0024 is additive, idempotent, and targets ONE table
ok 1230 - F14: migration 0024 is additive, idempotent, and targets ONE table
  ---
  duration_ms: 0.437417
  type: 'test'
  ...
# Subtest: migration 0023 targets mksap_chunks and never a table called `corpus`
ok 1231 - migration 0023 targets mksap_chunks and never a table called `corpus`
  ---
  duration_ms: 0.359625
  type: 'test'
  ...
# Subtest: 0023 and the runtime DDL agree on lvc_ratifications.promoted_id
ok 1232 - 0023 and the runtime DDL agree on lvc_ratifications.promoted_id
  ---
  duration_ms: 0.430333
  type: 'test'
  ...
# Subtest: 0023 remains a NO-OP on re-run: every statement is guarded, nothing destructive
ok 1233 - 0023 remains a NO-OP on re-run: every statement is guarded, nothing destructive
  ---
  duration_ms: 0.269583
  type: 'test'
  ...
# Subtest: F11: exactly the three honourable probe tools expose `model` and `ceiling`
ok 1234 - F11: exactly the three honourable probe tools expose `model` and `ceiling`
  ---
  duration_ms: 0.049708
  type: 'test'
  ...
# Subtest: F11: the three unwired-route probes have NO model param and SAY why (A4)
ok 1235 - F11: the three unwired-route probes have NO model param and SAY why (A4)
  ---
  duration_ms: 0.054917
  type: 'test'
  ...
# Subtest: F11: the model param resolves all three prefixes and errors loud on unknown
ok 1236 - F11: the model param resolves all three prefixes and errors loud on unknown
  ---
  duration_ms: 0.062834
  type: 'test'
  ...
# Subtest: F11: omitted model ⇒ the local mini, byte-identical, and NOT paid
ok 1237 - F11: omitted model ⇒ the local mini, byte-identical, and NOT paid
  ---
  duration_ms: 0.243416
  type: 'test'
  ...
# Subtest: F11: the paid ceiling stops at N and reports; free runs never count
ok 1238 - F11: the paid ceiling stops at N and reports; free runs never count
  ---
  duration_ms: 0.044667
  type: 'test'
  ...
# Subtest: F11: provider is recorded on lab_analyses alongside the RESOLVED model
ok 1239 - F11: provider is recorded on lab_analyses alongside the RESOLVED model
  ---
  duration_ms: 0.317875
  type: 'test'
  ...
# Subtest: F11: NO route file was touched in this build
ok 1240 - F11: NO route file was touched in this build
  ---
  duration_ms: 0.334416
  type: 'test'
  ...
# Subtest: F11: the engine label is DERIVED from the resolved provider, not hardcoded
ok 1241 - F11: the engine label is DERIVED from the resolved provider, not hardcoded
  ---
  duration_ms: 0.341958
  type: 'test'
  ...
# Subtest: F11: ollama maps back to "mini" so every historical label is preserved exactly
ok 1242 - F11: ollama maps back to "mini" so every historical label is preserved exactly
  ---
  duration_ms: 0.219834
  type: 'test'
  ...
# Subtest: F11: mini_analyze TEXT mode refuses a model rather than accepting and ignoring it
ok 1243 - F11: mini_analyze TEXT mode refuses a model rather than accepting and ignoring it
  ---
  duration_ms: 0.218333
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY (a): with no labModel the gate short-circuits to "no override"
ok 1244 - BYTE-IDENTITY (a): with no labModel the gate short-circuits to "no override"
  ---
  duration_ms: 0.544375
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY (b): labRoutingOpts(null) is {} and the spread changes nothing
ok 1245 - BYTE-IDENTITY (b): labRoutingOpts(null) is {} and the spread changes nothing
  ---
  duration_ms: 0.37825
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY (c): EVERY routing site in EVERY wired route threads ...LAB — none left behind
ok 1246 - BYTE-IDENTITY (c): EVERY routing site in EVERY wired route threads ...LAB — none left behind
  ---
  duration_ms: 0.464583
  type: 'test'
  ...
# Subtest: BYTE-IDENTITY per route: each wired route calls the gate and takes labModel additively
ok 1247 - BYTE-IDENTITY per route: each wired route calls the gate and takes labModel additively
  ---
  duration_ms: 0.184083
  type: 'test'
  ...
# Subtest: the wiring is ADDITIVE: labModel is the only new body field, providerOverride unchanged
ok 1248 - the wiring is ADDITIVE: labModel is the only new body field, providerOverride unchanged
  ---
  duration_ms: 0.062667
  type: 'test'
  ...
# Subtest: every wired route records the RESOLVED model on the trace, never the requested string
ok 1249 - every wired route records the RESOLVED model on the trace, never the requested string
  ---
  duration_ms: 0.066375
  type: 'test'
  ...
# Subtest: CONTAINMENT: exactly the two model-string routes are wired; the three forceOllama routes are NOT
ok 1250 - CONTAINMENT: exactly the two model-string routes are wired; the three forceOllama routes are NOT
  ---
  duration_ms: 0.285417
  type: 'test'
  ...
# Subtest: CONTAINMENT: no SIXTH route imports the gate
ok 1251 - CONTAINMENT: no SIXTH route imports the gate
  ---
  duration_ms: 13.118
  type: 'test'
  ...
# Subtest: selfPostNdjson can now carry the lab-origin header (gate condition 2)
ok 1252 - selfPostNdjson can now carry the lab-origin header (gate condition 2)
  ---
  duration_ms: 0.284834
  type: 'test'
  ...
# Subtest: routing map: vertex→gemini, openrouter clears gemini, ollama forces the mini
ok 1253 - routing map: vertex→gemini, openrouter clears gemini, ollama forces the mini
  ---
  duration_ms: 0.312125
  type: 'test'
  ...
# Subtest: condition 6 probe is deterministic and refuses an unknown provider
ok 1254 - condition 6 probe is deterministic and refuses an unknown provider
  ---
  duration_ms: 0.104041
  type: 'test'
  ...
# Subtest: THE INVARIANT: no model requested ⇒ no override — this is what keeps the five routes byte-identical
ok 1255 - THE INVARIANT: no model requested ⇒ no override — this is what keeps the five routes byte-identical
  ---
  duration_ms: 0.735834
  type: 'test'
  ...
# Subtest: the full pass path honours the override and reports the RESOLVED model
ok 1256 - the full pass path honours the override and reports the RESOLVED model
  ---
  duration_ms: 0.077375
  type: 'test'
  ...
# Subtest: 1 — env flag: absent, unset or anything but "1" ⇒ OFF (the kill switch)
ok 1257 - 1 — env flag: absent, unset or anything but "1" ⇒ OFF (the kill switch)
  ---
  duration_ms: 0.069708
  type: 'test'
  ...
# Subtest: 2 — lab-origin marker: a header, and only the exact value passes
ok 1258 - 2 — lab-origin marker: a header, and only the exact value passes
  ---
  duration_ms: 0.05925
  type: 'test'
  ...
# Subtest: 3 — admin auth must pass on the same request
ok 1259 - 3 — admin auth must pass on the same request
  ---
  duration_ms: 0.045
  type: 'test'
  ...
# Subtest: 4 — a clinician session REFUSES the override even when 1-3 all pass
ok 1260 - 4 — a clinician session REFUSES the override even when 1-3 all pass
  ---
  duration_ms: 0.096458
  type: 'test'
  ...
# Subtest: 5 — an unknown provider prefix falls through to the production default
ok 1261 - 5 — an unknown provider prefix falls through to the production default
  ---
  duration_ms: 0.049666
  type: 'test'
  ...
# Subtest: 6 — an unreachable model falls through to default, and UNPROBED counts as unreachable
ok 1262 - 6 — an unreachable model falls through to default, and UNPROBED counts as unreachable
  ---
  duration_ms: 0.039125
  type: 'test'
  ...
# Subtest: the gate NEVER throws and NEVER returns an error, whatever it is handed
ok 1263 - the gate NEVER throws and NEVER returns an error, whatever it is handed
  ---
  duration_ms: 0.2265
  type: 'test'
  ...
# Subtest: condition ORDER is the safety property — the kill switch is evaluated first
ok 1264 - condition ORDER is the safety property — the kill switch is evaluated first
  ---
  duration_ms: 0.28475
  type: 'test'
  ...
# Subtest: an honoured override logs route · provider · resolved model · caller (A12)
ok 1265 - an honoured override logs route · provider · resolved model · caller (A12)
  ---
  duration_ms: 0.109958
  type: 'test'
  ...
# Subtest: refusals are logged except the normal no-override path
ok 1266 - refusals are logged except the normal no-override path
  ---
  duration_ms: 0.047333
  type: 'test'
  ...
# Subtest: ollama and vertex both pass the gate when everything else does
ok 1267 - ollama and vertex both pass the gate when everything else does
  ---
  duration_ms: 0.051667
  type: 'test'
  ...
# Subtest: ROUND TRIP: serialise → parse returns a deeply equal package set
ok 1268 - ROUND TRIP: serialise → parse returns a deeply equal package set
  ---
  duration_ms: 2.334
  type: 'test'
  ...
# Subtest: ROUND TRIP: re-importing an unmodified export yields a ZERO-ROW DIFF
ok 1269 - ROUND TRIP: re-importing an unmodified export yields a ZERO-ROW DIFF
  ---
  duration_ms: 0.74725
  type: 'test'
  ...
# Subtest: ROUND TRIP: the import route refuses to create a version when the diff is empty
ok 1270 - ROUND TRIP: the import route refuses to create a version when the diff is empty
  ---
  duration_ms: 0.297667
  type: 'test'
  ...
# Subtest: ROUND TRIP survives the awkward characters — quotes, commas, semicolons, unicode
ok 1271 - ROUND TRIP survives the awkward characters — quotes, commas, semicolons, unicode
  ---
  duration_ms: 0.318834
  type: 'test'
  ...
# Subtest: ROUND TRIP is stable across CRLF and a BOM (what Excel actually writes)
ok 1272 - ROUND TRIP is stable across CRLF and a BOM (what Excel actually writes)
  ---
  duration_ms: 0.470334
  type: 'test'
  ...
# Subtest: an empty package set round-trips to a header-only file and back
ok 1273 - an empty package set round-trips to a header-only file and back
  ---
  duration_ms: 0.324
  type: 'test'
  ...
# Subtest: CSV validation rejects each invalid case named in §7.3, and applies nothing
ok 1274 - CSV validation rejects each invalid case named in §7.3, and applies nothing
  ---
  duration_ms: 0.413916
  type: 'test'
  ...
# Subtest: CSV validation rejects an oversize row count and a non-.csv extension
ok 1275 - CSV validation rejects an oversize row count and a non-.csv extension
  ---
  duration_ms: 2.95125
  type: 'test'
  ...
# Subtest: constituents and aliases are trimmed and de-duplicated case-insensitively on ingest
ok 1276 - constituents and aliases are trimmed and de-duplicated case-insensitively on ingest
  ---
  duration_ms: 0.886458
  type: 'test'
  ...
# Subtest: the low-level CSV splitters handle quotes, doubled quotes and embedded newlines
ok 1277 - the low-level CSV splitters handle quotes, doubled quotes and embedded newlines
  ---
  duration_ms: 0.908209
  type: 'test'
  ...
# Subtest: the diff lists REMOVALS explicitly — they can never be inferred from a count alone
ok 1278 - the diff lists REMOVALS explicitly — they can never be inferred from a count alone
  ---
  duration_ms: 0.595542
  type: 'test'
  ...
# Subtest: the diff reports constituent and alias movement per package
ok 1279 - the diff reports constituent and alias movement per package
  ---
  duration_ms: 14.58625
  type: 'test'
  ...
# Subtest: EQUIVALENCE: an empty or malformed package set leaves the judge prompt BYTE-IDENTICAL
ok 1280 - EQUIVALENCE: an empty or malformed package set leaves the judge prompt BYTE-IDENTICAL
  ---
  duration_ms: 0.205458
  type: 'test'
  ...
# Subtest: EQUIVALENCE holds with the other optional context blocks present too
ok 1281 - EQUIVALENCE holds with the other optional context blocks present too
  ---
  duration_ms: 0.064125
  type: 'test'
  ...
# Subtest: a REAL package set adds a factual block and changes nothing else
ok 1282 - a REAL package set adds a factual block and changes nothing else
  ---
  duration_ms: 0.258375
  type: 'test'
  ...
# Subtest: the LVC judge call fails OPEN — a package-context error cannot cost a judgement
ok 1283 - the LVC judge call fails OPEN — a package-context error cannot cost a judgement
  ---
  duration_ms: 0.136375
  type: 'test'
  ...
# Subtest: the applicability rubric itself is UNTOUCHED — this build adds context, not policy
ok 1284 - the applicability rubric itself is UNTOUCHED — this build adds context, not policy
  ---
  duration_ms: 0.146667
  type: 'test'
  ...
# Subtest: parseStoredLabPackages is the ARRAY branch of the divergent weights shape (§12.3)
ok 1285 - parseStoredLabPackages is the ARRAY branch of the divergent weights shape (§12.3)
  ---
  duration_ms: 0.134417
  type: 'test'
  ...
# Subtest: the publish path branches on shape so an array is not hashed against field keys
ok 1286 - the publish path branches on shape so an array is not hashed against field keys
  ---
  duration_ms: 0.136833
  type: 'test'
  ...
# Subtest: the generator de-duplicates the doubled source strings and drops self-references
ok 1287 - the generator de-duplicates the doubled source strings and drops self-references
  ---
  duration_ms: 0.077292
  type: 'test'
  ...
# Subtest: data/lab-packages.json is valid JSON and safe whatever state it is in
ok 1288 - data/lab-packages.json is valid JSON and safe whatever state it is in
  ---
  duration_ms: 0.771166
  type: 'test'
  ...
# Subtest: NULL means UNKNOWN, never zero — the single most important rule here
ok 1289 - NULL means UNKNOWN, never zero — the single most important rule here
  ---
  duration_ms: 0.068916
  type: 'test'
  ...
# Subtest: "None ordered" matches = 0 EXPLICITLY; unknown survives neither filtered view
ok 1290 - "None ordered" matches = 0 EXPLICITLY; unknown survives neither filtered view
  ---
  duration_ms: 0.046875
  type: 'test'
  ...
# Subtest: the lookup merges duplicate prescription rows so ORDERED never loses to a sibling 0
ok 1291 - the lookup merges duplicate prescription rows so ORDERED never loses to a sibling 0
  ---
  duration_ms: 0.095833
  type: 'test'
  ...
# Subtest: FAIL-SOFT: an unavailable lookup makes the filter INERT, not empty
ok 1292 - FAIL-SOFT: an unavailable lookup makes the filter INERT, not empty
  ---
  duration_ms: 0.19725
  type: 'test'
  ...
# Subtest: the investigations query uses the VALIDATED, DOUBLE-QUOTED hyphenated table
ok 1293 - the investigations query uses the VALIDATED, DOUBLE-QUOTED hyphenated table
  ---
  duration_ms: 0.201
  type: 'test'
  ...
# Subtest: the OPD filter control disables itself rather than disappearing when db13 is down
ok 1294 - the OPD filter control disables itself rather than disappearing when db13 is down
  ---
  duration_ms: 0.083458
  type: 'test'
  ...
# Subtest: FIX 0 ACCEPTANCE: 2026-07-25 collapses 532 audit rows to 429 notes
ok 1295 - FIX 0 ACCEPTANCE: 2026-07-25 collapses 532 audit rows to 429 notes
  ---
  duration_ms: 0.684458
  type: 'test'
  ...
# Subtest: FIX 0: numeric version comparison — 0.81.14 beats 0.81.9 (lexicographic gets this wrong)
ok 1296 - FIX 0: numeric version comparison — 0.81.14 beats 0.81.9 (lexicographic gets this wrong)
  ---
  duration_ms: 0.044458
  type: 'test'
  ...
# Subtest: FIX 0: ONE implementation — canonicalByUid and canonicalByDocument are the same function
ok 1297 - FIX 0: ONE implementation — canonicalByUid and canonicalByDocument are the same function
  ---
  duration_ms: 0.139792
  type: 'test'
  ...
# Subtest: FIX 0: the OPD aggregates filter on the canonical set, and now FAIL CLOSED
ok 1298 - FIX 0: the OPD aggregates filter on the canonical set, and now FAIL CLOSED
  ---
  duration_ms: 0.465667
  type: 'test'
  ...
# Subtest: subjectSignature clusters near-verbatim subjects, ignores dose/case/parentheticals
ok 1299 - subjectSignature clusters near-verbatim subjects, ignores dose/case/parentheticals
  ---
  duration_ms: 0.970417
  type: 'test'
  ...
# Subtest: mineRuleCandidates: passes the volume + evidence gates, excludes the rest
ok 1300 - mineRuleCandidates: passes the volume + evidence gates, excludes the rest
  ---
  duration_ms: 0.804208
  type: 'test'
  ...
# Subtest: parseCanonicalMap maps indices → labels, ignores out-of-range
ok 1301 - parseCanonicalMap maps indices → labels, ignores out-of-range
  ---
  duration_ms: 0.121208
  type: 'test'
  ...
# Subtest: canonical label MERGES paraphrases that the deterministic signature would fragment
ok 1302 - canonical label MERGES paraphrases that the deterministic signature would fragment
  ---
  duration_ms: 0.255125
  type: 'test'
  ...
# Subtest: mineHarvestGaps: predominantly-UNCITED practices become harvest topics; well-cited/sparse do not
ok 1303 - mineHarvestGaps: predominantly-UNCITED practices become harvest topics; well-cited/sparse do not
  ---
  duration_ms: 0.574542
  type: 'test'
  ...
# Subtest: mineRuleCandidates: context-dependent → limit; prescribing domain → pharmacy_ams
ok 1304 - mineRuleCandidates: context-dependent → limit; prescribing domain → pharmacy_ams
  ---
  duration_ms: 0.118042
  type: 'test'
  ...
# Subtest: truncateCard: caps + ellipsis at the 140 boundary, collapses whitespace
ok 1305 - truncateCard: caps + ellipsis at the 140 boundary, collapses whitespace
  ---
  duration_ms: 0.061292
  type: 'test'
  ...
# Subtest: mineMissedFlags: same-signature flags cluster; a singleton is its own cluster (≥1 harvests)
ok 1306 - mineMissedFlags: same-signature flags cluster; a singleton is its own cluster (≥1 harvests)
  ---
  duration_ms: 0.476875
  type: 'test'
  ...
# Subtest: mineMissedFlags: citable cluster → deterministic missed_rule draft
ok 1307 - mineMissedFlags: citable cluster → deterministic missed_rule draft
  ---
  duration_ms: 0.208125
  type: 'test'
  ...
# Subtest: mineMissedFlags: uncitable → harvest_topic (evidence over frequency)
ok 1308 - mineMissedFlags: uncitable → harvest_topic (evidence over frequency)
  ---
  duration_ms: 0.302292
  type: 'test'
  ...
# Subtest: mineFalseClusters: ≥3 false/nitpick across ≥2 reviewers AND precision <0.5 → suppression
ok 1309 - mineFalseClusters: ≥3 false/nitpick across ≥2 reviewers AND precision <0.5 → suppression
  ---
  duration_ms: 0.203917
  type: 'test'
  ...
# Subtest: mineFalseClusters: precision ≥0.5 blocks the candidate even at volume
ok 1310 - mineFalseClusters: precision ≥0.5 blocks the candidate even at volume
  ---
  duration_ms: 0.918958
  type: 'test'
  ...
# Subtest: mineFalseClusters: single-reviewer cluster blocked (needs ≥2)
ok 1311 - mineFalseClusters: single-reviewer cluster blocked (needs ≥2)
  ---
  duration_ms: 0.232959
  type: 'test'
  ...
# Subtest: gate constants pinned to normative values (§2.3 + HARVEST-DEMAND-RANK §2.3)
ok 1312 - gate constants pinned to normative values (§2.3 + HARVEST-DEMAND-RANK §2.3)
  ---
  duration_ms: 0.139
  type: 'test'
  ...
# Subtest: demandRankScore: zero → 0, full saturation → 100
ok 1313 - demandRankScore: zero → 0, full saturation → 100
  ---
  duration_ms: 0.193083
  type: 'test'
  ...
# Subtest: demandRankScore: deficit outweighs volume outweighs breadth at equal magnitude
ok 1314 - demandRankScore: deficit outweighs volume outweighs breadth at equal magnitude
  ---
  duration_ms: 0.345292
  type: 'test'
  ...
# Subtest: demandRankScore: monotone non-decreasing in each term; clamps junk input
ok 1315 - demandRankScore: monotone non-decreasing in each term; clamps junk input
  ---
  duration_ms: 0.273959
  type: 'test'
  ...
# Subtest: coverageDeficitOf: 1 − topSim, clamped
ok 1316 - coverageDeficitOf: 1 − topSim, clamped
  ---
  duration_ms: 0.126417
  type: 'test'
  ...
# Subtest: mineHarvestGaps: back-compat — no probe injected → ranks by uncited volume, no demandRank
ok 1317 - mineHarvestGaps: back-compat — no probe injected → ranks by uncited volume, no demandRank
  ---
  duration_ms: 0.54275
  type: 'test'
  ...
# Subtest: mineHarvestGaps: live probe DROPS a covered topic even though citedFrac passed it
ok 1318 - mineHarvestGaps: live probe DROPS a covered topic even though citedFrac passed it
  ---
  duration_ms: 0.487
  type: 'test'
  ...
# Subtest: mineHarvestGaps: a low-volume/high-deficit cluster outranks a high-volume/partly-covered one
ok 1319 - mineHarvestGaps: a low-volume/high-deficit cluster outranks a high-volume/partly-covered one
  ---
  duration_ms: 0.309333
  type: 'test'
  ...
# Subtest: mineHarvestGaps: unprobed (deferred) clusters survive, unranked — never dropped
ok 1320 - mineHarvestGaps: unprobed (deferred) clusters survive, unranked — never dropped
  ---
  duration_ms: 0.391541
  type: 'test'
  ...
# Subtest: missed rail: ONE uncovered flag yields a demand-ranked harvest candidate
ok 1321 - missed rail: ONE uncovered flag yields a demand-ranked harvest candidate
  ---
  duration_ms: 0.478541
  type: 'test'
  ...
# Subtest: missed rail: ONE flag NEVER yields a rule, however well the corpus covers it
ok 1322 - missed rail: ONE flag NEVER yields a rule, however well the corpus covers it
  ---
  duration_ms: 0.218625
  type: 'test'
  ...
# Subtest: missed rail: ≥2 flags + covered corpus → missed_rule (unchanged bar)
ok 1323 - missed rail: ≥2 flags + covered corpus → missed_rule (unchanged bar)
  ---
  duration_ms: 0.14225
  type: 'test'
  ...
# Subtest: routeAdjudication: suppress → vouch, fix → surfaced-only, accept/defer/monitor → no-op
ok 1324 - routeAdjudication: suppress → vouch, fix → surfaced-only, accept/defer/monitor → no-op
  ---
  duration_ms: 0.112917
  type: 'test'
  ...
# Subtest: adjudicationSignalType: parses the coarse <signal_type>@<engine_version> key
ok 1325 - adjudicationSignalType: parses the coarse <signal_type>@<engine_version> key
  ---
  duration_ms: 0.10875
  type: 'test'
  ...
# Subtest: routeAdjudications: the 6 ratified decisions → 1 vouch, 5 surfaced fixes, 0 harvest
ok 1326 - routeAdjudications: the 6 ratified decisions → 1 vouch, 5 surfaced fixes, 0 harvest
  ---
  duration_ms: 0.4465
  type: 'test'
  ...
# Subtest: routeAdjudications: accept/defer/monitor vouch nothing and surface nothing
ok 1327 - routeAdjudications: accept/defer/monitor vouch nothing and surface nothing
  ---
  duration_ms: 0.111667
  type: 'test'
  ...
# Subtest: suppression vouch: an adjudicated suppress lets a ONE-reviewer cluster propose
ok 1328 - suppression vouch: an adjudicated suppress lets a ONE-reviewer cluster propose
  ---
  duration_ms: 0.480791
  type: 'test'
  ...
# Subtest: suppression vouch: relaxes ONLY the reviewer gate — volume + precision still bind
ok 1329 - suppression vouch: relaxes ONLY the reviewer gate — volume + precision still bind
  ---
  duration_ms: 0.183875
  type: 'test'
  ...
# Subtest: ratio: null on zero denominator, value otherwise
ok 1330 - ratio: null on zero denominator, value otherwise
  ---
  duration_ms: 0.432167
  type: 'test'
  ...
# Subtest: pct: "—" for null, whole-percent otherwise
ok 1331 - pct: "—" for null, whole-percent otherwise
  ---
  duration_ms: 5.24
  type: 'test'
  ...
# Subtest: buildFlywheel: perDay rounds audits over elapsed days; ≥1 divisor
ok 1332 - buildFlywheel: perDay rounds audits over elapsed days; ≥1 divisor
  ---
  duration_ms: 0.515917
  type: 'test'
  ...
# Subtest: buildFlywheel: attribution + grounded ratios (the two first-ever headline numbers)
ok 1333 - buildFlywheel: attribution + grounded ratios (the two first-ever headline numbers)
  ---
  duration_ms: 0.137459
  type: 'test'
  ...
# Subtest: buildFlywheel: zero corpus denominators → null → "—", never a fake 0%
ok 1334 - buildFlywheel: zero corpus denominators → null → "—", never a fake 0%
  ---
  duration_ms: 0.08025
  type: 'test'
  ...
# Subtest: buildFlywheel: approved list drops zero-count types
ok 1335 - buildFlywheel: approved list drops zero-count types
  ---
  duration_ms: 0.382834
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: T1: defaults are 90000 / 0 / 600000
ok 1336 - T1: defaults are 90000 / 0 / 600000
  ---
  duration_ms: 0.423209
  type: 'test'
  ...
# Subtest: T2: resolvers honour numeric overrides and fall back on garbage
ok 1337 - T2: resolvers honour numeric overrides and fall back on garbage
  ---
  duration_ms: 0.137375
  type: 'test'
  ...
# Subtest: T3: every new OpenAI(...) in lib/llm.ts carries timeout + maxRetries
ok 1338 - T3: every new OpenAI(...) in lib/llm.ts carries timeout + maxRetries
  ---
  duration_ms: 0.221541
  type: 'test'
  ...
# Subtest: T4: the audit call site passes an audit-class ceiling that clears measured latency
ok 1339 - T4: the audit call site passes an audit-class ceiling that clears measured latency
  ---
  duration_ms: 0.72525
  type: 'test'
  ...
# Subtest: T5: timeout fires as a catchable Error after exactly one wire call (maxRetries 0)
ok 1340 - T5: timeout fires as a catchable Error after exactly one wire call (maxRetries 0)
  ---
  duration_ms: 309.0985
  type: 'test'
  ...
# Subtest: priceFor matches flash before pro, and falls back
ok 1341 - priceFor matches flash before pro, and falls back
  ---
  duration_ms: 0.383292
  type: 'test'
  ...
# Subtest: perCallInr computes ₹ from tokens (Pro base tier)
ok 1342 - perCallInr computes ₹ from tokens (Pro base tier)
  ---
  duration_ms: 1.007875
  type: 'test'
  ...
# Subtest: perCallInr applies the >200k Pro high tier
ok 1343 - perCallInr applies the >200k Pro high tier
  ---
  duration_ms: 0.092167
  type: 'test'
  ...
# Subtest: costInr with explicit tier (aggregate path) matches base rate for summed tokens
ok 1344 - costInr with explicit tier (aggregate path) matches base rate for summed tokens
  ---
  duration_ms: 0.051
  type: 'test'
  ...
# Subtest: fmtInr rounds with Indian grouping; paise for tiny amounts
ok 1345 - fmtInr rounds with Indian grouping; paise for tiny amounts
  ---
  duration_ms: 10.1385
  type: 'test'
  ...
# Subtest: keywordRecall: substring match on normalized haystack; <3-char keywords ignored
ok 1346 - keywordRecall: substring match on normalized haystack; <3-char keywords ignored
  ---
  duration_ms: 1.697959
  type: 'test'
  ...
# Subtest: passesFloor: only "applies" above the surface floor fires (two-tier)
ok 1347 - passesFloor: only "applies" above the surface floor fires (two-tier)
  ---
  duration_ms: 0.242458
  type: 'test'
  ...
# Subtest: assembleFlags: gates, sorts by confidence desc, maps citation
ok 1348 - assembleFlags: gates, sorts by confidence desc, maps citation
  ---
  duration_ms: 0.345417
  type: 'test'
  ...
# Subtest: dedupeById keeps first occurrence across lists
ok 1349 - dedupeById keeps first occurrence across lists
  ---
  duration_ms: 0.188125
  type: 'test'
  ...
# Subtest: identical runs: full agreement, no flips, zero confidence drift
ok 1350 - identical runs: full agreement, no flips, zero confidence drift
  ---
  duration_ms: 1.98025
  type: 'test'
  ...
# Subtest: pairing is by rec id, never by position — reordering is not a flip
ok 1351 - pairing is by rec id, never by position — reordering is not a flip
  ---
  duration_ms: 0.247542
  type: 'test'
  ...
# Subtest: a flip is recorded in the matrix with its direction, and the delta is signed
ok 1352 - a flip is recorded in the matrix with its direction, and the delta is signed
  ---
  duration_ms: 0.359875
  type: 'test'
  ...
# Subtest: a rec present in only one run is unmatched, never silently dropped or counted as a flip
ok 1353 - a rec present in only one run is unmatched, never silently dropped or counted as a flip
  ---
  duration_ms: 0.171875
  type: 'test'
  ...
# Subtest: an empty comparable set is NOT agreement — it is nothing measured
ok 1354 - an empty comparable set is NOT agreement — it is nothing measured
  ---
  duration_ms: 0.26525
  type: 'test'
  ...
# Subtest: summary: percentages are over what actually compared, and the matrix sums across cases
ok 1355 - summary: percentages are over what actually compared, and the matrix sums across cases
  ---
  duration_ms: 0.422417
  type: 'test'
  ...
# Subtest: degenerate input never throws: nulls, missing recs, duplicate ids, non-numeric confidence
ok 1356 - degenerate input never throws: nulls, missing recs, duplicate ids, non-numeric confidence
  ---
  duration_ms: 0.619625
  type: 'test'
  ...
# Subtest: the verdict vocabulary is the judge's own three
ok 1357 - the verdict vocabulary is the judge's own three
  ---
  duration_ms: 0.246583
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [lvc] judge attempt 1/2 attribution UNKNOWN (no model reported by transport or body) — verdict accepted per D-6, not retried
# [lvc] judge attempt 1/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (body_names_other_model): served 'qwen2.5:14b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 transport_names_other_model: transport 'llama3.1:8b', body 'none' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 transport_names_other_model: transport 'llama3.1:8b', body 'none' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (transport_names_other_model): served 'llama3.1:8b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 transport_body_conflict: transport 'gemini-2.5-pro', body 'llama3.1:8b' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 transport_body_conflict: transport 'gemini-2.5-pro', body 'llama3.1:8b' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (transport_body_conflict): served 'gemini-2.5-pro' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 transport_body_conflict: transport 'llama3.1:8b', body 'gemini-2.5-pro' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 transport_body_conflict: transport 'llama3.1:8b', body 'gemini-2.5-pro' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (transport_body_conflict): served 'llama3.1:8b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 failed vertex 403
# [lvc] judge attempt 2/2 failed vertex 403
# [lvc] judge REFUSED (call_failed): served 'none' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 failed transient 429
# [lvc] judge attempt 1/2 transport_body_conflict: transport 'gemini-2.5-pro', body 'llama3.1:8b' vs intended 'gemini-2.5-pro'
# Subtest: 1: empty body model + no transport evidence + valid content → verdict served, ONE call, unknown
ok 1358 - 1: empty body model + no transport evidence + valid content → verdict served, ONE call, unknown
  ---
  duration_ms: 4.403417
  type: 'test'
  ...
# Subtest: 2: transport names the intended Gemini model → ONE call, verified
ok 1359 - 2: transport names the intended Gemini model → ONE call, verified
  ---
  duration_ms: 1.359333
  type: 'test'
  ...
# Subtest: 3: body names a DIFFERENT model → two calls, refusal, every rec insufficient_info, wrong_model
ok 1360 - 3: body names a DIFFERENT model → two calls, refusal, every rec insufficient_info, wrong_model
  ---
  duration_ms: 1.491833
  type: 'test'
  ...
# Subtest: 4: transport names the LOCAL model → wrong_model, the verdict is never accepted
ok 1361 - 4: transport names the LOCAL model → wrong_model, the verdict is never accepted
  ---
  duration_ms: 0.491667
  type: 'test'
  ...
# Subtest: 5: a CONFLICT between the two sources is wrong_model — in BOTH directions
ok 1362 - 5: a CONFLICT between the two sources is wrong_model — in BOTH directions
  ---
  duration_ms: 0.863041
  type: 'test'
  ...
# Subtest: 6: body-only verified — no transport evidence, body names the intended Gemini → verified, ONE call
ok 1363 - 6: body-only verified — no transport evidence, body names the intended Gemini → verified, ONE call
  ---
  duration_ms: 0.380792
  type: 'test'
  ...
# Subtest: 7: a provider THROW retries once then refuses — and stays distinct from unknown
ok 1364 - 7: a provider THROW retries once then refuses — and stays distinct from unknown
  ---
  duration_ms: 0.352292
  type: 'test'
  ...
# Subtest: 7b: a first-attempt throw followed by a verified answer is served — the retry still recovers
ok 1365 - 7b: a first-attempt throw followed by a verified answer is served — the retry still recovers
  ---
  duration_ms: 0.184333
  type: 'test'
  ...
# Subtest: 8: the REAL judge call passes noLocalFallback: true — mechanically, through llmCall
ok 1366 - 8: the REAL judge call passes noLocalFallback: true — mechanically, through llmCall
  ---
  duration_ms: 0.337333
  type: 'test'
  ...
# Subtest: 8b: candidate extraction does NOT pass noLocalFallback — its options object is byte-identical
ok 1367 - 8b: candidate extraction does NOT pass noLocalFallback — its options object is byte-identical
  ---
  duration_ms: 0.649334
  type: 'test'
  ...
# Subtest: 9: attempt + invocation payloads — absent stays null, both sources stay separately visible
ok 1368 - 9: attempt + invocation payloads — absent stays null, both sources stay separately visible
  ---
  duration_ms: 0.240708
  type: 'test'
  ...
# Subtest: 9b: the pure builders — nothing absent is invented, retry_count is 0 on a single attempt
ok 1369 - 9b: the pure builders — nothing absent is invented, retry_count is 0 on a single attempt
  ---
  duration_ms: 0.103
  type: 'test'
  ...
# Subtest: 9c: a throwing recorder can never cost a verdict
ok 1370 - 9c: a throwing recorder can never cost a verdict
  ---
  duration_ms: 0.147542
  type: 'test'
  ...
# Subtest: 10: resolveJudgeAttribution — every row of the table, exhaustively
ok 1371 - 10: resolveJudgeAttribution — every row of the table, exhaustively
  ---
  duration_ms: 0.205875
  type: 'test'
  ...
# Subtest: transport attribution is a NON-ENUMERABLE property — no existing consumer can see it
ok 1372 - transport attribution is a NON-ENUMERABLE property — no existing consumer can see it
  ---
  duration_ms: 0.075625
  type: 'test'
  ...
# Subtest: attaching to a frozen or non-object result never throws — evidence must not cost a call
ok 1373 - attaching to a frozen or non-object result never throws — evidence must not cost a call
  ---
  duration_ms: 0.140458
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [lvc] judge attempt 1/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge attempt 2/2 body_names_other_model: transport 'none', body 'qwen2.5:14b' vs intended 'gemini-2.5-pro'
# [lvc] judge REFUSED (body_names_other_model): served 'qwen2.5:14b' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 attribution UNKNOWN (no model reported by transport or body) — verdict accepted per D-6, not retried
# [lvc] judge attempt 1/2 failed vertex 403
# [lvc] judge attempt 2/2 failed vertex 403
# [lvc] judge REFUSED (call_failed): served 'none' != intended 'gemini-2.5-pro' — every rec insufficient_info, no flag fires
# [lvc] judge attempt 1/2 failed transient 429
# [lvc] judge REFUSED (force_ollama_requested): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# Subtest: D-1: the judge call body carries temperature 0, the fixed seed and top_p 1
ok 1374 - D-1: the judge call body carries temperature 0, the fixed seed and top_p 1
  ---
  duration_ms: 3.618708
  type: 'test'
  ...
# Subtest: D-1: the autoflag surface is pinned identically — one judge, one configuration
ok 1375 - D-1: the autoflag surface is pinned identically — one judge, one configuration
  ---
  duration_ms: 0.655375
  type: 'test'
  ...
# Subtest: D-2: a non-Gemini served model is retried ONCE, then the whole batch refuses
ok 1376 - D-2: a non-Gemini served model is retried ONCE, then the whole batch refuses
  ---
  duration_ms: 1.5875
  type: 'test'
  ...
# Subtest: D-2 → D-6: an EMPTY served model is UNKNOWN attribution, not a failure (see lvc-judge-attribution.test.ts)
ok 1377 - D-2 → D-6: an EMPTY served model is UNKNOWN attribution, not a failure (see lvc-judge-attribution.test.ts)
  ---
  duration_ms: 1.156375
  type: 'test'
  ...
# Subtest: D-2: a throw is retried once and then refuses — no soft-fail to a local answer
ok 1378 - D-2: a throw is retried once and then refuses — no soft-fail to a local answer
  ---
  duration_ms: 0.801625
  type: 'test'
  ...
# Subtest: D-2: a FIRST-attempt failure followed by an agreeing Gemini answer is served normally
ok 1379 - D-2: a FIRST-attempt failure followed by an agreeing Gemini answer is served normally
  ---
  duration_ms: 1.411
  type: 'test'
  ...
# Subtest: D-2: the publisher prefix is not a disagreement — google/<slug> still serves
ok 1380 - D-2: the publisher prefix is not a disagreement — google/<slug> still serves
  ---
  duration_ms: 0.574667
  type: 'test'
  ...
# Subtest: D-2: forceOllama refuses BEFORE any call — no ollama call may serve a judge verdict
ok 1381 - D-2: forceOllama refuses BEFORE any call — no ollama call may serve a judge verdict
  ---
  duration_ms: 0.601417
  type: 'test'
  ...
# Subtest: D-2: with no Gemini available there is no slug to retry against — immediate refusal
ok 1382 - D-2: with no Gemini available there is no slug to retry against — immediate refusal
  ---
  duration_ms: 0.811083
  type: 'test'
  ...
# Subtest: D-2: the refusal event kind is the one the PRD names
ok 1383 - D-2: the refusal event kind is the one the PRD names
  ---
  duration_ms: 0.63325
  type: 'test'
  ...
# Subtest: §4: valid round tags resolve to themselves
ok 1384 - §4: valid round tags resolve to themselves
  ---
  duration_ms: 0.386417
  type: 'test'
  ...
# Subtest: §4: junk falls back to the r1 default — the route can never write an unfindable tag
ok 1385 - §4: junk falls back to the r1 default — the route can never write an unfindable tag
  ---
  duration_ms: 0.097792
  type: 'test'
  ...
# Subtest: §4: surrounding whitespace is trimmed, not rejected
ok 1386 - §4: surrounding whitespace is trimmed, not rejected
  ---
  duration_ms: 0.043958
  type: 'test'
  ...
# [lvc-wording] CDMSS-LVC-JUDGE-PINNING-PRD-v1.0-10-AUG-2026.md absent (root *.md is gitignored) — the .sql round trip is the anchor here
# Subtest: §3: seven preconditions, two retirements, nine distinct rows
ok 1387 - §3: seven preconditions, two retirements, nine distinct rows
  ---
  duration_ms: 0.822
  type: 'test'
  ...
# Subtest: §3: the ids are exactly the ones the PRD names
ok 1388 - §3: the ids are exactly the ones the PRD names
  ---
  duration_ms: 0.1295
  type: 'test'
  ...
# Subtest: every shipped precondition round-trips byte-for-byte through the .sql record
ok 1389 - every shipped precondition round-trips byte-for-byte through the .sql record
  ---
  duration_ms: 0.8765
  type: 'test'
  ...
# Subtest: §3.2 round-trips byte-for-byte — the MERGED safety-netting record (D-5a)
ok 1390 - §3.2 round-trips byte-for-byte — the MERGED safety-netting record (D-5a)
  ---
  duration_ms: 0.157417
  type: 'test'
  ...
# Subtest: §3.8 round-trips byte-for-byte — the vitamin-D carve-out (D-5c)
ok 1391 - §3.8 round-trips byte-for-byte — the vitamin-D carve-out (D-5c)
  ---
  duration_ms: 0.173292
  type: 'test'
  ...
# Subtest: when the ratified PRD is present, every text still matches it byte-for-byte
ok 1392 - when the ratified PRD is present, every text still matches it byte-for-byte
  ---
  duration_ms: 0.342667
  type: 'test'
  ...
# Subtest: the .sql record and the shipped constants cannot drift
ok 1393 - the .sql record and the shipped constants cannot drift
  ---
  duration_ms: 0.258958
  type: 'test'
  ...
# Subtest: every shipped precondition encodes the ratified drafting convention
ok 1394 - every shipped precondition encodes the ratified drafting convention
  ---
  duration_ms: 0.179542
  type: 'test'
  ...
# Subtest: first run updates all nine rows and verifies them
ok 1395 - first run updates all nine rows and verifies them
  ---
  duration_ms: 0.676958
  type: 'test'
  ...
# Subtest: IDEMPOTENCE: the second run changes zero rows
ok 1396 - IDEMPOTENCE: the second run changes zero rows
  ---
  duration_ms: 0.641458
  type: 'test'
  ...
# Subtest: the readback runs FIRST, so a broken schema writes nothing at all
ok 1397 - the readback runs FIRST, so a broken schema writes nothing at all
  ---
  duration_ms: 0.103542
  type: 'test'
  ...
# Subtest: a dry run reads and plans without writing
ok 1398 - a dry run reads and plans without writing
  ---
  duration_ms: 0.114292
  type: 'test'
  ...
# Subtest: a missing id is reported, never silently skipped
ok 1399 - a missing id is reported, never silently skipped
  ---
  duration_ms: 0.089917
  type: 'test'
  ...
# Subtest: a row already carrying the ratified value is left alone even on the first run
ok 1400 - a row already carrying the ratified value is left alone even on the first run
  ---
  duration_ms: 0.083834
  type: 'test'
  ...
# Subtest: sameInstant compares instants, not strings — a Postgres timestamptz still verifies
ok 1401 - sameInstant compares instants, not strings — a Postgres timestamptz still verifies
  ---
  duration_ms: 0.039917
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: §2/§7: LVC params (reasoning present) ⇒ no injected reasoning:{enabled:false}; the caller value survives
ok 1402 - §2/§7: LVC params (reasoning present) ⇒ no injected reasoning:{enabled:false}; the caller value survives
  ---
  duration_ms: 1.492042
  type: 'test'
  ...
# Subtest: §2/§7: a caller with NO reasoning (citation critic / Qwen3) still receives reasoning:{enabled:false}
ok 1403 - §2/§7: a caller with NO reasoning (citation critic / Qwen3) still receives reasoning:{enabled:false}
  ---
  duration_ms: 0.144083
  type: 'test'
  ...
# Subtest: §3/§7: the both-failed error contains BOTH the provider and the Ollama fallback messages
ok 1404 - §3/§7: the both-failed error contains BOTH the provider and the Ollama fallback messages
  ---
  duration_ms: 0.273125
  type: 'test'
  ...
# Subtest: §3/§7: runOllamaFallback returns the fallback result unchanged on success; throws both-failed on error
ok 1405 - §3/§7: runOllamaFallback returns the fallback result unchanged on success; throws both-failed on error
  ---
  duration_ms: 0.344125
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall f5202a39-ea91-4180-9e35-74b04dc2b401
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall a0d5fb21-a895-45f5-a2f3-a432e66f8eb8
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 48e18265-b5d2-45b2-90c2-9ae6c33a9714
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 4a7132b9-f7e9-4f17-84d5-75910a3f2484
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall f0bbbdd7-ba24-4bba-a119-44c4ad92c6b4
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall edbd73ec-e92f-4c5d-b07a-494d2f94dab3
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall b6e4a814-0454-45f1-966c-52d5b03074e8
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall cbf20972-5ebd-46ce-9046-54bc265f09d5
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall b0153ff0-65e6-4021-be9c-a4f5dffc976a
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] semantic recall failed Invalid URL
# [retrieval-telemetry] terminal write rejected (revision or state moved) lvc_recall — row state unknown
# [retrieval-telemetry] settlement rejected: no_row lvc_recall 0885e91d-d845-47c1-b53e-bcfa3ca84334
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# [lvc] judge REFUSED (no_gemini_model_resolved): served 'none' != intended 'none' — every rec insufficient_info, no flag fires
# Subtest: 42 A1 — A/A pass 0 uses DEFAULT recall and declares with role lvc_recall on route lvc_judge_aa
ok 1406 - 42 A1 — A/A pass 0 uses DEFAULT recall and declares with role lvc_recall on route lvc_judge_aa
  ---
  duration_ms: 66.269667
  type: 'test'
  ...
# Subtest: 42 A2 — the PINNED passes declare nothing: one declaration per case, not three
ok 1407 - 42 A2 — the PINNED passes declare nothing: one declaration per case, not three
  ---
  duration_ms: 28.724833
  type: 'test'
  ...
# Subtest: 42 A3 — exactly ONE lvc_recall row per pass-0 recall, not two and not zero
ok 1408 - 42 A3 — exactly ONE lvc_recall row per pass-0 recall, not two and not zero
  ---
  duration_ms: 10.268334
  type: 'test'
  ...
# Subtest: 42 A4 — ONE CONTEXT PER REQUEST: one id across a request, and a different id for the next
ok 1409 - 42 A4 — ONE CONTEXT PER REQUEST: one id across a request, and a different id for the next
  ---
  duration_ms: 13.917125
  type: 'test'
  ...
# Subtest: 42 B5 — the appropriateness route passes unknown_route (SOURCE: its POST cannot be driven here)
ok 1410 - 42 B5 — the appropriateness route passes unknown_route (SOURCE: its POST cannot be driven here)
  ---
  duration_ms: 0.312084
  type: 'test'
  ...
# Subtest: 42 B6 — both right-care probe scripts write nothing (SOURCE: neither can be driven from a test)
ok 1411 - 42 B6 — both right-care probe scripts write nothing (SOURCE: neither can be driven from a test)
  ---
  duration_ms: 1.434542
  type: 'test'
  ...
# Subtest: 42 B7 — the A/A route's existing surface is unchanged (SOURCE: read from the diff, not a request)
ok 1412 - 42 B7 — the A/A route's existing surface is unchanged (SOURCE: read from the diff, not a request)
  ---
  duration_ms: 0.249458
  type: 'test'
  ...
# Subtest: 42 B7b — the context is minted ONCE, in GET, and threaded (SOURCE, alongside A4)
ok 1413 - 42 B7b — the context is minted ONCE, in GET, and threaded (SOURCE, alongside A4)
  ---
  duration_ms: 0.127916
  type: 'test'
  ...
# Subtest: lvc-value defaultRetrieveHits does NOT set useNormativeLeg (no normative frame in the judge prompt)
ok 1414 - lvc-value defaultRetrieveHits does NOT set useNormativeLeg (no normative frame in the judge prompt)
  ---
  duration_ms: 0.460541
  type: 'test'
  ...
# Subtest: linked: continued / newly-started / gap classified, provenance on the sides that exist
ok 1415 - linked: continued / newly-started / gap classified, provenance on the sides that exist
  ---
  duration_ms: 9.598584
  type: 'test'
  ...
# Subtest: unlinked: admission-list-only, no reconciliation rows (missing baseline stays visible)
ok 1416 - unlinked: admission-list-only, no reconciliation rows (missing baseline stays visible)
  ---
  duration_ms: 0.236667
  type: 'test'
  ...
# Subtest: linked but no pre-admission OPD meds: still admission-only (no baseline to compare)
ok 1417 - linked but no pre-admission OPD meds: still admission-only (no baseline to compare)
  ---
  duration_ms: 0.362709
  type: 'test'
  ...
# Subtest: flag off: the composition never fires — no admission occurrence is reconciled
ok 1418 - flag off: the composition never fires — no admission occurrence is reconciled
  ---
  duration_ms: 0.31525
  type: 'test'
  ...
# Subtest: med-rec ONLY: the view exposes no problem / allergy continuity field (Gate D scope)
ok 1419 - med-rec ONLY: the view exposes no problem / allergy continuity field (Gate D scope)
  ---
  duration_ms: 0.366167
  type: 'test'
  ...
# Subtest: version
ok 1420 - version
  ---
  duration_ms: 1.451666
  type: 'test'
  ...
# Subtest: resolveProblemLabel: map hit, source-text preference, unknown → neutral
ok 1421 - resolveProblemLabel: map hit, source-text preference, unknown → neutral
  ---
  duration_ms: 1.376375
  type: 'test'
  ...
# Subtest: classifyProblemTier: active/background/historical (recency, recurrence, incidental)
ok 1422 - classifyProblemTier: active/background/historical (recency, recurrence, incidental)
  ---
  duration_ms: 0.406375
  type: 'test'
  ...
# Subtest: flagAbnormalLabs: banding, unit-mismatch = no flag, sex-specific, trend
ok 1423 - flagAbnormalLabs: banding, unit-mismatch = no flag, sex-specific, trend
  ---
  duration_ms: 0.635709
  type: 'test'
  ...
# Subtest: computeCareGaps: abnormal-not-rechecked > 6mo; recent excluded; normal excluded
ok 1424 - computeCareGaps: abnormal-not-rechecked > 6mo; recent excluded; normal excluded
  ---
  duration_ms: 0.317917
  type: 'test'
  ...
# Subtest: computePictureConfidence: Ravali-like → THIN; in-person recent → GOOD
ok 1425 - computePictureConfidence: Ravali-like → THIN; in-person recent → GOOD
  ---
  duration_ms: 0.308416
  type: 'test'
  ...
# Subtest: buildVitalsView: numbers + EWS surfaced when present; honest absence otherwise
ok 1426 - buildVitalsView: numbers + EWS surfaced when present; honest absence otherwise
  ---
  duration_ms: 0.296208
  type: 'test'
  ...
# Subtest: buildAttentionFlags: medication conflict + critical lab surface as flags
ok 1427 - buildAttentionFlags: medication conflict + critical lab surface as flags
  ---
  duration_ms: 0.251
  type: 'test'
  ...
# Subtest: patch/1: canonicalAnalyte tolerant match — real Vit D db name → severe band
ok 1428 - patch/1: canonicalAnalyte tolerant match — real Vit D db name → severe band
  ---
  duration_ms: 0.210583
  type: 'test'
  ...
# Subtest: patch/1: real Vit D (8.01 ng/mL) surfaces in labs, gaps AND attention
ok 1429 - patch/1: real Vit D (8.01 ng/mL) surfaces in labs, gaps AND attention
  ---
  duration_ms: 0.427833
  type: 'test'
  ...
# Subtest: patch/2: safety-net item is SURFACED (labs) but NOT PROMOTED (no gap, no attention flag)
ok 1430 - patch/2: safety-net item is SURFACED (labs) but NOT PROMOTED (no gap, no attention flag)
  ---
  duration_ms: 0.083125
  type: 'test'
  ...
# Subtest: patch/2: latest source-NORMAL + no range → NOT surfaced (nothing over-flagged)
ok 1431 - patch/2: latest source-NORMAL + no range → NOT surfaced (nothing over-flagged)
  ---
  duration_ms: 0.065959
  type: 'test'
  ...
# Subtest: patch/3: trend de-clutter — stable repeats collapse, differing values surface
ok 1432 - patch/3: trend de-clutter — stable repeats collapse, differing values surface
  ---
  duration_ms: 0.078791
  type: 'test'
  ...
# Subtest: determinism: fns twice → deep-equal
ok 1433 - determinism: fns twice → deep-equal
  ---
  duration_ms: 0.158125
  type: 'test'
  ...
# Subtest: inv1 / stratum4: problem omitted at a later encounter → uncertain_current_status, never resolved
ok 1434 - inv1 / stratum4: problem omitted at a later encounter → uncertain_current_status, never resolved
  ---
  duration_ms: 1.586292
  type: 'test'
  ...
# Subtest: inv1 / stratum3: explicit later resolved → documented_resolved
ok 1435 - inv1 / stratum3: explicit later resolved → documented_resolved
  ---
  duration_ms: 0.136334
  type: 'test'
  ...
# Subtest: inv2: empty memberRef is a hard error (single-member invariant)
ok 1436 - inv2: empty memberRef is a hard error (single-member invariant)
  ---
  duration_ms: 0.105958
  type: 'test'
  ...
# Subtest: inv3: two distinct raws with no dictionary hit stay separate (no fuzzy merge)
ok 1437 - inv3: two distinct raws with no dictionary hit stay separate (no fuzzy merge)
  ---
  duration_ms: 0.225375
  type: 'test'
  ...
# Subtest: inv4 + inv5: every occurrence carries provenance and the derived status keeps its occurrences
ok 1438 - inv4 + inv5: every occurrence carries provenance and the derived status keeps its occurrences
  ---
  duration_ms: 0.154916
  type: 'test'
  ...
# Subtest: inv6 / stratum5: contradictory allergy → reported_allergy AND a safety_critical status_conflict
ok 1439 - inv6 / stratum5: contradictory allergy → reported_allergy AND a safety_critical status_conflict
  ---
  duration_ms: 2.425666
  type: 'test'
  ...
# Subtest: inv7: buildMemberState is reproducible — same evidence + versions → deep-equal
ok 1440 - inv7: buildMemberState is reproducible — same evidence + versions → deep-equal
  ---
  duration_ms: 0.708584
  type: 'test'
  ...
# Subtest: inv7 / stratum13: buildMemberState does not mutate input; corrected evidence → corrected snapshot
ok 1441 - inv7 / stratum13: buildMemberState does not mutate input; corrected evidence → corrected snapshot
  ---
  duration_ms: 0.208291
  type: 'test'
  ...
# Subtest: inv9: version + as-of metadata is mandatory and stamped
ok 1442 - inv9: version + as-of metadata is mandatory and stamped
  ---
  duration_ms: 0.222708
  type: 'test'
  ...
# Subtest: inv10: unresolved concept flows through as data (null id, relation unresolved)
ok 1443 - inv10: unresolved concept flows through as data (null id, relation unresolved)
  ---
  duration_ms: 0.334416
  type: 'test'
  ...
# Subtest: stratum1: persistent chronic (multi-touch, span>1yr, no long gap) → persistent + active
ok 1444 - stratum1: persistent chronic (multi-touch, span>1yr, no long gap) → persistent + active
  ---
  duration_ms: 0.084834
  type: 'test'
  ...
# Subtest: stratum2: recurrent (present → long gap → present) → recurrent [EPISODIC concept]
ok 1445 - stratum2: recurrent (present → long gap → present) → recurrent [EPISODIC concept]
  ---
  duration_ms: 0.068917
  type: 'test'
  ...
# Subtest: R1: a chronic concept re-documented ≥2× is persistent regardless of gap length
ok 1446 - R1: a chronic concept re-documented ≥2× is persistent regardless of gap length
  ---
  duration_ms: 0.071917
  type: 'test'
  ...
# Subtest: R1 guard: an episodic concept with dense touches within a year is NOT forced persistent
ok 1447 - R1 guard: an episodic concept with dense touches within a year is NOT forced persistent
  ---
  duration_ms: 0.050916
  type: 'test'
  ...
# Subtest: R2: patient-reported stop then a LATER prescription → status stopped + one medication/temporal_conflict/review (both provenances)
ok 1448 - R2: patient-reported stop then a LATER prescription → status stopped + one medication/temporal_conflict/review (both provenances)
  ---
  duration_ms: 0.156708
  type: 'test'
  ...
# Subtest: R2 guard: prescribe THEN patient-reported stop (no re-script) stays a status_conflict, not temporal
ok 1449 - R2 guard: prescribe THEN patient-reported stop (no re-script) stays a status_conflict, not temporal
  ---
  duration_ms: 0.080042
  type: 'test'
  ...
# Subtest: stratum6: medication prescribed → status prescribed, currentness never inferred to taking
ok 1450 - stratum6: medication prescribed → status prescribed, currentness never inferred to taking
  ---
  duration_ms: 0.049417
  type: 'test'
  ...
# Subtest: stratum7: medication explicitly stopped → status stopped + a medication status_conflict
ok 1451 - stratum7: medication explicitly stopped → status stopped + a medication status_conflict
  ---
  duration_ms: 0.062291
  type: 'test'
  ...
# Subtest: stratum8: broader/narrower wording NOT merged (diabetes vs type-2-diabetes → 2 problems)
ok 1452 - stratum8: broader/narrower wording NOT merged (diabetes vs type-2-diabetes → 2 problems)
  ---
  duration_ms: 0.049792
  type: 'test'
  ...
# Subtest: stratum9: same analyte, different units → one series, unit null, value_conflict Discrepancy
ok 1453 - stratum9: same analyte, different units → one series, unit null, value_conflict Discrepancy
  ---
  duration_ms: 0.077541
  type: 'test'
  ...
# Subtest: stratum10: abnormal→normal investigation series is date-ordered, unit preserved
ok 1454 - stratum10: abnormal→normal investigation series is date-ordered, unit preserved
  ---
  duration_ms: 0.061625
  type: 'test'
  ...
# Subtest: stratum12: two simultaneous conditions → two parallel problems
ok 1455 - stratum12: two simultaneous conditions → two parallel problems
  ---
  duration_ms: 0.089125
  type: 'test'
  ...
# Subtest: stratum14: "rule out PE" is never merged with confirmed PE
ok 1456 - stratum14: "rule out PE" is never merged with confirmed PE
  ---
  duration_ms: 0.060291
  type: 'test'
  ...
# Subtest: demographic identity_conflict: sex flip across encounters → review Discrepancy
ok 1457 - demographic identity_conflict: sex flip across encounters → review Discrepancy
  ---
  duration_ms: 0.127583
  type: 'test'
  ...
# Subtest: single occurrence → single_episode course
ok 1458 - single occurrence → single_episode course
  ---
  duration_ms: 0.047166
  type: 'test'
  ...
# Subtest: normal aging does NOT raise an identity_conflict (consistent birth year)
ok 1459 - normal aging does NOT raise an identity_conflict (consistent birth year)
  ---
  duration_ms: 0.04475
  type: 'test'
  ...
# Subtest: assembleEvidence: prescription row → opd EncounterEvidence (meds, denied allergy, icd problem, demographics)
ok 1460 - assembleEvidence: prescription row → opd EncounterEvidence (meds, denied allergy, icd problem, demographics)
  ---
  duration_ms: 1.114
  type: 'test'
  ...
# Subtest: assembleEvidence: lab rows → lab encounters grouped by booking, investigation points
ok 1461 - assembleEvidence: lab rows → lab encounters grouped by booking, investigation points
  ---
  duration_ms: 0.109083
  type: 'test'
  ...
# Subtest: assembleEvidence → buildMemberState: creatinine series spans both bookings, unit consistent
ok 1462 - assembleEvidence → buildMemberState: creatinine series spans both bookings, unit consistent
  ---
  duration_ms: 1.20875
  type: 'test'
  ...
# Subtest: assembleEvidence: identifier-free — no name/mobile/dob leaks into evidence
ok 1463 - assembleEvidence: identifier-free — no name/mobile/dob leaks into evidence
  ---
  duration_ms: 0.179292
  type: 'test'
  ...
# Subtest: assembleEvidence: diagnosis_icd_codes bare-string arrays — empty elements/arrays skipped
ok 1464 - assembleEvidence: diagnosis_icd_codes bare-string arrays — empty elements/arrays skipped
  ---
  duration_ms: 0.239167
  type: 'test'
  ...
# Subtest: assembleEvidence: malformed / missing rows degrade to empty, never throw
ok 1465 - assembleEvidence: malformed / missing rows degrade to empty, never throw
  ---
  duration_ms: 0.12325
  type: 'test'
  ...
# Subtest: careCallOutcomeToEncounter: stopped+reason → care_call encounter, identifier-free, deterministic
ok 1466 - careCallOutcomeToEncounter: stopped+reason → care_call encounter, identifier-free, deterministic
  ---
  duration_ms: 3.056292
  type: 'test'
  ...
# Subtest: careCallOutcomeToEncounter: complaint resolved → complaintStatuses; empty derived → empty arrays
ok 1467 - careCallOutcomeToEncounter: complaint resolved → complaintStatuses; empty derived → empty arrays
  ---
  duration_ms: 0.267458
  type: 'test'
  ...
# Subtest: Patch B: care-call encounter dated at called_at (fresh observation), not the episode note_date
ok 1468 - Patch B: care-call encounter dated at called_at (fresh observation), not the episode note_date
  ---
  duration_ms: 0.096583
  type: 'test'
  ...
# Subtest: loop closure: opd prescribes X + care_call reports X stopped → frozen buildMemberState currentness = stopped
ok 1469 - loop closure: opd prescribes X + care_call reports X stopped → frozen buildMemberState currentness = stopped
  ---
  duration_ms: 1.158875
  type: 'test'
  ...
# Subtest: loop closure R2: a LATER re-prescription after the patient-reported stop → medication/temporal_conflict/review
ok 1470 - loop closure R2: a LATER re-prescription after the patient-reported stop → medication/temporal_conflict/review
  ---
  duration_ms: 0.147083
  type: 'test'
  ...
# Subtest: gold seed is FROZEN: 20 strata, every case ratified:true, member-bank/1.0
ok 1471 - gold seed is FROZEN: 20 strata, every case ratified:true, member-bank/1.0
  ---
  duration_ms: 0.562791
  type: 'test'
  ...
# Subtest: frozen baseline member-state-baseline/1.0: the seed clears every floor (no breaches)
ok 1472 - frozen baseline member-state-baseline/1.0: the seed clears every floor (no breaches)
  ---
  duration_ms: 3.18675
  type: 'test'
  ...
# Subtest: HARD gates hold for EVERY case: retention/provenance/trust 100%, incorrect-resolution 0
ok 1473 - HARD gates hold for EVERY case: retention/provenance/trust 100%, incorrect-resolution 0
  ---
  duration_ms: 0.561375
  type: 'test'
  ...
# Subtest: EVERY invariant-class case scores zero invariantViolations against the frozen core
ok 1474 - EVERY invariant-class case scores zero invariantViolations against the frozen core
  ---
  duration_ms: 0.438833
  type: 'test'
  ...
# Subtest: S3: explicit resolution → documented_resolved
ok 1475 - S3: explicit resolution → documented_resolved
  ---
  duration_ms: 0.087042
  type: 'test'
  ...
# Subtest: S4: omitted later → uncertain, never resolved
ok 1476 - S4: omitted later → uncertain, never resolved
  ---
  duration_ms: 0.068208
  type: 'test'
  ...
# Subtest: S5: allergy reported dominates denied + safety_critical conflict
ok 1477 - S5: allergy reported dominates denied + safety_critical conflict
  ---
  duration_ms: 0.069625
  type: 'test'
  ...
# Subtest: S6: prescribed, currentness never inferred to taking
ok 1478 - S6: prescribed, currentness never inferred to taking
  ---
  duration_ms: 0.047458
  type: 'test'
  ...
# Subtest: S8: broader/narrower not merged → 2 distinct problems
ok 1479 - S8: broader/narrower not merged → 2 distinct problems
  ---
  duration_ms: 0.160667
  type: 'test'
  ...
# Subtest: S9: mixed units → unit:null + value_conflict
ok 1480 - S9: mixed units → unit:null + value_conflict
  ---
  duration_ms: 0.303458
  type: 'test'
  ...
# Subtest: S12: two simultaneous → 2 parallel problems
ok 1481 - S12: two simultaneous → 2 parallel problems
  ---
  duration_ms: 0.064042
  type: 'test'
  ...
# Subtest: S14: "rule out PE" not merged with confirmed PE
ok 1482 - S14: "rule out PE" not merged with confirmed PE
  ---
  duration_ms: 0.04675
  type: 'test'
  ...
# Subtest: S15: patient complaint resolved → documented_resolved occurrence (explicit, not silence)
ok 1483 - S15: patient complaint resolved → documented_resolved occurrence (explicit, not silence)
  ---
  duration_ms: 0.053916
  type: 'test'
  ...
# Subtest: S16: patient-reported stopped overrides prescription
ok 1484 - S16: patient-reported stopped overrides prescription
  ---
  duration_ms: 0.055833
  type: 'test'
  ...
# Subtest: S17: allergy trust-conflict records BOTH trusts in the Discrepancy detail
ok 1485 - S17: allergy trust-conflict records BOTH trusts in the Discrepancy detail
  ---
  duration_ms: 0.101875
  type: 'test'
  ...
# Subtest: S18: followUps carried, deduped by id, no overlay
ok 1486 - S18: followUps carried, deduped by id, no overlay
  ---
  duration_ms: 0.416625
  type: 'test'
  ...
# Subtest: S20: neutrality — zero patient-reported → empty followUps + 1.0 statuses
ok 1487 - S20: neutrality — zero patient-reported → empty followUps + 1.0 statuses
  ---
  duration_ms: 0.099
  type: 'test'
  ...
# Subtest: S1: chronic re-documented across years → persistent (R1 chronicity fix)
ok 1488 - S1: chronic re-documented across years → persistent (R1 chronicity fix)
  ---
  duration_ms: 0.073375
  type: 'test'
  ...
# Subtest: S2: episodic present-gap-present → recurrent (unchanged by R1)
ok 1489 - S2: episodic present-gap-present → recurrent (unchanged by R1)
  ---
  duration_ms: 0.060083
  type: 'test'
  ...
# Subtest: S7: explicit stopped reflected in status
ok 1490 - S7: explicit stopped reflected in status
  ---
  duration_ms: 0.056834
  type: 'test'
  ...
# Subtest: S19: keeps stopped after a re-prescription + one medication/temporal_conflict/review (both trusts)
ok 1491 - S19: keeps stopped after a re-prescription + one medication/temporal_conflict/review (both trusts)
  ---
  duration_ms: 0.0735
  type: 'test'
  ...
# Subtest: S13: evidence is not mutated; a corrected copy recomputes to a different snapshot
ok 1492 - S13: evidence is not mutated; a corrected copy recomputes to a different snapshot
  ---
  duration_ms: 0.13125
  type: 'test'
  ...
# Subtest: aggregate over the full seed: retention 1.0, zero invariant violations, zero incorrect resolutions
ok 1493 - aggregate over the full seed: retention 1.0, zero invariant violations, zero incorrect resolutions
  ---
  duration_ms: 0.408792
  type: 'test'
  ...
# Subtest: normalizeConcept: exact hit → relation exact + canonical id
ok 1494 - normalizeConcept: exact hit → relation exact + canonical id
  ---
  duration_ms: 0.882959
  type: 'test'
  ...
# Subtest: normalizeConcept: synonym hit → relation synonym, same canonical id
ok 1495 - normalizeConcept: synonym hit → relation synonym, same canonical id
  ---
  duration_ms: 0.2
  type: 'test'
  ...
# Subtest: normalizeConcept: no dictionary hit → unresolved (null id), never a guess
ok 1496 - normalizeConcept: no dictionary hit → unresolved (null id), never a guess
  ---
  duration_ms: 1.145833
  type: 'test'
  ...
# Subtest: normalizeConcept: broader/narrower are NEVER merged (diabetes ≠ type-2-diabetes)
ok 1497 - normalizeConcept: broader/narrower are NEVER merged (diabetes ≠ type-2-diabetes)
  ---
  duration_ms: 0.253625
  type: 'test'
  ...
# Subtest: normalizeConcept: domain-scoped dictionaries (creatinine only resolves as investigation)
ok 1498 - normalizeConcept: domain-scoped dictionaries (creatinine only resolves as investigation)
  ---
  duration_ms: 0.306625
  type: 'test'
  ...
# Subtest: normalizeConcept: deterministic — same input → identical result
ok 1499 - normalizeConcept: deterministic — same input → identical result
  ---
  duration_ms: 0.8715
  type: 'test'
  ...
# Subtest: groupingKey: resolved → canonical id; two unresolved merge only on identical normalized raw
ok 1500 - groupingKey: resolved → canonical id; two unresolved merge only on identical normalized raw
  ---
  duration_ms: 0.293459
  type: 'test'
  ...
# Subtest: normalizeRaw: lowercases, strips punctuation, collapses whitespace
ok 1501 - normalizeRaw: lowercases, strips punctuation, collapses whitespace
  ---
  duration_ms: 0.165625
  type: 'test'
  ...
# Subtest: complaint resolved → problem documented_resolved (explicit signal)
ok 1502 - complaint resolved → problem documented_resolved (explicit signal)
  ---
  duration_ms: 1.549792
  type: 'test'
  ...
# Subtest: complaint worse → active (never resolved)
ok 1503 - complaint worse → active (never resolved)
  ---
  duration_ms: 0.128583
  type: 'test'
  ...
# Subtest: resolved-then-silent stays resolved (a later unrelated encounter does not re-open it)
ok 1504 - resolved-then-silent stays resolved (a later unrelated encounter does not re-open it)
  ---
  duration_ms: 0.28225
  type: 'test'
  ...
# Subtest: a complaint whose concept matches no documented problem still forms its own problem
ok 1505 - a complaint whose concept matches no documented problem still forms its own problem
  ---
  duration_ms: 0.124
  type: 'test'
  ...
# Subtest: patient-reported stopped overrides a prescription prescribed
ok 1506 - patient-reported stopped overrides a prescription prescribed
  ---
  duration_ms: 0.46675
  type: 'test'
  ...
# Subtest: patient-reported reported_taking sets taking; currentness not synthesized otherwise
ok 1507 - patient-reported reported_taking sets taking; currentness not synthesized otherwise
  ---
  duration_ms: 0.10275
  type: 'test'
  ...
# Subtest: most-recent patient-reported wins over an older patient-reported
ok 1508 - most-recent patient-reported wins over an older patient-reported
  ---
  duration_ms: 0.130584
  type: 'test'
  ...
# Subtest: stopReason is carried on the occurrence
ok 1509 - stopReason is carried on the occurrence
  ---
  duration_ms: 0.066417
  type: 'test'
  ...
# Subtest: patient_reported denied + structured_db reported_allergy → reported_allergy + safety_critical conflict recording both trusts
ok 1510 - patient_reported denied + structured_db reported_allergy → reported_allergy + safety_critical conflict recording both trusts
  ---
  duration_ms: 2.231459
  type: 'test'
  ...
# Subtest: followUps carried onto the snapshot, deduped by id, date-sorted
ok 1511 - followUps carried onto the snapshot, deduped by id, date-sorted
  ---
  duration_ms: 0.662166
  type: 'test'
  ...
# Subtest: neutrality: no patient-reported evidence → 1.0 behaviour + empty followUps
ok 1512 - neutrality: no patient-reported evidence → 1.0 behaviour + empty followUps
  ---
  duration_ms: 0.106542
  type: 'test'
  ...
# Subtest: version + provenance passthrough
ok 1513 - version + provenance passthrough
  ---
  duration_ms: 0.514834
  type: 'test'
  ...
# Subtest: course: chronic re-documented → Persistent (warn)
ok 1514 - course: chronic re-documented → Persistent (warn)
  ---
  duration_ms: 0.398167
  type: 'test'
  ...
# Subtest: status: an omitted/silent problem renders Uncertain, NEVER Active
ok 1515 - status: an omitted/silent problem renders Uncertain, NEVER Active
  ---
  duration_ms: 0.114792
  type: 'test'
  ...
# Subtest: medication currentness: prescribed carries "not confirmed taken"; stopped → Stopped
ok 1516 - medication currentness: prescribed carries "not confirmed taken"; stopped → Stopped
  ---
  duration_ms: 0.065833
  type: 'test'
  ...
# Subtest: allergy: reported_allergy + matching allergy Discrepancy → conflicted:true, critical
ok 1517 - allergy: reported_allergy + matching allergy Discrepancy → conflicted:true, critical
  ---
  duration_ms: 0.051375
  type: 'test'
  ...
# Subtest: series: two-point HbA1c → direction down; mixed-unit creatinine → mixedUnits true
ok 1518 - series: two-point HbA1c → direction down; mixed-unit creatinine → mixedUnits true
  ---
  duration_ms: 0.050209
  type: 'test'
  ...
# Subtest: conflicts sorted safety_critical → review → informational; counts.safetyCritical
ok 1519 - conflicts sorted safety_critical → review → informational; counts.safetyCritical
  ---
  duration_ms: 0.124167
  type: 'test'
  ...
# Subtest: counts reflect the view arrays
ok 1520 - counts reflect the view arrays
  ---
  duration_ms: 0.041834
  type: 'test'
  ...
# Subtest: Patch A: view dates render as YYYY-MM-DD (dayOnly, idempotent on already-day strings)
ok 1521 - Patch A: view dates render as YYYY-MM-DD (dayOnly, idempotent on already-day strings)
  ---
  duration_ms: 0.590625
  type: 'test'
  ...
# Subtest: presentMemberState is deterministic (twice → deep-equal)
ok 1522 - presentMemberState is deterministic (twice → deep-equal)
  ---
  duration_ms: 1.1645
  type: 'test'
  ...
# Subtest: version constants are the Stage-0 pinned triple
ok 1523 - version constants are the Stage-0 pinned triple
  ---
  duration_ms: 0.397292
  type: 'test'
  ...
# Subtest: emptyMemberStateSnapshot: passed-in computedAt/asOf, empty arrays, passes zod
ok 1524 - emptyMemberStateSnapshot: passed-in computedAt/asOf, empty arrays, passes zod
  ---
  duration_ms: 1.078
  type: 'test'
  ...
# Subtest: a built snapshot validates against the zod schema
ok 1525 - a built snapshot validates against the zod schema
  ---
  duration_ms: 1.520083
  type: 'test'
  ...
# Subtest: version constant
ok 1526 - version constant
  ---
  duration_ms: 1.380375
  type: 'test'
  ...
# Subtest: retention/provenance/trust-provenance = 1.0 on well-formed input
ok 1527 - retention/provenance/trust-provenance = 1.0 on well-formed input
  ---
  duration_ms: 7.171833
  type: 'test'
  ...
# Subtest: falseMerges=1 when two distinct expected concepts collapse (synonyms merge)
ok 1528 - falseMerges=1 when two distinct expected concepts collapse (synonyms merge)
  ---
  duration_ms: 0.568958
  type: 'test'
  ...
# Subtest: falseSplits=1 when one expected concept becomes two entities
ok 1529 - falseSplits=1 when one expected concept becomes two entities
  ---
  duration_ms: 0.265084
  type: 'test'
  ...
# Subtest: conflictRecall [1,1] on a seeded allergy conflict
ok 1530 - conflictRecall [1,1] on a seeded allergy conflict
  ---
  duration_ms: 0.8235
  type: 'test'
  ...
# Subtest: problemCourseAgree [1,1] on a correctly-scored course
ok 1531 - problemCourseAgree [1,1] on a correctly-scored course
  ---
  duration_ms: 30.61675
  type: 'test'
  ...
# Subtest: incorrectResolutions=1 for a documented_resolved occurrence with no explicit basis
ok 1532 - incorrectResolutions=1 for a documented_resolved occurrence with no explicit basis
  ---
  duration_ms: 2.42525
  type: 'test'
  ...
# Subtest: scoreCase is deterministic (twice → deep-equal)
ok 1533 - scoreCase is deterministic (twice → deep-equal)
  ---
  duration_ms: 0.540167
  type: 'test'
  ...
# Subtest: aggregate rolls up the Part-C metric set
ok 1534 - aggregate rolls up the Part-C metric set
  ---
  duration_ms: 5.675625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: prescriptionsSql is byte-identical to shadow.mjs (drift fails CI)
ok 1535 - prescriptionsSql is byte-identical to shadow.mjs (drift fails CI)
  ---
  duration_ms: 0.513166
  type: 'test'
  ...
# Subtest: labsSql is byte-identical to shadow.mjs (drift fails CI)
ok 1536 - labsSql is byte-identical to shadow.mjs (drift fails CI)
  ---
  duration_ms: 0.109625
  type: 'test'
  ...
# Subtest: individualForPrescSql: pinned shape + injection guard (bad uid throws)
ok 1537 - individualForPrescSql: pinned shape + injection guard (bad uid throws)
  ---
  duration_ms: 0.230667
  type: 'test'
  ...
# Subtest: individualUidForPresc: a bad uid returns null WITHOUT touching the DB
ok 1538 - individualUidForPresc: a bad uid returns null WITHOUT touching the DB
  ---
  duration_ms: 0.073708
  type: 'test'
  ...
# Subtest: vitalsEver true → GREEN with the unchanged label, whatever the modality
ok 1539 - vitalsEver true → GREEN with the unchanged label, whatever the modality
  ---
  duration_ms: 1.998625
  type: 'test'
  ...
# Subtest: vitalsEver false + majority unknown → AMBER, with the new label
ok 1540 - vitalsEver false + majority unknown → AMBER, with the new label
  ---
  duration_ms: 0.113375
  type: 'test'
  ...
# Subtest: vitalsEver false + majority remote + inPerson 0 → RED, label BYTE-IDENTICAL to today
ok 1541 - vitalsEver false + majority remote + inPerson 0 → RED, label BYTE-IDENTICAL to today
  ---
  duration_ms: 0.104167
  type: 'test'
  ...
# Subtest: vitalsEver false + inPerson > 0 → AMBER, label BYTE-IDENTICAL to today
ok 1542 - vitalsEver false + inPerson > 0 → AMBER, label BYTE-IDENTICAL to today
  ---
  duration_ms: 0.057
  type: 'test'
  ...
# Subtest: the no-visits variant of the old label is preserved (opd 0 ⇒ no count suffix)
ok 1543 - the no-visits variant of the old label is preserved (opd 0 ⇒ no count suffix)
  ---
  duration_ms: 0.053542
  type: 'test'
  ...
# Subtest: the vitals factor stays counted: true in every case
ok 1544 - the vitals factor stays counted: true in every case
  ---
  duration_ms: 0.228208
  type: 'test'
  ...
# Subtest: the MODALITY factor is unaffected in all four cases — this build did not touch it
ok 1545 - the MODALITY factor is unaffected in all four cases — this build did not touch it
  ---
  duration_ms: 0.101208
  type: 'test'
  ...
# Subtest: the contact and labs factors are unaffected
ok 1546 - the contact and labs factors are unaffected
  ---
  duration_ms: 0.362584
  type: 'test'
  ...
# Subtest: the unknown case is reachable through the OR, and remote is not
ok 1547 - the unknown case is reachable through the OR, and remote is not
  ---
  duration_ms: 6.036292
  type: 'test'
  ...
# Subtest: D-B case 1 — ALL rows documented: the ladder is unchanged
ok 1548 - D-B case 1 — ALL rows documented: the ladder is unchanged
  ---
  duration_ms: 0.550833
  type: 'test'
  ...
# Subtest: D-B case 2 — NO rows documented with total > 0 ⇒ majority unknown
ok 1549 - D-B case 2 — NO rows documented with total > 0 ⇒ majority unknown
  ---
  duration_ms: 0.091459
  type: 'test'
  ...
# Subtest: D-B case 3 — total === 0 still returns unknown, as it always did
ok 1550 - D-B case 3 — total === 0 still returns unknown, as it always did
  ---
  duration_ms: 0.057541
  type: 'test'
  ...
# Subtest: picture confidence: unknown is AMBER, still counted, with the exact label
ok 1551 - picture confidence: unknown is AMBER, still counted, with the exact label
  ---
  duration_ms: 0.270042
  type: 'test'
  ...
# Subtest: picture confidence: in_person, mixed and remote branches are byte-identical
ok 1552 - picture confidence: in_person, mixed and remote branches are byte-identical
  ---
  duration_ms: 0.159333
  type: 'test'
  ...
# Subtest: buildVitalsView: unknown gets the exact note; the other branch is unchanged
ok 1553 - buildVitalsView: unknown gets the exact note; the other branch is unchanged
  ---
  duration_ms: 0.105625
  type: 'test'
  ...
# Subtest: the call-context sentence no longer claims remote care when the modality is unknown
ok 1554 - the call-context sentence no longer claims remote care when the modality is unknown
  ---
  duration_ms: 0.37725
  type: 'test'
  ...
# Subtest: THE JOIN KEY: consult_uid is matched FIRST, prescription_uid is the fallback
ok 1555 - THE JOIN KEY: consult_uid is matched FIRST, prescription_uid is the fallback
  ---
  duration_ms: 0.073708
  type: 'test'
  ...
# Subtest: the vitals SELECT now carries consult_uid, and fetchRows exposes it
ok 1556 - the vitals SELECT now carries consult_uid, and fetchRows exposes it
  ---
  duration_ms: 0.201875
  type: 'test'
  ...
# Subtest: the resolver copies individualUidForPresc: isUid guard, LIMIT 1, soft-fail
ok 1557 - the resolver copies individualUidForPresc: isUid guard, LIMIT 1, soft-fail
  ---
  duration_ms: 0.522208
  type: 'test'
  ...
# Subtest: readEncounterVitals still never throws, and readMemberVitals is untouched
ok 1558 - readEncounterVitals still never throws, and readMemberVitals is untouched
  ---
  duration_ms: 0.101041
  type: 'test'
  ...
# Subtest: Gate D · no regression: every ratified gold case is byte-identical flag-on vs flag-off
ok 1559 - Gate D · no regression: every ratified gold case is byte-identical flag-on vs flag-off
  ---
  duration_ms: 22.428959
  type: 'test'
  ...
# Subtest: Gate D · additive-only: composing an admission preserves every baseline occurrence, all deltas admission-anchored
ok 1560 - Gate D · additive-only: composing an admission preserves every baseline occurrence, all deltas admission-anchored
  ---
  duration_ms: 1.746
  type: 'test'
  ...
# Subtest: Gate D · flag-off: the fixture is byte-identical to the frozen spine (composition does not fire)
ok 1561 - Gate D · flag-off: the fixture is byte-identical to the frozen spine (composition does not fire)
  ---
  duration_ms: 0.17925
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: every relation has a ratified status, and every ratified status has a relation
ok 1562 - every relation has a ratified status, and every ratified status has a relation
  ---
  duration_ms: 0.863583
  type: 'test'
  ...
# Subtest: no relation THREW — a crash is never a legitimate relation outcome
ok 1563 - no relation THREW — a crash is never a legitimate relation outcome
  ---
  duration_ms: 0.14575
  type: 'test'
  ...
# Subtest: D-1 Dose context is read — holds
ok 1564 - D-1 Dose context is read — holds
  ---
  duration_ms: 0.050709
  type: 'test'
  ...
# Subtest: D-2 Dose context, inverse — holds
ok 1565 - D-2 Dose context, inverse — holds
  ---
  duration_ms: 0.030208
  type: 'test'
  ...
# Subtest: D-3 SOS cap is applied — holds
ok 1566 - D-3 SOS cap is applied — holds
  ---
  duration_ms: 0.0375
  type: 'test'
  ...
# Subtest: D-4 Dose completeness — holds
ok 1567 - D-4 Dose completeness — holds
  ---
  duration_ms: 0.027959
  type: 'test'
  ...
# Subtest: D-5 Formulation is read — reproduces the observed defect (pinned)
ok 1568 - D-5 Formulation is read — reproduces the observed defect (pinned)
  ---
  duration_ms: 0.026583
  type: 'test'
  ...
# Subtest: D-6 Interaction needs both members — holds
ok 1569 - D-6 Interaction needs both members — holds
  ---
  duration_ms: 0.080875
  type: 'test'
  ...
# Subtest: D-7 Interaction ignores non-analgesic dose — holds
ok 1570 - D-7 Interaction ignores non-analgesic dose — holds
  ---
  duration_ms: 0.188416
  type: 'test'
  ...
# Subtest: G-1 Order independence — holds
ok 1571 - G-1 Order independence — holds
  ---
  duration_ms: 0.25225
  type: 'test'
  ...
# Subtest: G-2 Unrelated addition — holds
ok 1572 - G-2 Unrelated addition — holds
  ---
  duration_ms: 0.036875
  type: 'test'
  ...
# Subtest: G-3 Empty-field safety — holds
ok 1573 - G-3 Empty-field safety — holds
  ---
  duration_ms: 0.026
  type: 'test'
  ...
# Subtest: G-4 Unit invariance — holds
ok 1574 - G-4 Unit invariance — holds
  ---
  duration_ms: 0.020791
  type: 'test'
  ...
# Subtest: G-5 Duplicate line — holds
ok 1575 - G-5 Duplicate line — holds
  ---
  duration_ms: 0.021125
  type: 'test'
  ...
# Subtest: G-6 Teleconsult context — holds
ok 1576 - G-6 Teleconsult context — holds
  ---
  duration_ms: 0.02025
  type: 'test'
  ...
# Subtest: G-7 Referral handoff — holds
ok 1577 - G-7 Referral handoff — holds
  ---
  duration_ms: 0.05625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: removes: base HAS the state, transformed does NOT → HOLDS
ok 1578 - removes: base HAS the state, transformed does NOT → HOLDS
  ---
  duration_ms: 0.633625
  type: 'test'
  ...
# Subtest: removes: base HAS the state, transformed STILL has it → FAILS
ok 1579 - removes: base HAS the state, transformed STILL has it → FAILS
  ---
  duration_ms: 0.068667
  type: 'test'
  ...
# Subtest: removes: base LACKS the state → VACUOUS, with today's exact reason string
ok 1580 - removes: base LACKS the state → VACUOUS, with today's exact reason string
  ---
  duration_ms: 0.067042
  type: 'test'
  ...
# Subtest: adds: base LACKS the state, transformed HAS it → HOLDS
ok 1581 - adds: base LACKS the state, transformed HAS it → HOLDS
  ---
  duration_ms: 0.052083
  type: 'test'
  ...
# Subtest: adds: base LACKS the state, transformed ALSO lacks it → FAILS
ok 1582 - adds: base LACKS the state, transformed ALSO lacks it → FAILS
  ---
  duration_ms: 0.04725
  type: 'test'
  ...
# Subtest: adds: base ALREADY fires → VACUOUS with the new reason, and NEVER HOLDS
ok 1583 - adds: base ALREADY fires → VACUOUS with the new reason, and NEVER HOLDS
  ---
  duration_ms: 0.06275
  type: 'test'
  ...
# Subtest: L-1 fires on a finding naming the antibiotic
ok 1584 - L-1 fires on a finding naming the antibiotic
  ---
  duration_ms: 0.211875
  type: 'test'
  ...
# Subtest: L-1 does NOT fire on a finding whose only match is the word cellulitis — the original defect
ok 1585 - L-1 does NOT fire on a finding whose only match is the word cellulitis — the original defect
  ---
  duration_ms: 0.095708
  type: 'test'
  ...
# Subtest: L-1 ignores informational findings and praise
ok 1586 - L-1 ignores informational findings and praise
  ---
  duration_ms: 0.203708
  type: 'test'
  ...
# Subtest: L-1: ONLY the symptom line and the diagnosis text change between the arms
ok 1587 - L-1: ONLY the symptom line and the diagnosis text change between the arms
  ---
  duration_ms: 0.692917
  type: 'test'
  ...
# Subtest: L-2: the DRUGS stay and the REASON goes
ok 1588 - L-2: the DRUGS stay and the REASON goes
  ---
  duration_ms: 0.094708
  type: 'test'
  ...
# Subtest: L-2: the referral the old fixture rested on is GONE from both arms
ok 1589 - L-2: the referral the old fixture rested on is GONE from both arms
  ---
  duration_ms: 0.062708
  type: 'test'
  ...
# Subtest: L-3: the base earns praise through a named drug, and the transformation is untouched
ok 1590 - L-3: the base earns praise through a named drug, and the transformation is untouched
  ---
  duration_ms: 0.089166
  type: 'test'
  ...
# Subtest: every relation carries an active flag, and it is a boolean
ok 1591 - every relation carries an active flag, and it is a boolean
  ---
  duration_ms: 0.034792
  type: 'test'
  ...
# Subtest: EXACTLY ONE relation is active — L-1; L-2 and L-3 are retired
ok 1592 - EXACTLY ONE relation is active — L-1; L-2 and L-3 are retired
  ---
  duration_ms: 0.038125
  type: 'test'
  ...
# Subtest: RETIRED IS NOT DELETED — both objects stay complete and usable as fixtures
ok 1593 - RETIRED IS NOT DELETED — both objects stay complete and usable as fixtures
  ---
  duration_ms: 0.171542
  type: 'test'
  ...
# Subtest: the runner and the panel both filter on active — retired relations are skipped, not shown
ok 1594 - the runner and the panel both filter on active — retired relations are skipped, not shown
  ---
  duration_ms: 0.423167
  type: 'test'
  ...
# Subtest: the panel states the leg's scope and the retirement, without overclaiming
ok 1595 - the panel states the leg's scope and the retirement, without overclaiming
  ---
  duration_ms: 0.193208
  type: 'test'
  ...
# Subtest: every relation in PART_C_RELATIONS carries a direction, and it is one of the two
ok 1596 - every relation in PART_C_RELATIONS carries a direction, and it is one of the two
  ---
  duration_ms: 0.058458
  type: 'test'
  ...
# Subtest: ids, experiment names and titles are preserved — the lab history must stay joinable
ok 1597 - ids, experiment names and titles are preserved — the lab history must stay joinable
  ---
  duration_ms: 0.125666
  type: 'test'
  ...
# Subtest: the generalising tests still cover ALL THREE relations, active or retired
ok 1598 - the generalising tests still cover ALL THREE relations, active or retired
  ---
  duration_ms: 0.045584
  type: 'test'
  ...
# Subtest: every fixture is synthetic — no db13 uid may reach the lab runner (§9.3)
ok 1599 - every fixture is synthetic — no db13 uid may reach the lab runner (§9.3)
  ---
  duration_ms: 0.0855
  type: 'test'
  ...
# Subtest: no relation throws on its own transform, and both arms stay well-formed rows
ok 1600 - no relation throws on its own transform, and both arms stay well-formed rows
  ---
  duration_ms: 0.07975
  type: 'test'
  ...
# Subtest: every statement the route runs is in the .sql, and every statement in the .sql is run
ok 1601 - every statement the route runs is in the .sql, and every statement in the .sql is run
  ---
  duration_ms: 3.419208
  type: 'test'
  ...
# Subtest: the parity comparison cannot pass vacuously
ok 1602 - the parity comparison cannot pass vacuously
  ---
  duration_ms: 2.779417
  type: 'test'
  ...
# Subtest: every CHECK value in the route is in the .sql, and the reverse
ok 1603 - every CHECK value in the route is in the .sql, and the reverse
  ---
  duration_ms: 2.372667
  type: 'test'
  ...
# Subtest: the value lists are GENERATED, never hand-typed into the route
ok 1604 - the value lists are GENERATED, never hand-typed into the route
  ---
  duration_ms: 0.358875
  type: 'test'
  ...
# Subtest: the retrieval_role CHECK is generated from RETRIEVAL_ROLES and rejects an unknown role
ok 1605 - the retrieval_role CHECK is generated from RETRIEVAL_ROLES and rejects an unknown role
  ---
  duration_ms: 0.424375
  type: 'test'
  ...
# Subtest: the conditional NOT NULL is the ONE allowed difference, and the .sql states the rule
ok 1606 - the conditional NOT NULL is the ONE allowed difference, and the .sql states the rule
  ---
  duration_ms: 1.17125
  type: 'test'
  ...
# Subtest: every statement is idempotent, and each ADD CONSTRAINT is preceded by its own DROP
ok 1607 - every statement is idempotent, and each ADD CONSTRAINT is preceded by its own DROP
  ---
  duration_ms: 0.96625
  type: 'test'
  ...
# Subtest: the index count in the .sql is the real total
ok 1608 - the index count in the .sql is the real total
  ---
  duration_ms: 1.128334
  type: 'test'
  ...
# Subtest: each table comment is written for its own table, not pasted three times
ok 1609 - each table comment is written for its own table, not pasted three times
  ---
  duration_ms: 0.422375
  type: 'test'
  ...
# Subtest: the route halts, changes nothing and reports counts when the table exists with rows
ok 1610 - the route halts, changes nothing and reports counts when the table exists with rows
  ---
  duration_ms: 0.86025
  type: 'test'
  ...
# Subtest: the outcome CHECK partitions the states, and the .sql says so where it cannot branch
ok 1611 - the outcome CHECK partitions the states, and the .sql says so where it cannot branch
  ---
  duration_ms: 0.182583
  type: 'test'
  ...
# Subtest: the mirror names the route, and the route names the mirror
ok 1612 - the mirror names the route, and the route names the mirror
  ---
  duration_ms: 0.514416
  type: 'test'
  ...
# Subtest: D1 FIRST: the rendered prompt contains NO human label, reviewer name, or triage field
ok 1613 - D1 FIRST: the rendered prompt contains NO human label, reviewer name, or triage field
  ---
  duration_ms: 0.684292
  type: 'test'
  ...
# Subtest: D1 structural: the renderer accepts ONLY the finding + note context — no third argument
ok 1614 - D1 structural: the renderer accepts ONLY the finding + note context — no third argument
  ---
  duration_ms: 0.6555
  type: 'test'
  ...
# Subtest: D2: the model sees what a reviewer sees — all six finding fields plus the note context
ok 1615 - D2: the model sees what a reviewer sees — all six finding fields plus the note context
  ---
  duration_ms: 0.094958
  type: 'test'
  ...
# Subtest: the rubric uses the reviewer surface's own definitions, verbatim
ok 1616 - the rubric uses the reviewer surface's own definitions, verbatim
  ---
  duration_ms: 0.050542
  type: 'test'
  ...
# Subtest: the parser accepts exactly the three classes
ok 1617 - the parser accepts exactly the three classes
  ---
  duration_ms: 0.445125
  type: 'test'
  ...
# Subtest: anything outside the three classes is `unparseable` and COUNTED — never coerced
ok 1618 - anything outside the three classes is `unparseable` and COUNTED — never coerced
  ---
  duration_ms: 0.133959
  type: 'test'
  ...
# Subtest: cohenKappa: perfect agreement 1, computed example exact, degenerate cases total
ok 1619 - cohenKappa: perfect agreement 1, computed example exact, degenerate cases total
  ---
  duration_ms: 0.2265
  type: 'test'
  ...
# Subtest: D5: contested rows are EXCLUDED from κ and every rate, but present and described
ok 1620 - D5: contested rows are EXCLUDED from κ and every rate, but present and described
  ---
  duration_ms: 0.449792
  type: 'test'
  ...
# Subtest: unparseable is a COUNTED outcome: disagreement, never dropped, never coerced
ok 1621 - unparseable is a COUNTED outcome: disagreement, never dropped, never coerced
  ---
  duration_ms: 0.276333
  type: 'test'
  ...
# Subtest: κ by engine version partitions the scored set
ok 1622 - κ by engine version partitions the scored set
  ---
  duration_ms: 0.410167
  type: 'test'
  ...
# Subtest: self-agreement is its own readout, and the kill-condition comparison is computed
ok 1623 - self-agreement is its own readout, and the kill-condition comparison is computed
  ---
  duration_ms: 0.10225
  type: 'test'
  ...
# Subtest: per-class precision/recall come from the pooled confusion matrix
ok 1624 - per-class precision/recall come from the pooled confusion matrix
  ---
  duration_ms: 0.089333
  type: 'test'
  ...
# Subtest: planTrial: 778 scored + 39 contested ⇒ 1,634 planned calls, under the cap
ok 1625 - planTrial: 778 scored + 39 contested ⇒ 1,634 planned calls, under the cap
  ---
  duration_ms: 0.057292
  type: 'test'
  ...
# Subtest: planTrial REFUSES over the cap — before the first call, not after
ok 1626 - planTrial REFUSES over the cap — before the first call, not after
  ---
  duration_ms: 0.089334
  type: 'test'
  ...
# Subtest: prompt version is pinned and single-sourced
ok 1627 - prompt version is pinned and single-sourced
  ---
  duration_ms: 0.04675
  type: 'test'
  ...
# Subtest: no write path to opd_audit_feedback exists anywhere in the trial code
ok 1628 - no write path to opd_audit_feedback exists anywhere in the trial code
  ---
  duration_ms: 1.541542
  type: 'test'
  ...
# Subtest: label_source shape is the ruling's, and the id comes from the RESPONSE
ok 1629 - label_source shape is the ruling's, and the id comes from the RESPONSE
  ---
  duration_ms: 0.260917
  type: 'test'
  ...
# Subtest: C1: dedup is one-row-per-key, LATEST artefact wins — a re-run supersedes its failures
ok 1630 - C1: dedup is one-row-per-key, LATEST artefact wins — a re-run supersedes its failures
  ---
  duration_ms: 17.701375
  type: 'test'
  ...
# Subtest: §4: cross-invocation agreement is its own figure and ignores unresolved invocations
ok 1631 - §4: cross-invocation agreement is its own figure and ignores unresolved invocations
  ---
  duration_ms: 1.525167
  type: 'test'
  ...
# Subtest: C3: the route accepts a keyed top-up that bypasses the offset plan gate but not the auth
ok 1632 - C3: the route accepts a keyed top-up that bypasses the offset plan gate but not the auth
  ---
  duration_ms: 0.277542
  type: 'test'
  ...
# Subtest: C2: the summary reports distinct keys vs the set WITH the missing-key list and the dedup rule
ok 1633 - C2: the summary reports distinct keys vs the set WITH the missing-key list and the dedup rule
  ---
  duration_ms: 0.193833
  type: 'test'
  ...
# Subtest: applyCohort: frozen labels win, extras separated, missing listed, revisions counted
ok 1634 - applyCohort: frozen labels win, extras separated, missing listed, revisions counted
  ---
  duration_ms: 2.298708
  type: 'test'
  ...
# Subtest: the cohort is immutable and the summary carries cohortId beside the metrics
ok 1635 - the cohort is immutable and the summary carries cohortId beside the metrics
  ---
  duration_ms: 0.261084
  type: 'test'
  ...
# Subtest: pre-freeze (version absent): four model-side meters armed, value null, armed label
ok 1636 - pre-freeze (version absent): four model-side meters armed, value null, armed label
  ---
  duration_ms: 1.22475
  type: 'test'
  ...
# Subtest: pre-freeze: reviewer cadence ALWAYS live (never armed, never faked)
ok 1637 - pre-freeze: reviewer cadence ALWAYS live (never armed, never faked)
  ---
  duration_ms: 1.101584
  type: 'test'
  ...
# Subtest: post-freeze: model-side meters unarm and carry real values + fill
ok 1638 - post-freeze: model-side meters unarm and carry real values + fill
  ---
  duration_ms: 0.214458
  type: 'test'
  ...
# Subtest: meters returned in mockup order
ok 1639 - meters returned in mockup order
  ---
  duration_ms: 0.789
  type: 'test'
  ...
# Subtest: fill clamps to [0,1] even when value exceeds target
ok 1640 - fill clamps to [0,1] even when value exceeds target
  ---
  duration_ms: 0.156625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: bm25_rank surviving from a later variant is preserved (the exact bug being fixed)
ok 1641 - bm25_rank surviving from a later variant is preserved (the exact bug being fixed)
  ---
  duration_ms: 0.764
  type: 'test'
  ...
# Subtest: bm25_variant_ranks aligns to variants and is null where the chunk did not arrive via that BM25 leg
ok 1642 - bm25_variant_ranks aligns to variants and is null where the chunk did not arrive via that BM25 leg
  ---
  duration_ms: 0.431833
  type: 'test'
  ...
# Subtest: scalar bm25_rank is the best (min) non-null across variants
ok 1643 - scalar bm25_rank is the best (min) non-null across variants
  ---
  duration_ms: 0.124667
  type: 'test'
  ...
# Subtest: a chunk that never arrived via any BM25 leg has bm25_rank null
ok 1644 - a chunk that never arrived via any BM25 leg has bm25_rank null
  ---
  duration_ms: 0.126458
  type: 'test'
  ...
# Subtest: variant_ranks and rrf_score are unchanged by the provenance addition
ok 1645 - variant_ranks and rrf_score are unchanged by the provenance addition
  ---
  duration_ms: 0.28525
  type: 'test'
  ...
# Subtest: each per-variant retrieve() is called with withDiagnostics true (so bm25_rank is populated)
ok 1646 - each per-variant retrieve() is called with withDiagnostics true (so bm25_rank is populated)
  ---
  duration_ms: 0.123417
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: expandQuery runs exactly once, on the original question
ok 1647 - expandQuery runs exactly once, on the original question
  ---
  duration_ms: 0.77325
  type: 'test'
  ...
# Subtest: the original arm retrieves on expanded text; variant arms retrieve on variant text
ok 1648 - the original arm retrieves on expanded text; variant arms retrieve on variant text
  ---
  duration_ms: 0.456958
  type: 'test'
  ...
# Subtest: variant generation runs on the original question, never the expanded paragraph
ok 1649 - variant generation runs on the original question, never the expanded paragraph
  ---
  duration_ms: 0.113875
  type: 'test'
  ...
# Subtest: skipExpand:true from the caller turns expansion OFF — expandQuery is not called
ok 1650 - skipExpand:true from the caller turns expansion OFF — expandQuery is not called
  ---
  duration_ms: 0.111583
  type: 'test'
  ...
# Subtest: expansion fail-open (returns the original question) leaves the original arm on the raw question
ok 1651 - expansion fail-open (returns the original question) leaves the original arm on the raw question
  ---
  duration_ms: 0.275542
  type: 'test'
  ...
# Subtest: per-variant retrieve() keeps reranker/weights OFF after expansion is restored
ok 1652 - per-variant retrieve() keeps reranker/weights OFF after expansion is restored
  ---
  duration_ms: 0.203875
  type: 'test'
  ...
# Subtest: expandedQuery is returned on MultiRetrieveResult
ok 1653 - expandedQuery is returned on MultiRetrieveResult
  ---
  duration_ms: 0.124167
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: RRF fusion: a chunk ranked \#1 by two variants beats a chunk ranked \#1 by one variant with higher cosine
ok 1654 - RRF fusion: a chunk ranked \#1 by two variants beats a chunk ranked \#1 by one variant with higher cosine
  ---
  duration_ms: 2.300708
  type: 'test'
  ...
# Subtest: rerank runs once over the fused pool against the original question — never a variant
ok 1655 - rerank runs once over the fused pool against the original question — never a variant
  ---
  duration_ms: 0.240542
  type: 'test'
  ...
# Subtest: source weighting: a guidelines (0.95) chunk outranks an unknown-journal (0.80) chunk at equal rerank score
ok 1656 - source weighting: a guidelines (0.95) chunk outranks an unknown-journal (0.80) chunk at equal rerank score
  ---
  duration_ms: 0.298334
  type: 'test'
  ...
# Subtest: per-variant retrieve() runs with useReranker/useSourceWeights false; fusion reranks once
ok 1657 - per-variant retrieve() runs with useReranker/useSourceWeights false; fusion reranks once
  ---
  duration_ms: 0.187875
  type: 'test'
  ...
# Subtest: variant generation returning nothing falls back to the original query alone, no throw
ok 1658 - variant generation returning nothing falls back to the original query alone, no throw
  ---
  duration_ms: 0.935958
  type: 'test'
  ...
# Subtest: multi-query hits always carry rrf_score + variant_ranks — no includeQuarantined needed
ok 1659 - multi-query hits always carry rrf_score + variant_ranks — no includeQuarantined needed
  ---
  duration_ms: 0.37775
  type: 'test'
  ...
# Subtest: R-6 guard: assertEmbeddingV2Available throws a named error when v2 is on but the column is absent
ok 1660 - R-6 guard: assertEmbeddingV2Available throws a named error when v2 is on but the column is absent
  ---
  duration_ms: 0.388917
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: every arm now RECEIVES a capture, and the fusion lifts index_version from the first that has one
ok 1661 - every arm now RECEIVES a capture, and the fusion lifts index_version from the first that has one
  ---
  duration_ms: 1.110041
  type: 'test'
  ...
# Subtest: the manifest that results carries a non-null index_version, and validates clean on that field
ok 1662 - the manifest that results carries a non-null index_version, and validates clean on that field
  ---
  duration_ms: 0.956833
  type: 'test'
  ...
# Subtest: an arm that stamps nothing leaves a null, and the null is recorded rather than invented
ok 1663 - an arm that stamps nothing leaves a null, and the null is recorded rather than invented
  ---
  duration_ms: 0.115708
  type: 'test'
  ...
# Subtest: INSTRUMENTATION OFF: no arm capture is made, and the arms are called with an undefined third argument
ok 1664 - INSTRUMENTATION OFF: no arm capture is made, and the arms are called with an undefined third argument
  ---
  duration_ms: 0.265417
  type: 'test'
  ...
# Subtest: 63 — the fail-open early exit still has its literal form, and this file does not quote it in a comment
ok 1665 - 63 — the fail-open early exit still has its literal form, and this file does not quote it in a comment
  ---
  duration_ms: 0.088625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: DEFAULT_NORMATIVE_SOURCES = choosing-wisely + the two activated guideline keys, in order
ok 1666 - DEFAULT_NORMATIVE_SOURCES = choosing-wisely + the two activated guideline keys, in order
  ---
  duration_ms: 0.713792
  type: 'test'
  ...
# Subtest: the added keys target ACTIVATED sources (lab:), never quarantined (labq:) — inert until activation
ok 1667 - the added keys target ACTIVATED sources (lab:), never quarantined (labq:) — inert until activation
  ---
  duration_ms: 0.25425
  type: 'test'
  ...
# Subtest: sourceLabel renders "Even Guidelines" / "ICMR Guidelines" for the activated sources
ok 1668 - sourceLabel renders "Even Guidelines" / "ICMR Guidelines" for the activated sources
  ---
  duration_ms: 0.106209
  type: 'test'
  ...
# Subtest: labels are INERT while quarantined: a labq: chunk falls back to book (unchanged today)
ok 1669 - labels are INERT while quarantined: a labq: chunk falls back to book (unchanged today)
  ---
  duration_ms: 0.045375
  type: 'test'
  ...
# Subtest: choosing-wisely and every other source are byte-identical (book-driven, no override)
ok 1670 - choosing-wisely and every other source are byte-identical (book-driven, no override)
  ---
  duration_ms: 0.057167
  type: 'test'
  ...
# Subtest: the guideline anchors resolve to NO url (category/internal authority, not deterministic)
ok 1671 - the guideline anchors resolve to NO url (category/internal authority, not deterministic)
  ---
  duration_ms: 0.09375
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [normative-grounding] CW leg failed db down
# [normative-grounding] guideline leg failed db down
# Subtest: CW gate: accept the top candidate only when its statement category == finding.lvc_category AND cosine ≥ τ
ok 1672 - CW gate: accept the top candidate only when its statement category == finding.lvc_category AND cosine ≥ τ
  ---
  duration_ms: 0.641417
  type: 'test'
  ...
# Subtest: guideline gate: accept iff cosine ≥ τ (no category constraint)
ok 1673 - guideline gate: accept iff cosine ≥ τ (no category constraint)
  ---
  duration_ms: 0.144125
  type: 'test'
  ...
# Subtest: mergeNormativeCitations attaches both accepted legs and dedupes against existing
ok 1674 - mergeNormativeCitations attaches both accepted legs and dedupes against existing
  ---
  duration_ms: 0.60325
  type: 'test'
  ...
# Subtest: hitToSource: guideline anchor resolves to NO url (no fake identifier), CW keeps its source/item
ok 1675 - hitToSource: guideline anchor resolves to NO url (no fake identifier), CW keeps its source/item
  ---
  duration_ms: 0.0565
  type: 'test'
  ...
# Subtest: SCORE-INVARIANCE: attaching citations leaves verdict/score/band/lvc_category byte-identical
ok 1676 - SCORE-INVARIANCE: attaching citations leaves verdict/score/band/lvc_category byte-identical
  ---
  duration_ms: 0.597333
  type: 'test'
  ...
# Subtest: attachNormativeCitations is IDEMPOTENT — a re-run adds nothing
ok 1677 - attachNormativeCitations is IDEMPOTENT — a re-run adds nothing
  ---
  duration_ms: 0.07675
  type: 'test'
  ...
# Subtest: groundFinding attaches CW+guideline when both legs return accepted hits
ok 1678 - groundFinding attaches CW+guideline when both legs return accepted hits
  ---
  duration_ms: 0.280958
  type: 'test'
  ...
# Subtest: groundFinding grounds nothing on cross-category CW / below-τ guideline, and SOFT-FAILS on throw
ok 1679 - groundFinding grounds nothing on cross-category CW / below-τ guideline, and SOFT-FAILS on throw
  ---
  duration_ms: 0.253875
  type: 'test'
  ...
# Subtest: even gate: accept iff cosine ≥ τ AND the dynamic lookup category == finding.lvc_category
ok 1680 - even gate: accept iff cosine ≥ τ AND the dynamic lookup category == finding.lvc_category
  ---
  duration_ms: 0.229667
  type: 'test'
  ...
# Subtest: citation ordering: external legs first, even-lvc LAST; dedup by (source,item_number)
ok 1681 - citation ordering: external legs first, even-lvc LAST; dedup by (source,item_number)
  ---
  duration_ms: 0.350375
  type: 'test'
  ...
# Subtest: groundFinding runs the even leg ONLY with a lookup; attaches it last, inert without a lookup
ok 1682 - groundFinding runs the even leg ONLY with a lookup; attaches it last, inert without a lookup
  ---
  duration_ms: 0.150625
  type: 'test'
  ...
# Subtest: --legs cw runs ONLY the CW leg (guideline omitted, guideline retrieve not even called)
ok 1683 - --legs cw runs ONLY the CW leg (guideline omitted, guideline retrieve not even called)
  ---
  duration_ms: 0.076417
  type: 'test'
  ...
# Subtest: --legs guideline runs ONLY the guideline leg (CW omitted)
ok 1684 - --legs guideline runs ONLY the guideline leg (CW omitted)
  ---
  duration_ms: 0.053583
  type: 'test'
  ...
# Subtest: --categories filters eligibility: a finding whose lvc_category is not listed grounds nothing
ok 1685 - --categories filters eligibility: a finding whose lvc_category is not listed grounds nothing
  ---
  duration_ms: 0.141417
  type: 'test'
  ...
# Subtest: --tau raises/lowers acceptance (same match math, different threshold)
ok 1686 - --tau raises/lowers acceptance (same match math, different threshold)
  ---
  duration_ms: 0.087541
  type: 'test'
  ...
# Subtest: DEFAULT options reproduce today's behaviour byte-identically (regression guard)
ok 1687 - DEFAULT options reproduce today's behaviour byte-identically (regression guard)
  ---
  duration_ms: 0.121333
  type: 'test'
  ...
# Subtest: CW category map: every id maps to a known lvc_category; the strong categories are covered
ok 1688 - CW category map: every id maps to a known lvc_category; the strong categories are covered
  ---
  duration_ms: 0.06475
  type: 'test'
  ...
# Subtest: isGroundableFinding: only non-informational low-value findings
ok 1689 - isGroundableFinding: only non-informational low-value findings
  ---
  duration_ms: 0.04325
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: resolveNormativeSources defaults to choosing-wisely + the two activated guideline keys; never labq:% by default
ok 1690 - resolveNormativeSources defaults to choosing-wisely + the two activated guideline keys; never labq:% by default
  ---
  duration_ms: 0.78375
  type: 'test'
  ...
# Subtest: normativeLegK reads env NORMATIVE_LEG_K, defaults 5
ok 1691 - normativeLegK reads env NORMATIVE_LEG_K, defaults 5
  ---
  duration_ms: 0.097625
  type: 'test'
  ...
# Subtest: the normative leg is the vector SQL filtered to source = ANY, capped at N_norm
ok 1692 - the normative leg is the vector SQL filtered to source = ANY, capped at N_norm
  ---
  duration_ms: 0.225625
  type: 'test'
  ...
# Subtest: the normative leg leaves the default filter clauses byte-identical
ok 1693 - the normative leg leaves the default filter clauses byte-identical
  ---
  duration_ms: 0.1135
  type: 'test'
  ...
# Subtest: useNormativeLeg + normativeSources thread through retrieveMultiQuery to each per-variant retrieve
ok 1694 - useNormativeLeg + normativeSources thread through retrieveMultiQuery to each per-variant retrieve
  ---
  duration_ms: 0.354542
  type: 'test'
  ...
# Subtest: engine bumped to 0.81.19 (neutraliser removal) and the read family includes 0.81.8…0.81.17
ok 1695 - engine bumped to 0.81.19 (neutraliser removal) and the read family includes 0.81.8…0.81.17
  ---
  duration_ms: 0.535208
  type: 'test'
  ...
# Subtest: bug 9: an unresolved brand is surfaced but informational (never scores)
ok 1696 - bug 9: an unresolved brand is surfaced but informational (never scores)
  ---
  duration_ms: 1.347167
  type: 'test'
  ...
# Subtest: bug 6: an unresolved line never ALSO stacks incomplete dosing (consolidated)
ok 1697 - bug 6: an unresolved line never ALSO stacks incomplete dosing (consolidated)
  ---
  duration_ms: 0.2985
  type: 'test'
  ...
# Subtest: bug 7: an off-formulary cosmetic (by name) is exempt from incomplete dosing
ok 1698 - bug 7: an off-formulary cosmetic (by name) is exempt from incomplete dosing
  ---
  duration_ms: 0.234042
  type: 'test'
  ...
# Subtest: a RESOLVED real drug missing its dose STILL scores incomplete dosing
ok 1699 - a RESOLVED real drug missing its dose STILL scores incomplete dosing
  ---
  duration_ms: 0.218042
  type: 'test'
  ...
# Subtest: bug 2: a health-check package encounter is recognised and neutralises screening critiques
ok 1700 - bug 2: a health-check package encounter is recognised and neutralises screening critiques
  ---
  duration_ms: 0.4345
  type: 'test'
  ...
# Subtest: bug 10: a biotin-before-thyroid over-flag is neutralised to informational
ok 1701 - bug 10: a biotin-before-thyroid over-flag is neutralised to informational
  ---
  duration_ms: 0.755083
  type: 'test'
  ...
# Subtest: bug 5: the Antispasmodic/anticholinergic reclass does NOT change DDI tags
ok 1702 - bug 5: the Antispasmodic/anticholinergic reclass does NOT change DDI tags
  ---
  duration_ms: 0.503625
  type: 'test'
  ...
# Subtest: Part B: the 3 base categories are unchanged
ok 1703 - Part B: the 3 base categories are unchanged
  ---
  duration_ms: 0.727125
  type: 'test'
  ...
# Subtest: Part B: residual other splits into overuse sub-tags by priority
ok 1704 - Part B: residual other splits into overuse sub-tags by priority
  ---
  duration_ms: 2.091958
  type: 'test'
  ...
# Subtest: Part B: the omission guard keeps missing-safety-net / mismatch findings in other
ok 1705 - Part B: the omission guard keeps missing-safety-net / mismatch findings in other
  ---
  duration_ms: 0.413792
  type: 'test'
  ...
# Subtest: Part B: priority order — therapeutic_duplication wins over a steroid mention
ok 1706 - Part B: priority order — therapeutic_duplication wins over a steroid mention
  ---
  duration_ms: 0.038083
  type: 'test'
  ...
# Subtest: Part B: every category has a shared human label (no raw slug can render)
ok 1707 - Part B: every category has a shared human label (no raw slug can render)
  ---
  duration_ms: 0.0465
  type: 'test'
  ...
# Subtest: Part C: frequentFlierCmp orders per Decision 12
ok 1708 - Part C: frequentFlierCmp orders per Decision 12
  ---
  duration_ms: 0.121625
  type: 'test'
  ...
# Subtest: Part C: default (index) order is untouched by the comparator module
ok 1709 - Part C: default (index) order is untouched by the comparator module
  ---
  duration_ms: 0.032708
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 0.81.10 S1: the muscle-relaxant finding is emitted informational (surfaced, out of the score)
ok 1710 - 0.81.10 S1: the muscle-relaxant finding is emitted informational (surfaced, out of the score)
  ---
  duration_ms: 1.675708
  type: 'test'
  ...
# Subtest: bug 1: xanthine for an acute URTI fires (context-guarded)
ok 1711 - bug 1: xanthine for an acute URTI fires (context-guarded)
  ---
  duration_ms: 3.5215
  type: 'test'
  ...
# Subtest: bug 1: the SAME xanthine is NOT flagged for a chronic-airways patient (J40–J47 guard)
ok 1712 - bug 1: the SAME xanthine is NOT flagged for a chronic-airways patient (J40–J47 guard)
  ---
  duration_ms: 0.297833
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 12: acebrophylline + acetylcysteine in an acute URTI → NO finding (rule dormant for it)
ok 1713 - 0.81.14 Ruling 12: acebrophylline + acetylcysteine in an acute URTI → NO finding (rule dormant for it)
  ---
  duration_ms: 0.075542
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 11: antihistamine + montelukast emits NO finding at any duration
ok 1714 - 0.81.13 Decision 11: antihistamine + montelukast emits NO finding at any duration
  ---
  duration_ms: 0.191417
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 11: a xanthine AND antihistamine+montelukast → exactly ONE finding (the xanthine)
ok 1715 - 0.81.13 Decision 11: a xanthine AND antihistamine+montelukast → exactly ONE finding (the xanthine)
  ---
  duration_ms: 0.1355
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 3: xanthine subject/rationale carry no "mucolytic"; guard + confidence unchanged
ok 1716 - 0.81.13 Decision 3: xanthine subject/rationale carry no "mucolytic"; guard + confidence unchanged
  ---
  duration_ms: 0.173
  type: 'test'
  ...
# Subtest: bug 1: no acute-URTI context → nothing fires
ok 1717 - bug 1: no acute-URTI context → nothing fires
  ---
  duration_ms: 0.043833
  type: 'test'
  ...
# Subtest: 0.81.13 Decision 4: 5 → none; 7 → none; 8 and 15 → 0.7; 16 and 1 month → 0.85; unparseable → none
ok 1718 - 0.81.13 Decision 4: 5 → none; 7 → none; 8 and 15 → 0.7; 16 and 1 month → 0.85; unparseable → none
  ---
  duration_ms: 0.505917
  type: 'test'
  ...
# Subtest: 0.81.13: parseDurationDays (exported) parses days/weeks/months and returns null for chronic/unparseable
ok 1719 - 0.81.13: parseDurationDays (exported) parses days/weeks/months and returns null for chronic/unparseable
  ---
  duration_ms: 0.335917
  type: 'test'
  ...
# Subtest: bug 8: BPO wash-off + leave-on is NOT a duplicate (finding dropped)
ok 1720 - bug 8: BPO wash-off + leave-on is NOT a duplicate (finding dropped)
  ---
  duration_ms: 4.397334
  type: 'test'
  ...
# Subtest: bug 8: topical + systemic sharing a molecule is not a duplicate
ok 1721 - bug 8: topical + systemic sharing a molecule is not a duplicate
  ---
  duration_ms: 1.130166
  type: 'test'
  ...
# Subtest: bug 8: a genuine same-route duplicate is KEPT
ok 1722 - bug 8: a genuine same-route duplicate is KEPT
  ---
  duration_ms: 0.113125
  type: 'test'
  ...
# Subtest: bug 8: an LLM finding (non-deterministic) is never touched by the route filter
ok 1723 - bug 8: an LLM finding (non-deterministic) is never touched by the route filter
  ---
  duration_ms: 0.131709
  type: 'test'
  ...
# Subtest: bug 4: opdCaseText surfaces the consult date exactly once with a historical guard
ok 1724 - bug 4: opdCaseText surfaces the consult date exactly once with a historical guard
  ---
  duration_ms: 0.161541
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 1: an oral + topical NSAID pair emits NO interaction finding
ok 1725 - 0.81.14 Ruling 1: an oral + topical NSAID pair emits NO interaction finding
  ---
  duration_ms: 1.148167
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 1: two ORAL NSAIDs still produce an interaction finding (unchanged)
ok 1726 - 0.81.14 Ruling 1: two ORAL NSAIDs still produce an interaction finding (unchanged)
  ---
  duration_ms: 0.333791
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 4: muscle relaxant with MSK context → none; without → fires; ctx omitted → today
ok 1727 - 0.81.14 Ruling 4: muscle relaxant with MSK context → none; without → fires; ctx omitted → today
  ---
  duration_ms: 0.058667
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 4: mskContextDocumented — "low back pain" true, ICD M54.5 true, "fever, cough" false
ok 1728 - 0.81.14 Ruling 4: mskContextDocumented — "low back pain" true, ICD M54.5 true, "fever, cough" false
  ---
  duration_ms: 0.304375
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 13: 60,000 IU weekly for >8 weeks fires informational; 8 weeks / daily / low-strength / unparseable → none
ok 1729 - 0.81.14 Ruling 13: 60,000 IU weekly for >8 weeks fires informational; 8 weeks / daily / low-strength / unparseable → none
  ---
  duration_ms: 0.35925
  type: 'test'
  ...
# Subtest: 0.81.14 Rulings 5–8: pregnancy advisory fires only in the 36–90d window with a trigger drug, always informational
ok 1730 - 0.81.14 Rulings 5–8: pregnancy advisory fires only in the 36–90d window with a trigger drug, always informational
  ---
  duration_ms: 1.496709
  type: 'test'
  ...
# Subtest: 0.81.14: lmpIntervalDays parses ISO dates + fail-safe on missing/garbage
ok 1731 - 0.81.14: lmpIntervalDays parses ISO dates + fail-safe on missing/garbage
  ---
  duration_ms: 0.130792
  type: 'test'
  ...
# Subtest: wrapText: short text stays on one line
ok 1732 - wrapText: short text stays on one line
  ---
  duration_ms: 2.178917
  type: 'test'
  ...
# Subtest: wrapText: wraps on word boundaries when a line would overflow
ok 1733 - wrapText: wraps on word boundaries when a line would overflow
  ---
  duration_ms: 0.285166
  type: 'test'
  ...
# Subtest: wrapText: hard-breaks a single word longer than maxWidth
ok 1734 - wrapText: hard-breaks a single word longer than maxWidth
  ---
  duration_ms: 0.298583
  type: 'test'
  ...
# Subtest: wrapText: mixes a long word with normal words, never exceeding maxWidth
ok 1735 - wrapText: mixes a long word with normal words, never exceeding maxWidth
  ---
  duration_ms: 0.148917
  type: 'test'
  ...
# Subtest: wrapText: collapses whitespace and handles empty input
ok 1736 - wrapText: collapses whitespace and handles empty input
  ---
  duration_ms: 0.252458
  type: 'test'
  ...
# Subtest: paginate: packs items greedily within capacity
ok 1737 - paginate: packs items greedily within capacity
  ---
  duration_ms: 0.29375
  type: 'test'
  ...
# Subtest: paginate: an item taller than capacity gets its own page, never dropped
ok 1738 - paginate: an item taller than capacity gets its own page, never dropped
  ---
  duration_ms: 0.134917
  type: 'test'
  ...
# Subtest: paginate: empty input → no pages
ok 1739 - paginate: empty input → no pages
  ---
  duration_ms: 0.19125
  type: 'test'
  ...
# Subtest: paginate: everything fits on one page when capacity is large
ok 1740 - paginate: everything fits on one page when capacity is large
  ---
  duration_ms: 0.467458
  type: 'test'
  ...
# Subtest: migration 0025 is exactly one additive, idempotent statement
ok 1741 - migration 0025 is exactly one additive, idempotent statement
  ---
  duration_ms: 0.640458
  type: 'test'
  ...
# Subtest: ALL THREE write paths carry the scorecard — a row written without one is a bug
ok 1742 - ALL THREE write paths carry the scorecard — a row written without one is a bug
  ---
  duration_ms: 0.122042
  type: 'test'
  ...
# Subtest: the A.1 column is APPENDED — no established placeholder index moved
ok 1743 - the A.1 column is APPENDED — no established placeholder index moved
  ---
  duration_ms: 0.115083
  type: 'test'
  ...
# Subtest: INSERT: columns and arguments align in ALL SIXTEEN branches
ok 1744 - INSERT: columns and arguments align in ALL SIXTEEN branches
  ---
  duration_ms: 1.095375
  type: 'test'
  ...
# Subtest: INSERT: every jsonb column is cast, including the A.1 one
ok 1745 - INSERT: every jsonb column is cast, including the A.1 one
  ---
  duration_ms: 0.066833
  type: 'test'
  ...
# Subtest: UPDATE placeholders align in all four branches; scorecard $20, excluded_reason $21, quieting_gen $22
ok 1746 - UPDATE placeholders align in all four branches; scorecard $20, excluded_reason $21, quieting_gen $22
  ---
  duration_ms: 0.0645
  type: 'test'
  ...
# Subtest: serialisation is FAIL-SAFE: a scorecard fault must never cost an audit
ok 1747 - serialisation is FAIL-SAFE: a scorecard fault must never cost an audit
  ---
  duration_ms: 0.101416
  type: 'test'
  ...
# Subtest: the scorecard is stored AS COMPUTED — not pruned, reshaped or renamed
ok 1748 - the scorecard is stored AS COMPUTED — not pruned, reshaped or renamed
  ---
  duration_ms: 0.095167
  type: 'test'
  ...
# Subtest: THE POINT: an unassessed note carries note_quality with weight 0 and a stating basis
ok 1749 - THE POINT: an unassessed note carries note_quality with weight 0 and a stating basis
  ---
  duration_ms: 0.925666
  type: 'test'
  ...
# Subtest: an ASSESSED note keeps a non-zero note_quality weight — the control
ok 1750 - an ASSESSED note keeps a non-zero note_quality weight — the control
  ---
  duration_ms: 0.390542
  type: 'test'
  ...
# Subtest: matches a low-value investigation to its line
ok 1751 - matches a low-value investigation to its line
  ---
  duration_ms: 0.712458
  type: 'test'
  ...
# Subtest: matches a dosing finding to the specific medication line
ok 1752 - matches a dosing finding to the specific medication line
  ---
  duration_ms: 0.107083
  type: 'test'
  ...
# Subtest: prescribing finding prefers the med line on a tie
ok 1753 - prescribing finding prefers the med line on a tie
  ---
  duration_ms: 0.062833
  type: 'test'
  ...
# Subtest: documentation finding falls back to keyword section
ok 1754 - documentation finding falls back to keyword section
  ---
  duration_ms: 0.087667
  type: 'test'
  ...
# Subtest: follow-up keyword routes to followup section
ok 1755 - follow-up keyword routes to followup section
  ---
  duration_ms: 0.092167
  type: 'test'
  ...
# Subtest: unmatched appropriateness finding falls back to investigations section
ok 1756 - unmatched appropriateness finding falls back to investigations section
  ---
  duration_ms: 0.147084
  type: 'test'
  ...
# Subtest: appropriateness fallback goes to diagnosis when no investigations exist
ok 1757 - appropriateness fallback goes to diagnosis when no investigations exist
  ---
  duration_ms: 0.352291
  type: 'test'
  ...
# Subtest: note_quality findings anchor to the whole note
ok 1758 - note_quality findings anchor to the whole note
  ---
  duration_ms: 0.198667
  type: 'test'
  ...
# Subtest: numbers follow findings order and grouping keys are stable
ok 1759 - numbers follow findings order and grouping keys are stable
  ---
  duration_ms: 0.9475
  type: 'test'
  ...
# Subtest: stopwords alone never force a spurious med match
ok 1760 - stopwords alone never force a spurious med match
  ---
  duration_ms: 0.353459
  type: 'test'
  ...
# Subtest: chronicPoints tiers: 0 | 1–2 | 3+ → 0 | 1 | 2
ok 1761 - chronicPoints tiers: 0 | 1–2 | 3+ → 0 | 1 | 2
  ---
  duration_ms: 1.059042
  type: 'test'
  ...
# Subtest: lab/util points fire at their thresholds (3 abnormal / 4 encounters)
ok 1762 - lab/util points fire at their thresholds (3 abnormal / 4 encounters)
  ---
  duration_ms: 0.228416
  type: 'test'
  ...
# Subtest: bandFor: full point table (LOW/MODERATE/HIGH boundaries)
ok 1763 - bandFor: full point table (LOW/MODERATE/HIGH boundaries)
  ---
  duration_ms: 0.2145
  type: 'test'
  ...
# Subtest: NEW_TO_US precedence: zero encounters in prior 24m overrides the point band
ok 1764 - NEW_TO_US precedence: zero encounters in prior 24m overrides the point band
  ---
  duration_ms: 0.118667
  type: 'test'
  ...
# Subtest: complexityPoints sums the three legs
ok 1765 - complexityPoints sums the three legs
  ---
  duration_ms: 0.121584
  type: 'test'
  ...
# Subtest: buildComplexity returns band + echoes inputs
ok 1766 - buildComplexity returns band + echoes inputs
  ---
  duration_ms: 0.12125
  type: 'test'
  ...
# Subtest: windowStart: 12m / 24m before the index date (UTC month math)
ok 1767 - windowStart: 12m / 24m before the index date (UTC month math)
  ---
  duration_ms: 1.106
  type: 'test'
  ...
# Subtest: db13-row parsers: distinct chronic ICDs, abnormal count, scalar count; NULL-safe
ok 1768 - db13-row parsers: distinct chronic ICDs, abnormal count, scalar count; NULL-safe
  ---
  duration_ms: 0.129959
  type: 'test'
  ...
# Subtest: index-encounter exclusion is an as-of property: with only the index in-window, prior counts are 0 → NEW_TO_US
ok 1769 - index-encounter exclusion is an as-of property: with only the index in-window, prior counts are 0 → NEW_TO_US
  ---
  duration_ms: 0.19475
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: no eval config ⇒ opdRetrieveOpts byte-identical to today
ok 1770 - no eval config ⇒ opdRetrieveOpts byte-identical to today
  ---
  duration_ms: 0.845833
  type: 'test'
  ...
# Subtest: evalNormativeLeg:true ⇒ useNormativeLeg true regardless of mini / env
ok 1771 - evalNormativeLeg:true ⇒ useNormativeLeg true regardless of mini / env
  ---
  duration_ms: 0.092458
  type: 'test'
  ...
# Subtest: buildOpenRouterBody carries the eval determinism config: temp0 + top_p1 + seed + reasoning-pin + provider-pin
ok 1772 - buildOpenRouterBody carries the eval determinism config: temp0 + top_p1 + seed + reasoning-pin + provider-pin
  ---
  duration_ms: 0.171416
  type: 'test'
  ...
# Subtest: production defaultGenerate: Vertex-Gemini path gets temp0 + seed + top_p + fixed thinking, GATED on onGemini; mini/Ollama unchanged
ok 1773 - production defaultGenerate: Vertex-Gemini path gets temp0 + seed + top_p + fixed thinking, GATED on onGemini; mini/Ollama unchanged
  ---
  duration_ms: 0.392292
  type: 'test'
  ...
# Subtest: LVC/Kimi adjudication params: temp0 + seed + top_p + OpenRouter provider-pin
ok 1774 - LVC/Kimi adjudication params: temp0 + seed + top_p + OpenRouter provider-pin
  ---
  duration_ms: 0.147042
  type: 'test'
  ...
# Subtest: openRouterGenerate posts to the OpenRouter endpoint at temp 0 and returns the completion
ok 1775 - openRouterGenerate posts to the OpenRouter endpoint at temp 0 and returns the completion
  ---
  duration_ms: 7.267417
  type: 'test'
  ...
# Subtest: openRouterGenerate throws (does not silently fall back) when the key is missing
ok 1776 - openRouterGenerate throws (does not silently fall back) when the key is missing
  ---
  duration_ms: 0.238584
  type: 'test'
  ...
# Subtest: the lab-batch eval path never writes opd_note_audits (structural guard)
ok 1777 - the lab-batch eval path never writes opd_note_audits (structural guard)
  ---
  duration_ms: 3.410666
  type: 'test'
  ...
# Subtest: parseBatchState reads the eval config; absent ⇒ off / null
ok 1778 - parseBatchState reads the eval config; absent ⇒ off / null
  ---
  duration_ms: 0.34875
  type: 'test'
  ...
# Subtest: verdict sets are wired by scope
ok 1779 - verdict sets are wired by scope
  ---
  duration_ms: 0.847417
  type: 'test'
  ...
# Subtest: impact scope: TP-only second tap — valid tag + finding_ref required, category always null
ok 1780 - impact scope: TP-only second tap — valid tag + finding_ref required, category always null
  ---
  duration_ms: 0.286125
  type: 'test'
  ...
# Subtest: missed scope: category is REQUIRED (F6/A10.1) and whitelisted; unknown category rejected
ok 1781 - missed scope: category is REQUIRED (F6/A10.1) and whitelisted; unknown category rejected
  ---
  duration_ms: 0.196708
  type: 'test'
  ...
# Subtest: non-missed/impact scopes carry category=null
ok 1782 - non-missed/impact scopes carry category=null
  ---
  duration_ms: 0.060459
  type: 'test'
  ...
# Subtest: bad auditId is rejected before anything else
ok 1783 - bad auditId is rejected before anything else
  ---
  duration_ms: 0.04775
  type: 'test'
  ...
# Subtest: unknown scope is rejected
ok 1784 - unknown scope is rejected
  ---
  duration_ms: 0.039417
  type: 'test'
  ...
# Subtest: legacy audit scope: bare comment allowed, defaults to audit, verdict optional
ok 1785 - legacy audit scope: bare comment allowed, defaults to audit, verdict optional
  ---
  duration_ms: 0.104417
  type: 'test'
  ...
# Subtest: audit scope: valid verdict kept, invalid verdict dropped to null
ok 1786 - audit scope: valid verdict kept, invalid verdict dropped to null
  ---
  duration_ms: 0.058041
  type: 'test'
  ...
# Subtest: audit scope: empty body (no verdict, no comment) rejected
ok 1787 - audit scope: empty body (no verdict, no comment) rejected
  ---
  duration_ms: 0.20075
  type: 'test'
  ...
# Subtest: finding scope: requires a finding verdict
ok 1788 - finding scope: requires a finding verdict
  ---
  duration_ms: 0.279125
  type: 'test'
  ...
# Subtest: finding scope: requires finding_ref
ok 1789 - finding scope: requires finding_ref
  ---
  duration_ms: 0.050333
  type: 'test'
  ...
# Subtest: finding scope: all four verdicts accepted, carries ref + signal_type + optional comment
ok 1790 - finding scope: all four verdicts accepted, carries ref + signal_type + optional comment
  ---
  duration_ms: 0.059459
  type: 'test'
  ...
# Subtest: missed scope: verdict forced to missed, comment required
ok 1791 - missed scope: verdict forced to missed, comment required
  ---
  duration_ms: 0.04775
  type: 'test'
  ...
# Subtest: fields are trimmed, empties collapse to null, oversized values are capped
ok 1792 - fields are trimmed, empties collapse to null, oversized values are capped
  ---
  duration_ms: 0.051875
  type: 'test'
  ...
# Subtest: dedup expression selects latest per (audit_id, finding_ref), tie-break highest id
ok 1793 - dedup expression selects latest per (audit_id, finding_ref), tie-break highest id
  ---
  duration_ms: 1.812167
  type: 'test'
  ...
# Subtest: precision_strict excludes contested; zero denominator → null
ok 1794 - precision_strict excludes contested; zero denominator → null
  ---
  duration_ms: 0.56075
  type: 'test'
  ...
# Subtest: coverage_pct = triaged/fired as a one-decimal percentage
ok 1795 - coverage_pct = triaged/fired as a one-decimal percentage
  ---
  duration_ms: 1.086917
  type: 'test'
  ...
# Subtest: parseAdjudicateArgs: valid log accepted; bad decision/action/missing rationale rejected
ok 1796 - parseAdjudicateArgs: valid log accepted; bad decision/action/missing rationale rejected
  ---
  duration_ms: 0.533792
  type: 'test'
  ...
# Subtest: parseAdjudicateArgs: monitor and all five decisions accepted; list defaults + clamp
ok 1797 - parseAdjudicateArgs: monitor and all five decisions accepted; list defaults + clamp
  ---
  duration_ms: 3.861042
  type: 'test'
  ...
# Subtest: missed rows: grouped by category; null category labelled (unclassified); unjoined engine preserved
ok 1798 - missed rows: grouped by category; null category labelled (unclassified); unjoined engine preserved
  ---
  duration_ms: 1.151209
  type: 'test'
  ...
# Subtest: buildDetailSql: whitelist rejects bad scope/verdict; param slots line up
ok 1799 - buildDetailSql: whitelist rejects bad scope/verdict; param slots line up
  ---
  duration_ms: 1.044458
  type: 'test'
  ...
# Subtest: rollup SQL builders parameterize every arg (no interpolation) and count slots
ok 1800 - rollup SQL builders parameterize every arg (no interpolation) and count slots
  ---
  duration_ms: 1.08925
  type: 'test'
  ...
# Subtest: isEscalationComment + rollup n_escalations count only the marker prefix
ok 1801 - isEscalationComment + rollup n_escalations count only the marker prefix
  ---
  duration_ms: 0.257459
  type: 'test'
  ...
# Subtest: ratio/pct guard zero denominators to null and round
ok 1802 - ratio/pct guard zero denominators to null and round
  ---
  duration_ms: 0.32825
  type: 'test'
  ...
# Subtest: open_adjudications: ≥3 false+nitpick opens; defer/absent open; fix|monitor close
ok 1803 - open_adjudications: ≥3 false+nitpick opens; defer/absent open; fix|monitor close
  ---
  duration_ms: 0.401917
  type: 'test'
  ...
# Subtest: reduceLedgerList marks the newest row per cluster_key as current
ok 1804 - reduceLedgerList marks the newest row per cluster_key as current
  ---
  duration_ms: 0.091333
  type: 'test'
  ...
# Subtest: shapeDetailRow resolves the finding from finding_raw; ref_resolved + history flags
ok 1805 - shapeDetailRow resolves the finding from finding_raw; ref_resolved + history flags
  ---
  duration_ms: 0.160542
  type: 'test'
  ...
# Subtest: adjudication insert/list builders parameterize; clusterKey convention
ok 1806 - adjudication insert/list builders parameterize; clusterKey convention
  ---
  duration_ms: 0.093459
  type: 'test'
  ...
# Subtest: planTap: same-pill tap is a no-op (toggle-off removed)
ok 1807 - planTap: same-pill tap is a no-op (toggle-off removed)
  ---
  duration_ms: 2.009292
  type: 'test'
  ...
# Subtest: revertOnFail restores the previous verdict from the attempt
ok 1808 - revertOnFail restores the previous verdict from the attempt
  ---
  duration_ms: 0.112041
  type: 'test'
  ...
# Subtest: makeAttempt preserves the exact retry payload (verdict + comment)
ok 1809 - makeAttempt preserves the exact retry payload (verdict + comment)
  ---
  duration_ms: 0.088833
  type: 'test'
  ...
# Subtest: savedLabel formats "Saved HH:MM · name" in 24h IST; anon fallback
ok 1810 - savedLabel formats "Saved HH:MM · name" in 24h IST; anon fallback
  ---
  duration_ms: 0.136
  type: 'test'
  ...
# Subtest: Feature B: saved dedupes by findingRef; caps at total
ok 1811 - Feature B: saved dedupes by findingRef; caps at total
  ---
  duration_ms: 0.123209
  type: 'test'
  ...
# Subtest: Feature B: missed increments its own counter, not triaged
ok 1812 - Feature B: missed increments its own counter, not triaged
  ---
  duration_ms: 0.0595
  type: 'test'
  ...
# Subtest: Feature B: initProgress clamps seed triaged to total and de-dupes/ignores empty refs
ok 1813 - Feature B: initProgress clamps seed triaged to total and de-dupes/ignores empty refs
  ---
  duration_ms: 0.099417
  type: 'test'
  ...
# Subtest: the zero-import SHA-1 matches the standard test vector (addendum A3)
ok 1814 - the zero-import SHA-1 matches the standard test vector (addendum A3)
  ---
  duration_ms: 0.813875
  type: 'test'
  ...
# Subtest: normStableText: NFKC, lowercase, whitespace collapse, trailing punctuation/quotes stripped
ok 1815 - normStableText: NFKC, lowercase, whitespace collapse, trailing punctuation/quotes stripped
  ---
  duration_ms: 0.239833
  type: 'test'
  ...
# Subtest: stable_ref is deterministic and full 40-char lowercase hex
ok 1816 - stable_ref is deterministic and full 40-char lowercase hex
  ---
  duration_ms: 0.151667
  type: 'test'
  ...
# Subtest: A1: the SAME (signal_type, subject) on two DIFFERENT notes produces the SAME ref — by design
ok 1817 - A1: the SAME (signal_type, subject) on two DIFFERENT notes produces the SAME ref — by design
  ---
  duration_ms: 0.071625
  type: 'test'
  ...
# Subtest: stable_ref survives an engine bump: same note re-audited under two engine versions ⇒ same ref
ok 1818 - stable_ref survives an engine bump: same note re-audited under two engine versions ⇒ same ref
  ---
  duration_ms: 0.460875
  type: 'test'
  ...
# Subtest: stable_ref differs when signal_type differs, even for an identical subject
ok 1819 - stable_ref differs when signal_type differs, even for an identical subject
  ---
  duration_ms: 0.072833
  type: 'test'
  ...
# Subtest: THE ONE-FUNCTION INVARIANT: engine stamp and backfill produce byte-identical refs
ok 1820 - THE ONE-FUNCTION INVARIANT: engine stamp and backfill produce byte-identical refs
  ---
  duration_ms: 2.607125
  type: 'test'
  ...
# Subtest: null — never a hash of "" — on an empty subject or signal_type
ok 1821 - null — never a hash of "" — on an empty subject or signal_type
  ---
  duration_ms: 0.111125
  type: 'test'
  ...
# Subtest: U+0001 delimiter: a subject containing "|" cannot collide across fields
ok 1822 - U+0001 delimiter: a subject containing "|" cannot collide across fields
  ---
  duration_ms: 0.253416
  type: 'test'
  ...
# Subtest: stampFindingIdentity keeps its ORIGINAL signature and always stamps (addenda A1/A4)
ok 1823 - stampFindingIdentity keeps its ORIGINAL signature and always stamps (addenda A1/A4)
  ---
  duration_ms: 0.353334
  type: 'test'
  ...
# Subtest: finding_ref behaviour is untouched: same hash, same within-note \#2 suffixing
ok 1824 - finding_ref behaviour is untouched: same hash, same within-note \#2 suffixing
  ---
  duration_ms: 0.150542
  type: 'test'
  ...
# Subtest: resolveLabel matches by stable_ref first
ok 1825 - resolveLabel matches by stable_ref first
  ---
  duration_ms: 0.100583
  type: 'test'
  ...
# Subtest: resolveLabel falls back to finding_ref when the stable_ref is absent or dead
ok 1826 - resolveLabel falls back to finding_ref when the stable_ref is absent or dead
  ---
  duration_ms: 0.054208
  type: 'test'
  ...
# Subtest: collision ⇒ null + ambiguous:true; never a guess
ok 1827 - collision ⇒ null + ambiguous:true; never a guess
  ---
  duration_ms: 0.041167
  type: 'test'
  ...
# Subtest: A1: uid scoping picks the right finding when two notes share a stable_ref
ok 1828 - A1: uid scoping picks the right finding when two notes share a stable_ref
  ---
  duration_ms: 0.040958
  type: 'test'
  ...
# Subtest: a blank uid resolves to nothing — never an unscoped lookup (A1)
ok 1829 - a blank uid resolves to nothing — never an unscoped lookup (A1)
  ---
  duration_ms: 0.033959
  type: 'test'
  ...
# Subtest: normalizeClusterKey strips "@version" and leaves a bare key unchanged
ok 1830 - normalizeClusterKey strips "@version" and leaves a bare key unchanged
  ---
  duration_ms: 0.049459
  type: 'test'
  ...
# Subtest: F2 min_triaged excludes zero-triaged buckets while every total still reconciles
ok 1831 - F2 min_triaged excludes zero-triaged buckets while every total still reconciles
  ---
  duration_ms: 0.740125
  type: 'test'
  ...
# Subtest: F2 mode=summary respects the 20k budget and sets truncated + n_buckets_omitted
ok 1832 - F2 mode=summary respects the 20k budget and sets truncated + n_buckets_omitted
  ---
  duration_ms: 29.958542
  type: 'test'
  ...
# Subtest: F2 summary keeps the top-20 by fired AND every bucket with triaged >= 5
ok 1833 - F2 summary keeps the top-20 by fired AND every bucket with triaged >= 5
  ---
  duration_ms: 0.191542
  type: 'test'
  ...
# Subtest: F4 reviewers_current sums to totals.triaged; reviewers_all_rows keeps its own basis
ok 1834 - F4 reviewers_current sums to totals.triaged; reviewers_all_rows keeps its own basis
  ---
  duration_ms: 0.1345
  type: 'test'
  ...
# Subtest: F4 reviewers_current degrades to [] when its query fails, without breaking the rollup
ok 1835 - F4 reviewers_current degrades to [] when its query fails, without breaking the rollup
  ---
  duration_ms: 0.349417
  type: 'test'
  ...
# Subtest: open_adjudications uses the BARE signal_type and honours a normalised historical ledger key
ok 1836 - open_adjudications uses the BARE signal_type and honours a normalised historical ledger key
  ---
  duration_ms: 0.225042
  type: 'test'
  ...
# Subtest: ledger folding is newest-first-wins when several versioned keys normalise onto one
ok 1837 - ledger folding is newest-first-wins when several versioned keys normalise onto one
  ---
  duration_ms: 0.053709
  type: 'test'
  ...
# Subtest: reduceLedgerList decides currency on the NORMALISED key (normative detail 5)
ok 1838 - reduceLedgerList decides currency on the NORMALISED key (normative detail 5)
  ---
  duration_ms: 0.080708
  type: 'test'
  ...
# Subtest: ageBandOf boundaries
ok 1839 - ageBandOf boundaries
  ---
  duration_ms: 0.542542
  type: 'test'
  ...
# Subtest: stratum fallback hierarchy: band×age (n≥30) → band marginal (n≥30) → global
ok 1840 - stratum fallback hierarchy: band×age (n≥30) → band marginal (n≥30) → global
  ---
  duration_ms: 0.190542
  type: 'test'
  ...
# Subtest: age unavailable (null) collapses band×age → band marginal (reproduces the gate)
ok 1841 - age unavailable (null) collapses band×age → band marginal (reproduces the gate)
  ---
  duration_ms: 0.070291
  type: 'test'
  ...
# Subtest: O/E arithmetic: expected = Σ n·stratumMean; raw = O/n; oe = O/E
ok 1842 - O/E arithmetic: expected = Σ n·stratumMean; raw = O/n; oe = O/E
  ---
  duration_ms: 0.160708
  type: 'test'
  ...
# Subtest: zero denominator → oe null; unbanded cells excluded
ok 1843 - zero denominator → oe null; unbanded cells excluded
  ---
  duration_ms: 0.078542
  type: 'test'
  ...
# Subtest: exclusion-set filtering: excluded doctor drops from output AND from stratum means
ok 1844 - exclusion-set filtering: excluded doctor drops from output AND from stratum means
  ---
  duration_ms: 0.073584
  type: 'test'
  ...
# Subtest: funnel limits vs hand-computed
ok 1845 - funnel limits vs hand-computed
  ---
  duration_ms: 0.376833
  type: 'test'
  ...
# Subtest: funnelCurve dedupes+sorts n; funnelPosition classifies vs limits + building
ok 1846 - funnelCurve dedupes+sorts n; funnelPosition classifies vs limits + building
  ---
  duration_ms: 0.131583
  type: 'test'
  ...
# Subtest: reference format + parse round-trips and validates
ok 1847 - reference format + parse round-trips and validates
  ---
  duration_ms: 1.722167
  type: 'test'
  ...
# Subtest: SLA only when a timely response is owed; privilege-review escalates on mint
ok 1848 - SLA only when a timely response is owed; privilege-review escalates on mint
  ---
  duration_ms: 1.223167
  type: 'test'
  ...
# Subtest: isOverdue: only a routed, past-SLA, response-owed signal is overdue
ok 1849 - isOverdue: only a routed, past-SLA, response-owed signal is overdue
  ---
  duration_ms: 0.185583
  type: 'test'
  ...
# Subtest: status machine: response + action transitions
ok 1850 - status machine: response + action transitions
  ---
  duration_ms: 0.148875
  type: 'test'
  ...
# Subtest: validateDoctorResponse: type must match; explanation needs comment+verdict; guards
ok 1851 - validateDoctorResponse: type must match; explanation needs comment+verdict; guards
  ---
  duration_ms: 0.360083
  type: 'test'
  ...
# Subtest: validateSignalAction: enum guard + normalize
ok 1852 - validateSignalAction: enum guard + normalize
  ---
  duration_ms: 0.197583
  type: 'test'
  ...
# Subtest: signalObject: shape + overdue + label; no patient fields
ok 1853 - signalObject: shape + overdue + label; no patient fields
  ---
  duration_ms: 0.377083
  type: 'test'
  ...
# Subtest: healthy attribute produces no signal
ok 1854 - healthy attribute produces no signal
  ---
  duration_ms: 0.616041
  type: 'test'
  ...
# Subtest: act_now severity below 2.5, watch below 3.5
ok 1855 - act_now severity below 2.5, watch below 3.5
  ---
  duration_ms: 0.218708
  type: 'test'
  ...
# Subtest: trend computed vs prior window with ±0.3 threshold
ok 1856 - trend computed vs prior window with ±0.3 threshold
  ---
  duration_ms: 0.084917
  type: 'test'
  ...
# Subtest: no baseline ⇒ no_baseline trend
ok 1857 - no baseline ⇒ no_baseline trend
  ---
  duration_ms: 0.049666
  type: 'test'
  ...
# Subtest: systemic scope when most eligible doctors are affected — hospital-level action
ok 1858 - systemic scope when most eligible doctors are affected — hospital-level action
  ---
  duration_ms: 0.189792
  type: 'test'
  ...
# Subtest: concentrated scope names the affected doctors, worst first
ok 1859 - concentrated scope names the affected doctors, worst first
  ---
  duration_ms: 0.103167
  type: 'test'
  ...
# Subtest: mixed scope appends the lowest-scoring doctors to the systemic action
ok 1860 - mixed scope appends the lowest-scoring doctors to the systemic action
  ---
  duration_ms: 0.158375
  type: 'test'
  ...
# Subtest: insufficient eligible doctors falls back to systemic wording
ok 1861 - insufficient eligible doctors falls back to systemic wording
  ---
  duration_ms: 0.056125
  type: 'test'
  ...
# Subtest: doctors below doctorMinNotes are not eligible
ok 1862 - doctors below doctorMinNotes are not eligible
  ---
  duration_ms: 0.204667
  type: 'test'
  ...
# Subtest: ranking: act_now before watch, then mean ascending; healthy sorted best-first
ok 1863 - ranking: act_now before watch, then mean ascending; healthy sorted best-first
  ---
  duration_ms: 0.634125
  type: 'test'
  ...
# Subtest: thresholds are overridable
ok 1864 - thresholds are overridable
  ---
  duration_ms: 0.06525
  type: 'test'
  ...
# Subtest: lower_worse severity: completeness 74 act_now, 88 watch, 96 healthy
ok 1865 - lower_worse severity: completeness 74 act_now, 88 watch, 96 healthy
  ---
  duration_ms: 0.746583
  type: 'test'
  ...
# Subtest: higher_worse severity: interactions 25/100 act_now, 12 watch, 8 healthy
ok 1866 - higher_worse severity: interactions 25/100 act_now, 12 watch, 8 healthy
  ---
  duration_ms: 0.091625
  type: 'test'
  ...
# Subtest: direction-aware trend: rising interactions = worsening, rising completeness = improving
ok 1867 - direction-aware trend: rising interactions = worsening, rising completeness = improving
  ---
  duration_ms: 0.06775
  type: 'test'
  ...
# Subtest: scope: systemic when most doctors low; concentrated names them worst-first (higher_worse)
ok 1868 - scope: systemic when most doctors low; concentrated names them worst-first (higher_worse)
  ---
  duration_ms: 0.166958
  type: 'test'
  ...
# Subtest: placeholders substituted; fallbacks when absent
ok 1869 - placeholders substituted; fallbacks when absent
  ---
  duration_ms: 0.179334
  type: 'test'
  ...
# Subtest: low_value_rate is HELD by default; included with includeHeld + confidence estimate
ok 1870 - low_value_rate is HELD by default; included with includeHeld + confidence estimate
  ---
  duration_ms: 0.062
  type: 'test'
  ...
# Subtest: kind discriminator and unit present on every domain signal
ok 1871 - kind discriminator and unit present on every domain signal
  ---
  duration_ms: 0.095083
  type: 'test'
  ...
# Subtest: mixed scope appends most-affected list to systemic action
ok 1872 - mixed scope appends most-affected list to systemic action
  ---
  duration_ms: 0.078625
  type: 'test'
  ...
# Subtest: bandFor and its thresholds are BYTE-IDENTICAL — hysteresis wraps, never replaces
ok 1873 - bandFor and its thresholds are BYTE-IDENTICAL — hysteresis wraps, never replaces
  ---
  duration_ms: 0.532375
  type: 'test'
  ...
# Subtest: NULL prior (first score at this version) ⇒ bandFor(index) — the anchor is set normally
ok 1874 - NULL prior (first score at this version) ⇒ bandFor(index) — the anchor is set normally
  ---
  duration_ms: 0.145
  type: 'test'
  ...
# Subtest: THE TABLE (g = 3.87): each held band leaves exactly at its ± g edges
ok 1875 - THE TABLE (g = 3.87): each held band leaves exactly at its ± g edges
  ---
  duration_ms: 0.0725
  type: 'test'
  ...
# Subtest: a decisive crossing lands on bandFor(index), even across MULTIPLE bands
ok 1876 - a decisive crossing lands on bandFor(index), even across MULTIPLE bands
  ---
  duration_ms: 0.038583
  type: 'test'
  ...
# Subtest: THE POINT: a threshold-proximity wobble no longer flips the displayed band
ok 1877 - THE POINT: a threshold-proximity wobble no longer flips the displayed band
  ---
  duration_ms: 0.056667
  type: 'test'
  ...
# Subtest: the SQL CASE mirrors the pure function EXACTLY, built from the same HYSTERESIS_G
ok 1878 - the SQL CASE mirrors the pure function EXACTLY, built from the same HYSTERESIS_G
  ---
  duration_ms: 0.138666
  type: 'test'
  ...
# Subtest: all three write paths set displayed_band: insert anchor, conflict CASE, update CASE
ok 1879 - all three write paths set displayed_band: insert anchor, conflict CASE, update CASE
  ---
  duration_ms: 0.1025
  type: 'test'
  ...
# Subtest: deploy-before-migrate tolerance on BOTH writers and readers — 0029 not yet run ⇒ raw band, never a blank page
ok 1880 - deploy-before-migrate tolerance on BOTH writers and readers — 0029 not yet run ⇒ raw band, never a blank page
  ---
  duration_ms: 0.343833
  type: 'test'
  ...
# Subtest: every per-note band display renders displayed_band with the raw-band fallback
ok 1881 - every per-note band display renders displayed_band with the raw-band fallback
  ---
  duration_ms: 1.62525
  type: 'test'
  ...
# Subtest: migration 0029 is exactly one additive, idempotent statement
ok 1882 - migration 0029 is exactly one additive, idempotent statement
  ---
  duration_ms: 0.450584
  type: 'test'
  ...
# Subtest: engine version is current AND the read family includes it (the classic error, not repeated)
ok 1883 - engine version is current AND the read family includes it (the classic error, not repeated)
  ---
  duration_ms: 0.058958
  type: 'test'
  ...
# Subtest: S0 behaviour and worker dedup are UNTOUCHED by S1
ok 1884 - S0 behaviour and worker dedup are UNTOUCHED by S1
  ---
  duration_ms: 0.2685
  type: 'test'
  ...
# Subtest: the lab eval path knows nothing of hysteresis or displayed_band
ok 1885 - the lab eval path knows nothing of hysteresis or displayed_band
  ---
  duration_ms: 0.252333
  type: 'test'
  ...
# Subtest: precedence: explicit consult_type regex wins over everything
ok 1886 - precedence: explicit consult_type regex wins over everything
  ---
  duration_ms: 1.255959
  type: 'test'
  ...
# Subtest: consult_types markers: VISITING_HOSPITAL / EMERGENCY → in-person, and WIN over CHAT
ok 1887 - consult_types markers: VISITING_HOSPITAL / EMERGENCY → in-person, and WIN over CHAT
  ---
  duration_ms: 0.244584
  type: 'test'
  ...
# Subtest: consult_types markers: CHAT → tele (when no in-person marker); HOSPITAL_* + CHAT = tele
ok 1888 - consult_types markers: CHAT → tele (when no in-person marker); HOSPITAL_* + CHAT = tele
  ---
  duration_ms: 0.116708
  type: 'test'
  ...
# Subtest: fallback: form-type default when no markers (GENERAL_PRACTITIONER → tele; HOSPITAL_* → in-person)
ok 1889 - fallback: form-type default when no markers (GENERAL_PRACTITIONER → tele; HOSPITAL_* → in-person)
  ---
  duration_ms: 0.227333
  type: 'test'
  ...
# Subtest: hands-on-exam downgrade still applies AFTER classification (unchanged)
ok 1890 - hands-on-exam downgrade still applies AFTER classification (unchanged)
  ---
  duration_ms: 0.467958
  type: 'test'
  ...
# Subtest: formatEncounterChip: channel first, form second
ok 1891 - formatEncounterChip: channel first, form second
  ---
  duration_ms: 0.085541
  type: 'test'
  ...
# Subtest: parseConsultTypes: JS array / JSON string / PG array literal / empty → clean string[]
ok 1892 - parseConsultTypes: JS array / JSON string / PG array literal / empty → clean string[]
  ---
  duration_ms: 0.523166
  type: 'test'
  ...
# Subtest: currentVisitNote: prefers show_in_prescription; falls back to latest non-carried date_of_visit
ok 1893 - currentVisitNote: prefers show_in_prescription; falls back to latest non-carried date_of_visit
  ---
  duration_ms: 8.251584
  type: 'test'
  ...
# Subtest: parseTrimester: numeric / worded / derived-from-GA-weeks; null when unparseable
ok 1894 - parseTrimester: numeric / worded / derived-from-GA-weeks; null when unparseable
  ---
  duration_ms: 2.722458
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: llmLegFailedAfterParse: failed when the parse produced nothing PDQI-9-usable
ok 1895 - llmLegFailedAfterParse: failed when the parse produced nothing PDQI-9-usable
  ---
  duration_ms: 0.558291
  type: 'test'
  ...
# Subtest: the predicate is DELIBERATELY weaker than the lab guard — partial PDQI-9 passes in production
ok 1896 - the predicate is DELIBERATELY weaker than the lab guard — partial PDQI-9 passes in production
  ---
  duration_ms: 0.071459
  type: 'test'
  ...
# Subtest: exactly ONE bounded retry, gated on !opts.evalModel, whether the leg THREW or parsed to nothing
ok 1897 - exactly ONE bounded retry, gated on !opts.evalModel, whether the leg THREW or parsed to nothing
  ---
  duration_ms: 0.194291
  type: 'test'
  ...
# Subtest: a worse retry never replaces a partial first attempt
ok 1898 - a worse retry never replaces a partial first attempt
  ---
  duration_ms: 0.0545
  type: 'test'
  ...
# Subtest: the signal can NEVER be set on the eval path — lab rows must not carry production marks
ok 1899 - the signal can NEVER be set on the eval path — lab rows must not carry production marks
  ---
  duration_ms: 0.054667
  type: 'test'
  ...
# Subtest: the det-only fallback is marked UNCONDITIONALLY — every fallback row is a failed measurement
ok 1900 - the det-only fallback is marked UNCONDITIONALLY — every fallback row is a failed measurement
  ---
  duration_ms: 0.07625
  type: 'test'
  ...
# Subtest: the eval-path parse guards are UNCHANGED — d08bba7 is not the pattern here, but it still stands
ok 1901 - the eval-path parse guards are UNCHANGED — d08bba7 is not the pattern here, but it still stands
  ---
  duration_ms: 0.118666
  type: 'test'
  ...
# Subtest: saveOpdAudit writes the mark only when signal AND stored pdqi9 are both empty
ok 1902 - saveOpdAudit writes the mark only when signal AND stored pdqi9 are both empty
  ---
  duration_ms: 0.0505
  type: 'test'
  ...
# Subtest: a successful re-audit CLEARS a stale mark; house_account is preserved verbatim — both paths
ok 1903 - a successful re-audit CLEARS a stale mark; house_account is preserved verbatim — both paths
  ---
  duration_ms: 0.206459
  type: 'test'
  ...
# Subtest: D6 — the trap survives in its NARROWED form: only an incident makes a note re-auditable
ok 1904 - D6 — the trap survives in its NARROWED form: only an incident makes a note re-auditable
  ---
  duration_ms: 0.405209
  type: 'test'
  ...
# Subtest: addendum F v2 task 2 — a failed row never blocks a retry, a successful row is never overwritten
ok 1905 - addendum F v2 task 2 — a failed row never blocks a retry, a successful row is never overwritten
  ---
  duration_ms: 0.125042
  type: 'test'
  ...
# Subtest: the canonical id set still excludes marked rows — the mark IS the aggregate exclusion
ok 1906 - the canonical id set still excludes marked rows — the mark IS the aggregate exclusion
  ---
  duration_ms: 0.03525
  type: 'test'
  ...
# Subtest: EVERY enumerated aggregate/display reader excludes marked rows
ok 1907 - EVERY enumerated aggregate/display reader excludes marked rows
  ---
  duration_ms: 0.758708
  type: 'test'
  ...
# Subtest: the detail page suppresses the score and says exactly "Not assessed at this engine version"
ok 1908 - the detail page suppresses the score and says exactly "Not assessed at this engine version"
  ---
  duration_ms: 0.122167
  type: 'test'
  ...
# Subtest: the escalation package never hands a failed measurement to an external reviewer
ok 1909 - the escalation package never hands a failed measurement to an external reviewer
  ---
  duration_ms: 0.030875
  type: 'test'
  ...
# Subtest: the backfill predicate is the §5 / S0-gate predicate VERBATIM
ok 1910 - the backfill predicate is the §5 / S0-gate predicate VERBATIM
  ---
  duration_ms: 0.027708
  type: 'test'
  ...
# Subtest: DRY-RUN BY DEFAULT: the write happens only under ?apply=1, and the delta is always reported
ok 1911 - DRY-RUN BY DEFAULT: the write happens only under ?apply=1, and the delta is always reported
  ---
  duration_ms: 0.105667
  type: 'test'
  ...
# Subtest: opd-note-score-core.ts knows nothing of any of this — no scoring change, no engine bump
ok 1912 - opd-note-score-core.ts knows nothing of any of this — no scoring change, no engine bump
  ---
  duration_ms: 0.082458
  type: 'test'
  ...
# Subtest: parseOpdAnalysis is untouched — the guard sits at the call site, production keeps the leniency
ok 1913 - parseOpdAnalysis is untouched — the guard sits at the call site, production keeps the leniency
  ---
  duration_ms: 0.064542
  type: 'test'
  ...
# Subtest: the lab batch path knows nothing of llmLegFailed
ok 1914 - the lab batch path knows nothing of llmLegFailed
  ---
  duration_ms: 0.207875
  type: 'test'
  ...
# Subtest: L1: TSH re-ordered within 42-day interval → one repeat_test finding citing the prior value
ok 1915 - L1: TSH re-ordered within 42-day interval → one repeat_test finding citing the prior value
  ---
  duration_ms: 0.95425
  type: 'test'
  ...
# Subtest: L1: HbA1c prior is OUTSIDE its 90-day interval → no finding
ok 1916 - L1: HbA1c prior is OUTSIDE its 90-day interval → no finding
  ---
  duration_ms: 0.100875
  type: 'test'
  ...
# Subtest: L1: an unmatched analyte (CBC — no canonical id) yields NO finding
ok 1917 - L1: an unmatched analyte (CBC — no canonical id) yields NO finding
  ---
  duration_ms: 0.186
  type: 'test'
  ...
# Subtest: L1: analyte normalization matches note ↔ state (Vitamin D synonym within 90d)
ok 1918 - L1: analyte normalization matches note ↔ state (Vitamin D synonym within 90d)
  ---
  duration_ms: 0.088708
  type: 'test'
  ...
# Subtest: L1: the retest table keys on canonical analyte ids (house defaults)
ok 1919 - L1: the retest table keys on canonical analyte ids (house defaults)
  ---
  duration_ms: 0.050084
  type: 'test'
  ...
# Subtest: L2: re-prescription of a patient-reported-stopped drug → med_reconciliation citing the stop
ok 1920 - L2: re-prescription of a patient-reported-stopped drug → med_reconciliation citing the stop
  ---
  duration_ms: 0.219875
  type: 'test'
  ...
# Subtest: L2: continuation of an active prior prescription → med_reconciliation (duplicate continuation)
ok 1921 - L2: continuation of an active prior prescription → med_reconciliation (duplicate continuation)
  ---
  duration_ms: 0.075375
  type: 'test'
  ...
# Subtest: L2: no false match — a drug not in the prior state produces nothing
ok 1922 - L2: no false match — a drug not in the prior state produces nothing
  ---
  duration_ms: 0.105292
  type: 'test'
  ...
# Subtest: L2: both cases fire together for a mixed note
ok 1923 - L2: both cases fire together for a mixed note
  ---
  duration_ms: 0.232834
  type: 'test'
  ...
# Subtest: L3-det: a severe open care gap not re-ordered / not mentioned → missed_followup
ok 1924 - L3-det: a severe open care gap not re-ordered / not mentioned → missed_followup
  ---
  duration_ms: 1.573625
  type: 'test'
  ...
# Subtest: L3-det: ORDERING the analyte in the note suppresses the finding (addressed)
ok 1925 - L3-det: ORDERING the analyte in the note suppresses the finding (addressed)
  ---
  duration_ms: 0.408167
  type: 'test'
  ...
# Subtest: L3-det: MENTIONING the analyte in the impression suppresses the finding
ok 1926 - L3-det: MENTIONING the analyte in the impression suppresses the finding
  ---
  duration_ms: 0.260625
  type: 'test'
  ...
# Subtest: battery: the full deterministic pass yields L1 + L2×2 + L3 on the fixture
ok 1927 - battery: the full deterministic pass yields L1 + L2×2 + L3 on the fixture
  ---
  duration_ms: 0.297833
  type: 'test'
  ...
# Subtest: serializer: emits the priority-ordered sections and stays under the char budget
ok 1928 - serializer: emits the priority-ordered sections and stays under the char budget
  ---
  duration_ms: 0.553958
  type: 'test'
  ...
# Subtest: serializer: validMonths grounds only real encounter months
ok 1929 - serializer: validMonths grounds only real encounter months
  ---
  duration_ms: 0.135625
  type: 'test'
  ...
# Subtest: serializer: truncates tail-first when over budget (header survives, last section dropped)
ok 1930 - serializer: truncates tail-first when over budget (header survives, last section dropped)
  ---
  duration_ms: 0.506208
  type: 'test'
  ...
# Subtest: serializer: de-identified — no uid / member identifier can leak (serializer takes none)
ok 1931 - serializer: de-identified — no uid / member identifier can leak (serializer takes none)
  ---
  duration_ms: 0.120625
  type: 'test'
  ...
# Subtest: buildLongitudinalUser: notes the teleconsult fairness guard in the payload
ok 1932 - buildLongitudinalUser: notes the teleconsult fairness guard in the payload
  ---
  duration_ms: 0.226375
  type: 'test'
  ...
# Subtest: LLM parse: a grounded finding is kept and mapped to the right signal type
ok 1933 - LLM parse: a grounded finding is kept and mapped to the right signal type
  ---
  duration_ms: 0.238833
  type: 'test'
  ...
# Subtest: LLM parse: an UNGROUNDED finding (cited date not in context) is dropped (no hindsight)
ok 1934 - LLM parse: an UNGROUNDED finding (cited date not in context) is dropped (no hindsight)
  ---
  duration_ms: 0.106292
  type: 'test'
  ...
# Subtest: LLM parse: continuity is the default type; malformed JSON → []
ok 1935 - LLM parse: continuity is the default type; malformed JSON → []
  ---
  duration_ms: 0.353708
  type: 'test'
  ...
# Subtest: stampLongitudinal: assigns a finding_ref but PRESERVES the explicit longitudinal signal_type
ok 1936 - stampLongitudinal: assigns a finding_ref but PRESERVES the explicit longitudinal signal_type
  ---
  duration_ms: 1.494542
  type: 'test'
  ...
# Subtest: suppression pass-through: an active suppression drops a longitudinal type like any finding
ok 1937 - suppression pass-through: an active suppression drops a longitudinal type like any finding
  ---
  duration_ms: 0.458375
  type: 'test'
  ...
# Subtest: confidenceFor: 0 → none, 1-2 → thin, ≥3 → established
ok 1938 - confidenceFor: 0 → none, 1-2 → thin, ≥3 → established
  ---
  duration_ms: 0.038875
  type: 'test'
  ...
# Subtest: emptyLongitudinalBlock: carries the honest excluded_reason and zero findings
ok 1939 - emptyLongitudinalBlock: carries the honest excluded_reason and zero findings
  ---
  duration_ms: 0.047917
  type: 'test'
  ...
# Subtest: buildLongitudinalInput: null without uid/date; a clean projection that never mutates the case
ok 1940 - buildLongitudinalInput: null without uid/date; a clean projection that never mutates the case
  ---
  duration_ms: 0.111041
  type: 'test'
  ...
# Subtest: zero-drift: the battery + serializer + stamp never mutate the snapshot or note input
ok 1941 - zero-drift: the battery + serializer + stamp never mutate the snapshot or note input
  ---
  duration_ms: 0.474083
  type: 'test'
  ...
# Subtest: buildLongitudinalGates seeds all 5 longitudinal types at 0/0
ok 1942 - buildLongitudinalGates seeds all 5 longitudinal types at 0/0
  ---
  duration_ms: 0.732459
  type: 'test'
  ...
# Subtest: overlays signal-health decided → labelled and fp_rate → fpRate for longitudinal types
ok 1943 - overlays signal-health decided → labelled and fp_rate → fpRate for longitudinal types
  ---
  duration_ms: 0.130833
  type: 'test'
  ...
# Subtest: ignores non-longitudinal (routable) signal types from signal-health
ok 1944 - ignores non-longitudinal (routable) signal types from signal-health
  ---
  duration_ms: 0.104917
  type: 'test'
  ...
# Subtest: clamps out-of-range / non-finite fp_rate and negative decided
ok 1945 - clamps out-of-range / non-finite fp_rate and negative decided
  ---
  duration_ms: 0.114167
  type: 'test'
  ...
# Subtest: gates feed buildLabelLane → promotion status matches promotionGate directly
ok 1946 - gates feed buildLabelLane → promotion status matches promotionGate directly
  ---
  duration_ms: 0.260417
  type: 'test'
  ...
# Subtest: lane only contains non-routable longitudinal types (routable dropped)
ok 1947 - lane only contains non-routable longitudinal types (routable dropped)
  ---
  duration_ms: 0.072042
  type: 'test'
  ...
# Subtest: classifyLvcCategory: antibiotic | imaging | supplement | other
ok 1948 - classifyLvcCategory: antibiotic | imaging | supplement | other
  ---
  duration_ms: 3.169292
  type: 'test'
  ...
# Subtest: stampLvcMetadata: low-value findings get rule_ref:null + lvc_category; others untouched; score fields preserved
ok 1949 - stampLvcMetadata: low-value findings get rule_ref:null + lvc_category; others untouched; score fields preserved
  ---
  duration_ms: 0.172083
  type: 'test'
  ...
# Subtest: stampLvcMetadata preserves an existing rule_ref
ok 1950 - stampLvcMetadata preserves an existing rule_ref
  ---
  duration_ms: 0.056541
  type: 'test'
  ...
# Subtest: classifyLvcFinding: verdict tier authoritative; non-low-value / informational are not LVC
ok 1951 - classifyLvcFinding: verdict tier authoritative; non-low-value / informational are not LVC
  ---
  duration_ms: 0.104625
  type: 'test'
  ...
# Subtest: classifyLvcFinding: stamped row passes its metadata through
ok 1952 - classifyLvcFinding: stamped row passes its metadata through
  ---
  duration_ms: 0.37675
  type: 'test'
  ...
# Subtest: classifyLvcFinding: fallback text-match to a rule (older engine, no stamp)
ok 1953 - classifyLvcFinding: fallback text-match to a rule (older engine, no stamp)
  ---
  duration_ms: 0.360541
  type: 'test'
  ...
# Subtest: precision gate: suppress via ledger decision on lvc:<rule_ref>; default keeps all
ok 1954 - precision gate: suppress via ledger decision on lvc:<rule_ref>; default keeps all
  ---
  duration_ms: 0.104625
  type: 'test'
  ...
# Subtest: LVC_CATEGORIES vocabulary — 3 base + 8 overuse sub-tags + other (0.81.8 Part B)
ok 1955 - LVC_CATEGORIES vocabulary — 3 base + 8 overuse sub-tags + other (0.81.8 Part B)
  ---
  duration_ms: 0.097792
  type: 'test'
  ...
# Subtest: matcher v3: OR across keywords — alternative trigger phrases (the CW-rule fix)
ok 1956 - matcher v3: OR across keywords — alternative trigger phrases (the CW-rule fix)
  ---
  duration_ms: 0.299792
  type: 'test'
  ...
# Subtest: matcher v3: AND within a keyword — every token must be a whole word
ok 1957 - matcher v3: AND within a keyword — every token must be a whole word
  ---
  duration_ms: 0.343208
  type: 'test'
  ...
# Subtest: matcher v3.1: longest matched phrase wins when it wins alone; any top-specificity tie → null
ok 1958 - matcher v3.1: longest matched phrase wins when it wins alone; any top-specificity tie → null
  ---
  duration_ms: 0.280375
  type: 'test'
  ...
# Subtest: matcher v3: bare 1-token keyword over-matches under OR (why CBP is re-authored in data, 26a)
ok 1959 - matcher v3: bare 1-token keyword over-matches under OR (why CBP is re-authored in data, 26a)
  ---
  duration_ms: 0.119833
  type: 'test'
  ...
# Subtest: matcher v3: zero-keyword / empty-token rules never match; category from matched rule
ok 1960 - matcher v3: zero-keyword / empty-token rules never match; category from matched rule
  ---
  duration_ms: 0.066292
  type: 'test'
  ...
# Subtest: stampLvcMetadata: no rules → rule_ref null; non-low-value + informational skipped; scores untouched
ok 1961 - stampLvcMetadata: no rules → rule_ref null; non-low-value + informational skipped; scores untouched
  ---
  duration_ms: 0.067334
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: no normative hits ⇒ assembleAuditContext is byte-identical to today's assembly
ok 1962 - no normative hits ⇒ assembleAuditContext is byte-identical to today's assembly
  ---
  duration_ms: 1.262709
  type: 'test'
  ...
# Subtest: channel mode: the literature retrieve opts are unchanged — useNormativeLeg is NOT set
ok 1963 - channel mode: the literature retrieve opts are unchanged — useNormativeLeg is NOT set
  ---
  duration_ms: 0.218541
  type: 'test'
  ...
# Subtest: normativeChannelOpts: standalone CW-only search — restrictSources, topK 4, leg NOT set
ok 1964 - normativeChannelOpts: standalone CW-only search — restrictSources, topK 4, leg NOT set
  ---
  duration_ms: 0.158083
  type: 'test'
  ...
# Subtest: channel context: literature [1-8] then the labelled normative block [9+]
ok 1965 - channel context: literature [1-8] then the labelled normative block [9+]
  ---
  duration_ms: 0.119834
  type: 'test'
  ...
# Subtest: numbering adapts when fewer than 8 literature excerpts return
ok 1966 - numbering adapts when fewer than 8 literature excerpts return
  ---
  duration_ms: 0.119125
  type: 'test'
  ...
# Subtest: buildNormativeBlock: empty hits ⇒ empty string (audit proceeds on literature alone)
ok 1967 - buildNormativeBlock: empty hits ⇒ empty string (audit proceeds on literature alone)
  ---
  duration_ms: 0.039959
  type: 'test'
  ...
# Subtest: evalNormativeChannel is independent of evalNormativeLeg — no union, no eviction
ok 1968 - evalNormativeChannel is independent of evalNormativeLeg — no union, no eviction
  ---
  duration_ms: 0.154
  type: 'test'
  ...
# Subtest: the eval path still writes lab_analyses only — never opd_note_audits
ok 1969 - the eval path still writes lab_analyses only — never opd_note_audits
  ---
  duration_ms: 0.279625
  type: 'test'
  ...
# Subtest: OPD_AUDIT_SYSTEM is untouched — the channel header is not injected into the system prompt
ok 1970 - OPD_AUDIT_SYSTEM is untouched — the channel header is not injected into the system prompt
  ---
  duration_ms: 0.368666
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: flag off ⇒ opts byte-identical to today (no useNormativeLeg key)
ok 1971 - flag off ⇒ opts byte-identical to today (no useNormativeLeg key)
  ---
  duration_ms: 0.847083
  type: 'test'
  ...
# Subtest: flag on + non-mini ⇒ useNormativeLeg: true
ok 1972 - flag on + non-mini ⇒ useNormativeLeg: true
  ---
  duration_ms: 0.095625
  type: 'test'
  ...
# Subtest: flag on + mini ⇒ no useNormativeLeg key (mini path can never enable the leg)
ok 1973 - flag on + mini ⇒ no useNormativeLeg key (mini path can never enable the leg)
  ---
  duration_ms: 42.905
  type: 'test'
  ...
# Subtest: only OPD_NORMATIVE_LEG_ENABLED === "1" enables the leg
ok 1974 - only OPD_NORMATIVE_LEG_ENABLED === "1" enables the leg
  ---
  duration_ms: 0.241
  type: 'test'
  ...
# Subtest: rowToOpdCase parses stringified JSONB + separates de-identified case from keys
ok 1975 - rowToOpdCase parses stringified JSONB + separates de-identified case from keys
  ---
  duration_ms: 1.459417
  type: 'test'
  ...
# Subtest: rowToOpdCase reads the NESTED GP fields (the extraction fix)
ok 1976 - rowToOpdCase reads the NESTED GP fields (the extraction fix)
  ---
  duration_ms: 0.903042
  type: 'test'
  ...
# Subtest: rowToOpdCase prefers the dpipe pipeline content over the nested source fields
ok 1977 - rowToOpdCase prefers the dpipe pipeline content over the nested source fields
  ---
  duration_ms: 0.154459
  type: 'test'
  ...
# Subtest: 0.6: referral handoff — leaflet excluded, referral + teleconsult surfaced
ok 1978 - 0.6: referral handoff — leaflet excluded, referral + teleconsult surfaced
  ---
  duration_ms: 0.319166
  type: 'test'
  ...
# Subtest: 0.6: teleconsult completeness — examination is not scored (N/A), referral counts as the plan
ok 1979 - 0.6: teleconsult completeness — examination is not scored (N/A), referral counts as the plan
  ---
  duration_ms: 0.456208
  type: 'test'
  ...
# Subtest: opdCompleteness flags the real gaps; allergy + history items removed
ok 1980 - opdCompleteness flags the real gaps; allergy + history items removed
  ---
  duration_ms: 0.670375
  type: 'test'
  ...
# Subtest: route inference: documented → used; blank → inferred from form; no form → null (real gap)
ok 1981 - route inference: documented → used; blank → inferred from form; no form → null (real gap)
  ---
  duration_ms: 0.434958
  type: 'test'
  ...
# Subtest: dose documented from the field, the strength field, or the strength embedded in the drug name
ok 1982 - dose documented from the field, the strength field, or the strength embedded in the drug name
  ---
  duration_ms: 0.510583
  type: 'test'
  ...
# Subtest: prescribingChecks: dosing gap only when route is truly ambiguous / amount is absent (0.5)
ok 1983 - prescribingChecks: dosing gap only when route is truly ambiguous / amount is absent (0.5)
  ---
  duration_ms: 0.811125
  type: 'test'
  ...
# Subtest: prescribingChecks: unverified brand, duplicate by RESOLVED generic, high-alert info (v0.4)
ok 1984 - prescribingChecks: unverified brand, duplicate by RESOLVED generic, high-alert info (v0.4)
  ---
  duration_ms: 0.579916
  type: 'test'
  ...
# Subtest: parseOpdAnalysis extracts findings + PDQI-9 + suggestions and clamps citations
ok 1985 - parseOpdAnalysis extracts findings + PDQI-9 + suggestions and clamps citations
  ---
  duration_ms: 0.281
  type: 'test'
  ...
# Subtest: C1: parseOpdAnalysis strips a reasoning <think> block (DeepSeek-R1) before parsing
ok 1986 - C1: parseOpdAnalysis strips a reasoning <think> block (DeepSeek-R1) before parsing
  ---
  duration_ms: 0.094834
  type: 'test'
  ...
# Subtest: opdSignalType maps every deterministic subject shape to the controlled vocab
ok 1987 - opdSignalType maps every deterministic subject shape to the controlled vocab
  ---
  duration_ms: 0.453959
  type: 'test'
  ...
# Subtest: opdSignalType: LLM subjects — antibiotic rule, coarse domain×verdict buckets, general fallback
ok 1988 - opdSignalType: LLM subjects — antibiotic rule, coarse domain×verdict buckets, general fallback
  ---
  duration_ms: 0.433084
  type: 'test'
  ...
# Subtest: stampFindingIdentity: stable refs, severity-change stable, distinct details distinct
ok 1989 - stampFindingIdentity: stable refs, severity-change stable, distinct details distinct
  ---
  duration_ms: 0.751292
  type: 'test'
  ...
# Subtest: 0.81.11: form/dosageForm are inert — prescribingChecks output is byte-identical with them present vs absent
ok 1990 - 0.81.11: form/dosageForm are inert — prescribingChecks output is byte-identical with them present vs absent
  ---
  duration_ms: 0.45575
  type: 'test'
  ...
# Subtest: 0.81.12 CANARY: guideline-recommended vaccine co-administration produces NO finding (LASA deleted)
ok 1991 - 0.81.12 CANARY: guideline-recommended vaccine co-administration produces NO finding (LASA deleted)
  ---
  duration_ms: 0.111791
  type: 'test'
  ...
# Subtest: 0.81.12 (Stage 2a): the SCORING molecule-subset dedup is NOT present — a mono+FDC produces no new penalty
ok 1992 - 0.81.12 (Stage 2a): the SCORING molecule-subset dedup is NOT present — a mono+FDC produces no new penalty
  ---
  duration_ms: 0.096083
  type: 'test'
  ...
# Subtest: 0.81.10: a low-value deterministic finding RETAINS its specific signal_type (no collapse to low_value_care)
ok 1993 - 0.81.10: a low-value deterministic finding RETAINS its specific signal_type (no collapse to low_value_care)
  ---
  duration_ms: 0.315083
  type: 'test'
  ...
# Subtest: 0.81.10: the muscle-relaxant documentation subject maps to signal_type muscle_relaxant_indication
ok 1994 - 0.81.10: the muscle-relaxant documentation subject maps to signal_type muscle_relaxant_indication
  ---
  duration_ms: 0.038834
  type: 'test'
  ...
# Subtest: stampFindingIdentity: within-note collision suffixes \#2, \#3 deterministically
ok 1995 - stampFindingIdentity: within-note collision suffixes \#2, \#3 deterministically
  ---
  duration_ms: 0.141458
  type: 'test'
  ...
# Subtest: stampFindingIdentity: every finding stamped non-empty (acceptance, spec §2)
ok 1996 - stampFindingIdentity: every finding stamped non-empty (acceptance, spec §2)
  ---
  duration_ms: 0.154042
  type: 'test'
  ...
# Subtest: opdCaseText includes the treating specialty line when provided (B4)
ok 1997 - opdCaseText includes the treating specialty line when provided (B4)
  ---
  duration_ms: 0.363625
  type: 'test'
  ...
# Subtest: followUpDocumented + completeness: UNKNOWN/blank excluded, real dispositions count (B2)
ok 1998 - followUpDocumented + completeness: UNKNOWN/blank excluded, real dispositions count (B2)
  ---
  duration_ms: 0.350125
  type: 'test'
  ...
# Subtest: completeness coverage excludes continuity fields — scored once (0.8)
ok 1999 - completeness coverage excludes continuity fields — scored once (0.8)
  ---
  duration_ms: 0.176708
  type: 'test'
  ...
# Subtest: opdCaseText marks a zero-medication note explicitly (B1)
ok 2000 - opdCaseText marks a zero-medication note explicitly (B1)
  ---
  duration_ms: 0.070375
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-04: HOSPITAL_* prescription types are IN-PERSON, not teleconsult
ok 2001 - v0.81 BUG-0.8-04: HOSPITAL_* prescription types are IN-PERSON, not teleconsult
  ---
  duration_ms: 0.041334
  type: 'test'
  ...
# Subtest: v0.81 FIX I: a documented hands-on exam downgrades a teleconsult classification
ok 2002 - v0.81 FIX I: a documented hands-on exam downgrades a teleconsult classification
  ---
  duration_ms: 0.094125
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-04: HOSPITAL_GP in-person note IS scored on examination
ok 2003 - v0.81 BUG-0.8-04: HOSPITAL_GP in-person note IS scored on examination
  ---
  duration_ms: 0.066042
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-05/07: stacked findings degrade gracefully, never a flat 0; single finding unchanged
ok 2004 - v0.81 BUG-0.8-05/07: stacked findings degrade gracefully, never a flat 0; single finding unchanged
  ---
  duration_ms: 0.301084
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-03: a formal referral counts as documented follow-up
ok 2005 - v0.81 BUG-0.8-03: a formal referral counts as documented follow-up
  ---
  duration_ms: 0.122041
  type: 'test'
  ...
# Subtest: v0.81 BUG-0.8-01: injectable concentration is not a dose; oral strength still counts
ok 2006 - v0.81 BUG-0.8-01: injectable concentration is not a dose; oral strength still counts
  ---
  duration_ms: 0.043584
  type: 'test'
  ...
# Subtest: v0.81.1 P1: reasoning rubric judges by presentation, not sparseness
ok 2007 - v0.81.1 P1: reasoning rubric judges by presentation, not sparseness
  ---
  duration_ms: 0.108125
  type: 'test'
  ...
# Subtest: v0.81.1 P/O/F/N: prompt-hardening guards are present
ok 2008 - v0.81.1 P/O/F/N: prompt-hardening guards are present
  ---
  duration_ms: 0.042541
  type: 'test'
  ...
# Subtest: v0.81.1 O-render: an impression without an ICD code is not shown as "(none documented)"
ok 2009 - v0.81.1 O-render: an impression without an ICD code is not shown as "(none documented)"
  ---
  duration_ms: 0.088792
  type: 'test'
  ...
# Subtest: v0.81.1 D (BUG-0.8-02): a nested diagnosis is not dropped when dpipe captured only one
ok 2010 - v0.81.1 D (BUG-0.8-02): a nested diagnosis is not dropped when dpipe captured only one
  ---
  duration_ms: 0.0825
  type: 'test'
  ...
# Subtest: v0.81.1 K: in-person febrile note with no vitals gets a documentation gap; controls do not
ok 2011 - v0.81.1 K: in-person febrile note with no vitals gets a documentation gap; controls do not
  ---
  duration_ms: 0.34325
  type: 'test'
  ...
# Subtest: BUG-0.8-12: consolidateDecisions merges the deterministic NSAID interaction + LLM duplication
ok 2012 - BUG-0.8-12: consolidateDecisions merges the deterministic NSAID interaction + LLM duplication
  ---
  duration_ms: 0.250875
  type: 'test'
  ...
# Subtest: BUG-0.8-12: consolidateDecisions is a no-op when there is no deterministic NSAID interaction
ok 2013 - BUG-0.8-12: consolidateDecisions is a no-op when there is no deterministic NSAID interaction
  ---
  duration_ms: 0.037958
  type: 'test'
  ...
# Subtest: BUG-0.8-16: an "inaccurate drug class" finding is neutralised (non-scoring) not a clinician penalty
ok 2014 - BUG-0.8-16: an "inaccurate drug class" finding is neutralised (non-scoring) not a clinician penalty
  ---
  duration_ms: 0.640833
  type: 'test'
  ...
# Subtest: Q (0.8-10): an NSAID ingredient is detected inside a combination whose primary is a non-NSAID
ok 2015 - Q (0.8-10): an NSAID ingredient is detected inside a combination whose primary is a non-NSAID
  ---
  duration_ms: 0.101875
  type: 'test'
  ...
# Subtest: R (0.8-11): a muscle relaxant is detected + consolidateDecisions drops the LLM version when a deterministic one exists
ok 2016 - R (0.8-11): a muscle relaxant is detected + consolidateDecisions drops the LLM version when a deterministic one exists
  ---
  duration_ms: 0.083292
  type: 'test'
  ...
# Subtest: Part 1: an ICD/coding-completeness gap finding is neutralised to non-scoring
ok 2017 - Part 1: an ICD/coding-completeness gap finding is neutralised to non-scoring
  ---
  duration_ms: 0.195833
  type: 'test'
  ...
# Subtest: obstetric adapter (flag ON): populates canonical fields from the obstetric template + current-visit selection
ok 2018 - obstetric adapter (flag ON): populates canonical fields from the obstetric template + current-visit selection
  ---
  duration_ms: 0.594375
  type: 'test'
  ...
# Subtest: obstetric adapter (flag OFF): the obstetric note audits via the GP path, byte-identical (no isObstetric)
ok 2019 - obstetric adapter (flag OFF): the obstetric note audits via the GP path, byte-identical (no isObstetric)
  ---
  duration_ms: 0.090333
  type: 'test'
  ...
# Subtest: obstetric mandatory set: SFH/FHR/presentation required only in the 2nd/3rd trimester
ok 2020 - obstetric mandatory set: SFH/FHR/presentation required only in the 2nd/3rd trimester
  ---
  duration_ms: 0.261083
  type: 'test'
  ...
# Subtest: obstetric vitals: BP never mandatory (credited if present); weight is the required vital
ok 2021 - obstetric vitals: BP never mandatory (credited if present); weight is the required vital
  ---
  duration_ms: 0.108708
  type: 'test'
  ...
# Subtest: obstetric mandatory set: rich note near-complete; follow-up scored in Continuity not Documentation
ok 2022 - obstetric mandatory set: rich note near-complete; follow-up scored in Continuity not Documentation
  ---
  duration_ms: 1.122834
  type: 'test'
  ...
# Subtest: obstetricDosingComplete: a 1-0-1 schedule counts even with a blank frequency field
ok 2023 - obstetricDosingComplete: a 1-0-1 schedule counts even with a blank frequency field
  ---
  duration_ms: 0.335125
  type: 'test'
  ...
# Subtest: bpDocumented reads BP from the obstetric narrative (no structured BP column in db13, §9)
ok 2024 - bpDocumented reads BP from the obstetric narrative (no structured BP column in db13, §9)
  ---
  duration_ms: 0.245084
  type: 'test'
  ...
# Subtest: 0.81.14 Ruling 2: high-alert name-collision artifacts excluded at molecule level; real high-alerts + injectable MgSO4 still fire
ok 2025 - 0.81.14 Ruling 2: high-alert name-collision artifacts excluded at molecule level; real high-alerts + injectable MgSO4 still fire
  ---
  duration_ms: 0.967542
  type: 'test'
  ...
# Subtest: A-9: a non-obstetric note with an LMP gains NO mandatory LMP field; the obstetric path keeps it mandatory
ok 2026 - A-9: a non-obstetric note with an LMP gains NO mandatory LMP field; the obstetric path keeps it mandatory
  ---
  duration_ms: 0.38425
  type: 'test'
  ...
# Subtest: a complete, high-quality note scores in band A
ok 2027 - a complete, high-quality note scores in band A
  ---
  duration_ms: 1.596583
  type: 'test'
  ...
# Subtest: CANARY: three co-prescribed major interactions score prescribing safety 26/100, never 100
ok 2028 - CANARY: three co-prescribed major interactions score prescribing safety 26/100, never 100
  ---
  duration_ms: 0.462542
  type: 'test'
  ...
# Subtest: 0.81.10: an informational finding (the retired muscle-relaxant prompt) does NOT enter the score
ok 2029 - 0.81.10: an informational finding (the retired muscle-relaxant prompt) does NOT enter the score
  ---
  duration_ms: 0.211583
  type: 'test'
  ...
# Subtest: a poor note (gaps + low-value order + prescribing issue + weak PDQI) scores low
ok 2030 - a poor note (gaps + low-value order + prescribing issue + weak PDQI) scores low
  ---
  duration_ms: 0.252833
  type: 'test'
  ...
# Subtest: PDQI-9 not assessed → note_quality weight collapses to 0 (does not drag the index)
ok 2031 - PDQI-9 not assessed → note_quality weight collapses to 0 (does not drag the index)
  ---
  duration_ms: 0.2695
  type: 'test'
  ...
# Subtest: PDQI-9 partial ratings average only the provided attributes
ok 2032 - PDQI-9 partial ratings average only the provided attributes
  ---
  duration_ms: 0.162625
  type: 'test'
  ...
# Subtest: weights are sane
ok 2033 - weights are sane
  ---
  duration_ms: 0.235084
  type: 'test'
  ...
# Subtest: documentationAdequacyFlag fires only when fields (near-)complete AND thoroughness/synthesis low
ok 2034 - documentationAdequacyFlag fires only when fields (near-)complete AND thoroughness/synthesis low
  ---
  duration_ms: 0.151291
  type: 'test'
  ...
# Subtest: computeOpdScore surfaces the thin-documentation flag without changing scores
ok 2035 - computeOpdScore surfaces the thin-documentation flag without changing scores
  ---
  duration_ms: 0.37075
  type: 'test'
  ...
# Subtest: §4.1: concept_id "underuse:…" + source llm ⇒ direction underuse
ok 2036 - §4.1: concept_id "underuse:…" + source llm ⇒ direction underuse
  ---
  duration_ms: 0.684458
  type: 'test'
  ...
# Subtest: §4.1: an underuse finding contributes ZERO penalty
ok 2037 - §4.1: an underuse finding contributes ZERO penalty
  ---
  duration_ms: 0.462667
  type: 'test'
  ...
# Subtest: §4.1 pinned DELIBERATELY: the same finding with NO concept_id emerges with NO direction — the fresh-path behaviour, so a future change to it is visible
ok 2038 - §4.1 pinned DELIBERATELY: the same finding with NO concept_id emerges with NO direction — the fresh-path behaviour, so a future change to it is visible
  ---
  duration_ms: 0.180666
  type: 'test'
  ...
# Subtest: overuse: prefix stamps overuse (the four measured 0.81.17 exhibits — non-antibiotic subjects)
ok 2039 - overuse: prefix stamps overuse (the four measured 0.81.17 exhibits — non-antibiotic subjects)
  ---
  duration_ms: 0.14975
  type: 'test'
  ...
# Subtest: §4.2 (D-6): documentation: and process: prefixes set no direction — absent stays the honest default
ok 2040 - §4.2 (D-6): documentation: and process: prefixes set no direction — absent stays the honest default
  ---
  duration_ms: 0.068417
  type: 'test'
  ...
# Subtest: §4.3 (D-3): the value written as based_on_coded_at IS the value read — identity, not recency
ok 2041 - §4.3 (D-3): the value written as based_on_coded_at IS the value read — identity, not recency
  ---
  duration_ms: 0.378208
  type: 'test'
  ...
# Subtest: the watermark SQL binds based_on_coded_at as $3 and reserves now() for rescored_at only
ok 2042 - the watermark SQL binds based_on_coded_at as $3 and reserves now() for rescored_at only
  ---
  duration_ms: 0.138916
  type: 'test'
  ...
# Subtest: the route passes the coded_at from the CANDIDATE SELECT and never re-reads it after the update
ok 2043 - the route passes the coded_at from the CANDIDATE SELECT and never re-reads it after the update
  ---
  duration_ms: 0.087833
  type: 'test'
  ...
# Subtest: candidate SQL: engine versions are a BOUND array param — unknown version ⇒ zero rows, never a throw
ok 2044 - candidate SQL: engine versions are a BOUND array param — unknown version ⇒ zero rows, never a throw
  ---
  duration_ms: 0.212875
  type: 'test'
  ...
# Subtest: candidate SQL: candidacy = the coder touched the note more recently than the last re-score observed
ok 2045 - candidate SQL: candidacy = the coder touched the note more recently than the last re-score observed
  ---
  duration_ms: 0.279167
  type: 'test'
  ...
# Subtest: candidate SQL tolerates migration 0029 not having run (displayed_band variant)
ok 2046 - candidate SQL tolerates migration 0029 not having run (displayed_band variant)
  ---
  duration_ms: 0.046584
  type: 'test'
  ...
# Subtest: ?limit= — default 800, clamped 1..3000, junk lands on the default
ok 2047 - ?limit= — default 800, clamped 1..3000, junk lands on the default
  ---
  duration_ms: 0.05775
  type: 'test'
  ...
# Subtest: A-1 §1: resolveEngineFilter(null) returns the whole family
ok 2048 - A-1 §1: resolveEngineFilter(null) returns the whole family
  ---
  duration_ms: 0.105458
  type: 'test'
  ...
# Subtest: A-1 §2: an exact family member narrows to exactly that one version
ok 2049 - A-1 §2: an exact family member narrows to exactly that one version
  ---
  duration_ms: 0.03375
  type: 'test'
  ...
# Subtest: A-1 §3: an unknown version yields [] — the fail-safe, never a widened scope
ok 2050 - A-1 §3: an unknown version yields [] — the fail-safe, never a widened scope
  ---
  duration_ms: 0.032333
  type: 'test'
  ...
# Subtest: A-1 §4: an injection-shaped value yields [] and never reaches the query as a live term
ok 2051 - A-1 §4: an injection-shaped value yields [] and never reaches the query as a live term
  ---
  duration_ms: 0.028083
  type: 'test'
  ...
# Subtest: A-1 §5: the report's engine_versions reflects the FILTERED list, not the family
ok 2052 - A-1 §5: the report's engine_versions reflects the FILTERED list, not the family
  ---
  duration_ms: 0.042291
  type: 'test'
  ...
# Subtest: a candidate-query error degrades to an EMPTY report — never a 500
ok 2053 - a candidate-query error degrades to an EMPTY report — never a 500
  ---
  duration_ms: 0.156209
  type: 'test'
  ...
# Subtest: finalize() runs stampDirection on the reuse path — the moment that already works
ok 2054 - finalize() runs stampDirection on the reuse path — the moment that already works
  ---
  duration_ms: 0.070625
  type: 'test'
  ...
# Subtest: the route threads each row's OWN engine_version into auditOpdNote, so the UPDATE is in place
ok 2055 - the route threads each row's OWN engine_version into auditOpdNote, so the UPDATE is in place
  ---
  duration_ms: 0.032583
  type: 'test'
  ...
# Subtest: ?apply=1 is the ONLY write switch — read-only without it
ok 2056 - ?apply=1 is the ONLY write switch — read-only without it
  ---
  duration_ms: 0.045083
  type: 'test'
  ...
# Subtest: §2.7: no cron, no ?auto=1, no scheduler — cadence is V's decision, later
ok 2057 - §2.7: no cron, no ?auto=1, no scheduler — cadence is V's decision, later
  ---
  duration_ms: 0.078458
  type: 'test'
  ...
# Subtest: hysteresis is NOT this build's code — the band rides updateOpdAudit (D-4), the report only mirrors it
ok 2058 - hysteresis is NOT this build's code — the band rides updateOpdAudit (D-4), the report only mirrors it
  ---
  duration_ms: 0.035666
  type: 'test'
  ...
# Subtest: reduceRescoreReport counts direction/index/band movement directly and samples ≤ 20 movers
ok 2059 - reduceRescoreReport counts direction/index/band movement directly and samples ≤ 20 movers
  ---
  duration_ms: 0.072708
  type: 'test'
  ...
# Subtest: A-2 §1: one skipped + one error outcome count into apply_skipped 1 / apply_error 1
ok 2060 - A-2 §1: one skipped + one error outcome count into apply_skipped 1 / apply_error 1
  ---
  duration_ms: 0.050291
  type: 'test'
  ...
# Subtest: A-2 §2: first_apply_error is the FIRST non-empty error message, null when none occurred
ok 2061 - A-2 §2: first_apply_error is the FIRST non-empty error message, null when none occurred
  ---
  duration_ms: 0.092083
  type: 'test'
  ...
# Subtest: A-2 §3: an applyError longer than 300 characters is truncated to 300
ok 2062 - A-2 §3: an applyError longer than 300 characters is truncated to 300
  ---
  duration_ms: 0.039
  type: 'test'
  ...
# Subtest: A-2 §4: missing_audit_uid counts apply-path outcomes whose auditUid is null or empty
ok 2063 - A-2 §4: missing_audit_uid counts apply-path outcomes whose auditUid is null or empty
  ---
  duration_ms: 0.043209
  type: 'test'
  ...
# Subtest: A-2: the route records updateOpdAudit's outcome and never console-logs the driver message
ok 2064 - A-2: the route records updateOpdAudit's outcome and never console-logs the driver message
  ---
  duration_ms: 0.050833
  type: 'test'
  ...
# Subtest: directionGained counts findings that GAINED a direction; underuseCount feeds the sample
ok 2065 - directionGained counts findings that GAINED a direction; underuseCount feeds the sample
  ---
  duration_ms: 0.070833
  type: 'test'
  ...
# Subtest: pdqi9 stored rows-array reconstructs to the computeOpdScore object form
ok 2066 - pdqi9 stored rows-array reconstructs to the computeOpdScore object form
  ---
  duration_ms: 0.065958
  type: 'test'
  ...
# Subtest: A-3 §1: hysteresisCaseSql('displayed_band','$3','$2::int') emits $2::int in every comparison, $3 as every result
ok 2067 - A-3 §1: hysteresisCaseSql('displayed_band','$3','$2::int') emits $2::int in every comparison, $3 as every result
  ---
  duration_ms: 0.234208
  type: 'test'
  ...
# Subtest: A-3 §2: the UPDATE statement deduces $2 from the SET clause and casts it in the CASE
ok 2068 - A-3 §2: the UPDATE statement deduces $2 from the SET clause and casts it in the CASE
  ---
  duration_ms: 0.256917
  type: 'test'
  ...
# Subtest: A-3 §3: saveOpdAudit's conflict clause still reads EXCLUDED.note_quality_index — the two call sites must never be "unified" back into this bug
ok 2069 - A-3 §3: saveOpdAudit's conflict clause still reads EXCLUDED.note_quality_index — the two call sites must never be "unified" back into this bug
  ---
  duration_ms: 0.04025
  type: 'test'
  ...
# Subtest: A-3 §4: the pure twin hysteresisBand is untouched — same thresholds, same g
ok 2070 - A-3 §4: the pure twin hysteresisBand is untouched — same thresholds, same g
  ---
  duration_ms: 0.052875
  type: 'test'
  ...
# Subtest: A-4 §1 (defect 1): the candidate comparison truncates the DB side to the watermark's precision
ok 2071 - A-4 §1 (defect 1): the candidate comparison truncates the DB side to the watermark's precision
  ---
  duration_ms: 0.036416
  type: 'test'
  ...
# Subtest: A-4 §2 (defect 2): an underuse finding carrying lvc_category on input emerges WITHOUT it — every other key survives
ok 2072 - A-4 §2 (defect 2): an underuse finding carrying lvc_category on input emerges WITHOUT it — every other key survives
  ---
  duration_ms: 0.225166
  type: 'test'
  ...
# Subtest: A-4 §3 (defect 2): a non-underuse finding is unchanged — it still receives stamped[i] with its lvc_category
ok 2073 - A-4 §3 (defect 2): a non-underuse finding is unchanged — it still receives stamped[i] with its lvc_category
  ---
  duration_ms: 0.097791
  type: 'test'
  ...
# Subtest: A-4 §4 (defect 2): underuse + signal_type low_value_care — specific type restored AND lvc_category dropped, both on one finding
ok 2074 - A-4 §4 (defect 2): underuse + signal_type low_value_care — specific type restored AND lvc_category dropped, both on one finding
  ---
  duration_ms: 0.949666
  type: 'test'
  ...
# Subtest: A-4 §5 (defect 3): the pass lock — lab_batch semantics, TTL pinned, held ⇒ empty report, never a 500
ok 2075 - A-4 §5 (defect 3): the pass lock — lab_batch semantics, TTL pinned, held ⇒ empty report, never a 500
  ---
  duration_ms: 1.734584
  type: 'test'
  ...
# Subtest: migration 0030: CREATE TABLE IF NOT EXISTS opd_rescore_state, keyed (uid, engine_version)
ok 2076 - migration 0030: CREATE TABLE IF NOT EXISTS opd_rescore_state, keyed (uid, engine_version)
  ---
  duration_ms: 0.307
  type: 'test'
  ...
# Subtest: severityOf + importanceHint: known types weighted, unknown → med
ok 2077 - severityOf + importanceHint: known types weighted, unknown → med
  ---
  duration_ms: 0.849583
  type: 'test'
  ...
# Subtest: buildQueue groups by doctor→signal_type, counts, and drops informational
ok 2078 - buildQueue groups by doctor→signal_type, counts, and drops informational
  ---
  duration_ms: 0.431959
  type: 'test'
  ...
# Subtest: buildQueue ranks types by severity×frequency; noisiest marked; doctors by attention
ok 2079 - buildQueue ranks types by severity×frequency; noisiest marked; doctors by attention
  ---
  duration_ms: 0.143375
  type: 'test'
  ...
# Subtest: buildQueue overlays the latest type decision; status filter hides triaged
ok 2080 - buildQueue overlays the latest type decision; status filter hides triaged
  ---
  duration_ms: 0.354708
  type: 'test'
  ...
# Subtest: buildQueue concentrated flag: doctor holding the whole window share of a type
ok 2081 - buildQueue concentrated flag: doctor holding the whole window share of a type
  ---
  duration_ms: 0.077041
  type: 'test'
  ...
# Subtest: validateDecision: valid batch route decision normalizes
ok 2082 - validateDecision: valid batch route decision normalizes
  ---
  duration_ms: 0.116209
  type: 'test'
  ...
# Subtest: validateDecision: audit_bug forces routed=false and requires bug_type
ok 2083 - validateDecision: audit_bug forces routed=false and requires bug_type
  ---
  duration_ms: 0.104791
  type: 'test'
  ...
# Subtest: validateDecision: valid_signal requires importance; routed requires response_required
ok 2084 - validateDecision: valid_signal requires importance; routed requires response_required
  ---
  duration_ms: 0.051417
  type: 'test'
  ...
# Subtest: validateDecision: instance scope requires audit_id + finding_ref; bad enums rejected
ok 2085 - validateDecision: instance scope requires audit_id + finding_ref; bad enums rejected
  ---
  duration_ms: 0.164083
  type: 'test'
  ...
# Subtest: classifyTransition: audit_bug & not-routed → dismiss; routed → resolution
ok 2086 - classifyTransition: audit_bug & not-routed → dismiss; routed → resolution
  ---
  duration_ms: 0.572834
  type: 'test'
  ...
# Subtest: requireChip: dismiss/resolution require an in-vocabulary chip
ok 2087 - requireChip: dismiss/resolution require an in-vocabulary chip
  ---
  duration_ms: 0.103875
  type: 'test'
  ...
# Subtest: buildTriageEvent: enforces chip, free text optional, telemetry columns normalized
ok 2088 - buildTriageEvent: enforces chip, free text optional, telemetry columns normalized
  ---
  duration_ms: 0.0905
  type: 'test'
  ...
# Subtest: buildQueue: representative carries complexity_band/inputs + lvc_category (passthrough)
ok 2089 - buildQueue: representative carries complexity_band/inputs + lvc_category (passthrough)
  ---
  duration_ms: 0.0635
  type: 'test'
  ...
# Subtest: buildQueue: missing complexity → representative fields null (no placeholder)
ok 2090 - buildQueue: missing complexity → representative fields null (no placeholder)
  ---
  duration_ms: 0.038709
  type: 'test'
  ...
# Subtest: maxTries: 1 makes exactly ONE attempt — no retry at all
ok 2091 - maxTries: 1 makes exactly ONE attempt — no retry at all
  ---
  duration_ms: 0.872667
  type: 'test'
  ...
# Subtest: maxTries: 2 makes exactly TWO attempts
ok 2092 - maxTries: 2 makes exactly TWO attempts
  ---
  duration_ms: 0.218542
  type: 'test'
  ...
# Subtest: a shortened ladder still SUCCEEDS on a later attempt within it
ok 2093 - a shortened ladder still SUCCEEDS on a later attempt within it
  ---
  duration_ms: 0.298917
  type: 'test'
  ...
# Subtest: the empty-200 class respects the shortened budget too
ok 2094 - the empty-200 class respects the shortened budget too
  ---
  duration_ms: 0.144541
  type: 'test'
  ...
# Subtest: the terminal timeout message reports the ladder ACTUALLY used, not the constant
ok 2095 - the terminal timeout message reports the ladder ACTUALLY used, not the constant
  ---
  duration_ms: 5.319125
  type: 'test'
  ...
# Subtest: maxTries absent ⇒ 3 attempts, unchanged from today
ok 2096 - maxTries absent ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.821
  type: 'test'
  ...
# Subtest: maxTries zero ⇒ 3 attempts, unchanged from today
ok 2097 - maxTries zero ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.443875
  type: 'test'
  ...
# Subtest: maxTries negative ⇒ 3 attempts, unchanged from today
ok 2098 - maxTries negative ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.187167
  type: 'test'
  ...
# Subtest: maxTries NaN ⇒ 3 attempts, unchanged from today
ok 2099 - maxTries NaN ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.2775
  type: 'test'
  ...
# Subtest: maxTries Infinity ⇒ 3 attempts, unchanged from today
ok 2100 - maxTries Infinity ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.354792
  type: 'test'
  ...
# Subtest: maxTries a fraction below one ⇒ 3 attempts, unchanged from today
ok 2101 - maxTries a fraction below one ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.134541
  type: 'test'
  ...
# Subtest: maxTries a string ⇒ 3 attempts, unchanged from today
ok 2102 - maxTries a string ⇒ 3 attempts, unchanged from today
  ---
  duration_ms: 0.079542
  type: 'test'
  ...
# Subtest: a fractional maxTries above one TRUNCATES rather than rounding up
ok 2103 - a fractional maxTries above one TRUNCATES rather than rounding up
  ---
  duration_ms: 0.1135
  type: 'test'
  ...
# Subtest: OPENROUTER_MAX_TRIES still exports 3 and stays the default
ok 2104 - OPENROUTER_MAX_TRIES still exports 3 and stays the default
  ---
  duration_ms: 0.169625
  type: 'test'
  ...
# Subtest: the loop body reads the LOCAL maxTries, never the constant
ok 2105 - the loop body reads the LOCAL maxTries, never the constant
  ---
  duration_ms: 0.113459
  type: 'test'
  ...
# Subtest: chatWithFallback takes maxTries fifth and uses it only where a retry loop exists
ok 2106 - chatWithFallback takes maxTries fifth and uses it only where a retry loop exists
  ---
  duration_ms: 0.252875
  type: 'test'
  ...
# Subtest: governedChat threads maxTries down BOTH arms
ok 2107 - governedChat threads maxTries down BOTH arms
  ---
  duration_ms: 0.171291
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the lab path and the production wrapper share ONE policy — identical bindings, not copies
ok 2108 - the lab path and the production wrapper share ONE policy — identical bindings, not copies
  ---
  duration_ms: 0.668458
  type: 'test'
  ...
# Subtest: policy values are unchanged by the move: 3 tries, 429/5xx retryable, 110s deadline, jittered backoff
ok 2109 - policy values are unchanged by the move: 3 tries, 429/5xx retryable, 110s deadline, jittered backoff
  ---
  duration_ms: 0.151
  type: 'test'
  ...
# Subtest: a clean completion returns on attempt 1 — one call, no sleep, no failure report
ok 2110 - a clean completion returns on attempt 1 — one call, no sleep, no failure report
  ---
  duration_ms: 0.640042
  type: 'test'
  ...
# Subtest: every attempt carries OUR deadline and the SDK retries OFF — the budget must not multiply
ok 2111 - every attempt carries OUR deadline and the SDK retries OFF — the budget must not multiply
  ---
  duration_ms: 0.123208
  type: 'test'
  ...
# Subtest: a transport error (no HTTP status) is retryable; success on attempt 2 returns normally
ok 2112 - a transport error (no HTTP status) is retryable; success on attempt 2 returns normally
  ---
  duration_ms: 0.154083
  type: 'test'
  ...
# Subtest: 429/5xx retry on the bounded budget; the FINAL attempt rethrows the provider error
ok 2113 - 429/5xx retry on the bounded budget; the FINAL attempt rethrows the provider error
  ---
  duration_ms: 0.378333
  type: 'test'
  ...
# Subtest: a non-transient status (4xx) throws IMMEDIATELY — the call site fallback path is unchanged for it
ok 2114 - a non-transient status (4xx) throws IMMEDIATELY — the call site fallback path is unchanged for it
  ---
  duration_ms: 0.226875
  type: 'test'
  ...
# Subtest: an EMPTY 200 is a retryable failure, not a terminal one — d6efe39 made it visible, this makes it survivable
ok 2115 - an EMPTY 200 is a retryable failure, not a terminal one — d6efe39 made it visible, this makes it survivable
  ---
  duration_ms: 0.349875
  type: 'test'
  ...
# Subtest: an empty 200 on the FINAL attempt throws the MARKED error so call sites refuse the Ollama fallback (§2.3)
ok 2116 - an empty 200 on the FINAL attempt throws the MARKED error so call sites refuse the Ollama fallback (§2.3)
  ---
  duration_ms: 0.614375
  type: 'test'
  ...
# Subtest: an abort error is retryable — an abort that was not retryable would make the deadline strictly worse than no deadline
ok 2117 - an abort error is retryable — an abort that was not retryable would make the deadline strictly worse than no deadline
  ---
  duration_ms: 0.448875
  type: 'test'
  ...
# Subtest: the onAttemptFailure hook can never be the thing that fails the call
ok 2118 - the onAttemptFailure hook can never be the thing that fails the call
  ---
  duration_ms: 0.116791
  type: 'test'
  ...
# Subtest: streams are the CALLER's exclusion, not the wrapper's — the governed call sites keep the bare create() for stream:true
ok 2119 - streams are the CALLER's exclusion, not the wrapper's — the governed call sites keep the bare create() for stream:true
  ---
  duration_ms: 0.299667
  type: 'test'
  ...
# Subtest: NO timeoutMs → OPENROUTER_TIMEOUT_MS, byte-identical to before
ok 2120 - NO timeoutMs → OPENROUTER_TIMEOUT_MS, byte-identical to before
  ---
  duration_ms: 0.753375
  type: 'test'
  ...
# Subtest: timeoutMs: 600_000 → the doAttempt timeout is 600 000, not 110 000
ok 2121 - timeoutMs: 600_000 → the doAttempt timeout is 600 000, not 110 000
  ---
  duration_ms: 0.112833
  type: 'test'
  ...
# Subtest: timeoutMs: 600_000 → the ABORTCONTROLLER deadline is 600 000 too, not just the SDK belt
ok 2122 - timeoutMs: 600_000 → the ABORTCONTROLLER deadline is 600 000 too, not just the SDK belt
  ---
  duration_ms: 0.121958
  type: 'test'
  ...
# Subtest: a junk timeoutMs degrades to the default — a deadline may never be switched off
ok 2123 - a junk timeoutMs degrades to the default — a deadline may never be switched off
  ---
  duration_ms: 0.172667
  type: 'test'
  ...
# Subtest: the terminal error message reports the APPLIED timeout, not the constant
ok 2124 - the terminal error message reports the APPLIED timeout, not the constant
  ---
  duration_ms: 29.362167
  type: 'test'
  ...
# Subtest: OPENROUTER_MAX_TRIES is still 3 and OPENROUTER_TIMEOUT_MS still defaults to 110 000
ok 2125 - OPENROUTER_MAX_TRIES is still 3 and OPENROUTER_TIMEOUT_MS still defaults to 110 000
  ---
  duration_ms: 0.581417
  type: 'test'
  ...
# Subtest: retry CLASSIFICATION is unchanged: 429 and 5xx retry, 4xx does not
ok 2126 - retry CLASSIFICATION is unchanged: 429 and 5xx retry, 4xx does not
  ---
  duration_ms: 0.108792
  type: 'test'
  ...
# Subtest: a 4xx throws immediately — one attempt, no retry
ok 2127 - a 4xx throws immediately — one attempt, no retry
  ---
  duration_ms: 0.203291
  type: 'test'
  ...
# Subtest: a 429 retries the full budget
ok 2128 - a 429 retries the full budget
  ---
  duration_ms: 0.256916
  type: 'test'
  ...
# Subtest: an ABORT retries — a deadline that ended the call must not end the budget
ok 2129 - an ABORT retries — a deadline that ended the call must not end the budget
  ---
  duration_ms: 19.581875
  type: 'test'
  ...
# Subtest: the backoff curve is untouched
ok 2130 - the backoff curve is untouched
  ---
  duration_ms: 0.472375
  type: 'test'
  ...
# Subtest: EVERY openrouterCreateWithRetry call site forwards the caller timeout AND maxTries
ok 2131 - EVERY openrouterCreateWithRetry call site forwards the caller timeout AND maxTries
  ---
  duration_ms: 1.146083
  type: 'test'
  ...
# Subtest: there are exactly FOUR provider call sites — a fifth must be enumerated
ok 2132 - there are exactly FOUR provider call sites — a fifth must be enumerated
  ---
  duration_ms: 2.808333
  type: 'test'
  ...
# Subtest: chatWithFallback's OpenRouter branch passes the caller's timeout through
ok 2133 - chatWithFallback's OpenRouter branch passes the caller's timeout through
  ---
  duration_ms: 0.503667
  type: 'test'
  ...
# Subtest: tracedChat's OpenRouter branch — THE PRODUCTION PATH — passes both through
ok 2134 - tracedChat's OpenRouter branch — THE PRODUCTION PATH — passes both through
  ---
  duration_ms: 0.189833
  type: 'test'
  ...
# Subtest: the IPD worker box is 800 s, matching the OPD worker
ok 2135 - the IPD worker box is 800 s, matching the OPD worker
  ---
  duration_ms: 0.172542
  type: 'test'
  ...
# Subtest: this build did not disturb the OPD cron window
ok 2136 - this build did not disturb the OPD cron window
  ---
  duration_ms: 0.099958
  type: 'test'
  ...
# Subtest: §2.1 — the DDL re-applies BOTH failure-table constraints, in one keyed statement
ok 2137 - §2.1 — the DDL re-applies BOTH failure-table constraints, in one keyed statement
  ---
  duration_ms: 0.737333
  type: 'test'
  ...
# Subtest: §2.1 — the re-applied CHECKs carry the widened phase list
ok 2138 - §2.1 — the re-applied CHECKs carry the widened phase list
  ---
  duration_ms: 0.160416
  type: 'test'
  ...
# Subtest: §2.1 — the statement is idempotent: DROP tolerates absence, ADD names a now-free constraint
ok 2139 - §2.1 — the statement is idempotent: DROP tolerates absence, ADD names a now-free constraint
  ---
  duration_ms: 0.124958
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: §2.1 — a FRESH table run issues create, then the one ALTER, in order
ok 2140 - §2.1 — a FRESH table run issues create, then the one ALTER, in order
  ---
  duration_ms: 52.162209
  type: 'test'
  ...
# Subtest: §2.1 — a PRE-EXISTING table carrying the OLD constraints still ends with the widened form
ok 2141 - §2.1 — a PRE-EXISTING table carrying the OLD constraints still ends with the widened form
  ---
  duration_ms: 1.4925
  type: 'test'
  ...
# Subtest: §2.1 — migrations/0035 is in parity with the re-applied constraints
ok 2142 - §2.1 — migrations/0035 is in parity with the re-applied constraints
  ---
  duration_ms: 0.188792
  type: 'test'
  ...
# Subtest: §2.2 — the version is 3, and a payload built today claims 3
ok 2143 - §2.2 — the version is 3, and a payload built today claims 3
  ---
  duration_ms: 0.404458
  type: 'test'
  ...
# Subtest: §2.2 — a VERSION-2 manifest is unrecognized, which is the point of the bump
ok 2144 - §2.2 — a VERSION-2 manifest is unrecognized, which is the point of the bump
  ---
  duration_ms: 0.585542
  type: 'test'
  ...
# Subtest: §2.2 — ABSENT and explicit NULL stay distinguishable, which is why `has` is used
ok 2145 - §2.2 — ABSENT and explicit NULL stay distinguishable, which is why `has` is used
  ---
  duration_ms: 0.475375
  type: 'test'
  ...
# Subtest: §2.2 — both fields are TYPE-checked, not merely present
ok 2146 - §2.2 — both fields are TYPE-checked, not merely present
  ---
  duration_ms: 0.887292
  type: 'test'
  ...
# Subtest: §2.2 — the seed vocabulary is ONE object, not two that agree
ok 2147 - §2.2 — the seed vocabulary is ONE object, not two that agree
  ---
  duration_ms: 0.569167
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# Subtest: §2.3 — the JUDGE arm no longer claims an unproven not_served
ok 2148 - §2.3 — the JUDGE arm no longer claims an unproven not_served
  ---
  duration_ms: 68.628
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# Subtest: §2.3 — the COHERE arm is unchanged from pass 0
ok 2149 - §2.3 — the COHERE arm is unchanged from pass 0
  ---
  duration_ms: 32.630791
  type: 'test'
  ...
# [rerank] backend failed, returning input order generic, untyped
# [rerank] backend failed, returning input order generic, untyped
# Subtest: §2.3 — THE REGRESSION GUARD: no synthesised boundary on EITHER arm may assert proof
ok 2150 - §2.3 — THE REGRESSION GUARD: no synthesised boundary on EITHER arm may assert proof
  ---
  duration_ms: 13.669959
  type: 'test'
  ...
# Subtest: §2.3 — where transport proof EXISTS, the served class still stands
ok 2151 - §2.3 — where transport proof EXISTS, the served class still stands
  ---
  duration_ms: 1.271083
  type: 'test'
  ...
# Subtest: parseSkeleton forces DDx hand-off on a low-certainty / anchored diagnosis
ok 2152 - parseSkeleton forces DDx hand-off on a low-certainty / anchored diagnosis
  ---
  duration_ms: 1.811458
  type: 'test'
  ...
# Subtest: normStageKind maps synonyms + defaults to assessment
ok 2153 - normStageKind maps synonyms + defaults to assessment
  ---
  duration_ms: 0.2415
  type: 'test'
  ...
# Subtest: normStageFlag maps synonyms + defaults to routine
ok 2154 - normStageFlag maps synonyms + defaults to routine
  ---
  duration_ms: 0.127
  type: 'test'
  ...
# Subtest: orderAndIdStages enforces canonical order, stable within kind, sequential ids
ok 2155 - orderAndIdStages enforces canonical order, stable within kind, sequential ids
  ---
  duration_ms: 0.546541
  type: 'test'
  ...
# Subtest: orderAndIdStages caps the spine
ok 2156 - orderAndIdStages caps the spine
  ---
  duration_ms: 0.099333
  type: 'test'
  ...
# Subtest: STAGE_ORDER is strictly increasing along the canonical path
ok 2157 - STAGE_ORDER is strictly increasing along the canonical path
  ---
  duration_ms: 0.059416
  type: 'test'
  ...
# Subtest: parseSkeleton parses a fenced JSON skeleton
ok 2158 - parseSkeleton parses a fenced JSON skeleton
  ---
  duration_ms: 0.201083
  type: 'test'
  ...
# Subtest: parseSkeleton forces needsDdx for undifferentiated low-certainty presentation
ok 2159 - parseSkeleton forces needsDdx for undifferentiated low-certainty presentation
  ---
  duration_ms: 0.061667
  type: 'test'
  ...
# Subtest: parseSkeleton returns null on garbage / empty stages
ok 2160 - parseSkeleton returns null on garbage / empty stages
  ---
  duration_ms: 0.186958
  type: 'test'
  ...
# Subtest: parseEnrichment parses, filters unknown ids, dedups, separates evidence/estimates
ok 2161 - parseEnrichment parses, filters unknown ids, dedups, separates evidence/estimates
  ---
  duration_ms: 0.490709
  type: 'test'
  ...
# Subtest: parseEnrichment returns null on garbage
ok 2162 - parseEnrichment returns null on garbage
  ---
  duration_ms: 0.065625
  type: 'test'
  ...
# Subtest: mergeStages overlays enrichment by id and marks enriched
ok 2163 - mergeStages overlays enrichment by id and marks enriched
  ---
  duration_ms: 0.106041
  type: 'test'
  ...
# Subtest: §2.7.1 fact vs inference survives: provenance/extractionMethod/confidence pass through verbatim
ok 2164 - §2.7.1 fact vs inference survives: provenance/extractionMethod/confidence pass through verbatim
  ---
  duration_ms: 0.785125
  type: 'test'
  ...
# Subtest: §2.7.2 negatives ≠ unknowns, and assessedInputs ≠ missingInputs — never merged, never dropped when empty
ok 2165 - §2.7.2 negatives ≠ unknowns, and assessedInputs ≠ missingInputs — never merged, never dropped when empty
  ---
  duration_ms: 0.717875
  type: 'test'
  ...
# Subtest: §2.7.3 conflicts surface and are NEVER resolved, filtered or collapsed — including safety_critical
ok 2166 - §2.7.3 conflicts surface and are NEVER resolved, filtered or collapsed — including safety_critical
  ---
  duration_ms: 0.1245
  type: 'test'
  ...
# Subtest: §2.7.4 as_of comes from the snapshot's own field — never recomputed, only re-FORMATTED
ok 2167 - §2.7.4 as_of comes from the snapshot's own field — never recomputed, only re-FORMATTED
  ---
  duration_ms: 0.08
  type: 'test'
  ...
# Subtest: §2.4 the LAST served observation wins, and a clean frontier run is not degraded
ok 2168 - §2.4 the LAST served observation wins, and a clean frontier run is not degraded
  ---
  duration_ms: 0.102833
  type: 'test'
  ...
# Subtest: §2.4 THE T-5 SCENARIO: a fallback leg ⇒ degraded, whatever the intent said
ok 2169 - §2.4 THE T-5 SCENARIO: a fallback leg ⇒ degraded, whatever the intent said
  ---
  duration_ms: 0.078833
  type: 'test'
  ...
# Subtest: §2.4 "we do not know" is DEGRADED — never the happy path
ok 2170 - §2.4 "we do not know" is DEGRADED — never the happy path
  ---
  duration_ms: 0.1015
  type: 'test'
  ...
# Subtest: §2.4 a partial assembly (a state leg failed) is degraded even when the model was clean
ok 2171 - §2.4 a partial assembly (a state leg failed) is degraded even when the model was clean
  ---
  duration_ms: 0.04975
  type: 'test'
  ...
# Subtest: §2.4 the wired reader takes provider/model from llm_response — NEVER llm_request (that is intent)
ok 2172 - §2.4 the wired reader takes provider/model from llm_response — NEVER llm_request (that is intent)
  ---
  duration_ms: 0.189833
  type: 'test'
  ...
# Subtest: §2.5 commercial is a SIBLING of clinical, never nested inside it, and carries its own definition
ok 2173 - §2.5 commercial is a SIBLING of clinical, never nested inside it, and carries its own definition
  ---
  duration_ms: 0.302042
  type: 'test'
  ...
# Subtest: §2.5 the commercial layer SHIPS — it is not omitted
ok 2174 - §2.5 the commercial layer SHIPS — it is not omitted
  ---
  duration_ms: 0.053459
  type: 'test'
  ...
# Subtest: §2.6 the disclaimer is rewritten for a physician pre-encounter and EMITTED in the JSON
ok 2175 - §2.6 the disclaimer is rewritten for a physician pre-encounter and EMITTED in the JSON
  ---
  duration_ms: 0.05875
  type: 'test'
  ...
# Subtest: §2.3 every namespace is present and the envelope carries its required fields
ok 2176 - §2.3 every namespace is present and the envelope carries its required fields
  ---
  duration_ms: 0.120292
  type: 'test'
  ...
# Subtest: §2.3 actions.follow_ups carries the snapshot's own followUps — never re-derived
ok 2177 - §2.3 actions.follow_ups carries the snapshot's own followUps — never re-derived
  ---
  duration_ms: 0.057625
  type: 'test'
  ...
# Subtest: §2.1 POST answers 202 with a job id and a poll url; the poll route returns 202/200/404
ok 2178 - §2.1 POST answers 202 with a job id and a poll url; the poll route returns 202/200/404
  ---
  duration_ms: 0.04
  type: 'test'
  ...
# Subtest: §2.1 the 202 shape is documented as load-bearing — V2 precompute must not change the contract
ok 2179 - §2.1 the 202 shape is documented as load-bearing — V2 precompute must not change the contract
  ---
  duration_ms: 0.07975
  type: 'test'
  ...
# Subtest: §2.2 auth reuses CRON_SECRET and RECORDS that it is pilot-scoped and must be split
ok 2180 - §2.2 auth reuses CRON_SECRET and RECORDS that it is pilot-scoped and must be split
  ---
  duration_ms: 0.068583
  type: 'test'
  ...
# Subtest: the poll route tells Pulse it is REQUIRED to render a degraded package differently
ok 2181 - the poll route tells Pulse it is REQUIRED to render a degraded package differently
  ---
  duration_ms: 0.027459
  type: 'test'
  ...
# Subtest: job ids are well-formed and validated
ok 2182 - job ids are well-formed and validated
  ---
  duration_ms: 0.111125
  type: 'test'
  ...
# Subtest: §1.1 the CCB card and its live PHI count query are gone; OPD Audit Triage is untouched
ok 2183 - §1.1 the CCB card and its live PHI count query are gone; OPD Audit Triage is untouched
  ---
  duration_ms: 0.053291
  type: 'test'
  ...
# Subtest: §1.1 /care/briefs stays REACHABLE — no gate was added (V overruled 404-ing it)
ok 2184 - §1.1 /care/briefs stays REACHABLE — no gate was added (V overruled 404-ing it)
  ---
  duration_ms: 0.131625
  type: 'test'
  ...
# Subtest: §1.3 every preserved-mechanics file carries the RETIRED header WITH the CCB_ENABLED hazard
ok 2185 - §1.3 every preserved-mechanics file carries the RETIRED header WITH the CCB_ENABLED hazard
  ---
  duration_ms: 0.605
  type: 'test'
  ...
# Subtest: §2.3 the ExtractedReport[] sink is ADDITIVE — the envelope and every existing caller are untouched
ok 2186 - §2.3 the ExtractedReport[] sink is ADDITIVE — the envelope and every existing caller are untouched
  ---
  duration_ms: 0.091667
  type: 'test'
  ...
# Subtest: ungrounded: citation_coverage_pct === 0 flips envelope.ungrounded — a zero-grounded package must not pass as well-grounded
ok 2187 - ungrounded: citation_coverage_pct === 0 flips envelope.ungrounded — a zero-grounded package must not pass as well-grounded
  ---
  duration_ms: 0.051625
  type: 'test'
  ...
# Subtest: state_llm: rejected[] is surfaced in the envelope — the hallucination meter is not discarded
ok 2188 - state_llm: rejected[] is surfaced in the envelope — the hallucination meter is not discarded
  ---
  duration_ms: 0.097917
  type: 'test'
  ...
# Subtest: state_conflicts: a concept in BOTH positives and negatives is surfaced, normalised, never resolved
ok 2189 - state_conflicts: a concept in BOTH positives and negatives is surfaced, normalised, never resolved
  ---
  duration_ms: 1.159
  type: 'test'
  ...
# Subtest: a flag-on stage-2 failure is DEGRADED — the state shipped thinner than the default contract
ok 2190 - a flag-on stage-2 failure is DEGRADED — the state shipped thinner than the default contract
  ---
  duration_ms: 0.13975
  type: 'test'
  ...
# Subtest: the wired stage 2 is flag-gated DEFAULT ON, governed, and rides the brief trace
ok 2191 - the wired stage 2 is flag-gated DEFAULT ON, governed, and rides the brief trace
  ---
  duration_ms: 0.112459
  type: 'test'
  ...
# Subtest: stage 2 caps its thinking — the Vertex form, gated on a resolved Gemini model, never zero
ok 2192 - stage 2 caps its thinking — the Vertex form, gated on a resolved Gemini model, never zero
  ---
  duration_ms: 0.179917
  type: 'test'
  ...
# Subtest: the audit budget is NOT changed by the stage-2 cap — separate constants, separate files
ok 2193 - the audit budget is NOT changed by the stage-2 cap — separate constants, separate files
  ---
  duration_ms: 0.495125
  type: 'test'
  ...
# Subtest: T-13 §5.1: the captured failure now reports degraded, naming the dead leg
ok 2194 - T-13 §5.1: the captured failure now reports degraded, naming the dead leg
  ---
  duration_ms: 0.140291
  type: 'test'
  ...
# Subtest: T-13 §5.2: a HEALTHY package still reports degraded:false — the check must not mark everything
ok 2195 - T-13 §5.2: a HEALTHY package still reports degraded:false — the check must not mark everything
  ---
  duration_ms: 0.090875
  type: 'test'
  ...
# Subtest: T-13 §5.4: each check fires ALONE, with the other disabled
ok 2196 - T-13 §5.4: each check fires ALONE, with the other disabled
  ---
  duration_ms: 0.282708
  type: 'test'
  ...
# Subtest: T-13: the content check needs BOTH conditions — a grounded package with 0 findings, or an ungrounded one with findings, is not "empty"
ok 2197 - T-13: the content check needs BOTH conditions — a grounded package with 0 findings, or an ungrounded one with findings, is not "empty"
  ---
  duration_ms: 0.163458
  type: 'test'
  ...
# Subtest: T-13: failed legs are deduped and named in sorted order, and junk never crashes the reason
ok 2198 - T-13: failed legs are deduped and named in sorted order, and junk never crashes the reason
  ---
  duration_ms: 0.113792
  type: 'test'
  ...
# Subtest: T-13: the reasons compose — every independent cause is stated, none replaces another
ok 2199 - T-13: the reasons compose — every independent cause is stated, none replaces another
  ---
  duration_ms: 0.114917
  type: 'test'
  ...
# Subtest: T-13 §4: as_of is normalised to full ISO 8601 — a bare date keeps its calendar day
ok 2200 - T-13 §4: as_of is normalised to full ISO 8601 — a bare date keeps its calendar day
  ---
  duration_ms: 1.087667
  type: 'test'
  ...
# Subtest: T-13 §4: the snapshot itself is NOT recomputed — only the envelope is formatted
ok 2201 - T-13 §4: the snapshot itself is NOT recomputed — only the envelope is formatted
  ---
  duration_ms: 0.146
  type: 'test'
  ...
# Subtest: T-13 §2: the envelope reads the failure signal that already existed on the trace
ok 2202 - T-13 §2: the envelope reads the failure signal that already existed on the trace
  ---
  duration_ms: 0.0495
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: THE DEFECT: a 200 with empty content THROWS instead of returning an empty string
ok 2203 - THE DEFECT: a 200 with empty content THROWS instead of returning an empty string
  ---
  duration_ms: 73.855791
  type: 'test'
  ...
# Subtest: empty content is RETRYABLE on the EXISTING budget — only the final attempt throws
ok 2204 - empty content is RETRYABLE on the EXISTING budget — only the final attempt throws
  ---
  duration_ms: 0.340084
  type: 'test'
  ...
# Subtest: the try budget is NOT raised — still exactly 3
ok 2205 - the try budget is NOT raised — still exactly 3
  ---
  duration_ms: 0.0465
  type: 'test'
  ...
# Subtest: persistent empty content exhausts the budget and throws — no silent fallback
ok 2206 - persistent empty content exhausts the budget and throws — no silent fallback
  ---
  duration_ms: 0.248583
  type: 'test'
  ...
# Subtest: a NON-empty response still returns normally — the happy path is untouched
ok 2207 - a NON-empty response still returns normally — the happy path is untouched
  ---
  duration_ms: 0.183917
  type: 'test'
  ...
# Subtest: THE ERROR MESSAGE is verbatim per PRD §4 and carries the whole envelope
ok 2208 - THE ERROR MESSAGE is verbatim per PRD §4 and carries the whole envelope
  ---
  duration_ms: 0.057625
  type: 'test'
  ...
# Subtest: the message renders missing envelope fields as null rather than undefined or blank
ok 2209 - the message renders missing envelope fields as null rather than undefined or blank
  ---
  duration_ms: 0.055084
  type: 'test'
  ...
# Subtest: the thrown message actually reaches the caller with the envelope in it
ok 2210 - the thrown message actually reaches the caller with the envelope in it
  ---
  duration_ms: 0.386333
  type: 'test'
  ...
# Subtest: onEnvelope fires on EVERY attempt — success, empty content and HTTP failure alike
ok 2211 - onEnvelope fires on EVERY attempt — success, empty content and HTTP failure alike
  ---
  duration_ms: 0.739708
  type: 'test'
  ...
# Subtest: ENVELOPE CAPTURE NEVER THROWS — a broken callback cannot cost a real result
ok 2212 - ENVELOPE CAPTURE NEVER THROWS — a broken callback cannot cost a real result
  ---
  duration_ms: 0.640542
  type: 'test'
  ...
# Subtest: readLlmEnvelope is total — any shape yields a defined envelope, never a throw
ok 2213 - readLlmEnvelope is total — any shape yields a defined envelope, never a throw
  ---
  duration_ms: 0.158208
  type: 'test'
  ...
# Subtest: OPENROUTER_TIMEOUT_MS defaults to 110s and is env-overridable
ok 2214 - OPENROUTER_TIMEOUT_MS defaults to 110s and is env-overridable
  ---
  duration_ms: 0.136917
  type: 'test'
  ...
# Subtest: an AbortSignal is passed to the fetch, and the timer is always cleared
ok 2215 - an AbortSignal is passed to the fetch, and the timer is always cleared
  ---
  duration_ms: 0.150375
  type: 'test'
  ...
# Subtest: a timeout is a NORMAL RETRYABLE failure on the same bounded budget
ok 2216 - a timeout is a NORMAL RETRYABLE failure on the same bounded budget
  ---
  duration_ms: 0.18475
  type: 'test'
  ...
# Subtest: a persistent transport failure exhausts the budget and throws a named error
ok 2217 - a persistent transport failure exhausts the budget and throws a named error
  ---
  duration_ms: 0.215417
  type: 'test'
  ...
# Subtest: the transport catch still emits an envelope, so a hung attempt is visible
ok 2218 - the transport catch still emits an envelope, so a hung attempt is visible
  ---
  duration_ms: 0.202625
  type: 'test'
  ...
# Subtest: THE CATCH BLOCK rethrows ONLY for eval; the non-eval return is byte-identical
ok 2219 - THE CATCH BLOCK rethrows ONLY for eval; the non-eval return is byte-identical
  ---
  duration_ms: 0.085125
  type: 'test'
  ...
# Subtest: the production defaultGenerate params are byte-identical — no eval change leaked in
ok 2220 - the production defaultGenerate params are byte-identical — no eval change leaked in
  ---
  duration_ms: 0.117667
  type: 'test'
  ...
# Subtest: buildOpenRouterBody is BYTE-IDENTICAL — no max_tokens, no response_format (D3)
ok 2221 - buildOpenRouterBody is BYTE-IDENTICAL — no max_tokens, no response_format (D3)
  ---
  duration_ms: 0.222625
  type: 'test'
  ...
# Subtest: no engine version bump, and the retry predicate is unchanged
ok 2222 - no engine version bump, and the retry predicate is unchanged
  ---
  duration_ms: 0.2455
  type: 'test'
  ...
# Subtest: runMiniOpdToLab writes the envelope on success and cannot write one on failure
ok 2223 - runMiniOpdToLab writes the envelope on success and cannot write one on failure
  ---
  duration_ms: 0.195625
  type: 'test'
  ...
# Subtest: the lab-batch core is untouched — drainPlan and the locks still stand
ok 2224 - the lab-batch core is untouched — drainPlan and the locks still stand
  ---
  duration_ms: 0.099458
  type: 'test'
  ...
# Subtest: parses a full draft: caps, ranking, counts, version, disclaimer
ok 2225 - parses a full draft: caps, ranking, counts, version, disclaimer
  ---
  duration_ms: 0.847292
  type: 'test'
  ...
# Subtest: citation ids bounded by the SHARED source count
ok 2226 - citation ids bounded by the SHARED source count
  ---
  duration_ms: 0.628542
  type: 'test'
  ...
# Subtest: unknown enums fall to safe defaults
ok 2227 - unknown enums fall to safe defaults
  ---
  duration_ms: 0.076334
  type: 'test'
  ...
# Subtest: caps: complications 8, safety-net 10
ok 2228 - caps: complications 8, safety-net 10
  ---
  duration_ms: 0.1505
  type: 'test'
  ...
# Subtest: malformed / empty inputs return null
ok 2229 - malformed / empty inputs return null
  ---
  duration_ms: 0.102584
  type: 'test'
  ...
# Subtest: summary fallback built when model omits it
ok 2230 - summary fallback built when model omits it
  ---
  duration_ms: 0.100792
  type: 'test'
  ...
# Subtest: buildPxUser: lens per doc type + documented plan block + empty-plan fallback
ok 2231 - buildPxUser: lens per doc type + documented plan block + empty-plan fallback
  ---
  duration_ms: 0.218792
  type: 'test'
  ...
# Subtest: parsePxCritique reads PX-specific keys; needs_revision inferred from non-empty arrays
ok 2232 - parsePxCritique reads PX-specific keys; needs_revision inferred from non-empty arrays
  ---
  duration_ms: 0.107833
  type: 'test'
  ...
# Subtest: R5: offsetPrognosisCitations shifts every citation id by the analyze-source count
ok 2233 - R5: offsetPrognosisCitations shifts every citation id by the analyze-source count
  ---
  duration_ms: 0.243667
  type: 'test'
  ...
# Subtest: modifiers parsed with direction defaulting to raises; capped at 6
ok 2234 - modifiers parsed with direction defaulting to raises; capped at 6
  ---
  duration_ms: 0.305292
  type: 'test'
  ...
# Subtest: §7.1 hash stability: spacing and casing variants produce the SAME hash
ok 2235 - §7.1 hash stability: spacing and casing variants produce the SAME hash
  ---
  duration_ms: 0.720333
  type: 'test'
  ...
# Subtest: the hash is EXACTLY sha256(normalized) hex first 16 — the stored contract, pinned
ok 2236 - the hash is EXACTLY sha256(normalized) hex first 16 — the stored contract, pinned
  ---
  duration_ms: 0.158292
  type: 'test'
  ...
# Subtest: ADDENDUM A §1.2 — the ten cross-engine vectors, pinned with their literal hashes
ok 2237 - ADDENDUM A §1.2 — the ten cross-engine vectors, pinned with their literal hashes
  ---
  duration_ms: 0.183125
  type: 'test'
  ...
# Subtest: normalization is trim + lower-case + collapse internal whitespace, nothing more
ok 2238 - normalization is trim + lower-case + collapse internal whitespace, nothing more
  ---
  duration_ms: 0.047708
  type: 'test'
  ...
# Subtest: §7.2 re-audit resilience: the array reorders, the hash still finds the right complication
ok 2239 - §7.2 re-audit resilience: the array reorders, the hash still finds the right complication
  ---
  duration_ms: 0.359875
  type: 'test'
  ...
# Subtest: §7.3 engine bump: an outcome linked at engine A resolves against engine B when the name survived
ok 2240 - §7.3 engine bump: an outcome linked at engine A resolves against engine B when the name survived
  ---
  duration_ms: 0.053459
  type: 'test'
  ...
# Subtest: §7.3 engine bump: a renamed complication renders UNRESOLVED — never re-pointed by index
ok 2241 - §7.3 engine bump: a renamed complication renders UNRESOLVED — never re-pointed by index
  ---
  duration_ms: 0.113125
  type: 'test'
  ...
# Subtest: a NULL hash reads as unpredicted, and junk shapes never throw
ok 2242 - a NULL hash reads as unpredicted, and junk shapes never throw
  ---
  duration_ms: 0.105708
  type: 'test'
  ...
# Subtest: §7.5 each classification is produced by the correct form state
ok 2243 - §7.5 each classification is produced by the correct form state
  ---
  duration_ms: 0.287834
  type: 'test'
  ...
# Subtest: §7.5 no_adverse_outcome FORCES a null complication hash, whatever the form held
ok 2244 - §7.5 no_adverse_outcome FORCES a null complication hash, whatever the form held
  ---
  duration_ms: 0.292708
  type: 'test'
  ...
# Subtest: the vocabularies are exactly the PRD’s
ok 2245 - the vocabularies are exactly the PRD’s
  ---
  duration_ms: 0.082042
  type: 'test'
  ...
# Subtest: §7.4 currentRows: the default view shows only non-superseded rows; history shows all
ok 2246 - §7.4 currentRows: the default view shows only non-superseded rows; history shows all
  ---
  duration_ms: 0.063542
  type: 'test'
  ...
# Subtest: §7.6 a document with no rows is not_followed_up and OUTSIDE the over-warning denominator
ok 2247 - §7.6 a document with no rows is not_followed_up and OUTSIDE the over-warning denominator
  ---
  duration_ms: 0.048709
  type: 'test'
  ...
# Subtest: §7.6 an event row alone follows the document up but does NOT admit it to the over-warning denominator
ok 2248 - §7.6 an event row alone follows the document up but does NOT admit it to the over-warning denominator
  ---
  duration_ms: 0.037583
  type: 'test'
  ...
# Subtest: §7.6 a no_adverse_outcome row admits the document; a superseded one does not
ok 2249 - §7.6 a no_adverse_outcome row admits the document; a superseded one does not
  ---
  duration_ms: 0.034292
  type: 'test'
  ...
# Subtest: §7.6 no_adverse alongside an event row: followed up, in the denominator, both persist
ok 2250 - §7.6 no_adverse alongside an event row: followed up, in the denominator, both persist
  ---
  duration_ms: 0.034709
  type: 'test'
  ...
# Subtest: §7.7 idempotent migration: every statement is IF NOT EXISTS — running it twice is a no-op
ok 2251 - §7.7 idempotent migration: every statement is IF NOT EXISTS — running it twice is a no-op
  ---
  duration_ms: 0.204542
  type: 'test'
  ...
# Subtest: P-7 in the store: supersede is ONE atomic statement — flag-flip CTE + insert, no content UPDATE, no DELETE
ok 2252 - P-7 in the store: supersede is ONE atomic statement — flag-flip CTE + insert, no content UPDATE, no DELETE
  ---
  duration_ms: 0.137417
  type: 'test'
  ...
# Subtest: §7.6 the view emits the not_followed_up bucket, and the over-warning columns go NULL outside it
ok 2253 - §7.6 the view emits the not_followed_up bucket, and the over-warning columns go NULL outside it
  ---
  duration_ms: 0.044333
  type: 'test'
  ...
# Subtest: the view reads only non-superseded rows and resolves by the SAME hash as the core
ok 2254 - the view reads only non-superseded rows and resolves by the SAME hash as the core
  ---
  duration_ms: 0.056417
  type: 'test'
  ...
# Subtest: the migrate route creates the table BEFORE the view, mirroring migrations/0033 exactly
ok 2255 - the migrate route creates the table BEFORE the view, mirroring migrations/0033 exactly
  ---
  duration_ms: 0.048333
  type: 'test'
  ...
# Subtest: P-8: the table and the view pass the SQL guard, and lib/sql-guard-core.ts is untouched
ok 2256 - P-8: the table and the view pass the SQL guard, and lib/sql-guard-core.ts is untouched
  ---
  duration_ms: 0.636166
  type: 'test'
  ...
# Subtest: A-2: horizon_days is DERIVED in SQL against the canonical discharged_at — never typed, never audited_at
ok 2257 - A-2: horizon_days is DERIVED in SQL against the canonical discharged_at — never typed, never audited_at
  ---
  duration_ms: 0.060208
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: SQL honesty: reads degrade to unavailable and writes to a refusal — never a throw (no DB in this sandbox)
ok 2258 - SQL honesty: reads degrade to unavailable and writes to a refusal — never a throw (no DB in this sandbox)
  ---
  duration_ms: 25.152167
  type: 'test'
  ...
# Subtest: promotion threshold is 5
ok 2259 - promotion threshold is 5
  ---
  duration_ms: 0.503959
  type: 'test'
  ...
# Subtest: a selection recurring ≥ threshold → promotion candidate
ok 2260 - a selection recurring ≥ threshold → promotion candidate
  ---
  duration_ms: 3.451334
  type: 'test'
  ...
# Subtest: below threshold → collecting
ok 2261 - below threshold → collecting
  ---
  duration_ms: 0.218583
  type: 'test'
  ...
# Subtest: threshold override is honoured
ok 2262 - threshold override is honoured
  ---
  duration_ms: 0.162208
  type: 'test'
  ...
# Subtest: dominant selection wins over a minority variant; edited count tracks divergence from generated
ok 2263 - dominant selection wins over a minority variant; edited count tracks divergence from generated
  ---
  duration_ms: 0.553
  type: 'test'
  ...
# Subtest: selection order and duplicates do not split a recurring set
ok 2264 - selection order and duplicates do not split a recurring set
  ---
  duration_ms: 0.401209
  type: 'test'
  ...
# Subtest: records with no procedure context are skipped
ok 2265 - records with no procedure context are skipped
  ---
  duration_ms: 0.32775
  type: 'test'
  ...
# Subtest: procedure grouping is case/whitespace-insensitive
ok 2266 - procedure grouping is case/whitespace-insensitive
  ---
  duration_ms: 1.272083
  type: 'test'
  ...
# Subtest: candidates sort before collecting; ties by recurrence desc
ok 2267 - candidates sort before collecting; ties by recurrence desc
  ---
  duration_ms: 0.624292
  type: 'test'
  ...
# Subtest: grouping is deterministic (twice → deep-equal)
ok 2268 - grouping is deterministic (twice → deep-equal)
  ---
  duration_ms: 0.928041
  type: 'test'
  ...
# Subtest: empty input → empty queue
ok 2269 - empty input → empty queue
  ---
  duration_ms: 0.124
  type: 'test'
  ...
# Subtest: suggestSetName maps a procedure to hs-<word>
ok 2270 - suggestSetName maps a procedure to hs-<word>
  ---
  duration_ms: 0.231625
  type: 'test'
  ...
# Subtest: a dominant selection of real bank ids survives validateAdhocSelection
ok 2271 - a dominant selection of real bank ids survives validateAdhocSelection
  ---
  duration_ms: 0.60825
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: scored instruments → one dated care_call encounter with investigation points
ok 2272 - promResponsesToEncounter: scored instruments → one dated care_call encounter with investigation points
  ---
  duration_ms: 2.659625
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: unscored (null) instruments are dropped from the fold
ok 2273 - promResponsesToEncounter: unscored (null) instruments are dropped from the fold
  ---
  duration_ms: 0.126375
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: empty / all-null → empty investigations, no date (fold filters it)
ok 2274 - promResponsesToEncounter: empty / all-null → empty investigations, no date (fold filters it)
  ---
  duration_ms: 0.282792
  type: 'test'
  ...
# Subtest: promResponsesToEncounter: deterministic (twice → deep-equal)
ok 2275 - promResponsesToEncounter: deterministic (twice → deep-equal)
  ---
  duration_ms: 0.864208
  type: 'test'
  ...
# Subtest: versions
ok 2276 - versions
  ---
  duration_ms: 0.623042
  type: 'test'
  ...
# Subtest: classifyFamily: each regex family (order = first-match-wins)
ok 2277 - classifyFamily: each regex family (order = first-match-wins)
  ---
  duration_ms: 1.295792
  type: 'test'
  ...
# Subtest: classifyFamily: no regex match → unknown (core+PREM); NULLIF empties handled
ok 2278 - classifyFamily: no regex match → unknown (core+PREM); NULLIF empties handled
  ---
  duration_ms: 0.096666
  type: 'test'
  ...
# Subtest: classifyFamily v1.1: main surgical families reach their existing packs
ok 2279 - classifyFamily v1.1: main surgical families reach their existing packs
  ---
  duration_ms: 0.099917
  type: 'test'
  ...
# Subtest: classifyFamily v1.1: existing coarse families unregressed
ok 2280 - classifyFamily v1.1: existing coarse families unregressed
  ---
  duration_ms: 0.053875
  type: 'test'
  ...
# Subtest: classifyFamily v1.1: proctology routes to its house pack end-to-end
ok 2281 - classifyFamily v1.1: proctology routes to its house pack end-to-end
  ---
  duration_ms: 3.013583
  type: 'test'
  ...
# Subtest: classifyFamily: the universal_core catch-all is never returned as a family
ok 2282 - classifyFamily: the universal_core catch-all is never returned as a family
  ---
  duration_ms: 0.140458
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: sample uid→family for the 5 ratified representatives
ok 2283 - UID_FAMILY_MAP: sample uid→family for the 5 ratified representatives
  ---
  duration_ms: 0.058333
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: uid-map beats the procedure_name regex (precedence)
ok 2284 - UID_FAMILY_MAP: uid-map beats the procedure_name regex (precedence)
  ---
  duration_ms: 0.217
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: facial_ent resolves to STANDARD + CORE+PREM only (null primary/fallback, no crash)
ok 2285 - UID_FAMILY_MAP: facial_ent resolves to STANDARD + CORE+PREM only (null primary/fallback, no crash)
  ---
  duration_ms: 0.706375
  type: 'test'
  ...
# Subtest: UID_FAMILY_MAP: every mapped value except "excluded" is a real FAMILY_PACKS family
ok 2286 - UID_FAMILY_MAP: every mapped value except "excluded" is a real FAMILY_PACKS family
  ---
  duration_ms: 0.084958
  type: 'test'
  ...
# Subtest: archetypeFor: direct pack, coarse-regex bridge, unknown→STANDARD
ok 2287 - archetypeFor: direct pack, coarse-regex bridge, unknown→STANDARD
  ---
  duration_ms: 1.790541
  type: 'test'
  ...
# Subtest: instrumentsDue: cancelled → empty
ok 2288 - instrumentsDue: cancelled → empty
  ---
  duration_ms: 0.04925
  type: 'test'
  ...
# Subtest: instrumentsDue: no discharge → pre-op (baseline) only
ok 2289 - instrumentsDue: no discharge → pre-op (baseline) only
  ---
  duration_ms: 0.071583
  type: 'test'
  ...
# Subtest: instrumentsDue: d72h window — out_of_window before, in_window at +3d, missed after close
ok 2290 - instrumentsDue: d72h window — out_of_window before, in_window at +3d, missed after close
  ---
  duration_ms: 0.116542
  type: 'test'
  ...
# Subtest: instrumentsDue: baseline — in_window before surgery, missed after
ok 2291 - instrumentsDue: baseline — in_window before surgery, missed after
  ---
  duration_ms: 0.153334
  type: 'test'
  ...
# Subtest: instrumentsDue: CORE + pack add-on + PREM scheduled (STANDARD)
ok 2292 - instrumentsDue: CORE + pack add-on + PREM scheduled (STANDARD)
  ---
  duration_ms: 0.075125
  type: 'test'
  ...
# Subtest: instrumentsDue: a Pv pack with an unconfirmed sweep uses its house fallback
ok 2293 - instrumentsDue: a Pv pack with an unconfirmed sweep uses its house fallback
  ---
  duration_ms: 0.058708
  type: 'test'
  ...
# Subtest: scoreInstrument: house simple sum; complete set scored
ok 2294 - scoreInstrument: house simple sum; complete set scored
  ---
  duration_ms: 0.207791
  type: 'test'
  ...
# Subtest: scoreInstrument: partial set → honest null
ok 2295 - scoreInstrument: partial set → honest null
  ---
  duration_ms: 0.037375
  type: 'test'
  ...
# Subtest: scoreInstrument: ⚠ items emit the escalation code
ok 2296 - scoreInstrument: ⚠ items emit the escalation code
  ---
  duration_ms: 0.212542
  type: 'test'
  ...
# Subtest: scoreInstrument: still-unfilled validated instrument → honest null (rule not encoded yet)
ok 2297 - scoreInstrument: still-unfilled validated instrument → honest null (rule not encoded yet)
  ---
  duration_ms: 0.032667
  type: 'test'
  ...
# Subtest: scoreInstrument: WHODAS-12 simple sum — full 12-item set on WHODAS5 → 0–48
ok 2298 - scoreInstrument: WHODAS-12 simple sum — full 12-item set on WHODAS5 → 0–48
  ---
  duration_ms: 0.107917
  type: 'test'
  ...
# Subtest: scoreInstrument: WHODAS-12 — incomplete (<12 mapped) → honest null
ok 2299 - scoreInstrument: WHODAS-12 — incomplete (<12 mapped) → honest null
  ---
  duration_ms: 0.041167
  type: 'test'
  ...
# Subtest: catalog: whodas12 has exactly 12 items, each on WHODAS5
ok 2300 - catalog: whodas12 has exactly 12 items, each on WHODAS5
  ---
  duration_ms: 0.039
  type: 'test'
  ...
# Subtest: scoreInstrument: PREM experience sum of items 1–7 (EXP4 0–3); item 8 excluded; 0–21
ok 2301 - scoreInstrument: PREM experience sum of items 1–7 (EXP4 0–3); item 8 excluded; 0–21
  ---
  duration_ms: 0.203333
  type: 'test'
  ...
# Subtest: scoreInstrument: PREM partial (an EXP4 item missing) → honest null
ok 2302 - scoreInstrument: PREM partial (an EXP4 item missing) → honest null
  ---
  duration_ms: 0.044917
  type: 'test'
  ...
# Subtest: catalog: PREM_MODULE has 8 items (prem1..prem7 EXP4, prem8 NRS-11); service flag present
ok 2303 - catalog: PREM_MODULE has 8 items (prem1..prem7 EXP4, prem8 NRS-11); service flag present
  ---
  duration_ms: 0.057583
  type: 'test'
  ...
# Subtest: catalog: WHODAS5 + EXP4 registered in SHARED_SCALES; every WHODAS/PREM item scale resolves
ok 2304 - catalog: WHODAS5 + EXP4 registered in SHARED_SCALES; every WHODAS/PREM item scale resolves
  ---
  duration_ms: 0.087792
  type: 'test'
  ...
# Subtest: integrity: every FamilyPack primary/fallback resolves to a known instrument
ok 2305 - integrity: every FamilyPack primary/fallback resolves to a known instrument
  ---
  duration_ms: 0.060667
  type: 'test'
  ...
# Subtest: integrity: every HOUSE item uses a SHARED_SCALES scale
ok 2306 - integrity: every HOUSE item uses a SHARED_SCALES scale
  ---
  duration_ms: 0.669
  type: 'test'
  ...
# Subtest: integrity: ARCHETYPE_WINDOWS + PREM_POINTS complete for all 5 archetypes
ok 2307 - integrity: ARCHETYPE_WINDOWS + PREM_POINTS complete for all 5 archetypes
  ---
  duration_ms: 0.085917
  type: 'test'
  ...
# Subtest: integrity: every house item scale has response options; whodas12 now carries its 12 items
ok 2308 - integrity: every house item scale has response options; whodas12 now carries its 12 items
  ---
  duration_ms: 0.061667
  type: 'test'
  ...
# Subtest: 2b scoring: koos_jr / hoos_jr interval-table lookup (higher = better)
ok 2309 - 2b scoring: koos_jr / hoos_jr interval-table lookup (higher = better)
  ---
  duration_ms: 0.125584
  type: 'test'
  ...
# Subtest: 2b scoring: spadi total %, ndi sum, nose ×5, ipss qol-excluded, nyha class, rmdq count
ok 2310 - 2b scoring: spadi total %, ndi sum, nose ×5, ipss qol-excluded, nyha class, rmdq count
  ---
  duration_ms: 0.106084
  type: 'test'
  ...
# Subtest: 2b scoring: partial responses → null (koos_jr/hoos_jr/spadi/ndi/ipss/nose/nyha)
ok 2311 - 2b scoring: partial responses → null (koos_jr/hoos_jr/spadi/ndi/ipss/nose/nyha)
  ---
  duration_ms: 0.11475
  type: 'test'
  ...
# Subtest: 2b catalog integrity: scales present, item counts, scales resolve, 2 lic corrections
ok 2312 - 2b catalog integrity: scales present, item counts, scales resolve, 2 lic corrections
  ---
  duration_ms: 0.189709
  type: 'test'
  ...
# Subtest: 2a selection: each Pv family selects its hs-set fallback (not the unconfirmed primary)
ok 2313 - 2a selection: each Pv family selects its hs-set fallback (not the unconfirmed primary)
  ---
  duration_ms: 0.190917
  type: 'test'
  ...
# Subtest: 2a scoring: complete house set → numeric sum (scale house); partial → honest null
ok 2314 - 2a scoring: complete house set → numeric sum (scale house); partial → honest null
  ---
  duration_ms: 0.106584
  type: 'test'
  ...
# Subtest: 2a escalation: red-flag responses fire the expected code
ok 2315 - 2a escalation: red-flag responses fire the expected code
  ---
  duration_ms: 0.052
  type: 'test'
  ...
# Subtest: 2a integrity: 3 new scales verbatim; every hs-set option value resolves in SHARED_SCALES
ok 2316 - 2a integrity: 3 new scales verbatim; every hs-set option value resolves in SHARED_SCALES
  ---
  duration_ms: 0.169166
  type: 'test'
  ...
# Subtest: determinism: classify / instrumentsDue / score twice → deep-equal
ok 2317 - determinism: classify / instrumentsDue / score twice → deep-equal
  ---
  duration_ms: 0.117417
  type: 'test'
  ...
# Subtest: tier3 versions + max are stamped
ok 2318 - tier3 versions + max are stamped
  ---
  duration_ms: 0.583541
  type: 'test'
  ...
# Subtest: compileItemBank is deterministic (twice → deep-equal)
ok 2319 - compileItemBank is deterministic (twice → deep-equal)
  ---
  duration_ms: 0.731584
  type: 'test'
  ...
# Subtest: bank is house-only: no validated-instrument id leaks in
ok 2320 - bank is house-only: no validated-instrument id leaks in
  ---
  duration_ms: 0.094292
  type: 'test'
  ...
# Subtest: bank is house-only: no PREM id leaks in
ok 2321 - bank is house-only: no PREM id leaks in
  ---
  duration_ms: 0.135833
  type: 'test'
  ...
# Subtest: every bank item is sourced from an hs-set (never a validated set or PREM)
ok 2322 - every bank item is sourced from an hs-set (never a validated set or PREM)
  ---
  duration_ms: 0.098333
  type: 'test'
  ...
# Subtest: bank ids are unique (dedupe holds)
ok 2323 - bank ids are unique (dedupe holds)
  ---
  duration_ms: 0.066
  type: 'test'
  ...
# Subtest: bank covers all 21 hs-sets (item count = Σ set items, deduped)
ok 2324 - bank covers all 21 hs-sets (item count = Σ set items, deduped)
  ---
  duration_ms: 0.177
  type: 'test'
  ...
# Subtest: bankById is first-wins and complete
ok 2325 - bankById is first-wins and complete
  ---
  duration_ms: 0.130666
  type: 'test'
  ...
# Subtest: every bank item scale exists in SHARED_SCALES
ok 2326 - every bank item scale exists in SHARED_SCALES
  ---
  duration_ms: 0.235
  type: 'test'
  ...
# Subtest: validate drops unknown ids
ok 2327 - validate drops unknown ids
  ---
  duration_ms: 2.315583
  type: 'test'
  ...
# Subtest: validate dedupes repeated ids
ok 2328 - validate dedupes repeated ids
  ---
  duration_ms: 0.592291
  type: 'test'
  ...
# Subtest: validate caps at ADHOC_MAX_ITEMS, preserving order
ok 2329 - validate caps at ADHOC_MAX_ITEMS, preserving order
  ---
  duration_ms: 0.085792
  type: 'test'
  ...
# Subtest: validate: zero valid ids → empty set
ok 2330 - validate: zero valid ids → empty set
  ---
  duration_ms: 0.061167
  type: 'test'
  ...
# Subtest: validate preserves selection order
ok 2331 - validate preserves selection order
  ---
  duration_ms: 0.06275
  type: 'test'
  ...
# Subtest: validate is deterministic (twice → deep-equal)
ok 2332 - validate is deterministic (twice → deep-equal)
  ---
  duration_ms: 0.072166
  type: 'test'
  ...
# Subtest: scoreAdhocSet: house-sum correct on a fixture
ok 2333 - scoreAdhocSet: house-sum correct on a fixture
  ---
  duration_ms: 0.216917
  type: 'test'
  ...
# Subtest: scoreAdhocSet: any item unanswered → null (complete-gate)
ok 2334 - scoreAdhocSet: any item unanswered → null (complete-gate)
  ---
  duration_ms: 0.082209
  type: 'test'
  ...
# Subtest: scoreAdhocSet: a ⚠ item surfaces its escalation code
ok 2335 - scoreAdhocSet: a ⚠ item surfaces its escalation code
  ---
  duration_ms: 0.132667
  type: 'test'
  ...
# Subtest: ADHOC_GEN_PROMPT is present, selection-only, never-invent
ok 2336 - ADHOC_GEN_PROMPT is present, selection-only, never-invent
  ---
  duration_ms: 0.126459
  type: 'test'
  ...
# Subtest: regression: 21 sets — all-index-0 → score 0, escalations match the oracle
ok 2337 - regression: 21 sets — all-index-0 → score 0, escalations match the oracle
  ---
  duration_ms: 0.632833
  type: 'test'
  ...
# Subtest: regression: 21 sets — complete-midpoint (all index 1) → score = item count
ok 2338 - regression: 21 sets — complete-midpoint (all index 1) → score = item count
  ---
  duration_ms: 0.094042
  type: 'test'
  ...
# Subtest: regression: 21 sets — any item unanswered → null
ok 2339 - regression: 21 sets — any item unanswered → null
  ---
  duration_ms: 0.082709
  type: 'test'
  ...
# Subtest: regression: 21 sets — red-flag escalations match the oracle AND kernel/adhoc agree with scoreInstrument
ok 2340 - regression: 21 sets — red-flag escalations match the oracle AND kernel/adhoc agree with scoreInstrument
  ---
  duration_ms: 0.4015
  type: 'test'
  ...
# Subtest: the citation-derived labels carry the caveat, VERBATIM per the kickoff
ok 2341 - the citation-derived labels carry the caveat, VERBATIM per the kickoff
  ---
  duration_ms: 0.49075
  type: 'test'
  ...
# Subtest: deterministic_rule and no_source labels are BYTE-IDENTICAL to before
ok 2342 - deterministic_rule and no_source labels are BYTE-IDENTICAL to before
  ---
  duration_ms: 0.063667
  type: 'test'
  ...
# Subtest: all four `elevated` values are unchanged — this is wording, not ranking
ok 2343 - all four `elevated` values are unchanged — this is wording, not ranking
  ---
  duration_ms: 0.047
  type: 'test'
  ...
# Subtest: groundingKind returns the same kind for the same input as before — all four kinds
ok 2344 - groundingKind returns the same kind for the same input as before — all four kinds
  ---
  duration_ms: 0.071417
  type: 'test'
  ...
# Subtest: PROVENANCE_TIER_LABELS is byte-identical — the ledger map was not touched
ok 2345 - PROVENANCE_TIER_LABELS is byte-identical — the ledger map was not touched
  ---
  duration_ms: 0.333333
  type: 'test'
  ...
# Subtest: classifyProvenanceTier is untouched: never reads citation_ids, same verdicts on a fixture
ok 2346 - classifyProvenanceTier is untouched: never reads citation_ids, same verdicts on a fixture
  ---
  duration_ms: 0.192625
  type: 'test'
  ...
# Subtest: the page-level caveat renders ONCE per page, verbatim, in the findings area
ok 2347 - the page-level caveat renders ONCE per page, verbatim, in the findings area
  ---
  duration_ms: 0.249625
  type: 'test'
  ...
# Subtest: GREP TEST: no surface renders the bare pre-caveat strings, and the map has ONE home
ok 2348 - GREP TEST: no surface renders the bare pre-caveat strings, and the map has ONE home
  ---
  duration_ms: 118.797625
  type: 'test'
  ...
# Subtest: the label correction itself rode no bump — the version only moves for scoring changes
ok 2349 - the label correction itself rode no bump — the version only moves for scoring changes
  ---
  duration_ms: 0.324584
  type: 'test'
  ...
# Subtest: the provenance ledger page still reads ONLY the ledger map
ok 2350 - the provenance ledger page still reads ONLY the ledger map
  ---
  duration_ms: 0.343
  type: 'test'
  ...
# Subtest: clinician-signed: derivation "clinician" → clinician_signed, NEVER internal_consensus / uncited_deterministic
ok 2351 - clinician-signed: derivation "clinician" → clinician_signed, NEVER internal_consensus / uncited_deterministic
  ---
  duration_ms: 1.377041
  type: 'test'
  ...
# Subtest: clinician-signed: existing external + llm derivations route exactly as before
ok 2352 - clinician-signed: existing external + llm derivations route exactly as before
  ---
  duration_ms: 0.217084
  type: 'test'
  ...
# Subtest: MANDATORY PIN: the 44 society rules' generic choosingwisely URL does NOT resolve
ok 2353 - MANDATORY PIN: the 44 society rules' generic choosingwisely URL does NOT resolve
  ---
  duration_ms: 0.40125
  type: 'test'
  ...
# Subtest: resolving citations: DOI, PMID, instance-specific URLs
ok 2354 - resolving citations: DOI, PMID, instance-specific URLs
  ---
  duration_ms: 0.177292
  type: 'test'
  ...
# Subtest: non-resolving: null/empty, bare domains, bare resolver roots — never a mere null-check
ok 2355 - non-resolving: null/empty, bare domains, bare resolver roots — never a mere null-check
  ---
  duration_ms: 0.15875
  type: 'test'
  ...
# Subtest: rule 1: rule_ref + resolving citation → deterministic; generic/none/missing row → internal_consensus
ok 2356 - rule 1: rule_ref + resolving citation → deterministic; generic/none/missing row → internal_consensus
  ---
  duration_ms: 0.12975
  type: 'test'
  ...
# Subtest: rule 2: deterministic source without rule_ref → uncited_deterministic (even at low-value)
ok 2357 - rule 2: deterministic source without rule_ref → uncited_deterministic (even at low-value)
  ---
  duration_ms: 0.109542
  type: 'test'
  ...
# Subtest: rule 3: low-value without rule_ref → unattributed_sourceable
ok 2358 - rule 3: low-value without rule_ref → unattributed_sourceable
  ---
  duration_ms: 0.096375
  type: 'test'
  ...
# Subtest: rule 4: judgement family → inherent_judgment
ok 2359 - rule 4: judgement family → inherent_judgment
  ---
  duration_ms: 0.749125
  type: 'test'
  ...
# Subtest: rule 5 direction: unknowns default to SOURCEABLE, never to inherent (the bias runs against us)
ok 2360 - rule 5 direction: unknowns default to SOURCEABLE, never to inherent (the bias runs against us)
  ---
  duration_ms: 0.871292
  type: 'test'
  ...
# Subtest: grounding: precedence + R-7 labels verbatim; internal corpus is never elevated
ok 2361 - grounding: precedence + R-7 labels verbatim; internal corpus is never elevated
  ---
  duration_ms: 0.997292
  type: 'test'
  ...
# Subtest: corpusCitationResolves: OpenFDA null-page label resolves (§4); StatPearls/UpToDate/PubMed resolve
ok 2362 - corpusCitationResolves: OpenFDA null-page label resolves (§4); StatPearls/UpToDate/PubMed resolve
  ---
  duration_ms: 0.168
  type: 'test'
  ...
# Subtest: corpusCitationResolves: self-reference / empty / no-locator does NOT resolve
ok 2363 - corpusCitationResolves: self-reference / empty / no-locator does NOT resolve
  ---
  duration_ms: 0.119584
  type: 'test'
  ...
# Subtest: deterministic finding with a resolving corpus citation → deterministic
ok 2364 - deterministic finding with a resolving corpus citation → deterministic
  ---
  duration_ms: 0.10775
  type: 'test'
  ...
# Subtest: deterministic finding marked llm → internal_consensus
ok 2365 - deterministic finding marked llm → internal_consensus
  ---
  duration_ms: 0.0905
  type: 'test'
  ...
# Subtest: S1 (0.81.10): muscle_relaxant_indication → deterministic_completeness (documentation prompt, same class as incomplete_dosing)
ok 2366 - S1 (0.81.10): muscle_relaxant_indication → deterministic_completeness (documentation prompt, same class as incomplete_dosing)
  ---
  duration_ms: 0.198375
  type: 'test'
  ...
# Subtest: 0.81.14: vitamin_d_repletion_duration + pregnancy_risk_verify → deterministic_completeness (documentation prompts)
ok 2367 - 0.81.14: vitamin_d_repletion_duration + pregnancy_risk_verify → deterministic_completeness (documentation prompts)
  ---
  duration_ms: 0.090584
  type: 'test'
  ...
# Subtest: V1/V2: incomplete_dosing → deterministic_completeness; duplicate_* → deterministic_logical
ok 2368 - V1/V2: incomplete_dosing → deterministic_completeness; duplicate_* → deterministic_logical
  ---
  duration_ms: 0.086042
  type: 'test'
  ...
# Subtest: §3.3 unreachability: an in-scope deterministic signal type that carries provenance is NEVER uncited_deterministic
ok 2369 - §3.3 unreachability: an in-scope deterministic signal type that carries provenance is NEVER uncited_deterministic
  ---
  duration_ms: 0.148625
  type: 'test'
  ...
# Subtest: bedrock is in LAB_PROVIDERS, and the other three are untouched
ok 2370 - bedrock is in LAB_PROVIDERS, and the other three are untouched
  ---
  duration_ms: 9.371958
  type: 'test'
  ...
# Subtest: EVERY provider has an entry for EVERY call class
ok 2371 - EVERY provider has an entry for EVERY call class
  ---
  duration_ms: 0.226416
  type: 'test'
  ...
# Subtest: the measured table, verbatim
ok 2372 - the measured table, verbatim
  ---
  duration_ms: 0.226917
  type: 'test'
  ...
# Subtest: OLLAMA AUDIT IS SINGLE-TRY — a local box that missed the budget will not answer on a re-ask
ok 2373 - OLLAMA AUDIT IS SINGLE-TRY — a local box that missed the budget will not answer on a re-ask
  ---
  duration_ms: 0.084667
  type: 'test'
  ...
# Subtest: BOTH AUDIT CLASSES ARE SINGLE-TRY on every provider (DEC-B4, reversing Unit A)
ok 2374 - BOTH AUDIT CLASSES ARE SINGLE-TRY on every provider (DEC-B4, reversing Unit A)
  ---
  duration_ms: 0.060667
  type: 'test'
  ...
# Subtest: ollama does not serve doc_read at all — null, not a number
ok 2375 - ollama does not serve doc_read at all — null, not a number
  ---
  duration_ms: 0.049666
  type: 'test'
  ...
# Subtest: the backoff allowance is the exact upper bound of the shipped curve
ok 2376 - the backoff allowance is the exact upper bound of the shipped curve
  ---
  duration_ms: 0.119792
  type: 'test'
  ...
# Subtest: totalBudgetMs = perAttemptMs × maxTries + the backoff allowance
ok 2377 - totalBudgetMs = perAttemptMs × maxTries + the backoff allowance
  ---
  duration_ms: 0.066208
  type: 'test'
  ...
# Subtest: the allowance is never optimistic — the total is at least the naive product
ok 2378 - the allowance is never optimistic — the total is at least the naive product
  ---
  duration_ms: 0.215875
  type: 'test'
  ...
# Subtest: bedrock:anthropic.claude-x RESOLVES, and is marked paid
ok 2379 - bedrock:anthropic.claude-x RESOLVES, and is marked paid
  ---
  duration_ms: 0.348458
  type: 'test'
  ...
# Subtest: …and it PROBES REACHABLE only when the WHOLE OIDC chain is configured
ok 2380 - …and it PROBES REACHABLE only when the WHOLE OIDC chain is configured
  ---
  duration_ms: 0.192208
  type: 'test'
  ...
# Subtest: an unknown prefix STILL errors and never falls back
ok 2381 - an unknown prefix STILL errors and never falls back
  ---
  duration_ms: 0.068375
  type: 'test'
  ...
# Subtest: EXISTING resolution semantics are untouched
ok 2382 - EXISTING resolution semantics are untouched
  ---
  duration_ms: 0.084708
  type: 'test'
  ...
# Subtest: the paid ceiling is untouched
ok 2383 - the paid ceiling is untouched
  ---
  duration_ms: 0.074334
  type: 'test'
  ...
# Subtest: RESOLVED BY UNIT D: one audit leg now fits the worker box it runs in
ok 2384 - RESOLVED BY UNIT D: one audit leg now fits the worker box it runs in
  ---
  duration_ms: 0.039292
  type: 'test'
  ...
# Subtest: §4.1: a Vertex 403 body survives whole — status, message, details all captured
ok 2385 - §4.1: a Vertex 403 body survives whole — status, message, details all captured
  ---
  duration_ms: 0.610042
  type: 'test'
  ...
# Subtest: §4.1: the cap is 4000, not 200 — a diagnostic longer than 200 chars survives
ok 2386 - §4.1: the cap is 4000, not 200 — a diagnostic longer than 200 chars survives
  ---
  duration_ms: 0.0785
  type: 'test'
  ...
# Subtest: §4.1: nested {error:{error:{…}}} unwraps; plain Error and junk degrade safely, never throw
ok 2387 - §4.1: nested {error:{error:{…}}} unwraps; plain Error and junk degrade safely, never throw
  ---
  duration_ms: 0.113709
  type: 'test'
  ...
# Subtest: §4.2: begin/end account per provider; snapshot totals; end floors at 0
ok 2388 - §4.2: begin/end account per provider; snapshot totals; end floors at 0
  ---
  duration_ms: 0.400667
  type: 'test'
  ...
# Subtest: §4.2: providerErrorPayload carries inFlightAtError + provider/label/fellBackTo + the serialised error
ok 2389 - §4.2: providerErrorPayload carries inFlightAtError + provider/label/fellBackTo + the serialised error
  ---
  duration_ms: 0.09325
  type: 'test'
  ...
# Subtest: §4.1: the 200-char truncation is GONE from every provider-error path
ok 2390 - §4.1: the 200-char truncation is GONE from every provider-error path
  ---
  duration_ms: 0.09675
  type: 'test'
  ...
# Subtest: §4.3: the fallback is LOUD — console.error with the stable [provider-fallback] prefix, console.warn gone
ok 2391 - §4.3: the fallback is LOUD — console.error with the stable [provider-fallback] prefix, console.warn gone
  ---
  duration_ms: 0.129125
  type: 'test'
  ...
# Subtest: §4.2: both tracedChat catches emit a provider_error event through the existing logEvent path
ok 2392 - §4.2: both tracedChat catches emit a provider_error event through the existing logEvent path
  ---
  duration_ms: 0.080083
  type: 'test'
  ...
# Subtest: §4.2: the in-flight snapshot is taken BEFORE the decrement — the failing call counts itself
ok 2393 - §4.2: the in-flight snapshot is taken BEFORE the decrement — the failing call counts itself
  ---
  duration_ms: 0.175708
  type: 'test'
  ...
# Subtest: the payload names model, region and SA identity — and the SA getter exposes client_email ONLY
ok 2394 - the payload names model, region and SA identity — and the SA getter exposes client_email ONLY
  ---
  duration_ms: 0.706041
  type: 'test'
  ...
# Subtest: §5 superseded for OpenRouter ONLY by addendum F v2: retry exists, but ONLY via the shared policy module
ok 2395 - §5 superseded for OpenRouter ONLY by addendum F v2: retry exists, but ONLY via the shared policy module
  ---
  duration_ms: 0.181917
  type: 'test'
  ...
# Subtest: §5.2: a good response is NOT reclassified — including a one-character answer
ok 2396 - §5.2: a good response is NOT reclassified — including a one-character answer
  ---
  duration_ms: 0.166417
  type: 'test'
  ...
# Subtest: §2.1: the three failure rules — no choices, empty content, unusable finish_reason
ok 2397 - §2.1: the three failure rules — no choices, empty content, unusable finish_reason
  ---
  duration_ms: 0.091459
  type: 'test'
  ...
# Subtest: §2.1: a STREAM is never judged — it has no choices yet and would fail every rule
ok 2398 - §2.1: a STREAM is never judged — it has no choices yet and would fail every rule
  ---
  duration_ms: 0.048
  type: 'test'
  ...
# Subtest: §2.2: the event carries the FULL body, both finish reasons, the served endpoint and the error object
ok 2399 - §2.2: the event carries the FULL body, both finish reasons, the served endpoint and the error object
  ---
  duration_ms: 0.237375
  type: 'test'
  ...
# Subtest: §5.1: the caller sees a FAILURE, not an empty string — and the error is marked, not laundered
ok 2400 - §5.1: the caller sees a FAILURE, not an empty string — and the error is marked, not laundered
  ---
  duration_ms: 0.098459
  type: 'test'
  ...
# Subtest: §2.2/§2.3: the response is validated per attempt, the event is emitted, and the bad-200 path DOES NOT fall back
ok 2401 - §2.2/§2.3: the response is validated per attempt, the event is emitted, and the bad-200 path DOES NOT fall back
  ---
  duration_ms: 0.229542
  type: 'test'
  ...
# Subtest: §2.1: the check runs only when the provider actually served — never after a fallback
ok 2402 - §2.1: the check runs only when the provider actually served — never after a fallback
  ---
  duration_ms: 0.053125
  type: 'test'
  ...
# Subtest: §6 out of scope: no retry, no backoff, and the Google provider pin is untouched
ok 2403 - §6 out of scope: no retry, no backoff, and the Google provider pin is untouched
  ---
  duration_ms: 0.100584
  type: 'test'
  ...
# Subtest: modelsAgree: served matches intended across provider prefixes (verdict KEPT)
ok 2404 - modelsAgree: served matches intended across provider prefixes (verdict KEPT)
  ---
  duration_ms: 0.509708
  type: 'test'
  ...
# Subtest: modelsAgree: a silent drop to the local Ollama model is a MISMATCH (verdict EXCLUDED)
ok 2405 - modelsAgree: a silent drop to the local Ollama model is a MISMATCH (verdict EXCLUDED)
  ---
  duration_ms: 0.118125
  type: 'test'
  ...
# Subtest: guard both directions: Qwen kept, Ollama fallback flagged — the SL2 regression
ok 2406 - guard both directions: Qwen kept, Ollama fallback flagged — the SL2 regression
  ---
  duration_ms: 0.059958
  type: 'test'
  ...
# Subtest: every provider has a budget for every call class, and the classes are the four
ok 2407 - every provider has a budget for every call class, and the classes are the four
  ---
  duration_ms: 0.84775
  type: 'test'
  ...
# Subtest: audit_ipd exists on every provider and ollama serves it
ok 2408 - audit_ipd exists on every provider and ollama serves it
  ---
  duration_ms: 0.095417
  type: 'test'
  ...
# Subtest: the published totals are exactly what the arithmetic in the PRD says
ok 2409 - the published totals are exactly what the arithmetic in the PRD says
  ---
  duration_ms: 0.086
  type: 'test'
  ...
# Subtest: BOTH audit classes are one try on every provider — the ladder is multiplicative
ok 2410 - BOTH audit classes are one try on every provider — the ladder is multiplicative
  ---
  duration_ms: 0.048916
  type: 'test'
  ...
# Subtest: analyzeCase accepts a budget and passes it down BOTH arms of the generate closure
ok 2411 - analyzeCase accepts a budget and passes it down BOTH arms of the generate closure
  ---
  duration_ms: 0.206208
  type: 'test'
  ...
# Subtest: the IPD callers read the budget from the TABLE, never as literals in their own file
ok 2412 - the IPD callers read the budget from the TABLE, never as literals in their own file
  ---
  duration_ms: 0.112042
  type: 'test'
  ...
# Subtest: a null budget throws rather than substituting a default
ok 2413 - a null budget throws rather than substituting a default
  ---
  duration_ms: 0.10525
  type: 'test'
  ...
# Subtest: the OPD audit call site sends a maxTries taken from the budget
ok 2414 - the OPD audit call site sends a maxTries taken from the budget
  ---
  duration_ms: 0.085625
  type: 'test'
  ...
# Subtest: ipd-audit-now records what SERVED — the constant model is gone
ok 2415 - ipd-audit-now records what SERVED — the constant model is gone
  ---
  duration_ms: 0.201709
  type: 'test'
  ...
# Subtest: ipd-audit-now got the box its work actually needs (DEC-B5)
ok 2416 - ipd-audit-now got the box its work actually needs (DEC-B5)
  ---
  duration_ms: 0.299583
  type: 'test'
  ...
# Subtest: PROVIDER_SWITCH_ENABLED defaults OFF and is read at call time
ok 2417 - PROVIDER_SWITCH_ENABLED defaults OFF and is read at call time
  ---
  duration_ms: 0.078041
  type: 'test'
  ...
# Subtest: both workers gate ?provider= AND errors-loud behind the flag
ok 2418 - both workers gate ?provider= AND errors-loud behind the flag
  ---
  duration_ms: 0.394708
  type: 'test'
  ...
# Subtest: DEC-2 writes NO ROW rather than a laundered one, and never fires on a mini run
ok 2419 - DEC-2 writes NO ROW rather than a laundered one, and never fires on a mini run
  ---
  duration_ms: 0.150125
  type: 'test'
  ...
# Subtest: a provider that cannot serve a class is REFUSED, not defaulted
ok 2420 - a provider that cannot serve a class is REFUSED, not defaulted
  ---
  duration_ms: 0.96575
  type: 'test'
  ...
# Subtest: resolveWorkerProvider errors loud and never falls back
ok 2421 - resolveWorkerProvider errors loud and never falls back
  ---
  duration_ms: 0.619667
  type: 'test'
  ...
# Subtest: the view is created idempotently beside the other two
ok 2422 - the view is created idempotently beside the other two
  ---
  duration_ms: 0.130166
  type: 'test'
  ...
# Subtest: ⚠️ payload IS EXCLUDED — it is the only PHI-bearing column on the table
ok 2423 - ⚠️ payload IS EXCLUDED — it is the only PHI-bearing column on the table
  ---
  duration_ms: 0.217167
  type: 'test'
  ...
# Subtest: tokens_out is present — it is the determinism observable, not a bonus column
ok 2424 - tokens_out is present — it is the determinism observable, not a bonus column
  ---
  duration_ms: 0.5175
  type: 'test'
  ...
# Subtest: call_model / call_provider are read as REAL COLUMNS, not out of payload
ok 2425 - call_model / call_provider are read as REAL COLUMNS, not out of payload
  ---
  duration_ms: 0.079375
  type: 'test'
  ...
# Subtest: THE NAME PASSES THE SQL GUARD WITHOUT lib/sql-guard-core.ts CHANGING
ok 2426 - THE NAME PASSES THE SQL GUARD WITHOUT lib/sql-guard-core.ts CHANGING
  ---
  duration_ms: 0.651833
  type: 'test'
  ...
# Subtest: lib/sql-guard-core.ts was NOT edited by this build
ok 2427 - lib/sql-guard-core.ts was NOT edited by this build
  ---
  duration_ms: 0.0905
  type: 'test'
  ...
# Subtest: exactly one cron entry moved, and it is the OPD worker path
ok 2428 - exactly one cron entry moved, and it is the OPD worker path
  ---
  duration_ms: 0.243834
  type: 'test'
  ...
# Subtest: quantizeConfidence is DELETED — the function, its export, and every call
ok 2429 - quantizeConfidence is DELETED — the function, its export, and every call
  ---
  duration_ms: 0.513375
  type: 'test'
  ...
# Subtest: findingPenalty is the target text VERBATIM — raw clamped float, no level cliff
ok 2430 - findingPenalty is the target text VERBATIM — raw clamped float, no level cliff
  ---
  duration_ms: 0.082667
  type: 'test'
  ...
# Subtest: the penalty is CONTINUOUS in confidence again — the 0.80 cliff is gone
ok 2431 - the penalty is CONTINUOUS in confidence again — the 0.80 cliff is gone
  ---
  duration_ms: 0.523375
  type: 'test'
  ...
# Subtest: THE KEPT BEHAVIOUR: junk confidence lands on the scale, not outside it
ok 2432 - THE KEPT BEHAVIOUR: junk confidence lands on the scale, not outside it
  ---
  duration_ms: 0.200958
  type: 'test'
  ...
# Subtest: the pre-S1 arithmetic is restored exactly: the triple-QT canary computes 26 again
ok 2433 - the pre-S1 arithmetic is restored exactly: the triple-QT canary computes 26 again
  ---
  duration_ms: 0.0945
  type: 'test'
  ...
# Subtest: PENALTY_BASE, SEVERITY and bandFor are byte-identical
ok 2434 - PENALTY_BASE, SEVERITY and bandFor are byte-identical
  ---
  duration_ms: 0.36725
  type: 'test'
  ...
# Subtest: hysteresis is ENDORSED and untouched: g, the rule, and the store CASE all stand
ok 2435 - hysteresis is ENDORSED and untouched: g, the rule, and the store CASE all stand
  ---
  duration_ms: 0.271375
  type: 'test'
  ...
# Subtest: engine is current and the family includes it (decision 21 — no orphaned corpus)
ok 2436 - engine is current and the family includes it (decision 21 — no orphaned corpus)
  ---
  duration_ms: 0.061458
  type: 'test'
  ...
# Subtest: pairs A→B→C into (A,B) and (B,C)
ok 2437 - pairs A→B→C into (A,B) and (B,C)
  ---
  duration_ms: 0.999667
  type: 'test'
  ...
# Subtest: no pair beyond 90 days; exactly 90 days is IN the window
ok 2438 - no pair beyond 90 days; exactly 90 days is IN the window
  ---
  duration_ms: 0.094042
  type: 'test'
  ...
# Subtest: same-day / overlapping admissions never pair; ER encounters never pair
ok 2439 - same-day / overlapping admissions never pair; ER encounters never pair
  ---
  duration_ms: 0.152042
  type: 'test'
  ...
# Subtest: tight_7d / within_30d boundaries
ok 2440 - tight_7d / within_30d boundaries
  ---
  duration_ms: 1.676
  type: 'test'
  ...
# Subtest: structural_bounce = same department OR same doctor
ok 2441 - structural_bounce = same department OR same doctor
  ---
  duration_ms: 0.100958
  type: 'test'
  ...
# Subtest: er_route via admission_type Emergency and via an ER encounter within 48h
ok 2442 - er_route via admission_type Emergency and via an ER encounter within 48h
  ---
  duration_ms: 0.100125
  type: 'test'
  ...
# Subtest: excluded_category fires on EITHER side, exact live strings
ok 2443 - excluded_category fires on EITHER side, exact live strings
  ---
  duration_ms: 0.157208
  type: 'test'
  ...
# Subtest: lane precedence: excluded → er_routed → tight_bounce → structural_30d → other
ok 2444 - lane precedence: excluded → er_routed → tight_bounce → structural_30d → other
  ---
  duration_ms: 0.066083
  type: 'test'
  ...
# Subtest: dedup keys: stable for the same pair, distinct for different pairs and classes
ok 2445 - dedup keys: stable for the same pair, distinct for different pairs and classes
  ---
  duration_ms: 0.212583
  type: 'test'
  ...
# Subtest: duplicate-MRN reconcile fires only on name AND dob — never on a shared identifier alone
ok 2446 - duplicate-MRN reconcile fires only on name AND dob — never on a shared identifier alone
  ---
  duration_ms: 0.376875
  type: 'test'
  ...
# Subtest: form within ±5d of a KX readmit dedupes into the pair and attaches the CM note
ok 2447 - form within ±5d of a KX readmit dedupes into the pair and attaches the CM note
  ---
  duration_ms: 0.251667
  type: 'test'
  ...
# Subtest: form with an Even index stay but NO matching KX readmit is out-of-network, index-side
ok 2448 - form with an Even index stay but NO matching KX readmit is out-of-network, index-side
  ---
  duration_ms: 0.102875
  type: 'test'
  ...
# Subtest: form patients with no Even IP stay are OUT of scope; blank readmission_date is counted, not audited
ok 2449 - form patients with no Even IP stay are OUT of scope; blank readmission_date is counted, not audited
  ---
  duration_ms: 0.052875
  type: 'test'
  ...
# Subtest: ADT mapping priority: the live-validated column wins each candidate list
ok 2450 - ADT mapping priority: the live-validated column wins each candidate list
  ---
  duration_ms: 0.117709
  type: 'test'
  ...
# Subtest: detectReadmissions lane counts + within-30 subset
ok 2451 - detectReadmissions lane counts + within-30 subset
  ---
  duration_ms: 0.063375
  type: 'test'
  ...
# Subtest: planned counts only when foreshadowed in the INDEX summary
ok 2452 - planned counts only when foreshadowed in the INDEX summary
  ---
  duration_ms: 1.770041
  type: 'test'
  ...
# Subtest: planned asserted ONLY in the readmit summary does NOT make it planned
ok 2453 - planned asserted ONLY in the readmit summary does NOT make it planned
  ---
  duration_ms: 0.218292
  type: 'test'
  ...
# Subtest: near-discharge abnormal → high-confidence omission
ok 2454 - near-discharge abnormal → high-confidence omission
  ---
  duration_ms: 0.137125
  type: 'test'
  ...
# Subtest: admission-only labs → lower-confidence, clearly-labelled — never a hard "discharged unstable"
ok 2455 - admission-only labs → lower-confidence, clearly-labelled — never a hard "discharged unstable"
  ---
  duration_ms: 0.125083
  type: 'test'
  ...
# Subtest: missing labs → prose-only track; "no contradicting lab" is NEVER "confirmed stable"
ok 2456 - missing labs → prose-only track; "no contradicting lab" is NEVER "confirmed stable"
  ---
  duration_ms: 0.1845
  type: 'test'
  ...
# Subtest: labTimingProfile: short_stay / has_late_labs / admission_only / no_labs
ok 2457 - labTimingProfile: short_stay / has_late_labs / admission_only / no_labs
  ---
  duration_ms: 0.076209
  type: 'test'
  ...
# Subtest: an uncorroborated exculpatory claim does NOT clear a flagged case
ok 2458 - an uncorroborated exculpatory claim does NOT clear a flagged case
  ---
  duration_ms: 0.169958
  type: 'test'
  ...
# Subtest: a disinterested corroborator makes the exculpatory claim count
ok 2459 - a disinterested corroborator makes the exculpatory claim count
  ---
  duration_ms: 0.09075
  type: 'test'
  ...
# Subtest: same-condition decided on the analyte bundle even when the model followed the renamed diagnosis string
ok 2460 - same-condition decided on the analyte bundle even when the model followed the renamed diagnosis string
  ---
  duration_ms: 0.563833
  type: 'test'
  ...
# Subtest: analyte helpers: canonicalisation, ranges, bundles
ok 2461 - analyte helpers: canonicalisation, ranges, bundles
  ---
  duration_ms: 0.907708
  type: 'test'
  ...
# Subtest: two-pass: same verdict + overlapping evidence ids → avoidable emitted
ok 2462 - two-pass: same verdict + overlapping evidence ids → avoidable emitted
  ---
  duration_ms: 0.075917
  type: 'test'
  ...
# Subtest: two-pass: same verdict + DISJOINT evidence → needs_adjudication
ok 2463 - two-pass: same verdict + DISJOINT evidence → needs_adjudication
  ---
  duration_ms: 0.056208
  type: 'test'
  ...
# Subtest: two-pass: disagreeing verdicts → needs_adjudication; avoidable on interested evidence alone → needs_adjudication
ok 2464 - two-pass: disagreeing verdicts → needs_adjudication; avoidable on interested evidence alone → needs_adjudication
  ---
  duration_ms: 0.060125
  type: 'test'
  ...
# Subtest: hallucinated evidence ids are dropped before the overlap test
ok 2465 - hallucinated evidence ids are dropped before the overlap test
  ---
  duration_ms: 0.038
  type: 'test'
  ...
# Subtest: a verdict resting only on treating-team prose auto-routes to human review
ok 2466 - a verdict resting only on treating-team prose auto-routes to human review
  ---
  duration_ms: 0.119792
  type: 'test'
  ...
# Subtest: lane-D condition pass: SAME condition sets promoteToFull; different does not
ok 2467 - lane-D condition pass: SAME condition sets promoteToFull; different does not
  ---
  duration_ms: 0.11775
  type: 'test'
  ...
# Subtest: out-of-network: index-side only, NO avoidable verdict, identity always resolved, patient-reported stated
ok 2468 - out-of-network: index-side only, NO avoidable verdict, identity always resolved, patient-reported stated
  ---
  duration_ms: 0.16425
  type: 'test'
  ...
# Subtest: out-of-network planned may come from the CM form flag
ok 2469 - out-of-network planned may come from the CM form flag
  ---
  duration_ms: 0.044
  type: 'test'
  ...
# Subtest: parsePassClaims: fenced JSON with prose around it parses; junk returns null (fail-safe)
ok 2470 - parsePassClaims: fenced JSON with prose around it parses; junk returns null (fail-safe)
  ---
  duration_ms: 0.244084
  type: 'test'
  ...
# Subtest: extractJsonObject survives nested braces and invalid verdict values are dropped, not guessed
ok 2471 - extractJsonObject survives nested braces and invalid verdict values are dropped, not guessed
  ---
  duration_ms: 0.097709
  type: 'test'
  ...
# Subtest: tier routing: structured labs in window → tier1; none → tier2; no index case → tier3
ok 2472 - tier routing: structured labs in window → tier1; none → tier2; no index case → tier3
  ---
  duration_ms: 2.200375
  type: 'test'
  ...
# Subtest: inferLabTier reads a catalog for pre-1.5 callers: structured lab → tier1, narrative only → tier2, nothing → tier3
ok 2473 - inferLabTier reads a catalog for pre-1.5 callers: structured lab → tier1, narrative only → tier2, nothing → tier3
  ---
  duration_ms: 2.636541
  type: 'test'
  ...
# Subtest: tier-1 numeric omission: index "stable" contradicted by an abnormal value near discharge → high-confidence finding
ok 2474 - tier-1 numeric omission: index "stable" contradicted by an abnormal value near discharge → high-confidence finding
  ---
  duration_ms: 1.21475
  type: 'test'
  ...
# Subtest: the SAME value dated only at admission lowers the confidence and says why (§8c.3)
ok 2475 - the SAME value dated only at admission lowers the confidence and says why (§8c.3)
  ---
  duration_ms: 0.344708
  type: 'test'
  ...
# Subtest: no stability claim in the index narrative → no derived omission (there is nothing to contradict)
ok 2476 - no stability claim in the index narrative → no derived omission (there is nothing to contradict)
  ---
  duration_ms: 0.103291
  type: 'test'
  ...
# Subtest: only the LATEST value at/before discharge is audited — a corrected analyte is not flagged
ok 2477 - only the LATEST value at/before discharge is audited — a corrected analyte is not flagged
  ---
  duration_ms: 0.1485
  type: 'test'
  ...
# Subtest: a value drawn AFTER discharge cannot be an omission — the discharge decision could not have known it
ok 2478 - a value drawn AFTER discharge cannot be an omission — the discharge decision could not have known it
  ---
  duration_ms: 0.060166
  type: 'test'
  ...
# Subtest: the derived audit runs ONLY on an explicitly stated tier 1, never on an inferred one
ok 2479 - the derived audit runs ONLY on an explicitly stated tier 1, never on an inferred one
  ---
  duration_ms: 0.074333
  type: 'test'
  ...
# Subtest: stability claims are the discharge-condition kind, not any use of the word
ok 2480 - stability claims are the discharge-condition kind, not any use of the word
  ---
  duration_ms: 0.173541
  type: 'test'
  ...
# Subtest: tier 2 caps an omission at moderate — a summary-vs-summary contradiction is never high-confidence
ok 2481 - tier 2 caps an omission at moderate — a summary-vs-summary contradiction is never high-confidence
  ---
  duration_ms: 0.353917
  type: 'test'
  ...
# Subtest: tier 3 emits no omissions at all and records the refusal
ok 2482 - tier 3 emits no omissions at all and records the refusal
  ---
  duration_ms: 0.161416
  type: 'test'
  ...
# Subtest: only a STRUCTURED value can corroborate a stability claim
ok 2483 - only a STRUCTURED value can corroborate a stability claim
  ---
  duration_ms: 0.150709
  type: 'test'
  ...
# Subtest: the range is a JSON OBJECT: bounds come from .l/.h numerically
ok 2484 - the range is a JSON OBJECT: bounds come from .l/.h numerically
  ---
  duration_ms: 0.32025
  type: 'test'
  ...
# Subtest: an UNPARSEABLE range yields no numeric flag — never a guessed one
ok 2485 - an UNPARSEABLE range yields no numeric flag — never a guessed one
  ---
  duration_ms: 0.198542
  type: 'test'
  ...
# Subtest: an abnormal value against the live object range flags; an in-range one does not
ok 2486 - an abnormal value against the live object range flags; an in-range one does not
  ---
  duration_ms: 0.049125
  type: 'test'
  ...
# Subtest: a value whose range will not parse produces NO derived omission, even under an explicit tier 1
ok 2487 - a value whose range will not parse produces NO derived omission, even under an explicit tier 1
  ---
  duration_ms: 0.084208
  type: 'test'
  ...
# Subtest: refRangeDisplay prefers the lab's own wording over our reconstruction
ok 2488 - refRangeDisplay prefers the lab's own wording over our reconstruction
  ---
  duration_ms: 0.068166
  type: 'test'
  ...
# Subtest: the analyte-name matcher handles the real db13 names (LOINC is absent, so this is the primary path)
ok 2489 - the analyte-name matcher handles the real db13 names (LOINC is absent, so this is the primary path)
  ---
  duration_ms: 0.531208
  type: 'test'
  ...
# Subtest: with loinc_id absent the NAME decides; the code is only the fallback
ok 2490 - with loinc_id absent the NAME decides; the code is only the fallback
  ---
  duration_ms: 0.055667
  type: 'test'
  ...
# Subtest: the LOINC table still resolves where a code exists — kept as the fallback, not the primary path
ok 2491 - the LOINC table still resolves where a code exists — kept as the fallback, not the primary path
  ---
  duration_ms: 0.090958
  type: 'test'
  ...
# Subtest: a renamed diagnosis cannot move the organ bundle: same failing organ both sides → SAME condition
ok 2492 - a renamed diagnosis cannot move the organ bundle: same failing organ both sides → SAME condition
  ---
  duration_ms: 0.219542
  type: 'test'
  ...
# Subtest: a derived omission and the model's version of the same one collapse to one row, derived winning
ok 2493 - a derived omission and the model's version of the same one collapse to one row, derived winning
  ---
  duration_ms: 0.159041
  type: 'test'
  ...
# Subtest: the tier and its provenance ride the finding for the reviewer
ok 2494 - the tier and its provenance ride the finding for the reviewer
  ---
  duration_ms: 0.1495
  type: 'test'
  ...
# Subtest: lanes render clearest-first, and an UNKNOWN lane never hides in the collapsed block
ok 2495 - lanes render clearest-first, and an UNKNOWN lane never hides in the collapsed block
  ---
  duration_ms: 0.959041
  type: 'test'
  ...
# Subtest: within a lane, needs_human_review comes first and then the most recent readmission
ok 2496 - within a lane, needs_human_review comes first and then the most recent readmission
  ---
  duration_ms: 0.214541
  type: 'test'
  ...
# Subtest: the review count is audited AND (avoidable | needs_adjudication) — nothing else
ok 2497 - the review count is audited AND (avoidable | needs_adjudication) — nothing else
  ---
  duration_ms: 0.090208
  type: 'test'
  ...
# Subtest: out-of-network never shows an avoidable verdict, and not_auditable says why
ok 2498 - out-of-network never shows an avoidable verdict, and not_auditable says why
  ---
  duration_ms: 0.071708
  type: 'test'
  ...
# Subtest: an excluded row says "Held out", never lane-D’s "No verdict"
ok 2499 - an excluded row says "Held out", never lane-D’s "No verdict"
  ---
  duration_ms: 0.13075
  type: 'test'
  ...
# Subtest: the held-out sample groups last and collapsed, with the audited lanes untouched
ok 2500 - the held-out sample groups last and collapsed, with the audited lanes untouched
  ---
  duration_ms: 0.14625
  type: 'test'
  ...
# Subtest: tiles are blind to excluded rows — the route filters, and the filter is the contract
ok 2501 - tiles are blind to excluded rows — the route filters, and the filter is the contract
  ---
  duration_ms: 0.137833
  type: 'test'
  ...
# Subtest: a badge is omitted rather than guessed — unknown planned, ambiguous department, absent tier
ok 2502 - a badge is omitted rather than guessed — unknown planned, ambiguous department, absent tier
  ---
  duration_ms: 0.491125
  type: 'test'
  ...
# Subtest: the verdict chip never borrows another verdict’s confidence
ok 2503 - the verdict chip never borrows another verdict’s confidence
  ---
  duration_ms: 0.249291
  type: 'test'
  ...
# Subtest: the 30-day rate is null without a real denominator — never a rate over a guess
ok 2504 - the 30-day rate is null without a real denominator — never a rate over a guess
  ---
  duration_ms: 0.310084
  type: 'test'
  ...
# Subtest: a failed name join degrades to the UHID, never a blank card
ok 2505 - a failed name join degrades to the UHID, never a blank card
  ---
  duration_ms: 0.815167
  type: 'test'
  ...
# Subtest: every promptRef tag across all tagged files resolves to a real registry id
ok 2506 - every promptRef tag across all tagged files resolves to a real registry id
  ---
  duration_ms: 2.108083
  type: 'test'
  ...
# Subtest: governedChat is exact delegation (transport-equivalence pin)
ok 2507 - governedChat is exact delegation (transport-equivalence pin)
  ---
  duration_ms: 0.179875
  type: 'test'
  ...
# Subtest: governance config sanity: four call patterns, three governed files, fold declared
ok 2508 - governance config sanity: four call patterns, three governed files, fold declared
  ---
  duration_ms: 9.052333
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: promptFingerprint resolves from the committed registry; unknown id → null, never a throw
ok 2509 - promptFingerprint resolves from the committed registry; unknown id → null, never a throw
  ---
  duration_ms: 0.84725
  type: 'test'
  ...
# Subtest: buildEnvelope: promptRef set → fingerprint columns; unset → call facts only
ok 2510 - buildEnvelope: promptRef set → fingerprint columns; unset → call facts only
  ---
  duration_ms: 0.125583
  type: 'test'
  ...
# Subtest: ENVELOPE_UPDATE_SQL writes exactly the ten normative columns
ok 2511 - ENVELOPE_UPDATE_SQL writes exactly the ten normative columns
  ---
  duration_ms: 0.05825
  type: 'test'
  ...
# Subtest: withTrace finalizes exactly once — on success AND on throw
ok 2512 - withTrace finalizes exactly once — on success AND on throw
  ---
  duration_ms: 0.318875
  type: 'test'
  ...
# Subtest: migration 0012 is additive + idempotent and covers every normative column
ok 2513 - migration 0012 is additive + idempotent and covers every normative column
  ---
  duration_ms: 0.384
  type: 'test'
  ...
# Subtest: governance gate (Stage 4): the repo scan is CLEAN; synthetic direct calls are flagged
ok 2514 - governance gate (Stage 4): the repo scan is CLEAN; synthetic direct calls are flagged
  ---
  duration_ms: 299.25375
  type: 'test'
  ...
# Subtest: every Right Care promptRef tag resolves to a REAL registry id
ok 2515 - every Right Care promptRef tag resolves to a REAL registry id
  ---
  duration_ms: 1.114166
  type: 'test'
  ...
# Subtest: countNonEnumVerdicts (A04) counts exactly the out-of-enum verdicts
ok 2516 - countNonEnumVerdicts (A04) counts exactly the out-of-enum verdicts
  ---
  duration_ms: 0.521541
  type: 'test'
  ...
# Subtest: outcomeForPrompt maps the committed scorecard to the right prompt version/hash
ok 2517 - outcomeForPrompt maps the committed scorecard to the right prompt version/hash
  ---
  duration_ms: 0.569583
  type: 'test'
  ...
# Subtest: RECOMPUTE: arm stats re-derive from the raw runs via the harness scorer — no drift
ok 2518 - RECOMPUTE: arm stats re-derive from the raw runs via the harness scorer — no drift
  ---
  duration_ms: 0.622333
  type: 'test'
  ...
# Subtest: maturity gate: mature requires a cleared gold; the LIVE manifests pass (CI assertion)
ok 2519 - maturity gate: mature requires a cleared gold; the LIVE manifests pass (CI assertion)
  ---
  duration_ms: 0.531542
  type: 'test'
  ...
# Subtest: provenance rider: cwus-ahaacchrs-001 labels as guideline-derived
ok 2520 - provenance rider: cwus-ahaacchrs-001 labels as guideline-derived
  ---
  duration_ms: 0.206958
  type: 'test'
  ...
# Subtest: determinism + evidence currency
ok 2521 - determinism + evidence currency
  ---
  duration_ms: 0.289583
  type: 'test'
  ...
# Subtest: registry generation is deterministic and the committed artifact is current
ok 2522 - registry generation is deterministic and the committed artifact is current
  ---
  duration_ms: 261.235625
  type: 'test'
  ...
# Subtest: every extracted prompt has non-empty text and a valid sha256 of exactly that text
ok 2523 - every extracted prompt has non-empty text and a valid sha256 of exactly that text
  ---
  duration_ms: 0.594958
  type: 'test'
  ...
# Subtest: the research export contains prompt/rubric/metadata keys ONLY — no clinical/patient/trace content
ok 2524 - the research export contains prompt/rubric/metadata keys ONLY — no clinical/patient/trace content
  ---
  duration_ms: 1.190417
  type: 'test'
  ...
# Subtest: manifest merge: registered id gets its metadata; unknown id → unregistered, never a throw
ok 2525 - manifest merge: registered id gets its metadata; unknown id → unregistered, never a throw
  ---
  duration_ms: 0.498875
  type: 'test'
  ...
# Subtest: rubric inclusion: nabh/6e external-json + the five embedded-in-prompt rubrics
ok 2526 - rubric inclusion: nabh/6e external-json + the five embedded-in-prompt rubrics
  ---
  duration_ms: 0.092875
  type: 'test'
  ...
# Subtest: count invariant: counts match the committed artifact contents (30 prompts / 7 rubrics / 32 builders)
ok 2527 - count invariant: counts match the committed artifact contents (30 prompts / 7 rubrics / 32 builders)
  ---
  duration_ms: 0.057041
  type: 'test'
  ...
# Subtest: registryTabRows maps generated + manifest correctly
ok 2528 - registryTabRows maps generated + manifest correctly
  ---
  duration_ms: 0.913625
  type: 'test'
  ...
# Subtest: groupPromptVersionCost sums the 4th breakdown correctly
ok 2529 - groupPromptVersionCost sums the 4th breakdown correctly
  ---
  duration_ms: 0.155125
  type: 'test'
  ...
# Subtest: fingerprint + rollup tolerate NULL columns (pre-Stage-1 rows) without throwing
ok 2530 - fingerprint + rollup tolerate NULL columns (pre-Stage-1 rows) without throwing
  ---
  duration_ms: 12.861333
  type: 'test'
  ...
# Subtest: PHI-safety: new views surface registry/envelope fields only
ok 2531 - PHI-safety: new views surface registry/envelope fields only
  ---
  duration_ms: 0.4615
  type: 'test'
  ...
# Subtest: shortVersion / shortPromptRef formatters
ok 2532 - shortVersion / shortPromptRef formatters
  ---
  duration_ms: 0.073167
  type: 'test'
  ...
# Subtest: promptVersionChanges detects a rollout inside the watch window
ok 2533 - promptVersionChanges detects a rollout inside the watch window
  ---
  duration_ms: 0.13725
  type: 'test'
  ...
# Subtest: GOVERNANCE_SNAPSHOT matches the live scan — the coverage panel cannot rot
ok 2534 - GOVERNANCE_SNAPSHOT matches the live scan — the coverage panel cannot rot
  ---
  duration_ms: 292.9875
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 55 — every failure-phase to reconciler-state mapping, all four rows of D13's table
ok 2535 - 55 — every failure-phase to reconciler-state mapping, all four rows of D13's table
  ---
  duration_ms: 0.599375
  type: 'test'
  ...
# Subtest: 55 — the selection is bounded, non-terminal only, and oldest first
ok 2536 - 55 — the selection is bounded, non-terminal only, and oldest first
  ---
  duration_ms: 0.179208
  type: 'test'
  ...
# Subtest: 55 — the update is a compare-and-set on the expected revision, and cannot move a terminal row
ok 2537 - 55 — the update is a compare-and-set on the expected revision, and cannot move a terminal row
  ---
  duration_ms: 0.152833
  type: 'test'
  ...
# Subtest: 55 — a revision mismatch causes ONE reread and reclassification, never a blind retry
ok 2538 - 55 — a revision mismatch causes ONE reread and reclassification, never a blind retry
  ---
  duration_ms: 0.099875
  type: 'test'
  ...
# Subtest: 55 — every state the reconciler can assign is a legal transition from where it assigns it
ok 2539 - 55 — every state the reconciler can assign is a legal transition from where it assigns it
  ---
  duration_ms: 0.094417
  type: 'test'
  ...
# Subtest: 55 — the reconciler owns an invocation of its own kind, and closes it
ok 2540 - 55 — the reconciler owns an invocation of its own kind, and closes it
  ---
  duration_ms: 0.211459
  type: 'test'
  ...
# Subtest: 55 runtime — an ordinary one-row pass: one pinned write, no reread
ok 2541 - 55 runtime — an ordinary one-row pass: one pinned write, no reread
  ---
  duration_ms: 12.778125
  type: 'test'
  ...
# Subtest: 55 runtime — the statement the route ACTUALLY SENT is the pinned one, complete
ok 2542 - 55 runtime — the statement the route ACTUALLY SENT is the pinned one, complete
  ---
  duration_ms: 1.929416
  type: 'test'
  ...
# Subtest: 55 runtime — each row's write binds ITS OWN revision
ok 2543 - 55 runtime — each row's write binds ITS OWN revision
  ---
  duration_ms: 5.810416
  type: 'test'
  ...
# Subtest: 55 runtime — THE STALE DECISION DOES NOT LAND: reread, reclassify, write the FRESH state
ok 2544 - 55 runtime — THE STALE DECISION DOES NOT LAND: reread, reclassify, write the FRESH state
  ---
  duration_ms: 6.498333
  type: 'test'
  ...
# Subtest: 55 runtime — a TERMINAL row wins, and no second write is issued
ok 2545 - 55 runtime — a TERMINAL row wins, and no second write is issued
  ---
  duration_ms: 0.994583
  type: 'test'
  ...
# Subtest: 55 runtime — the CUTOFF is the request time minus the preregistered grace
ok 2546 - 55 runtime — the CUTOFF is the request time minus the preregistered grace
  ---
  duration_ms: 7.348667
  type: 'test'
  ...
# Subtest: 55 runtime — a FORBIDDEN transition is refused, and nothing is written
ok 2547 - 55 runtime — a FORBIDDEN transition is refused, and nothing is written
  ---
  duration_ms: 0.970833
  type: 'test'
  ...
# Subtest: the stub fails CLOSED on every body it does not model
ok 2548 - the stub fails CLOSED on every body it does not model
  ---
  duration_ms: 0.385458
  type: 'test'
  ...
# Subtest: 55 behaviour — the SELECT sent at run time is the complete pinned selection
ok 2549 - 55 behaviour — the SELECT sent at run time is the complete pinned selection
  ---
  duration_ms: 0.662917
  type: 'test'
  ...
# Subtest: 55 behaviour — the first write binds the revision the SELECTION returned
ok 2550 - 55 behaviour — the first write binds the revision the SELECTION returned
  ---
  duration_ms: 1.333209
  type: 'test'
  ...
# Subtest: 55 behaviour — a transport error on the write is a 500, never a fabricated verdict
ok 2551 - 55 behaviour — a transport error on the write is a 500, never a fabricated verdict
  ---
  duration_ms: 0.591084
  type: 'test'
  ...
# Subtest: 55 behaviour — a SECOND conflict on the reread path stops after two writes and one reread
ok 2552 - 55 behaviour — a SECOND conflict on the reread path stops after two writes and one reread
  ---
  duration_ms: 0.42125
  type: 'test'
  ...
# Subtest: 55 summary — a slice of TERMINAL rows tallies no reconciliations at all
ok 2553 - 55 summary — a slice of TERMINAL rows tallies no reconciliations at all
  ---
  duration_ms: 0.297875
  type: 'test'
  ...
# Subtest: 55 summary — more_may_remain is TRUE on a full slice and FALSE on a short one
ok 2554 - 55 summary — more_may_remain is TRUE on a full slice and FALSE on a short one
  ---
  duration_ms: 0.954334
  type: 'test'
  ...
# Subtest: 55 behaviour — an unauthenticated request is 401 and touches the database not at all
ok 2555 - 55 behaviour — an unauthenticated request is 401 and touches the database not at all
  ---
  duration_ms: 0.20575
  type: 'test'
  ...
# Subtest: 58 — WORKER_MAX_DURATION_SECONDS equals the worker route's own maxDuration literal
ok 2556 - 58 — WORKER_MAX_DURATION_SECONDS equals the worker route's own maxDuration literal
  ---
  duration_ms: 0.162208
  type: 'test'
  ...
# Subtest: 59 — the reconciler fires at 10:01 UTC, outside every hour the OPD worker runs
ok 2557 - 59 — the reconciler fires at 10:01 UTC, outside every hour the OPD worker runs
  ---
  duration_ms: 0.202709
  type: 'test'
  ...
# Subtest: 64 — both files assert 17, and neither still asserts 16
ok 2558 - 64 — both files assert 17, and neither still asserts 16
  ---
  duration_ms: 0.261084
  type: 'test'
  ...
# Subtest: 64 — undo the one authorised line and each file hashes to exactly what it did at 177adc9
ok 2559 - 64 — undo the one authorised line and each file hashes to exactly what it did at 177adc9
  ---
  duration_ms: 0.32625
  type: 'test'
  ...
# Subtest: 64 — provider-switch-unit-d's sql-guard assertion is untouched, and is nowhere near line 270
ok 2560 - 64 — provider-switch-unit-d's sql-guard assertion is untouched, and is nowhere near line 270
  ---
  duration_ms: 0.124542
  type: 'test'
  ...
# Subtest: artifact — THE ROUTE HAS NOT RUN IN THIS PROCESS
ok 2561 - artifact — THE ROUTE HAS NOT RUN IN THIS PROCESS
  ---
  duration_ms: 0.686833
  type: 'test'
  ...
# Subtest: artifact — the reconciler route is byte-for-byte the reviewed file
ok 2562 - artifact — the reconciler route is byte-for-byte the reviewed file
  ---
  duration_ms: 0.225209
  type: 'test'
  ...
# Subtest: artifact — what this pin does NOT cover
ok 2563 - artifact — what this pin does NOT cover
  ---
  duration_ms: 0.095375
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state started
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row already terminal (persisted_complete), preserved
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state started
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row already terminal (persisted_complete), preserved
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state started
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state unknown
# Subtest: v7 §8 — a rejected terminal write now leaves DURABLE evidence, not just a console.warn
ok 2564 - v7 §8 — a rejected terminal write now leaves DURABLE evidence, not just a console.warn
  ---
  duration_ms: 5.314667
  type: 'test'
  ...
# Subtest: v7 §8 — the reread distinguishes an already-terminal row from a moved revision
ok 2565 - v7 §8 — the reread distinguishes an already-terminal row from a moved revision
  ---
  duration_ms: 1.075417
  type: 'test'
  ...
# Subtest: v7 §8 — an existing terminal row is NEVER downgraded, and that is structural
ok 2566 - v7 §8 — an existing terminal row is NEVER downgraded, and that is structural
  ---
  duration_ms: 0.30325
  type: 'test'
  ...
# Subtest: v7 §8 — the handle is returned unadvanced, and nothing is retried
ok 2567 - v7 §8 — the handle is returned unadvanced, and nothing is retried
  ---
  duration_ms: 0.358833
  type: 'test'
  ...
# Subtest: v7 §8 — a failed reread still records the evidence, because the reread is diagnostic
ok 2568 - v7 §8 — a failed reread still records the evidence, because the reread is diagnostic
  ---
  duration_ms: 0.300084
  type: 'test'
  ...
# Subtest: v7 §8 — the new phase is run-scoped and in the vocabulary, and the reconciler deliberately ignores it
ok 2569 - v7 §8 — the new phase is run-scoped and in the vocabulary, and the reconciler deliberately ignores it
  ---
  duration_ms: 0.085708
  type: 'test'
  ...
# Subtest: v7 §8 — the generated CHECK and the mirrored .sql agree on the new phase
ok 2570 - v7 §8 — the generated CHECK and the mirrored .sql agree on the new phase
  ---
  duration_ms: 0.254667
  type: 'test'
  ...
# Subtest: v7 §7 — the field is present-and-null when there is no active run, and that validates clean
ok 2571 - v7 §7 — the field is present-and-null when there is no active run, and that validates clean
  ---
  duration_ms: 1.622041
  type: 'test'
  ...
# Subtest: v7 §7 — an ABSENT field is a defect, which is what makes the null a claim rather than a gap
ok 2572 - v7 §7 — an ABSENT field is a defect, which is what makes the null a claim rather than a gap
  ---
  duration_ms: 3.290709
  type: 'test'
  ...
# Subtest: v7 §7 — the definition is recorded, and BackfillRun still has no `target` field
ok 2573 - v7 §7 — the definition is recorded, and BackfillRun still has no `target` field
  ---
  duration_ms: 0.594291
  type: 'test'
  ...
# Subtest: v7 §7 — the writer maps no-active-run to null on all three fields
ok 2574 - v7 §7 — the writer maps no-active-run to null on all three fields
  ---
  duration_ms: 0.314083
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] backend failed, returning input order transient 503
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (m): simulated 403
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' failed the discrimination probe (m): no discrimination
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' missing (m): 404
# [rerank] judge fallback failed → input order: judge is down too
# Subtest: resolveRerankBackend: explicit override wins, else env default; only judge|cohere
ok 2575 - resolveRerankBackend: explicit override wins, else env default; only judge|cohere
  ---
  duration_ms: 1.086708
  type: 'test'
  ...
# Subtest: no backend arg routes to the env default (judge in the test env), not cohere
ok 2576 - no backend arg routes to the env default (judge in the test env), not cohere
  ---
  duration_ms: 0.303417
  type: 'test'
  ...
# Subtest: assertRerankBackendHealthy passes when rel=0.8, irr=0.02
ok 2577 - assertRerankBackendHealthy passes when rel=0.8, irr=0.02
  ---
  duration_ms: 4.528791
  type: 'test'
  ...
# Subtest: probe fails RerankBackendUnhealthy when the margin < MIN_MARGIN (rel=0.5, irr=0.45)
ok 2578 - probe fails RerankBackendUnhealthy when the margin < MIN_MARGIN (rel=0.5, irr=0.45)
  ---
  duration_ms: 0.402667
  type: 'test'
  ...
# Subtest: probe fails Unhealthy when the backend returns CONSTANT scores (no discrimination)
ok 2579 - probe fails Unhealthy when the backend returns CONSTANT scores (no discrimination)
  ---
  duration_ms: 0.270333
  type: 'test'
  ...
# Subtest: probe fails RerankBackendUnreachable on fetch throw, non-200, or missing key
ok 2580 - probe fails RerankBackendUnreachable on fetch throw, non-200, or missing key
  ---
  duration_ms: 0.273834
  type: 'test'
  ...
# Subtest: probe is memoized within the TTL — two calls ⇒ one fetch
ok 2581 - probe is memoized within the TTL — two calls ⇒ one fetch
  ---
  duration_ms: 0.300459
  type: 'test'
  ...
# Subtest: rerankCohere maps index→candidate, uses relevance_score directly (no sigmoid), tags cohere
ok 2582 - rerankCohere maps index→candidate, uses relevance_score directly (no sigmoid), tags cohere
  ---
  duration_ms: 0.371084
  type: 'test'
  ...
# Subtest: explicit cohere runs the health probe BEFORE scoring, and a probe failure propagates (not swallowed)
ok 2583 - explicit cohere runs the health probe BEFORE scoring, and a probe failure propagates (not swallowed)
  ---
  duration_ms: 0.802875
  type: 'test'
  ...
# Subtest: a TRANSIENT (generic, non-typed) failure still soft-falls to input order
ok 2584 - a TRANSIENT (generic, non-typed) failure still soft-falls to input order
  ---
  duration_ms: 0.518709
  type: 'test'
  ...
# Subtest: D2.1 env-default cohere: a typed cohere failure ⇒ falls back to JUDGE (tier 1), never throws
ok 2585 - D2.1 env-default cohere: a typed cohere failure ⇒ falls back to JUDGE (tier 1), never throws
  ---
  duration_ms: 0.179083
  type: 'test'
  ...
# Subtest: D2.2 env-default cohere: cohere AND judge both throw ⇒ INPUT ORDER (none), never throws
ok 2586 - D2.2 env-default cohere: cohere AND judge both throw ⇒ INPUT ORDER (none), never throws
  ---
  duration_ms: 0.133208
  type: 'test'
  ...
# Subtest: D2.3 EXPLICIT cohere: a typed cohere failure PROPAGATES (strict — NO fallback to judge)
ok 2587 - D2.3 EXPLICIT cohere: a typed cohere failure PROPAGATES (strict — NO fallback to judge)
  ---
  duration_ms: 0.081083
  type: 'test'
  ...
# Subtest: D2.4 env-default cohere HEALTHY ⇒ cohere scores; probe invoked once (memoization proven in §5.5)
ok 2588 - D2.4 env-default cohere HEALTHY ⇒ cohere scores; probe invoked once (memoization proven in §5.5)
  ---
  duration_ms: 0.063083
  type: 'test'
  ...
# Subtest: D3 a successful cohere rerank records ONE cost entry carrying the response usage.cost
ok 2589 - D3 a successful cohere rerank records ONE cost entry carrying the response usage.cost
  ---
  duration_ms: 0.5015
  type: 'test'
  ...
# Subtest: the rerank module no longer contains any bge symbol
ok 2590 - the rerank module no longer contains any bge symbol
  ---
  duration_ms: 0.31875
  type: 'test'
  ...
# Subtest: discrimination thresholds default to 0.40 / 0.15
ok 2591 - discrimination thresholds default to 0.40 / 0.15
  ---
  duration_ms: 0.040709
  type: 'test'
  ...
# Subtest: §5.1 the LIVE production case: RERANK_BACKEND=Cohere resolves to judge AND warns
ok 2592 - §5.1 the LIVE production case: RERANK_BACKEND=Cohere resolves to judge AND warns
  ---
  duration_ms: 0.044083
  type: 'test'
  ...
# Subtest: §5.1b …and the warning actually FIRES at real module load (cold-start proof, subprocess)
ok 2593 - §5.1b …and the warning actually FIRES at real module load (cold-start proof, subprocess)
  ---
  duration_ms: 343.7115
  type: 'test'
  ...
# Subtest: §5.2 exact lowercase cohere (whitespace-trimmed) selects cohere silently; COHERE warns to judge
ok 2594 - §5.2 exact lowercase cohere (whitespace-trimmed) selects cohere silently; COHERE warns to judge
  ---
  duration_ms: 0.087167
  type: 'test'
  ...
# Subtest: §5.3 judge, trimmed judge and unset are silent; any other value warns to judge
ok 2595 - §5.3 judge, trimmed judge and unset are silent; any other value warns to judge
  ---
  duration_ms: 0.224167
  type: 'test'
  ...
# Subtest: §5.4 miniPipeline normalizes: Mini and " mini " both select the mini pipeline
ok 2596 - §5.4 miniPipeline normalizes: Mini and " mini " both select the mini pipeline
  ---
  duration_ms: 0.085083
  type: 'test'
  ...
# Subtest: §5.5 INVARIANCE: no rerankBackend ⇒ retrieve options deep-equal to today, no extra key
ok 2597 - §5.5 INVARIANCE: no rerankBackend ⇒ retrieve options deep-equal to today, no extra key
  ---
  duration_ms: 0.15975
  type: 'test'
  ...
# Subtest: §5.6 rerankBackend:cohere reaches retrieve() — carried in the opts and threaded at the call sites
ok 2598 - §5.6 rerankBackend:cohere reaches retrieve() — carried in the opts and threaded at the call sites
  ---
  duration_ms: 0.539541
  type: 'test'
  ...
# Subtest: §5.7 explicit cohere via the threaded path stays STRICT — typed errors propagate, no fallback
ok 2599 - §5.7 explicit cohere via the threaded path stays STRICT — typed errors propagate, no fallback
  ---
  duration_ms: 0.179083
  type: 'test'
  ...
# Subtest: pickScoreFields drops text/section, keeps ids + scores
ok 2600 - pickScoreFields drops text/section, keeps ids + scores
  ---
  duration_ms: 0.093209
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] backend failed, returning input order untyped cohere failure
# Subtest: 2.1 — rerankCohere with an injected fetchImpl serves, stamps the capture, and opens no real socket
ok 2601 - 2.1 — rerankCohere with an injected fetchImpl serves, stamps the capture, and opens no real socket
  ---
  duration_ms: 165.760958
  type: 'test'
  ...
# Subtest: 2.2 — the DEFAULT cohereFn adapter inside rerank passes the capture in the CAPTURE position, not the fetch position
ok 2602 - 2.2 — the DEFAULT cohereFn adapter inside rerank passes the capture in the CAPTURE position, not the fetch position
  ---
  duration_ms: 10.861041
  type: 'test'
  ...
# Subtest: 16.1 — Cohere selected, an UNTYPED throw: inputOrder returned, one synthesised terminal_failure batch, expected == recorded, soft_failed true, row not partial — by the REAL validation chain, both arms
ok 2603 - 16.1 — Cohere selected, an UNTYPED throw: inputOrder returned, one synthesised terminal_failure batch, expected == recorded, soft_failed true, row not partial — by the REAL validation chain, both arms
  ---
  duration_ms: 19.367584
  type: 'test'
  ...
# Subtest: 17.1 — a per-batch throw inside rerankJudge warns, continues, and leaves rerank_soft_failed FALSE
ok 2604 - 17.1 — a per-batch throw inside rerankJudge warns, continues, and leaves rerank_soft_failed FALSE
  ---
  duration_ms: 34.977125
  type: 'test'
  ...
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (m): probe refused
# Subtest: 18.1 — JUDGE served: expected_batch_count == ceil(pool / JUDGE_BATCH), JUDGE_BATCH read from source text
ok 2605 - 18.1 — JUDGE served: expected_batch_count == ceil(pool / JUDGE_BATCH), JUDGE_BATCH read from source text
  ---
  duration_ms: 18.801875
  type: 'test'
  ...
# Subtest: 18.2 — COHERE served: expected_batch_count == 1, whatever the pool — stamped by the REAL rerankCohere
ok 2606 - 18.2 — COHERE served: expected_batch_count == 1, whatever the pool — stamped by the REAL rerankCohere
  ---
  duration_ms: 1.011542
  type: 'test'
  ...
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (rerank-v3.5): probe refused by design
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (rerank-v3.5): probe refused by design
# Subtest: 18.3 — DERIVED FROM served_backend, NEVER intended_backend: intended Cohere, judge serves, expected is the JUDGE count
ok 2607 - 18.3 — DERIVED FROM served_backend, NEVER intended_backend: intended Cohere, judge serves, expected is the JUDGE count
  ---
  duration_ms: 2.241833
  type: 'test'
  ...
# Subtest: 70.1 — RUNTIME ORDER, observed AT INVOCATION: checkHealthy throws RerankBackendError FIRST, the judge is invoked SECOND
ok 2608 - 70.1 — RUNTIME ORDER, observed AT INVOCATION: checkHealthy throws RerankBackendError FIRST, the judge is invoked SECOND
  ---
  duration_ms: 1.357833
  type: 'test'
  ...
# [rerank] env-default cohere unavailable → falling back to judge: rerank backend 'cohere' unreachable (rerank-v3.5): probe refused by design
# Subtest: 70.2 — MANIFEST FACTS: intended_backend cohere, served_backend judge, rerank_backend_downgraded true, expected_batch_count matches the judge
ok 2609 - 70.2 — MANIFEST FACTS: intended_backend cohere, served_backend judge, rerank_backend_downgraded true, expected_batch_count matches the judge
  ---
  duration_ms: 1.351916
  type: 'test'
  ...
# Subtest: 70.3 — the row is persisted_complete by the REAL chain, and a broken payload is persisted_partial
ok 2610 - 70.3 — the row is persisted_complete by the REAL chain, and a broken payload is persisted_partial
  ---
  duration_ms: 1.57575
  type: 'test'
  ...
# Subtest: 70.4 — SOURCE PARITY: provider selection and fallback order in lib/rerank.ts are byte-identical to 72960baa
ok 2611 - 70.4 — SOURCE PARITY: provider selection and fallback order in lib/rerank.ts are byte-identical to 72960baa
  ---
  duration_ms: 76.605209
  type: 'test'
  ...
# [rerank judge] batch failed 0 - 5 Unexpected token 'o', "not json" is not valid JSON
# [rerank judge] batch failed 5 - 6 Unexpected token 'o', "not json" is not valid JSON
# [rerank] backend failed, returning input order generic judge failure
# Subtest: J2.1 — under a JUDGE default: explicit judge, on success and on failure, calls neither checkHealthy nor cohereFn
ok 2612 - J2.1 — under a JUDGE default: explicit judge, on success and on failure, calls neither checkHealthy nor cohereFn
  ---
  duration_ms: 17.981542
  type: 'test'
  ...
# [rerank judge] batch failed 0 - 5 Unexpected token 'o', "not json" is not valid JSON
# [rerank judge] batch failed 5 - 6 Unexpected token 'o', "not json" is not valid JSON
# [rerank] backend failed, returning input order generic judge failure
# Subtest: J2.2 — under a HOSTILE COHERE default: explicit judge, on success and on failure, still calls neither — and each failure arm PROVES its failure happened
ok 2613 - J2.2 — under a HOSTILE COHERE default: explicit judge, on success and on failure, still calls neither — and each failure arm PROVES its failure happened
  ---
  duration_ms: 6.136166
  type: 'test'
  ...
# Subtest: THE EXHIBIT: "Atarax Cream…" resolves to NOTHING — not Hydroxyzine, not approximate
ok 2614 - THE EXHIBIT: "Atarax Cream…" resolves to NOTHING — not Hydroxyzine, not approximate
  ---
  duration_ms: 1.958417
  type: 'test'
  ...
# Subtest: the gate fires on the TEXT alone too — no route needed
ok 2615 - the gate fires on the TEXT alone too — no route needed
  ---
  duration_ms: 0.245833
  type: 'test'
  ...
# Subtest: the ORAL Atarax lines still resolve, confident — the gate is surgical
ok 2616 - the ORAL Atarax lines still resolve, confident — the gate is surgical
  ---
  duration_ms: 0.865542
  type: 'test'
  ...
# Subtest: a topical line matching a family that HAS a topical row still resolves
ok 2617 - a topical line matching a family that HAS a topical row still resolves
  ---
  duration_ms: 0.093875
  type: 'test'
  ...
# Subtest: route vocabulary: Topical, "topical " (trailing space) and local ALL count as topical
ok 2618 - route vocabulary: Topical, "topical " (trailing space) and local ALL count as topical
  ---
  duration_ms: 0.139375
  type: 'test'
  ...
# Subtest: phase 1.1 route PHRASES: application/apply-locally/intranasal variants all count as topical
ok 2619 - phase 1.1 route PHRASES: application/apply-locally/intranasal variants all count as topical
  ---
  duration_ms: 0.045625
  type: 'test'
  ...
# Subtest: the topical-form regex is the normative one, and word boundaries hold
ok 2620 - the topical-form regex is the normative one, and word boundaries hold
  ---
  duration_ms: 0.109375
  type: 'test'
  ...
# Subtest: tier 5 (brand-prefix, APPROX): a topical line never takes an oral approximate match
ok 2621 - tier 5 (brand-prefix, APPROX): a topical line never takes an oral approximate match
  ---
  duration_ms: 0.048584
  type: 'test'
  ...
# Subtest: TIERS 1–3 UNCHANGED: source generic, exact brand and embedded molecule ignore the gate
ok 2622 - TIERS 1–3 UNCHANGED: source generic, exact brand and embedded molecule ignore the gate
  ---
  duration_ms: 0.315625
  type: 'test'
  ...
# Subtest: CONFIDENT_MATCH and classifyUnmatched/NUTRA are untouched
ok 2623 - CONFIDENT_MATCH and classifyUnmatched/NUTRA are untouched
  ---
  duration_ms: 0.50175
  type: 'test'
  ...
# Subtest: the category gate: the three enums, case-sensitive, trimmed — matcher skipped entirely
ok 2624 - the category gate: the three enums, case-sensitive, trimmed — matcher skipped entirely
  ---
  duration_ms: 32.919
  type: 'test'
  ...
# Subtest: the category gate is CASE-SENSITIVE and enum-exact — near-misses fall through to the matcher
ok 2625 - the category gate is CASE-SENSITIVE and enum-exact — near-misses fall through to the matcher
  ---
  duration_ms: 6.091041
  type: 'test'
  ...
# Subtest: rowToOpdCase carries default_opd_service_category verbatim, fail-safe on absence
ok 2626 - rowToOpdCase carries default_opd_service_category verbatim, fail-safe on absence
  ---
  duration_ms: 0.281333
  type: 'test'
  ...
# Subtest: §5.1: the gate still fires for a category-gated TOPICAL line — the Atarax exhibit
ok 2627 - §5.1: the gate still fires for a category-gated TOPICAL line — the Atarax exhibit
  ---
  duration_ms: 5.580458
  type: 'test'
  ...
# Subtest: §5.2: a category-gated ORAL line runs the matcher — Crocin resolves to Paracetamol
ok 2628 - §5.2: a category-gated ORAL line runs the matcher — Crocin resolves to Paracetamol
  ---
  duration_ms: 3.969583
  type: 'test'
  ...
# Subtest: §5.3 THE PHASE-3 UNBLOCKER: Depura 60000 IU Vitamin D3 Oral Solution resolves to Vitamin D3
ok 2629 - §5.3 THE PHASE-3 UNBLOCKER: Depura 60000 IU Vitamin D3 Oral Solution resolves to Vitamin D3
  ---
  duration_ms: 5.37075
  type: 'test'
  ...
# Subtest: §5.4: category + BLANK route + form word in the brand ⇒ still gated (text is evidence)
ok 2630 - §5.4: category + BLANK route + form word in the brand ⇒ still gated (text is evidence)
  ---
  duration_ms: 1.687125
  type: 'test'
  ...
# Subtest: §5.5: category + blank route + NO form word ⇒ matcher runs — Zincovit Tablet
ok 2631 - §5.5: category + blank route + NO form word ⇒ matcher runs — Zincovit Tablet
  ---
  duration_ms: 6.877875
  type: 'test'
  ...
# Subtest: §5.7: the tier-4/5 form gate from phase 1 is unchanged for non-category topical lines
ok 2632 - §5.7: the tier-4/5 form gate from phase 1 is unchanged for non-category topical lines
  ---
  duration_ms: 0.110292
  type: 'test'
  ...
# Subtest: phase 1.1 direction check: the widened regex can only WITHHOLD matches, never create one
ok 2633 - phase 1.1 direction check: the widened regex can only WITHHOLD matches, never create one
  ---
  duration_ms: 0.221167
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 28 — ONE multi-row insert, app_source bound explicitly, no stamper involved
ok 2634 - 28 — ONE multi-row insert, app_source bound explicitly, no stamper involved
  ---
  duration_ms: 3.347791
  type: 'test'
  ...
# Subtest: 62 — app_source binds APP_SOURCE when set, and 'standalone' when absent, never null
ok 2635 - 62 — app_source binds APP_SOURCE when set, and 'standalone' when absent, never null
  ---
  duration_ms: 0.737125
  type: 'test'
  ...
# Subtest: the three A/A experiment columns are BOUND, so opd_art_experiment_idx is populable
ok 2636 - the three A/A experiment columns are BOUND, so opd_art_experiment_idx is populable
  ---
  duration_ms: 2.711584
  type: 'test'
  ...
# Subtest: declared_retrievals counts the rows that LANDED, not the rows that were asked for
ok 2637 - declared_retrievals counts the rows that LANDED, not the rows that were asked for
  ---
  duration_ms: 0.506542
  type: 'test'
  ...
# Subtest: a declaration that lands nothing bumps nothing at all
ok 2638 - a declaration that lands nothing bumps nothing at all
  ---
  duration_ms: 0.158208
  type: 'test'
  ...
# Subtest: an empty run list writes nothing and returns an empty handle
ok 2639 - an empty run list writes nothing and returns an empty handle
  ---
  duration_ms: 0.077625
  type: 'test'
  ...
# Subtest: 29 — a failed batch declaration writes ONE work_declaration failure row per generated run
ok 2640 - 29 — a failed batch declaration writes ONE work_declaration failure row per generated run
  ---
  duration_ms: 0.640333
  type: 'test'
  ...
# [retrieval-telemetry] failure row for a run-scoped phase has no run id or role work_declaration
# [retrieval-telemetry] failure store write failed: Error connecting to database: AlsoDown (stub)
# [retrieval-telemetry] telemetry_write_failures increment failed: Error connecting to database: NeonDbError (stub)
# Subtest: 29 — a run-scoped failure phase with no run id is refused before it reaches the CHECK
ok 2641 - 29 — a run-scoped failure phase with no run id is refused before it reaches the CHECK
  ---
  duration_ms: 7.494584
  type: 'test'
  ...
# Subtest: 29 — when the failure store ITSELF fails, the invocation counter is the last evidence
ok 2642 - 29 — when the failure store ITSELF fails, the invocation counter is the last evidence
  ---
  duration_ms: 1.131583
  type: 'test'
  ...
# Subtest: 30 — an invocation insert failure is fail-open, and leaves evidence
ok 2643 - 30 — an invocation insert failure is fail-open, and leaves evidence
  ---
  duration_ms: 5.006333
  type: 'test'
  ...
# Subtest: 30 — the invocation row is inserted once, with its kind and route class
ok 2644 - 30 — the invocation row is inserted once, with its kind and route class
  ---
  duration_ms: 0.158542
  type: 'test'
  ...
# Subtest: closeInvocation is fail-open too, and records a closure failure
ok 2645 - closeInvocation is fail-open too, and records a closure failure
  ---
  duration_ms: 0.271833
  type: 'test'
  ...
# Subtest: the write-failure counter never throws, even when its own UPDATE fails
ok 2646 - the write-failure counter never throws, even when its own UPDATE fails
  ---
  duration_ms: 0.134291
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: RETRIEVAL_LLM_SEED is the fixed shared seed (42), defined once in expand.ts
ok 2647 - RETRIEVAL_LLM_SEED is the fixed shared seed (42), defined once in expand.ts
  ---
  duration_ms: 0.432125
  type: 'test'
  ...
# Subtest: expand.ts: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
ok 2648 - expand.ts: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
  ---
  duration_ms: 0.125667
  type: 'test'
  ...
# Subtest: multi-query generateQueryVariants: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
ok 2649 - multi-query generateQueryVariants: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched
  ---
  duration_ms: 0.07375
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 60 A — useReranker false: instrumentation on and off return byte-identical results
ok 2650 - 60 A — useReranker false: instrumentation on and off return byte-identical results
  ---
  duration_ms: 861.33975
  type: 'test'
  ...
# Subtest: 60 B — useReranker true: identical results, batch boundaries and prompts across on and off
ok 2651 - 60 B — useReranker true: identical results, batch boundaries and prompts across on and off
  ---
  duration_ms: 44.84825
  type: 'test'
  ...
# Subtest: 60 C — the production opts: identical results with source weighting, expansion and embedding all live
ok 2652 - 60 C — the production opts: identical results with source weighting, expansion and embedding all live
  ---
  duration_ms: 42.998542
  type: 'test'
  ...
# Subtest: 60 — THE CALL-FORM PIN: one side omits the capture argument, per case
ok 2653 - 60 — THE CALL-FORM PIN: one side omits the capture argument, per case
  ---
  duration_ms: 0.3105
  type: 'test'
  ...
# Subtest: 60 — the seven routing fragments are pairwise non-overlapping on the statements that ran
ok 2654 - 60 — the seven routing fragments are pairwise non-overlapping on the statements that ran
  ---
  duration_ms: 0.151541
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [retrieval-telemetry] settlement rejected: no_row primary r1
# [retrieval-telemetry] settlement rejected: stale_revision primary expected 1, found 4
# [retrieval-telemetry] settlement rejected: already_terminal primary persisted_complete
# [retrieval-telemetry] settlement rejected: disallowed_transition primary started -> persisted_complete
# [retrieval-telemetry] settlement rejected: lost_update primary r1
# Subtest: 51 — every settlement outcome has a state, and the mapping is D9's table exactly
ok 2655 - 51 — every settlement outcome has a state, and the mapping is D9's table exactly
  ---
  duration_ms: 4.104208
  type: 'test'
  ...
# Subtest: 51 — saveOpdAudit's four return values each map to their D9 outcome, including skipped
ok 2656 - 51 — saveOpdAudit's four return values each map to their D9 outcome, including skipped
  ---
  duration_ms: 0.093916
  type: 'test'
  ...
# Subtest: 51 — settlement writes ONCE per run, and the write carries the mapped state and the audit id
ok 2657 - 51 — settlement writes ONCE per run, and the write carries the mapped state and the audit id
  ---
  duration_ms: 4.531084
  type: 'test'
  ...
# Subtest: 15 — a retrieval_failure with a persisted audit settles persisted_complete, not partial
ok 2658 - 15 — a retrieval_failure with a persisted audit settles persisted_complete, not partial
  ---
  duration_ms: 0.285458
  type: 'test'
  ...
# Subtest: 33 — primary settles, normative fails: one settled, one failed, one failure row, nothing thrown
ok 2659 - 33 — primary settles, normative fails: one settled, one failed, one failure row, nothing thrown
  ---
  duration_ms: 0.548458
  type: 'test'
  ...
# Subtest: 33 — a role still at revision 0 is NOT linked: audit id null, and the state is not the outcome's
ok 2660 - 33 — a role still at revision 0 is NOT linked: audit id null, and the state is not the outcome's
  ---
  duration_ms: 0.622333
  type: 'test'
  ...
# Subtest: revision 0 with retrieval_terminal evidence settles telemetry_persistence_failed
ok 2661 - revision 0 with retrieval_terminal evidence settles telemetry_persistence_failed
  ---
  duration_ms: 0.263709
  type: 'test'
  ...
# Subtest: revision 0 with NO evidence settles aborted
ok 2662 - revision 0 with NO evidence settles aborted
  ---
  duration_ms: 0.146042
  type: 'test'
  ...
# Subtest: revision 0 KEEPS an outcome a never-retrieved run can honestly carry
ok 2663 - revision 0 KEEPS an outcome a never-retrieved run can honestly carry
  ---
  duration_ms: 0.371
  type: 'test'
  ...
# Subtest: a REJECTED write is reported as rejected, never as settled, and leaves durable evidence
ok 2664 - a REJECTED write is reported as rejected, never as settled, and leaves durable evidence
  ---
  duration_ms: 0.8825
  type: 'test'
  ...
# Subtest: an identical-content retry stays SETTLED and burns no revision
ok 2665 - an identical-content retry stays SETTLED and burns no revision
  ---
  duration_ms: 0.145167
  type: 'test'
  ...
# Subtest: v9 §4.2 — settlement REFUSES a duplicate role and reports it, rather than settling it twice
ok 2666 - v9 §4.2 — settlement REFUSES a duplicate role and reports it, rather than settling it twice
  ---
  duration_ms: 0.14125
  type: 'test'
  ...
# Subtest: v9 §4.2 — `status` stays at D12's three values; the new class rides in `rejection`
ok 2667 - v9 §4.2 — `status` stays at D12's three values; the new class rides in `rejection`
  ---
  duration_ms: 0.092792
  type: 'test'
  ...
# Subtest: v9 §4.2 — the vocabulary has SIX classes, and the sixth needs no migration
ok 2668 - v9 §4.2 — the vocabulary has SIX classes, and the sixth needs no migration
  ---
  duration_ms: 0.510166
  type: 'test'
  ...
# Subtest: v9 §4.2 — a duplicate role at the TERMINAL WRITE throws, as an undeclared role already does
ok 2669 - v9 §4.2 — a duplicate role at the TERMINAL WRITE throws, as an undeclared role already does
  ---
  duration_ms: 0.702459
  type: 'test'
  ...
# Subtest: v9 §4.2 — a handle with one run per role is untouched by the guard
ok 2670 - v9 §4.2 — a handle with one run per role is untouched by the guard
  ---
  duration_ms: 0.249209
  type: 'test'
  ...
# Subtest: v9 §4.1 — the base outcome type excludes persisted_dirty, and the mappers cannot produce it
ok 2671 - v9 §4.1 — the base outcome type excludes persisted_dirty, and the mappers cannot produce it
  ---
  duration_ms: 0.11125
  type: 'test'
  ...
# Subtest: 56.0 — the round trip runs against a REAL, DISPOSABLE PostgreSQL on 127.0.0.1 in a temporary directory: it answers SELECT version(), holds the one empty table, and is not any shared or production database
ok 2672 - 56.0 — the round trip runs against a REAL, DISPOSABLE PostgreSQL on 127.0.0.1 in a temporary directory: it answers SELECT version(), holds the one empty table, and is not any shared or production database
  ---
  duration_ms: 191.642209
  type: 'test'
  ...
# Subtest: 56.1 — RECURSIVE canonicalization: keys are sorted at EVERY depth, inside objects and inside objects nested in arrays, and array order is preserved
ok 2673 - 56.1 — RECURSIVE canonicalization: keys are sorted at EVERY depth, inside objects and inside objects nested in arrays, and array order is preserved
  ---
  duration_ms: 0.182
  type: 'test'
  ...
# Subtest: 56.2 — NESTED-KEY PERMUTATION: two documents whose keys are inserted in different orders at several depths canonicalize to the SAME string
ok 2674 - 56.2 — NESTED-KEY PERMUTATION: two documents whose keys are inserted in different orders at several depths canonicalize to the SAME string
  ---
  duration_ms: 0.117834
  type: 'test'
  ...
# Subtest: 56.3 — JSONB ROUND TRIP, REAL: the canonical bytes are INSERTed as jsonb into the disposable PostgreSQL and SELECTed back; PostgreSQL returns them in ITS key order (visibly not the canonical order), and canonicalizing what came back reproduces the persisted bytes exactly — the identical-content no-op check compares equal
ok 2675 - 56.3 — JSONB ROUND TRIP, REAL: the canonical bytes are INSERTed as jsonb into the disposable PostgreSQL and SELECTed back; PostgreSQL returns them in ITS key order (visibly not the canonical order), and canonicalizing what came back reproduces the persisted bytes exactly — the identical-content no-op check compares equal
  ---
  duration_ms: 126.766083
  type: 'test'
  ...
# Subtest: 56.4 — ARRAY REORDER IS NOT EQUAL: array order is content, at the top level and nested — for canonicalJson AND for the jsonb PostgreSQL holds; a reordered array round-tripped through the database is a DIFFERENT document
ok 2676 - 56.4 — ARRAY REORDER IS NOT EQUAL: array order is content, at the top level and nested — for canonicalJson AND for the jsonb PostgreSQL holds; a reordered array round-tripped through the database is a DIFFERENT document
  ---
  duration_ms: 391.287625
  type: 'test'
  ...
# Subtest: 56.5 — an UNDEFINED ARRAY ELEMENT is REJECTED (thrown, not dropped and not nulled), while undefined in an object is omitted
ok 2677 - 56.5 — an UNDEFINED ARRAY ELEMENT is REJECTED (thrown, not dropped and not nulled), while undefined in an object is omitted
  ---
  duration_ms: 0.698708
  type: 'test'
  ...
# Subtest: 56.6 — NON-FINITE numbers are rejected at any depth, and finite ones pass — and survive the real round trip
ok 2678 - 56.6 — NON-FINITE numbers are rejected at any depth, and finite ones pass — and survive the real round trip
  ---
  duration_ms: 135.340583
  type: 'test'
  ...
# Subtest: 56.7 — THE LIFECYCLE RULES, proved against a fake runner (v26 §3.7): deletion follows VERIFIED shutdown; a stop failure with the server still running LEAVES the directory in place and fails by name; a bounded timeout is a named failure, not a hang
ok 2679 - 56.7 — THE LIFECYCLE RULES, proved against a fake runner (v26 §3.7): deletion follows VERIFIED shutdown; a stop failure with the server still running LEAVES the directory in place and fails by name; a bounded timeout is a named failure, not a hang
  ---
  duration_ms: 408.81475
  type: 'test'
  ...
# Subtest: the runtime states and the state CHECK are the same list, in the same order
ok 2680 - the runtime states and the state CHECK are the same list, in the same order
  ---
  duration_ms: 2.416416
  type: 'test'
  ...
# Subtest: the outcome CHECK pins its two state lists the same way, and neither slice is empty
ok 2681 - the outcome CHECK pins its two state lists the same way, and neither slice is empty
  ---
  duration_ms: 0.733375
  type: 'test'
  ...
# Subtest: the three outcome-CHECK sets PARTITION all fourteen states — no overlap, none omitted
ok 2682 - the three outcome-CHECK sets PARTITION all fourteen states — no overlap, none omitted
  ---
  duration_ms: 0.213458
  type: 'test'
  ...
# Subtest: two states are non-terminal, and a window cannot close on either
ok 2683 - two states are non-terminal, and a window cannot close on either
  ---
  duration_ms: 0.19225
  type: 'test'
  ...
# Subtest: the migration still declares its retention, access and deletion controls (§4.2)
ok 2684 - the migration still declares its retention, access and deletion controls (§4.2)
  ---
  duration_ms: 0.431583
  type: 'test'
  ...
# Subtest: the HMAC is keyed, versioned, and unreproducible with an unkeyed hash
ok 2685 - the HMAC is keyed, versioned, and unreproducible with an unkeyed hash
  ---
  duration_ms: 9.571125
  type: 'test'
  ...
# Subtest: key version travels with the value, so a rotation is visible rather than inferred
ok 2686 - key version travels with the value, so a rotation is visible rather than inferred
  ---
  duration_ms: 0.519542
  type: 'test'
  ...
# Subtest: a missing secret THROWS, and a whitespace-only key counts as missing (D8, test 71)
ok 2687 - a missing secret THROWS, and a whitespace-only key counts as missing (D8, test 71)
  ---
  duration_ms: 0.624041
  type: 'test'
  ...
# Subtest: 35.1 — every served class increments its OWN counter, and a null increments none (D16 rows: provider success → that route counter; proven non-delivery → not_served; attribution gap → unattributed; a stage-level null → nothing)
ok 2688 - 35.1 — every served class increments its OWN counter, and a null increments none (D16 rows: provider success → that route counter; proven non-delivery → not_served; attribution gap → unattributed; a stage-level null → nothing)
  ---
  duration_ms: 2.211708
  type: 'test'
  ...
# Subtest: counters derive from the manifest, so row and payload cannot disagree
ok 2689 - counters derive from the manifest, so row and payload cannot disagree
  ---
  duration_ms: 0.391333
  type: 'test'
  ...
# Subtest: rerank_429_attempts is the count of http_429 attempts, wherever they happened (test 13)
ok 2690 - rerank_429_attempts is the count of http_429 attempts, wherever they happened (test 13)
  ---
  duration_ms: 0.073875
  type: 'test'
  ...
# Subtest: batch order is a property of candidate boundaries, never of completion order (constraint 7)
ok 2691 - batch order is a property of candidate boundaries, never of completion order (constraint 7)
  ---
  duration_ms: 0.737792
  type: 'test'
  ...
# Subtest: neither field-bearing manifest declaration has a field that could carry clinical text
ok 2692 - neither field-bearing manifest declaration has a field that could carry clinical text
  ---
  duration_ms: 0.54675
  type: 'test'
  ...
# Subtest: the ban loop really bans — it fails when a banned field is added
ok 2693 - the ban loop really bans — it fails when a banned field is added
  ---
  duration_ms: 0.11675
  type: 'test'
  ...
# Subtest: TelemetryCapture is not declared in the core — the raw bytes live elsewhere (D5)
ok 2694 - TelemetryCapture is not declared in the core — the raw bytes live elsewhere (D5)
  ---
  duration_ms: 0.326875
  type: 'test'
  ...
# Subtest: StampedRetrievalManifest is EXACTLY the intersection, so nothing can be smuggled through it
ok 2695 - StampedRetrievalManifest is EXACTLY the intersection, so nothing can be smuggled through it
  ---
  duration_ms: 1.203709
  type: 'test'
  ...
# Subtest: every route maps to a class, and an unknown caller is never assigned to the nearest match
ok 2696 - every route maps to a class, and an unknown caller is never assigned to the nearest match
  ---
  duration_ms: 0.066833
  type: 'test'
  ...
# Subtest: the reconciler is an INVOCATION route and never a retrieval route (D17)
ok 2697 - the reconciler is an INVOCATION route and never a retrieval route (D17)
  ---
  duration_ms: 0.040708
  type: 'test'
  ...
# Subtest: the five roles are closed, and the appropriateness exclusion is by ROUTE not by role
ok 2698 - the five roles are closed, and the appropriateness exclusion is by ROUTE not by role
  ---
  duration_ms: 0.042792
  type: 'test'
  ...
# Subtest: usage aggregates by served provider/model, not by intended
ok 2699 - usage aggregates by served provider/model, not by intended
  ---
  duration_ms: 6.826125
  type: 'test'
  ...
# Subtest: a bucket with no usage reports null tokens and counts the unknowns — never zero (§4.6)
ok 2700 - a bucket with no usage reports null tokens and counts the unknowns — never zero (§4.6)
  ---
  duration_ms: 0.075333
  type: 'test'
  ...
# Subtest: partial usage is summed without inventing the missing half
ok 2701 - partial usage is summed without inventing the missing half
  ---
  duration_ms: 0.061834
  type: 'test'
  ...
# Subtest: local, not-served and skipped stages are UNPRICED; unattributed and parse failures are not
ok 2702 - local, not-served and skipped stages are UNPRICED; unattributed and parse failures are not
  ---
  duration_ms: 0.152959
  type: 'test'
  ...
# Subtest: this module prices nothing — money has ONE source of truth
ok 2703 - this module prices nothing — money has ONE source of truth
  ---
  duration_ms: 0.452958
  type: 'test'
  ...
# Subtest: the row contract and the manifest contract version independently (§4.3)
ok 2704 - the row contract and the manifest contract version independently (§4.3)
  ---
  duration_ms: 0.122625
  type: 'test'
  ...
# Subtest: 35.2 — ROW 1, provider success: vertex → vertex, openrouter → openrouter, ollama → local; that route counter += 1, failed unchanged, served model and attempts PRESERVED
ok 2705 - 35.2 — ROW 1, provider success: vertex → vertex, openrouter → openrouter, ollama → local; that route counter += 1, failed unchanged, served model and attempts PRESERVED
  ---
  duration_ms: 0.578208
  type: 'test'
  ...
# Subtest: 35.3 — ROW 2, terminal failure PROVEN to have returned no completion: not_served += 1, failed += 1, served_route_class not_served, served_model null
ok 2706 - 35.3 — ROW 2, terminal failure PROVEN to have returned no completion: not_served += 1, failed += 1, served_route_class not_served, served_model null
  ---
  duration_ms: 0.084958
  type: 'test'
  ...
# Subtest: 35.4 — ROW 3, a completion may have arrived and attribution is unavailable: unattributed += 1 (rerank_unattributed_batches), failed FOLLOWS the batch outcome, served_route_class unattributed
ok 2707 - 35.4 — ROW 3, a completion may have arrived and attribution is unavailable: unattributed += 1 (rerank_unattributed_batches), failed FOLLOWS the batch outcome, served_route_class unattributed
  ---
  duration_ms: 0.098167
  type: 'test'
  ...
# Subtest: 35.5 — ROW 4, timeout: the attempt records outcome timeout, the batch outcome is timeout, and the served class follows the PROOF rule — not_served with proof, unattributed without
ok 2708 - 35.5 — ROW 4, timeout: the attempt records outcome timeout, the batch outcome is timeout, and the served class follows the PROOF rule — not_served with proof, unattributed without
  ---
  duration_ms: 0.102542
  type: 'test'
  ...
# Subtest: 35.6 — ROW 5 and the v11 §6.1 CORRECTION: a SKIPPED expansion stage records served_route_class null (NOT not_served), no route counter, no not_served counter — and attempts: [] , never null
ok 2709 - 35.6 — ROW 5 and the v11 §6.1 CORRECTION: a SKIPPED expansion stage records served_route_class null (NOT not_served), no route counter, no not_served counter — and attempts: [] , never null
  ---
  duration_ms: 0.160583
  type: 'test'
  ...
# Subtest: 35.7 — the v11 §6.1 CORRECTION at the other two sites: ABSENT evidence records attempts [] on a batch and on variant generation, while a transport that did NOT COLLECT (attempts: null on real evidence) keeps null
ok 2710 - 35.7 — the v11 §6.1 CORRECTION at the other two sites: ABSENT evidence records attempts [] on a batch and on variant generation, while a transport that did NOT COLLECT (attempts: null on real evidence) keeps null
  ---
  duration_ms: 0.199583
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [rerank] backend failed, returning input order generic, untyped
# [rerank] backend failed, returning input order generic, untyped
# Subtest: 35.8 — ROW 6 AS AMENDED (v7 §6, v8 §2): a soft failure without transport proof synthesises one terminal_failure record per PLANNED boundary — MORE THAN ONE boundary on the judge arm, each with its exact start and end — served_route_class UNATTRIBUTED (not the not_served D16 wrote), rerank_soft_failed true; not_served stands only where proof exists
ok 2711 - 35.8 — ROW 6 AS AMENDED (v7 §6, v8 §2): a soft failure without transport proof synthesises one terminal_failure record per PLANNED boundary — MORE THAN ONE boundary on the judge arm, each with its exact start and end — served_route_class UNATTRIBUTED (not the not_served D16 wrote), rerank_soft_failed true; not_served stands only where proof exists
  ---
  duration_ms: 90.306834
  type: 'test'
  ...
# Subtest: 35.9 — ROW 7, intended local request: exactly one ollama attempt; local on success, not_served on PROVEN failure
ok 2712 - 35.9 — ROW 7, intended local request: exactly one ollama attempt; local on success, not_served on PROVEN failure
  ---
  duration_ms: 0.142708
  type: 'test'
  ...
# Subtest: 35.10 — ROW 8, variant parse_failure: served provider, model, attempts and BOTH token counts are PRESERVED, status parse_failure, never not_served
ok 2713 - 35.10 — ROW 8, variant parse_failure: served provider, model, attempts and BOTH token counts are PRESERVED, status parse_failure, never not_served
  ---
  duration_ms: 0.104292
  type: 'test'
  ...
# Subtest: 35.11 — ROW 9, variant parsed_empty / all_invalid / not_an_array: served provider, model and usage preserved
ok 2714 - 35.11 — ROW 9, variant parsed_empty / all_invalid / not_an_array: served provider, model and usage preserved
  ---
  duration_ms: 0.078042
  type: 'test'
  ...
# Subtest: 35.12 — ROW 10 and the v11 §6.2 CORRECTION: a variant-generation stage that RAN and failed_open records not_served ONLY with proof, otherwise UNATTRIBUTED — and only a stage that did NOT run records the stage-level null
ok 2715 - 35.12 — ROW 10 and the v11 §6.2 CORRECTION: a variant-generation stage that RAN and failed_open records not_served ONLY with proof, otherwise UNATTRIBUTED — and only a stage that did NOT run records the stage-level null
  ---
  duration_ms: 0.074083
  type: 'test'
  ...
# Subtest: 35.13 — D16, Bedrock defensively: a Bedrock completion on this path is unattributed, never quietly mapped to a plausible class
ok 2716 - 35.13 — D16, Bedrock defensively: a Bedrock completion on this path is unattributed, never quietly mapped to a plausible class
  ---
  duration_ms: 0.046
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [retrieval-telemetry] settlement rejected: stale_revision primary expected 0, found 1
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state unknown
# [retrieval-telemetry] failure store write failed: Error connecting to database: AlsoDown (stub)
# [retrieval-telemetry] failure store write failed: Error connecting to database: AlsoDown (stub)
# [retrieval-telemetry] telemetry_write_failures increment failed: Error connecting to database: DownToo (stub)
# [retrieval-telemetry] terminal write rejected (revision or state moved) primary — row state unknown
# Subtest: 19 — the predeclared run id is the one every later write targets, and no second row is inserted
ok 2717 - 19 — the predeclared run id is the one every later write targets, and no second row is inserted
  ---
  duration_ms: 2.296
  type: 'test'
  ...
# Subtest: 20 — declare returns 0, the terminal write returns 1, and a stale handle is REJECTED
ok 2718 - 20 — declare returns 0, the terminal write returns 1, and a stale handle is REJECTED
  ---
  duration_ms: 0.670791
  type: 'test'
  ...
# Subtest: 20 — revisions advance PER ROLE: a normative write cannot invalidate the primary's handle
ok 2719 - 20 — revisions advance PER ROLE: a normative write cannot invalidate the primary's handle
  ---
  duration_ms: 0.968209
  type: 'test'
  ...
# Subtest: 20 — a terminal write that matches nothing is NOT retried, and does not advance the handle
ok 2720 - 20 — a terminal write that matches nothing is NOT retried, and does not advance the handle
  ---
  duration_ms: 0.265209
  type: 'test'
  ...
# Subtest: 31 — the reuse guard returns BEFORE any telemetry statement exists
ok 2721 - 31 — the reuse guard returns BEFORE any telemetry statement exists
  ---
  duration_ms: 0.319708
  type: 'test'
  ...
# Subtest: 32 — the attached handle is absent from JSON.stringify, from the keys, and from a spread
ok 2722 - 32 — the attached handle is absent from JSON.stringify, from the keys, and from a spread
  ---
  duration_ms: 0.100625
  type: 'test'
  ...
# Subtest: 34 — terminal write fails, failure row fails: the invocation counter is the only evidence left
ok 2723 - 34 — terminal write fails, failure row fails: the invocation counter is the only evidence left
  ---
  duration_ms: 0.337
  type: 'test'
  ...
# Subtest: 34 — and when the counter ALSO fails: a log line, nothing else, still no propagation
ok 2724 - 34 — and when the counter ALSO fails: a log line, nothing else, still no propagation
  ---
  duration_ms: 0.290583
  type: 'test'
  ...
# Subtest: 34 — NO MODULE-LEVEL COUNTER EXISTS ANYWHERE, asserted by source search
ok 2725 - 34 — NO MODULE-LEVEL COUNTER EXISTS ANYWHERE, asserted by source search
  ---
  duration_ms: 0.59025
  type: 'test'
  ...
# Subtest: 52 — every owner in the D9 matrix settles, including both scripts and both MCP paths
ok 2726 - 52 — every owner in the D9 matrix settles, including both scripts and both MCP paths
  ---
  duration_ms: 1.122791
  type: 'test'
  ...
# Subtest: 53 — the callback carries the audit id, and its failure never changes the save result
ok 2727 - 53 — the callback carries the audit id, and its failure never changes the save result
  ---
  duration_ms: 0.296834
  type: 'test'
  ...
# [retrieval-telemetry] terminal write rejected (revision or state moved) normative_channel — row state unknown
# Subtest: CANARY-GATE HAZARD — primary rejected, normative lands: the audit persisted and the Stage 0b primary-link gate fails
ok 2728 - CANARY-GATE HAZARD — primary rejected, normative lands: the audit persisted and the Stage 0b primary-link gate fails
  ---
  duration_ms: 8.607583
  type: 'test'
  ...
# Subtest: CANARY-GATE HAZARD — the mirror: primary lands, normative rejected
ok 2729 - CANARY-GATE HAZARD — the mirror: primary lands, normative rejected
  ---
  duration_ms: 11.653291
  type: 'test'
  ...
# Subtest: 54 — fourteen states, two of them non-terminal, and the two sets partition the whole
ok 2730 - 54 — fourteen states, two of them non-terminal, and the two sets partition the whole
  ---
  duration_ms: 0.542875
  type: 'test'
  ...
# Subtest: 54 — the implemented table IS D12's table, in both directions
ok 2731 - 54 — the implemented table IS D12's table, in both directions
  ---
  duration_ms: 0.387708
  type: 'test'
  ...
# Subtest: 54 — every one of the 196 ordered pairs answers the way D12 says
ok 2732 - 54 — every one of the 196 ordered pairs answers the way D12 says
  ---
  duration_ms: 0.178208
  type: 'test'
  ...
# Subtest: 54 — TERMINAL STATES NEVER TRANSITION, to anything, including themselves
ok 2733 - 54 — TERMINAL STATES NEVER TRANSITION, to anything, including themselves
  ---
  duration_ms: 0.088292
  type: 'test'
  ...
# Subtest: 54 — the two deliberate asymmetries are both present, and are not accidents
ok 2734 - 54 — the two deliberate asymmetries are both present, and are not accidents
  ---
  duration_ms: 0.091916
  type: 'test'
  ...
# Subtest: 54 — every settlement outcome lands on a state, and the settlement table names none of the three reconciler-mapped states
ok 2735 - 54 — every settlement outcome lands on a state, and the settlement table names none of the three reconciler-mapped states
  ---
  duration_ms: 0.084791
  type: 'test'
  ...
# Subtest: 54 — every reconciler-assigned state is a LEGAL transition from the state it is assigned from
ok 2736 - 54 — every reconciler-assigned state is a LEGAL transition from the state it is assigned from
  ---
  duration_ms: 0.105334
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# \# proof 45: D17_FIELD_MATRIX has 74 entries; 222 generated cases
# \# proof 45: D17's list transcribes to 54 fields; 53 are matrix rows and 1 (multi_query) is the role-conditional presence rule
# \# proof 45: matrix rows by origin: D17=57, D8=4, D16=2, v25 §3.3=1, v7 §10=2, v26 §3.1=2, D15=2, v25 §3.2=2, v26 §3.5=2
# \# proof 45: 1708 hostile placements, none threw
# Subtest: 45.0 — the fixture is CLEAN: the valid manifest returns no code, so every code below is caused by the one mutation named beside it
ok 2737 - 45.0 — the fixture is CLEAN: the valid manifest returns no code, so every code below is caused by the one mutation named beside it
  ---
  duration_ms: 2.69
  type: 'test'
  ...
# Subtest: 45.2 — manifest_schema_version: null → manifest_version_unrecognized
ok 2738 - 45.2 — manifest_schema_version: null → manifest_version_unrecognized
  ---
  duration_ms: 0.253458
  type: 'test'
  ...
# Subtest: 45.3 — manifest_schema_version: wrong version 2 → manifest_version_unrecognized
ok 2739 - 45.3 — manifest_schema_version: wrong version 2 → manifest_version_unrecognized
  ---
  duration_ms: 0.125458
  type: 'test'
  ...
# Subtest: 45.4 — hmac_key_version: null WITHOUT hmac_key_absent → hmac_key_version_absent
ok 2740 - 45.4 — hmac_key_version: null WITHOUT hmac_key_absent → hmac_key_version_absent
  ---
  duration_ms: 0.106417
  type: 'test'
  ...
# Subtest: 45.5 — hmac_key_version: empty string → hmac_key_version_absent
ok 2741 - 45.5 — hmac_key_version: empty string → hmac_key_version_absent
  ---
  duration_ms: 0.119208
  type: 'test'
  ...
# Subtest: 45.6 — operational: missing → operational_absent
ok 2742 - 45.6 — operational: missing → operational_absent
  ---
  duration_ms: 0.105042
  type: 'test'
  ...
# Subtest: 45.7 — operational.route: missing → route_absent_or_invalid
ok 2743 - 45.7 — operational.route: missing → route_absent_or_invalid
  ---
  duration_ms: 0.102833
  type: 'test'
  ...
# Subtest: 45.8 — operational.route: invalid (not in RETRIEVAL_ROUTES) → route_absent_or_invalid
ok 2744 - 45.8 — operational.route: invalid (not in RETRIEVAL_ROUTES) → route_absent_or_invalid
  ---
  duration_ms: 0.144625
  type: 'test'
  ...
# Subtest: 45.9 — operational.route_class: null → route_class_absent
ok 2745 - 45.9 — operational.route_class: null → route_class_absent
  ---
  duration_ms: 0.211958
  type: 'test'
  ...
# Subtest: 45.10 — operational.retrieval_role: invalid → retrieval_role_absent_or_invalid
ok 2746 - 45.10 — operational.retrieval_role: invalid → retrieval_role_absent_or_invalid
  ---
  duration_ms: 0.36575
  type: 'test'
  ...
# Subtest: 45.11 — operational.started_at: null → started_at_absent
ok 2747 - 45.11 — operational.started_at: null → started_at_absent
  ---
  duration_ms: 0.098958
  type: 'test'
  ...
# Subtest: 45.12 — operational.completed_at: empty string → completed_at_absent
ok 2748 - 45.12 — operational.completed_at: empty string → completed_at_absent
  ---
  duration_ms: 0.0835
  type: 'test'
  ...
# Subtest: 45.13 — operational.invocation_id: empty string → invocation_id_absent
ok 2749 - 45.13 — operational.invocation_id: empty string → invocation_id_absent
  ---
  duration_ms: 0.081
  type: 'test'
  ...
# Subtest: 45.14 — operational.trace_id: missing (null is permitted) → trace_id_field_absent
ok 2750 - 45.14 — operational.trace_id: missing (null is permitted) → trace_id_field_absent
  ---
  duration_ms: 0.079292
  type: 'test'
  ...
# Subtest: 45.15 — operational.deployment_sha: missing (null is permitted) → deployment_sha_field_absent
ok 2751 - 45.15 — operational.deployment_sha: missing (null is permitted) → deployment_sha_field_absent
  ---
  duration_ms: 0.083291
  type: 'test'
  ...
# Subtest: 45.16 — operational.routing_flags: null ({} is permitted) → routing_flags_absent
ok 2752 - 45.16 — operational.routing_flags: null ({} is permitted) → routing_flags_absent
  ---
  duration_ms: 0.082875
  type: 'test'
  ...
# Subtest: 45.17 — operational.routing_flags: an array is not a flags object → routing_flags_absent
ok 2753 - 45.17 — operational.routing_flags: an array is not a flags object → routing_flags_absent
  ---
  duration_ms: 0.07775
  type: 'test'
  ...
# Subtest: 45.18 — operational.active_backfill_run_id: missing (null is permitted) → active_backfill_run_id_field_absent
ok 2754 - 45.18 — operational.active_backfill_run_id: missing (null is permitted) → active_backfill_run_id_field_absent
  ---
  duration_ms: 0.076375
  type: 'test'
  ...
# Subtest: 45.19 — operational.active_backfill_target: missing (null is permitted) → active_backfill_target_field_absent
ok 2755 - 45.19 — operational.active_backfill_target: missing (null is permitted) → active_backfill_target_field_absent
  ---
  duration_ms: 0.078292
  type: 'test'
  ...
# Subtest: 45.20 — operational.active_backfill_state: missing (null is permitted) → active_backfill_state_field_absent
ok 2756 - 45.20 — operational.active_backfill_state: missing (null is permitted) → active_backfill_state_field_absent
  ---
  duration_ms: 0.084208
  type: 'test'
  ...
# Subtest: 45.21 — operational.active_backfill_state: invalid (not active/idle) → active_backfill_state_invalid
ok 2757 - 45.21 — operational.active_backfill_state: invalid (not active/idle) → active_backfill_state_invalid
  ---
  duration_ms: 0.076667
  type: 'test'
  ...
# Subtest: 45.22 — operational.active_lab_experiment_id: missing (null is permitted) → active_lab_experiment_id_field_absent
ok 2758 - 45.22 — operational.active_lab_experiment_id: missing (null is permitted) → active_lab_experiment_id_field_absent
  ---
  duration_ms: 0.078083
  type: 'test'
  ...
# Subtest: 45.23 — retrieval_outcome: null → retrieval_outcome_absent_or_invalid
ok 2759 - 45.23 — retrieval_outcome: null → retrieval_outcome_absent_or_invalid
  ---
  duration_ms: 0.07425
  type: 'test'
  ...
# Subtest: 45.24 — retrieval_outcome: invalid → retrieval_outcome_absent_or_invalid
ok 2760 - 45.24 — retrieval_outcome: invalid → retrieval_outcome_absent_or_invalid
  ---
  duration_ms: 0.07625
  type: 'test'
  ...
# Subtest: 45.25 — retrieval_error_class: missing (null is permitted on success) → retrieval_error_class_field_absent
ok 2761 - 45.25 — retrieval_error_class: missing (null is permitted on success) → retrieval_error_class_field_absent
  ---
  duration_ms: 0.075
  type: 'test'
  ...
# Subtest: 45.26 — retrieval_error_class: null when the outcome is retrieval_failure → retrieval_error_class_absent_on_failure
ok 2762 - 45.26 — retrieval_error_class: null when the outcome is retrieval_failure → retrieval_error_class_absent_on_failure
  ---
  duration_ms: 0.083375
  type: 'test'
  ...
# Subtest: 45.27 — expansion: missing → expansion_absent
ok 2763 - 45.27 — expansion: missing → expansion_absent
  ---
  duration_ms: 0.0765
  type: 'test'
  ...
# Subtest: 45.28 — expansion.status: null → expansion_status_absent_or_invalid
ok 2764 - 45.28 — expansion.status: null → expansion_status_absent_or_invalid
  ---
  duration_ms: 0.083125
  type: 'test'
  ...
# Subtest: 45.29 — expansion.input_hmac: missing → expansion_input_hmac_field_absent
ok 2765 - 45.29 — expansion.input_hmac: missing → expansion_input_hmac_field_absent
  ---
  duration_ms: 0.077666
  type: 'test'
  ...
# Subtest: 45.30 — expansion.input_hmac: null on an EXPANDED stage without hmac_key_absent → expansion_input_hmac_absent
ok 2766 - 45.30 — expansion.input_hmac: null on an EXPANDED stage without hmac_key_absent → expansion_input_hmac_absent
  ---
  duration_ms: 0.075417
  type: 'test'
  ...
# Subtest: 45.31 — expansion.served_route_class: missing → expansion_served_route_class_field_absent
ok 2767 - 45.31 — expansion.served_route_class: missing → expansion_served_route_class_field_absent
  ---
  duration_ms: 0.075709
  type: 'test'
  ...
# Subtest: 45.32 — expansion.served_route_class: null on an EXPANDED stage → expansion_served_route_class_absent
ok 2768 - 45.32 — expansion.served_route_class: null on an EXPANDED stage → expansion_served_route_class_absent
  ---
  duration_ms: 0.077667
  type: 'test'
  ...
# Subtest: 45.33 — expansion.served_route_class: invalid → expansion_served_route_class_invalid
ok 2769 - 45.33 — expansion.served_route_class: invalid → expansion_served_route_class_invalid
  ---
  duration_ms: 0.078833
  type: 'test'
  ...
# Subtest: 45.34 — expansion.served_model: missing (null is permitted) → expansion_served_model_field_absent
ok 2770 - 45.34 — expansion.served_model: missing (null is permitted) → expansion_served_model_field_absent
  ---
  duration_ms: 0.078292
  type: 'test'
  ...
# Subtest: 45.35 — expansion.attempts: missing (null and [] are permitted) → expansion_attempts_field_absent
ok 2771 - 45.35 — expansion.attempts: missing (null and [] are permitted) → expansion_attempts_field_absent
  ---
  duration_ms: 0.076208
  type: 'test'
  ...
# Subtest: 45.36 — expansion.attempts: a non-array, non-null value → attempt_outcome_absent_or_invalid
ok 2772 - 45.36 — expansion.attempts: a non-array, non-null value → attempt_outcome_absent_or_invalid
  ---
  duration_ms: 0.075834
  type: 'test'
  ...
# Subtest: 45.37 — fused_candidate_ids: null ([] is permitted) → fused_candidate_ids_absent
ok 2773 - 45.37 — fused_candidate_ids: null ([] is permitted) → fused_candidate_ids_absent
  ---
  duration_ms: 0.073167
  type: 'test'
  ...
# Subtest: 45.38 — fused_candidate_ids: a non-numeric member → fused_candidate_ids_absent
ok 2774 - 45.38 — fused_candidate_ids: a non-numeric member → fused_candidate_ids_absent
  ---
  duration_ms: 0.082167
  type: 'test'
  ...
# Subtest: 45.39 — hydrated_candidate_ids: null ([] is permitted) → hydrated_candidate_ids_absent
ok 2775 - 45.39 — hydrated_candidate_ids: null ([] is permitted) → hydrated_candidate_ids_absent
  ---
  duration_ms: 0.071917
  type: 'test'
  ...
# Subtest: 45.40 — fused_candidate_count: null → fused_candidate_count_absent
ok 2776 - 45.40 — fused_candidate_count: null → fused_candidate_count_absent
  ---
  duration_ms: 0.076875
  type: 'test'
  ...
# Subtest: 45.41 — fused_candidate_count: invalid number: negative → fused_candidate_count_absent
ok 2777 - 45.41 — fused_candidate_count: invalid number: negative → fused_candidate_count_absent
  ---
  duration_ms: 0.078333
  type: 'test'
  ...
# Subtest: 45.42 — fused_candidate_count: invalid number: NaN → fused_candidate_count_absent
ok 2778 - 45.42 — fused_candidate_count: invalid number: NaN → fused_candidate_count_absent
  ---
  duration_ms: 0.076125
  type: 'test'
  ...
# Subtest: 45.43 — fused_candidate_count: invalid number: a numeric STRING → fused_candidate_count_absent
ok 2779 - 45.43 — fused_candidate_count: invalid number: a numeric STRING → fused_candidate_count_absent
  ---
  duration_ms: 0.070709
  type: 'test'
  ...
# Subtest: 45.44 — hydrated_candidate_count: invalid number: Infinity → hydrated_candidate_count_absent
ok 2780 - 45.44 — hydrated_candidate_count: invalid number: Infinity → hydrated_candidate_count_absent
  ---
  duration_ms: 0.091792
  type: 'test'
  ...
# Subtest: 45.45 — hydrated_candidate_count: null → hydrated_candidate_count_absent
ok 2781 - 45.45 — hydrated_candidate_count: null → hydrated_candidate_count_absent
  ---
  duration_ms: 0.077417
  type: 'test'
  ...
# Subtest: 45.46 — pre_rerank_passage_hmacs: missing → pre_rerank_passage_hmacs_field_absent
ok 2782 - 45.46 — pre_rerank_passage_hmacs: missing → pre_rerank_passage_hmacs_field_absent
  ---
  duration_ms: 0.074166
  type: 'test'
  ...
# Subtest: 45.47 — pre_rerank_passage_hmacs: null WITHOUT hmac_key_absent → pre_rerank_passage_hmacs_absent
ok 2783 - 45.47 — pre_rerank_passage_hmacs: null WITHOUT hmac_key_absent → pre_rerank_passage_hmacs_absent
  ---
  duration_ms: 0.281458
  type: 'test'
  ...
# Subtest: 45.48 — pre_rerank_passage_hmacs: a non-array → pre_rerank_passage_hmacs_absent
ok 2784 - 45.48 — pre_rerank_passage_hmacs: a non-array → pre_rerank_passage_hmacs_absent
  ---
  duration_ms: 0.261375
  type: 'test'
  ...
# Subtest: 45.49 — pre_rerank_passage_hmacs: cardinality ≠ hydrated_candidate_ids (one per HYDRATED row) → passage_hmac_cardinality_mismatch
ok 2785 - 45.49 — pre_rerank_passage_hmacs: cardinality ≠ hydrated_candidate_ids (one per HYDRATED row) → passage_hmac_cardinality_mismatch
  ---
  duration_ms: 1.480042
  type: 'test'
  ...
# Subtest: 45.50 — intended_backend: null (the string none is permitted) → intended_backend_absent
ok 2786 - 45.50 — intended_backend: null (the string none is permitted) → intended_backend_absent
  ---
  duration_ms: 0.129625
  type: 'test'
  ...
# Subtest: 45.51 — intended_backend: empty string → intended_backend_absent
ok 2787 - 45.51 — intended_backend: empty string → intended_backend_absent
  ---
  duration_ms: 0.092917
  type: 'test'
  ...
# Subtest: 45.52 — intended_model: empty string → intended_model_absent
ok 2788 - 45.52 — intended_model: empty string → intended_model_absent
  ---
  duration_ms: 0.086667
  type: 'test'
  ...
# Subtest: 45.53 — served_backend: missing (null is permitted with no batches) → served_backend_field_absent
ok 2789 - 45.53 — served_backend: missing (null is permitted with no batches) → served_backend_field_absent
  ---
  duration_ms: 0.081708
  type: 'test'
  ...
# Subtest: 45.54 — served_backend: null once a batch record exists → served_backend_absent_with_batches
ok 2790 - 45.54 — served_backend: null once a batch record exists → served_backend_absent_with_batches
  ---
  duration_ms: 0.089792
  type: 'test'
  ...
# Subtest: 45.55 — rerank_backend_downgraded: null → rerank_backend_downgraded_absent
ok 2791 - 45.55 — rerank_backend_downgraded: null → rerank_backend_downgraded_absent
  ---
  duration_ms: 0.075917
  type: 'test'
  ...
# Subtest: 45.56 — rerank_soft_failed: a string, not a boolean → rerank_soft_failed_absent
ok 2792 - 45.56 — rerank_soft_failed: a string, not a boolean → rerank_soft_failed_absent
  ---
  duration_ms: 0.099333
  type: 'test'
  ...
# Subtest: 45.57 — expected_batch_count: null → expected_batch_count_absent
ok 2793 - 45.57 — expected_batch_count: null → expected_batch_count_absent
  ---
  duration_ms: 0.068417
  type: 'test'
  ...
# Subtest: 45.58 — recorded_rerank_batches: invalid number: NaN → recorded_rerank_batches_absent
ok 2794 - 45.58 — recorded_rerank_batches: invalid number: NaN → recorded_rerank_batches_absent
  ---
  duration_ms: 6.393917
  type: 'test'
  ...
# Subtest: 45.59 — recorded_rerank_batches: disagrees with batches.length → recorded_batch_count_mismatch
ok 2795 - 45.59 — recorded_rerank_batches: disagrees with batches.length → recorded_batch_count_mismatch
  ---
  duration_ms: 0.151292
  type: 'test'
  ...
# Subtest: 45.60 — expected_batch_count: disagrees with batches.length (§7, never waived) → batch_count_mismatch
ok 2796 - 45.60 — expected_batch_count: disagrees with batches.length (§7, never waived) → batch_count_mismatch
  ---
  duration_ms: 0.082292
  type: 'test'
  ...
# Subtest: 45.61 — batches: null ([] is permitted) → batches_absent
ok 2797 - 45.61 — batches: null ([] is permitted) → batches_absent
  ---
  duration_ms: 0.089791
  type: 'test'
  ...
# Subtest: 45.62 — batch.batch_index: missing → batch_index_absent
ok 2798 - 45.62 — batch.batch_index: missing → batch_index_absent
  ---
  duration_ms: 0.097125
  type: 'test'
  ...
# Subtest: 45.63 — batch.batch_index: duplicated → duplicate_batch_index
ok 2799 - 45.63 — batch.batch_index: duplicated → duplicate_batch_index
  ---
  duration_ms: 0.098375
  type: 'test'
  ...
# Subtest: 45.64 — batch.candidate_start: missing (v26 §3.3, its own row) → batch_boundaries_absent
ok 2800 - 45.64 — batch.candidate_start: missing (v26 §3.3, its own row) → batch_boundaries_absent
  ---
  duration_ms: 0.07425
  type: 'test'
  ...
# Subtest: 45.65 — batch.candidate_start: null (v26 §3.3, its own row) → batch_boundaries_absent
ok 2801 - 45.65 — batch.candidate_start: null (v26 §3.3, its own row) → batch_boundaries_absent
  ---
  duration_ms: 0.076125
  type: 'test'
  ...
# Subtest: 45.66 — batch.candidate_start: invalid: a numeric STRING (v26 §3.3, its own row) → batch_boundaries_absent
ok 2802 - 45.66 — batch.candidate_start: invalid: a numeric STRING (v26 §3.3, its own row) → batch_boundaries_absent
  ---
  duration_ms: 0.06875
  type: 'test'
  ...
# Subtest: 45.67 — batch.candidate_end: missing → batch_boundaries_absent
ok 2803 - 45.67 — batch.candidate_end: missing → batch_boundaries_absent
  ---
  duration_ms: 0.076125
  type: 'test'
  ...
# Subtest: 45.68 — batch.candidate_end: null → batch_boundaries_absent
ok 2804 - 45.68 — batch.candidate_end: null → batch_boundaries_absent
  ---
  duration_ms: 0.072167
  type: 'test'
  ...
# Subtest: 45.69 — batch.candidate_start/end: end <= start (the relation, after both fields validate) → bad_candidate_boundaries
ok 2805 - 45.69 — batch.candidate_start/end: end <= start (the relation, after both fields validate) → bad_candidate_boundaries
  ---
  duration_ms: 0.071334
  type: 'test'
  ...
# Subtest: 45.70 — batch (member): a null member — reported, never dereferenced (v26 §3.2) → batch_member_invalid
ok 2806 - 45.70 — batch (member): a null member — reported, never dereferenced (v26 §3.2) → batch_member_invalid
  ---
  duration_ms: 0.068875
  type: 'test'
  ...
# Subtest: 45.71 — batch (member): a numeric member → batch_member_invalid
ok 2807 - 45.71 — batch (member): a numeric member → batch_member_invalid
  ---
  duration_ms: 0.086334
  type: 'test'
  ...
# Subtest: 45.72 — batch.missing_score_keys: missing (D15 count) → missing_score_keys_absent
ok 2808 - 45.72 — batch.missing_score_keys: missing (D15 count) → missing_score_keys_absent
  ---
  duration_ms: 0.14125
  type: 'test'
  ...
# Subtest: 45.73 — batch.nonnumeric_score_keys: invalid: negative (D15 count) → nonnumeric_score_keys_absent
ok 2809 - 45.73 — batch.nonnumeric_score_keys: invalid: negative (D15 count) → nonnumeric_score_keys_absent
  ---
  duration_ms: 0.0815
  type: 'test'
  ...
# Subtest: 45.74 — telemetry_error: missing (D8 — the licence declaration must be a present field) → telemetry_error_field_absent
ok 2810 - 45.74 — telemetry_error: missing (D8 — the licence declaration must be a present field) → telemetry_error_field_absent
  ---
  duration_ms: 0.076667
  type: 'test'
  ...
# Subtest: 45.75 — telemetry_error: invalid: an unknown error string → telemetry_error_invalid
ok 2811 - 45.75 — telemetry_error: invalid: an unknown error string → telemetry_error_invalid
  ---
  duration_ms: 0.075041
  type: 'test'
  ...
# Subtest: 45.76 — batch.intended_provider: empty string → batch_intended_provider_absent
ok 2812 - 45.76 — batch.intended_provider: empty string → batch_intended_provider_absent
  ---
  duration_ms: 0.075542
  type: 'test'
  ...
# Subtest: 45.77 — batch.intended_model: null → batch_intended_model_absent
ok 2813 - 45.77 — batch.intended_model: null → batch_intended_model_absent
  ---
  duration_ms: 0.07675
  type: 'test'
  ...
# Subtest: 45.78 — batch.served_route_class: missing → batch_served_route_class_absent
ok 2814 - 45.78 — batch.served_route_class: missing → batch_served_route_class_absent
  ---
  duration_ms: 18.529625
  type: 'test'
  ...
# Subtest: 45.79 — batch.served_route_class: null — the type permits it, the contract does not (A6) → batch_served_route_class_absent
ok 2815 - 45.79 — batch.served_route_class: null — the type permits it, the contract does not (A6) → batch_served_route_class_absent
  ---
  duration_ms: 0.180458
  type: 'test'
  ...
# Subtest: 45.80 — batch.served_route_class: invalid → batch_served_route_class_invalid
ok 2816 - 45.80 — batch.served_route_class: invalid → batch_served_route_class_invalid
  ---
  duration_ms: 0.107833
  type: 'test'
  ...
# Subtest: 45.81 — batch.served_model: missing (null is permitted) → batch_served_model_field_absent
ok 2817 - 45.81 — batch.served_model: missing (null is permitted) → batch_served_model_field_absent
  ---
  duration_ms: 0.087209
  type: 'test'
  ...
# Subtest: 45.82 — batch.served_model: non-null on an unattributed batch (§10) → unattributed_with_model
ok 2818 - 45.82 — batch.served_model: non-null on an unattributed batch (§10) → unattributed_with_model
  ---
  duration_ms: 0.0815
  type: 'test'
  ...
# Subtest: 45.83 — batch.served_model: non-null on a not_served batch (§10) → not_served_with_model
ok 2819 - 45.83 — batch.served_model: non-null on a not_served batch (§10) → not_served_with_model
  ---
  duration_ms: 0.077417
  type: 'test'
  ...
# Subtest: 45.84 — batch.attempts: missing (null is permitted) → batch_attempts_field_absent
ok 2820 - 45.84 — batch.attempts: missing (null is permitted) → batch_attempts_field_absent
  ---
  duration_ms: 0.0845
  type: 'test'
  ...
# Subtest: 45.85 — batch.attempts: a member with an outcome outside the six → attempt_outcome_absent_or_invalid
ok 2821 - 45.85 — batch.attempts: a member with an outcome outside the six → attempt_outcome_absent_or_invalid
  ---
  duration_ms: 0.085875
  type: 'test'
  ...
# Subtest: 45.86 — batch.prompt_tokens: missing (null is permitted) — v25 §3.2, unvalidated until the pass 3 repair → batch_prompt_tokens_field_absent
ok 2822 - 45.86 — batch.prompt_tokens: missing (null is permitted) — v25 §3.2, unvalidated until the pass 3 repair → batch_prompt_tokens_field_absent
  ---
  duration_ms: 0.098792
  type: 'test'
  ...
# Subtest: 45.87 — batch.prompt_tokens: invalid: a numeric STRING → batch_prompt_tokens_invalid
ok 2823 - 45.87 — batch.prompt_tokens: invalid: a numeric STRING → batch_prompt_tokens_invalid
  ---
  duration_ms: 0.077625
  type: 'test'
  ...
# Subtest: 45.88 — batch.prompt_tokens: invalid number: negative → batch_prompt_tokens_invalid
ok 2824 - 45.88 — batch.prompt_tokens: invalid number: negative → batch_prompt_tokens_invalid
  ---
  duration_ms: 0.076042
  type: 'test'
  ...
# Subtest: 45.89 — batch.prompt_tokens: invalid number: NaN → batch_prompt_tokens_invalid
ok 2825 - 45.89 — batch.prompt_tokens: invalid number: NaN → batch_prompt_tokens_invalid
  ---
  duration_ms: 0.077708
  type: 'test'
  ...
# Subtest: 45.90 — batch.completion_tokens: missing (null is permitted) — v25 §3.2, unvalidated until the pass 3 repair → batch_completion_tokens_field_absent
ok 2826 - 45.90 — batch.completion_tokens: missing (null is permitted) — v25 §3.2, unvalidated until the pass 3 repair → batch_completion_tokens_field_absent
  ---
  duration_ms: 0.076917
  type: 'test'
  ...
# Subtest: 45.91 — batch.completion_tokens: invalid: a numeric STRING → batch_completion_tokens_invalid
ok 2827 - 45.91 — batch.completion_tokens: invalid: a numeric STRING → batch_completion_tokens_invalid
  ---
  duration_ms: 0.079541
  type: 'test'
  ...
# Subtest: 45.92 — batch.completion_tokens: invalid number: Infinity → batch_completion_tokens_invalid
ok 2828 - 45.92 — batch.completion_tokens: invalid number: Infinity → batch_completion_tokens_invalid
  ---
  duration_ms: 0.074583
  type: 'test'
  ...
# Subtest: 45.93 — batch.completion_tokens: invalid: an object → batch_completion_tokens_invalid
ok 2829 - 45.93 — batch.completion_tokens: invalid: an object → batch_completion_tokens_invalid
  ---
  duration_ms: 0.085125
  type: 'test'
  ...
# Subtest: 45.94 — batch.outcome: invalid → batch_outcome_absent_or_invalid
ok 2830 - 45.94 — batch.outcome: invalid → batch_outcome_absent_or_invalid
  ---
  duration_ms: 0.077416
  type: 'test'
  ...
# Subtest: 45.95 — batch.expected_score_keys: null → expected_score_keys_absent
ok 2831 - 45.95 — batch.expected_score_keys: null → expected_score_keys_absent
  ---
  duration_ms: 0.078833
  type: 'test'
  ...
# Subtest: 45.96 — batch.finite_score_keys: invalid number: negative → finite_score_keys_absent
ok 2832 - 45.96 — batch.finite_score_keys: invalid number: negative → finite_score_keys_absent
  ---
  duration_ms: 0.076666
  type: 'test'
  ...
# Subtest: 45.97 — batch.finite_score_keys: more finite keys than expected → score_keys_exceed_expected
ok 2833 - 45.97 — batch.finite_score_keys: more finite keys than expected → score_keys_exceed_expected
  ---
  duration_ms: 0.081041
  type: 'test'
  ...
# Subtest: 45.98 — ordered_final_candidate_ids: null ([] is permitted) → ordered_final_candidate_ids_absent
ok 2834 - 45.98 — ordered_final_candidate_ids: null ([] is permitted) → ordered_final_candidate_ids_absent
  ---
  duration_ms: 0.07625
  type: 'test'
  ...
# Subtest: 45.99 — retrieval_config: null → retrieval_config_absent
ok 2835 - 45.99 — retrieval_config: null → retrieval_config_absent
  ---
  duration_ms: 0.085417
  type: 'test'
  ...
# Subtest: 45.100 — retrieval_config: an array is not a config object → retrieval_config_absent
ok 2836 - 45.100 — retrieval_config: an array is not a config object → retrieval_config_absent
  ---
  duration_ms: 0.087625
  type: 'test'
  ...
# Subtest: 45.101 — retrieval_config.rerank_temperature: missing (v7 §10: required as of manifest v3; null is permitted) → rerank_temperature_field_absent
ok 2837 - 45.101 — retrieval_config.rerank_temperature: missing (v7 §10: required as of manifest v3; null is permitted) → rerank_temperature_field_absent
  ---
  duration_ms: 0.086459
  type: 'test'
  ...
# Subtest: 45.102 — retrieval_config.rerank_temperature: invalid number: NaN → rerank_temperature_invalid
ok 2838 - 45.102 — retrieval_config.rerank_temperature: invalid number: NaN → rerank_temperature_invalid
  ---
  duration_ms: 0.100458
  type: 'test'
  ...
# Subtest: 45.103 — retrieval_config.rerank_seed_status: missing (v7 §10) → rerank_seed_status_field_absent
ok 2839 - 45.103 — retrieval_config.rerank_seed_status: missing (v7 §10) → rerank_seed_status_field_absent
  ---
  duration_ms: 0.080333
  type: 'test'
  ...
# Subtest: 45.104 — retrieval_config.rerank_seed_status: null — never null, not_applicable is the value for no decode → rerank_seed_status_invalid
ok 2840 - 45.104 — retrieval_config.rerank_seed_status: null — never null, not_applicable is the value for no decode → rerank_seed_status_invalid
  ---
  duration_ms: 10.397666
  type: 'test'
  ...
# Subtest: 45.105 — corpus_version: missing (null is permitted) → corpus_version_field_absent
ok 2841 - 45.105 — corpus_version: missing (null is permitted) → corpus_version_field_absent
  ---
  duration_ms: 0.119958
  type: 'test'
  ...
# Subtest: 45.106 — index_version: null → index_version_absent
ok 2842 - 45.106 — index_version: null → index_version_absent
  ---
  duration_ms: 0.085
  type: 'test'
  ...
# Subtest: 45.107 — index_version: empty string → index_version_absent
ok 2843 - 45.107 — index_version: empty string → index_version_absent
  ---
  duration_ms: 0.071041
  type: 'test'
  ...
# Subtest: 45.108 — scorer_context_hmac: missing → scorer_context_hmac_field_absent
ok 2844 - 45.108 — scorer_context_hmac: missing → scorer_context_hmac_field_absent
  ---
  duration_ms: 0.102625
  type: 'test'
  ...
# Subtest: 45.109 — scorer_context_hmac: null on role primary WITHOUT hmac_key_absent → scorer_context_hmac_absent
ok 2845 - 45.109 — scorer_context_hmac: null on role primary WITHOUT hmac_key_absent → scorer_context_hmac_absent
  ---
  duration_ms: 0.079667
  type: 'test'
  ...
# Subtest: 45.110 — multi_query: present on a role that is not lab_multi_query → multi_query_on_non_multi_query_role
ok 2846 - 45.110 — multi_query: present on a role that is not lab_multi_query → multi_query_on_non_multi_query_role
  ---
  duration_ms: 0.0845
  type: 'test'
  ...
# Subtest: 45.111 — the lab_multi_query fixture is CLEAN before its rows run
ok 2847 - 45.111 — the lab_multi_query fixture is CLEAN before its rows run
  ---
  duration_ms: 0.116
  type: 'test'
  ...
# Subtest: 45.112 — multi_query: missing on lab_multi_query → multi_query_absent
ok 2848 - 45.112 — multi_query: missing on lab_multi_query → multi_query_absent
  ---
  duration_ms: 0.101042
  type: 'test'
  ...
# Subtest: 45.113 — multi_query.variant_generation: null → variant_generation_absent
ok 2849 - 45.113 — multi_query.variant_generation: null → variant_generation_absent
  ---
  duration_ms: 0.085208
  type: 'test'
  ...
# Subtest: 45.114 — multi_query.variant_generation.status: invalid → variant_generation_status_absent_or_invalid
ok 2850 - 45.114 — multi_query.variant_generation.status: invalid → variant_generation_status_absent_or_invalid
  ---
  duration_ms: 0.089375
  type: 'test'
  ...
# Subtest: 45.115 — multi_query.variant_generation.served_route_class: missing (null is permitted for a stage that did not run) → variant_generation_served_route_class_field_absent
ok 2851 - 45.115 — multi_query.variant_generation.served_route_class: missing (null is permitted for a stage that did not run) → variant_generation_served_route_class_field_absent
  ---
  duration_ms: 0.082333
  type: 'test'
  ...
# Subtest: 45.116 — multi_query.variant_generation.generated_variant_count: null → generated_variant_count_absent
ok 2852 - 45.116 — multi_query.variant_generation.generated_variant_count: null → generated_variant_count_absent
  ---
  duration_ms: 0.084125
  type: 'test'
  ...
# Subtest: 45.117 — multi_query.variant_generation.attempts: a member with an outcome outside the six → attempt_outcome_absent_or_invalid
ok 2853 - 45.117 — multi_query.variant_generation.attempts: a member with an outcome outside the six → attempt_outcome_absent_or_invalid
  ---
  duration_ms: 0.086333
  type: 'test'
  ...
# Subtest: 45.118 — multi_query.variant_generation.prompt_tokens: missing (v26 §3.5, null is permitted) → variant_generation_prompt_tokens_field_absent
ok 2854 - 45.118 — multi_query.variant_generation.prompt_tokens: missing (v26 §3.5, null is permitted) → variant_generation_prompt_tokens_field_absent
  ---
  duration_ms: 0.082
  type: 'test'
  ...
# Subtest: 45.119 — multi_query.variant_generation.prompt_tokens: invalid: a numeric STRING (v26 §3.5) → variant_generation_prompt_tokens_invalid
ok 2855 - 45.119 — multi_query.variant_generation.prompt_tokens: invalid: a numeric STRING (v26 §3.5) → variant_generation_prompt_tokens_invalid
  ---
  duration_ms: 0.082125
  type: 'test'
  ...
# Subtest: 45.120 — multi_query.variant_generation.completion_tokens: missing (v26 §3.5, null is permitted) → variant_generation_completion_tokens_field_absent
ok 2856 - 45.120 — multi_query.variant_generation.completion_tokens: missing (v26 §3.5, null is permitted) → variant_generation_completion_tokens_field_absent
  ---
  duration_ms: 0.084959
  type: 'test'
  ...
# Subtest: 45.121 — multi_query.variant_generation.completion_tokens: invalid: negative (v26 §3.5) → variant_generation_completion_tokens_invalid
ok 2857 - 45.121 — multi_query.variant_generation.completion_tokens: invalid: negative (v26 §3.5) → variant_generation_completion_tokens_invalid
  ---
  duration_ms: 0.084167
  type: 'test'
  ...
# Subtest: 45.122 — multi_query.variant_generation.served_model: missing (null is permitted) → variant_generation_served_model_field_absent
ok 2858 - 45.122 — multi_query.variant_generation.served_model: missing (null is permitted) → variant_generation_served_model_field_absent
  ---
  duration_ms: 0.080208
  type: 'test'
  ...
# Subtest: 45.123 — multi_query.variants (member): a null member (v26 §3.2) → variant_member_invalid
ok 2859 - 45.123 — multi_query.variants (member): a null member (v26 §3.2) → variant_member_invalid
  ---
  duration_ms: 0.08125
  type: 'test'
  ...
# Subtest: 45.124 — multi_query.variants[].outcome: invalid → variant_outcome_absent_or_invalid
ok 2860 - 45.124 — multi_query.variants[].outcome: invalid → variant_outcome_absent_or_invalid
  ---
  duration_ms: 0.084542
  type: 'test'
  ...
# Subtest: 45.125 — multi_query.variants[].candidate_count: missing → variant_candidate_count_absent_or_invalid
ok 2861 - 45.125 — multi_query.variants[].candidate_count: missing → variant_candidate_count_absent_or_invalid
  ---
  duration_ms: 0.084291
  type: 'test'
  ...
# Subtest: 45.126 — multi_query.variants: null → variants_absent
ok 2862 - 45.126 — multi_query.variants: null → variants_absent
  ---
  duration_ms: 0.07675
  type: 'test'
  ...
# Subtest: 45.127 — multi_query.variants: length ≠ generated_variant_count + 1 → variant_arity_mismatch
ok 2863 - 45.127 — multi_query.variants: length ≠ generated_variant_count + 1 → variant_arity_mismatch
  ---
  duration_ms: 0.07875
  type: 'test'
  ...
# Subtest: 45.1 — OWN-PROPERTY CHECKS: missing, explicit null, empty array, empty string and invalid number are FIVE different answers, and the validator tells them apart
ok 2864 - 45.1 — OWN-PROPERTY CHECKS: missing, explicit null, empty array, empty string and invalid number are FIVE different answers, and the validator tells them apart
  ---
  duration_ms: 15.251542
  type: 'test'
  ...
# Subtest: 45.128 — the HMAC-absent licence covers EXACTLY the four D8 fields, and only when telemetry_error declares it
ok 2865 - 45.128 — the HMAC-absent licence covers EXACTLY the four D8 fields, and only when telemetry_error declares it
  ---
  duration_ms: 0.213584
  type: 'test'
  ...
# Subtest: 45.200 — matrix manifest_schema_version (D17): ABSENT → manifest_version_unrecognized
ok 2866 - 45.200 — matrix manifest_schema_version (D17): ABSENT → manifest_version_unrecognized
  ---
  duration_ms: 0.128958
  type: 'test'
  ...
# Subtest: 45.201 — matrix manifest_schema_version (D17): NULL → manifest_version_unrecognized
ok 2867 - 45.201 — matrix manifest_schema_version (D17): NULL → manifest_version_unrecognized
  ---
  duration_ms: 0.093958
  type: 'test'
  ...
# Subtest: 45.202 — matrix manifest_schema_version (D17): WRONG TYPE ("not-a-member-of-this-enum") → manifest_version_unrecognized
ok 2868 - 45.202 — matrix manifest_schema_version (D17): WRONG TYPE ("not-a-member-of-this-enum") → manifest_version_unrecognized
  ---
  duration_ms: 0.086208
  type: 'test'
  ...
# Subtest: 45.203 — matrix hmac_key_version (D8): ABSENT → hmac_key_version_field_absent
ok 2869 - 45.203 — matrix hmac_key_version (D8): ABSENT → hmac_key_version_field_absent
  ---
  duration_ms: 0.075417
  type: 'test'
  ...
# Subtest: 45.204 — matrix hmac_key_version (D8): NULL → hmac_key_version_absent
ok 2870 - 45.204 — matrix hmac_key_version (D8): NULL → hmac_key_version_absent
  ---
  duration_ms: 0.068958
  type: 'test'
  ...
# Subtest: 45.205 — matrix hmac_key_version (D8): WRONG TYPE (4242) → hmac_key_version_absent
ok 2871 - 45.205 — matrix hmac_key_version (D8): WRONG TYPE (4242) → hmac_key_version_absent
  ---
  duration_ms: 0.0725
  type: 'test'
  ...
# Subtest: 45.206 — matrix telemetry_error (D8): ABSENT → telemetry_error_field_absent
ok 2872 - 45.206 — matrix telemetry_error (D8): ABSENT → telemetry_error_field_absent
  ---
  duration_ms: 0.066958
  type: 'test'
  ...
# Subtest: 45.207 — matrix telemetry_error (D8): NULL → permitted here, no code
ok 2873 - 45.207 — matrix telemetry_error (D8): NULL → permitted here, no code
  ---
  duration_ms: 0.06725
  type: 'test'
  ...
# Subtest: 45.208 — matrix telemetry_error (D8): WRONG TYPE ("not-a-member-of-this-enum") → telemetry_error_invalid
ok 2874 - 45.208 — matrix telemetry_error (D8): WRONG TYPE ("not-a-member-of-this-enum") → telemetry_error_invalid
  ---
  duration_ms: 0.0685
  type: 'test'
  ...
# Subtest: 45.209 — matrix operational (D17): ABSENT → operational_absent
ok 2875 - 45.209 — matrix operational (D17): ABSENT → operational_absent
  ---
  duration_ms: 0.069208
  type: 'test'
  ...
# Subtest: 45.210 — matrix operational (D17): NULL → operational_absent
ok 2876 - 45.210 — matrix operational (D17): NULL → operational_absent
  ---
  duration_ms: 0.065542
  type: 'test'
  ...
# Subtest: 45.211 — matrix operational (D17): WRONG TYPE (["not","an","object"]) → operational_absent
ok 2877 - 45.211 — matrix operational (D17): WRONG TYPE (["not","an","object"]) → operational_absent
  ---
  duration_ms: 0.063791
  type: 'test'
  ...
# Subtest: 45.212 — matrix operational.route (D17): ABSENT → route_absent_or_invalid
ok 2878 - 45.212 — matrix operational.route (D17): ABSENT → route_absent_or_invalid
  ---
  duration_ms: 0.072916
  type: 'test'
  ...
# Subtest: 45.213 — matrix operational.route (D17): NULL → route_absent_or_invalid
ok 2879 - 45.213 — matrix operational.route (D17): NULL → route_absent_or_invalid
  ---
  duration_ms: 5.444375
  type: 'test'
  ...
# Subtest: 45.214 — matrix operational.route (D17): WRONG TYPE ("not-a-member-of-this-enum") → route_absent_or_invalid
ok 2880 - 45.214 — matrix operational.route (D17): WRONG TYPE ("not-a-member-of-this-enum") → route_absent_or_invalid
  ---
  duration_ms: 0.111708
  type: 'test'
  ...
# Subtest: 45.215 — matrix operational.route_class (D17): ABSENT → route_class_absent
ok 2881 - 45.215 — matrix operational.route_class (D17): ABSENT → route_class_absent
  ---
  duration_ms: 0.082792
  type: 'test'
  ...
# Subtest: 45.216 — matrix operational.route_class (D17): NULL → route_class_absent
ok 2882 - 45.216 — matrix operational.route_class (D17): NULL → route_class_absent
  ---
  duration_ms: 0.073333
  type: 'test'
  ...
# Subtest: 45.217 — matrix operational.route_class (D17): WRONG TYPE (4242) → route_class_absent
ok 2883 - 45.217 — matrix operational.route_class (D17): WRONG TYPE (4242) → route_class_absent
  ---
  duration_ms: 0.072625
  type: 'test'
  ...
# Subtest: 45.218 — matrix operational.retrieval_role (D17): ABSENT → retrieval_role_absent_or_invalid
ok 2884 - 45.218 — matrix operational.retrieval_role (D17): ABSENT → retrieval_role_absent_or_invalid
  ---
  duration_ms: 0.077167
  type: 'test'
  ...
# Subtest: 45.219 — matrix operational.retrieval_role (D17): NULL → retrieval_role_absent_or_invalid
ok 2885 - 45.219 — matrix operational.retrieval_role (D17): NULL → retrieval_role_absent_or_invalid
  ---
  duration_ms: 0.068042
  type: 'test'
  ...
# Subtest: 45.220 — matrix operational.retrieval_role (D17): WRONG TYPE ("not-a-member-of-this-enum") → retrieval_role_absent_or_invalid
ok 2886 - 45.220 — matrix operational.retrieval_role (D17): WRONG TYPE ("not-a-member-of-this-enum") → retrieval_role_absent_or_invalid
  ---
  duration_ms: 0.069334
  type: 'test'
  ...
# Subtest: 45.221 — matrix operational.invocation_id (D17): ABSENT → invocation_id_absent
ok 2887 - 45.221 — matrix operational.invocation_id (D17): ABSENT → invocation_id_absent
  ---
  duration_ms: 0.067833
  type: 'test'
  ...
# Subtest: 45.222 — matrix operational.invocation_id (D17): NULL → invocation_id_absent
ok 2888 - 45.222 — matrix operational.invocation_id (D17): NULL → invocation_id_absent
  ---
  duration_ms: 0.06475
  type: 'test'
  ...
# Subtest: 45.223 — matrix operational.invocation_id (D17): WRONG TYPE (4242) → invocation_id_absent
ok 2889 - 45.223 — matrix operational.invocation_id (D17): WRONG TYPE (4242) → invocation_id_absent
  ---
  duration_ms: 0.065625
  type: 'test'
  ...
# Subtest: 45.224 — matrix operational.started_at (D17): ABSENT → started_at_absent
ok 2890 - 45.224 — matrix operational.started_at (D17): ABSENT → started_at_absent
  ---
  duration_ms: 0.118042
  type: 'test'
  ...
# Subtest: 45.225 — matrix operational.started_at (D17): NULL → started_at_absent
ok 2891 - 45.225 — matrix operational.started_at (D17): NULL → started_at_absent
  ---
  duration_ms: 0.06875
  type: 'test'
  ...
# Subtest: 45.226 — matrix operational.started_at (D17): WRONG TYPE (4242) → started_at_absent
ok 2892 - 45.226 — matrix operational.started_at (D17): WRONG TYPE (4242) → started_at_absent
  ---
  duration_ms: 0.064666
  type: 'test'
  ...
# Subtest: 45.227 — matrix operational.completed_at (D17): ABSENT → completed_at_absent
ok 2893 - 45.227 — matrix operational.completed_at (D17): ABSENT → completed_at_absent
  ---
  duration_ms: 0.068792
  type: 'test'
  ...
# Subtest: 45.228 — matrix operational.completed_at (D17): NULL → completed_at_absent
ok 2894 - 45.228 — matrix operational.completed_at (D17): NULL → completed_at_absent
  ---
  duration_ms: 0.068375
  type: 'test'
  ...
# Subtest: 45.229 — matrix operational.completed_at (D17): WRONG TYPE (4242) → completed_at_absent
ok 2895 - 45.229 — matrix operational.completed_at (D17): WRONG TYPE (4242) → completed_at_absent
  ---
  duration_ms: 0.110208
  type: 'test'
  ...
# Subtest: 45.230 — matrix operational.trace_id (D17): ABSENT → trace_id_field_absent
ok 2896 - 45.230 — matrix operational.trace_id (D17): ABSENT → trace_id_field_absent
  ---
  duration_ms: 0.059166
  type: 'test'
  ...
# Subtest: 45.231 — matrix operational.trace_id (D17): NULL → permitted here, no code
ok 2897 - 45.231 — matrix operational.trace_id (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.0625
  type: 'test'
  ...
# Subtest: 45.232 — matrix operational.trace_id (D17): WRONG TYPE (4242) → trace_id_invalid
ok 2898 - 45.232 — matrix operational.trace_id (D17): WRONG TYPE (4242) → trace_id_invalid
  ---
  duration_ms: 0.058833
  type: 'test'
  ...
# Subtest: 45.233 — matrix operational.deployment_sha (D17): ABSENT → deployment_sha_field_absent
ok 2899 - 45.233 — matrix operational.deployment_sha (D17): ABSENT → deployment_sha_field_absent
  ---
  duration_ms: 0.056292
  type: 'test'
  ...
# Subtest: 45.234 — matrix operational.deployment_sha (D17): NULL → permitted here, no code
ok 2900 - 45.234 — matrix operational.deployment_sha (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.055208
  type: 'test'
  ...
# Subtest: 45.235 — matrix operational.deployment_sha (D17): WRONG TYPE (4242) → deployment_sha_invalid
ok 2901 - 45.235 — matrix operational.deployment_sha (D17): WRONG TYPE (4242) → deployment_sha_invalid
  ---
  duration_ms: 0.055959
  type: 'test'
  ...
# Subtest: 45.236 — matrix operational.routing_flags (D17): ABSENT → routing_flags_absent
ok 2902 - 45.236 — matrix operational.routing_flags (D17): ABSENT → routing_flags_absent
  ---
  duration_ms: 0.053833
  type: 'test'
  ...
# Subtest: 45.237 — matrix operational.routing_flags (D17): NULL → routing_flags_absent
ok 2903 - 45.237 — matrix operational.routing_flags (D17): NULL → routing_flags_absent
  ---
  duration_ms: 0.054208
  type: 'test'
  ...
# Subtest: 45.238 — matrix operational.routing_flags (D17): WRONG TYPE (["not","an","object"]) → routing_flags_absent
ok 2904 - 45.238 — matrix operational.routing_flags (D17): WRONG TYPE (["not","an","object"]) → routing_flags_absent
  ---
  duration_ms: 0.054041
  type: 'test'
  ...
# Subtest: 45.239 — matrix operational.active_backfill_run_id (D17): ABSENT → active_backfill_run_id_field_absent
ok 2905 - 45.239 — matrix operational.active_backfill_run_id (D17): ABSENT → active_backfill_run_id_field_absent
  ---
  duration_ms: 0.054792
  type: 'test'
  ...
# Subtest: 45.240 — matrix operational.active_backfill_run_id (D17): NULL → permitted here, no code
ok 2906 - 45.240 — matrix operational.active_backfill_run_id (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.054833
  type: 'test'
  ...
# Subtest: 45.241 — matrix operational.active_backfill_run_id (D17): WRONG TYPE (4242) → active_backfill_run_id_invalid
ok 2907 - 45.241 — matrix operational.active_backfill_run_id (D17): WRONG TYPE (4242) → active_backfill_run_id_invalid
  ---
  duration_ms: 0.054083
  type: 'test'
  ...
# Subtest: 45.242 — matrix operational.active_backfill_target (D17): ABSENT → active_backfill_target_field_absent
ok 2908 - 45.242 — matrix operational.active_backfill_target (D17): ABSENT → active_backfill_target_field_absent
  ---
  duration_ms: 0.080333
  type: 'test'
  ...
# Subtest: 45.243 — matrix operational.active_backfill_target (D17): NULL → permitted here, no code
ok 2909 - 45.243 — matrix operational.active_backfill_target (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.054917
  type: 'test'
  ...
# Subtest: 45.244 — matrix operational.active_backfill_target (D17): WRONG TYPE (4242) → active_backfill_target_invalid
ok 2910 - 45.244 — matrix operational.active_backfill_target (D17): WRONG TYPE (4242) → active_backfill_target_invalid
  ---
  duration_ms: 0.054084
  type: 'test'
  ...
# Subtest: 45.245 — matrix operational.active_backfill_state (D17): ABSENT → active_backfill_state_field_absent
ok 2911 - 45.245 — matrix operational.active_backfill_state (D17): ABSENT → active_backfill_state_field_absent
  ---
  duration_ms: 0.056083
  type: 'test'
  ...
# Subtest: 45.246 — matrix operational.active_backfill_state (D17): NULL → permitted here, no code
ok 2912 - 45.246 — matrix operational.active_backfill_state (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.056208
  type: 'test'
  ...
# Subtest: 45.247 — matrix operational.active_backfill_state (D17): WRONG TYPE ("not-a-member-of-this-enum") → active_backfill_state_invalid
ok 2913 - 45.247 — matrix operational.active_backfill_state (D17): WRONG TYPE ("not-a-member-of-this-enum") → active_backfill_state_invalid
  ---
  duration_ms: 0.054541
  type: 'test'
  ...
# Subtest: 45.248 — matrix operational.active_lab_experiment_id (D17): ABSENT → active_lab_experiment_id_field_absent
ok 2914 - 45.248 — matrix operational.active_lab_experiment_id (D17): ABSENT → active_lab_experiment_id_field_absent
  ---
  duration_ms: 0.056042
  type: 'test'
  ...
# Subtest: 45.249 — matrix operational.active_lab_experiment_id (D17): NULL → permitted here, no code
ok 2915 - 45.249 — matrix operational.active_lab_experiment_id (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.056334
  type: 'test'
  ...
# Subtest: 45.250 — matrix operational.active_lab_experiment_id (D17): WRONG TYPE (4242) → active_lab_experiment_id_invalid
ok 2916 - 45.250 — matrix operational.active_lab_experiment_id (D17): WRONG TYPE (4242) → active_lab_experiment_id_invalid
  ---
  duration_ms: 0.054666
  type: 'test'
  ...
# Subtest: 45.251 — matrix retrieval_outcome (D17): ABSENT → retrieval_outcome_absent_or_invalid
ok 2917 - 45.251 — matrix retrieval_outcome (D17): ABSENT → retrieval_outcome_absent_or_invalid
  ---
  duration_ms: 0.060084
  type: 'test'
  ...
# Subtest: 45.252 — matrix retrieval_outcome (D17): NULL → retrieval_outcome_absent_or_invalid
ok 2918 - 45.252 — matrix retrieval_outcome (D17): NULL → retrieval_outcome_absent_or_invalid
  ---
  duration_ms: 0.053166
  type: 'test'
  ...
# Subtest: 45.253 — matrix retrieval_outcome (D17): WRONG TYPE ("not-a-member-of-this-enum") → retrieval_outcome_absent_or_invalid
ok 2919 - 45.253 — matrix retrieval_outcome (D17): WRONG TYPE ("not-a-member-of-this-enum") → retrieval_outcome_absent_or_invalid
  ---
  duration_ms: 2.807333
  type: 'test'
  ...
# Subtest: 45.254 — matrix retrieval_error_class (D17): ABSENT → retrieval_error_class_field_absent
ok 2920 - 45.254 — matrix retrieval_error_class (D17): ABSENT → retrieval_error_class_field_absent
  ---
  duration_ms: 0.07875
  type: 'test'
  ...
# Subtest: 45.255 — matrix retrieval_error_class (D17): NULL → permitted here, no code
ok 2921 - 45.255 — matrix retrieval_error_class (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.062292
  type: 'test'
  ...
# Subtest: 45.256 — matrix retrieval_error_class (D17): WRONG TYPE (4242) → retrieval_error_class_invalid
ok 2922 - 45.256 — matrix retrieval_error_class (D17): WRONG TYPE (4242) → retrieval_error_class_invalid
  ---
  duration_ms: 0.056125
  type: 'test'
  ...
# Subtest: 45.257 — matrix expansion (D17): ABSENT → expansion_absent
ok 2923 - 45.257 — matrix expansion (D17): ABSENT → expansion_absent
  ---
  duration_ms: 0.052917
  type: 'test'
  ...
# Subtest: 45.258 — matrix expansion (D17): NULL → expansion_absent
ok 2924 - 45.258 — matrix expansion (D17): NULL → expansion_absent
  ---
  duration_ms: 0.052834
  type: 'test'
  ...
# Subtest: 45.259 — matrix expansion (D17): WRONG TYPE (["not","an","object"]) → expansion_absent
ok 2925 - 45.259 — matrix expansion (D17): WRONG TYPE (["not","an","object"]) → expansion_absent
  ---
  duration_ms: 0.050125
  type: 'test'
  ...
# Subtest: 45.260 — matrix expansion.status (D17): ABSENT → expansion_status_absent_or_invalid
ok 2926 - 45.260 — matrix expansion.status (D17): ABSENT → expansion_status_absent_or_invalid
  ---
  duration_ms: 0.055042
  type: 'test'
  ...
# Subtest: 45.261 — matrix expansion.status (D17): NULL → expansion_status_absent_or_invalid
ok 2927 - 45.261 — matrix expansion.status (D17): NULL → expansion_status_absent_or_invalid
  ---
  duration_ms: 0.050083
  type: 'test'
  ...
# Subtest: 45.262 — matrix expansion.status (D17): WRONG TYPE ("not-a-member-of-this-enum") → expansion_status_absent_or_invalid
ok 2928 - 45.262 — matrix expansion.status (D17): WRONG TYPE ("not-a-member-of-this-enum") → expansion_status_absent_or_invalid
  ---
  duration_ms: 0.050167
  type: 'test'
  ...
# Subtest: 45.263 — matrix expansion.input_hmac (D8): ABSENT → expansion_input_hmac_field_absent
ok 2929 - 45.263 — matrix expansion.input_hmac (D8): ABSENT → expansion_input_hmac_field_absent
  ---
  duration_ms: 0.050292
  type: 'test'
  ...
# Subtest: 45.264 — matrix expansion.input_hmac (D8): NULL → expansion_input_hmac_absent
ok 2930 - 45.264 — matrix expansion.input_hmac (D8): NULL → expansion_input_hmac_absent
  ---
  duration_ms: 0.731625
  type: 'test'
  ...
# Subtest: 45.265 — matrix expansion.input_hmac (D8): WRONG TYPE (4242) → expansion_input_hmac_invalid
ok 2931 - 45.265 — matrix expansion.input_hmac (D8): WRONG TYPE (4242) → expansion_input_hmac_invalid
  ---
  duration_ms: 0.477667
  type: 'test'
  ...
# Subtest: 45.266 — matrix expansion.served_route_class (D16): ABSENT → expansion_served_route_class_field_absent
ok 2932 - 45.266 — matrix expansion.served_route_class (D16): ABSENT → expansion_served_route_class_field_absent
  ---
  duration_ms: 0.055792
  type: 'test'
  ...
# Subtest: 45.267 — matrix expansion.served_route_class (D16): NULL → expansion_served_route_class_absent
ok 2933 - 45.267 — matrix expansion.served_route_class (D16): NULL → expansion_served_route_class_absent
  ---
  duration_ms: 0.052708
  type: 'test'
  ...
# Subtest: 45.268 — matrix expansion.served_route_class (D16): WRONG TYPE ("not-a-member-of-this-enum") → expansion_served_route_class_invalid
ok 2934 - 45.268 — matrix expansion.served_route_class (D16): WRONG TYPE ("not-a-member-of-this-enum") → expansion_served_route_class_invalid
  ---
  duration_ms: 0.054791
  type: 'test'
  ...
# Subtest: 45.269 — matrix expansion.served_model (D17): ABSENT → expansion_served_model_field_absent
ok 2935 - 45.269 — matrix expansion.served_model (D17): ABSENT → expansion_served_model_field_absent
  ---
  duration_ms: 0.05375
  type: 'test'
  ...
# Subtest: 45.270 — matrix expansion.served_model (D17): NULL → permitted here, no code
ok 2936 - 45.270 — matrix expansion.served_model (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.053875
  type: 'test'
  ...
# Subtest: 45.271 — matrix expansion.served_model (D17): WRONG TYPE (4242) → expansion_served_model_invalid
ok 2937 - 45.271 — matrix expansion.served_model (D17): WRONG TYPE (4242) → expansion_served_model_invalid
  ---
  duration_ms: 0.055375
  type: 'test'
  ...
# Subtest: 45.272 — matrix expansion.attempts (D17): ABSENT → expansion_attempts_field_absent
ok 2938 - 45.272 — matrix expansion.attempts (D17): ABSENT → expansion_attempts_field_absent
  ---
  duration_ms: 0.052792
  type: 'test'
  ...
# Subtest: 45.273 — matrix expansion.attempts (D17): NULL → permitted here, no code
ok 2939 - 45.273 — matrix expansion.attempts (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.321917
  type: 'test'
  ...
# Subtest: 45.274 — matrix expansion.attempts (D17): WRONG TYPE ("not-an-attempt-list") → attempt_outcome_absent_or_invalid
ok 2940 - 45.274 — matrix expansion.attempts (D17): WRONG TYPE ("not-an-attempt-list") → attempt_outcome_absent_or_invalid
  ---
  duration_ms: 0.085417
  type: 'test'
  ...
# Subtest: 45.275 — matrix fused_candidate_ids (D17): ABSENT → fused_candidate_ids_absent
ok 2941 - 45.275 — matrix fused_candidate_ids (D17): ABSENT → fused_candidate_ids_absent
  ---
  duration_ms: 0.064625
  type: 'test'
  ...
# Subtest: 45.276 — matrix fused_candidate_ids (D17): NULL → fused_candidate_ids_absent
ok 2942 - 45.276 — matrix fused_candidate_ids (D17): NULL → fused_candidate_ids_absent
  ---
  duration_ms: 0.057
  type: 'test'
  ...
# Subtest: 45.277 — matrix fused_candidate_ids (D17): WRONG TYPE ("not-an-array") → fused_candidate_ids_absent
ok 2943 - 45.277 — matrix fused_candidate_ids (D17): WRONG TYPE ("not-an-array") → fused_candidate_ids_absent
  ---
  duration_ms: 0.055958
  type: 'test'
  ...
# Subtest: 45.278 — matrix hydrated_candidate_ids (D17): ABSENT → hydrated_candidate_ids_absent
ok 2944 - 45.278 — matrix hydrated_candidate_ids (D17): ABSENT → hydrated_candidate_ids_absent
  ---
  duration_ms: 0.0565
  type: 'test'
  ...
# Subtest: 45.279 — matrix hydrated_candidate_ids (D17): NULL → hydrated_candidate_ids_absent
ok 2945 - 45.279 — matrix hydrated_candidate_ids (D17): NULL → hydrated_candidate_ids_absent
  ---
  duration_ms: 0.053084
  type: 'test'
  ...
# Subtest: 45.280 — matrix hydrated_candidate_ids (D17): WRONG TYPE ("not-an-array") → hydrated_candidate_ids_absent
ok 2946 - 45.280 — matrix hydrated_candidate_ids (D17): WRONG TYPE ("not-an-array") → hydrated_candidate_ids_absent
  ---
  duration_ms: 0.0605
  type: 'test'
  ...
# Subtest: 45.281 — matrix fused_candidate_count (D17): ABSENT → fused_candidate_count_absent
ok 2947 - 45.281 — matrix fused_candidate_count (D17): ABSENT → fused_candidate_count_absent
  ---
  duration_ms: 0.054375
  type: 'test'
  ...
# Subtest: 45.282 — matrix fused_candidate_count (D17): NULL → fused_candidate_count_absent
ok 2948 - 45.282 — matrix fused_candidate_count (D17): NULL → fused_candidate_count_absent
  ---
  duration_ms: 0.054958
  type: 'test'
  ...
# Subtest: 45.283 — matrix fused_candidate_count (D17): WRONG TYPE ("not-a-number") → fused_candidate_count_absent
ok 2949 - 45.283 — matrix fused_candidate_count (D17): WRONG TYPE ("not-a-number") → fused_candidate_count_absent
  ---
  duration_ms: 0.053667
  type: 'test'
  ...
# Subtest: 45.284 — matrix hydrated_candidate_count (D17): ABSENT → hydrated_candidate_count_absent
ok 2950 - 45.284 — matrix hydrated_candidate_count (D17): ABSENT → hydrated_candidate_count_absent
  ---
  duration_ms: 0.051375
  type: 'test'
  ...
# Subtest: 45.285 — matrix hydrated_candidate_count (D17): NULL → hydrated_candidate_count_absent
ok 2951 - 45.285 — matrix hydrated_candidate_count (D17): NULL → hydrated_candidate_count_absent
  ---
  duration_ms: 0.048459
  type: 'test'
  ...
# Subtest: 45.286 — matrix hydrated_candidate_count (D17): WRONG TYPE ("not-a-number") → hydrated_candidate_count_absent
ok 2952 - 45.286 — matrix hydrated_candidate_count (D17): WRONG TYPE ("not-a-number") → hydrated_candidate_count_absent
  ---
  duration_ms: 0.048416
  type: 'test'
  ...
# Subtest: 45.287 — matrix pre_rerank_passage_hmacs (D8): ABSENT → pre_rerank_passage_hmacs_field_absent
ok 2953 - 45.287 — matrix pre_rerank_passage_hmacs (D8): ABSENT → pre_rerank_passage_hmacs_field_absent
  ---
  duration_ms: 0.049417
  type: 'test'
  ...
# Subtest: 45.288 — matrix pre_rerank_passage_hmacs (D8): NULL → pre_rerank_passage_hmacs_absent
ok 2954 - 45.288 — matrix pre_rerank_passage_hmacs (D8): NULL → pre_rerank_passage_hmacs_absent
  ---
  duration_ms: 0.048084
  type: 'test'
  ...
# Subtest: 45.289 — matrix pre_rerank_passage_hmacs (D8): WRONG TYPE ("not-an-array") → pre_rerank_passage_hmacs_absent
ok 2955 - 45.289 — matrix pre_rerank_passage_hmacs (D8): WRONG TYPE ("not-an-array") → pre_rerank_passage_hmacs_absent
  ---
  duration_ms: 0.047458
  type: 'test'
  ...
# Subtest: 45.290 — matrix intended_backend (D17): ABSENT → intended_backend_absent
ok 2956 - 45.290 — matrix intended_backend (D17): ABSENT → intended_backend_absent
  ---
  duration_ms: 0.047417
  type: 'test'
  ...
# Subtest: 45.291 — matrix intended_backend (D17): NULL → intended_backend_absent
ok 2957 - 45.291 — matrix intended_backend (D17): NULL → intended_backend_absent
  ---
  duration_ms: 0.047875
  type: 'test'
  ...
# Subtest: 45.292 — matrix intended_backend (D17): WRONG TYPE (4242) → intended_backend_absent
ok 2958 - 45.292 — matrix intended_backend (D17): WRONG TYPE (4242) → intended_backend_absent
  ---
  duration_ms: 0.057917
  type: 'test'
  ...
# Subtest: 45.293 — matrix intended_model (D17): ABSENT → intended_model_absent
ok 2959 - 45.293 — matrix intended_model (D17): ABSENT → intended_model_absent
  ---
  duration_ms: 0.052375
  type: 'test'
  ...
# Subtest: 45.294 — matrix intended_model (D17): NULL → intended_model_absent
ok 2960 - 45.294 — matrix intended_model (D17): NULL → intended_model_absent
  ---
  duration_ms: 0.052208
  type: 'test'
  ...
# Subtest: 45.295 — matrix intended_model (D17): WRONG TYPE (4242) → intended_model_absent
ok 2961 - 45.295 — matrix intended_model (D17): WRONG TYPE (4242) → intended_model_absent
  ---
  duration_ms: 0.051875
  type: 'test'
  ...
# Subtest: 45.296 — matrix served_backend (D17): ABSENT → served_backend_field_absent
ok 2962 - 45.296 — matrix served_backend (D17): ABSENT → served_backend_field_absent
  ---
  duration_ms: 0.052208
  type: 'test'
  ...
# Subtest: 45.297 — matrix served_backend (D17): NULL → served_backend_absent_with_batches
ok 2963 - 45.297 — matrix served_backend (D17): NULL → served_backend_absent_with_batches
  ---
  duration_ms: 0.052666
  type: 'test'
  ...
# Subtest: 45.298 — matrix served_backend (D17): WRONG TYPE (4242) → served_backend_invalid
ok 2964 - 45.298 — matrix served_backend (D17): WRONG TYPE (4242) → served_backend_invalid
  ---
  duration_ms: 0.051625
  type: 'test'
  ...
# Subtest: 45.299 — matrix rerank_backend_downgraded (D17): ABSENT → rerank_backend_downgraded_absent
ok 2965 - 45.299 — matrix rerank_backend_downgraded (D17): ABSENT → rerank_backend_downgraded_absent
  ---
  duration_ms: 0.052
  type: 'test'
  ...
# Subtest: 45.300 — matrix rerank_backend_downgraded (D17): NULL → rerank_backend_downgraded_absent
ok 2966 - 45.300 — matrix rerank_backend_downgraded (D17): NULL → rerank_backend_downgraded_absent
  ---
  duration_ms: 0.052208
  type: 'test'
  ...
# Subtest: 45.301 — matrix rerank_backend_downgraded (D17): WRONG TYPE ("false") → rerank_backend_downgraded_absent
ok 2967 - 45.301 — matrix rerank_backend_downgraded (D17): WRONG TYPE ("false") → rerank_backend_downgraded_absent
  ---
  duration_ms: 0.051291
  type: 'test'
  ...
# Subtest: 45.302 — matrix expected_batch_count (D17): ABSENT → expected_batch_count_absent
ok 2968 - 45.302 — matrix expected_batch_count (D17): ABSENT → expected_batch_count_absent
  ---
  duration_ms: 0.0525
  type: 'test'
  ...
# Subtest: 45.303 — matrix expected_batch_count (D17): NULL → expected_batch_count_absent
ok 2969 - 45.303 — matrix expected_batch_count (D17): NULL → expected_batch_count_absent
  ---
  duration_ms: 0.05175
  type: 'test'
  ...
# Subtest: 45.304 — matrix expected_batch_count (D17): WRONG TYPE ("not-a-number") → expected_batch_count_absent
ok 2970 - 45.304 — matrix expected_batch_count (D17): WRONG TYPE ("not-a-number") → expected_batch_count_absent
  ---
  duration_ms: 0.051875
  type: 'test'
  ...
# Subtest: 45.305 — matrix recorded_rerank_batches (D17): ABSENT → recorded_rerank_batches_absent
ok 2971 - 45.305 — matrix recorded_rerank_batches (D17): ABSENT → recorded_rerank_batches_absent
  ---
  duration_ms: 0.052208
  type: 'test'
  ...
# Subtest: 45.306 — matrix recorded_rerank_batches (D17): NULL → recorded_rerank_batches_absent
ok 2972 - 45.306 — matrix recorded_rerank_batches (D17): NULL → recorded_rerank_batches_absent
  ---
  duration_ms: 0.052459
  type: 'test'
  ...
# Subtest: 45.307 — matrix recorded_rerank_batches (D17): WRONG TYPE ("not-a-number") → recorded_rerank_batches_absent
ok 2973 - 45.307 — matrix recorded_rerank_batches (D17): WRONG TYPE ("not-a-number") → recorded_rerank_batches_absent
  ---
  duration_ms: 0.053583
  type: 'test'
  ...
# Subtest: 45.308 — matrix rerank_soft_failed (D17): ABSENT → rerank_soft_failed_absent
ok 2974 - 45.308 — matrix rerank_soft_failed (D17): ABSENT → rerank_soft_failed_absent
  ---
  duration_ms: 0.080875
  type: 'test'
  ...
# Subtest: 45.309 — matrix rerank_soft_failed (D17): NULL → rerank_soft_failed_absent
ok 2975 - 45.309 — matrix rerank_soft_failed (D17): NULL → rerank_soft_failed_absent
  ---
  duration_ms: 0.051625
  type: 'test'
  ...
# Subtest: 45.310 — matrix rerank_soft_failed (D17): WRONG TYPE ("false") → rerank_soft_failed_absent
ok 2976 - 45.310 — matrix rerank_soft_failed (D17): WRONG TYPE ("false") → rerank_soft_failed_absent
  ---
  duration_ms: 0.053584
  type: 'test'
  ...
# Subtest: 45.311 — matrix ordered_final_candidate_ids (D17): ABSENT → ordered_final_candidate_ids_absent
ok 2977 - 45.311 — matrix ordered_final_candidate_ids (D17): ABSENT → ordered_final_candidate_ids_absent
  ---
  duration_ms: 0.052417
  type: 'test'
  ...
# Subtest: 45.312 — matrix ordered_final_candidate_ids (D17): NULL → ordered_final_candidate_ids_absent
ok 2978 - 45.312 — matrix ordered_final_candidate_ids (D17): NULL → ordered_final_candidate_ids_absent
  ---
  duration_ms: 0.051417
  type: 'test'
  ...
# Subtest: 45.313 — matrix ordered_final_candidate_ids (D17): WRONG TYPE ("not-an-array") → ordered_final_candidate_ids_absent
ok 2979 - 45.313 — matrix ordered_final_candidate_ids (D17): WRONG TYPE ("not-an-array") → ordered_final_candidate_ids_absent
  ---
  duration_ms: 0.051167
  type: 'test'
  ...
# Subtest: 45.314 — matrix scorer_context_hmac (v25 §3.3): ABSENT → scorer_context_hmac_field_absent
ok 2980 - 45.314 — matrix scorer_context_hmac (v25 §3.3): ABSENT → scorer_context_hmac_field_absent
  ---
  duration_ms: 0.571208
  type: 'test'
  ...
# Subtest: 45.315 — matrix scorer_context_hmac (v25 §3.3): NULL → scorer_context_hmac_absent
ok 2981 - 45.315 — matrix scorer_context_hmac (v25 §3.3): NULL → scorer_context_hmac_absent
  ---
  duration_ms: 1.3905
  type: 'test'
  ...
# Subtest: 45.316 — matrix scorer_context_hmac (v25 §3.3): WRONG TYPE (4242) → scorer_context_hmac_invalid
ok 2982 - 45.316 — matrix scorer_context_hmac (v25 §3.3): WRONG TYPE (4242) → scorer_context_hmac_invalid
  ---
  duration_ms: 0.437334
  type: 'test'
  ...
# Subtest: 45.317 — matrix retrieval_config (D17): ABSENT → retrieval_config_absent
ok 2983 - 45.317 — matrix retrieval_config (D17): ABSENT → retrieval_config_absent
  ---
  duration_ms: 33.334333
  type: 'test'
  ...
# Subtest: 45.318 — matrix retrieval_config (D17): NULL → retrieval_config_absent
ok 2984 - 45.318 — matrix retrieval_config (D17): NULL → retrieval_config_absent
  ---
  duration_ms: 1.443167
  type: 'test'
  ...
# Subtest: 45.319 — matrix retrieval_config (D17): WRONG TYPE (["not","an","object"]) → retrieval_config_absent
ok 2985 - 45.319 — matrix retrieval_config (D17): WRONG TYPE (["not","an","object"]) → retrieval_config_absent
  ---
  duration_ms: 0.224042
  type: 'test'
  ...
# Subtest: 45.320 — matrix retrieval_config.rerank_temperature (v7 §10): ABSENT → rerank_temperature_field_absent
ok 2986 - 45.320 — matrix retrieval_config.rerank_temperature (v7 §10): ABSENT → rerank_temperature_field_absent
  ---
  duration_ms: 7.335917
  type: 'test'
  ...
# Subtest: 45.321 — matrix retrieval_config.rerank_temperature (v7 §10): NULL → permitted here, no code
ok 2987 - 45.321 — matrix retrieval_config.rerank_temperature (v7 §10): NULL → permitted here, no code
  ---
  duration_ms: 0.319584
  type: 'test'
  ...
# Subtest: 45.322 — matrix retrieval_config.rerank_temperature (v7 §10): WRONG TYPE ("not-a-number") → rerank_temperature_invalid
ok 2988 - 45.322 — matrix retrieval_config.rerank_temperature (v7 §10): WRONG TYPE ("not-a-number") → rerank_temperature_invalid
  ---
  duration_ms: 0.105583
  type: 'test'
  ...
# Subtest: 45.323 — matrix retrieval_config.rerank_seed_status (v7 §10): ABSENT → rerank_seed_status_field_absent
ok 2989 - 45.323 — matrix retrieval_config.rerank_seed_status (v7 §10): ABSENT → rerank_seed_status_field_absent
  ---
  duration_ms: 0.095
  type: 'test'
  ...
# Subtest: 45.324 — matrix retrieval_config.rerank_seed_status (v7 §10): NULL → rerank_seed_status_invalid
ok 2990 - 45.324 — matrix retrieval_config.rerank_seed_status (v7 §10): NULL → rerank_seed_status_invalid
  ---
  duration_ms: 0.06225
  type: 'test'
  ...
# Subtest: 45.325 — matrix retrieval_config.rerank_seed_status (v7 §10): WRONG TYPE ("not-a-member-of-this-enum") → rerank_seed_status_invalid
ok 2991 - 45.325 — matrix retrieval_config.rerank_seed_status (v7 §10): WRONG TYPE ("not-a-member-of-this-enum") → rerank_seed_status_invalid
  ---
  duration_ms: 0.060875
  type: 'test'
  ...
# Subtest: 45.326 — matrix corpus_version (D17): ABSENT → corpus_version_field_absent
ok 2992 - 45.326 — matrix corpus_version (D17): ABSENT → corpus_version_field_absent
  ---
  duration_ms: 0.061209
  type: 'test'
  ...
# Subtest: 45.327 — matrix corpus_version (D17): NULL → permitted here, no code
ok 2993 - 45.327 — matrix corpus_version (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.058584
  type: 'test'
  ...
# Subtest: 45.328 — matrix corpus_version (D17): WRONG TYPE (4242) → corpus_version_invalid
ok 2994 - 45.328 — matrix corpus_version (D17): WRONG TYPE (4242) → corpus_version_invalid
  ---
  duration_ms: 0.056333
  type: 'test'
  ...
# Subtest: 45.329 — matrix index_version (D17): ABSENT → index_version_absent
ok 2995 - 45.329 — matrix index_version (D17): ABSENT → index_version_absent
  ---
  duration_ms: 0.059291
  type: 'test'
  ...
# Subtest: 45.330 — matrix index_version (D17): NULL → index_version_absent
ok 2996 - 45.330 — matrix index_version (D17): NULL → index_version_absent
  ---
  duration_ms: 0.054417
  type: 'test'
  ...
# Subtest: 45.331 — matrix index_version (D17): WRONG TYPE (4242) → index_version_absent
ok 2997 - 45.331 — matrix index_version (D17): WRONG TYPE (4242) → index_version_absent
  ---
  duration_ms: 2.517417
  type: 'test'
  ...
# Subtest: 45.332 — matrix batches (D17): ABSENT → batches_absent
ok 2998 - 45.332 — matrix batches (D17): ABSENT → batches_absent
  ---
  duration_ms: 0.138208
  type: 'test'
  ...
# Subtest: 45.333 — matrix batches (D17): NULL → batches_absent
ok 2999 - 45.333 — matrix batches (D17): NULL → batches_absent
  ---
  duration_ms: 0.069375
  type: 'test'
  ...
# Subtest: 45.334 — matrix batches (D17): WRONG TYPE ("not-an-array") → batches_absent
ok 3000 - 45.334 — matrix batches (D17): WRONG TYPE ("not-an-array") → batches_absent
  ---
  duration_ms: 0.059125
  type: 'test'
  ...
# Subtest: 45.335 — matrix batches[] (v26 §3.1): a null member → batch_member_invalid, without throwing
ok 3001 - 45.335 — matrix batches[] (v26 §3.1): a null member → batch_member_invalid, without throwing
  ---
  duration_ms: 0.147667
  type: 'test'
  ...
# Subtest: 45.336 — matrix batches[] (v26 §3.1): a numeric member → batch_member_invalid
ok 3002 - 45.336 — matrix batches[] (v26 §3.1): a numeric member → batch_member_invalid
  ---
  duration_ms: 0.067375
  type: 'test'
  ...
# Subtest: 45.337 — matrix batches[] (v26 §3.1): an array member → batch_member_invalid
ok 3003 - 45.337 — matrix batches[] (v26 §3.1): an array member → batch_member_invalid
  ---
  duration_ms: 0.06275
  type: 'test'
  ...
# Subtest: 45.338 — matrix batches[].batch_index (D17): ABSENT → batch_index_absent
ok 3004 - 45.338 — matrix batches[].batch_index (D17): ABSENT → batch_index_absent
  ---
  duration_ms: 0.063083
  type: 'test'
  ...
# Subtest: 45.339 — matrix batches[].batch_index (D17): NULL → batch_index_absent
ok 3005 - 45.339 — matrix batches[].batch_index (D17): NULL → batch_index_absent
  ---
  duration_ms: 0.056708
  type: 'test'
  ...
# Subtest: 45.340 — matrix batches[].batch_index (D17): WRONG TYPE ("not-a-number") → batch_index_absent
ok 3006 - 45.340 — matrix batches[].batch_index (D17): WRONG TYPE ("not-a-number") → batch_index_absent
  ---
  duration_ms: 0.05375
  type: 'test'
  ...
# Subtest: 45.341 — matrix batches[].candidate_start (D17): ABSENT → batch_boundaries_absent
ok 3007 - 45.341 — matrix batches[].candidate_start (D17): ABSENT → batch_boundaries_absent
  ---
  duration_ms: 0.054334
  type: 'test'
  ...
# Subtest: 45.342 — matrix batches[].candidate_start (D17): NULL → batch_boundaries_absent
ok 3008 - 45.342 — matrix batches[].candidate_start (D17): NULL → batch_boundaries_absent
  ---
  duration_ms: 0.050625
  type: 'test'
  ...
# Subtest: 45.343 — matrix batches[].candidate_start (D17): WRONG TYPE ("not-a-number") → batch_boundaries_absent
ok 3009 - 45.343 — matrix batches[].candidate_start (D17): WRONG TYPE ("not-a-number") → batch_boundaries_absent
  ---
  duration_ms: 0.0515
  type: 'test'
  ...
# Subtest: 45.344 — matrix batches[].candidate_end (D17): ABSENT → batch_boundaries_absent
ok 3010 - 45.344 — matrix batches[].candidate_end (D17): ABSENT → batch_boundaries_absent
  ---
  duration_ms: 0.05225
  type: 'test'
  ...
# Subtest: 45.345 — matrix batches[].candidate_end (D17): NULL → batch_boundaries_absent
ok 3011 - 45.345 — matrix batches[].candidate_end (D17): NULL → batch_boundaries_absent
  ---
  duration_ms: 0.050917
  type: 'test'
  ...
# Subtest: 45.346 — matrix batches[].candidate_end (D17): WRONG TYPE ("not-a-number") → batch_boundaries_absent
ok 3012 - 45.346 — matrix batches[].candidate_end (D17): WRONG TYPE ("not-a-number") → batch_boundaries_absent
  ---
  duration_ms: 0.053041
  type: 'test'
  ...
# Subtest: 45.347 — matrix batches[].intended_provider (D17): ABSENT → batch_intended_provider_absent
ok 3013 - 45.347 — matrix batches[].intended_provider (D17): ABSENT → batch_intended_provider_absent
  ---
  duration_ms: 0.050875
  type: 'test'
  ...
# Subtest: 45.348 — matrix batches[].intended_provider (D17): NULL → batch_intended_provider_absent
ok 3014 - 45.348 — matrix batches[].intended_provider (D17): NULL → batch_intended_provider_absent
  ---
  duration_ms: 0.050417
  type: 'test'
  ...
# Subtest: 45.349 — matrix batches[].intended_provider (D17): WRONG TYPE (4242) → batch_intended_provider_absent
ok 3015 - 45.349 — matrix batches[].intended_provider (D17): WRONG TYPE (4242) → batch_intended_provider_absent
  ---
  duration_ms: 0.05475
  type: 'test'
  ...
# Subtest: 45.350 — matrix batches[].intended_model (D17): ABSENT → batch_intended_model_absent
ok 3016 - 45.350 — matrix batches[].intended_model (D17): ABSENT → batch_intended_model_absent
  ---
  duration_ms: 0.05
  type: 'test'
  ...
# Subtest: 45.351 — matrix batches[].intended_model (D17): NULL → batch_intended_model_absent
ok 3017 - 45.351 — matrix batches[].intended_model (D17): NULL → batch_intended_model_absent
  ---
  duration_ms: 0.067375
  type: 'test'
  ...
# Subtest: 45.352 — matrix batches[].intended_model (D17): WRONG TYPE (4242) → batch_intended_model_absent
ok 3018 - 45.352 — matrix batches[].intended_model (D17): WRONG TYPE (4242) → batch_intended_model_absent
  ---
  duration_ms: 0.051291
  type: 'test'
  ...
# Subtest: 45.353 — matrix batches[].served_route_class (D17): ABSENT → batch_served_route_class_absent
ok 3019 - 45.353 — matrix batches[].served_route_class (D17): ABSENT → batch_served_route_class_absent
  ---
  duration_ms: 0.051
  type: 'test'
  ...
# Subtest: 45.354 — matrix batches[].served_route_class (D17): NULL → batch_served_route_class_absent
ok 3020 - 45.354 — matrix batches[].served_route_class (D17): NULL → batch_served_route_class_absent
  ---
  duration_ms: 0.0655
  type: 'test'
  ...
# Subtest: 45.355 — matrix batches[].served_route_class (D17): WRONG TYPE ("not-a-member-of-this-enum") → batch_served_route_class_invalid
ok 3021 - 45.355 — matrix batches[].served_route_class (D17): WRONG TYPE ("not-a-member-of-this-enum") → batch_served_route_class_invalid
  ---
  duration_ms: 0.050792
  type: 'test'
  ...
# Subtest: 45.356 — matrix batches[].served_model (D17): ABSENT → batch_served_model_field_absent
ok 3022 - 45.356 — matrix batches[].served_model (D17): ABSENT → batch_served_model_field_absent
  ---
  duration_ms: 0.0505
  type: 'test'
  ...
# Subtest: 45.357 — matrix batches[].served_model (D17): NULL → permitted here, no code
ok 3023 - 45.357 — matrix batches[].served_model (D17): NULL → permitted here, no code
  ---
  duration_ms: 5.09025
  type: 'test'
  ...
# Subtest: 45.358 — matrix batches[].served_model (D17): WRONG TYPE (4242) → batch_served_model_invalid
ok 3024 - 45.358 — matrix batches[].served_model (D17): WRONG TYPE (4242) → batch_served_model_invalid
  ---
  duration_ms: 0.11375
  type: 'test'
  ...
# Subtest: 45.359 — matrix batches[].attempts (D17): ABSENT → batch_attempts_field_absent
ok 3025 - 45.359 — matrix batches[].attempts (D17): ABSENT → batch_attempts_field_absent
  ---
  duration_ms: 0.068583
  type: 'test'
  ...
# Subtest: 45.360 — matrix batches[].attempts (D17): NULL → permitted here, no code
ok 3026 - 45.360 — matrix batches[].attempts (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.05875
  type: 'test'
  ...
# Subtest: 45.361 — matrix batches[].attempts (D17): WRONG TYPE ("not-an-attempt-list") → attempt_outcome_absent_or_invalid
ok 3027 - 45.361 — matrix batches[].attempts (D17): WRONG TYPE ("not-an-attempt-list") → attempt_outcome_absent_or_invalid
  ---
  duration_ms: 0.057708
  type: 'test'
  ...
# Subtest: 45.362 — matrix batches[].outcome (D17): ABSENT → batch_outcome_absent_or_invalid
ok 3028 - 45.362 — matrix batches[].outcome (D17): ABSENT → batch_outcome_absent_or_invalid
  ---
  duration_ms: 0.0535
  type: 'test'
  ...
# Subtest: 45.363 — matrix batches[].outcome (D17): NULL → batch_outcome_absent_or_invalid
ok 3029 - 45.363 — matrix batches[].outcome (D17): NULL → batch_outcome_absent_or_invalid
  ---
  duration_ms: 0.052709
  type: 'test'
  ...
# Subtest: 45.364 — matrix batches[].outcome (D17): WRONG TYPE ("not-a-member-of-this-enum") → batch_outcome_absent_or_invalid
ok 3030 - 45.364 — matrix batches[].outcome (D17): WRONG TYPE ("not-a-member-of-this-enum") → batch_outcome_absent_or_invalid
  ---
  duration_ms: 0.0535
  type: 'test'
  ...
# Subtest: 45.365 — matrix batches[].expected_score_keys (D17): ABSENT → expected_score_keys_absent
ok 3031 - 45.365 — matrix batches[].expected_score_keys (D17): ABSENT → expected_score_keys_absent
  ---
  duration_ms: 0.053667
  type: 'test'
  ...
# Subtest: 45.366 — matrix batches[].expected_score_keys (D17): NULL → expected_score_keys_absent
ok 3032 - 45.366 — matrix batches[].expected_score_keys (D17): NULL → expected_score_keys_absent
  ---
  duration_ms: 0.051542
  type: 'test'
  ...
# Subtest: 45.367 — matrix batches[].expected_score_keys (D17): WRONG TYPE ("not-a-number") → expected_score_keys_absent
ok 3033 - 45.367 — matrix batches[].expected_score_keys (D17): WRONG TYPE ("not-a-number") → expected_score_keys_absent
  ---
  duration_ms: 0.049875
  type: 'test'
  ...
# Subtest: 45.368 — matrix batches[].finite_score_keys (D17): ABSENT → finite_score_keys_absent
ok 3034 - 45.368 — matrix batches[].finite_score_keys (D17): ABSENT → finite_score_keys_absent
  ---
  duration_ms: 0.050083
  type: 'test'
  ...
# Subtest: 45.369 — matrix batches[].finite_score_keys (D17): NULL → finite_score_keys_absent
ok 3035 - 45.369 — matrix batches[].finite_score_keys (D17): NULL → finite_score_keys_absent
  ---
  duration_ms: 0.051709
  type: 'test'
  ...
# Subtest: 45.370 — matrix batches[].finite_score_keys (D17): WRONG TYPE ("not-a-number") → finite_score_keys_absent
ok 3036 - 45.370 — matrix batches[].finite_score_keys (D17): WRONG TYPE ("not-a-number") → finite_score_keys_absent
  ---
  duration_ms: 0.050375
  type: 'test'
  ...
# Subtest: 45.371 — matrix batches[].missing_score_keys (D15): ABSENT → missing_score_keys_absent
ok 3037 - 45.371 — matrix batches[].missing_score_keys (D15): ABSENT → missing_score_keys_absent
  ---
  duration_ms: 0.051958
  type: 'test'
  ...
# Subtest: 45.372 — matrix batches[].missing_score_keys (D15): NULL → missing_score_keys_absent
ok 3038 - 45.372 — matrix batches[].missing_score_keys (D15): NULL → missing_score_keys_absent
  ---
  duration_ms: 0.051
  type: 'test'
  ...
# Subtest: 45.373 — matrix batches[].missing_score_keys (D15): WRONG TYPE ("not-a-number") → missing_score_keys_absent
ok 3039 - 45.373 — matrix batches[].missing_score_keys (D15): WRONG TYPE ("not-a-number") → missing_score_keys_absent
  ---
  duration_ms: 0.048875
  type: 'test'
  ...
# Subtest: 45.374 — matrix batches[].nonnumeric_score_keys (D15): ABSENT → nonnumeric_score_keys_absent
ok 3040 - 45.374 — matrix batches[].nonnumeric_score_keys (D15): ABSENT → nonnumeric_score_keys_absent
  ---
  duration_ms: 0.050834
  type: 'test'
  ...
# Subtest: 45.375 — matrix batches[].nonnumeric_score_keys (D15): NULL → nonnumeric_score_keys_absent
ok 3041 - 45.375 — matrix batches[].nonnumeric_score_keys (D15): NULL → nonnumeric_score_keys_absent
  ---
  duration_ms: 0.05225
  type: 'test'
  ...
# Subtest: 45.376 — matrix batches[].nonnumeric_score_keys (D15): WRONG TYPE ("not-a-number") → nonnumeric_score_keys_absent
ok 3042 - 45.376 — matrix batches[].nonnumeric_score_keys (D15): WRONG TYPE ("not-a-number") → nonnumeric_score_keys_absent
  ---
  duration_ms: 0.051667
  type: 'test'
  ...
# Subtest: 45.377 — matrix batches[].prompt_tokens (v25 §3.2): ABSENT → batch_prompt_tokens_field_absent
ok 3043 - 45.377 — matrix batches[].prompt_tokens (v25 §3.2): ABSENT → batch_prompt_tokens_field_absent
  ---
  duration_ms: 0.050958
  type: 'test'
  ...
# Subtest: 45.378 — matrix batches[].prompt_tokens (v25 §3.2): NULL → permitted here, no code
ok 3044 - 45.378 — matrix batches[].prompt_tokens (v25 §3.2): NULL → permitted here, no code
  ---
  duration_ms: 0.049917
  type: 'test'
  ...
# Subtest: 45.379 — matrix batches[].prompt_tokens (v25 §3.2): WRONG TYPE ("not-a-number") → batch_prompt_tokens_invalid
ok 3045 - 45.379 — matrix batches[].prompt_tokens (v25 §3.2): WRONG TYPE ("not-a-number") → batch_prompt_tokens_invalid
  ---
  duration_ms: 0.049458
  type: 'test'
  ...
# Subtest: 45.380 — matrix batches[].completion_tokens (v25 §3.2): ABSENT → batch_completion_tokens_field_absent
ok 3046 - 45.380 — matrix batches[].completion_tokens (v25 §3.2): ABSENT → batch_completion_tokens_field_absent
  ---
  duration_ms: 0.051959
  type: 'test'
  ...
# Subtest: 45.381 — matrix batches[].completion_tokens (v25 §3.2): NULL → permitted here, no code
ok 3047 - 45.381 — matrix batches[].completion_tokens (v25 §3.2): NULL → permitted here, no code
  ---
  duration_ms: 0.340625
  type: 'test'
  ...
# Subtest: 45.382 — matrix batches[].completion_tokens (v25 §3.2): WRONG TYPE ("not-a-number") → batch_completion_tokens_invalid
ok 3048 - 45.382 — matrix batches[].completion_tokens (v25 §3.2): WRONG TYPE ("not-a-number") → batch_completion_tokens_invalid
  ---
  duration_ms: 0.05625
  type: 'test'
  ...
# Subtest: 45.383 — matrix multi_query.variant_generation (D17): ABSENT → variant_generation_absent
ok 3049 - 45.383 — matrix multi_query.variant_generation (D17): ABSENT → variant_generation_absent
  ---
  duration_ms: 0.064459
  type: 'test'
  ...
# Subtest: 45.384 — matrix multi_query.variant_generation (D17): NULL → variant_generation_absent
ok 3050 - 45.384 — matrix multi_query.variant_generation (D17): NULL → variant_generation_absent
  ---
  duration_ms: 0.060042
  type: 'test'
  ...
# Subtest: 45.385 — matrix multi_query.variant_generation (D17): WRONG TYPE (["not","an","object"]) → variant_generation_absent
ok 3051 - 45.385 — matrix multi_query.variant_generation (D17): WRONG TYPE (["not","an","object"]) → variant_generation_absent
  ---
  duration_ms: 0.100125
  type: 'test'
  ...
# Subtest: 45.386 — matrix multi_query.variant_generation.status (D17): ABSENT → variant_generation_status_absent_or_invalid
ok 3052 - 45.386 — matrix multi_query.variant_generation.status (D17): ABSENT → variant_generation_status_absent_or_invalid
  ---
  duration_ms: 0.3225
  type: 'test'
  ...
# Subtest: 45.387 — matrix multi_query.variant_generation.status (D17): NULL → variant_generation_status_absent_or_invalid
ok 3053 - 45.387 — matrix multi_query.variant_generation.status (D17): NULL → variant_generation_status_absent_or_invalid
  ---
  duration_ms: 0.076625
  type: 'test'
  ...
# Subtest: 45.388 — matrix multi_query.variant_generation.status (D17): WRONG TYPE ("not-a-member-of-this-enum") → variant_generation_status_absent_or_invalid
ok 3054 - 45.388 — matrix multi_query.variant_generation.status (D17): WRONG TYPE ("not-a-member-of-this-enum") → variant_generation_status_absent_or_invalid
  ---
  duration_ms: 0.064
  type: 'test'
  ...
# Subtest: 45.389 — matrix multi_query.variant_generation.served_route_class (D16): ABSENT → variant_generation_served_route_class_field_absent
ok 3055 - 45.389 — matrix multi_query.variant_generation.served_route_class (D16): ABSENT → variant_generation_served_route_class_field_absent
  ---
  duration_ms: 0.06275
  type: 'test'
  ...
# Subtest: 45.390 — matrix multi_query.variant_generation.served_route_class (D16): NULL → permitted here, no code
ok 3056 - 45.390 — matrix multi_query.variant_generation.served_route_class (D16): NULL → permitted here, no code
  ---
  duration_ms: 0.06475
  type: 'test'
  ...
# Subtest: 45.391 — matrix multi_query.variant_generation.served_route_class (D16): WRONG TYPE ("not-a-member-of-this-enum") → variant_generation_served_route_class_invalid
ok 3057 - 45.391 — matrix multi_query.variant_generation.served_route_class (D16): WRONG TYPE ("not-a-member-of-this-enum") → variant_generation_served_route_class_invalid
  ---
  duration_ms: 0.060459
  type: 'test'
  ...
# Subtest: 45.392 — matrix multi_query.variant_generation.served_model (D17): ABSENT → variant_generation_served_model_field_absent
ok 3058 - 45.392 — matrix multi_query.variant_generation.served_model (D17): ABSENT → variant_generation_served_model_field_absent
  ---
  duration_ms: 0.059042
  type: 'test'
  ...
# Subtest: 45.393 — matrix multi_query.variant_generation.served_model (D17): NULL → permitted here, no code
ok 3059 - 45.393 — matrix multi_query.variant_generation.served_model (D17): NULL → permitted here, no code
  ---
  duration_ms: 1.120292
  type: 'test'
  ...
# Subtest: 45.394 — matrix multi_query.variant_generation.served_model (D17): WRONG TYPE (4242) → variant_generation_served_model_invalid
ok 3060 - 45.394 — matrix multi_query.variant_generation.served_model (D17): WRONG TYPE (4242) → variant_generation_served_model_invalid
  ---
  duration_ms: 2.024042
  type: 'test'
  ...
# Subtest: 45.395 — matrix multi_query.variant_generation.attempts (D17): ABSENT → variant_generation_attempts_field_absent
ok 3061 - 45.395 — matrix multi_query.variant_generation.attempts (D17): ABSENT → variant_generation_attempts_field_absent
  ---
  duration_ms: 0.402583
  type: 'test'
  ...
# Subtest: 45.396 — matrix multi_query.variant_generation.attempts (D17): NULL → permitted here, no code
ok 3062 - 45.396 — matrix multi_query.variant_generation.attempts (D17): NULL → permitted here, no code
  ---
  duration_ms: 0.089458
  type: 'test'
  ...
# Subtest: 45.397 — matrix multi_query.variant_generation.attempts (D17): WRONG TYPE ("not-an-attempt-list") → attempt_outcome_absent_or_invalid
ok 3063 - 45.397 — matrix multi_query.variant_generation.attempts (D17): WRONG TYPE ("not-an-attempt-list") → attempt_outcome_absent_or_invalid
  ---
  duration_ms: 0.067458
  type: 'test'
  ...
# Subtest: 45.398 — matrix multi_query.variant_generation.prompt_tokens (v26 §3.5): ABSENT → variant_generation_prompt_tokens_field_absent
ok 3064 - 45.398 — matrix multi_query.variant_generation.prompt_tokens (v26 §3.5): ABSENT → variant_generation_prompt_tokens_field_absent
  ---
  duration_ms: 0.062667
  type: 'test'
  ...
# Subtest: 45.399 — matrix multi_query.variant_generation.prompt_tokens (v26 §3.5): NULL → permitted here, no code
ok 3065 - 45.399 — matrix multi_query.variant_generation.prompt_tokens (v26 §3.5): NULL → permitted here, no code
  ---
  duration_ms: 0.057792
  type: 'test'
  ...
# Subtest: 45.400 — matrix multi_query.variant_generation.prompt_tokens (v26 §3.5): WRONG TYPE ("not-a-number") → variant_generation_prompt_tokens_invalid
ok 3066 - 45.400 — matrix multi_query.variant_generation.prompt_tokens (v26 §3.5): WRONG TYPE ("not-a-number") → variant_generation_prompt_tokens_invalid
  ---
  duration_ms: 0.057334
  type: 'test'
  ...
# Subtest: 45.401 — matrix multi_query.variant_generation.completion_tokens (v26 §3.5): ABSENT → variant_generation_completion_tokens_field_absent
ok 3067 - 45.401 — matrix multi_query.variant_generation.completion_tokens (v26 §3.5): ABSENT → variant_generation_completion_tokens_field_absent
  ---
  duration_ms: 0.058
  type: 'test'
  ...
# Subtest: 45.402 — matrix multi_query.variant_generation.completion_tokens (v26 §3.5): NULL → permitted here, no code
ok 3068 - 45.402 — matrix multi_query.variant_generation.completion_tokens (v26 §3.5): NULL → permitted here, no code
  ---
  duration_ms: 0.058875
  type: 'test'
  ...
# Subtest: 45.403 — matrix multi_query.variant_generation.completion_tokens (v26 §3.5): WRONG TYPE ("not-a-number") → variant_generation_completion_tokens_invalid
ok 3069 - 45.403 — matrix multi_query.variant_generation.completion_tokens (v26 §3.5): WRONG TYPE ("not-a-number") → variant_generation_completion_tokens_invalid
  ---
  duration_ms: 0.059625
  type: 'test'
  ...
# Subtest: 45.404 — matrix multi_query.variant_generation.generated_variant_count (D17): ABSENT → generated_variant_count_absent
ok 3070 - 45.404 — matrix multi_query.variant_generation.generated_variant_count (D17): ABSENT → generated_variant_count_absent
  ---
  duration_ms: 0.05825
  type: 'test'
  ...
# Subtest: 45.405 — matrix multi_query.variant_generation.generated_variant_count (D17): NULL → generated_variant_count_absent
ok 3071 - 45.405 — matrix multi_query.variant_generation.generated_variant_count (D17): NULL → generated_variant_count_absent
  ---
  duration_ms: 0.057875
  type: 'test'
  ...
# Subtest: 45.406 — matrix multi_query.variant_generation.generated_variant_count (D17): WRONG TYPE ("not-a-number") → generated_variant_count_absent
ok 3072 - 45.406 — matrix multi_query.variant_generation.generated_variant_count (D17): WRONG TYPE ("not-a-number") → generated_variant_count_absent
  ---
  duration_ms: 0.056958
  type: 'test'
  ...
# Subtest: 45.407 — matrix multi_query.variants (D17): ABSENT → variants_absent
ok 3073 - 45.407 — matrix multi_query.variants (D17): ABSENT → variants_absent
  ---
  duration_ms: 0.057209
  type: 'test'
  ...
# Subtest: 45.408 — matrix multi_query.variants (D17): NULL → variants_absent
ok 3074 - 45.408 — matrix multi_query.variants (D17): NULL → variants_absent
  ---
  duration_ms: 0.054959
  type: 'test'
  ...
# Subtest: 45.409 — matrix multi_query.variants (D17): WRONG TYPE ("not-an-array") → variants_absent
ok 3075 - 45.409 — matrix multi_query.variants (D17): WRONG TYPE ("not-an-array") → variants_absent
  ---
  duration_ms: 0.05475
  type: 'test'
  ...
# Subtest: 45.410 — matrix multi_query.variants[] (v26 §3.1): a null member → variant_member_invalid, without throwing
ok 3076 - 45.410 — matrix multi_query.variants[] (v26 §3.1): a null member → variant_member_invalid, without throwing
  ---
  duration_ms: 0.060125
  type: 'test'
  ...
# Subtest: 45.411 — matrix multi_query.variants[] (v26 §3.1): a numeric member → variant_member_invalid
ok 3077 - 45.411 — matrix multi_query.variants[] (v26 §3.1): a numeric member → variant_member_invalid
  ---
  duration_ms: 0.057875
  type: 'test'
  ...
# Subtest: 45.412 — matrix multi_query.variants[] (v26 §3.1): an array member → variant_member_invalid
ok 3078 - 45.412 — matrix multi_query.variants[] (v26 §3.1): an array member → variant_member_invalid
  ---
  duration_ms: 0.072083
  type: 'test'
  ...
# Subtest: 45.413 — matrix multi_query.variants[].index (D17): ABSENT → variant_index_absent_or_invalid
ok 3079 - 45.413 — matrix multi_query.variants[].index (D17): ABSENT → variant_index_absent_or_invalid
  ---
  duration_ms: 0.073875
  type: 'test'
  ...
# Subtest: 45.414 — matrix multi_query.variants[].index (D17): NULL → variant_index_absent_or_invalid
ok 3080 - 45.414 — matrix multi_query.variants[].index (D17): NULL → variant_index_absent_or_invalid
  ---
  duration_ms: 0.056875
  type: 'test'
  ...
# Subtest: 45.415 — matrix multi_query.variants[].index (D17): WRONG TYPE ("not-a-number") → variant_index_absent_or_invalid
ok 3081 - 45.415 — matrix multi_query.variants[].index (D17): WRONG TYPE ("not-a-number") → variant_index_absent_or_invalid
  ---
  duration_ms: 0.057292
  type: 'test'
  ...
# Subtest: 45.416 — matrix multi_query.variants[].outcome (D17): ABSENT → variant_outcome_absent_or_invalid
ok 3082 - 45.416 — matrix multi_query.variants[].outcome (D17): ABSENT → variant_outcome_absent_or_invalid
  ---
  duration_ms: 0.055958
  type: 'test'
  ...
# Subtest: 45.417 — matrix multi_query.variants[].outcome (D17): NULL → variant_outcome_absent_or_invalid
ok 3083 - 45.417 — matrix multi_query.variants[].outcome (D17): NULL → variant_outcome_absent_or_invalid
  ---
  duration_ms: 0.054417
  type: 'test'
  ...
# Subtest: 45.418 — matrix multi_query.variants[].outcome (D17): WRONG TYPE ("not-a-member-of-this-enum") → variant_outcome_absent_or_invalid
ok 3084 - 45.418 — matrix multi_query.variants[].outcome (D17): WRONG TYPE ("not-a-member-of-this-enum") → variant_outcome_absent_or_invalid
  ---
  duration_ms: 0.055833
  type: 'test'
  ...
# Subtest: 45.419 — matrix multi_query.variants[].candidate_count (D17): ABSENT → variant_candidate_count_absent_or_invalid
ok 3085 - 45.419 — matrix multi_query.variants[].candidate_count (D17): ABSENT → variant_candidate_count_absent_or_invalid
  ---
  duration_ms: 0.055292
  type: 'test'
  ...
# Subtest: 45.420 — matrix multi_query.variants[].candidate_count (D17): NULL → variant_candidate_count_absent_or_invalid
ok 3086 - 45.420 — matrix multi_query.variants[].candidate_count (D17): NULL → variant_candidate_count_absent_or_invalid
  ---
  duration_ms: 0.054208
  type: 'test'
  ...
# Subtest: 45.421 — matrix multi_query.variants[].candidate_count (D17): WRONG TYPE ("not-a-number") → variant_candidate_count_absent_or_invalid
ok 3087 - 45.421 — matrix multi_query.variants[].candidate_count (D17): WRONG TYPE ("not-a-number") → variant_candidate_count_absent_or_invalid
  ---
  duration_ms: 0.055958
  type: 'test'
  ...
# Subtest: 45.199 — THE COUNT, computed not recalled: the matrix length, the generated cases, unique paths, and D17's transcribed field list all resolved into the matrix
ok 3088 - 45.199 — THE COUNT, computed not recalled: the matrix length, the generated cases, unique paths, and D17's transcribed field list all resolved into the matrix
  ---
  duration_ms: 0.366459
  type: 'test'
  ...
# Subtest: 45.198 — batches: [null] returns CODES, it does not throw; and every other malformed member shape is classified the same way
ok 3089 - 45.198 — batches: [null] returns CODES, it does not throw; and every other malformed member shape is classified the same way
  ---
  duration_ms: 0.475208
  type: 'test'
  ...
# Subtest: 45.197 — validateManifest is STABLE on unknown input: hostile top-level values and a hostile value at every matrix path return string codes and never throw
ok 3090 - 45.197 — validateManifest is STABLE on unknown input: hostile top-level values and a hostile value at every matrix path return string codes and never throw
  ---
  duration_ms: 79.150833
  type: 'test'
  ...
# Subtest: 45.196 — THE LICENCE'S FIELDS (v26 §3.4): under hmac_key_absent the four HMAC fields may be NULL but must be PRESENT and correctly TYPED — a missing hmac_key_version no longer validates clean
ok 3091 - 45.196 — THE LICENCE'S FIELDS (v26 §3.4): under hmac_key_absent the four HMAC fields may be NULL but must be PRESENT and correctly TYPED — a missing hmac_key_version no longer validates clean
  ---
  duration_ms: 0.996875
  type: 'test'
  ...
# Subtest: 46.1 — expansion.served_route_class null with status skipped is valid: no expansion code, so a normative_channel row is not partial by construction
ok 3092 - 46.1 — expansion.served_route_class null with status skipped is valid: no expansion code, so a normative_channel row is not partial by construction
  ---
  duration_ms: 0.234208
  type: 'test'
  ...
# Subtest: 46.2 — through the REAL builder: a normative_channel capture (expansion never set — the leg sets skipExpand unconditionally) produces a payload that validates clean
ok 3093 - 46.2 — through the REAL builder: a normative_channel capture (expansion never set — the leg sets skipExpand unconditionally) produces a payload that validates clean
  ---
  duration_ms: 0.215166
  type: 'test'
  ...
# Subtest: 47.1 — on role primary the scorer-context HMAC is REQUIRED: computed over the EXACT citedContext bytes, and it changes when one byte does
ok 3094 - 47.1 — on role primary the scorer-context HMAC is REQUIRED: computed over the EXACT citedContext bytes, and it changes when one byte does
  ---
  duration_ms: 0.387792
  type: 'test'
  ...
# Subtest: 47.2 — the EMPTY-STRING case: zero candidates render an empty citedContext, and the HMAC of the empty string is a DEFINED value — never null because reranking was skipped
ok 3095 - 47.2 — the EMPTY-STRING case: zero candidates render an empty citedContext, and the HMAC of the empty string is a DEFINED value — never null because reranking was skipped
  ---
  duration_ms: 0.14125
  type: 'test'
  ...
# Subtest: 47.3 — on the other FOUR roles the HMAC is null, and those nulls are NOT partial
ok 3096 - 47.3 — on the other FOUR roles the HMAC is null, and those nulls are NOT partial
  ---
  duration_ms: 0.285792
  type: 'test'
  ...
# Subtest: 47.4 — a NON-NULL scorer-context HMAC on any of the four non-primary roles is REJECTED (v25 §3.3): scorer_context_hmac_on_non_primary_role — and primary is untouched
ok 3097 - 47.4 — a NON-NULL scorer-context HMAC on any of the four non-primary roles is REJECTED (v25 §3.3): scorer_context_hmac_on_non_primary_role — and primary is untouched
  ---
  duration_ms: 0.415417
  type: 'test'
  ...
# Subtest: 47.5 — through the REAL assembleAuditContext: the primary HMAC is the keyed HMAC of the EXACT rendered citedContext (literature only, and literature plus the normative block), and with zero hits the rendered context is the EMPTY STRING whose HMAC is a defined value
ok 3098 - 47.5 — through the REAL assembleAuditContext: the primary HMAC is the keyed HMAC of the EXACT rendered citedContext (literature only, and literature plus the normative block), and with zero hits the rendered context is the EMPTY STRING whose HMAC is a defined value
  ---
  duration_ms: 0.464958
  type: 'test'
  ...
# Subtest: 47.6 — the PRODUCTION CALLER handoff, pinned in comment-stripped source: lib/opd-note-audit.ts destructures citedContext from assembleAuditContext(hits, normHits), passes it into writeRetrievalTerminals, keys the PRIMARY payload with scorerContext: citedContext, the NORMATIVE payload with scorerContext: null, and validates the stamped primary manifest
ok 3099 - 47.6 — the PRODUCTION CALLER handoff, pinned in comment-stripped source: lib/opd-note-audit.ts destructures citedContext from assembleAuditContext(hits, normHits), passes it into writeRetrievalTerminals, keys the PRIMARY payload with scorerContext: citedContext, the NORMATIVE payload with scorerContext: null, and validates the stamped primary manifest
  ---
  duration_ms: 0.807
  type: 'test'
  ...
# Subtest: 47.7 — EXECUTED through the production terminal-payload path: real assembleAuditContext output → writeRetrievalTerminals (the seam) → the PRIMARY terminal write carries the keyed HMAC of exactly those bytes, the NORMATIVE write carries null, both manifests validate clean, and the handle is published after each
ok 3100 - 47.7 — EXECUTED through the production terminal-payload path: real assembleAuditContext output → writeRetrievalTerminals (the seam) → the PRIMARY terminal write carries the keyed HMAC of exactly those bytes, the NORMATIVE write carries null, both manifests validate clean, and the handle is published after each
  ---
  duration_ms: 3.942458
  type: 'test'
  ...
# Subtest: 47.8 — EXECUTED, the EMPTY-STRING case: zero hits render an empty citedContext through the production path, and the primary write carries HMAC(""), a defined value — never null
ok 3101 - 47.8 — EXECUTED, the EMPTY-STRING case: zero hits render an empty citedContext through the production path, and the primary write carries HMAC(""), a defined value — never null
  ---
  duration_ms: 0.5245
  type: 'test'
  ...
# Subtest: 49.1 — EMPTY FUSION: retrieve() returns before the rerank block exists — fused 0, hydrated 0, expected 0, recorded 0, batches [], backend and model none
ok 3102 - 49.1 — EMPTY FUSION: retrieve() returns before the rerank block exists — fused 0, hydrated 0, expected 0, recorded 0, batches [], backend and model none
  ---
  duration_ms: 0.247291
  type: 'test'
  ...
# Subtest: 49.2 — HYDRATE EMPTIED: fused > 0, hydrated 0 — the same shape, and the TWO COUNTS DIFFER, which is the point
ok 3103 - 49.2 — HYDRATE EMPTIED: fused > 0, hydrated 0 — the same shape, and the TWO COUNTS DIFFER, which is the point
  ---
  duration_ms: 0.113625
  type: 'test'
  ...
# Subtest: 49.3 — the two zero-candidate shapes are DISTINGUISHABLE: empty fusion (0/0) and hydrate emptied (3/0) differ in fused_candidate_count and agree in hydrated_candidate_count
ok 3104 - 49.3 — the two zero-candidate shapes are DISTINGUISHABLE: empty fusion (0/0) and hydrate emptied (3/0) differ in fused_candidate_count and agree in hydrated_candidate_count
  ---
  duration_ms: 0.050958
  type: 'test'
  ...
# Subtest: 49.4 — ONE HYDRATED CANDIDATE: rerank() is never entered — hydrated 1, expected 0, recorded 0, batches [], backend and model none
ok 3105 - 49.4 — ONE HYDRATED CANDIDATE: rerank() is never entered — hydrated 1, expected 0, recorded 0, batches [], backend and model none
  ---
  duration_ms: 0.102125
  type: 'test'
  ...
# Subtest: 49.5 — RERANKER DISABLED (normative_channel always; lab_direct when the caller sets it): several hydrated candidates, the same shape as the one-candidate case
ok 3106 - 49.5 — RERANKER DISABLED (normative_channel always; lab_direct when the caller sets it): several hydrated candidates, the same shape as the one-candidate case
  ---
  duration_ms: 0.317583
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: default path: filter clause array is byte-identical to production, no params
ok 3107 - default path: filter clause array is byte-identical to production, no params
  ---
  duration_ms: 0.849708
  type: 'test'
  ...
# Subtest: default path with structural filters keeps the base guards and remaps $FP offsets per leg
ok 3108 - default path with structural filters keeps the base guards and remaps $FP offsets per leg
  ---
  duration_ms: 0.104208
  type: 'test'
  ...
# Subtest: relaxed path: both quarantine guards gain a bound OR arm on both legs
ok 3109 - relaxed path: both quarantine guards gain a bound OR arm on both legs
  ---
  duration_ms: 0.204625
  type: 'test'
  ...
# Subtest: relaxed path ordering: the quarantine label takes $FP_0, structural filters follow
ok 3110 - relaxed path ordering: the quarantine label takes $FP_0, structural filters follow
  ---
  duration_ms: 0.088125
  type: 'test'
  ...
# Subtest: hostile labels are slugged by labLabel and cannot widen the filter
ok 3111 - hostile labels are slugged by labLabel and cannot widen the filter
  ---
  duration_ms: 0.2325
  type: 'test'
  ...
# Subtest: empty/whitespace includeQuarantined is treated as omitted (byte-identical default path)
ok 3112 - empty/whitespace includeQuarantined is treated as omitted (byte-identical default path)
  ---
  duration_ms: 0.099
  type: 'test'
  ...
# Subtest: clampLabRetrieveTopK clamps to [1,20], default 8
ok 3113 - clampLabRetrieveTopK clamps to [1,20], default 8
  ---
  duration_ms: 0.065958
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: restrictSources omitted ⇒ default clauses + no params (byte-identical)
ok 3114 - restrictSources omitted ⇒ default clauses + no params (byte-identical)
  ---
  duration_ms: 0.808875
  type: 'test'
  ...
# Subtest: restrictSources: [choosing-wisely] ⇒ both legs source = ANY, bound array param
ok 3115 - restrictSources: [choosing-wisely] ⇒ both legs source = ANY, bound array param
  ---
  duration_ms: 0.132667
  type: 'test'
  ...
# Subtest: a named labq: source is admitted through the quarantine guard; un-named stays excluded
ok 3116 - a named labq: source is admitted through the quarantine guard; un-named stays excluded
  ---
  duration_ms: 0.116084
  type: 'test'
  ...
# Subtest: empty or all-blank restrictSources falls back to the default filter (no restriction)
ok 3117 - empty or all-blank restrictSources falls back to the default filter (no restriction)
  ---
  duration_ms: 0.128084
  type: 'test'
  ...
# Subtest: restrictSources stacks with book/chunk filters and supersedes the single-source filter
ok 3118 - restrictSources stacks with book/chunk filters and supersedes the single-source filter
  ---
  duration_ms: 0.054333
  type: 'test'
  ...
# Subtest: group key exactness: same (subject, signal_type) groups; different signal splits
ok 3119 - group key exactness: same (subject, signal_type) groups; different signal splits
  ---
  duration_ms: 1.414708
  type: 'test'
  ...
# Subtest: '' signal folds like stewardship (empty signal groups together)
ok 3120 - '' signal folds like stewardship (empty signal groups together)
  ---
  duration_ms: 0.190417
  type: 'test'
  ...
# Subtest: ≥2 threshold: a pair groups, a singleton does not
ok 3121 - ≥2 threshold: a pair groups, a singleton does not
  ---
  duration_ms: 0.74925
  type: 'test'
  ...
# Subtest: section order + group sort (size desc, newest tie-break) + singles in queue order
ok 3122 - section order + group sort (size desc, newest tie-break) + singles in queue order
  ---
  duration_ms: 0.68325
  type: 'test'
  ...
# Subtest: disagreement pinning: disagreements section leads the order, groups/singles below
ok 3123 - disagreement pinning: disagreements section leads the order, groups/singles below
  ---
  duration_ms: 0.321709
  type: 'test'
  ...
# Subtest: traversal: within-group → next group → singles; wrap; exhausted → null
ok 3124 - traversal: within-group → next group → singles; wrap; exhausted → null
  ---
  duration_ms: 0.248042
  type: 'test'
  ...
# Subtest: skip sinks within its section and traversal passes it over
ok 3125 - skip sinks within its section and traversal passes it over
  ---
  duration_ms: 0.325916
  type: 'test'
  ...
# Subtest: labeled stays in place (not sunk) with its status; k/n progress counts labeled+skipped
ok 3126 - labeled stays in place (not sunk) with its status; k/n progress counts labeled+skipped
  ---
  duration_ms: 0.167666
  type: 'test'
  ...
# Subtest: determinism: same input → identical output
ok 3127 - determinism: same input → identical output
  ---
  duration_ms: 0.471584
  type: 'test'
  ...
# Subtest: hashBucket is deterministic and in 0..99
ok 3128 - hashBucket is deterministic and in 0..99
  ---
  duration_ms: 1.310125
  type: 'test'
  ...
# Subtest: overlap is ~20% and buckets < 20
ok 3129 - overlap is ~20% and buckets < 20
  ---
  duration_ms: 0.520458
  type: 'test'
  ...
# Subtest: overlap findings are served to EVERY reviewer; partitioned to exactly one
ok 3130 - overlap findings are served to EVERY reviewer; partitioned to exactly one
  ---
  duration_ms: 1.036167
  type: 'test'
  ...
# Subtest: a reviewer not on the roster still gets the overlap set (only)
ok 3131 - a reviewer not on the roster still gets the overlap set (only)
  ---
  duration_ms: 0.349042
  type: 'test'
  ...
# Subtest: partition is roughly even across the roster
ok 3132 - partition is roughly even across the roster
  ---
  duration_ms: 0.186958
  type: 'test'
  ...
# Subtest: balanceBySignalType interleaves types and is newest-first within a type
ok 3133 - balanceBySignalType interleaves types and is newest-first within a type
  ---
  duration_ms: 0.9515
  type: 'test'
  ...
# Subtest: disagreement items come first, then fresh; limit respected
ok 3134 - disagreement items come first, then fresh; limit respected
  ---
  duration_ms: 0.743625
  type: 'test'
  ...
# Subtest: passthrough: optional uid + prescription_url survive buildReviewQueue onto emitted items
ok 3135 - passthrough: optional uid + prescription_url survive buildReviewQueue onto emitted items
  ---
  duration_ms: 0.266375
  type: 'test'
  ...
# Subtest: excludes labeled-by-this-reviewer, informational, unassigned, and filtered-out findings
ok 3136 - excludes labeled-by-this-reviewer, informational, unassigned, and filtered-out findings
  ---
  duration_ms: 1.526917
  type: 'test'
  ...
# Subtest: parseGoal: valid / missing / garbage → exact defaults; personal ceil
ok 3137 - parseGoal: valid / missing / garbage → exact defaults; personal ceil
  ---
  duration_ms: 1.094208
  type: 'test'
  ...
# Subtest: prevDay + istWeekStart (Monday-start)
ok 3138 - prevDay + istWeekStart (Monday-start)
  ---
  duration_ms: 1.12275
  type: 'test'
  ...
# Subtest: countedLabels: impact excluded, missed included, roster filter, finding current-state (later wins)
ok 3139 - countedLabels: impact excluded, missed included, roster filter, finding current-state (later wins)
  ---
  duration_ms: 0.42875
  type: 'test'
  ...
# Subtest: streak: threshold exactly 15, consecutive, yesterday-grace, today-only, gap → 0
ok 3140 - streak: threshold exactly 15, consecutive, yesterday-grace, today-only, gap → 0
  ---
  duration_ms: 0.572791
  type: 'test'
  ...
# Subtest: agreement: pair construction (2 & 3 reviewers), tier match/mismatch, overlap-only
ok 3141 - agreement: pair construction (2 & 3 reviewers), tier match/mismatch, overlap-only
  ---
  duration_ms: 0.453
  type: 'test'
  ...
# Subtest: agreement: current-state dedup feeds pairs (later verdict wins), then match recomputed
ok 3142 - agreement: current-state dedup feeds pairs (later verdict wins), then match recomputed
  ---
  duration_ms: 0.363791
  type: 'test'
  ...
# Subtest: computeReviewStats: ≥20-pair display boundary, week total, badges shape
ok 3143 - computeReviewStats: ≥20-pair display boundary, week total, badges shape
  ---
  duration_ms: 0.594792
  type: 'test'
  ...
# Subtest: the committed gold artifact is frozen, ratified, and catalog-consistent
ok 3144 - the committed gold artifact is frozen, ratified, and catalog-consistent
  ---
  duration_ms: 6.597708
  type: 'test'
  ...
# Subtest: loadCheckGold rejects drift: wrong version, unratified, polarity/target mismatch
ok 3145 - loadCheckGold rejects drift: wrong version, unratified, polarity/target mismatch
  ---
  duration_ms: 2.600542
  type: 'test'
  ...
# Subtest: the committed 2.0 artifact is frozen, ratified, family-split, and catalog-consistent
ok 3146 - the committed 2.0 artifact is frozen, ratified, family-split, and catalog-consistent
  ---
  duration_ms: 1.24425
  type: 'test'
  ...
# Subtest: loadCheckGold2: accepts the delivered shape — empty targets legal, L carries annex/memberHistory
ok 3147 - loadCheckGold2: accepts the delivered shape — empty targets legal, L carries annex/memberHistory
  ---
  duration_ms: 0.501083
  type: 'test'
  ...
# Subtest: loadCheckGold2 rejects drift: version, status, dup ids, missing verdict fields, annex misuse
ok 3148 - loadCheckGold2 rejects drift: version, status, dup ids, missing verdict fields, annex misuse
  ---
  duration_ms: 0.836417
  type: 'test'
  ...
# Subtest: splitCheckGold2: P/N/C form the scored floor, L is the annex — never folded together
ok 3149 - splitCheckGold2: P/N/C form the scored floor, L is the annex — never folded together
  ---
  duration_ms: 1.583666
  type: 'test'
  ...
# Subtest: checkGold2CatalogGaps: unbound polarity-side targets are flagged, bound ones are not
ok 3150 - checkGold2CatalogGaps: unbound polarity-side targets are flagged, bound ones are not
  ---
  duration_ms: 0.330041
  type: 'test'
  ...
# Subtest: scoreCheckAgainstGold: per-target-rec, deterministic, ignores non-target firings
ok 3151 - scoreCheckAgainstGold: per-target-rec, deterministic, ignores non-target firings
  ---
  duration_ms: 0.266042
  type: 'test'
  ...
# Subtest: aggregateCheckGold: hand-computed recall / specificity / precision / F1
ok 3152 - aggregateCheckGold: hand-computed recall / specificity / precision / F1
  ---
  duration_ms: 0.898167
  type: 'test'
  ...
# Subtest: Fix A: ANALYZE_SYSTEM carries the verdict discipline (uncertain = equipoise only)
ok 3153 - Fix A: ANALYZE_SYSTEM carries the verdict discipline (uncertain = equipoise only)
  ---
  duration_ms: 0.488125
  type: 'test'
  ...
# Subtest: Fix A: normNetValue contract unchanged, but the parse fallback is now visible
ok 3154 - Fix A: normNetValue contract unchanged, but the parse fallback is now visible
  ---
  duration_ms: 0.175667
  type: 'test'
  ...
# Subtest: Fix B: the two syncope recs are in the seed, verified, unique, well-formed
ok 3155 - Fix B: the two syncope recs are in the seed, verified, unique, well-formed
  ---
  duration_ms: 1.549958
  type: 'test'
  ...
# Subtest: Fix B gold: deterministic recall hits C04 with BOTH new recs, and no other check case
ok 3156 - Fix B gold: deterministic recall hits C04 with BOTH new recs, and no other check case
  ---
  duration_ms: 4.347083
  type: 'test'
  ...
# Subtest: flag-off byte-identical: every grounded builder without the param equals Slice 1 exactly
ok 3157 - flag-off byte-identical: every grounded builder without the param equals Slice 1 exactly
  ---
  duration_ms: 0.890084
  type: 'test'
  ...
# Subtest: grounded: the picture lands between the input and the downstream sections, verbatim
ok 3158 - grounded: the picture lands between the input and the downstream sections, verbatim
  ---
  duration_ms: 0.151375
  type: 'test'
  ...
# Subtest: patientPictureBlock: formatClinicalState content + the two prompt rules
ok 3159 - patientPictureBlock: formatClinicalState content + the two prompt rules
  ---
  duration_ms: 2.447667
  type: 'test'
  ...
# Subtest: grounding flag is double-gated on the master flag
ok 3160 - grounding flag is double-gated on the master flag
  ---
  duration_ms: 0.119042
  type: 'test'
  ...
# Subtest: frozen bank right-care-eval/1.0: pinned, unique ids, per-mode shape
ok 3161 - frozen bank right-care-eval/1.0: pinned, unique ids, per-mode shape
  ---
  duration_ms: 0.810792
  type: 'test'
  ...
# Subtest: pair-judge parser: defensive on directions, safety classes, fences
ok 3162 - pair-judge parser: defensive on directions, safety classes, fences
  ---
  duration_ms: 0.288583
  type: 'test'
  ...
# Subtest: deterministic check diff: added / removed / kept by rec id
ok 3163 - deterministic check diff: added / removed / kept by rec id
  ---
  duration_ms: 0.241416
  type: 'test'
  ...
# Subtest: scorecard gates: FAIL_SAFETY dominates; PASS needs net improvement clearing noise
ok 3164 - scorecard gates: FAIL_SAFETY dominates; PASS needs net improvement clearing noise
  ---
  duration_ms: 0.242083
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: Order check constructs a ClinicalState from the provided input with counts > 0
ok 3165 - Order check constructs a ClinicalState from the provided input with counts > 0
  ---
  duration_ms: 3.44125
  type: 'test'
  ...
# Subtest: Care pathway constructs from the presentation field with counts > 0
ok 3166 - Care pathway constructs from the presentation field with counts > 0
  ---
  duration_ms: 0.479083
  type: 'test'
  ...
# Subtest: Record audit adapts the existing ExtractedCase and round-trips on the shared fields
ok 3167 - Record audit adapts the existing ExtractedCase and round-trips on the shared fields
  ---
  duration_ms: 0.7965
  type: 'test'
  ...
# Subtest: fail-open: a throwing LLM stage keeps the deterministic state; junk input never throws
ok 3168 - fail-open: a throwing LLM stage keeps the deterministic state; junk input never throws
  ---
  duration_ms: 0.362459
  type: 'test'
  ...
# Subtest: flag-off neutrality: no gate flag → feature inert; UI field off → {}
ok 3169 - flag-off neutrality: no gate flag → feature inert; UI field off → {}
  ---
  duration_ms: 0.535834
  type: 'test'
  ...
# Subtest: save-run reconstruction: same pure builders, schema-valid, per mode
ok 3170 - save-run reconstruction: same pure builders, schema-valid, per mode
  ---
  duration_ms: 0.66425
  type: 'test'
  ...
# Subtest: member link: strict validation, and identity stays OUT of the state
ok 3171 - member link: strict validation, and identity stays OUT of the state
  ---
  duration_ms: 0.201542
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: 1 — a PRIMARY defect leaves the NORMATIVE run clean
ok 3172 - 1 — a PRIMARY defect leaves the NORMATIVE run clean
  ---
  duration_ms: 1.890792
  type: 'test'
  ...
# Subtest: 2 — a NORMATIVE defect leaves the PRIMARY run clean
ok 3173 - 2 — a NORMATIVE defect leaves the PRIMARY run clean
  ---
  duration_ms: 0.312875
  type: 'test'
  ...
# Subtest: 3 — both roles dirty: both settle dirty
ok 3174 - 3 — both roles dirty: both settle dirty
  ---
  duration_ms: 0.429042
  type: 'test'
  ...
# Subtest: 4 — neither dirty: both settle clean
ok 3175 - 4 — neither dirty: both settle clean
  ---
  duration_ms: 0.204792
  type: 'test'
  ...
# Subtest: 4b — an EMPTY array is clean; an ABSENT key on a linkable run is NOT
ok 3176 - 4b — an EMPTY array is clean; an ABSENT key on a linkable run is NOT
  ---
  duration_ms: 0.222
  type: 'test'
  ...
# Subtest: 5 — no map at all: a single-role save behaves exactly as before
ok 3177 - 5 — no map at all: a single-role save behaves exactly as before
  ---
  duration_ms: 5.054292
  type: 'test'
  ...
# Subtest: 5b — only the CLEAN branch is upgraded; a losing race or a skip is never made partial
ok 3178 - 5b — only the CLEAN branch is upgraded; a losing race or a skip is never made partial
  ---
  duration_ms: 0.106708
  type: 'test'
  ...
# Subtest: 5c — a revision-0 role is still not linked, and the per-run upgrade did not disturb that
ok 3179 - 5c — a revision-0 role is still not linked, and the per-run upgrade did not disturb that
  ---
  duration_ms: 0.292292
  type: 'test'
  ...
# Subtest: 6 — every persistence owner passes the role map, and none passes an empty one where it holds defects
ok 3180 - 6 — every persistence owner passes the role map, and none passes an empty one where it holds defects
  ---
  duration_ms: 1.184875
  type: 'test'
  ...
# Subtest: 6b — the upgrade is applied in settlement, not by the owners
ok 3181 - 6b — the upgrade is applied in settlement, not by the owners
  ---
  duration_ms: 0.900667
  type: 'test'
  ...
# Subtest: 6c — settleOwned still takes ONE base outcome and makes ONE settlement call
ok 3182 - 6c — settleOwned still takes ONE base outcome and makes ONE settlement call
  ---
  duration_ms: 0.184166
  type: 'test'
  ...
# Subtest: 6d — settlement is fail-safe: a role map on a handle with no runs settles nothing and throws nothing
ok 3183 - 6d — settlement is fail-safe: a role map on a handle with no runs settles nothing and throws nothing
  ---
  duration_ms: 0.056916
  type: 'test'
  ...
# Subtest: 7 — the three cases of `verdictForRun`, stated directly
ok 3184 - 7 — the three cases of `verdictForRun`, stated directly
  ---
  duration_ms: 0.758292
  type: 'test'
  ...
# Subtest: 7b — requirement 10: an INHERITED key is not a verdict
ok 3185 - 7b — requirement 10: an INHERITED key is not a verdict
  ---
  duration_ms: 0.792875
  type: 'test'
  ...
# Subtest: 7c — an inherited key does not rescue a run from partial, through settlement
ok 3186 - 7c — an inherited key does not rescue a run from partial, through settlement
  ---
  duration_ms: 0.537792
  type: 'test'
  ...
# Subtest: 7d — THE PLACEMENT TEST: the rule reaches a linkable run and stops at a revision-zero one
ok 3187 - 7d — THE PLACEMENT TEST: the rule reaches a linkable run and stops at a revision-zero one
  ---
  duration_ms: 0.651709
  type: 'test'
  ...
# Subtest: 7e — requirement 3 in the only place it is observable: settlement never mutates the map
ok 3188 - 7e — requirement 3 in the only place it is observable: settlement never mutates the map
  ---
  duration_ms: 0.173709
  type: 'test'
  ...
# Subtest: 7f — the base outcome still decides: only a CLEAN run is made partial by a missing key
ok 3189 - 7f — the base outcome still decides: only a CLEAN run is made partial by a missing key
  ---
  duration_ms: 0.056791
  type: 'test'
  ...
# Subtest: 7g — no new settlement outcome value was added, and nothing writes the synthetic code
ok 3190 - 7g — no new settlement outcome value was added, and nothing writes the synthetic code
  ---
  duration_ms: 0.353584
  type: 'test'
  ...
# Subtest: matchRoomCategory prefers the longest alias and falls back
ok 3191 - matchRoomCategory prefers the longest alias and falls back
  ---
  duration_ms: 1.050791
  type: 'test'
  ...
# Subtest: excessBedDays = LOS − benchmark, floored at 0
ok 3192 - excessBedDays = LOS − benchmark, floored at 0
  ---
  duration_ms: 0.086458
  type: 'test'
  ...
# Subtest: computeBedDayCost: 8-day single room over-stay = 7 × 6500 = 45,500 (est.)
ok 3193 - computeBedDayCost: 8-day single room over-stay = 7 × 6500 = 45,500 (est.)
  ---
  duration_ms: 10.365084
  type: 'test'
  ...
# Subtest: computeBedDayCost returns 0 when not flagged, day-care, or single-day
ok 3194 - computeBedDayCost returns 0 when not flagged, day-care, or single-day
  ---
  duration_ms: 0.075708
  type: 'test'
  ...
# Subtest: tariff-status table drops the (est.) label
ok 3195 - tariff-status table drops the (est.) label
  ---
  duration_ms: 0.149875
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the routes still declare the numbers this guard reads
ok 3196 - the routes still declare the numbers this guard reads
  ---
  duration_ms: 1.831042
  type: 'test'
  ...
# Subtest: the body extractor is not vacuous — it finds real code, not an empty default param
ok 3197 - the body extractor is not vacuous — it finds real code, not an empty default param
  ---
  duration_ms: 1.488792
  type: 'test'
  ...
# Subtest: IPD_ANALYZE_LEGS equals the analyze call sites in lib/doc-audit.ts — a FOURTH leg fails here
ok 3198 - IPD_ANALYZE_LEGS equals the analyze call sites in lib/doc-audit.ts — a FOURTH leg fails here
  ---
  duration_ms: 0.589
  type: 'test'
  ...
# Subtest: OPD_AUDIT_LEGS equals the EXECUTABLE legs in auditOpdNote — a third fails here
ok 3199 - OPD_AUDIT_LEGS equals the EXECUTABLE legs in auditOpdNote — a third fails here
  ---
  duration_ms: 2.166083
  type: 'test'
  ...
# Subtest: THE IPD WORKER FITS ITS BOX, for every provider that can serve it
ok 3200 - THE IPD WORKER FITS ITS BOX, for every provider that can serve it
  ---
  duration_ms: 0.617083
  type: 'test'
  ...
# Subtest: ipd-audit-now fits the same box on the same basis (DEC-B5)
ok 3201 - ipd-audit-now fits the same box on the same basis (DEC-B5)
  ---
  duration_ms: 0.132
  type: 'test'
  ...
# Subtest: THE OPD WORKER FITS ITS BOX, for every provider that can serve it
ok 3202 - THE OPD WORKER FITS ITS BOX, for every provider that can serve it
  ---
  duration_ms: 22.151
  type: 'test'
  ...
# Subtest: the OPD call site sends a per-attempt ceiling that matches its budget (DEC-B9)
ok 3203 - the OPD call site sends a per-attempt ceiling that matches its budget (DEC-B9)
  ---
  duration_ms: 1.5155
  type: 'test'
  ...
# Subtest: raising max, lowering the box, or adding a retry FAILS the guard
ok 3204 - raising max, lowering the box, or adding a retry FAILS the guard
  ---
  duration_ms: 0.355166
  type: 'test'
  ...
# Subtest: a null budget means REFUSE, never substitute a default
ok 3205 - a null budget means REFUSE, never substitute a default
  ---
  duration_ms: 0.669542
  type: 'test'
  ...
# Subtest: the IPD cron interval clears the IPD box — and this is NOT extended to OPD
ok 3206 - the IPD cron interval clears the IPD box — and this is NOT extended to OPD
  ---
  duration_ms: 0.23725
  type: 'test'
  ...
# Subtest: OPENROUTER_TIMEOUT_MS and OPENROUTER_MAX_TRIES still read 110,000 and 3
ok 3207 - OPENROUTER_TIMEOUT_MS and OPENROUTER_MAX_TRIES still read 110,000 and 3
  ---
  duration_ms: 0.049375
  type: 'test'
  ...
# Subtest: check mode → Runs + Interventions + CW_Flags + Citations, normalized by run_id
ok 3208 - check mode → Runs + Interventions + CW_Flags + Citations, normalized by run_id
  ---
  duration_ms: 3.219166
  type: 'test'
  ...
# Subtest: pathway mode → PathwayStages merges skeleton+enrichment by id, ordered
ok 3209 - pathway mode → PathwayStages merges skeleton+enrichment by id, ordered
  ---
  duration_ms: 0.378417
  type: 'test'
  ...
# Subtest: audit mode → findings/completeness/diff/suggestions/idealised/extracted/citations
ok 3210 - audit mode → findings/completeness/diff/suggestions/idealised/extracted/citations
  ---
  duration_ms: 1.939959
  type: 'test'
  ...
# Subtest: mergeRunSheets stacks rows across runs by sheet name
ok 3211 - mergeRunSheets stacks rows across runs by sheet name
  ---
  duration_ms: 0.435542
  type: 'test'
  ...
# Subtest: THE INVARIANT: all-Standard weighting reproduces legacy completeness EXACTLY
ok 3212 - THE INVARIANT: all-Standard weighting reproduces legacy completeness EXACTLY
  ---
  duration_ms: 1.375791
  type: 'test'
  ...
# Subtest: THE INVARIANT holds for the null vector too (PRD §8.1 fallback = legacy behaviour)
ok 3213 - THE INVARIANT holds for the null vector too (PRD §8.1 fallback = legacy behaviour)
  ---
  duration_ms: 0.150459
  type: 'test'
  ...
# Subtest: THE INVARIANT holds at all-Minor as well (PRD §8.4: mathematically identical to all-Standard)
ok 3214 - THE INVARIANT holds at all-Minor as well (PRD §8.4: mathematically identical to all-Standard)
  ---
  duration_ms: 0.202
  type: 'test'
  ...
# Subtest: the fixture set actually exercises the hard cases (guards against a vacuous invariant)
ok 3215 - the fixture set actually exercises the hard cases (guards against a vacuous invariant)
  ---
  duration_ms: 0.176875
  type: 'test'
  ...
# Subtest: the na-policy divergence is REAL and this build takes the legacy branch (flagged deviation)
ok 3216 - the na-policy divergence is REAL and this build takes the legacy branch (flagged deviation)
  ---
  duration_ms: 0.12375
  type: 'test'
  ...
# Subtest: a CONDITIONAL na leaves both sides under BOTH policies (mandatoryTotal 20 vs 21, PRD §2.9)
ok 3217 - a CONDITIONAL na leaves both sides under BOTH policies (mandatoryTotal 20 vs 21, PRD §2.9)
  ---
  duration_ms: 0.085208
  type: 'test'
  ...
# Subtest: tier points are exactly Critical 8 · Important 4 · Standard 2 · Minor 1, and none is zero
ok 3218 - tier points are exactly Critical 8 · Important 4 · Standard 2 · Minor 1, and none is zero
  ---
  duration_ms: 0.095208
  type: 'test'
  ...
# Subtest: normalised weights sum to 100.0 ± 0.05 for every combination (PRD §10)
ok 3219 - normalised weights sum to 100.0 ± 0.05 for every combination (PRD §10)
  ---
  duration_ms: 0.580125
  type: 'test'
  ...
# Subtest: weighting actually MOVES the score when tiers differ (the change is not a no-op)
ok 3220 - weighting actually MOVES the score when tiers differ (the change is not a no-op)
  ---
  duration_ms: 0.246083
  type: 'test'
  ...
# Subtest: partial is exactly 0.5, and na is not partial
ok 3221 - partial is exactly 0.5, and na is not partial
  ---
  duration_ms: 0.325583
  type: 'test'
  ...
# Subtest: all-na document returns 100 without dividing by zero (PRD §8.5)
ok 3222 - all-na document returns 100 without dividing by zero (PRD §8.5)
  ---
  duration_ms: 0.074291
  type: 'test'
  ...
# Subtest: unknown key defaults to Standard; empty/garbage vector falls back to equal weights (PRD §8.2)
ok 3223 - unknown key defaults to Standard; empty/garbage vector falls back to equal weights (PRD §8.2)
  ---
  duration_ms: 0.060667
  type: 'test'
  ...
# Subtest: malformed input never throws and never produces a wrong-looking score
ok 3224 - malformed input never throws and never produces a wrong-looking score
  ---
  duration_ms: 0.11125
  type: 'test'
  ...
# Subtest: rounding is half-up, applied via legacy's DOUBLE round
ok 3225 - rounding is half-up, applied via legacy's DOUBLE round
  ---
  duration_ms: 0.059792
  type: 'test'
  ...
# Subtest: missingMandatory lists applicable missing fields by label (the unweighted gap count)
ok 3226 - missingMandatory lists applicable missing fields by label (the unweighted gap count)
  ---
  duration_ms: 0.037666
  type: 'test'
  ...
# Subtest: legacyCompleteness (the independent path) agrees with the null-vector weighted path
ok 3227 - legacyCompleteness (the independent path) agrees with the null-vector weighted path
  ---
  duration_ms: 0.23875
  type: 'test'
  ...
# Subtest: the re-stated domain weights match the closed cores VERBATIM (drift guard)
ok 3228 - the re-stated domain weights match the closed cores VERBATIM (drift guard)
  ---
  duration_ms: 0.195708
  type: 'test'
  ...
# Subtest: OPD index reproduces the core formula on a worked case
ok 3229 - OPD index reproduces the core formula on a worked case
  ---
  duration_ms: 0.087625
  type: 'test'
  ...
# Subtest: PDQI-9 absent ⇒ note_quality drops and the divisor is 0.75 (PRD §2.6)
ok 3230 - PDQI-9 absent ⇒ note_quality drops and the divisor is 0.75 (PRD §2.6)
  ---
  duration_ms: 0.047375
  type: 'test'
  ...
# Subtest: Care-Value Index reproduces the six-domain formula
ok 3231 - Care-Value Index reproduces the six-domain formula
  ---
  duration_ms: 0.053375
  type: 'test'
  ...
# Subtest: substituting a new documentation score moves the index and can re-band
ok 3232 - substituting a new documentation score moves the index and can re-band
  ---
  duration_ms: 0.051834
  type: 'test'
  ...
# Subtest: band boundaries at 39/40, 54/55, 69/70, 84/85
ok 3233 - band boundaries at 39/40, 54/55, 69/70, 84/85
  ---
  duration_ms: 0.046875
  type: 'test'
  ...
# Subtest: no domain scores at all ⇒ index 0, not NaN
ok 3234 - no domain scores at all ⇒ index 0, not NaN
  ---
  duration_ms: 0.034667
  type: 'test'
  ...
# Subtest: the weights-version label is exact (PRD §2.8, §8.3)
ok 3235 - the weights-version label is exact (PRD §2.8, §8.3)
  ---
  duration_ms: 0.047791
  type: 'test'
  ...
# Subtest: preview: an unchanged candidate moves nothing
ok 3236 - preview: an unchanged candidate moves nothing
  ---
  duration_ms: 0.386125
  type: 'test'
  ...
# Subtest: preview: making a widely-missing field Critical moves the mean and reports movers
ok 3237 - preview: making a widely-missing field Critical moves the mean and reports movers
  ---
  duration_ms: 11.730666
  type: 'test'
  ...
# Subtest: preview: empty cohort yields zeroed stats, no throw (the OPD empty state)
ok 3238 - preview: empty cohort yields zeroed stats, no throw (the OPD empty state)
  ---
  duration_ms: 0.289709
  type: 'test'
  ...
# Subtest: preview: SD is population SD and a single row has SD 0
ok 3239 - preview: SD is population SD and a single row has SD 0
  ---
  duration_ms: 0.184709
  type: 'test'
  ...
# Subtest: missingPrevalence excludes `na` from the base, and reports a percentage
ok 3240 - missingPrevalence excludes `na` from the base, and reports a percentage
  ---
  duration_ms: 0.388125
  type: 'test'
  ...
# Subtest: systemic-defect warning fires only above 50% missing AND only at Critical; it never blocks
ok 3241 - systemic-defect warning fires only above 50% missing AND only at Critical; it never blocks
  ---
  duration_ms: 0.397292
  type: 'test'
  ...
# Subtest: the systemic-defect copy is verbatim per PRD §5.3
ok 3242 - the systemic-defect copy is verbatim per PRD §5.3
  ---
  duration_ms: 0.157667
  type: 'test'
  ...
# Subtest: scoreRow routes IPD and OPD to different index formulas
ok 3243 - scoreRow routes IPD and OPD to different index formulas
  ---
  duration_ms: 0.318042
  type: 'test'
  ...
# Subtest: the 21 discharge_summary fields match data/nabh-rubric.json EXACTLY (key, label, section)
ok 3244 - the 21 discharge_summary fields match data/nabh-rubric.json EXACTLY (key, label, section)
  ---
  duration_ms: 0.7335
  type: 'test'
  ...
# Subtest: cause_of_death is the ONE conditional key, read from the rubric
ok 3245 - cause_of_death is the ONE conditional key, read from the rubric
  ---
  duration_ms: 0.288292
  type: 'test'
  ...
# Subtest: the OPD label→key mapping covers every live-observed label (companion spec §4.7)
ok 3246 - the OPD label→key mapping covers every live-observed label (companion spec §4.7)
  ---
  duration_ms: 0.404917
  type: 'test'
  ...
# Subtest: the OPD engine's ACTUAL emitted keys are all in the catalogue (no orphan can appear)
ok 3247 - the OPD engine's ACTUAL emitted keys are all in the catalogue (no orphan can appear)
  ---
  duration_ms: 0.895542
  type: 'test'
  ...
# Subtest: the OPD structured emission is ADDITIVE: status/section added, present/mandatory preserved
ok 3248 - the OPD structured emission is ADDITIVE: status/section added, present/mandatory preserved
  ---
  duration_ms: 47.047875
  type: 'test'
  ...
# Subtest: the OPD engine emits the structured shape from BOTH completeness paths (GP and obstetric)
ok 3249 - the OPD engine emits the structured shape from BOTH completeness paths (GP and obstetric)
  ---
  duration_ms: 0.591042
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: A.1 THE FALLBACK RULE: a NULL completeness_items row keeps its stored scores, untouched
ok 3250 - A.1 THE FALLBACK RULE: a NULL completeness_items row keeps its stored scores, untouched
  ---
  duration_ms: 685.394041
  type: 'test'
  ...
# Subtest: A.1 a missing array is never read as 100 NOR as 0 — both directions
ok 3251 - A.1 a missing array is never read as 100 NOR as 0 — both directions
  ---
  duration_ms: 62.260333
  type: 'test'
  ...
# Subtest: A.1 a row WITH items is weighted, and weights_not_applicable flips to false
ok 3252 - A.1 a row WITH items is weighted, and weights_not_applicable flips to false
  ---
  duration_ms: 6.770792
  type: 'test'
  ...
# Subtest: A.1 continuity items are EXCLUDED from the OPD denominator (reproduces the engine's coverage)
ok 3253 - A.1 continuity items are EXCLUDED from the OPD denominator (reproduces the engine's coverage)
  ---
  duration_ms: 3.075
  type: 'test'
  ...
# Subtest: A.1 applyOpdScoringPolicy never throws and handles an empty batch
ok 3254 - A.1 applyOpdScoringPolicy never throws and handles an empty batch
  ---
  duration_ms: 10.058916
  type: 'test'
  ...
# Subtest: A.1 parseOpdCompletenessItems drops malformed entries rather than throwing
ok 3255 - A.1 parseOpdCompletenessItems drops malformed entries rather than throwing
  ---
  duration_ms: 3.13125
  type: 'test'
  ...
# Subtest: A.1 the OPD write path persists the array, guarded by a column probe
ok 3256 - A.1 the OPD write path persists the array, guarded by a column probe
  ---
  duration_ms: 0.800792
  type: 'test'
  ...
# Subtest: A.1 the migration runner exists, is admin-guarded, and every statement is idempotent
ok 3257 - A.1 the migration runner exists, is admin-guarded, and every statement is idempotent
  ---
  duration_ms: 0.573333
  type: 'test'
  ...
# Subtest: A.1 the runner's inlined DDL matches the two .sql files it stands in for
ok 3258 - A.1 the runner's inlined DDL matches the two .sql files it stands in for
  ---
  duration_ms: 0.860083
  type: 'test'
  ...
# Subtest: A.1 no backfill: nothing in the build writes completeness_items to historical rows
ok 3259 - A.1 no backfill: nothing in the build writes completeness_items to historical rows
  ---
  duration_ms: 0.199042
  type: 'test'
  ...
# Subtest: the three continuity fields are EXCLUDED from the OPD weight vector (kickoff normative list)
ok 3260 - the three continuity fields are EXCLUDED from the OPD weight vector (kickoff normative list)
  ---
  duration_ms: 0.072583
  type: 'test'
  ...
# Subtest: the near-duplicate pairs are kept SEPARATE and flagged, not merged
ok 3261 - the near-duplicate pairs are kept SEPARATE and flagged, not merged
  ---
  duration_ms: 0.076125
  type: 'test'
  ...
# Subtest: labelToOpdKey: dynamic obstetric labels match by prefix; unknown returns null (never guesses)
ok 3262 - labelToOpdKey: dynamic obstetric labels match by prefix; unknown returns null (never guesses)
  ---
  duration_ms: 0.229917
  type: 'test'
  ...
# Subtest: every catalogued OPD label round-trips through the mapping
ok 3263 - every catalogued OPD label round-trips through the mapping
  ---
  duration_ms: 0.055875
  type: 'test'
  ...
# Subtest: fieldsFor / weightedKeysFor route by note type and never return an empty key space
ok 3264 - fieldsFor / weightedKeysFor route by note type and never return an empty key space
  ---
  duration_ms: 0.035208
  type: 'test'
  ...
# Subtest: diffVectors reports only real changes, with old → new tiers
ok 3265 - diffVectors reports only real changes, with old → new tiers
  ---
  duration_ms: 0.1875
  type: 'test'
  ...
# Subtest: vectorsEqual treats absent as Standard (so a seeded v1 equals an empty draft)
ok 3266 - vectorsEqual treats absent as Standard (so a seeded v1 equals an empty draft)
  ---
  duration_ms: 0.052292
  type: 'test'
  ...
# Subtest: validateVector rejects non-objects but coerces unknown tiers rather than failing
ok 3267 - validateVector rejects non-objects but coerces unknown tiers rather than failing
  ---
  duration_ms: 0.114834
  type: 'test'
  ...
# Subtest: canonicalVectorJson is stable regardless of key insertion order
ok 3268 - canonicalVectorJson is stable regardless of key insertion order
  ---
  duration_ms: 0.057
  type: 'test'
  ...
# Subtest: bySection groups and preserves first-seen order
ok 3269 - bySection groups and preserves first-seen order
  ---
  duration_ms: 0.090708
  type: 'test'
  ...
# Subtest: computeSignalHealth: FP rate, latest-per-doctor, top reasons, healable
ok 3270 - computeSignalHealth: FP rate, latest-per-doctor, top reasons, healable
  ---
  duration_ms: 0.6455
  type: 'test'
  ...
# Subtest: computeSignalHealth: ranks noisiest (audit_bug × rate) first
ok 3271 - computeSignalHealth: ranks noisiest (audit_bug × rate) first
  ---
  duration_ms: 0.170334
  type: 'test'
  ...
# Subtest: findingMatchesSuppression: type/scope/discriminator/active gates
ok 3272 - findingMatchesSuppression: type/scope/discriminator/active gates
  ---
  duration_ms: 0.10625
  type: 'test'
  ...
# Subtest: applySuppressions: drop removes, downgrade sets informational, no active = no-op
ok 3273 - applySuppressions: drop removes, downgrade sets informational, no active = no-op
  ---
  duration_ms: 0.182375
  type: 'test'
  ...
# Subtest: previewCollateral: dual-label invariant — refuses to remove a validated signal
ok 3274 - previewCollateral: dual-label invariant — refuses to remove a validated signal
  ---
  duration_ms: 0.099208
  type: 'test'
  ...
# Subtest: every ratified tier-2 kind maps to tier 2, not unlisted
ok 3275 - every ratified tier-2 kind maps to tier 2, not unlisted
  ---
  duration_ms: 2.421959
  type: 'test'
  ...
# Subtest: every ratified tier-3 kind maps to tier 3 — log only
ok 3276 - every ratified tier-3 kind maps to tier 3 — log only
  ---
  duration_ms: 0.313583
  type: 'test'
  ...
# Subtest: banned_fdc is ratified TIER 2 (not higher) and pregnancy_risk_verify is ratified TIER 3
ok 3277 - banned_fdc is ratified TIER 2 (not higher) and pregnancy_risk_verify is ratified TIER 3
  ---
  duration_ms: 0.182667
  type: 'test'
  ...
# Subtest: O1c: a model-invented kind lands in tier 2 and is flagged unlisted
ok 3278 - O1c: a model-invented kind lands in tier 2 and is flagged unlisted
  ---
  duration_ms: 0.153792
  type: 'test'
  ...
# Subtest: praise: *_high_value kinds and any high-value verdict (antibiotic_stewardship praise) are excluded and counted
ok 3279 - praise: *_high_value kinds and any high-value verdict (antibiotic_stewardship praise) are excluded and counted
  ---
  duration_ms: 0.12975
  type: 'test'
  ...
# Subtest: antibiotic_stewardship VIOLATION (low-value — antibiotic for a viral URTI) is tier 2
ok 3280 - antibiotic_stewardship VIOLATION (low-value — antibiotic for a viral URTI) is tier 2
  ---
  duration_ms: 0.11
  type: 'test'
  ...
# Subtest: incomplete_dosing: missing strength / duration alone → tier 3 (ratified rows: findings 20, 24, 37, 41 + chronic continuation)
ok 3281 - incomplete_dosing: missing strength / duration alone → tier 3 (ratified rows: findings 20, 24, 37, 41 + chronic continuation)
  ---
  duration_ms: 0.90925
  type: 'test'
  ...
# Subtest: incomplete_dosing: a missing frequency or route changes what the patient does → tier 2; unparseable → tier 2
ok 3282 - incomplete_dosing: a missing frequency or route changes what the patient does → tier 2; unparseable → tier 2
  ---
  duration_ms: 0.196167
  type: 'test'
  ...
# Subtest: E-1 (finding 36): a time-critical cardiac pattern in the finding text promotes to tier 1 — from any kind
ok 3283 - E-1 (finding 36): a time-critical cardiac pattern in the finding text promotes to tier 1 — from any kind
  ---
  duration_ms: 0.466333
  type: 'test'
  ...
# Subtest: E-2 (finding 49): persistent swelling ≥ 4 weeks with no follow-through promotes; with follow-through it does not
ok 3284 - E-2 (finding 49): persistent swelling ≥ 4 weeks with no follow-through promotes; with follow-through it does not
  ---
  duration_ms: 3.412042
  type: 'test'
  ...
# Subtest: praise never escalates: a high-value finding praising an appropriate ACS referral stays praise
ok 3285 - praise never escalates: a high-value finding praising an appropriate ACS referral stays praise
  ---
  duration_ms: 0.185833
  type: 'test'
  ...
# Subtest: bucketByTier: buckets are disjoint, complete, and count unlisted kinds
ok 3286 - bucketByTier: buckets are disjoint, complete, and count unlisted kinds
  ---
  duration_ms: 0.218083
  type: 'test'
  ...
# Subtest: dedupeTwins: same (finding_ref, doctor_uid, day) collapses with an occurrence count; different notes same day still collapse; different days do not
ok 3287 - dedupeTwins: same (finding_ref, doctor_uid, day) collapses with an occurrence count; different notes same day still collapse; different days do not
  ---
  duration_ms: 7.4115
  type: 'test'
  ...
# Subtest: dedupeTwins: unkeyable rows (no ref / no doctor / no date) never merge
ok 3288 - dedupeTwins: unkeyable rows (no ref / no doctor / no date) never merge
  ---
  duration_ms: 3.40875
  type: 'test'
  ...
# Subtest: allows SELECT / WITH and auto-adds LIMIT
ok 3289 - allows SELECT / WITH and auto-adds LIMIT
  ---
  duration_ms: 1.091625
  type: 'test'
  ...
# Subtest: rejects writes, DDL, multiple statements, non-SELECT, over-cap LIMIT, system fns
ok 3290 - rejects writes, DDL, multiple statements, non-SELECT, over-cap LIMIT, system fns
  ---
  duration_ms: 0.9325
  type: 'test'
  ...
# Subtest: blocks PHI-bearing relations anywhere in the query
ok 3291 - blocks PHI-bearing relations anywhere in the query
  ---
  duration_ms: 0.349292
  type: 'test'
  ...
# Subtest: honors a smaller caller cap
ok 3292 - honors a smaller caller cap
  ---
  duration_ms: 0.17
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: coverage floor (PRD §4): ≥5 dose-ceiling, ≥3 SOS, ≥3 banned-FDC, ≥4 interaction, ≥4 incomplete-dosing positives; exactly 6 negatives
ok 3293 - coverage floor (PRD §4): ≥5 dose-ceiling, ≥3 SOS, ≥3 banned-FDC, ≥4 interaction, ≥4 incomplete-dosing positives; exactly 6 negatives
  ---
  duration_ms: 0.648375
  type: 'test'
  ...
# Subtest: fixtures carry no PHI, no db13 uid, and banned-FDC fixtures use placeholder molecules only
ok 3294 - fixtures carry no PHI, no db13 uid, and banned-FDC fixtures use placeholder molecules only
  ---
  duration_ms: 0.209666
  type: 'test'
  ...
# Subtest: positive POS-DOSE-1 fires dose_ceiling_exceeded — paracetamol stacked across two products: 650 QID + 500 TDS = 4100 mg/day > 4000
ok 3295 - positive POS-DOSE-1 fires dose_ceiling_exceeded — paracetamol stacked across two products: 650 QID + 500 TDS = 4100 mg/day > 4000
  ---
  duration_ms: 0.048833
  type: 'test'
  ...
# Subtest: positive POS-DOSE-2 fires dose_ceiling_exceeded — ibuprofen 800 QID = 3200 mg/day > 2400 (single product)
ok 3296 - positive POS-DOSE-2 fires dose_ceiling_exceeded — ibuprofen 800 QID = 3200 mg/day > 2400 (single product)
  ---
  duration_ms: 0.033667
  type: 'test'
  ...
# Subtest: positive POS-DOSE-3 fires dose_ceiling_exceeded — diclofenac 75 TDS = 225 mg/day > 150
ok 3297 - positive POS-DOSE-3 fires dose_ceiling_exceeded — diclofenac 75 TDS = 225 mg/day > 150
  ---
  duration_ms: 0.035667
  type: 'test'
  ...
# Subtest: positive POS-DOSE-4 fires dose_ceiling_exceeded — etoricoxib 120 OD with NO documented gout > the 90 mg/day default ceiling (Decision 6)
ok 3298 - positive POS-DOSE-4 fires dose_ceiling_exceeded — etoricoxib 120 OD with NO documented gout > the 90 mg/day default ceiling (Decision 6)
  ---
  duration_ms: 0.028166
  type: 'test'
  ...
# Subtest: positive POS-DOSE-5 fires dose_ceiling_exceeded — mefenamic acid 500 QID = 2000 mg/day > 1500
ok 3299 - positive POS-DOSE-5 fires dose_ceiling_exceeded — mefenamic acid 500 QID = 2000 mg/day > 1500
  ---
  duration_ms: 0.08475
  type: 'test'
  ...
# Subtest: positive POS-SOS-1 fires dose_ceiling_sos — paracetamol 1000 TDS scheduled + 650 SOS uncapped (default cap 3) → 4950 potential > 4000
ok 3300 - positive POS-SOS-1 fires dose_ceiling_sos — paracetamol 1000 TDS scheduled + 650 SOS uncapped (default cap 3) → 4950 potential > 4000
  ---
  duration_ms: 0.031459
  type: 'test'
  ...
# Subtest: positive POS-SOS-2 fires dose_ceiling_sos — etoricoxib 90 SOS with an EXPLICIT max 2/day → 180 potential > 90
ok 3301 - positive POS-SOS-2 fires dose_ceiling_sos — etoricoxib 90 SOS with an EXPLICIT max 2/day → 180 potential > 90
  ---
  duration_ms: 0.177958
  type: 'test'
  ...
# Subtest: positive POS-SOS-3 fires dose_ceiling_sos — ibuprofen 600 grid 1-0-1 + 600 SOS uncapped → 3000 potential > 2400
ok 3302 - positive POS-SOS-3 fires dose_ceiling_sos — ibuprofen 600 grid 1-0-1 + 600 SOS uncapped → 3000 potential > 2400
  ---
  duration_ms: 0.280625
  type: 'test'
  ...
# Subtest: positive POS-FDC-1 fires banned_fdc — exact two-molecule banned set (placeholders mol-a + mol-b)
ok 3303 - positive POS-FDC-1 fires banned_fdc — exact two-molecule banned set (placeholders mol-a + mol-b)
  ---
  duration_ms: 0.036208
  type: 'test'
  ...
# Subtest: positive POS-FDC-2 fires banned_fdc — exact three-molecule banned set (placeholders mol-c/mol-d/mol-e)
ok 3304 - positive POS-FDC-2 fires banned_fdc — exact three-molecule banned set (placeholders mol-c/mol-d/mol-e)
  ---
  duration_ms: 0.031458
  type: 'test'
  ...
# Subtest: positive POS-FDC-3 fires banned_fdc — order-swapped banned pair (mol-b + mol-a) still matches the stored set
ok 3305 - positive POS-FDC-3 fires banned_fdc — order-swapped banned pair (mol-b + mol-a) still matches the stored set
  ---
  duration_ms: 0.023583
  type: 'test'
  ...
# Subtest: positive POS-DDI-1 fires drug_interaction — warfarin + ibuprofen — anticoagulant + NSAID (major)
ok 3306 - positive POS-DDI-1 fires drug_interaction — warfarin + ibuprofen — anticoagulant + NSAID (major)
  ---
  duration_ms: 0.022417
  type: 'test'
  ...
# Subtest: positive POS-DDI-2 fires drug_interaction — atorvastatin + clarithromycin — statin + macrolide (major)
ok 3307 - positive POS-DDI-2 fires drug_interaction — atorvastatin + clarithromycin — statin + macrolide (major)
  ---
  duration_ms: 0.022417
  type: 'test'
  ...
# Subtest: positive POS-DDI-3 fires drug_interaction — sertraline + tramadol — two serotonergic drugs (major)
ok 3308 - positive POS-DDI-3 fires drug_interaction — sertraline + tramadol — two serotonergic drugs (major)
  ---
  duration_ms: 0.023542
  type: 'test'
  ...
# Subtest: positive POS-DDI-4 fires drug_interaction — telmisartan + spironolactone — ACE-I/ARB + potassium-sparing diuretic (major)
ok 3309 - positive POS-DDI-4 fires drug_interaction — telmisartan + spironolactone — ACE-I/ARB + potassium-sparing diuretic (major)
  ---
  duration_ms: 0.023459
  type: 'test'
  ...
# Subtest: positive POS-DOSING-1 fires incomplete_dosing — dose/strength blanked (no dose field, no strength, none in the name)
ok 3310 - positive POS-DOSING-1 fires incomplete_dosing — dose/strength blanked (no dose field, no strength, none in the name)
  ---
  duration_ms: 0.022583
  type: 'test'
  ...
# Subtest: positive POS-DOSING-2 fires incomplete_dosing — frequency blanked
ok 3311 - positive POS-DOSING-2 fires incomplete_dosing — frequency blanked
  ---
  duration_ms: 0.020666
  type: 'test'
  ...
# Subtest: positive POS-DOSING-3 fires incomplete_dosing — duration blanked
ok 3312 - positive POS-DOSING-3 fires incomplete_dosing — duration blanked
  ---
  duration_ms: 0.02375
  type: 'test'
  ...
# Subtest: positive POS-DOSING-4 fires incomplete_dosing — route blanked and not inferable (no dosage-form word anywhere on the line)
ok 3313 - positive POS-DOSING-4 fires incomplete_dosing — route blanked and not inferable (no dosage-form word anywhere on the line)
  ---
  duration_ms: 0.022125
  type: 'test'
  ...
# Subtest: negative NEG-1 stays silent — ibuprofen 800 TDS = exactly 2400 mg/day — AT the ceiling, not over it
ok 3314 - negative NEG-1 stays silent — ibuprofen 800 TDS = exactly 2400 mg/day — AT the ceiling, not over it
  ---
  duration_ms: 0.035791
  type: 'test'
  ...
# Subtest: negative NEG-2 stays silent — etoricoxib 120 OD WITH a documented gout diagnosis — the conditional 120 ceiling applies
ok 3315 - negative NEG-2 stays silent — etoricoxib 120 OD WITH a documented gout diagnosis — the conditional 120 ceiling applies
  ---
  duration_ms: 0.021916
  type: 'test'
  ...
# Subtest: negative NEG-3 stays silent — amoxicillin + paracetamol — just OUTSIDE every interaction pair (no shared mechanism tag)
ok 3316 - negative NEG-3 stays silent — amoxicillin + paracetamol — just OUTSIDE every interaction pair (no shared mechanism tag)
  ---
  duration_ms: 0.02625
  type: 'test'
  ...
# Subtest: negative NEG-4 stays silent — a COMPLETE prescription — dose, frequency, duration and route all present
ok 3317 - negative NEG-4 stays silent — a COMPLETE prescription — dose, frequency, duration and route all present
  ---
  duration_ms: 0.021583
  type: 'test'
  ...
# Subtest: negative NEG-5 stays silent — banned core + one extra molecule (mol-a + mol-b + mol-z) — the C5 superset boundary
ok 3318 - negative NEG-5 stays silent — banned core + one extra molecule (mol-a + mol-b + mol-z) — the C5 superset boundary
  ---
  duration_ms: 0.022333
  type: 'test'
  ...
# Subtest: negative NEG-6 stays silent — paracetamol 500 SOS max 3/day = 1500 mg potential — well inside the 4000 ceiling
ok 3319 - negative NEG-6 stays silent — paracetamol 500 SOS max 3/day = 1500 mg potential — well inside the 4000 ceiling
  ---
  duration_ms: 0.021916
  type: 'test'
  ...
# Subtest: recall_det = fired / planted, over the deterministic leg only (no LLM recall claim — PRD §6)
ok 3320 - recall_det = fired / planted, over the deterministic leg only (no LLM recall claim — PRD §6)
  ---
  duration_ms: 0.938584
  type: 'test'
  ...
# Subtest: 57 case 1 — production Vercel build with no key at all: MISSING
ok 3321 - 57 case 1 — production Vercel build with no key at all: MISSING
  ---
  duration_ms: 0.531958
  type: 'test'
  ...
# Subtest: 57 case 2 — production Vercel build with an unusable key (empty or whitespace): MISSING
ok 3322 - 57 case 2 — production Vercel build with an unusable key (empty or whitespace): MISSING
  ---
  duration_ms: 0.21175
  type: 'test'
  ...
# Subtest: 57 case 3 — production Vercel build with a usable key: NOT missing
ok 3323 - 57 case 3 — production Vercel build with a usable key: NOT missing
  ---
  duration_ms: 0.130292
  type: 'test'
  ...
# Subtest: 57 case 4 — a Vercel build that is not production: NOT missing, at any key value
ok 3324 - 57 case 4 — a Vercel build that is not production: NOT missing, at any key value
  ---
  duration_ms: 0.290834
  type: 'test'
  ...
# Subtest: 57 case 5 — not a Vercel build, even when the environment says production: NOT missing
ok 3325 - 57 case 5 — not a Vercel build, even when the environment says production: NOT missing
  ---
  duration_ms: 0.150167
  type: 'test'
  ...
# Subtest: 57 EXECUTED — importing the config in production with no key throws, and names the variable
ok 3326 - 57 EXECUTED — importing the config in production with no key throws, and names the variable
  ---
  duration_ms: 62.269209
  type: 'test'
  ...
# Subtest: 57 EXECUTED — a production import WITH a key succeeds
ok 3327 - 57 EXECUTED — a production import WITH a key succeeds
  ---
  duration_ms: 44.934292
  type: 'test'
  ...
# Subtest: 57 EXECUTED — a non-production import with no key succeeds
ok 3328 - 57 EXECUTED — a non-production import with no key succeeds
  ---
  duration_ms: 38.999042
  type: 'test'
  ...
# Subtest: 57 whole file — it parses, and holds EXACTLY three top-level statements in order
ok 3329 - 57 whole file — it parses, and holds EXACTLY three top-level statements in order
  ---
  duration_ms: 8.403
  type: 'test'
  ...
# Subtest: 57 whole file — the declaration and the export are exactly what they must be
ok 3330 - 57 whole file — the declaration and the export are exactly what they must be
  ---
  duration_ms: 0.40925
  type: 'test'
  ...
# Subtest: 57 whole file — nothing executable outside the guard
ok 3331 - 57 whole file — nothing executable outside the guard
  ---
  duration_ms: 0.144542
  type: 'test'
  ...
# Subtest: 57 pin — each copy is exactly D8's three clauses, and there is no fourth of any kind
ok 3332 - 57 pin — each copy is exactly D8's three clauses, and there is no fourth of any kind
  ---
  duration_ms: 0.379625
  type: 'test'
  ...
# Subtest: 57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition
ok 3333 - 57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition
  ---
  duration_ms: 0.167917
  type: 'test'
  ...
# Subtest: 57 pin — the guard THROWS one Error, and the message a reader sees names the variable
ok 3334 - 57 pin — the guard THROWS one Error, and the message a reader sees names the variable
  ---
  duration_ms: 0.134833
  type: 'test'
  ...
# Subtest: no surface outside the allow-list SELECTs from the telemetry tables
ok 3335 - no surface outside the allow-list SELECTs from the telemetry tables
  ---
  duration_ms: 164.880917
  type: 'test'
  ...
# Subtest: the scan can actually fail — it is not passing because the matcher never matches
ok 3336 - the scan can actually fail — it is not passing because the matcher never matches
  ---
  duration_ms: 0.131959
  type: 'test'
  ...
# Subtest: the allow-list is by EXACT path, and every entry is one this build owns
ok 3337 - the allow-list is by EXACT path, and every entry is one this build owns
  ---
  duration_ms: 0.177542
  type: 'test'
  ...
# Subtest: no clinician-facing or patient-facing route names a telemetry table at all
ok 3338 - no clinician-facing or patient-facing route names a telemetry table at all
  ---
  duration_ms: 43.218708
  type: 'test'
  ...
# Subtest: GUARD 1 — admin: a set ADMIN_TOKEN with nothing presented is refused, and isAdminUnlocked is NOT consulted
ok 3339 - GUARD 1 — admin: a set ADMIN_TOKEN with nothing presented is refused, and isAdminUnlocked is NOT consulted
  ---
  duration_ms: 326.871625
  type: 'test'
  ...
# Subtest: GUARD 3 — preview: VERCEL_ENV=production is refused even with everything else correct
ok 3340 - GUARD 3 — preview: VERCEL_ENV=production is refused even with everything else correct
  ---
  duration_ms: 260.935333
  type: 'test'
  ...
# Subtest: GUARD 3 — preview: VERCEL_ENV=preview on a DIFFERENT branch is refused
ok 3341 - GUARD 3 — preview: VERCEL_ENV=preview on a DIFFERENT branch is refused
  ---
  duration_ms: 290.451208
  type: 'test'
  ...
# Subtest: GUARD 4 — arming: an unset CDMSS_OVERHEAD_MEASURE is refused
ok 3342 - GUARD 4 — arming: an unset CDMSS_OVERHEAD_MEASURE is refused
  ---
  duration_ms: 282.529417
  type: 'test'
  ...
# Subtest: GUARD 5 — THE ONE THAT MATTERS: a production endpoint id is refused
ok 3343 - GUARD 5 — THE ONE THAT MATTERS: a production endpoint id is refused
  ---
  duration_ms: 198.015208
  type: 'test'
  ...
# Subtest: GUARD 5 — an UNSET expectation refuses, it does not pass
ok 3344 - GUARD 5 — an UNSET expectation refuses, it does not pass
  ---
  duration_ms: 163.4795
  type: 'test'
  ...
# Subtest: GUARD 5 — an unparseable DATABASE_URL refuses
ok 3345 - GUARD 5 — an unparseable DATABASE_URL refuses
  ---
  duration_ms: 161.739417
  type: 'test'
  ...
# Subtest: GUARD 5 — a password containing @ cannot shift the parsed host
ok 3346 - GUARD 5 — a password containing @ cannot shift the parsed host
  ---
  duration_ms: 165.472417
  type: 'test'
  ...
# Subtest: GUARD 2 — expiry: past the hard UTC date every request is 410
ok 3347 - GUARD 2 — expiry: past the hard UTC date every request is 410
  ---
  duration_ms: 165.699916
  type: 'test'
  ...
# Subtest: GUARD 2 — before the expiry the route still runs
ok 3348 - GUARD 2 — before the expiry the route still runs
  ---
  duration_ms: 173.067209
  type: 'test'
  ...
# Subtest: ALL FIVE PASS — the route runs, writes route=script, and reports the first sample separately
ok 3349 - ALL FIVE PASS — the route runs, writes route=script, and reports the first sample separately
  ---
  duration_ms: 183.160833
  type: 'test'
  ...
# Subtest: FIX 2 + FIX 1 — a REAL 500, driven by an unparseable URL that still satisfies guard 5
ok 3350 - FIX 2 + FIX 1 — a REAL 500, driven by an unparseable URL that still satisfies guard 5
  ---
  duration_ms: 168.817
  type: 'test'
  ...
# Subtest: v5 FIX 1 — two of the three leaking shapes are refused BEFORE the driver ever sees them
ok 3351 - v5 FIX 1 — two of the three leaking shapes are refused BEFORE the driver ever sees them
  ---
  duration_ms: 317.096584
  type: 'test'
  ...
# Subtest: FIX 3 — a query parameter cannot move the parsed host away from the one the driver uses
ok 3352 - FIX 3 — a query parameter cannot move the parsed host away from the one the driver uses
  ---
  duration_ms: 161.548125
  type: 'test'
  ...
# Subtest: FIX 4 — the denylist refuses production even when the expected value also names it
ok 3353 - FIX 4 — the denylist refuses production even when the expected value also names it
  ---
  duration_ms: 155.13925
  type: 'test'
  ...
# Subtest: FIX 4 — an ABSENT denylist refuses: a denylist that is not there is not a denylist
ok 3354 - FIX 4 — an ABSENT denylist refuses: a denylist that is not there is not a denylist
  ---
  duration_ms: 157.843125
  type: 'test'
  ...
# Subtest: FIX 5 — p95 and p99 are withheld below their floors, never a maximum in disguise
ok 3355 - FIX 5 — p95 and p99 are withheld below their floors, never a maximum in disguise
  ---
  duration_ms: 318.156
  type: 'test'
  ...
# Subtest: FIX 5 — and p95 IS emitted once its floor is met, so the floor is not a blanket refusal
ok 3356 - FIX 5 — and p95 IS emitted once its floor is met, so the floor is not a blanket refusal
  ---
  duration_ms: 152.571292
  type: 'test'
  ...
# Subtest: FIX 6 — the invocation insert has its own cell
ok 3357 - FIX 6 — the invocation insert has its own cell
  ---
  duration_ms: 299.291542
  type: 'test'
  ...
# Subtest: FIX 7 — the shape is true per cell, and conc is gone
ok 3358 - FIX 7 — the shape is true per cell, and conc is gone
  ---
  duration_ms: 298.831333
  type: 'test'
  ...
# Subtest: FIX 8 — the real-audit arm refuses rather than silently becoming the null arm
ok 3359 - FIX 8 — the real-audit arm refuses rather than silently becoming the null arm
  ---
  duration_ms: 444.949208
  type: 'test'
  ...
# Subtest: v6 FIX 1 — the branch POOLED host passes against the bare expected id
ok 3360 - v6 FIX 1 — the branch POOLED host passes against the bare expected id
  ---
  duration_ms: 148.489958
  type: 'test'
  ...
# Subtest: v6 FIX 1 — the branch DIRECT host passes against the bare expected id
ok 3361 - v6 FIX 1 — the branch DIRECT host passes against the bare expected id
  ---
  duration_ms: 149.038459
  type: 'test'
  ...
# Subtest: v6 FIX 1 — the branch POOLED host passes against a POOLED expected id
ok 3362 - v6 FIX 1 — the branch POOLED host passes against a POOLED expected id
  ---
  duration_ms: 149.247958
  type: 'test'
  ...
# Subtest: v6 FIX 2 — production on its POOLED host refuses forbidden_endpoint, NOT endpoint_mismatch
ok 3363 - v6 FIX 2 — production on its POOLED host refuses forbidden_endpoint, NOT endpoint_mismatch
  ---
  duration_ms: 146.731083
  type: 'test'
  ...
# Subtest: v6 FIX 2 — production on its DIRECT host also refuses forbidden_endpoint
ok 3364 - v6 FIX 2 — production on its DIRECT host also refuses forbidden_endpoint
  ---
  duration_ms: 142.602583
  type: 'test'
  ...
# Subtest: v6 — `pooler` in the MIDDLE of a label is part of the id and is never truncated
ok 3365 - v6 — `pooler` in the MIDDLE of a label is part of the id and is never truncated
  ---
  duration_ms: 290.336959
  type: 'test'
  ...
# Subtest: v6 — a doubled `-pooler-pooler` strips exactly ONE, and that is the stated rule
ok 3366 - v6 — a doubled `-pooler-pooler` strips exactly ONE, and that is the stated rule
  ---
  duration_ms: 436.341459
  type: 'test'
  ...
# Subtest: v6 — normalisation cannot make two DIFFERENT endpoints compare equal
ok 3367 - v6 — normalisation cannot make two DIFFERENT endpoints compare equal
  ---
  duration_ms: 572.543958
  type: 'test'
  ...
# Subtest: NO OUTPUT ANYWHERE CARRIES A DATABASE_URL SUBSTRING — every response shape, stdout and stderr
ok 3368 - NO OUTPUT ANYWHERE CARRIES A DATABASE_URL SUBSTRING — every response shape, stdout and stderr
  ---
  duration_ms: 1631.237292
  type: 'test'
  ...
# Subtest: the route is POST-only, and carries its own expiry and deletion notice in source
ok 3369 - the route is POST-only, and carries its own expiry and deletion notice in source
  ---
  duration_ms: 0.194625
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: DEFAULT-OFF: unset ⇒ no cap (the shipped path is uncapped and must stay so)
ok 3370 - DEFAULT-OFF: unset ⇒ no cap (the shipped path is uncapped and must stay so)
  ---
  duration_ms: 0.446334
  type: 'test'
  ...
# Subtest: DEFAULT-OFF: 0, negative, junk and empty all mean "no cap", never a cap of 0
ok 3371 - DEFAULT-OFF: 0, negative, junk and empty all mean "no cap", never a cap of 0
  ---
  duration_ms: 0.098166
  type: 'test'
  ...
# Subtest: a set budget is honored, floored to an integer (the arms: 1647 / 823 / 128)
ok 3372 - a set budget is honored, floored to an integer (the arms: 1647 / 823 / 128)
  ---
  duration_ms: 0.120666
  type: 'test'
  ...
# Subtest: the cap rides the SL0-verified wire format (top-level google.thinking_config)
ok 3373 - the cap rides the SL0-verified wire format (top-level google.thinking_config)
  ---
  duration_ms: 0.370333
  type: 'test'
  ...
# Subtest: the cap is Gemini-only and cannot leak onto the Ollama fallback path
ok 3374 - the cap is Gemini-only and cannot leak onto the Ollama fallback path
  ---
  duration_ms: 0.17625
  type: 'test'
  ...
# Subtest: gen_params records the budget ONLY when capped — an uncapped trace is unchanged
ok 3375 - gen_params records the budget ONLY when capped — an uncapped trace is unchanged
  ---
  duration_ms: 0.131083
  type: 'test'
  ...
# Subtest: note-audit row → ClinicalFinding: verbatim vocab in the audit ext, valid core
ok 3376 - note-audit row → ClinicalFinding: verbatim vocab in the audit ext, valid core
  ---
  duration_ms: 1.628291
  type: 'test'
  ...
# Subtest: LOSSLESS: note-audit row round-trips byte-for-byte, incl. unmapped engine fields
ok 3377 - LOSSLESS: note-audit row round-trips byte-for-byte, incl. unmapped engine fields
  ---
  duration_ms: 0.455834
  type: 'test'
  ...
# Subtest: note-audit round-trip preserves absence: a minimal row gains no keys
ok 3378 - note-audit round-trip preserves absence: a minimal row gains no keys
  ---
  duration_ms: 0.118208
  type: 'test'
  ...
# Subtest: deterministic-source row maps to extractionMethod deterministic
ok 3379 - deterministic-source row maps to extractionMethod deterministic
  ---
  duration_ms: 0.0505
  type: 'test'
  ...
# Subtest: doc-audit AuditFinding → ClinicalFinding: verdict rides in ext.netValue (verbatim, separate slot)
ok 3380 - doc-audit AuditFinding → ClinicalFinding: verdict rides in ext.netValue (verbatim, separate slot)
  ---
  duration_ms: 0.399167
  type: 'test'
  ...
# Subtest: LOSSLESS: doc-audit AuditFinding round-trips byte-for-byte
ok 3381 - LOSSLESS: doc-audit AuditFinding round-trips byte-for-byte
  ---
  duration_ms: 0.14425
  type: 'test'
  ...
# Subtest: ExtractedCase → ClinicalState: clinical content in the core, metadata in surfaceExtras
ok 3382 - ExtractedCase → ClinicalState: clinical content in the core, metadata in surfaceExtras
  ---
  duration_ms: 0.610292
  type: 'test'
  ...
# Subtest: LOSSLESS: ExtractedCase round-trips byte-for-byte (full PX discharge shape)
ok 3383 - LOSSLESS: ExtractedCase round-trips byte-for-byte (full PX discharge shape)
  ---
  duration_ms: 0.13725
  type: 'test'
  ...
# Subtest: LOSSLESS: a sparse pre-PX ExtractedCase (no riskFactors/aftercare/completeness) round-trips
ok 3384 - LOSSLESS: a sparse pre-PX ExtractedCase (no riskFactors/aftercare/completeness) round-trips
  ---
  duration_ms: 0.269417
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the traceless route stays traceless — no trace id reaches the rerank transport
ok 3385 - the traceless route stays traceless — no trace id reaches the rerank transport
  ---
  duration_ms: 5.647583
  type: 'test'
  ...
# Subtest: nothing in the change touches the outbound request object
ok 3386 - nothing in the change touches the outbound request object
  ---
  duration_ms: 0.341959
  type: 'test'
  ...
# Subtest: attachment is non-enumerable, so a serialized request or response is byte-identical
ok 3387 - attachment is non-enumerable, so a serialized request or response is byte-identical
  ---
  duration_ms: 0.454375
  type: 'test'
  ...
# Subtest: attachment returns the SAME object — it allocates nothing the caller could miss
ok 3388 - attachment returns the SAME object — it allocates nothing the caller could miss
  ---
  duration_ms: 0.055959
  type: 'test'
  ...
# Subtest: the ladder, its order and its terminal dispositions are untouched
ok 3389 - the ladder, its order and its terminal dispositions are untouched
  ---
  duration_ms: 0.236708
  type: 'test'
  ...
# Subtest: retry policy is unchanged — capture rides the existing callback and adds no try budget
ok 3390 - retry policy is unchanged — capture rides the existing callback and adds no try budget
  ---
  duration_ms: 0.410791
  type: 'test'
  ...
# Subtest: every one of the four return sites carries evidence — no silent unattributed path
ok 3391 - every one of the four return sites carries evidence — no silent unattributed path
  ---
  duration_ms: 0.289292
  type: 'test'
  ...
# Subtest: the local substitution reports the LOCAL model, never the requested cloud model (§6.2)
ok 3392 - the local substitution reports the LOCAL model, never the requested cloud model (§6.2)
  ---
  duration_ms: 0.227167
  type: 'test'
  ...
# Subtest: every name still resolves at its original path, so no existing importer moves
ok 3393 - every name still resolves at its original path, so no existing importer moves
  ---
  duration_ms: 0.379791
  type: 'test'
  ...
# Subtest: the attempts field is OPTIONAL, so tracedChat attributions stay valid unchanged
ok 3394 - the attempts field is OPTIONAL, so tracedChat attributions stay valid unchanged
  ---
  duration_ms: 0.488791
  type: 'test'
  ...
# Subtest: a hostile completion cannot break the transport
ok 3395 - a hostile completion cannot break the transport
  ---
  duration_ms: 0.119958
  type: 'test'
  ...
# Subtest: a 429 is distinguishable from every other failure class
ok 3396 - a 429 is distinguishable from every other failure class
  ---
  duration_ms: 0.052584
  type: 'test'
  ...
# Subtest: both tiers classify through the same function — a 429 cannot be tier-dependent
ok 3397 - both tiers classify through the same function — a 429 cannot be tier-dependent
  ---
  duration_ms: 0.192834
  type: 'test'
  ...
# Subtest: the attempt sequence is invocation-scoped, never module state (§4.1)
ok 3398 - the attempt sequence is invocation-scoped, never module state (§4.1)
  ---
  duration_ms: 0.242125
  type: 'test'
  ...
# Subtest: the evidence carries identifiers and enums only — no prompt, passage or query text
ok 3399 - the evidence carries identifiers and enums only — no prompt, passage or query text
  ---
  duration_ms: 0.26725
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: a total transport failure records no served provider, and says so explicitly
ok 3400 - a total transport failure records no served provider, and says so explicitly
  ---
  duration_ms: 0.586833
  type: 'test'
  ...
# Subtest: a null attempt list means NOT COLLECTED, and is distinguishable from an empty one
ok 3401 - a null attempt list means NOT COLLECTED, and is distinguishable from an empty one
  ---
  duration_ms: 0.323625
  type: 'test'
  ...
# Subtest: every terminal phase is a stable NAME — never a message, never an interpolated value
ok 3402 - every terminal phase is a stable NAME — never a message, never an interpolated value
  ---
  duration_ms: 0.60625
  type: 'test'
  ...
# Subtest: the intended-local path records ONE attempt rather than an empty list
ok 3403 - the intended-local path records ONE attempt rather than an empty list
  ---
  duration_ms: 0.220291
  type: 'test'
  ...
# Subtest: both local arms record their attempt — the by-design one and the substitution
ok 3404 - both local arms record their attempt — the by-design one and the substitution
  ---
  duration_ms: 0.216709
  type: 'test'
  ...
# Subtest: the local success attempt is well-formed, and is at most one per invocation
ok 3405 - the local success attempt is well-formed, and is at most one per invocation
  ---
  duration_ms: 0.244625
  type: 'test'
  ...
# Subtest: classifyLocalAttempt reads what the SDK declared, and guesses nothing
ok 3406 - classifyLocalAttempt reads what the SDK declared, and guesses nothing
  ---
  duration_ms: 0.247333
  type: 'test'
  ...
# Subtest: the 429 rule has exactly one home — classifyLocalAttempt delegates, never duplicates
ok 3407 - the 429 rule has exactly one home — classifyLocalAttempt delegates, never duplicates
  ---
  duration_ms: 0.272208
  type: 'test'
  ...
# Subtest: the two terminal throws are BYTE-IDENTICAL to before this build
ok 3408 - the two terminal throws are BYTE-IDENTICAL to before this build
  ---
  duration_ms: 0.365417
  type: 'test'
  ...
# Subtest: the phase selector cannot drift from the throws it describes
ok 3409 - the phase selector cannot drift from the throws it describes
  ---
  duration_ms: 0.511833
  type: 'test'
  ...
# Subtest: the failure attach is a statement, not a control-flow change
ok 3410 - the failure attach is a statement, not a control-flow change
  ---
  duration_ms: 0.2665
  type: 'test'
  ...
# Subtest: nothing in the failure path touches the outbound request object
ok 3411 - nothing in the failure path touches the outbound request object
  ---
  duration_ms: 0.244417
  type: 'test'
  ...
# Subtest: the local calls are wrapped, and the SDK call expression itself is unchanged
ok 3412 - the local calls are wrapped, and the SDK call expression itself is unchanged
  ---
  duration_ms: 0.204166
  type: 'test'
  ...
# Subtest: failure evidence is a SEPARATE property, invisible to every success-attribution reader
ok 3413 - failure evidence is a SEPARATE property, invisible to every success-attribution reader
  ---
  duration_ms: 0.091875
  type: 'test'
  ...
# Subtest: the low-value-care judge reader is untouched — it reads two fields of the success shape
ok 3414 - the low-value-care judge reader is untouched — it reads two fields of the success shape
  ---
  duration_ms: 0.232917
  type: 'test'
  ...
# Subtest: tracedChat is not touched — D14 is scoped to the traceless arm
ok 3415 - tracedChat is not touched — D14 is scoped to the traceless arm
  ---
  duration_ms: 0.303583
  type: 'test'
  ...
# Subtest: every new name also resolves through lib/trace.ts, so no importer has to know the core path
ok 3416 - every new name also resolves through lib/trace.ts, so no importer has to know the core path
  ---
  duration_ms: 0.051042
  type: 'test'
  ...
# Subtest: failure evidence is IMMUTABLE — a later frame cannot rewrite what failed
ok 3417 - failure evidence is IMMUTABLE — a later frame cannot rewrite what failed
  ---
  duration_ms: 0.091041
  type: 'test'
  ...
# Subtest: a hostile or exotic error cannot break the transport
ok 3418 - a hostile or exotic error cannot break the transport
  ---
  duration_ms: 0.120959
  type: 'test'
  ...
# Subtest: failure evidence carries enums and counts only — no message, no body, no identifier
ok 3419 - failure evidence carries enums and counts only — no message, no body, no identifier
  ---
  duration_ms: 0.092208
  type: 'test'
  ...
# Subtest: the attempt shape admits the local provider, and nothing else new
ok 3420 - the attempt shape admits the local provider, and nothing else new
  ---
  duration_ms: 0.236
  type: 'test'
  ...
# Subtest: a finish_reason defect is NOT retryable; an empty 200 still is
ok 3421 - a finish_reason defect is NOT retryable; an empty 200 still is
  ---
  duration_ms: 0.623
  type: 'test'
  ...
# Subtest: THE 54 SECONDS: a truncating call is attempted ONCE, not three times
ok 3422 - THE 54 SECONDS: a truncating call is attempted ONCE, not three times
  ---
  duration_ms: 0.470209
  type: 'test'
  ...
# Subtest: …and the empty-200 retry budget is spent in full, exactly as before
ok 3423 - …and the empty-200 retry budget is spent in full, exactly as before
  ---
  duration_ms: 0.323584
  type: 'test'
  ...
# Subtest: the terminal error still names the truncation, so the sizing bug is readable
ok 3424 - the terminal error still names the truncation, so the sizing bug is readable
  ---
  duration_ms: 0.122334
  type: 'test'
  ...
# Subtest: transport failures are untouched by this rule — only BODY verdicts changed
ok 3425 - transport failures are untouched by this rule — only BODY verdicts changed
  ---
  duration_ms: 0.4025
  type: 'test'
  ...
# Subtest: the mini-sized cap is raised to a FLOOR on the bedrock path
ok 3426 - the mini-sized cap is raised to a FLOOR on the bedrock path
  ---
  duration_ms: 0.155583
  type: 'test'
  ...
# Subtest: ⚠️ BYTE-IDENTITY: the floor is the BEDROCK transport’s, and reaches no other provider
ok 3427 - ⚠️ BYTE-IDENTITY: the floor is the BEDROCK transport’s, and reaches no other provider
  ---
  duration_ms: 0.784667
  type: 'test'
  ...
# Subtest: a critique that never completed is recorded as UNAUDITED, not as clean
ok 3428 - a critique that never completed is recorded as UNAUDITED, not as clean
  ---
  duration_ms: 1.252333
  type: 'test'
  ...
# Subtest: the probe reducers carry critic_ran, so a lab row can tell the two apart
ok 3429 - the probe reducers carry critic_ran, so a lab row can tell the two apart
  ---
  duration_ms: 1.170583
  type: 'test'
  ...
# Subtest: unknown_finding + missing_critical + instability_input derive from a ClinicalState
ok 3430 - unknown_finding + missing_critical + instability_input derive from a ClinicalState
  ---
  duration_ms: 8.287375
  type: 'test'
  ...
# Subtest: med_contradiction derives from an open medication conflict (member stateRef)
ok 3431 - med_contradiction derives from an open medication conflict (member stateRef)
  ---
  duration_ms: 0.28575
  type: 'test'
  ...
# Subtest: med_contradiction: conflict on an episode HIGH-ALERT med is safety-critical
ok 3432 - med_contradiction: conflict on an episode HIGH-ALERT med is safety-critical
  ---
  duration_ms: 0.601
  type: 'test'
  ...
# Subtest: med_contradiction also derives from reconciled status stopped/not_taking/unknown without a conflict row
ok 3433 - med_contradiction also derives from reconciled status stopped/not_taking/unknown without a conflict row
  ---
  duration_ms: 0.543375
  type: 'test'
  ...
# Subtest: new_medication (B5): derives ONLY for meds absent from a NON-EMPTY snapshot med list
ok 3434 - new_medication (B5): derives ONLY for meds absent from a NON-EMPTY snapshot med list
  ---
  duration_ms: 0.411208
  type: 'test'
  ...
# Subtest: new_medication (B5): a high-alert episode med is skipped (it wins rank 0 anyway)
ok 3435 - new_medication (B5): a high-alert episode med is skipped (it wins rank 0 anyway)
  ---
  duration_ms: 0.091375
  type: 'test'
  ...
# Subtest: care_gap derives from a stale mapped-range abnormal (detail verbatim, severity mapped)
ok 3436 - care_gap derives from a stale mapped-range abnormal (detail verbatim, severity mapped)
  ---
  duration_ms: 0.381708
  type: 'test'
  ...
# Subtest: followup_open derives from advice keywords; suppressed when a committed follow-up matches
ok 3437 - followup_open derives from advice keywords; suppressed when a committed follow-up matches
  ---
  duration_ms: 0.311167
  type: 'test'
  ...
# Subtest: allergy_unconfirmed only when the note allergy field is blank
ok 3438 - allergy_unconfirmed only when the note allergy field is blank
  ---
  duration_ms: 0.223625
  type: 'test'
  ...
# Subtest: snapshot absent ⇒ member-derived kinds simply absent (episode-only degradation, D14)
ok 3439 - snapshot absent ⇒ member-derived kinds simply absent (episode-only degradation, D14)
  ---
  duration_ms: 0.326334
  type: 'test'
  ...
# Subtest: determinism: identical inputs ⇒ deep-equal output (double run)
ok 3440 - determinism: identical inputs ⇒ deep-equal output (double run)
  ---
  duration_ms: 0.165041
  type: 'test'
  ...
# Subtest: every UnknownItem carries ≥1 sourceRef and a stateRef
ok 3441 - every UnknownItem carries ≥1 sourceRef and a stateRef
  ---
  duration_ms: 0.109292
  type: 'test'
  ...
# Subtest: stable ordering: safety before review before info, then kind, then subject
ok 3442 - stable ordering: safety before review before info, then kind, then subject
  ---
  duration_ms: 0.184041
  type: 'test'
  ...
# Subtest: bandFor thresholds
ok 3443 - bandFor thresholds
  ---
  duration_ms: 0.466375
  type: 'test'
  ...
# Subtest: findingPenalty scales with verdict severity and confidence
ok 3444 - findingPenalty scales with verdict severity and confidence
  ---
  duration_ms: 4.484625
  type: 'test'
  ...
# Subtest: a clean, complete episode scores high (band A)
ok 3445 - a clean, complete episode scores high (band A)
  ---
  duration_ms: 0.359
  type: 'test'
  ...
# Subtest: domains route by tag; cost driven by low-value tariff spend; untagged → appropriateness
ok 3446 - domains route by tag; cost driven by low-value tariff spend; untagged → appropriateness
  ---
  duration_ms: 11.982167
  type: 'test'
  ...
# Subtest: estimated bed-day cost dents the cost domain even with no tariffed spend
ok 3447 - estimated bed-day cost dents the cost domain even with no tariffed spend
  ---
  duration_ms: 0.2905
  type: 'test'
  ...
# Subtest: weights are configurable and normalised
ok 3448 - weights are configurable and normalised
  ---
  duration_ms: 0.097708
  type: 'test'
  ...
# [provider-fallback] gemini gemini-2.5-pro failed → openrouter: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"openrouter","intended_model":"gemini-2.5-pro","fallback_model":null,"region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# Subtest: cloudLadder: Vertex first, OpenRouter second — and GEMINI_VIA_OPENROUTER=1 inverts it
ok 3449 - cloudLadder: Vertex first, OpenRouter second — and GEMINI_VIA_OPENROUTER=1 inverts it
  ---
  duration_ms: 115.723417
  type: 'test'
  ...
# Subtest: cloudLadder: a second tier exists ONLY with a leg budget, and only when it can serve
ok 3450 - cloudLadder: a second tier exists ONLY with a leg budget, and only when it can serve
  ---
  duration_ms: 0.1935
  type: 'test'
  ...
# Subtest: the tier-2 slug derivation is the same google/ prefixing, flag or no flag
ok 3451 - the tier-2 slug derivation is the same google/ prefixing, flag or no flag
  ---
  duration_ms: 0.078375
  type: 'test'
  ...
# Subtest: the flag itself is NOT touched by this unit — one code read, no default, no write
ok 3452 - the flag itself is NOT touched by this unit — one code read, no default, no write
  ---
  duration_ms: 0.274792
  type: 'test'
  ...
# Subtest: tierCeilingMs: tier 1 gets the full budget, tier 2 the remainder, a spent leg gets 0
ok 3453 - tierCeilingMs: tier 1 gets the full budget, tier 2 the remainder, a spent leg gets 0
  ---
  duration_ms: 0.091709
  type: 'test'
  ...
# Subtest: a leg never exceeds its budget across both tiers — the naive sum would blow the box
ok 3454 - a leg never exceeds its budget across both tiers — the naive sum would blow the box
  ---
  duration_ms: 0.048792
  type: 'test'
  ...
# Subtest: ladderSkipError names the skipped tier and carries the earlier failure, capped
ok 3455 - ladderSkipError names the skipped tier and carries the earlier failure, capped
  ---
  duration_ms: 0.146084
  type: 'test'
  ...
# Subtest: both transports run the SAME ladder mechanics — no second budget idiom
ok 3456 - both transports run the SAME ladder mechanics — no second budget idiom
  ---
  duration_ms: 0.178292
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# [provider-fallback] gemini gemini-2.5-pro failed → ollama: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"ollama","intended_model":"gemini-2.5-pro","fallback_model":"qwen2.5:14b","region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# [provider-fallback] gemini gemini-2.5-pro failed → openrouter: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"openrouter","intended_model":"gemini-2.5-pro","fallback_model":null,"region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/1 http 500 — giving up: 500 "boom"
# [provider-fallback] openrouter google/gemini-2.5-pro failed → none: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"none","intended_model":"google/gemini-2.5-pro","fallback_model":null,"region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":500,"error_status":null,"error_code":null,"message":"500 \\"boom\\"","details":null}
# [provider-fallback] gemini gemini-2.5-pro failed → openrouter: {"provider":"gemini","label":"chatWithFallback","feature":null,"fellBackTo":"openrouter","intended_model":"gemini-2.5-pro","fallback_model":null,"region":"asia-south1","sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"gemini":1},"http_status":null,"error_status":null,"error_code":null,"message":"GCP_SA_KEY is not valid JSON (or base64 JSON)","details":null}
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/1 http 500 — giving up: 500 "boom"
# [provider-fallback] openrouter google/gemini-2.5-pro failed → ollama: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"ollama","intended_model":"google/gemini-2.5-pro","fallback_model":"qwen2.5:14b","region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":500,"error_status":null,"error_code":null,"message":"500 \\"boom\\"","details":null}
# Subtest: F1: Vertex tier fails → the OpenRouter tier serves the SAME leg (the hop is real)
ok 3457 - F1: Vertex tier fails → the OpenRouter tier serves the SAME leg (the hop is real)
  ---
  duration_ms: 45.740792
  type: 'test'
  ...
# Subtest: F2: with NO leg budget there is NO second tier — the utility path is byte-identical
ok 3458 - F2: with NO leg budget there is NO second tier — the utility path is byte-identical
  ---
  duration_ms: 12.915959
  type: 'test'
  ...
# Subtest: F3: noLocalFallback=true → both tiers failing THROWS; Ollama is not called
ok 3459 - F3: noLocalFallback=true → both tiers failing THROWS; Ollama is not called
  ---
  duration_ms: 5.756875
  type: 'test'
  ...
# Subtest: F4: noLocalFallback absent → both tiers failing still falls back to Ollama (today's behaviour)
ok 3460 - F4: noLocalFallback absent → both tiers failing still falls back to Ollama (today's behaviour)
  ---
  duration_ms: 9.775958
  type: 'test'
  ...
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/3 http 500 — retrying: 500 "boom"
# [provider-retry] openrouter google/gemini-2.5-pro attempt 2/3 http 500 — retrying: 500 "boom"
# [provider-retry] openrouter google/gemini-2.5-pro attempt 3/3 http 500 — giving up: 500 "boom"
# [provider-fallback] openrouter google/gemini-2.5-pro failed → ollama: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"ollama","intended_model":"google/gemini-2.5-pro","fallback_model":"qwen2.5:14b","region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":500,"error_status":null,"error_code":null,"message":"500 \\"boom\\"","details":null}
# Subtest: F5: GEMINI_VIA_OPENROUTER=1 makes OpenRouter tier 1 — the inversion is live, not just typed
ok 3461 - F5: GEMINI_VIA_OPENROUTER=1 makes OpenRouter tier 1 — the inversion is live, not just typed
  ---
  duration_ms: 1687.946958
  type: 'test'
  ...
# [provider-retry] openrouter google/gemini-2.5-pro attempt 1/1 timeout — giving up: Request was aborted.
# [provider-fallback] openrouter google/gemini-2.5-pro failed → gemini: {"provider":"openrouter","label":"chatWithFallback","feature":null,"fellBackTo":"gemini","intended_model":"google/gemini-2.5-pro","fallback_model":null,"region":null,"sa_identity":null,"inFlightAtError":1,"in_flight_by_provider":{"openrouter":1},"http_status":null,"error_status":null,"error_code":null,"message":"openrouter TIMEOUT after 300ms (attempt 1/1)","details":null}
# Subtest: F6: a tier that burns the whole leg budget SKIPS the next tier by name
ok 3462 - F6: a tier that burns the whole leg budget SKIPS the next tier by name
  ---
  duration_ms: 302.241792
  type: 'test'
  ...
# Subtest: the OPD audit call site sets it — and the mini path passes FALSE
ok 3463 - the OPD audit call site sets it — and the mini path passes FALSE
  ---
  duration_ms: 0.344542
  type: 'test'
  ...
# Subtest: the IPD analyze closure sets it via analyzeNoLocalFallback — one flag, all six legs
ok 3464 - the IPD analyze closure sets it via analyzeNoLocalFallback — one flag, all six legs
  ---
  duration_ms: 0.200458
  type: 'test'
  ...
# Subtest: verifyCitation — the cite gate — does NOT get the flag, and keeps its soft-fail
ok 3465 - verifyCitation — the cite gate — does NOT get the flag, and keeps its soft-fail
  ---
  duration_ms: 0.052208
  type: 'test'
  ...
# Subtest: no third call site: the flag appears in doc-audit only on the analyze closure plumbing
ok 3466 - no third call site: the flag appears in doc-audit only on the analyze closure plumbing
  ---
  duration_ms: 0.1565
  type: 'test'
  ...
# Subtest: the throw reaches auditOpdNote's outer catch, which marks the row — nothing changed there
ok 3467 - the throw reaches auditOpdNote's outer catch, which marks the row — nothing changed there
  ---
  duration_ms: 0.260958
  type: 'test'
  ...
# Subtest: the DDL is additive + idempotent and matches the kickoff exactly
ok 3468 - the DDL is additive + idempotent and matches the kickoff exactly
  ---
  duration_ms: 0.075666
  type: 'test'
  ...
# Subtest: the writer is best-effort and truncates at 2000 — a ledger failure never fails an audit
ok 3469 - the writer is best-effort and truncates at 2000 — a ledger failure never fails an audit
  ---
  duration_ms: 4.170625
  type: 'test'
  ...
# Subtest: runIpdAudit writes the ledger at every no-row outcome, and the write precedes each return
ok 3470 - runIpdAudit writes the ledger at every no-row outcome, and the write precedes each return
  ---
  duration_ms: 0.108042
  type: 'test'
  ...
# Subtest: the ledger did NOT touch the machinery the kickoff fences off
ok 3471 - the ledger did NOT touch the machinery the kickoff fences off
  ---
  duration_ms: 0.042709
  type: 'test'
  ...
# Subtest: audit_query can read the ledger WITHOUT lib/sql-guard-core.ts changing
ok 3472 - audit_query can read the ledger WITHOUT lib/sql-guard-core.ts changing
  ---
  duration_ms: 0.629042
  type: 'test'
  ...
# Subtest: provider reaches the terminal error, the marked error, and every failure report
ok 3473 - provider reaches the terminal error, the marked error, and every failure report
  ---
  duration_ms: 9.604958
  type: 'test'
  ...
# Subtest: the marked empty-200 error names the provider that produced it
ok 3474 - the marked empty-200 error names the provider that produced it
  ---
  duration_ms: 0.735416
  type: 'test'
  ...
# Subtest: DEFAULT provider is openrouter — every pre-Unit-V call site is byte-identical
ok 3475 - DEFAULT provider is openrouter — every pre-Unit-V call site is byte-identical
  ---
  duration_ms: 6.909333
  type: 'test'
  ...
# Subtest: a caller classifier REPLACES the OpenAI-shaped default
ok 3476 - a caller classifier REPLACES the OpenAI-shaped default
  ---
  duration_ms: 0.717417
  type: 'test'
  ...
# Subtest: classify: () => null opts out of body judgement entirely
ok 3477 - classify: () => null opts out of body judgement entirely
  ---
  duration_ms: 0.231083
  type: 'test'
  ...
# Subtest: the default IS classifyProviderResponse — no call site loses validation by omission
ok 3478 - the default IS classifyProviderResponse — no call site loses validation by omission
  ---
  duration_ms: 0.253708
  type: 'test'
  ...
# Subtest: defaultTimeoutMs / defaultMaxTries apply when the CALLER passes nothing
ok 3479 - defaultTimeoutMs / defaultMaxTries apply when the CALLER passes nothing
  ---
  duration_ms: 0.819125
  type: 'test'
  ...
# Subtest: the CALLER still wins over the per-call default
ok 3480 - the CALLER still wins over the per-call default
  ---
  duration_ms: 0.286875
  type: 'test'
  ...
# Subtest: a junk DEFAULT degrades to the module constant — it can never disable a bound
ok 3481 - a junk DEFAULT degrades to the module constant — it can never disable a bound
  ---
  duration_ms: 1.682708
  type: 'test'
  ...
# Subtest: all four re-exported symbols still resolve at their current values
ok 3482 - all four re-exported symbols still resolve at their current values
  ---
  duration_ms: 1.278834
  type: 'test'
  ...
# Subtest: openrouterCreateWithRetry is still exported and still a pure pass-through
ok 3483 - openrouterCreateWithRetry is still exported and still a pure pass-through
  ---
  duration_ms: 0.296042
  type: 'test'
  ...
# Subtest: there are exactly FOUR provider call sites — a fifth must be enumerated here
ok 3484 - there are exactly FOUR provider call sites — a fifth must be enumerated here
  ---
  duration_ms: 1.266542
  type: 'test'
  ...
# Subtest: EVERY provider call site forwards the caller timeout AND maxTries
ok 3485 - EVERY provider call site forwards the caller timeout AND maxTries
  ---
  duration_ms: 1.094708
  type: 'test'
  ...
# Subtest: the Vertex chat branch is wrapped in BOTH files, and identifies itself as vertex
ok 3486 - the Vertex chat branch is wrapped in BOTH files, and identifies itself as vertex
  ---
  duration_ms: 0.290875
  type: 'test'
  ...
# Subtest: THE REGION AND SERVICE IDENTITY SURVIVE — they are the Vertex path's whole advantage
ok 3487 - THE REGION AND SERVICE IDENTITY SURVIVE — they are the Vertex path's whole advantage
  ---
  duration_ms: 0.182167
  type: 'test'
  ...
# Subtest: the self-heal lives INSIDE the attempt closure — healing must not spend the budget
ok 3488 - the self-heal lives INSIDE the attempt closure — healing must not spend the budget
  ---
  duration_ms: 0.179167
  type: 'test'
  ...
# Subtest: the provider-call accounting still pairs
ok 3489 - the provider-call accounting still pairs
  ---
  duration_ms: 0.168625
  type: 'test'
  ...
# Subtest: the Vertex doc_read fetch finally has a signal — its absence is why Record audit HUNG
ok 3490 - the Vertex doc_read fetch finally has a signal — its absence is why Record audit HUNG
  ---
  duration_ms: 0.158167
  type: 'test'
  ...
# Subtest: doc_read failures are STRUCTURED and name region + identity, and still return null
ok 3491 - doc_read failures are STRUCTURED and name region + identity, and still return null
  ---
  duration_ms: 0.1595
  type: 'test'
  ...
# Subtest: ⚠️ doc_read has NO RETRY in this unit, and that is ARITHMETIC — not caution
ok 3492 - ⚠️ doc_read has NO RETRY in this unit, and that is ARITHMETIC — not caution
  ---
  duration_ms: 1.167375
  type: 'test'
  ...
# Subtest: the Ollama fallback is still PRESENT and still CALLED in both files
ok 3493 - the Ollama fallback is still PRESENT and still CALLED in both files
  ---
  duration_ms: 0.121292
  type: 'test'
  ...
# Subtest: no PROVIDER_BUDGETS value moved in this unit
ok 3494 - no PROVIDER_BUDGETS value moved in this unit
  ---
  duration_ms: 0.131708
  type: 'test'
  ...
# Subtest: the floor holds: a window reaching before the vitals source is CLAMPED, and says so
ok 3495 - the floor holds: a window reaching before the vitals source is CLAMPED, and says so
  ---
  duration_ms: 4.313833
  type: 'test'
  ...
# Subtest: an unclamped window is exactly WINDOW_DAYS long and is not flagged
ok 3496 - an unclamped window is exactly WINDOW_DAYS long and is not flagged
  ---
  duration_ms: 0.112625
  type: 'test'
  ...
# Subtest: the boundary day itself: a window starting exactly on the source is not clamped
ok 3497 - the boundary day itself: a window starting exactly on the source is not clamped
  ---
  duration_ms: 0.118916
  type: 'test'
  ...
# Subtest: a window entirely before the source returns null — nothing honest to show
ok 3498 - a window entirely before the source returns null — nothing honest to show
  ---
  duration_ms: 0.052458
  type: 'test'
  ...
# Subtest: a malformed or absurd window returns null rather than guessing
ok 3499 - a malformed or absurd window returns null rather than guessing
  ---
  duration_ms: 0.065667
  type: 'test'
  ...
# Subtest: the SQL is the measured NOT IN form, bounded, HOSPITAL_GP only
ok 3500 - the SQL is the measured NOT IN form, bounded, HOSPITAL_GP only
  ---
  duration_ms: 0.220417
  type: 'test'
  ...
# Subtest: the NOT IN filter is GUARDED so it is only asked about notes that HAVE an ID
ok 3501 - the NOT IN filter is GUARDED so it is only asked about notes that HAVE an ID
  ---
  duration_ms: 0.096583
  type: 'test'
  ...
# Subtest: THE INJECTION GUARD: a non-date bound THROWS, it is never interpolated
ok 3502 - THE INJECTION GUARD: a non-date bound THROWS, it is never interpolated
  ---
  duration_ms: 0.255667
  type: 'test'
  ...
# Subtest: isDay accepts only the exact shape — the same guard lib/metabase.ts uses
ok 3503 - isDay accepts only the exact shape — the same guard lib/metabase.ts uses
  ---
  duration_ms: 0.209208
  type: 'test'
  ...
# Subtest: addDays is UTC-stable across a month boundary and returns "" on junk
ok 3504 - addDays is UTC-stable across a month boundary and returns "" on junk
  ---
  duration_ms: 0.292584
  type: 'test'
  ...
# Subtest: istDay reads the Asia/Kolkata calendar day, not UTC
ok 3505 - istDay reads the Asia/Kolkata calendar day, not UTC
  ---
  duration_ms: 15.092667
  type: 'test'
  ...
# Subtest: a note with a NULL consult ID is no-consult-ID — neither covered nor no-vitals
ok 3506 - a note with a NULL consult ID is no-consult-ID — neither covered nor no-vitals
  ---
  duration_ms: 0.483458
  type: 'test'
  ...
# Subtest: THE HEADLINE DENOMINATOR EXCLUDES what we cannot know
ok 3507 - THE HEADLINE DENOMINATOR EXCLUDES what we cannot know
  ---
  duration_ms: 0.178292
  type: 'test'
  ...
# Subtest: empty-string and whitespace IDs are the SAME category as null (the SQL btrims them)
ok 3508 - empty-string and whitespace IDs are the SAME category as null (the SQL btrims them)
  ---
  duration_ms: 0.228209
  type: 'test'
  ...
# Subtest: a note with an ID absent from the vitals table is still no-vitals; one present is still covered
ok 3509 - a note with an ID absent from the vitals table is still no-vitals; one present is still covered
  ---
  duration_ms: 0.126833
  type: 'test'
  ...
# Subtest: the MEASURED window reproduces: 160 of 561 = 28.5%
ok 3510 - the MEASURED window reproduces: 160 of 561 = 28.5%
  ---
  duration_ms: 0.527375
  type: 'test'
  ...
# Subtest: rows outside the window are DROPPED — a boundary sliver is not a day
ok 3511 - rows outside the window are DROPPED — a boundary sliver is not a day
  ---
  duration_ms: 0.798667
  type: 'test'
  ...
# Subtest: Metabase type wobble is absorbed: string counts and ISO timestamps
ok 3512 - Metabase type wobble is absorbed: string counts and ISO timestamps
  ---
  duration_ms: 0.117167
  type: 'test'
  ...
# Subtest: junk never produces a number that looks real
ok 3513 - junk never produces a number that looks real
  ---
  duration_ms: 0.174292
  type: 'test'
  ...
# Subtest: the core is PURE and dependency-free — it must not reach the engine or any score
ok 3514 - the core is PURE and dependency-free — it must not reach the engine or any score
  ---
  duration_ms: 8.366333
  type: 'test'
  ...
# Subtest: GATE 2 — flag OFF: all three fetch SQL strings are byte-identical to today's
ok 3515 - GATE 2 — flag OFF: all three fetch SQL strings are byte-identical to today's
  ---
  duration_ms: 0.926667
  type: 'test'
  ...
# Subtest: flag ON: vitals LEFT JOIN present, DISTINCT ON newest _update_time, scan bounded, quoted table
ok 3516 - flag ON: vitals LEFT JOIN present, DISTINCT ON newest _update_time, scan bounded, quoted table
  ---
  duration_ms: 0.328584
  type: 'test'
  ...
# Subtest: SWEEP-1 (D2) — the day fetch deduplicates by uid; the single/bulk uid fetches do NOT change
ok 3517 - SWEEP-1 (D2) — the day fetch deduplicates by uid; the single/bulk uid fetches do NOT change
  ---
  duration_ms: 0.122375
  type: 'test'
  ...
# Subtest: GATE 5 — no selected column ends in _tag, flag on or off (R-11: numbers, not judgments)
ok 3518 - GATE 5 — no selected column ends in _tag, flag on or off (R-11: numbers, not judgments)
  ---
  duration_ms: 0.122417
  type: 'test'
  ...
# Subtest: GATE 3 — synthetic control: a vitals row parses to the exact case shape
ok 3519 - GATE 3 — synthetic control: a vitals row parses to the exact case shape
  ---
  duration_ms: 0.972458
  type: 'test'
  ...
# Subtest: GATE 3 — no vitals row → vitalsRecorded false + vitals null (weight/height still mapped)
ok 3520 - GATE 3 — no vitals row → vitalsRecorded false + vitals null (weight/height still mapped)
  ---
  duration_ms: 0.165042
  type: 'test'
  ...
# Subtest: a record with every measurement blank is STILL vitalsRecorded true — a different finding from "no record"
ok 3521 - a record with every measurement blank is STILL vitalsRecorded true — a different finding from "no record"
  ---
  duration_ms: 0.099375
  type: 'test'
  ...
# Subtest: bp parse: null unless the string matches ^\\d+\\/\\d+$ (the raw string is kept as recorded)
ok 3522 - bp parse: null unless the string matches ^\\d+\\/\\d+$ (the raw string is kept as recorded)
  ---
  duration_ms: 0.107708
  type: 'test'
  ...
# Subtest: recordedAt: null when the note timestamp is missing (no wall clock ever leaks)
ok 3523 - recordedAt: null when the note timestamp is missing (no wall clock ever leaks)
  ---
  duration_ms: 0.243917
  type: 'test'
  ...
# Subtest: fail-safe: an error in the vitals leg resets to the safe state and leaves the rest of the case intact
ok 3524 - fail-safe: an error in the vitals leg resets to the safe state and leaves the rest of the case intact
  ---
  duration_ms: 0.384
  type: 'test'
  ...
# Subtest: flag OFF: the A1 fields stay absent — every existing case literal and behaviour unchanged
ok 3525 - flag OFF: the A1 fields stay absent — every existing case literal and behaviour unchanged
  ---
  duration_ms: 0.08175
  type: 'test'
  ...
# Subtest: GATE 1 — opdCaseText is byte-identical with and without the vitals block (A1 is score-invariant)
ok 3526 - GATE 1 — opdCaseText is byte-identical with and without the vitals block (A1 is score-invariant)
  ---
  duration_ms: 0.5575
  type: 'test'
  ...
# Subtest: GATE 4 — OpdKeys carries no vitals field, no weight, no height
ok 3527 - GATE 4 — OpdKeys carries no vitals field, no weight, no height
  ---
  duration_ms: 0.15225
  type: 'test'
  ...
# The `fetchConnectionCache` option is deprecated (now always `true`)
# Subtest: the declaration is ONE statement over the whole note set, with ids index-aligned to it
ok 3528 - the declaration is ONE statement over the whole note set, with ids index-aligned to it
  ---
  duration_ms: 4.263292
  type: 'test'
  ...
# Subtest: a note with no uid declares a NULL uid, never the string "undefined"
ok 3529 - a note with no uid declares a NULL uid, never the string "undefined"
  ---
  duration_ms: 0.213292
  type: 'test'
  ...
# Subtest: 25 — a failed declaration throws TelemetryDeclarationError and leaves per-run evidence
ok 3530 - 25 — a failed declaration throws TelemetryDeclarationError and leaves per-run evidence
  ---
  duration_ms: 0.520125
  type: 'test'
  ...
# Subtest: 25 — all three worker modes reach the SAME fail-closed declaration, and it answers 503
ok 3531 - 25 — all three worker modes reach the SAME fail-closed declaration, and it answers 503
  ---
  duration_ms: 0.211334
  type: 'test'
  ...
# Subtest: 26 — the sweep 503 body says earlier days persisted
ok 3532 - 26 — the sweep 503 body says earlier days persisted
  ---
  duration_ms: 0.104416
  type: 'test'
  ...
# Subtest: 27 — re-audit fetches first, declares only what resolved, and preserves count and order
ok 3533 - 27 — re-audit fetches first, declares only what resolved, and preserves count and order
  ---
  duration_ms: 0.142209
  type: 'test'
  ...
# Subtest: the run ids are never reallocated — every audit call ADOPTS the declared id
ok 3534 - the run ids are never reallocated — every audit call ADOPTS the declared id
  ---
  duration_ms: 0.128042
  type: 'test'
  ...
# Subtest: the mini-backfill declares the same way and refuses the tick the same way
ok 3535 - the mini-backfill declares the same way and refuses the tick the same way
  ---
  duration_ms: 0.07725
  type: 'test'
  ...
# Subtest: safety-regex positive: Start metformin 500 mg twice daily.
ok 3536 - safety-regex positive: Start metformin 500 mg twice daily.
  ---
  duration_ms: 1.704416
  type: 'test'
  ...
# Subtest: safety-regex positive: Give 1 mg of glucagon IM.
ok 3537 - safety-regex positive: Give 1 mg of glucagon IM.
  ---
  duration_ms: 0.067625
  type: 'test'
  ...
# Subtest: safety-regex positive: Loading dose 500 mcg.
ok 3538 - safety-regex positive: Loading dose 500 mcg.
  ---
  duration_ms: 0.043416
  type: 'test'
  ...
# Subtest: safety-regex positive: Bolus 5 units of insulin.
ok 3539 - safety-regex positive: Bolus 5 units of insulin.
  ---
  duration_ms: 0.0385
  type: 'test'
  ...
# Subtest: safety-regex positive: 0.5 g IV q6h.
ok 3540 - safety-regex positive: 0.5 g IV q6h.
  ---
  duration_ms: 0.037667
  type: 'test'
  ...
# Subtest: safety-regex positive: Infuse 1000 mL bolus over 30 min.
ok 3541 - safety-regex positive: Infuse 1000 mL bolus over 30 min.
  ---
  duration_ms: 0.09525
  type: 'test'
  ...
# Subtest: safety-regex positive: 500 cc of normal saline.
ok 3542 - safety-regex positive: 500 cc of normal saline.
  ---
  duration_ms: 0.089167
  type: 'test'
  ...
# Subtest: safety-regex positive: Run at 100 mL/hr.
ok 3543 - safety-regex positive: Run at 100 mL/hr.
  ---
  duration_ms: 0.134292
  type: 'test'
  ...
# Subtest: safety-regex positive: Maintenance 50 cc/h.
ok 3544 - safety-regex positive: Maintenance 50 cc/h.
  ---
  duration_ms: 0.240458
  type: 'test'
  ...
# Subtest: safety-regex positive: 30 drops/min via gravity.
ok 3545 - safety-regex positive: 30 drops/min via gravity.
  ---
  duration_ms: 0.308625
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per L): Sodium 140 mEq/L is normal.
ok 3546 - safety-regex negative (preserve lab unit per L): Sodium 140 mEq/L is normal.
  ---
  duration_ms: 0.051667
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per dL): Creatinine 1.4 mg/dL.
ok 3547 - safety-regex negative (preserve lab unit per dL): Creatinine 1.4 mg/dL.
  ---
  duration_ms: 0.027667
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit mmol/L): Lactate 4.2 mmol/L is the SSC threshold.
ok 3548 - safety-regex negative (preserve lab unit mmol/L): Lactate 4.2 mmol/L is the SSC threshold.
  ---
  duration_ms: 0.023167
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit g/dL): Albumin 3.5 g/dL.
ok 3549 - safety-regex negative (preserve lab unit g/dL): Albumin 3.5 g/dL.
  ---
  duration_ms: 0.02275
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve protocol cite mL/kg, not a dose): SSC recommends 30 mL/kg crystalloid in the first hour.
ok 3550 - safety-regex negative (preserve protocol cite mL/kg, not a dose): SSC recommends 30 mL/kg crystalloid in the first hour.
  ---
  duration_ms: 0.025625
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit): HCO3 9 mEq/L on this gas.
ok 3551 - safety-regex negative (preserve lab unit): HCO3 9 mEq/L on this gas.
  ---
  duration_ms: 0.021709
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve eGFR unit): eGFR 42 mL/min/1.73 m² is CKD G3b.
ok 3552 - safety-regex negative (preserve eGFR unit): eGFR 42 mL/min/1.73 m² is CKD G3b.
  ---
  duration_ms: 0.024209
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve mmHg not in dose set): PaO2 80 mmHg.
ok 3553 - safety-regex negative (preserve mmHg not in dose set): PaO2 80 mmHg.
  ---
  duration_ms: 0.021625
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per dL): BUN 28 mg/dL.
ok 3554 - safety-regex negative (preserve lab unit per dL): BUN 28 mg/dL.
  ---
  duration_ms: 0.022
  type: 'test'
  ...
# Subtest: safety-regex negative (preserve lab unit per dL): Glucose 580 mg/dL is severe hyperglycemia.
ok 3555 - safety-regex negative (preserve lab unit per dL): Glucose 580 mg/dL is severe hyperglycemia.
  ---
  duration_ms: 0.023208
  type: 'test'
  ...
# Subtest: safety-regex preserves fluid TYPE: Hypertonic saline is the indicated agent for sympt...
ok 3556 - safety-regex preserves fluid TYPE: Hypertonic saline is the indicated agent for sympt...
  ---
  duration_ms: 0.030708
  type: 'test'
  ...
# Subtest: safety-regex preserves fluid TYPE: Isotonic crystalloid is appropriate for initial re...
ok 3557 - safety-regex preserves fluid TYPE: Isotonic crystalloid is appropriate for initial re...
  ---
  duration_ms: 0.022958
  type: 'test'
  ...
# Subtest: safety-regex preserves fluid TYPE: Lactated Ringer is preferred over normal saline in...
ok 3558 - safety-regex preserves fluid TYPE: Lactated Ringer is preferred over normal saline in...
  ---
  duration_ms: 0.021042
  type: 'test'
  ...
# Subtest: safety-regex mixed: redact dose, preserve lab unit
ok 3559 - safety-regex mixed: redact dose, preserve lab unit
  ---
  duration_ms: 0.059375
  type: 'test'
  ...
# Subtest: ABG: classic high-AG metabolic acidosis (DKA-flavored)
ok 3560 - ABG: classic high-AG metabolic acidosis (DKA-flavored)
  ---
  duration_ms: 1.744083
  type: 'test'
  ...
# Subtest: ABG: respiratory alkalosis + concurrent high-AG metabolic acidosis (mixed via delta-delta)
ok 3561 - ABG: respiratory alkalosis + concurrent high-AG metabolic acidosis (mixed via delta-delta)
  ---
  duration_ms: 0.196125
  type: 'test'
  ...
# Subtest: ABG: acute respiratory acidosis (no chronic compensation evidence)
ok 3562 - ABG: acute respiratory acidosis (no chronic compensation evidence)
  ---
  duration_ms: 0.137667
  type: 'test'
  ...
# Subtest: ABG: metabolic alkalosis
ok 3563 - ABG: metabolic alkalosis
  ---
  duration_ms: 0.288167
  type: 'test'
  ...
# Subtest: ABG: normal — must not fabricate a disorder
ok 3564 - ABG: normal — must not fabricate a disorder
  ---
  duration_ms: 0.135167
  type: 'test'
  ...
# Subtest: ABG: albumin correction applied below 4.0
ok 3565 - ABG: albumin correction applied below 4.0
  ---
  duration_ms: 0.118
  type: 'test'
  ...
# Subtest: ABG: P/F ratio Berlin ARDS bands
ok 3566 - ABG: P/F ratio Berlin ARDS bands
  ---
  duration_ms: 0.276583
  type: 'test'
  ...
# Subtest: ABG: A-a gradient computed when PaO2+FiO2+PaCO2 all present
ok 3567 - ABG: A-a gradient computed when PaO2+FiO2+PaCO2 all present
  ---
  duration_ms: 0.117375
  type: 'test'
  ...
# Subtest: ABG: anion gap returns unknown when Na/Cl missing
ok 3568 - ABG: anion gap returns unknown when Na/Cl missing
  ---
  duration_ms: 0.34175
  type: 'test'
  ...
# Subtest: ckdEpi2021: young healthy F, SCr 0.7
ok 3569 - ckdEpi2021: young healthy F, SCr 0.7
  ---
  duration_ms: 0.614083
  type: 'test'
  ...
# Subtest: ckdEpi2021: mid-life M, SCr 1.0
ok 3570 - ckdEpi2021: mid-life M, SCr 1.0
  ---
  duration_ms: 0.062208
  type: 'test'
  ...
# Subtest: ckdEpi2021: older M, SCr 1.8 (CKD3b)
ok 3571 - ckdEpi2021: older M, SCr 1.8 (CKD3b)
  ---
  duration_ms: 0.698209
  type: 'test'
  ...
# Subtest: ckdEpi2021: elderly F, SCr 4.2 (CKD5)
ok 3572 - ckdEpi2021: elderly F, SCr 4.2 (CKD5)
  ---
  duration_ms: 0.155083
  type: 'test'
  ...
# Subtest: ckdEpi2021: F SCr 1.2 (CKD3a)
ok 3573 - ckdEpi2021: F SCr 1.2 (CKD3a)
  ---
  duration_ms: 0.049916
  type: 'test'
  ...
# Subtest: cockcroftGault: young healthy F, SCr 0.7, 60 kg
ok 3574 - cockcroftGault: young healthy F, SCr 0.7, 60 kg
  ---
  duration_ms: 0.074041
  type: 'test'
  ...
# Subtest: cockcroftGault: older M, SCr 1.8, 78 kg
ok 3575 - cockcroftGault: older M, SCr 1.8, 78 kg
  ---
  duration_ms: 0.101792
  type: 'test'
  ...
# Subtest: cockcroftGault: elderly F low weight, SCr 4.2, 52
ok 3576 - cockcroftGault: elderly F low weight, SCr 4.2, 52
  ---
  duration_ms: 0.032208
  type: 'test'
  ...
# Subtest: cockcroftGault returns null without weight
ok 3577 - cockcroftGault returns null without weight
  ---
  duration_ms: 0.177917
  type: 'test'
  ...
# Subtest: computeEgfr returns conservative_for_nti as the lower of the two
ok 3578 - computeEgfr returns conservative_for_nti as the lower of the two
  ---
  duration_ms: 0.303542
  type: 'test'
  ...
# Subtest: stageFromEgfr boundaries
ok 3579 - stageFromEgfr boundaries
  ---
  duration_ms: 0.055625
  type: 'test'
  ...
# Subtest: umolLtoMgDl conversion
ok 3580 - umolLtoMgDl conversion
  ---
  duration_ms: 0.041375
  type: 'test'
  ...
# Subtest: Hyponatremia: classic SIADH (euvolemic, U-Na high, U-osm concentrated, on SSRI)
ok 3581 - Hyponatremia: classic SIADH (euvolemic, U-Na high, U-osm concentrated, on SSRI)
  ---
  duration_ms: 2.789916
  type: 'test'
  ...
# Subtest: Hyponatremia: pseudo from hyperglycemia (corrected Na > measured)
ok 3582 - Hyponatremia: pseudo from hyperglycemia (corrected Na > measured)
  ---
  duration_ms: 0.255667
  type: 'test'
  ...
# Subtest: Hyponatremia: hypovolemic from extrarenal loss
ok 3583 - Hyponatremia: hypovolemic from extrarenal loss
  ---
  duration_ms: 0.136541
  type: 'test'
  ...
# Subtest: Hyponatremia: ODS risk fires for Na < 105
ok 3584 - Hyponatremia: ODS risk fires for Na < 105
  ---
  duration_ms: 0.234084
  type: 'test'
  ...
# Subtest: Hyponatremia: ODS risk fires for K < 3
ok 3585 - Hyponatremia: ODS risk fires for K < 3
  ---
  duration_ms: 0.250875
  type: 'test'
  ...
# Subtest: Hyponatremia: free-water excess for 70kg male, Na 125
ok 3586 - Hyponatremia: free-water excess for 70kg male, Na 125
  ---
  duration_ms: 0.124833
  type: 'test'
  ...
# Subtest: Hyponatremia: free-water excess returns null without weight
ok 3587 - Hyponatremia: free-water excess returns null without weight
  ---
  duration_ms: 0.10225
  type: 'test'
  ...
# Subtest: Hyponatremia: estimated osm fires when serum_osm absent
ok 3588 - Hyponatremia: estimated osm fires when serum_osm absent
  ---
  duration_ms: 0.106791
  type: 'test'
  ...
# Subtest: NEWS2: all-normal vitals → 0 / low / no banner
ok 3589 - NEWS2: all-normal vitals → 0 / low / no banner
  ---
  duration_ms: 0.744709
  type: 'test'
  ...
# Subtest: NEWS2: PRD §11 vignette \#2 — RR 22, SpO2 95, T 38.2, BP 110, HR 105 → 5 medium amber
ok 3590 - NEWS2: PRD §11 vignette \#2 — RR 22, SpO2 95, T 38.2, BP 110, HR 105 → 5 medium amber
  ---
  duration_ms: 0.079167
  type: 'test'
  ...
# Subtest: NEWS2: PRD §11 vignette \#3 — RR 28, SpO2 90, T 39.5, BP 88, HR 130, new confusion → ≥10 high red
ok 3591 - NEWS2: PRD §11 vignette \#3 — RR 28, SpO2 90, T 39.5, BP 88, HR 130, new confusion → ≥10 high red
  ---
  duration_ms: 0.088167
  type: 'test'
  ...
# Subtest: NEWS2 Scale 2 / COPD: SpO2 88 on 2L O2 — air SpO2 target met but on O2
ok 3592 - NEWS2 Scale 2 / COPD: SpO2 88 on 2L O2 — air SpO2 target met but on O2
  ---
  duration_ms: 0.058792
  type: 'test'
  ...
# Subtest: NEWS2 Scale 2: SpO2 96 on O2 (above target window) → scale 2 SpO2 → 2
ok 3593 - NEWS2 Scale 2: SpO2 96 on O2 (above target window) → scale 2 SpO2 → 2
  ---
  duration_ms: 0.050166
  type: 'test'
  ...
# Subtest: NEWS2 Scale 2: SpO2 96 on AIR (above target window without O2) → scale 2 SpO2 → 0
ok 3594 - NEWS2 Scale 2: SpO2 96 on AIR (above target window without O2) → scale 2 SpO2 → 0
  ---
  duration_ms: 0.040125
  type: 'test'
  ...
# Subtest: NEWS2: isolated tachycardia HR 115 → 2 low-medium (not a single 3, so stays low-medium)
ok 3595 - NEWS2: isolated tachycardia HR 115 → 2 low-medium (not a single 3, so stays low-medium)
  ---
  duration_ms: 0.0975
  type: 'test'
  ...
# Subtest: NEWS2: single param scoring 3 bumps low-medium → medium
ok 3596 - NEWS2: single param scoring 3 bumps low-medium → medium
  ---
  duration_ms: 0.044542
  type: 'test'
  ...
# Subtest: NEWS2 RR boundaries
ok 3597 - NEWS2 RR boundaries
  ---
  duration_ms: 0.283958
  type: 'test'
  ...
# Subtest: NEWS2 SBP boundaries
ok 3598 - NEWS2 SBP boundaries
  ---
  duration_ms: 0.300209
  type: 'test'
  ...
# Subtest: NEWS2 Temp boundaries
ok 3599 - NEWS2 Temp boundaries
  ---
  duration_ms: 0.067417
  type: 'test'
  ...
# Subtest: NEWS2 consciousness: any non-Alert → 3
ok 3600 - NEWS2 consciousness: any non-Alert → 3
  ---
  duration_ms: 0.055542
  type: 'test'
  ...
# Subtest: SepsisBundle V1: just recognized (5 min), nothing done
ok 3601 - SepsisBundle V1: just recognized (5 min), nothing done
  ---
  duration_ms: 1.229083
  type: 'test'
  ...
# Subtest: SepsisBundle V2: at 35 min, lactate + cultures done, abx + fluids missing (hypotensive)
ok 3602 - SepsisBundle V2: at 35 min, lactate + cultures done, abx + fluids missing (hypotensive)
  ---
  duration_ms: 0.103208
  type: 'test'
  ...
# Subtest: SepsisBundle V2b: at 35 min, only lactate done (25% compliance) → amber banner
ok 3603 - SepsisBundle V2b: at 35 min, only lactate done (25% compliance) → amber banner
  ---
  duration_ms: 0.093417
  type: 'test'
  ...
# Subtest: SepsisBundle V3: 55 min, vasopressors required after fluids in hypotension
ok 3604 - SepsisBundle V3: 55 min, vasopressors required after fluids in hypotension
  ---
  duration_ms: 0.057542
  type: 'test'
  ...
# Subtest: SepsisBundle V4: 75 min, abx never given → overdue + red banner
ok 3605 - SepsisBundle V4: 75 min, abx never given → overdue + red banner
  ---
  duration_ms: 0.132375
  type: 'test'
  ...
# Subtest: SepsisBundle: not-hypotensive patient does not require fluids/vasopressors
ok 3606 - SepsisBundle: not-hypotensive patient does not require fluids/vasopressors
  ---
  duration_ms: 0.250042
  type: 'test'
  ...
# Subtest: SepsisBundle: elapsed_min defaults to 0 for future recognition_time (clamps)
ok 3607 - SepsisBundle: elapsed_min defaults to 0 for future recognition_time (clamps)
  ---
  duration_ms: 0.089958
  type: 'test'
  ...
1..3607
# tests 3607
# suites 0
# pass 3607
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 22226.412958
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:49:22Z
```

### Command 2 — npm run typecheck

```text
COMMAND: npm run typecheck
STARTED: 2026-08-18T23:49:22Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 typecheck
> tsc --noEmit

--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:49:25Z
```

### Command 3 — keyed production build (env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build)

```text
COMMAND: env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build
STARTED: 2026-08-18T23:49:25Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 build
> next build

   ▲ Next.js 15.5.18
   - Environments: .env.local

   Creating an optimized production build ...
 ✓ Compiled successfully in 9.8s
   Linting and checking validity of types ...
   Collecting page data ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
 ⚠ Using edge runtime on a page currently disables static generation for that page
   Generating static pages (0/127) ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
   Generating static pages (31/127) 
   Generating static pages (63/127) 
The `fetchConnectionCache` option is deprecated (now always `true`)
   Generating static pages (95/127) 
 ✓ Generating static pages (127/127)
   Finalizing page optimization ...
   Collecting build traces ...

Route (app)                                             Size  First Load JS
┌ ƒ /                                                  205 B         107 kB
├ ƒ /_not-found                                      1.01 kB         104 kB
├ ƒ /admin/appropriateness-runs                        600 B         104 kB
├ ƒ /admin/architecture                                205 B         107 kB
├ ƒ /admin/ccb-funnel                                  600 B         104 kB
├ ƒ /admin/concordance                                 205 B         107 kB
├ ƒ /admin/episode-recon-queue                        1.5 kB         108 kB
├ ƒ /admin/eval                                        600 B         104 kB
├ ƒ /admin/ipd-audit                                   178 B         107 kB
├ ƒ /admin/ipd-audit/[id]                            6.16 kB         251 kB
├ ƒ /admin/ipd-audit/calendar                          842 B         107 kB
├ ƒ /admin/ipd-audit/search                            842 B         107 kB
├ ƒ /admin/ipd-gold-queue                             1.6 kB         108 kB
├ ƒ /admin/learning                                  1.76 kB         108 kB
├ ƒ /admin/literature                                  205 B         107 kB
├ ƒ /admin/lvc-ground                                4.23 kB         243 kB
├ ƒ /admin/mini-backfill                             6.58 kB         113 kB
├ ƒ /admin/observability                              5.3 kB         112 kB
├ ƒ /admin/observability/[traceId]                     205 B         107 kB
├ ƒ /admin/observability/adjudications                 178 B         107 kB
├ ƒ /admin/observability/engine-health                 205 B         107 kB
├ ƒ /admin/observability/reconstruction-fidelity       178 B         107 kB
├ ƒ /admin/opd-audit                                 3.48 kB         115 kB
├ ƒ /admin/opd-audit/[id]                            10.9 kB         117 kB
├ ƒ /admin/opd-audit/doctor/[uid]                      180 B         112 kB
├ ƒ /admin/opd-audit/doctors                           205 B         107 kB
├ ƒ /admin/opd-audit/how-it-works                      205 B         107 kB
├ ƒ /admin/opd-audit/vitals-coverage                   205 B         107 kB
├ ƒ /admin/proms-adhoc-review                        3.26 kB         106 kB
├ ƒ /admin/provenance                                  600 B         104 kB
├ ƒ /admin/scoring-policy                              178 B         107 kB
├ ƒ /admin/scoring-policy/lab-packages               2.59 kB         115 kB
├ ƒ /admin/scoring-policy/nabh-completeness            168 B         113 kB
├ ƒ /admin/scoring-policy/nabh-completeness/history    180 B         113 kB
├ ƒ /admin/stewardship                                 205 B         107 kB
├ ƒ /admin/stewardship/dept/[dept]                     205 B         107 kB
├ ƒ /api/admin/appropriateness-runs                    600 B         104 kB
├ ƒ /api/admin/appropriateness-runs/[id]               600 B         104 kB
├ ƒ /api/admin/backfill-corpus-provenance              600 B         104 kB
├ ƒ /api/admin/backfill-stable-ref                     600 B         104 kB
├ ƒ /api/admin/bm25-diag                               600 B         104 kB
├ ƒ /api/admin/ccb-calibration                         600 B         104 kB
├ ƒ /api/admin/complexity-backfill                     600 B         104 kB
├ ƒ /api/admin/concordance/migrate                     600 B         104 kB
├ ƒ /api/admin/concordance/runs                        600 B         104 kB
├ ƒ /api/admin/corpus-eval/status                      600 B         104 kB
├ ƒ /api/admin/episode-recon-rating                    600 B         104 kB
├ ƒ /api/admin/ipd-audit-billed-backfill               600 B         104 kB
├ ƒ /api/admin/ipd-audit-export                        600 B         104 kB
├ ƒ /api/admin/ipd-audit-feedback                      600 B         104 kB
├ ƒ /api/admin/ipd-audit-mini-backfill                 600 B         104 kB
├ ƒ /api/admin/ipd-audit-now                           600 B         104 kB
├ ƒ /api/admin/ipd-gold-adjudication                   600 B         104 kB
├ ƒ /api/admin/lab-batch                               600 B         104 kB
├ ƒ /api/admin/lvc-judge-aa                            600 B         104 kB
├ ƒ /api/admin/lvc-ref-backfill                        600 B         104 kB
├ ƒ /api/admin/mark-mini-labelled-prod                 600 B         104 kB
├ ƒ /api/admin/migrate                                 600 B         104 kB
├ ƒ /api/admin/migrate-adhoc-sets                      600 B         104 kB
├ ƒ /api/admin/migrate-appropriateness-runs            600 B         104 kB
├ ƒ /api/admin/migrate-audit-suppression               600 B         104 kB
├ ƒ /api/admin/migrate-care-call                       600 B         104 kB
├ ƒ /api/admin/migrate-care-tracks                     600 B         104 kB
├ ƒ /api/admin/migrate-ccb                             600 B         104 kB
├ ƒ /api/admin/migrate-ccb-cache                       600 B         104 kB
├ ƒ /api/admin/migrate-choosing-wisely                 600 B         104 kB
├ ƒ /api/admin/migrate-concept-state-key               600 B         104 kB
├ ƒ /api/admin/migrate-doctor-metrics                  600 B         104 kB
├ ƒ /api/admin/migrate-episode-recon                   600 B         104 kB
├ ƒ /api/admin/migrate-episode-states                  600 B         104 kB
├ ƒ /api/admin/migrate-even-ground                     600 B         104 kB
├ ƒ /api/admin/migrate-even-lvc                        600 B         104 kB
├ ƒ /api/admin/migrate-extracted-cases                 600 B         104 kB
├ ƒ /api/admin/migrate-inquiry                         600 B         104 kB
├ ƒ /api/admin/migrate-ipd-audits                      600 B         104 kB
├ ƒ /api/admin/migrate-ipd-gold-union                  600 B         104 kB
├ ƒ /api/admin/migrate-lab                             600 B         104 kB
├ ƒ /api/admin/migrate-lab-views                       600 B         104 kB
├ ƒ /api/admin/migrate-learning                        600 B         104 kB
├ ƒ /api/admin/migrate-lvc-concepts                    600 B         104 kB
├ ƒ /api/admin/migrate-lvc-wording                     600 B         104 kB
├ ƒ /api/admin/migrate-medaudit                        600 B         104 kB
├ ƒ /api/admin/migrate-mini-ticks                      600 B         104 kB
├ ƒ /api/admin/migrate-opd-audits                      600 B         104 kB
├ ƒ /api/admin/migrate-opd-gov-signal                  600 B         104 kB
├ ƒ /api/admin/migrate-opd-longitudinal                600 B         104 kB
├ ƒ /api/admin/migrate-opd-triage                      600 B         104 kB
├ ƒ /api/admin/migrate-proms                           600 B         104 kB
├ ƒ /api/admin/migrate-provenance-tier                 600 B         104 kB
├ ƒ /api/admin/migrate-readmissions                    600 B         104 kB
├ ƒ /api/admin/migrate-reasoning                       600 B         104 kB
├ ƒ /api/admin/migrate-retrieval-telemetry             600 B         104 kB
├ ƒ /api/admin/migrate-scoring-policy                  600 B         104 kB
├ ƒ /api/admin/migrate-v2                              600 B         104 kB
├ ƒ /api/admin/migrate-v6                              600 B         104 kB
├ ƒ /api/admin/migrate-v7                              600 B         104 kB
├ ƒ /api/admin/migrate-v8                              600 B         104 kB
├ ƒ /api/admin/mini-backfill-monitor                   600 B         104 kB
├ ƒ /api/admin/mini-backfill-settings                  600 B         104 kB
├ ƒ /api/admin/ollama-ps                               600 B         104 kB
├ ƒ /api/admin/opd-audit-mini-backfill                 600 B         104 kB
├ ƒ /api/admin/opd-audit/longitudinal-replay           600 B         104 kB
├ ƒ /api/admin/opd-dosing-backfill                     600 B         104 kB
├ ƒ /api/admin/opd-invalid-marking-backfill            600 B         104 kB
├ ƒ /api/admin/opd-rescore-direction                   600 B         104 kB
├ ƒ /api/admin/prognosis-outcome                       600 B         104 kB
├ ƒ /api/admin/proms-adhoc-review                      600 B         104 kB
├ ƒ /api/admin/quieting-dryrun                         600 B         104 kB
├ ƒ /api/admin/reasoning-registry                      600 B         104 kB
├ ƒ /api/admin/recompute-care-call                     600 B         104 kB
├ ƒ /api/admin/refresh-doctor-metrics                  600 B         104 kB
├ ƒ /api/admin/retrieval-telemetry-reconcile           600 B         104 kB
├ ƒ /api/admin/seed-choosing-wisely                    600 B         104 kB
├ ƒ /api/admin/seed-ddi-reference                      600 B         104 kB
├ ƒ /api/admin/seed-formulary                          600 B         104 kB
├ ƒ /api/admin/seed-topics                             600 B         104 kB
├ ƒ /api/admin/seed-topics-tropical                    600 B         104 kB
├ ƒ /api/admin/statpearls-pilot                        600 B         104 kB
├ ƒ /api/admin/sync-doctor-directory                   600 B         104 kB
├ ƒ /api/admin/telemetry-overhead                      600 B         104 kB
├ ƒ /api/admin/tooltip-cache/bump                      600 B         104 kB
├ ƒ /api/admin/traces                                  600 B         104 kB
├ ƒ /api/admin/traces/[traceId]                        600 B         104 kB
├ ƒ /api/admin/unlock                                  600 B         104 kB
├ ƒ /api/appropriateness                               600 B         104 kB
├ ƒ /api/appropriateness/save-run                      600 B         104 kB
├ ƒ /api/ask                                           600 B         104 kB
├ ƒ /api/ask/example-questions                         600 B         104 kB
├ ƒ /api/ask/stage-medians                             600 B         104 kB
├ ƒ /api/audit                                         600 B         104 kB
├ ƒ /api/audit/formulary                               600 B         104 kB
├ ƒ /api/audit/interactions                            600 B         104 kB
├ ƒ /api/audit/login                                   600 B         104 kB
├ ƒ /api/calculators/abcd2                             600 B         104 kB
├ ƒ /api/calculators/abg                               600 B         104 kB
├ ƒ /api/calculators/alvarado                          600 B         104 kB
├ ƒ /api/calculators/curb65                            600 B         104 kB
├ ƒ /api/calculators/egfr                              600 B         104 kB
├ ƒ /api/calculators/heart                             600 B         104 kB
├ ƒ /api/calculators/hyponatremia                      600 B         104 kB
├ ƒ /api/calculators/news2                             600 B         104 kB
├ ƒ /api/calculators/nihss                             600 B         104 kB
├ ƒ /api/calculators/qtc                               600 B         104 kB
├ ƒ /api/calculators/sepsis-bundle                     600 B         104 kB
├ ƒ /api/calculators/sepsis-bundle/sidebar             600 B         104 kB
├ ƒ /api/calculators/sofa                              600 B         104 kB
├ ƒ /api/calculators/timi                              600 B         104 kB
├ ƒ /api/calculators/tooltip                           600 B         104 kB
├ ƒ /api/calculators/typical-latency                   600 B         104 kB
├ ƒ /api/calculators/wells_dvt                         600 B         104 kB
├ ƒ /api/calculators/wells_pe                          600 B         104 kB
├ ƒ /api/care-call/askset                              600 B         104 kB
├ ƒ /api/care-call/outcome                             600 B         104 kB
├ ƒ /api/care-call/outcomes                            600 B         104 kB
├ ƒ /api/care-call/proms/adhoc/generate                600 B         104 kB
├ ƒ /api/care-call/proms/adhoc/update                  600 B         104 kB
├ ƒ /api/care-call/proms/response                      600 B         104 kB
├ ƒ /api/care-call/proms/schedule                      600 B         104 kB
├ ƒ /api/care/assignment                               600 B         104 kB
├ ƒ /api/care/concept/code                             600 B         104 kB
├ ƒ /api/care/concept/status                           600 B         104 kB
├ ƒ /api/care/login                                    600 B         104 kB
├ ƒ /api/care/lvc/generate                             600 B         104 kB
├ ƒ /api/care/lvc/ground                               600 B         104 kB
├ ƒ /api/care/lvc/ground-status                        600 B         104 kB
├ ƒ /api/care/lvc/list                                 600 B         104 kB
├ ƒ /api/care/lvc/ratify                               600 B         104 kB
├ ƒ /api/care/lvc/reject                               600 B         104 kB
├ ƒ /api/care/lvc/retire                               600 B         104 kB
├ ƒ /api/care/member-state                             600 B         104 kB
├ ƒ /api/care/readmissions/list                        600 B         104 kB
├ ƒ /api/care/review-queue                             600 B         104 kB
├ ƒ /api/care/review-stats                             600 B         104 kB
├ ƒ /api/care/workspace                                600 B         104 kB
├ ƒ /api/ccb/brief                                     600 B         104 kB
├ ƒ /api/ccb/brief/stream                              600 B         104 kB
├ ƒ /api/ccb/dossier                                   600 B         104 kB
├ ƒ /api/ccb/episode-docs                              600 B         104 kB
├ ƒ /api/ccb/search                                    600 B         104 kB
├ ƒ /api/ccb/selftest                                  600 B         104 kB
├ ƒ /api/ccb/worker                                    600 B         104 kB
├ ƒ /api/ccb/worklist                                  600 B         104 kB
├ ƒ /api/coach/end                                     600 B         104 kB
├ ƒ /api/coach/respond                                 600 B         104 kB
├ ƒ /api/coach/start                                   600 B         104 kB
├ ƒ /api/concordance/interview                         600 B         104 kB
├ ƒ /api/concordance/single-shot                       600 B         104 kB
├ ƒ /api/cron/curator                                  600 B         104 kB
├ ƒ /api/cron/harvest                                  600 B         104 kB
├ ƒ /api/cron/harvest-epmc                             600 B         104 kB
├ ƒ /api/ddx                                           600 B         104 kB
├ ƒ /api/debug-search                                  600 B         104 kB
├ ƒ /api/debug-stats                                   600 B         104 kB
├ ƒ /api/digest/generate                               600 B         104 kB
├ ƒ /api/doc-audit/analyze                             600 B         104 kB
├ ƒ /api/doc-audit/extract                             600 B         104 kB
├ ƒ /api/drugs/interactions                            600 B         104 kB
├ ƒ /api/drugs/lookup                                  600 B         104 kB
├ ƒ /api/flashcards/due                                600 B         104 kB
├ ƒ /api/flashcards/review                             600 B         104 kB
├ ƒ /api/governance/audit-signal/[reference]           600 B         104 kB
├ ƒ /api/governance/doctor-audits                      600 B         104 kB
├ ƒ /api/governance/doctor-directory                   600 B         104 kB
├ ƒ /api/governance/doctor-response                    600 B         104 kB
├ ƒ /api/governance/opd-signals                        600 B         104 kB
├ ƒ /api/governance/roster-audits                      600 B         104 kB
├ ƒ /api/governance/signal-action                      600 B         104 kB
├ ƒ /api/health                                        600 B         104 kB
├ ƒ /api/ipd-audit/review                              600 B         104 kB
├ ƒ /api/ipd-audit/worker                              600 B         104 kB
├ ƒ /api/lab/ml-label-trial                            600 B         104 kB
├ ƒ /api/learning/mine                                 600 B         104 kB
├ ƒ /api/learning/review                               600 B         104 kB
├ ƒ /api/log/query                                     600 B         104 kB
├ ƒ /api/mcp                                           600 B         104 kB
├ ƒ /api/mcp/[key]                                     600 B         104 kB
├ ƒ /api/opd-audit/backfill                            600 B         104 kB
├ ƒ /api/opd-audit/export-pdf                          600 B         104 kB
├ ƒ /api/opd-audit/feedback                            600 B         104 kB
├ ƒ /api/opd-audit/reset                               600 B         104 kB
├ ƒ /api/opd-audit/run                                 600 B         104 kB
├ ƒ /api/opd-audit/worker                              600 B         104 kB
├ ƒ /api/opd-triage/decide                             600 B         104 kB
├ ƒ /api/opd-triage/longitudinal-lane                  600 B         104 kB
├ ƒ /api/opd-triage/queue                              600 B         104 kB
├ ƒ /api/opd-triage/signal-health                      600 B         104 kB
├ ƒ /api/opd-triage/suppressions                       600 B         104 kB
├ ƒ /api/pathway/enrich                                600 B         104 kB
├ ƒ /api/pathway/skeleton                              600 B         104 kB
├ ƒ /api/practice/next                                 600 B         104 kB
├ ƒ /api/readmission/worker                            600 B         104 kB
├ ƒ /api/scoring-policy                                600 B         104 kB
├ ƒ /api/scoring-policy/draft                          600 B         104 kB
├ ƒ /api/scoring-policy/lab-packages/export            600 B         104 kB
├ ƒ /api/scoring-policy/lab-packages/import            600 B         104 kB
├ ƒ /api/scoring-policy/preview                        600 B         104 kB
├ ƒ /api/scoring-policy/publish                        600 B         104 kB
├ ƒ /api/search                                        600 B         104 kB
├ ƒ /api/topics                                        600 B         104 kB
├ ƒ /api/v1/patient-summary                            600 B         104 kB
├ ƒ /api/v1/patient-summary/[jobId]                    600 B         104 kB
├ ƒ /appropriateness                                 17.6 kB         266 kB
├ ƒ /ask                                             6.24 kB         179 kB
├ ƒ /ask/trace/[trace_id]                            1.63 kB         108 kB
├ ƒ /audit                                           9.26 kB         112 kB
├ ƒ /audit/login                                       985 B         104 kB
├ ƒ /audit/queries                                     600 B         104 kB
├ ƒ /browse                                            205 B         107 kB
├ ƒ /calculators                                     1.57 kB         108 kB
├ ƒ /calculators/abcd2                               2.57 kB         113 kB
├ ƒ /calculators/abg                                 4.99 kB         112 kB
├ ƒ /calculators/alvarado                            2.41 kB         113 kB
├ ƒ /calculators/curb65                              2.05 kB         112 kB
├ ƒ /calculators/egfr                                2.94 kB         113 kB
├ ƒ /calculators/heart                                  3 kB         113 kB
├ ƒ /calculators/hyponatremia                        5.68 kB         112 kB
├ ƒ /calculators/news2                               3.85 kB         114 kB
├ ƒ /calculators/nihss                               4.27 kB         115 kB
├ ƒ /calculators/qtc                                  2.6 kB         113 kB
├ ƒ /calculators/sepsis-bundle                        4.9 kB         111 kB
├ ƒ /calculators/sofa                                3.55 kB         114 kB
├ ƒ /calculators/timi                                2.19 kB         112 kB
├ ƒ /calculators/wells_dvt                           2.46 kB         113 kB
├ ƒ /calculators/wells_pe                            2.39 kB         113 kB
├ ƒ /care                                              178 B         107 kB
├ ƒ /care/[uid]                                      12.5 kB         124 kB
├ ƒ /care/briefs                                     2.82 kB         109 kB
├ ƒ /care/concepts                                   4.48 kB         239 kB
├ ƒ /care/login                                        982 B         104 kB
├ ƒ /care/lvc                                           6 kB         241 kB
├ ƒ /care/m/[uid]                                    25.3 kB         137 kB
├ ƒ /care/readmissions                               5.21 kB         112 kB
├ ƒ /care/review                                     9.91 kB         113 kB
├ ƒ /care/triage                                     11.2 kB         114 kB
├ ƒ /care/triage/health                              4.65 kB         108 kB
├ ƒ /coach                                           5.91 kB         171 kB
├ ƒ /concordance                                     4.43 kB         108 kB
├ ƒ /ddx                                             9.37 kB         182 kB
├ ƒ /drugs                                           8.86 kB         119 kB
├ ƒ /knowledge                                       3.29 kB         110 kB
├ ƒ /learn                                             205 B         107 kB
├ ƒ /practice                                        3.08 kB         106 kB
├ ƒ /review                                          4.75 kB         108 kB
├ ƒ /search                                            600 B         104 kB
└ ƒ /topics                                           3.4 kB         107 kB
+ First Load JS shared by all                         103 kB
  ├ chunks/3636-b8d66f842f910767.js                    46 kB
  ├ chunks/4bd1b696-100b9d70ed4e49c1.js              54.2 kB
  └ other shared chunks (total)                      2.95 kB


ƒ Middleware                                         34.5 kB

ƒ  (Dynamic)  server-rendered on demand

--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:00Z
```

### Command 4 — npm run architecture:check

```text
COMMAND: npm run architecture:check
STARTED: 2026-08-18T23:50:00Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 architecture:check
> node --import tsx scripts/architecture-check.mjs

rule 1 · GREEN · 26 files scanned · pure clinical cores must not reach up into the app
rule 2 · GREEN · 4 files scanned · advisory must not import score arithmetic (finding types/identity from opd-note-audit-core ARE allowed)
rule 3 · GREEN · 24 files scanned · the spine runs no audit/score logic (VALUE imports; `import type` is allowed)
rule 4 · GREEN · 24 files scanned · the spine must not couple to a prediction layer
rule 5 · GREEN · 8 files scanned · inquiry (advisory) and the scored cores never value-import each other
rule 6 · GREEN · 24 files scanned · the spine must not value-import the IPD audit module
rule 7 · GREEN · 24 files scanned · the frozen spine must not import EpisodeState
rule 8 · GREEN · 24 files scanned · the frozen spine must not import the admission adapter
coverage · GREEN · 39 subsystems · 16 registered, 23 explicitly unregistered

architecture:check — all 8 rules + coverage green.
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:01Z
```

### Command 5 — npm run architecture:map

```text
COMMAND: npm run architecture:map
STARTED: 2026-08-18T23:50:01Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 architecture:map
> node --import tsx scripts/architecture-map-gen.mjs

architecture:map — wrote lib/architecture/map.generated.ts (90492 bytes).
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:01Z
```

### Command 6 — precondition 1: git diff --exit-code -- lib/architecture/map.generated.ts

```text
COMMAND: git diff --exit-code -- lib/architecture/map.generated.ts
STARTED: 2026-08-18T23:50:01Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:01Z
```

### Command 6 — precondition 2: git diff --cached --exit-code -- lib/architecture/map.generated.ts

```text
COMMAND: git diff --cached --exit-code -- lib/architecture/map.generated.ts
STARTED: 2026-08-18T23:50:01Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:01Z
```

### git status immediately before the command 6 five-line block

```text
COMMAND: git status --porcelain (immediately before command 6 five-line block)
COMMAND: git status --porcelain --ignored
!! .env.local
!! .next/
!! .vercel/
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v26-18-AUG-2026.md
!! CDMSS-SAUL-REVIEW-37-18-AUG-2026.md
!! next-env.d.ts
!! node_modules/
!! tsconfig.tsbuildinfo
```

### Command 6 line 1 — npm run architecture:map (generation one)

```text
COMMAND: npm run architecture:map
STARTED: 2026-08-18T23:50:02Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 architecture:map
> node --import tsx scripts/architecture-map-gen.mjs

architecture:map — wrote lib/architecture/map.generated.ts (90492 bytes).
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:02Z
```

### wc -c after generation one (the generator prints UTF-16 code units labelled "bytes"; wc -c counts bytes; the two differ by design)

```text
   90494 lib/architecture/map.generated.ts
```

### Command 6 line 2 — cp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"

```text
COMMAND: cp lib/architecture/map.generated.ts /Users/vinaybhardwaj/cdmss-pass3-repair2-gate-18-aug-2026/gen1.ts
STARTED: 2026-08-18T23:50:02Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:02Z
```

### Command 6 line 3 — npm run architecture:map (generation two)

```text
COMMAND: npm run architecture:map
STARTED: 2026-08-18T23:50:02Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 architecture:map
> node --import tsx scripts/architecture-map-gen.mjs

architecture:map — wrote lib/architecture/map.generated.ts (90492 bytes).
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:02Z
```

### wc -c after generation two

```text
   90494 lib/architecture/map.generated.ts
```

### Command 6 line 4 — cmp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts" (determinism: generation two equals generation one)

```text
COMMAND: cmp lib/architecture/map.generated.ts /Users/vinaybhardwaj/cdmss-pass3-repair2-gate-18-aug-2026/gen1.ts
STARTED: 2026-08-18T23:50:02Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:02Z
```

### Command 6 line 5 — git diff --exit-code -- lib/architecture/map.generated.ts (currency; no git write occurred)

```text
COMMAND: git diff --exit-code -- lib/architecture/map.generated.ts
STARTED: 2026-08-18T23:50:02Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:02Z
```

### git status immediately after the command 6 five-line block

```text
COMMAND: git status --porcelain (immediately after command 6 five-line block)
COMMAND: git status --porcelain --ignored
!! .env.local
!! .next/
!! .vercel/
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v26-18-AUG-2026.md
!! CDMSS-SAUL-REVIEW-37-18-AUG-2026.md
!! next-env.d.ts
!! node_modules/
!! tsconfig.tsbuildinfo
```

### Command 7 — the registry, QUOTED FORM, with timestamps

⚠️ How the quotes were preserved (the same method as every round since v18): the command line in the transcript below was
written into the capture file through a single-quoted heredoc BEFORE executing the identical line, so the single quotes
survive byte-for-byte and do not depend on shell history or any capture mechanism that strips quoting.

### Command 7 transcript

```text
COMMAND (exactly as executed, single quotes included):
bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'
STARTED: 2026-08-18T23:50:03Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 reasoning:registry
> node scripts/reasoning-registry-gen.mjs

reasoning:registry — wrote data/reasoning-registry/prompts.generated.json (88737 bytes; 30 prompts · 7 rubrics · 36 builders · 19 features).
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:03Z
```

### Auxiliary check (not a numbered gate entry) — git diff --exit-code data/reasoning-registry/prompts.generated.json

```text
COMMAND: git diff --exit-code data/reasoning-registry/prompts.generated.json
STARTED: 2026-08-18T23:50:03Z
--- output (stdout+stderr merged) ---
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:03Z
```

### Command 8 — npm run reasoning:governance

```text
COMMAND: npm run reasoning:governance
STARTED: 2026-08-18T23:50:03Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 reasoning:governance
> node scripts/reasoning-governance-check.mjs

reasoning governance — HARD GATE (Stage 4): no direct model calls outside the governed layer

ungoverned model calls (bypass tracedChat/governedChat): 0

parallel run stores: 15 references (INFO — folded into traces since Stage 4)
  info lib/concordance-store.ts:8 — concordance_runs
  info lib/concordance-store.ts:28 — concordance_runs
  info lib/concordance-store.ts:46 — concordance_runs
  info lib/concordance-store.ts:47 — concordance_runs
  info lib/concordance-store.ts:48 — concordance_runs
  info lib/concordance.ts:8 — concordance_runs
  info lib/concordance.ts:9 — concordance_runs
  info app/admin/concordance/page.tsx:58 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:8 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:14 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:31 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:32 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:33 — concordance_runs
  info app/api/admin/concordance/migrate/route.ts:34 — concordance_runs
  info app/api/admin/concordance/runs/route.ts:10 — concordance_runs

reasoning:governance — GREEN: 0 ungoverned model calls; parallel stores folded.
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:03Z
```

### Command 9 — npm run changelog:coverage

```text
COMMAND: npm run changelog:coverage
STARTED: 2026-08-18T23:50:03Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 changelog:coverage
> node scripts/changelog-coverage-check.mjs

changelog:coverage — GREEN: all 19 shipped engine versions documented (30 versioned entries).
--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:03Z
```

### Build pair 1 — the REFUSAL build (CDMSS_TELEMETRY_HMAC_KEY empty; a NONZERO exit is the pass condition, and the error names the key). STARTED and ENDED recorded.

```text
COMMAND: env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY= npm run build
STARTED: 2026-08-18T23:50:03Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 build
> next build

 ⨯ Failed to load next.config.mjs, see more info here https://nextjs.org/docs/messages/next-config-error

> Build error occurred
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3). Set it in Vercel Production before deploying.
    at <unknown> (next.config.mjs:14:9)
--- end output ---
EXIT: 1
ENDED: 2026-08-18T23:50:04Z
```

### Build pair 2 — the KEYED build

```text
COMMAND: env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build
STARTED: 2026-08-18T23:50:04Z
--- output (stdout+stderr merged) ---

> even-cdmss@2.0.0 build
> next build

   ▲ Next.js 15.5.18
   - Environments: .env.local

   Creating an optimized production build ...
 ✓ Compiled successfully in 8.6s
   Linting and checking validity of types ...
   Collecting page data ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
 ⚠ Using edge runtime on a page currently disables static generation for that page
   Generating static pages (0/127) ...
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
The `fetchConnectionCache` option is deprecated (now always `true`)
   Generating static pages (31/127) 
   Generating static pages (63/127) 
The `fetchConnectionCache` option is deprecated (now always `true`)
   Generating static pages (95/127) 
 ✓ Generating static pages (127/127)
   Finalizing page optimization ...
   Collecting build traces ...

Route (app)                                             Size  First Load JS
┌ ƒ /                                                  205 B         107 kB
├ ƒ /_not-found                                      1.01 kB         104 kB
├ ƒ /admin/appropriateness-runs                        600 B         104 kB
├ ƒ /admin/architecture                                205 B         107 kB
├ ƒ /admin/ccb-funnel                                  600 B         104 kB
├ ƒ /admin/concordance                                 205 B         107 kB
├ ƒ /admin/episode-recon-queue                        1.5 kB         108 kB
├ ƒ /admin/eval                                        600 B         104 kB
├ ƒ /admin/ipd-audit                                   178 B         107 kB
├ ƒ /admin/ipd-audit/[id]                            6.16 kB         251 kB
├ ƒ /admin/ipd-audit/calendar                          842 B         107 kB
├ ƒ /admin/ipd-audit/search                            842 B         107 kB
├ ƒ /admin/ipd-gold-queue                             1.6 kB         108 kB
├ ƒ /admin/learning                                  1.76 kB         108 kB
├ ƒ /admin/literature                                  205 B         107 kB
├ ƒ /admin/lvc-ground                                4.23 kB         243 kB
├ ƒ /admin/mini-backfill                             6.58 kB         113 kB
├ ƒ /admin/observability                              5.3 kB         112 kB
├ ƒ /admin/observability/[traceId]                     205 B         107 kB
├ ƒ /admin/observability/adjudications                 178 B         107 kB
├ ƒ /admin/observability/engine-health                 205 B         107 kB
├ ƒ /admin/observability/reconstruction-fidelity       178 B         107 kB
├ ƒ /admin/opd-audit                                 3.48 kB         115 kB
├ ƒ /admin/opd-audit/[id]                            10.9 kB         117 kB
├ ƒ /admin/opd-audit/doctor/[uid]                      180 B         112 kB
├ ƒ /admin/opd-audit/doctors                           205 B         107 kB
├ ƒ /admin/opd-audit/how-it-works                      205 B         107 kB
├ ƒ /admin/opd-audit/vitals-coverage                   205 B         107 kB
├ ƒ /admin/proms-adhoc-review                        3.26 kB         106 kB
├ ƒ /admin/provenance                                  600 B         104 kB
├ ƒ /admin/scoring-policy                              178 B         107 kB
├ ƒ /admin/scoring-policy/lab-packages               2.59 kB         115 kB
├ ƒ /admin/scoring-policy/nabh-completeness            168 B         113 kB
├ ƒ /admin/scoring-policy/nabh-completeness/history    180 B         113 kB
├ ƒ /admin/stewardship                                 205 B         107 kB
├ ƒ /admin/stewardship/dept/[dept]                     205 B         107 kB
├ ƒ /api/admin/appropriateness-runs                    600 B         104 kB
├ ƒ /api/admin/appropriateness-runs/[id]               600 B         104 kB
├ ƒ /api/admin/backfill-corpus-provenance              600 B         104 kB
├ ƒ /api/admin/backfill-stable-ref                     600 B         104 kB
├ ƒ /api/admin/bm25-diag                               600 B         104 kB
├ ƒ /api/admin/ccb-calibration                         600 B         104 kB
├ ƒ /api/admin/complexity-backfill                     600 B         104 kB
├ ƒ /api/admin/concordance/migrate                     600 B         104 kB
├ ƒ /api/admin/concordance/runs                        600 B         104 kB
├ ƒ /api/admin/corpus-eval/status                      600 B         104 kB
├ ƒ /api/admin/episode-recon-rating                    600 B         104 kB
├ ƒ /api/admin/ipd-audit-billed-backfill               600 B         104 kB
├ ƒ /api/admin/ipd-audit-export                        600 B         104 kB
├ ƒ /api/admin/ipd-audit-feedback                      600 B         104 kB
├ ƒ /api/admin/ipd-audit-mini-backfill                 600 B         104 kB
├ ƒ /api/admin/ipd-audit-now                           600 B         104 kB
├ ƒ /api/admin/ipd-gold-adjudication                   600 B         104 kB
├ ƒ /api/admin/lab-batch                               600 B         104 kB
├ ƒ /api/admin/lvc-judge-aa                            600 B         104 kB
├ ƒ /api/admin/lvc-ref-backfill                        600 B         104 kB
├ ƒ /api/admin/mark-mini-labelled-prod                 600 B         104 kB
├ ƒ /api/admin/migrate                                 600 B         104 kB
├ ƒ /api/admin/migrate-adhoc-sets                      600 B         104 kB
├ ƒ /api/admin/migrate-appropriateness-runs            600 B         104 kB
├ ƒ /api/admin/migrate-audit-suppression               600 B         104 kB
├ ƒ /api/admin/migrate-care-call                       600 B         104 kB
├ ƒ /api/admin/migrate-care-tracks                     600 B         104 kB
├ ƒ /api/admin/migrate-ccb                             600 B         104 kB
├ ƒ /api/admin/migrate-ccb-cache                       600 B         104 kB
├ ƒ /api/admin/migrate-choosing-wisely                 600 B         104 kB
├ ƒ /api/admin/migrate-concept-state-key               600 B         104 kB
├ ƒ /api/admin/migrate-doctor-metrics                  600 B         104 kB
├ ƒ /api/admin/migrate-episode-recon                   600 B         104 kB
├ ƒ /api/admin/migrate-episode-states                  600 B         104 kB
├ ƒ /api/admin/migrate-even-ground                     600 B         104 kB
├ ƒ /api/admin/migrate-even-lvc                        600 B         104 kB
├ ƒ /api/admin/migrate-extracted-cases                 600 B         104 kB
├ ƒ /api/admin/migrate-inquiry                         600 B         104 kB
├ ƒ /api/admin/migrate-ipd-audits                      600 B         104 kB
├ ƒ /api/admin/migrate-ipd-gold-union                  600 B         104 kB
├ ƒ /api/admin/migrate-lab                             600 B         104 kB
├ ƒ /api/admin/migrate-lab-views                       600 B         104 kB
├ ƒ /api/admin/migrate-learning                        600 B         104 kB
├ ƒ /api/admin/migrate-lvc-concepts                    600 B         104 kB
├ ƒ /api/admin/migrate-lvc-wording                     600 B         104 kB
├ ƒ /api/admin/migrate-medaudit                        600 B         104 kB
├ ƒ /api/admin/migrate-mini-ticks                      600 B         104 kB
├ ƒ /api/admin/migrate-opd-audits                      600 B         104 kB
├ ƒ /api/admin/migrate-opd-gov-signal                  600 B         104 kB
├ ƒ /api/admin/migrate-opd-longitudinal                600 B         104 kB
├ ƒ /api/admin/migrate-opd-triage                      600 B         104 kB
├ ƒ /api/admin/migrate-proms                           600 B         104 kB
├ ƒ /api/admin/migrate-provenance-tier                 600 B         104 kB
├ ƒ /api/admin/migrate-readmissions                    600 B         104 kB
├ ƒ /api/admin/migrate-reasoning                       600 B         104 kB
├ ƒ /api/admin/migrate-retrieval-telemetry             600 B         104 kB
├ ƒ /api/admin/migrate-scoring-policy                  600 B         104 kB
├ ƒ /api/admin/migrate-v2                              600 B         104 kB
├ ƒ /api/admin/migrate-v6                              600 B         104 kB
├ ƒ /api/admin/migrate-v7                              600 B         104 kB
├ ƒ /api/admin/migrate-v8                              600 B         104 kB
├ ƒ /api/admin/mini-backfill-monitor                   600 B         104 kB
├ ƒ /api/admin/mini-backfill-settings                  600 B         104 kB
├ ƒ /api/admin/ollama-ps                               600 B         104 kB
├ ƒ /api/admin/opd-audit-mini-backfill                 600 B         104 kB
├ ƒ /api/admin/opd-audit/longitudinal-replay           600 B         104 kB
├ ƒ /api/admin/opd-dosing-backfill                     600 B         104 kB
├ ƒ /api/admin/opd-invalid-marking-backfill            600 B         104 kB
├ ƒ /api/admin/opd-rescore-direction                   600 B         104 kB
├ ƒ /api/admin/prognosis-outcome                       600 B         104 kB
├ ƒ /api/admin/proms-adhoc-review                      600 B         104 kB
├ ƒ /api/admin/quieting-dryrun                         600 B         104 kB
├ ƒ /api/admin/reasoning-registry                      600 B         104 kB
├ ƒ /api/admin/recompute-care-call                     600 B         104 kB
├ ƒ /api/admin/refresh-doctor-metrics                  600 B         104 kB
├ ƒ /api/admin/retrieval-telemetry-reconcile           600 B         104 kB
├ ƒ /api/admin/seed-choosing-wisely                    600 B         104 kB
├ ƒ /api/admin/seed-ddi-reference                      600 B         104 kB
├ ƒ /api/admin/seed-formulary                          600 B         104 kB
├ ƒ /api/admin/seed-topics                             600 B         104 kB
├ ƒ /api/admin/seed-topics-tropical                    600 B         104 kB
├ ƒ /api/admin/statpearls-pilot                        600 B         104 kB
├ ƒ /api/admin/sync-doctor-directory                   600 B         104 kB
├ ƒ /api/admin/telemetry-overhead                      600 B         104 kB
├ ƒ /api/admin/tooltip-cache/bump                      600 B         104 kB
├ ƒ /api/admin/traces                                  600 B         104 kB
├ ƒ /api/admin/traces/[traceId]                        600 B         104 kB
├ ƒ /api/admin/unlock                                  600 B         104 kB
├ ƒ /api/appropriateness                               600 B         104 kB
├ ƒ /api/appropriateness/save-run                      600 B         104 kB
├ ƒ /api/ask                                           600 B         104 kB
├ ƒ /api/ask/example-questions                         600 B         104 kB
├ ƒ /api/ask/stage-medians                             600 B         104 kB
├ ƒ /api/audit                                         600 B         104 kB
├ ƒ /api/audit/formulary                               600 B         104 kB
├ ƒ /api/audit/interactions                            600 B         104 kB
├ ƒ /api/audit/login                                   600 B         104 kB
├ ƒ /api/calculators/abcd2                             600 B         104 kB
├ ƒ /api/calculators/abg                               600 B         104 kB
├ ƒ /api/calculators/alvarado                          600 B         104 kB
├ ƒ /api/calculators/curb65                            600 B         104 kB
├ ƒ /api/calculators/egfr                              600 B         104 kB
├ ƒ /api/calculators/heart                             600 B         104 kB
├ ƒ /api/calculators/hyponatremia                      600 B         104 kB
├ ƒ /api/calculators/news2                             600 B         104 kB
├ ƒ /api/calculators/nihss                             600 B         104 kB
├ ƒ /api/calculators/qtc                               600 B         104 kB
├ ƒ /api/calculators/sepsis-bundle                     600 B         104 kB
├ ƒ /api/calculators/sepsis-bundle/sidebar             600 B         104 kB
├ ƒ /api/calculators/sofa                              600 B         104 kB
├ ƒ /api/calculators/timi                              600 B         104 kB
├ ƒ /api/calculators/tooltip                           600 B         104 kB
├ ƒ /api/calculators/typical-latency                   600 B         104 kB
├ ƒ /api/calculators/wells_dvt                         600 B         104 kB
├ ƒ /api/calculators/wells_pe                          600 B         104 kB
├ ƒ /api/care-call/askset                              600 B         104 kB
├ ƒ /api/care-call/outcome                             600 B         104 kB
├ ƒ /api/care-call/outcomes                            600 B         104 kB
├ ƒ /api/care-call/proms/adhoc/generate                600 B         104 kB
├ ƒ /api/care-call/proms/adhoc/update                  600 B         104 kB
├ ƒ /api/care-call/proms/response                      600 B         104 kB
├ ƒ /api/care-call/proms/schedule                      600 B         104 kB
├ ƒ /api/care/assignment                               600 B         104 kB
├ ƒ /api/care/concept/code                             600 B         104 kB
├ ƒ /api/care/concept/status                           600 B         104 kB
├ ƒ /api/care/login                                    600 B         104 kB
├ ƒ /api/care/lvc/generate                             600 B         104 kB
├ ƒ /api/care/lvc/ground                               600 B         104 kB
├ ƒ /api/care/lvc/ground-status                        600 B         104 kB
├ ƒ /api/care/lvc/list                                 600 B         104 kB
├ ƒ /api/care/lvc/ratify                               600 B         104 kB
├ ƒ /api/care/lvc/reject                               600 B         104 kB
├ ƒ /api/care/lvc/retire                               600 B         104 kB
├ ƒ /api/care/member-state                             600 B         104 kB
├ ƒ /api/care/readmissions/list                        600 B         104 kB
├ ƒ /api/care/review-queue                             600 B         104 kB
├ ƒ /api/care/review-stats                             600 B         104 kB
├ ƒ /api/care/workspace                                600 B         104 kB
├ ƒ /api/ccb/brief                                     600 B         104 kB
├ ƒ /api/ccb/brief/stream                              600 B         104 kB
├ ƒ /api/ccb/dossier                                   600 B         104 kB
├ ƒ /api/ccb/episode-docs                              600 B         104 kB
├ ƒ /api/ccb/search                                    600 B         104 kB
├ ƒ /api/ccb/selftest                                  600 B         104 kB
├ ƒ /api/ccb/worker                                    600 B         104 kB
├ ƒ /api/ccb/worklist                                  600 B         104 kB
├ ƒ /api/coach/end                                     600 B         104 kB
├ ƒ /api/coach/respond                                 600 B         104 kB
├ ƒ /api/coach/start                                   600 B         104 kB
├ ƒ /api/concordance/interview                         600 B         104 kB
├ ƒ /api/concordance/single-shot                       600 B         104 kB
├ ƒ /api/cron/curator                                  600 B         104 kB
├ ƒ /api/cron/harvest                                  600 B         104 kB
├ ƒ /api/cron/harvest-epmc                             600 B         104 kB
├ ƒ /api/ddx                                           600 B         104 kB
├ ƒ /api/debug-search                                  600 B         104 kB
├ ƒ /api/debug-stats                                   600 B         104 kB
├ ƒ /api/digest/generate                               600 B         104 kB
├ ƒ /api/doc-audit/analyze                             600 B         104 kB
├ ƒ /api/doc-audit/extract                             600 B         104 kB
├ ƒ /api/drugs/interactions                            600 B         104 kB
├ ƒ /api/drugs/lookup                                  600 B         104 kB
├ ƒ /api/flashcards/due                                600 B         104 kB
├ ƒ /api/flashcards/review                             600 B         104 kB
├ ƒ /api/governance/audit-signal/[reference]           600 B         104 kB
├ ƒ /api/governance/doctor-audits                      600 B         104 kB
├ ƒ /api/governance/doctor-directory                   600 B         104 kB
├ ƒ /api/governance/doctor-response                    600 B         104 kB
├ ƒ /api/governance/opd-signals                        600 B         104 kB
├ ƒ /api/governance/roster-audits                      600 B         104 kB
├ ƒ /api/governance/signal-action                      600 B         104 kB
├ ƒ /api/health                                        600 B         104 kB
├ ƒ /api/ipd-audit/review                              600 B         104 kB
├ ƒ /api/ipd-audit/worker                              600 B         104 kB
├ ƒ /api/lab/ml-label-trial                            600 B         104 kB
├ ƒ /api/learning/mine                                 600 B         104 kB
├ ƒ /api/learning/review                               600 B         104 kB
├ ƒ /api/log/query                                     600 B         104 kB
├ ƒ /api/mcp                                           600 B         104 kB
├ ƒ /api/mcp/[key]                                     600 B         104 kB
├ ƒ /api/opd-audit/backfill                            600 B         104 kB
├ ƒ /api/opd-audit/export-pdf                          600 B         104 kB
├ ƒ /api/opd-audit/feedback                            600 B         104 kB
├ ƒ /api/opd-audit/reset                               600 B         104 kB
├ ƒ /api/opd-audit/run                                 600 B         104 kB
├ ƒ /api/opd-audit/worker                              600 B         104 kB
├ ƒ /api/opd-triage/decide                             600 B         104 kB
├ ƒ /api/opd-triage/longitudinal-lane                  600 B         104 kB
├ ƒ /api/opd-triage/queue                              600 B         104 kB
├ ƒ /api/opd-triage/signal-health                      600 B         104 kB
├ ƒ /api/opd-triage/suppressions                       600 B         104 kB
├ ƒ /api/pathway/enrich                                600 B         104 kB
├ ƒ /api/pathway/skeleton                              600 B         104 kB
├ ƒ /api/practice/next                                 600 B         104 kB
├ ƒ /api/readmission/worker                            600 B         104 kB
├ ƒ /api/scoring-policy                                600 B         104 kB
├ ƒ /api/scoring-policy/draft                          600 B         104 kB
├ ƒ /api/scoring-policy/lab-packages/export            600 B         104 kB
├ ƒ /api/scoring-policy/lab-packages/import            600 B         104 kB
├ ƒ /api/scoring-policy/preview                        600 B         104 kB
├ ƒ /api/scoring-policy/publish                        600 B         104 kB
├ ƒ /api/search                                        600 B         104 kB
├ ƒ /api/topics                                        600 B         104 kB
├ ƒ /api/v1/patient-summary                            600 B         104 kB
├ ƒ /api/v1/patient-summary/[jobId]                    600 B         104 kB
├ ƒ /appropriateness                                 17.6 kB         266 kB
├ ƒ /ask                                             6.24 kB         179 kB
├ ƒ /ask/trace/[trace_id]                            1.63 kB         108 kB
├ ƒ /audit                                           9.26 kB         112 kB
├ ƒ /audit/login                                       985 B         104 kB
├ ƒ /audit/queries                                     600 B         104 kB
├ ƒ /browse                                            205 B         107 kB
├ ƒ /calculators                                     1.57 kB         108 kB
├ ƒ /calculators/abcd2                               2.57 kB         113 kB
├ ƒ /calculators/abg                                 4.99 kB         112 kB
├ ƒ /calculators/alvarado                            2.41 kB         113 kB
├ ƒ /calculators/curb65                              2.05 kB         112 kB
├ ƒ /calculators/egfr                                2.94 kB         113 kB
├ ƒ /calculators/heart                                  3 kB         113 kB
├ ƒ /calculators/hyponatremia                        5.68 kB         112 kB
├ ƒ /calculators/news2                               3.85 kB         114 kB
├ ƒ /calculators/nihss                               4.27 kB         115 kB
├ ƒ /calculators/qtc                                  2.6 kB         113 kB
├ ƒ /calculators/sepsis-bundle                        4.9 kB         111 kB
├ ƒ /calculators/sofa                                3.55 kB         114 kB
├ ƒ /calculators/timi                                2.19 kB         112 kB
├ ƒ /calculators/wells_dvt                           2.46 kB         113 kB
├ ƒ /calculators/wells_pe                            2.39 kB         113 kB
├ ƒ /care                                              178 B         107 kB
├ ƒ /care/[uid]                                      12.5 kB         124 kB
├ ƒ /care/briefs                                     2.82 kB         109 kB
├ ƒ /care/concepts                                   4.48 kB         239 kB
├ ƒ /care/login                                        982 B         104 kB
├ ƒ /care/lvc                                           6 kB         241 kB
├ ƒ /care/m/[uid]                                    25.3 kB         137 kB
├ ƒ /care/readmissions                               5.21 kB         112 kB
├ ƒ /care/review                                     9.91 kB         113 kB
├ ƒ /care/triage                                     11.2 kB         114 kB
├ ƒ /care/triage/health                              4.65 kB         108 kB
├ ƒ /coach                                           5.91 kB         171 kB
├ ƒ /concordance                                     4.43 kB         108 kB
├ ƒ /ddx                                             9.37 kB         182 kB
├ ƒ /drugs                                           8.86 kB         119 kB
├ ƒ /knowledge                                       3.29 kB         110 kB
├ ƒ /learn                                             205 B         107 kB
├ ƒ /practice                                        3.08 kB         106 kB
├ ƒ /review                                          4.75 kB         108 kB
├ ƒ /search                                            600 B         104 kB
└ ƒ /topics                                           3.4 kB         107 kB
+ First Load JS shared by all                         103 kB
  ├ chunks/3636-b8d66f842f910767.js                    46 kB
  ├ chunks/4bd1b696-100b9d70ed4e49c1.js              54.2 kB
  └ other shared chunks (total)                      2.95 kB


ƒ Middleware                                         34.5 kB

ƒ  (Dynamic)  server-rendered on demand

--- end output ---
EXIT: 0
ENDED: 2026-08-18T23:50:38Z
```

### git status after the whole gate

```text
COMMAND: git status --porcelain
COMMAND: git status --porcelain --ignored
!! .env.local
!! .next/
!! .vercel/
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v26-18-AUG-2026.md
!! CDMSS-SAUL-REVIEW-37-18-AUG-2026.md
!! next-env.d.ts
!! node_modules/
!! tsconfig.tsbuildinfo
```

### Gate command log (labels and exit statuses, in execution order)

```text
GATE START 2026-08-18T23:48:59Z at commit ac0155cda011dbac3f00410838d14990340b9287
cmd-1-npm-test exit=0
cmd-2-typecheck exit=0
cmd-3-build-keyed exit=0
cmd-4-architecture-check exit=0
cmd-5-architecture-map exit=0
cmd-6-precondition-1 exit=0
cmd-6-precondition-2 exit=0
cmd-6-line-1-map exit=0
cmd-6-line-2-cp exit=0
cmd-6-line-3-map exit=0
cmd-6-line-4-cmp exit=0
cmd-6-line-5-gitdiff exit=0
cmd-7-registry exit=0
cmd-7-aux-gitdiff exit=0
cmd-8-reasoning-governance exit=0
cmd-9-changelog-coverage exit=0
build-pair-1-refusal exit=1 (nonzero expected)
build-pair-2-keyed exit=0
GATE END 2026-08-18T23:50:38Z
```

## Part 3 — evidence integrity

The TEN earlier evidence files, hashed at this pass — the six pinned by addendum v20 §6.1, the supplemental-3 file pinned
in commit f6e9188's message, the supplemental-4 file pinned in commit 01c2375's message, the pass 3 file pinned in commit
a4ef66e's message, and the pass 3 repair file pinned in commit fb5e9d5's message — every one must match:

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

All ten digests match their pinned values (v20 §6.1 for the first six; `f80c7591…` from f6e9188's message; `a5ff9ff2…`
from 01c2375's message; `d4eb69da…` from a4ef66e's message; `1e313c93…` from fb5e9d5's message). No earlier evidence
file, report, addendum or review was edited in this pass; addendum v19 stands unchanged. Addendum v24 is no longer in the
worktree root (review 37 records it outside the worktree); the ignored check showed exactly two lines throughout — v26
and review 37 — and the post-commit-18 no-ignored-CDMSS check is in the builder's report.
