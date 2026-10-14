# CDMSS — Telemetry pass 4b: gate evidence

**Date:** 21 August 2026 (IST)
**Kickoff:** `CDMSS-TELEMETRY-PASS4B-KICKOFF-21-AUG-2026.md` (Saul Rep 42 — seam shape, fault points and per-proof contract are his).
**Base:** branch `t4a` @ `5994922`. **Build commit:** `12a4565`.
**Worktree:** `/Users/vinaybhardwaj/dev/t4b`, branch `t4b`, clean.
**Pushed:** **No.** V pushes.

---

## 1. What pass 4a's proof 23 was, and what this replaces it with

Pass 4a called `assembleAuditContext` and then called the terminal seam itself. The test's own
choreography guaranteed the ordering it claimed to prove; it never executed `auditOpdNote`. Rep 42
held 23 out of that pass and recorded the cause as an **Orchestrator specification error**.

Every proof here drives the real `auditOpdNote` through the wrapper and reads the transport. The
five fault points, the seam shape and the per-proof contract are Rep 42's.

## 2. The seam — exact declaration text

```ts
export const auditOpdLifecycleTestSeam: {
  readonly run: (row: Record<string, unknown>, opts: AuditOpdOpts, plan: LifecycleFaultPlan) => Promise<OpdNoteAudit>;
} = Object.freeze({
  run(row: Record<string, unknown>, opts: AuditOpdOpts, plan: LifecycleFaultPlan): Promise<OpdNoteAudit> {
    const planned: AuditOpdOpts = { ...opts };
    Object.defineProperty(planned, LIFECYCLE_FAULT_PLAN, {
      value: Object.freeze({
        faultAt: plan.faultAt,
        primaryHits: Object.freeze(plan.primaryHits.map((h) => Object.freeze({ ...h }))),
        normativeHits: Object.freeze(plan.normativeHits.map((h) => Object.freeze({ ...h }))),
      }),
      enumerable: false, writable: false, configurable: false,
    });
    return auditOpdNote(row, planned);
  },
});
```

Rep 42's seven properties, each with the assertion that holds it:

| # | Property | Where it is held |
|---|---|---|
| 1 | module-private `Symbol` carries an immutable per-call plan | `const LIFECYCLE_FAULT_PLAN = Symbol(…)`, never exported — `4B-SEAM.1` |
| 2 | frozen exported wrapper clones opts, attaches non-enumerable / non-writable / non-configurable | declaration above — `4B-SEAM.1`, `4B-SEAM.2` |
| 3 | the wrapper calls the **real** `auditOpdNote` | `return auditOpdNote(row, planned);` — and every proof below executes it |
| 4 | `AuditOpdOpts` and every production call site unchanged | `4B-SEAM.1`; `git show --stat` shows two files |
| 5 | no mutable module-level state, no install/reset, no cross-test cleanup | `4B-SEAM.1` (`no export let/var`, no install/reset symbol) |
| 6 | parallel calls carry independent plans | `4B-SEAM.4` — two concurrent runs, each keeping its own fault |
| 7 | deterministic fixtures replace provider calls only when the plan exists | `4B-SEAM.3` — **normative leg only; see deviation 1** |

`retrievalTerminalsSeam` is untouched. The `AuditOpdOpts` interface is byte-identical.

### Rep 42's v11 interpretation, transcribed into the module

Present verbatim in the doc block above `auditOpdNote`: no production caller invokes the wrapper;
no plan exists on production options; no injected collaborator or fault hook runs when the private
symbol is absent — and **a single absent private-symbol read inside the shared core is permitted,
without which no in-function fault seam could exist.**

`4B-SEAM.3` asserts there is **exactly one** `[LIFECYCLE_FAULT_PLAN]` read in the whole module.

## 3. The five fault points — Rep 42's names, final line numbers

| `faultAt` | Line | Placement as built |
|---|---|---|
| — (the single read) | `lib/opd-note-audit.ts:1717` | immediately before the outer `try`, after declaration publication |
| `after_declaration` | `:1720` | first statement inside the existing outer `try` |
| `after_primary_retrieval` | `:1734` | immediately after primary retrieval resolves |
| `after_normative_retrieval` | `:1741` | immediately after normative retrieval resolves |
| `during_context_assembly` | `:1746` | immediately before `assembleAuditContext` |
| `during_generation` | `:1762` | after both terminal writes and both publications, immediately before generation work |

`during_generation` sits immediately before `const specialty = await doctorSpecialtyFor(…)`. The
specialty is read for `buildOpdAuditUser`'s prompt and is used nowhere else, so that line is where
generation work begins; everything above it is telemetry.

**There is no expansion point and no rerank point.** Both are internal to primary retrieval and
neither is a separate D11 handle state. `4B-SEAM.3` asserts the five guarded sites are exactly
Rep 42's names in D11 order.

## 4. How a swallowed fault is surfaced (kickoff §5.1)

The outer catch returns a deterministic-only audit for every non-eval throw. Left there, **all five
faults would produce the same det-only audit**, and a test could not tell which point fired — or
whether a fault fired at all rather than the audit failing for an unrelated reason. That is the
"proves nothing" shape this pass exists to eliminate.

**Decision: the proofs pass `evalModel`**, the one flag the source rethrows on, and assert the
propagated error is the injected `LifecycleFaultInjected` carrying its own `faultAt`. Every fault
fires before any generation work, so the flag's only live effect here is the rethrow — it never
reaches `defaultGenerate`.

`4B-SEAM.5` drives the **non-eval** path separately and pins the swallow as unchanged: the det-only
audit returns with `llmLegFailed: true`, empty sources and suggestions, and the handle still
arrives by callback — which is D11's rule, since the fallback attaches no handle.

## 5. The mutation table — run BEFORE the gate

Sandbox: `…/scratchpad/sandbox-4b`, a full copy outside the worktree with `.next`, `node_modules`
and `.git` removed and `node_modules` symlinked back. **Shape verified before use** — `.git` absent,
`.next` absent, `node_modules` a symlink, path outside the worktree. **No git command was run inside
the sandbox.** Restore by `cp` from a pristine copy held outside the sandbox, verified by `cmp`.

### 5.1 The table found a defect in the tests, and the row was NOT adjusted

**First run of row M2 did not fail its named test.** M2 deletes the `during_generation` fault
outright; `22.2` still passed, because both terminals had been written and the settlement was still
correct — every assertion held while the thing being settled *from* had never happened. `22.2` was
asserting the settlement mapping, which `retrieval-settlement.test.ts` already owns in isolation,
and nothing about the path through `auditOpdNote`.

Per §7 the row is a defect in the test, not in the table. **The tests were repaired, the row was
not.** `22.1`, `22.2` and `22.4` now assert their own precondition — that the injected fault fired,
at the named point. The build commit was rolled back with `git reset --soft` before it had been
pushed or evidenced, the repair applied, and the whole table re-run, restoring the prescribed pass-3
order (tests → typecheck+test → table → repair → commit → gate). Both runs are recorded here.

### 5.2 All five rows, on the repaired tree

Command for every row: `node --test --import tsx lib/__tests__/retrieval-telemetry-lifecycle.test.ts`,
cwd = the sandbox, the named test file only.

| Row | Proof | Mutation | STARTED | ENDED | exit | pass/fail | Named test failed |
|---|---|---|---|---|---|---|---|
| M1 | 21 | publication after the primary terminal write removed | 19:48:39 | 19:48:43 | 1 | 33 / 2 | ✓ `21.2` |
| M2 | 22 | the `during_generation` fault deleted | 19:48:43 | 19:48:46 | 1 | 30 / 5 | ✓ `22.2` |
| M3 | 23 | the primary terminal hashes an empty scorer context | 19:48:46 | 19:48:50 | 1 | 34 / 1 | ✓ `23.6` |
| M4 | 23 — **Rep 42's named row** | an early terminal write introduced before context assembly | 19:48:50 | 19:48:53 | 1 | 27 / 8 | ✓ `23.4` |
| M5 | the seam itself | the wrapper's plan attachment replaced with a no-op | 19:48:53 | 19:48:57 | 1 | 24 / 11 | ✓ `21.1` |

Exact diffs:

```diff
### M1
@@ -796,3 +796,3 @@
     // is handed here is what was known here.
-    publishHandle(handle, { ...defectsByRole });
+    /* MUTANT M1: publication after the primary terminal removed */

### M2
@@ -1761,3 +1761,2 @@
     // `buildOpdAuditUser`'s prompt and is used nowhere else — so this is generation work's edge.
-    lifecycleFault(faultPlan, 'during_generation');
     const specialty = await doctorSpecialtyFor(keys.doctorUid);

### M3
@@ -1752,3 +1752,3 @@
         tele, handle, publishHandle, traceId: traceId ?? null,
-        startedAt: telemetryStartedAt, citedContext,
+        startedAt: telemetryStartedAt, citedContext: '',
         primaryCapture: primaryCapture!, normativeCapture,

### M4 — Rep 42's named row: an early terminal write must fail the named proof-23 test
@@ -1734,2 +1734,10 @@
     lifecycleFault(faultPlan, 'after_primary_retrieval');
+    if (tele && handle) {
+      /* MUTANT M4: an EARLY terminal write, before assembly */
+      await writeRetrievalTerminals({
+        tele, handle, publishHandle, traceId: traceId ?? null,
+        startedAt: telemetryStartedAt, citedContext: '',
+        primaryCapture: primaryCapture!, normativeCapture,
+      });
+    }

### M5
@@ -1513,10 +1513,3 @@
     const planned: AuditOpdOpts = { ...opts };
-    Object.defineProperty(planned, LIFECYCLE_FAULT_PLAN, {
-      value: Object.freeze({
-        faultAt: plan.faultAt,
-        primaryHits: Object.freeze(plan.primaryHits.map((h) => Object.freeze({ ...h }))),
-        normativeHits: Object.freeze(plan.normativeHits.map((h) => Object.freeze({ ...h }))),
-      }),
-      enumerable: false, writable: false, configurable: false,
-    });
+    /* MUTANT M5: plan attachment replaced with a no-op */ void plan;
     return auditOpdNote(row, planned);
```

The named failing lines, quoted:

```
not ok - 21.2 — the primary terminal publishes [1,0]: the primary advanced and the normative has not
not ok - 22.2 — during_generation settles retrieval_complete → audit_generation_failed
not ok - 23.6 — the primary payload HMAC is over the COMBINED assembled context, computed by the real run
not ok - 23.4 — A CONTEXT-ASSEMBLY FAULT PRODUCES ZERO TERMINAL WRITES, driven through the real auditOpdNote
not ok - 21.1 — declaration publishes both roles at revisions [0,0], through the real auditOpdNote
```

Every row restored by `cp` with `cmp exit=0`. **No row timed out**; every row failed by an assertion.

### 5.3 Four-hash byte equality

```
lib/opd-note-audit.ts
  worktree-before / sandbox-baseline / worktree-after / git show HEAD
  c7a6f3c1af653fe4a185c3787d994105eca7493d6e07ba84a7ebdca538485f22   (all four agree)

lib/__tests__/retrieval-telemetry-lifecycle.test.ts
  worktree-after / sandbox-restored / git show HEAD
  ba4b15fdc6a2514f028008c3d4f90e0c3f6b454c20946a20555581ebf2a4bebe   (all agree)
```

Sandbox deleted afterwards.

## 6. The gate — nine commands plus the build pair, against `12a4565`

```
### Command 1 — npm test                       STARTED 19:49:38  exit=0  ENDED 19:49:54
# tests 3598 / # suites 0 / # pass 3598 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0

### Command 2 — npm run typecheck              STARTED 19:49:54  exit=0  ENDED 19:49:57
> tsc --noEmit                                 (no diagnostics)

### Command 3 — npm run build                  STARTED 19:49:57  exit=0  ENDED 19:50:33
 ✓ Compiled successfully in 10.8s

### Command 4 — npm run architecture:check     STARTED 19:50:42  exit=0  ENDED 19:50:43
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

### Command 5 — npm run architecture:map       STARTED 19:50:43  exit=0  ENDED 19:50:43
architecture:map — wrote lib/architecture/map.generated.ts (90409 bytes).

### Command 6 — determinism + currency, NO git add form   STARTED 19:50:43  ENDED 19:50:44
precondition  git diff --exit-code lib/architecture/map.generated.ts          → exit 0
precondition  git diff --cached --exit-code lib/architecture/map.generated.ts → exit 0
generate twice, cmp generation A vs generation B                              → identical
post          git diff --exit-code lib/architecture/map.generated.ts          → exit 0
                                                (0 dirty paths; no git write performed)

### Command 7 — npm run reasoning:registry + diff   STARTED 19:50:55  exit=0  ENDED 19:50:56
reasoning:registry — wrote data/reasoning-registry/prompts.generated.json (88737 bytes; 30 prompts · 7 rubrics · 36 builders · 19 features).
git diff --exit-code data/reasoning-registry/prompts.generated.json → exit 0

### Command 8 — npm run reasoning:governance   STARTED 19:50:56  exit=0  ENDED 19:50:56
reasoning:governance — GREEN: 0 ungoverned model calls; parallel stores folded.

### Command 9 — npm run changelog:coverage     STARTED 19:50:56  exit=0  ENDED 19:50:56
changelog:coverage — GREEN: all 19 shipped engine versions documented (30 versioned entries).

### Build arm A — unkeyed production           STARTED 19:50:56  exit=1  ENDED 19:50:56
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3). Set it in Vercel Production before deploying.
    at <unknown> (next.config.mjs:14:9)

### Build arm B — keyed production             STARTED 19:50:56  exit=0  ENDED 19:51:28
 ✓ Compiled successfully in 8.3s
```

**Observed test count 3598. Observed map size 90409 bytes** — the Q1 baseline, unmoved, as §8
requires. Neither predeclared. The map did not move because the seam adds no import, exports no
`*_VERSION` constant and creates no `lib/` subsystem.

## 7. Deviations and flags

### 7.1 The primary provider call is NOT fixtured — §2.7 partially deviated

§2.7 asks for deterministic **primary and normative** hit fixtures. The primary call site cannot be
changed at all without editing files §10 excludes from the diff:

```
lib/__tests__/citation-support.test.ts:114
  const retrieveIdx = src.indexOf('const hits = await defaultRetrieve(');

lib/__tests__/rerank-backend.test.ts:339
  assert.ok(/defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend, primaryCapture\)/.test(audit), …)
```

Together these pin the assignment prefix **and** the call through its closing paren, so neither a
ternary nor a sixth argument survives. **The call site is therefore byte-identical to `t4a`, and no
primary fixture exists.**

It is also unnecessary, and arguably better: under the transport stub production's own
`defaultRetrieve` runs, takes its documented **fail-open** path with no corpus reachable, and
returns zero hits in single-digit milliseconds. `23.6` asserts what the row reports — `$3` is
`retrieval_failure` and `$12` is `0` — rather than assuming it, so the primary leg the proofs
execute is production's, not a fixture's. Only the normative leg, whose call site is unpinned, is
fixtured. The plan keeps all three of Rep 42's fields; `primaryHits` is carried and not consumed.

**Flagged for ruling.** Rep 42 governs; this is less production change than §2.7 authorizes, not
more, and no committed test outside the two authorized files was touched to achieve it.

### 7.2 The mutation table found a test defect — see §5.1

Reported, not hidden. The row was not adjusted; `22.1`, `22.2` and `22.4` were repaired to assert
their own precondition, and the table was re-run in full.

### 7.3 The build commit was rolled back once, before evidence

`git reset --soft` on my own unpushed, un-evidenced commit from minutes earlier, to restore the
prescribed pass-3 order after §5.1's repair. No amend, no squash, no rebase, no force-push, and
nothing on `t4a` or before it was altered — `5994922` and every commit under it are untouched.

### 7.4 Two worktree traps, recorded

`next build` must precede `tsc` in a fresh worktree, as the kickoff says: without `.next/types`,
`app/admin/opd-audit/[id]/finding-triage.tsx:227` reports a spurious `TS2322` on styled-jsx's `jsx`
prop. Separately, copying `.env.local` into the worktree makes a plain `npm run build` fail — it
carries `VERCEL=1` and `VERCEL_ENV=production`, which arms the HMAC-key guard. It was removed; the
gate ran without it, as the Q1 gate did.

### 7.5 Nothing else

No push, integration, deployment, migration, bootstrap, PR 2, ranking change or Cohere. No engine
bump, no changelog entry. `AuditOpdOpts` unchanged, no production call site altered,
`retrievalTerminalsSeam` untouched, and no production repair outside the pinned seam was required.
