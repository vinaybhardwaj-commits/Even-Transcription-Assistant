# CDMSS — Telemetry Q1 cleanup: gate evidence

**Date:** 21 August 2026 (IST)
**Kickoff:** `CDMSS-TELEMETRY-Q1-CLEANUP-KICKOFF-21-AUG-2026.md` (Saul Rep 42, Q1 — GO).
**Base:** branch `t4a` @ `ed63ad7`. Not `main`, not a new branch.
**Cleanup commit:** `07452bb`.
**Pushed:** **No.** V pushes, after review.

---

## 1. Why this commit exists

`app/api/admin/telemetry-overhead/route.ts` carried a hard UTC expiry as guard 2. It fired on
20 August 2026. From that moment every authenticated request returns 410 **before** reaching guards
1 and 3–5, so the 27 child-process cases in `lib/__tests__/telemetry-overhead-guard.test.ts` that
assert 403/400 receive 410 instead. Gate command 1 was red at the base and nothing on this branch
could gate until the instrument was gone.

The expiry was the *only* enforcement that this file goes away. Nothing in CI enumerates routes, and
the route's own header says so: *"a note in a report is not a mechanism."* It worked exactly as
designed — it converted an owed deletion into a blocked branch.

**The instrument is deleted, not disarmed.** Rep 42 rules out suppressing the tests, pinning their
clocks, accepting a red gate, and extending the expiry. None of those was done.

---

## 2. Precondition evidence, gathered BEFORE the deletion

### 2.1 The 27 failures have exactly one cause

Kickoff §4: *"If the gate is still red after the deletion, stop and report immediately — that would
mean the 27 had a second cause."* That risk was measured up front rather than discovered afterwards.

```
STARTED 2026-08-21 12:13:38 IST
$ npm test                       # at ed63ad7, before any deletion
# tests 3613
# suites 0
# pass 3586
# fail 27
ENDED   2026-08-21 12:13:57 IST

$ grep -cE '^not ok' → 27
  27  lib/__tests__/telemetry-overhead-guard.test.ts
```

All 27 `not ok` lines belong to that one file. No second cause exists.

### 2.2 The route is the sole `app/api → retrieval-capture` importer

Kickoff §2 states this and says it was verified by the Orchestrator. Verified again here
independently, because the permitted map delta depends on it entirely.

```
$ grep -rln retrieval-capture app/api/
app/api/admin/telemetry-overhead/route.ts          ← the only one

$ python3 — count {"from":"app/api","to":"retrieval-capture"} objects in map.generated.ts
app/api -> retrieval-capture edges: 1
    { "from": "app/api", "to": "retrieval-capture", "kind": "value" }
```

`scripts/telemetry-overhead-measure.mjs` also imports `retrieval-capture`. It is **not** under
`app/api/**`, it is independent of the route, and per kickoff §1 it stays. It was not touched.

---

## 3. The commit — exactly three paths

```
$ git show --stat --format="" 07452bb
 app/api/admin/telemetry-overhead/route.ts      | 481 ----------------------
 lib/__tests__/telemetry-overhead-guard.test.ts | 530 -------------------------
 lib/architecture/map.generated.ts              |   5 -
 3 files changed, 1016 deletions(-)
```

`ed63ad7` and its red evidence are preserved unchanged — no amend, no rebase, no squash. The red
gate is the record of why this commit exists.

### 3.1 The map delta is one edge and only one

Regenerated with `npm run architecture:map`. **Never edited by hand.** The complete diff:

```diff
@@ -1903,11 +1903,6 @@ export const MAP_EDGES: MapEdge[] = [
     "to": "rerank",
     "kind": "value"
   },
-  {
-    "from": "app/api",
-    "to": "retrieval-capture",
-    "kind": "value"
-  },
   {
     "from": "app/api",
     "to": "retrieval-invocation-store",
```

Five lines, one edge, nothing else moved. `architecture:check` still reports 39 subsystems,
16 registered, 23 unregistered — identical to `ac0155c` and to pass 4a, because `app/api` is an
aggregate node whose registration does not change when one file under it is removed.

---

## 4. The gate — nine commands plus the build pair

All run against the committed tree at `07452bb`.

### Command 1 — `npm test` — **GREEN**

```
STARTED 2026-08-21 12:17:11 IST
exit=0
# tests 3582
# suites 0
# pass 3582
# fail 0
# cancelled 0
# skipped 0
# todo 0
ENDED   2026-08-21 12:17:26 IST
```

**Observed total 3582, observed pass 3582, observed fail 0. Not predeclared, not estimated.**

The arithmetic closes twice over, stated after the fact rather than before it. The base ran 3613
tests of which 27 failed; the deleted guard file contained 31 `test(` cases. 3613 − 31 = 3582 for
the total. Of those 31, 27 were failing and 4 were passing; 3586 − 4 = 3582 for the pass count.
Both agree with what the runner printed.

### Command 2 — `npm run typecheck`

```
STARTED 12:17:34   exit=0   ENDED 12:17:36
> even-cdmss@2.0.0 typecheck
> tsc --noEmit
```

Exit 0, no diagnostics. Also run before staging the commit, per the standing rule — see §6.1 for a
stale-artifact trap encountered there.

### Command 3 — `npm run build`

```
STARTED 12:17:36   exit=0   ENDED 12:18:09
 ✓ Compiled successfully in 9.6s
```

`telemetry-overhead` appears **0 times** in the emitted route table.

### Command 4 — `npm run architecture:check`

```
STARTED 12:18:14   exit=0   ENDED 12:18:15
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

### Command 5 — `npm run architecture:map`

```
STARTED 12:18:15   exit=0   ENDED 12:18:15
architecture:map — wrote lib/architecture/map.generated.ts (90409 bytes).
```

**Observed 90409 bytes.** The 90492-byte pin is superseded for this cleanup by Rep 42; this value is
recorded as observed, not predicted. `wc -c` on the same file reports 90411 — the same two-unit
offset pass 4a documented, because the generator prints `src.length` in UTF-16 code units while
`wc -c` counts bytes and the file holds one three-byte UTF-8 character. The gate's number is the
generator's.

### Command 6 — map determinism + currency, the NO-`git add` form (addendum v18 §4.1)

```
STARTED 12:18:24
precondition  git diff --exit-code lib/architecture/map.generated.ts          → exit 0, clean
precondition  git diff --cached --exit-code lib/architecture/map.generated.ts → exit 0, clean
generate twice, cmp generation A vs generation B                              → identical
post          git diff --exit-code lib/architecture/map.generated.ts          → exit 0, clean
ENDED   12:18:25
```

No git write was performed; `git status --porcelain` reported 0 dirty paths afterwards. The
deprecated `git add` form — which would let a map change pass silently and land staged — was not
used.

### Command 7 — `npm run reasoning:registry` + diff

```
STARTED 12:18:32   exit=0   ENDED 12:18:32
reasoning:registry — wrote data/reasoning-registry/prompts.generated.json (88737 bytes; 30 prompts · 7 rubrics · 36 builders · 19 features).
git diff --exit-code data/reasoning-registry/prompts.generated.json → exit 0
```

88737 bytes, 30 / 7 / 36 / 19 — unchanged from pass 4a and from `ac0155c`. Deleting a route with no
registered prompt must not move the registry, and it did not.

### Command 8 — `npm run reasoning:governance`

```
STARTED 12:18:32   exit=0   ENDED 12:18:32
reasoning:governance — GREEN: 0 ungoverned model calls; parallel stores folded.
```

### Command 9 — `npm run changelog:coverage`

```
STARTED 12:18:32   exit=0   ENDED 12:18:33
changelog:coverage — GREEN: all 19 shipped engine versions documented (30 versioned entries).
```

Read-only. **No changelog entry was added to satisfy it.** No engine bump.

### The build pair

**A — unkeyed production build MUST fail and MUST name the key:**

```
STARTED 12:18:38
$ env -u CDMSS_TELEMETRY_HMAC_KEY VERCEL=1 VERCEL_ENV=production npm run build
exit=1
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3). Set it in Vercel Production before deploying.
    at <unknown> (next.config.mjs:14:9)
ENDED   12:18:38
```

**B — keyed production build MUST succeed:**

```
STARTED 12:18:43
$ env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=q1-cleanup-gate-key npm run build
exit=0
 ✓ Compiled successfully in 9.8s
ENDED   12:19:17
```

Both arms behave as specified. `telemetry-overhead` appears 0 times in arm B's route table, and the
tree was clean after both.

---

## 5. Two rulings from Rep 42 recorded against pass 4a

These are appended to `CDMSS-PROOF-PASS-4A-REPORT-FOR-SAUL-21-AUG-2026.md` in the same commit as
this document. They change what pass 4a claims.

### Proof 24 — conditionally closed

Conditional on this cleanup SHA producing a green full gate, which §4 above shows it does. The
official count stays **13/20** until that gate is reviewed, and becomes **14/20** on review. This
document does not advance the count on its own authority.

### Proof 23 — held, moved into pass 4b

Saul's reason, and it is correct: the current test calls `assembleAuditContext` and then calls the
terminal seam itself, so *the test's own choreography* guarantees that assembly precedes the write.
It does not execute `auditOpdNote`, so it proves the test's ordering rather than production's. The
source pin in 23.3 confirms current source text but is not an executable ordering proof.

**This was an Orchestrator specification error.** Pass 4a §3 asked for exactly the insufficient
thing. It is recorded as a specification error and not as a coder deviation.

Pass 4b will own proofs **21, 22 and 23**, reaching **17/20** if all three close. Rep 42 forbids
beginning pass 4b until this gate is green and reviewed, on a base containing all pass-4a and
cleanup commits.

---

## 6. Deviations and flags

### 6.1 A stale `.next/types` artifact, and why the first typecheck was not a real failure

The standing rule requires `npm run typecheck` before staging. On its first run it reported three
`TS2307` errors, all of the form:

```
.next/types/app/api/admin/telemetry-overhead/route.ts(2,24): error TS2307:
  Cannot find module '.../app/api/admin/telemetry-overhead/route.js'
.next/types/validator.ts(1511,39): error TS2307: …same module…
```

These are Next's generated route types from the **pre-deletion** build, still referencing the file
that had just been removed. `.next` is a gitignored build artifact and no committed source was
implicated. `rm -rf .next && npm run build` regenerated them and typecheck then exited 0 with no
diagnostics, before the commit was made.

Recorded rather than silently cleaned, because in a worktree the trap reads at first glance like the
deletion having broken the type graph, and the wrong reaction to it would be to restore the route.

### 6.2 Kickoff §3's step order vs §1's commit contents

§3 lists "make the forward cleanup commit" (step 2) before "regenerate the map" (step 3), while §1
specifies a commit containing three paths, the third being `M lib/architecture/map.generated.ts`.
Taken literally in sequence the map change would land outside the commit that §1 defines.

§1 governs, as the explicit statement of commit contents: the deletions and the regenerated map were
staged together and committed once, so `07452bb` carries exactly the three paths §1 names. No amend
was used to achieve this.

### 6.3 Nothing else

No push. No integration, deployment, migration or bootstrap. No PR 2, no pass 4b, no ranking change,
no Cohere. No test suppressed, no clock pinned, no expiry extended, no red gate accepted. No
`CDMSS-*.md` was edited to remove a mention of the deleted route — the two documents this commit
pair touches gain text, and remove none.
