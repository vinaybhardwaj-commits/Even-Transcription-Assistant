# CDMSS — Telemetry pass 4a: gate evidence and mutation table

**Date:** 21 August 2026 (IST)
**Kickoff:** `CDMSS-TELEMETRY-PASS4A-KICKOFF-20-AUG-2026.md`. Ruling authority Saul Rep 40 (order D) and Rep 41 (risk order).
**Base:** `exp/rerank-telemetry` @ `29572cf` (documentation-only; the last code commit is `ac0155c`).
**Branch / worktree:** `t4a` at `/Users/vinaybhardwaj/dev/t4a`.
**Build commit:** `5e9aed5`.
**Changed path (one, per §6):** `lib/__tests__/retrieval-telemetry-lifecycle.test.ts`.

**Scope held:** proofs **23 and 24 only**. No fault seam was built. Proofs 21 and 22 were not attempted.

---

## 1. Did any part of 23 or 24 need a new seam? — NO

Stated explicitly because §10 requires it. **Neither proof needed a seam, and none was built.** Both
are reached with `retrievalTerminalsSeam` (`lib/opd-note-audit.ts:821-831`), which already exists and
was accepted for proof 47, plus the transport stub `lib/__tests__/telemetry-db-stub.ts`. Nothing in
`lib/opd-note-audit.ts` or any other production file was touched, and the build commit shows exactly
one path.

The kickoff's §1 table proved accurate: 23 needs an execution-order observation and 24 is
transport-level plus two source pins, and neither requires driving `auditOpdNote` with injected
throws.

---

## 2. The four hashes — all agree

The tested bytes are the committed bytes.

```
worktree BEFORE the table   24b91eb8f78fbea51604d9d5f618399ac73ac55a174813ecc716f4da22db3f33
sandbox baseline            24b91eb8f78fbea51604d9d5f618399ac73ac55a174813ecc716f4da22db3f33
worktree AFTER the table    24b91eb8f78fbea51604d9d5f618399ac73ac55a174813ecc716f4da22db3f33
git show HEAD:<path>        24b91eb8f78fbea51604d9d5f618399ac73ac55a174813ecc716f4da22db3f33
```

## 3. Sandbox shape, verified before use

```
dotfiles present     : .env.example  .github  .gitignore  .npmrc
lib/__tests__ present: yes
.git absent          : yes
.next absent         : yes
node_modules         : symlink
cmp sandbox baseline vs worktree: identical
```

No git command was issued inside the sandbox at any point. No `git checkout --` was run anywhere.
The sandbox was deleted when the table completed.

---

## 4. The mutation table — 7 rows, run BEFORE the gate

Every row failed its named test **by name**. No row was a file-level timeout. No row altered judge
lifecycle or recorder counting (review 34 standing condition). Each row mutates a **production**
file: the point is to show the new tests detect a real regression, not to show the tests detect edits
to themselves.

### M1 — proof 23, target test `23.1`

**Load-bearing claim:** both role terminals reach the database transport, primary first  
**File mutated:** `lib/opd-note-audit.ts` (a production file; the test file under proof is never mutated)

```diff
--- /Users/vinaybhardwaj/dev/t4a/lib/opd-note-audit.ts	2026-08-21 06:32:58
+++ /Users/vinaybhardwaj/dev/t4a-sandbox/lib/opd-note-audit.ts	2026-08-21 06:40:38
@@ -796,7 +796,7 @@
     // is handed here is what was known here.
     publishHandle(handle, { ...defectsByRole });
 
-    if (args.normativeCapture) {
+    if (!args.normativeCapture) {
       // NORMATIVE carries null: the combined-context HMAC lives on the primary row, and duplicating
       // it here would imply this leg produced a context of its own. Its expansion stage is also
       // always `skipped` (normativeChannelOpts sets skipExpand unconditionally), which is why the
```

```
command : node --test --import tsx "lib/__tests__/retrieval-telemetry-lifecycle.test.ts"
cwd     : /Users/vinaybhardwaj/dev/t4a-sandbox
STARTED : 2026-08-21T01:10:38.699Z
ENDED   : 2026-08-21T01:10:39.874Z
exit    : 1
counts  : # tests 19  # pass 17  # fail 2
```

**Failing test, by name, TAP line verbatim:**

```
not ok 14 - 23.1 — OBSERVED AT EXECUTION: zero terminal writes have reached the transport when assembleAuditContext returns, and both arrive after it — never between primary retrieval and context assembly
```

Also failing in the same run (collateral, not the target):

```
not ok 15 - 23.2 — OBSERVED AT EXECUTION, and this is the load-bearing half: the primary row carries the keyed HMAC of exactly assembleAuditContext's bytes, which is NOT the HMAC of the context that existed at step 7 — so the write cannot have happened there
```

**Restore:** `cp` pristine → sandbox, then `cmp <worktree> <sandbox>` → identical, exit 0.

### M2 — proof 23, target test `23.2`

**Load-bearing claim:** the primary payload is keyed with exactly assembleAuditContext's citedContext  
**File mutated:** `lib/opd-note-audit.ts` (a production file; the test file under proof is never mutated)

```diff
--- /Users/vinaybhardwaj/dev/t4a/lib/opd-note-audit.ts	2026-08-21 06:32:58
+++ /Users/vinaybhardwaj/dev/t4a-sandbox/lib/opd-note-audit.ts	2026-08-21 06:40:39
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

```
command : node --test --import tsx "lib/__tests__/retrieval-telemetry-lifecycle.test.ts"
cwd     : /Users/vinaybhardwaj/dev/t4a-sandbox
STARTED : 2026-08-21T01:10:39.890Z
ENDED   : 2026-08-21T01:10:40.430Z
exit    : 1
counts  : # tests 19  # pass 18  # fail 1
```

**Failing test, by name, TAP line verbatim:**

```
not ok 15 - 23.2 — OBSERVED AT EXECUTION, and this is the load-bearing half: the primary row carries the keyed HMAC of exactly assembleAuditContext's bytes, which is NOT the HMAC of the context that existed at step 7 — so the write cannot have happened there
```

**Restore:** `cp` pristine → sandbox, then `cmp <worktree> <sandbox>` → identical, exit 0.

### M3 — proof 23, target test `23.3`

**Load-bearing claim:** the production caller assembles over BOTH hit sets before the terminal write  
**File mutated:** `lib/opd-note-audit.ts` (a production file; the test file under proof is never mutated)

```diff
--- /Users/vinaybhardwaj/dev/t4a/lib/opd-note-audit.ts	2026-08-21 06:32:58
+++ /Users/vinaybhardwaj/dev/t4a-sandbox/lib/opd-note-audit.ts	2026-08-21 06:40:40
@@ -1613,7 +1613,7 @@
     // STEP 7. `assembleAuditContext` runs over BOTH hit sets and is the only place the exact bytes
     // that reach the scorer exist; inside either retrieval call they do not exist yet, so a
     // scorer-context HMAC written there would be a hash of something the scorer never saw.
-    const { sources, citedContext } = assembleAuditContext(hits, normHits);
+    const { sources, citedContext } = assembleAuditContext(hits, []);
     // STEPS 10-13 — HMAC the combined context, build both payloads, write both terminals, and
     // publish the handle after each so a throw below still leaves the caller holding the latest.
     if (tele && handle) {
```

```
command : node --test --import tsx "lib/__tests__/retrieval-telemetry-lifecycle.test.ts"
cwd     : /Users/vinaybhardwaj/dev/t4a-sandbox
STARTED : 2026-08-21T01:10:40.443Z
ENDED   : 2026-08-21T01:10:40.956Z
exit    : 1
counts  : # tests 19  # pass 18  # fail 1
```

**Failing test, by name, TAP line verbatim:**

```
not ok 16 - 23.3 — SUPPORTING SOURCE PIN ONLY (23.1 and 23.2 are the proof): in comment-stripped source, auditOpdNote retrieves, then assembles, then writes the terminals — and issues no terminal write in between
```

**Restore:** `cp` pristine → sandbox, then `cmp <worktree> <sandbox>` → identical, exit 0.

### M4 — proof 24, target test `24.1`

**Load-bearing claim:** trace_id is not among the fourteen columns the declaration INSERT binds  
**File mutated:** `lib/retrieval-telemetry-store.ts` (a production file; the test file under proof is never mutated)

```diff
--- /Users/vinaybhardwaj/dev/t4a/lib/retrieval-telemetry-store.ts	2026-08-21 06:32:58
+++ /Users/vinaybhardwaj/dev/t4a-sandbox/lib/retrieval-telemetry-store.ts	2026-08-21 06:40:40
@@ -212,7 +212,7 @@
     landed = (await sql(
       `INSERT INTO opd_audit_retrieval_telemetry
          (retrieval_run_id, retrieval_role, route, invocation_id, app_source, deployment_sha,
-          telemetry_schema_version, persistence_state, started_at, uid, engine_version,
+          telemetry_schema_version, persistence_state, started_at, uid, trace_id,
           experiment_run_id, pair_id, replicate)
        VALUES ${values}
        ON CONFLICT (retrieval_run_id) DO NOTHING
```

```
command : node --test --import tsx "lib/__tests__/retrieval-telemetry-lifecycle.test.ts"
cwd     : /Users/vinaybhardwaj/dev/t4a-sandbox
STARTED : 2026-08-21T01:10:40.968Z
ENDED   : 2026-08-21T01:10:41.504Z
exit    : 1
counts  : # tests 19  # pass 18  # fail 1
```

**Failing test, by name, TAP line verbatim:**

```
not ok 17 - 24.1 — the declaration INSERT binds FOURTEEN columns at the transport and trace_id is not among them: the column is never written at declaration, and is not written as null either — it is not in the statement at all
```

**Restore:** `cp` pristine → sandbox, then `cmp <worktree> <sandbox>` → identical, exit 0.

### M5 — proof 24, target test `24.2`

**Load-bearing claim:** the terminal UPDATE assigns trace_id at $6  
**File mutated:** `lib/retrieval-telemetry-store.ts` (a production file; the test file under proof is never mutated)

```diff
--- /Users/vinaybhardwaj/dev/t4a/lib/retrieval-telemetry-store.ts	2026-08-21 06:32:58
+++ /Users/vinaybhardwaj/dev/t4a-sandbox/lib/retrieval-telemetry-store.ts	2026-08-21 06:40:41
@@ -313,7 +313,7 @@
               retrieval_outcome = $3,
               retrieval_error_class = $4,
               completed_at = $5,
-              trace_id = $6,
+              trace_id = $7,
               expansion_status = $7,
               expansion_route_class = $8,
               expansion_served_model = $9,
```

```
command : node --test --import tsx "lib/__tests__/retrieval-telemetry-lifecycle.test.ts"
cwd     : /Users/vinaybhardwaj/dev/t4a-sandbox
STARTED : 2026-08-21T01:10:41.516Z
ENDED   : 2026-08-21T01:10:42.017Z
exit    : 1
counts  : # tests 19  # pass 18  # fail 1
```

**Failing test, by name, TAP line verbatim:**

```
not ok 18 - 24.2 — the terminal UPDATE writes trace_id at $6, and binds exactly what the caller was holding — the sentinel when there is a trace, null when there is not
```

**Restore:** `cp` pristine → sandbox, then `cmp <worktree> <sandbox>` → identical, exit 0.

### M6 — proof 24, target test `24.3`

**Load-bearing claim:** caller 1 of 2 — lib/mcp-tools.ts audits with trace: false  
**File mutated:** `lib/mcp-tools.ts` (a production file; the test file under proof is never mutated)

```diff
--- /Users/vinaybhardwaj/dev/t4a/lib/mcp-tools.ts	2026-08-21 06:32:58
+++ /Users/vinaybhardwaj/dev/t4a-sandbox/lib/mcp-tools.ts	2026-08-21 06:40:42
@@ -484,7 +484,7 @@
     let handle: LifecycleHandle | null = null;
     let published = false;
     const audit = await auditOpdNote(row, {
-      pipeline: 'mini', engineTag: 'lab', trace: false, ...(evalModel ? { evalModel } : {}),
+      pipeline: 'mini', engineTag: 'lab', ...(evalModel ? { evalModel } : {}),
       ...(ctx ? {
         telemetry: { ctx, route: 'mcp_tools' as const, persistenceIntent: 'never_persists' as const },
         onLifecycleHandleUpdated: (h: LifecycleHandle) => { handle = h; published = true; },
```

```
command : node --test --import tsx "lib/__tests__/retrieval-telemetry-lifecycle.test.ts"
cwd     : /Users/vinaybhardwaj/dev/t4a-sandbox
STARTED : 2026-08-21T01:10:42.030Z
ENDED   : 2026-08-21T01:10:42.515Z
exit    : 1
counts  : # tests 19  # pass 18  # fail 1
```

**Failing test, by name, TAP line verbatim:**

```
not ok 19 - 24.3 — both trace:false callers, and the mechanism that makes their rows null: lib/mcp-tools.ts and scripts/metamorphic-llm-report.mjs each audit with trace:false AND telemetry wired, and auditOpdNote turns that flag into a null traceId at the terminal write
```

**Restore:** `cp` pristine → sandbox, then `cmp <worktree> <sandbox>` → identical, exit 0.

### M7 — proof 24, target test `24.3`

**Load-bearing claim:** caller 2 of 2 — scripts/metamorphic-llm-report.mjs audits with trace: false  
**File mutated:** `scripts/metamorphic-llm-report.mjs` (a production file; the test file under proof is never mutated)

```diff
--- /Users/vinaybhardwaj/dev/t4a/scripts/metamorphic-llm-report.mjs	2026-08-21 06:32:58
+++ /Users/vinaybhardwaj/dev/t4a-sandbox/scripts/metamorphic-llm-report.mjs	2026-08-21 06:40:42
@@ -68,7 +68,7 @@
       let published = false;
       try {
         const audit = await auditOpdNote(row, {
-          pipeline: 'mini', engineTag: 'lab', trace: false,
+          pipeline: 'mini', engineTag: 'lab',
           telemetry: { ctx: TELEMETRY_CTX, route: 'script', persistenceIntent: 'never_persists' },
           onLifecycleHandleUpdated: (h) => { handle = h; published = true; },
         });
```

```
command : node --test --import tsx "lib/__tests__/retrieval-telemetry-lifecycle.test.ts"
cwd     : /Users/vinaybhardwaj/dev/t4a-sandbox
STARTED : 2026-08-21T01:10:42.528Z
ENDED   : 2026-08-21T01:10:42.994Z
exit    : 1
counts  : # tests 19  # pass 18  # fail 1
```

**Failing test, by name, TAP line verbatim:**

```
not ok 19 - 24.3 — both trace:false callers, and the mechanism that makes their rows null: lib/mcp-tools.ts and scripts/metamorphic-llm-report.mjs each audit with trace:false AND telemetry wired, and auditOpdNote turns that flag into a null traceId at the terminal write
```

**Restore:** `cp` pristine → sandbox, then `cmp <worktree> <sandbox>` → identical, exit 0.
### Coverage of the table

| Row | Proof | Named test | Claim killed |
|---|---|---|---|
| M1 | 23 | 23.1 | both role terminals reach the transport, primary first |
| M2 | 23 | 23.2 | the primary payload is keyed with exactly `assembleAuditContext`'s `citedContext` |
| M3 | 23 | 23.3 | the production caller assembles over BOTH hit sets before the terminal write |
| M4 | 24 | 24.1 | `trace_id` is not among the fourteen declared columns |
| M5 | 24 | 24.2 | the terminal UPDATE assigns `trace_id` at `$6` |
| M6 | 24 | 24.3 | caller 1 of 2 — `lib/mcp-tools.ts` audits with `trace: false` |
| M7 | 24 | 24.3 | caller 2 of 2 — `scripts/metamorphic-llm-report.mjs` audits with `trace: false` |

M6 and M7 are deliberately separate rows. Kickoff v11 `:126` says **both** callers, not one; two rows
are what makes "both" load-bearing rather than decorative.

### One honest limit of row M1, stated rather than glossed

23.1 asserts three things: that no terminal write has reached the transport when
`assembleAuditContext` returns, that both writes arrive after it, and that the primary is first.
**Only the second and third are falsifiable by mutating production.** The first is not, because the
test itself chooses when to call `assembleAuditContext`, and no production edit can make a statement
appear at the transport before the test issues it.

That is the structural limit of proving 23 without driving `auditOpdNote`, and it is why **23.2 is
named in its own title as the load-bearing half**: the data dependency — the row carries the HMAC of
assembly's output and demonstrably not the HMAC of the context that existed at step 7 — is what makes
the ordering *necessary* rather than merely observed, and M2 kills it. 23.3 then pins the caller's
written order, and M3 kills that. The three together are what the proof rests on; 23.1 alone is not.

---

## 5. The gate — nine commands plus the build pair

### Command 1 — `npm test` — **RED, pre-existing and unrelated. See §6.**

```
# tests 3613
# suites 0
# pass 3586
# fail 27
# cancelled 0
# skipped 0
# todo 0
```

Observed total **3613**, never predeclared. The base recorded 3607 at `ac0155c`; pass 4a adds 6
tests, so 3607 + 6 = 3613 and the arithmetic closes exactly. All 27 failures are in one file that
this unit did not touch.

### Command 2 — `npm run typecheck`

```
> even-cdmss@2.0.0 typecheck
> tsc --noEmit
```

Exit 0, no output. Run again before the build commit, as §8 requires.

### Command 3 — `npm run build`

Exit 0. See also the build pair below.

### Command 4 — `npm run architecture:check`

```
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
```

Matches the expected values at `ac0155c` exactly: 8 rules green, 39 subsystems, 16 registered, 23
unregistered.

### Command 5 — `npm run architecture:map`

```
architecture:map — wrote lib/architecture/map.generated.ts (90492 bytes).
```

**90492 bytes — the expected value. The map did not move.** A test-only change must not move it, and
it did not.

(`wc -c` on the same file reports 90494. That is not a discrepancy in the map: the generator prints
`src.length`, a count of UTF-16 code units, while `wc -c` counts bytes, and the file contains one
three-byte UTF-8 character. The gate's stated number is the generator's, and it matches.)

### Command 6 — map determinism + currency, the NO-`git add` form (addendum v18 §4.1)

```
precondition  git diff --exit-code lib/architecture/map.generated.ts          → exit 0, clean
precondition  git diff --cached --exit-code lib/architecture/map.generated.ts → exit 0, clean
generate twice, cmp generation A vs generation B                              → identical
post          git diff --exit-code lib/architecture/map.generated.ts          → exit 0, clean
```

No git write was performed. The deprecated `git add` form — which would let a map change pass
silently and land staged — was not used.

### Command 7 — `npm run reasoning:registry` + diff

```
reasoning:registry — wrote data/reasoning-registry/prompts.generated.json (88737 bytes; 30 prompts · 7 rubrics · 36 builders · 19 features).
git diff --exit-code data/reasoning-registry/prompts.generated.json → exit 0, clean
```

30 prompts / 7 rubrics / 36 builders / 19 features — matches the expected values at `ac0155c`.

### Command 8 — `npm run reasoning:governance`

```
reasoning:governance — GREEN: 0 ungoverned model calls; parallel stores folded.
```

### Command 9 — `npm run changelog:coverage`

```
changelog:coverage — GREEN: all 19 shipped engine versions documented (30 versioned entries).
```

19 engine versions — matches. Command 9 is read-only and **no changelog entry was added to satisfy
it**. No engine bump.

### The build pair

**A — unkeyed production build MUST fail and MUST name the key:**

```
$ env -u CDMSS_TELEMETRY_HMAC_KEY VERCEL=1 VERCEL_ENV=production npm run build
exit=1
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every
patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3).
Set it in Vercel Production before deploying.
    at <unknown> (next.config.mjs:14:9)
```

**B — keyed production build MUST succeed:**

```
$ env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=pass4a-gate-key npm run build
exit=0
 ✓ Compiled successfully in 10.4s
```

Both arms behave as specified.

---

## 6. STOP-AND-REPORT: gate command 1 is red at the base, from a fired deletion deadline

**This is not caused by pass 4a, and pass 4a did not repair it.**

27 tests fail, all of them in `lib/__tests__/telemetry-overhead-guard.test.ts` — a file outside this
unit's contract, untouched here.

**Cause.** `app/api/admin/telemetry-overhead/route.ts:53` sets:

```ts
const EXPIRES_AT_UTC = Date.UTC(2026, 7, 20, 0, 0, 0);   // 2026-08-20T00:00:00Z = 20 Aug 05:30 IST
```

Guard 2 was deliberately **moved from fifth to second** in addendum v5 §9.1 so that "after 2026-08-20
every request is 410 whatever else is configured" would be true rather than false. It is now true.
Today is 21 August 2026, so every authenticated request short-circuits to 410 before reaching guards
3, 4 and 5 — which is precisely what the 27 failing cases exercise, and they assert 403.

**Proof that it is pre-existing.** This change was stashed and the file run against a pristine
`29572cf`:

```
$ git stash push -- lib/__tests__/retrieval-telemetry-lifecycle.test.ts
$ node --test --import tsx "lib/__tests__/telemetry-overhead-guard.test.ts"
# tests 31
# pass 4
# fail 27
```

Identical count with pass 4a absent. `29572cf` is documentation-only over `ac0155c`, and neither the
route nor the guard test differs between them, so `ac0155c` fails the same way today.

**The four survivors are the tell.** They are exactly the cases that do not depend on the ambient
clock:

```
ok 1  - GUARD 1 — admin: a set ADMIN_TOKEN with nothing presented is refused  (guard 1 runs BEFORE guard 2)
ok 9  - GUARD 2 — expiry: past the hard UTC date every request is 410         (pins its own clock forward)
ok 10 - GUARD 2 — before the expiry the route still runs                      (pins its own clock back)
ok 31 - the route is POST-only, and carries its own expiry and deletion notice in source  (source pin)
```

Every other case reads the wall clock through the route, and the wall clock has moved past the
deadline.

**This is the route's own demolition charge firing as designed.** Addendum v4 §12 records that
`app/api/admin/telemetry-overhead/route.ts` is temporary and **owed a deletion**, and the guard test's
own header says "when the route goes, this file goes with it." The expiry did what it was written to
do; what has not happened is the deletion.

**Why it was not fixed here.** §6 of the pass 4a kickoff puts `app/api/**` owner routes on the
do-not-touch list and says any production repair outside scope is stop-and-report. Deleting the route
and its test is a scope decision with a governance record behind it (addendum v4 §12), not a coder's
call. It is reported.

**What it does not affect.** Nothing in this failure touches retrieval telemetry's lifecycle, the
handle, the manifest, or either proof. `lib/__tests__/retrieval-telemetry-lifecycle.test.ts` is
19/19 green, and every other gate command is green.
