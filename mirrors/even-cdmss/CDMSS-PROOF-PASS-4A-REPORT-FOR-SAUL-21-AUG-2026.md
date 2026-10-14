# CDMSS — Telemetry pass 4a: report for Saul

**Date:** 21 August 2026 (IST)
**Kickoff:** `CDMSS-TELEMETRY-PASS4A-KICKOFF-20-AUG-2026.md` (Saul Rep 40 order D; Rep 41 risk order).
**Evidence:** `CDMSS-GATE-EVIDENCE-PASS-4A-21-AUG-2026.md`.

| | |
|---|---|
| Base | `exp/rerank-telemetry` @ `29572cf` (docs-only; last code commit `ac0155c`) |
| Worktree | `/Users/vinaybhardwaj/dev/t4a`, clean, branched off the telemetry branch |
| Branch | `t4a` |
| Build commit | `5e9aed5` — one path, `lib/__tests__/retrieval-telemetry-lifecycle.test.ts` |
| Pushed | **No.** V pushes. |

## Did any part of 23 or 24 need a new seam?

**No, and none was built.** Both proofs are reached with `retrievalTerminalsSeam`
(`lib/opd-note-audit.ts:821-831`, the shape accepted for proof 47) plus the transport stub. No
production file was touched. Proofs 21 and 22 were not attempted; they remain pass 4b, held on the
seam-shape question the kickoff's appendix puts to you.

## What was built

Six tests, one file, no production change.

**23 — the primary terminal write happens after `assembleAuditContext`, never immediately after
primary retrieval.**

- **23.1** observes at execution: zero terminal writes have reached the database transport when
  `assembleAuditContext` returns, and both arrive after it, primary first.
- **23.2** is named in its own title as the load-bearing half, and is the one that makes the ordering
  *necessary*: the primary row carries the keyed HMAC of exactly assembly's bytes, and **not** the
  HMAC of `assembleAuditContext(hits, [])` — the only context that exists at step 7. The step-7
  counterfactual is computed and asserted, not described. A write issued immediately after primary
  retrieval would have carried that other value.
- **23.3** is a source pin **explicitly labelled supporting, never the proof**, per review 37's
  ruling on proof 47.

**24 — `trace_id` null at declaration, written at the terminal write, null for both `trace: false`
callers.**

- **24.1** reads the **captured statement and its bound parameters**, not source: fourteen bound
  values, fourteen named columns, `trace_id` among neither, and `$1…$14` placeholders matching the
  parameter list one-for-one. The same run id's terminal write binds the sentinel; the declaration
  binds it nowhere. Both halves of the claim, as one transport-level observation.
- **24.2** `trace_id = $6`, carrying the sentinel with a trace and a bound `null` without.
- **24.3** both callers, `lib/mcp-tools.ts` and `scripts/metamorphic-llm-report.mjs`, plus the
  mechanism (`opts.trace !== false` → `undefined` → `traceId ?? null`). Source-read, as test 52 above
  reads the same `.mjs` for the same reason: it is outside the test glob.

## Mutation table

7 rows, **run before the gate**, every row failing its named test by name, all four hashes agreeing.
Full record in the evidence document. M6 and M7 are separate rows so that "both callers" is
load-bearing rather than decorative.

## Two things you should read before accepting

**1. One assertion in 23.1 is not falsifiable by mutating production, and the report says so.**
23.1's claim that nothing has reached the transport *at the moment assembly returns* cannot be killed
by any production edit, because the test controls when it calls `assembleAuditContext`. That is the
structural limit of proving 23 without driving `auditOpdNote`. The proof therefore rests on 23.2's
data dependency and 23.3's caller pin, both of which mutation kills (M2, M3). If you consider that
insufficient, proof 23 needs the pass-4b seam after all — which is a ruling, not a coder's call, and
is why it is surfaced here rather than papered over.

**2. Gate command 1 is RED at the base, and it is a fired deletion deadline, not a regression.**
3613 tests, 3586 pass, 27 fail — all 27 in `lib/__tests__/telemetry-overhead-guard.test.ts`, outside
this unit's contract and untouched. `app/api/admin/telemetry-overhead/route.ts:53` sets
`EXPIRES_AT_UTC = Date.UTC(2026, 7, 20)`; that instant has passed, so guard 2 — moved to second by
addendum v5 §9.1 precisely so the deadline would bind — returns 410 before the guards those cases
exercise. Verified pre-existing by stashing this change and re-running at a pristine `29572cf`: the
same 27. The 4 survivors are exactly the cases that pin their own clock or read source.

Addendum v4 §12 already records that this route is owed a deletion. The charge has gone off; the
demolition has not. **Pass 4a did not repair it** — §6 puts owner routes on the do-not-touch list and
makes any out-of-scope production repair a stop-and-report. Every other gate command is green, the
map did not move, and the proofs' own file is 19/19.

## Gate summary

| Command | Result |
|---|---|
| `npm test` | **RED — 3613 tests, 3586 pass, 27 fail**, all pre-existing, all in one untouched file |
| `npm run typecheck` | green, exit 0 |
| `npm run build` | green, exit 0 |
| `npm run architecture:check` | green — 8 rules, 39 subsystems, 16 registered, 23 unregistered |
| `npm run architecture:map` | **90492 bytes — did not move** |
| map determinism + currency (no-`git add` form) | green — preconditions clean, two generations identical, post-diff clean |
| `npm run reasoning:registry` + diff | green — 30 prompts / 7 rubrics / 36 builders / 19 features, diff clean |
| `npm run reasoning:governance` | green — 0 ungoverned model calls |
| `npm run changelog:coverage` | green — 19 engine versions |
| build pair, unkeyed production | fails, exit 1, names `CDMSS_TELEMETRY_HMAC_KEY` |
| build pair, keyed production | succeeds, exit 0 |

Observed test total **3613**, never predeclared: 3607 at the base plus 6 added.

## Deviations and flags

1. **Gate command 1 red at the base** — §6 above. Stop-and-report, not repaired.
2. **23.1's non-falsifiable assertion** — §1 above. Raised for your ruling.
3. **One test assertion was corrected during the build, and the code was right.** A first draft of
   24.3 asserted `lib/mcp-tools.ts` contains exactly one `trace: false`; it contains two textually,
   because `:482` is a *comment* explaining the row. Counting is now done on comment-stripped source.
   A second draft then asserted the file has only one `auditOpdNote` call; it has two, and the other
   (`backfill_control`, acting as the worker) deliberately omits `trace` and **is** traced. 24.3 now
   pins that asymmetry explicitly, so a `trace_id` on a `backfill_control` row reads as correct
   rather than as a defect. Both were defects in the draft assertions, not in production.
4. **No stale comment was "fixed."** The two known stale citations (`:302` and Saul review 37's) were
   left exactly as they are.
5. **No changelog entry, no engine bump, no production change, nothing pushed.**

---

## Addendum — two rulings from Saul Rep 42 (21 August 2026)

Recorded here because they change what this report claims. Added in the Q1 cleanup's forward
documentation commit, not by amending this report's original commit (`ed63ad7`); evidence for the
cleanup itself is in `CDMSS-GATE-EVIDENCE-Q1-CLEANUP-21-AUG-2026.md`.

### Gate command 1 — the red is resolved, by deletion

Deviation 1 above ("gate command 1 red at the base") is closed. The cause was the hard expiry in
`app/api/admin/telemetry-overhead/route.ts` firing on 20 Aug 2026. Rep 42 authorized deleting the
instrument rather than disarming it. Cleanup commit `07452bb` removes the route, its guard test and
the single `app/api → retrieval-capture` map edge, and the full gate is green:

| | at `ed63ad7` | at `07452bb` |
|---|---|---|
| `npm test` | RED — 3613 tests, 3586 pass, **27 fail** | **GREEN — 3582 tests, 3582 pass, 0 fail** |
| `npm run architecture:map` | 90492 bytes | **90409 bytes** (90492 pin superseded by Rep 42) |

Both figures observed and recorded after the run, never predeclared.

### Proof 24 — conditionally closed

Conditional on the cleanup SHA producing a green full gate, which it does. **The official count
stays 13/20 until that gate is reviewed, then becomes 14/20.** This report does not advance the
count on its own authority.

### Proof 23 — held, and moved into pass 4b

Saul's reason, and it is correct: the test calls `assembleAuditContext` and then calls the terminal
seam itself, so *the test's own choreography* guarantees assembly precedes the write. It never
executes `auditOpdNote`, so it proves the test's ordering rather than production's. The source pin
in 23.3 confirms current source text but is not an executable ordering proof.

**This was an Orchestrator specification error, not a coder deviation.** Pass 4a §3 asked for
exactly the insufficient thing, and this build delivered what was asked. Recorded as such.

This supersedes the "What was built" section's claim that 23 is reached: 23 is **held**. What this
pass actually established for 23 is that the seam and transport stub can observe terminal writes at
execution — a component of a future proof, not the proof.

Pass 4b will own proofs **21, 22 and 23**, reaching **17/20** if all three close. It may not begin
until this gate is green and reviewed, on a base containing all pass-4a and cleanup commits.
