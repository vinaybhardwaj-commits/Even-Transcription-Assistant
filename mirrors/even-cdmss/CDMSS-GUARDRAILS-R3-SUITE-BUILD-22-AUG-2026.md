# CDMSS — Replacement guardrail measurement suite: build evidence

**Date:** 22 August 2026 (IST)
**Authority:** Saul Rep 41 (design, fixtures, refusal tests and dry runs permitted in parallel; no measurement) and Rep 42.
**Base:** a NEW clean worktree, `~/dev/guardrails-r3`, branch `guardrails-r3` off **`main` `61b5463`** — not `t4b`, not the main checkout.
**Pushed:** **No.**

---

## 0. RESULT

The instrument is built, its guard chain is proven by execution, its fixtures are proven text-free,
and guardrails 4 and 5 have run locally. **No deployment, no qualifying measurement, no Preview
resource touched, no database contacted, no model called.**

**The instrument cannot take a qualifying measurement from this branch, and that is enforced in code
rather than promised.** A fully authorised, fully configured request — Preview, correct branch,
frozen SHA matching exactly, armed, pointed at the branch database, inside the window — still
refuses, with **501 `not_integrated`**. Test `R3.10` is that claim.

**What remains blocked on the frozen SHA is §6.**

---

## 1. The structural fact that shaped the design

**`main` carries none of the telemetry modules the first three guardrails measure.** Verified at
`61b5463`: `retrieval-telemetry-core`, `retrieval-telemetry-store`, `retrieval-invocation-store`,
`retrieval-capture`, `retrieval-settlement` and `telemetry-db-stub` are all **absent**. They live on
the telemetry branch. `retrieve.ts`, `opd-note-audit.ts`, `rerank.ts`, `llm.ts` and `db.ts` are
present.

Guardrails 1–3 write and read telemetry rows, so on a worktree off `main` there is nothing for them
to write with. Two ways to respond, and the rejected one is worth recording:

- **Rejected — vendor type shims** so the measurement body could be written and typechecked now.
  The shims would be duplicate definitions owed a deletion at integration, and *an owed deletion
  that nothing enforces is exactly how the predecessor route outlived its own expiry.*
- **Taken — state the absence as a guard.** `MEASUREMENT_INTEGRATION.present` is `false`, guard 7
  refuses on it, and the refusal is a distinct status. The consequence is the point: while it is
  false the instrument is structurally incapable of measuring, on any environment, however
  configured.

## 2. What was built

| File | What it is |
|---|---|
| `lib/guardrails-r3-core.ts` | The guard chain, **pure, zero outbound imports** |
| `app/api/admin/telemetry-guardrails-r3/route.ts` | The Preview route — guardrails 1–3 at integration |
| `lib/guardrails-r3-fixtures.ts` | Synthetic text-free fixtures, seeds, statistics |
| `lib/__tests__/guardrails-r3-refusal.test.ts` | 15 refusal tests, pure + child-process |
| `lib/__tests__/guardrails-r3-fixtures.test.ts` | 7 fixture tests, incl. the text-free proof |
| `scripts/guardrails-r3/paired-runner.mjs` | **Guardrail 4** — deterministic paired runner |
| `scripts/guardrails-r3/synthetic-audit-runner.mjs` | **Guardrail 5** — synthetic-audit runner |
| `lib/architecture/map.generated.ts` | Regenerated; the staleness gate requires it |

### 2.1 Why the chain is a pure function and not a route full of `if`s

The predecessor carried its whole chain inline, so every guard had to be proven by spawning a
process, and **the ORDER — the part that actually failed review — could only be observed by making a
request and reading a status.** Its expiry ran fifth while its report claimed *"after the expiry
every request is 410 whatever else is configured"*; that claim was false for any request failing an
earlier guard, and it survived two passes.

Here the decision is a pure function of an environment snapshot and a clock. `refusalsInOrder()`
**drives the real chain** to derive the order rather than restating it, so `R3.1` compares the
code's order against the declared one. A hand-written second list would have agreed with the
declaration and could still have disagreed with the function — which is precisely what the
misordered expiry was.

## 3. The guards

```
1. admin          requireAdmin ALONE — no isAdminUnlocked() clause          401 unauthorized
2. expiry         2026-09-15T00:00:00Z                                      410 expired
3. preview        VERCEL_ENV=preview AND VERCEL_GIT_COMMIT_REF=guardrails-r3  403 not_preview
4. qualification  the FROZEN measurement SHA, compared EXACTLY              403 freeze_deadline_passed
                                                                            403 not_qualified
                                                                            403 sha_mismatch
5. armed          CDMSS_GUARDRAILS_R3_MEASURE === '1'                       403 not_armed
6. db identity    denylist FIRST, then equality                             403 no_denylist
                                                                            403 forbidden_endpoint
                                                                            403 endpoint_mismatch
7. integration    the measurement body must exist on this branch            501 not_integrated
```

### 3.1 The expiry is second, and `R3.2` proves what that buys

Nine environments, each ALSO failing a later guard — not preview, wrong branch, no SHA, SHA
mismatch, not armed, no denylist, pointed at production, and everything wrong at once — **all return
410**. Under the predecessor's ordering every one of them returned 403 and the deletion deadline
meant nothing. The boundary is asserted both ways: one millisecond earlier is not `expired`, the
instant itself is.

### 3.2 The frozen-SHA guard is exact, and a prefix is never accepted

`R3.5`. Both sides must be 40-character lowercase hex and equal. **`startsWith` is used nowhere.**
The convenient thing — accepting the short SHA an operator reads off a deployment page — is the
hazard: a 7-character prefix names one commit today and can name two later, and "the qualifying
SHA" would then be a set rather than an object. A short expectation refuses, a short build SHA
refuses, a 39- or 41-character value refuses, uppercase refuses, an absent build SHA refuses. Every
failure direction is *do not measure*.

### 3.3 The freeze deadline is a mechanism, not a promise

The ledger's standing clock: *"If the qualifying SHA is not frozen by 2026-09-08T00:00:00Z, it is
deleted and disarmed … it is not silently extended."* Past that instant an **unset** SHA refuses
with its own word, `freeze_deadline_passed`, instead of the ordinary `not_qualified` — because the
two call for opposite actions. `not_qualified` means *freeze it and set it*; `freeze_deadline_passed`
means *you may no longer do that, go back for a new authorization*. One word for both would invite
exactly the silent extension the ledger forbids. `R3.6` pins both sides of the boundary, and pins
that a SHA frozen **before** the deadline keeps working right up to the expiry.

### 3.4 The denylist beats the allowlist

`R3.8`. The equality check compares two values the **operator** set and has no independent knowledge
of which endpoint is production. So the denylist holds production's id and is checked first:
**pointing the expected value at production still refuses.** An absent denylist refuses too — a
denylist that is not there is not a denylist. `R3.9` pins that both the pooled and direct forms
normalise, on **both** sides, because the predecessor shipped blind to Neon's `-pooler` suffix and
that gap survived two passes for want of a realistic fixture.

### 3.5 Nothing leaks

`R3.15` drives **nine** refusal paths and searches the body, stdout **and** stderr for the
connection string, username, password, host, database name and both endpoint ids. The predecessor's
first leak check searched only the parsed result, so a driver message on `console.error` would have
passed unnoticed.

## 4. Fixtures — synthetic, text-free, seeded

Text-freedom is a **proven property**, not a habit. `R3.16` walks every string any fixture can
produce — values *and* keys — and requires each to match a declared shape: an enum member, a UUID,
an ISO instant, a 64-hex digest, or a bare snake_case identifier. Free text matches none.

Both halves of PRD §6.4 are honoured:

- **It must fail when such a field is added.** `R3.17` runs a fixture poisoned with a clinical
  sentence through the same walk and requires exactly that value to be caught. The subtle half is
  recorded: the *key* `clinical_note` is itself a legal identifier, so the **value** is what fails.
- **It must not be able to pass on an empty slice.** The walk asserts it examined >100 strings
  before judging any of them — the same vacuity that the `every()` on an empty array was in proof 14.

`context_hmac` carries a constant of the right length and visibly not a digest of anything
(`R3.20`), because the real field is keyed over the assembled scorer context and that context is
clinical text. A fixture must never contain one.

Seeds are **declared, not generated** — `manifestShape`, `pairedRetrieval`, `syntheticAudit` — and
every runner derives all randomness from one of them through a seeded mulberry32. `Math.random()` is
used nowhere in the suite: a guardrail is a number a later run has to be comparable with.

## 5. Guardrails 4 and 5 — built and DRY RUN locally

Both are marked `DRY RUN` in their own output. The workload under measurement is a stand-in; **what
is validated now is the method**, and at integration the stand-in is swapped for the real call
without the method changing.

### 5.1 Guardrail 4 — retrieval wall time, PAIRED

```
GUARDRAIL 4 — retrieval wall time (PAIRED)   [DRY RUN]
  seed 1592590340  pairs 40  arm order alternating (instrumented first in 20/40)
  delta ms   min -0.0440   median 0.0105   mean 0.0180   max 0.2150
  p95 0.0660
  p99 withheld — needs n >= 100, have 40 — a p99 here would be the maximum
  instrumented slower in 38/40 pairs
```

Paired because the run-to-run variance of a retrieval is far larger than the overhead being looked
for; two independent medians would mostly report the draw. **Arm order alternates between pairs** —
exactly 20/40 — so a warming cache or a busier machine cannot land entirely on whichever arm always
went second and be reported as the cost of instrumentation. `instrumentedSlower` is a **count, not a
rate**: n is small by design and a rate would imply a precision this does not have.

### 5.2 Guardrail 5 — audit completion rate

```
clean:               started 200  completed 192  completed_empty 0  failed 8  abandoned 0   → 96%
inject 7 abandoned,  started 200  completed 180  completed_empty 5  failed 8  abandoned 7   → 90%
       5 empty       injected 7 abandoned and SAW them — the instrument is not blind
```

Four **disjoint** counts that sum to the number started, and the rate is over `completed` **alone**.
An empty result is counted but is never a completion — folding it in is how a guardrail reads 100%
on an engine that produces nothing.

**`abandoned` is why the runner exists.** An audit that vanishes leaves no row and no exception, so
it is invisible to any count taken from either; it is derived by **subtraction** from the plan. The
self-test injects abandoned audits and **fails loudly if it cannot see them** — an instrument blind
to the class it exists to see is worse than none.

## 6. WHAT REMAINS BLOCKED ON THE FROZEN SHA

Blocked, and deliberately so:

1. **Guardrails 1–3 have no measurement body.** They need the telemetry modules, which are on the
   telemetry branch. The body lands at integration at the named place in the route; until then guard
   7 refuses 501.
2. **No qualifying measurement, of any guardrail.** Rep 41 admits one only after 20/20 hard proofs ·
   4/4 judge · the proof-11 sweep · a signed closing ledger · approved fixtures and seeds · and a
   **frozen measurement SHA**. The SHA is not frozen; `CDMSS_GUARDRAILS_R3_QUALIFYING_SHA` is unset
   and the route refuses `not_qualified`.
3. **No deployment and no Preview resources.** Nothing was deployed, no Vercel variable was set or
   read from a deployment, no Neon branch was created or contacted. Guardrails 4 and 5 ran on this
   machine against synthetic data.
4. **Guardrails 4 and 5's numbers are DRY-RUN numbers** and are not offered as results. Their
   *methods* are what this pass establishes.
5. **The branch pin is `guardrails-r3`.** If the qualifying run is to happen from an integration
   branch instead, `ONLY_REF` is a one-line change a human makes deliberately — and `R3.4` will fail
   until the test is updated with it, which is the intended friction.

**Two dates now bind.** The instrument expires **2026-09-15T00:00:00Z**. If the qualifying SHA is
not frozen by **2026-09-08T00:00:00Z** it is deleted and disarmed and a newly dated authorization is
requested. Both are constants in `lib/guardrails-r3-core.ts` with tests on their exact values, and
the second is enforced by its own refusal word.

## 7. The gate

```
npm test                     exit=0   # tests 3215 / # pass 3215 / # fail 0
npm run typecheck            exit=0
npm run build                exit=0   ✓ Compiled successfully in 11.2s
npm run architecture:check   exit=0   all 8 rules + coverage green
npm run architecture:map     exit=0   wrote lib/architecture/map.generated.ts (90848 bytes)
determinism  generate twice, cmp A vs B  → identical
command 7    bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'   exit=0
npm run reasoning:governance exit=0   GREEN: 0 ungoverned model calls
npm run changelog:coverage   exit=0   GREEN: all 19 shipped engine versions documented
```

**Units and bytes, separately** — the generator counts UTF-16 code units, `wc -c` counts UTF-8 bytes:

| Artefact | Generator (units) | `wc -c` (bytes) | Offset |
|---|---|---|---|
| `lib/architecture/map.generated.ts` | 90848 | 90850 | +2 |

## 8. Deviations and flags

1. **The architecture map changed, and it had to.** Adding files makes the committed map stale and
   the staleness gate fails on it — the first `npm test` run failed exactly there, 3214/1. It is a
   generated file, regenerated by the gate's own command and verified deterministic.
2. **A pre-existing typecheck error on a pristine `main` worktree**, in
   `app/admin/opd-audit/[id]/finding-triage.tsx:227` (`styled-jsx`'s `jsx` prop). **Confirmed not
   mine**: it reproduces with my files moved out, and disappears once `npm run build` has generated
   `.next/types`. The known worktree trap; recorded so nobody re-diagnoses it.
3. **Two defects found by my own tests, both fixed, both worth naming.**
   - `R3.11` failed first because the raw-text scan for `isAdminUnlocked` matched **the route's own
     comment explaining why it omits that clause**. The predecessor recorded hitting this same trap
     and it still caught me. The scan now strips comments and separately asserts the explanation is
     still present.
   - `R3.14` failed because the endpoint parser accepted strings the driver could never use — a
     quote-wrapped value and one pasted with its `psql` command both parsed cleanly, because the
     scheme was only required to be *present*. It is now anchored at the start.
4. **The child process inherited `NODE_TEST_CONTEXT`** and re-entered the test runner instead of
   serving the request, which reads like a crash and is not one. Stripped, with the reason recorded
   at the call site.
5. **Nothing deployed, nothing measured, nothing pushed.** One commit on `guardrails-r3`.
