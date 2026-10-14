# CDMSS proof pass 2 — supplemental report 3 for Saul (the final test repair)

Date: 17 August 2026
Authority: **Saul review 31, as corrected by Saul review 32.** Governing
addendum: `CDMSS-RERANK-TELEMETRY-ADDENDUM-v20-17-AUG-2026.md`, signed by V over
a digest that the builder **verified by one-line substitution before any other
work** (section 1 below). Addenda v15 to v19 govern everything v20 does not
touch. Addendum v19 is preserved unchanged, with its false signature line
intact, as review 31 ruled; v20 §1 is the truthful record. Addendum v21 (signed by
V, verified by one-line substitution) corrects v20 §5.2 (commit 10 = seven paths)
and supplies §7 below.

Base: commit 8 at `df7821505e5800961a287b79d30e209e5c1e4a3a`.
Commit 9 (the final test repair): `0e0503b03946561d5cac233beb90243bc02e49f5` —
exactly one path, `lib/__tests__/explicit-judge-equivalence.test.ts`.
`judge-server-stub.ts` is untouched. Commit 10 is the commit carrying this
report (seven paths per v21 §2); its SHA is in the builder's covering report.

**Nothing is pushed.** `@{u}` remains `d69a11d7c57c18157b371b9079ffd2a00f466ce6`;
six commits will be held local when commit 10 lands.

---

## 1. The signature verification — full script output (v20 §0.1, kickoff §1.1)

Run verbatim from the worktree, before any other work:

```text
status line : STATUS: SIGNED by V, 17 August 2026, over digest 487a045e8c1089d1c49bf899dbcd64f5a3fee0d8b085d098eb3bd7ad08ebe3e6
claimed     : 487a045e8c1089d1c49bf899dbcd64f5a3fee0d8b085d098eb3bd7ad08ebe3e6
recomputed  : 487a045e8c1089d1c49bf899dbcd64f5a3fee0d8b085d098eb3bd7ad08ebe3e6
VERDICT     : VALID
script exit=0
```

Exactly one `STATUS:` line; replacing it alone with `STATUS: UNSIGNED` reproduced
the named digest. No other line was deleted, added or moved.

**Disclosed:** an earlier issue of this same kickoff (v2, same text) was run
while v20's status line still read `STATUS: UNSIGNED` and named no digest. The
script exited 1 (`FAIL: status line names no digest: STATUS: UNSIGNED`) and the
builder stopped without touching anything, per §1.1. The kickoff was re-issued
after signing; the run above is that second issue.

Stop conditions 2–4: `git rev-parse HEAD` → `df7821505e5800961a287b79d30e209e5c1e4a3a`;
`git status --porcelain` → empty; `git rev-parse @{u}` → `d69a11d7c57c18157b371b9079ffd2a00f466ce6`.
All PASS.

---

## 2. The three repairs

All in `lib/__tests__/explicit-judge-equivalence.test.ts`, the only path commit
9 changes.

### 2.1 5.2c carries no unbounded settlement wait, body or finally (v20 §3.1)

Every `await judge.settled()` in 5.2c is gone — the one in the body **and** the
one in the `finally` review 32 found. Both are now the bounded
`waitForInFlight` with target 0, each stating what it waited for:

```ts
await waitForInFlight(judge, 0, reqA, 'a quiet server before 5.2c starts');
…
await waitForInFlight(judge, 0, reqA, "5.2c's return to zero in-flight after the on→off toggle");
assert.equal(judge.inFlight(), 0, 'no in-flight leak from the mid-flight toggle');
…
} finally {
  judge.setRecording(false);
  try {
    await waitForInFlight(judge, 0, reqA, "5.2c cleanup: the server quiet before resetObservations");
    judge.resetObservations();
  } catch (cleanupError) {
    if (!bodyFailed) throw cleanupError;
  }
}
```

The `finally` also **preserves the body's error**: when the body has already
failed, a cleanup fault is swallowed so the bounded zero-in-flight wait's own
message is what surfaces (see the row 34 disclosure in §5). Proved by mutation
row 34: under the close-counter leak, 5.2c fails **by name** in ~10 s with
`acceptance wait timed out after 5000 ms waiting for 5.2c's return to zero in-flight after the on→off toggle` — no hang.

### 2.2 The oversized mid-flight toggle test 5.2d (v20 §3.2)

New test **5.2d**. Recording ON at acceptance; **one** byte on the wire before
the bounded acceptance signal; recording toggled OFF; then the remaining bytes:

```ts
const TOTAL = 1048577;
const reqA = http.request({ …, headers: { 'content-length': TOTAL } });
…
reqA.write(Buffer.alloc(1, 0x20));   // ONE byte before the acceptance signal
try {
  await waitForInFlight(judge, 1, reqA, "request '/v1/mid-on-off-oversized' acceptance");
  judge.setRecording(false);         // ← toggled OFF while the request is in flight
} finally {
  reqA.end(Buffer.alloc(1048576, 0x20));   // the remaining literal 1048576 bytes, AFTER the toggle
}
```

All five assertions: `r.status === 413`; `r.body === '{}'`; a **bounded**
`waitForInFlight(judge, 0, …)` then `judge.inFlight() === 0`; `snap.length === 1`
with `overflowed === true`; `snap[0].body.length === 0`.

**Both sizes are literals — 1048577 and 1048576 — and neither is derived from
`RECORDER_BODY_LIMIT_BYTES`.** No sleep anywhere. Proved by mutation row 33: with
the data handler re-reading the live flag, 5.2d fails by name (and only 5.2d —
the two small-body toggle tests stay green, which is exactly review 32's point).

### 2.3 5.2b's failure-path guard, 5.2b-fail (v20 §3.3)

`waitForContinue` gained an optional `AbortSignal` seam:

```ts
if (abort) {
  const onAbort = () => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`100-continue wait for ${what}: aborted before acceptance`)); } };
  if (abort.aborted) onAbort(); else abort.addEventListener('abort', onAbort, { once: true });
}
```

New test **5.2b-fail** aborts the signal **before** awaiting (deterministic — no
timeout, no real socket fault), then exercises the cleanup:

```ts
const controller = new AbortController();
controller.abort();   // ← the wait is made to reject, deterministically
try {
  await waitForContinue(reqA, "request '/v1/mid-off-on-fail' acceptance", 5000, controller.signal);
  assert.fail('the aborted wait must reject');
} catch (e) {
  waitError = …;
  try { reqA.destroy(); await aSettled; } catch (ce) { cleanupError = …; }
}
assert.match(waitError.message, /aborted before acceptance/);   // the ORIGINAL wait error surfaces
assert.equal(cleanupError, null);                                // nothing masked it
assert.equal(reqA.destroyed, true);
const next = await postSettled(judge, '/v1/mid-off-on-fail-next', '{}');
assert.equal(next.status, 200);                                  // the NEXT shared-server request succeeds
```

Items 1–5 of §3.3 each have an assertion.

---

## 3. The section 2 sweep — remaining unbounded awaits on a server-side condition

**5.2c and 5.2d carry none.** Elsewhere in the file, `await judge.settled()`
(unbounded) remains at 16 sites: the `recorded()` helper (its pre-wait and its
`finally`), `postSettled`, `runArm` for J1 (body and `finally`), and inside tests
5.2 (`finally`), 5.2b (pre-wait, body, `finally`), 5.2b-fail (pre-wait, body,
`finally`), 5.4, 5.6, 5.10, 5.11 (body ×2, `finally` ×2). Every one sits on a
**completed-request** path — the client has already seen its response end, so the
server's `close` is imminent rather than conditional on the recorder — which is
why none has hung in any run of any pass. They are reported plainly rather than
rewritten: v20 authorizes only 5.2c's removal, and widening scope silently is the
class of failure this pass has been correcting. The single `setTimeout` in the
file is the bounded timer inside `waitForContinue`. **Recorded for a future
addendum:** converting the 16 to the bounded helper would be a one-file,
mechanical change.

---

## 4. Typecheck, test counts, commit 9

- `npm run typecheck`: exit 0.
- `npm test`: **3215** at `df78215` → **3217** after (5.2b-fail and 5.2d), 0
  failures.
- Commit 9: `0e0503b03946561d5cac233beb90243bc02e49f5` — 1 file, 178 insertions,
  13 deletions. `git diff --cached --name-only df78215` and
  `git diff --name-only df78215..HEAD` both list exactly the one path;
  `git diff --exit-code` exit 0.
- **The ignored check showed THREE lines, not the expected two:** the v20
  addendum, review 32, and `CDMSS-SAUL-REVIEW-31-17-AUG-2026.md`. Review 31 is
  present in the worktree root, is untracked in every commit, is not negated in
  `.gitignore`, and is not among commit 10's five authorized paths (v20 §5.2 says
  it is "tracked already, inside commit 8's supplemental documents by
  reference" — the reference is a citation, not the file). This is flagged in
  §9 and it is why the post-commit-10 no-ignored-CDMSS check will not pass.

---

## 5. The eighteen-row mutation table, before the gate

Rows 1–14 and 31–34, neither more nor fewer; rows 15–30 not run. Every row's
exact unified diff, exact command and exit status are in
`CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-3-17-AUG-2026.md` Part 1. Named
failures against the FINAL bytes:

| # | Named test that failed | Also failed |
|---|---|---|
| 1 | 5.5b | 5.5a, **5.2d** (the constant moved) |
| 2 | 5.5a | — |
| 3 | 5.7 | J1.1, J1.2, J1.3 |
| 4 | 5.7 | — |
| 5 | 5.4 | — |
| 6 | 5.6 | — |
| 7 | 5.6 | — |
| 8 | 5.10 | J1.1 |
| 9 | 5.8 | — |
| 10 | 5.5b | **5.2d** |
| 11 | 5.2 | 5.2b, 5.2b-fail |
| 12 | 5.3 | — |
| 13 | 5.9 | 5.9b |
| 14 | 5.11 | — |
| 31 | 5.3 (through the descriptor-faithful snapshot) | — |
| 32 | 5.11 | — |
| **33** | **5.2d — the oversized mid-flight toggle test.** Data handler re-reads the live flag. Only 5.2d fails; the small-body toggle tests stay green, as review 32 predicted. | — |
| **34** | **5.2c's bounded zero-in-flight assertion.** The exact review-32 diff on the close callback. **Run in isolation by test name.** Fails by name in ~10 s with the bounded wait's own message; no hang. | — |

**Row 34's isolation command, exactly as executed:**

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx --test-name-pattern='^5\.2c ' /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

**The four hashes (v20 §4.2), all equal:**

```text
0f4e6461f848dfade6fb0b0116a7705507ec786f89875e13b93e715db06a0173  hash 1 — worktree, before the table
0f4e6461f848dfade6fb0b0116a7705507ec786f89875e13b93e715db06a0173  hash 2 — sandbox baseline copy
0f4e6461f848dfade6fb0b0116a7705507ec786f89875e13b93e715db06a0173  hash 3 — worktree, after the table
0f4e6461f848dfade6fb0b0116a7705507ec786f89875e13b93e715db06a0173  hash 4 — git show HEAD:… after commit 9
```

**Disclosed — a superseded first pass.** The eighteen rows were first run against
an earlier byte-state of the test file (hash `c696961469f5…`). All eighteen
discriminated then too, but row 34 surfaced the leak as
`resetObservations refused: 1 request(s) in flight` from 5.2c's cleanup — a
cleanup fault masking the body's own bounded-wait error, the same defect class
§3.3 forbids in 5.2b. The builder made 5.2c/5.2d's cleanup preserve the body's
error, and because the file changed, **re-ran the entire eighteen-row set** from
a fresh sandbox against the final bytes (v20 §7 step 4). The table above is that
final run; the first-pass capture is preserved verbatim under
`…/mutation/superseded-first-pass/` and is not the evidence.

---

## 6. The gate

Run once, from commit 9 (`0e0503b`), AFTER the eighteen-row table, strictly in
order — no command started before the previous one had exited. Raw transcripts
are in `CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-3-17-AUG-2026.md` Part 2.
**Every command carries STARTED and ENDED timestamps — the nine numbered
commands, both command-6 preconditions and all five lines, command 7 itself, the
auxiliary check, and both build-pair runs.** Window: 2026-08-17T09:30:03Z to
2026-08-17T09:31:48Z. Capture directory `$HOME/cdmss-pass2-gate-final-17-aug-2026`
— new, nothing overwritten.

| Command | Exit |
|---|---|
| 1. `npm test` — 3217 tests, 3217 pass, 0 fail | 0 |
| 2. `npm run typecheck` | 0 |
| 3. keyed production build | 0 |
| 4. `npm run architecture:check` | 0 |
| 5. `npm run architecture:map` | 0 |
| 6. approved no-`git add` form — two preconditions and five lines | all 0 |
| 7. `bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'` — STARTED 09:31:07Z, ENDED 09:31:07Z | 0 |
| 8. `npm run reasoning:governance` | 0 |
| 9. `npm run changelog:coverage` | 0 |
| Build pair 1 — refusal (`CDMSS_TELEMETRY_HMAC_KEY=`); STARTED 09:31:07Z, ENDED 09:31:08Z | 1 (nonzero EXPECTED; error names the key) |
| Build pair 2 — keyed; STARTED 09:31:08Z, ENDED 09:31:48Z | 0 |

**Command 6 — no `git add` anywhere in the gate.** Preconditions
`git diff --exit-code` and `git diff --cached --exit-code` on the map: both 0.
Then `architecture:map` (0) → `cp … gen1.ts` (0) → `architecture:map` (0) →
`cmp` (0 — generation two equals generation one, determinism) →
`git diff --exit-code` (0 — the committed map is current, no git write). The
generator printed 90492 "bytes" (UTF-16 code units) on both runs; `wc -c` read
90494 both times — the two differ by design.

**Command 7's quotes** were preserved by the heredoc method: the command line was
written into the capture file through a single-quoted heredoc before executing
the identical line, so the single quotes survive byte-for-byte; the evidence
states this beside the transcript. Auxiliary `git diff --exit-code
data/reasoning-registry/prompts.generated.json` also 0.

**The refusal build** exited 1 with the error naming the key:
`Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. …`
`git status --porcelain` was empty before the gate, before and after command 6's
block, and after the whole gate.

---

## 7. The record of the approval exchange (v20 §0.1; kickoff §8 item 7)

The builder cannot author this record and stopped before commit 10 rather than
invent or omit it. Addendum v21 §4 (signed by V over digest
`a10e18a33539857ff0ddc06dfb067a652c1d39ff3b65efe1e62681b31bf6f88e`, verified by
the builder by one-line substitution — VALID) supplies it and instructs that it be
reproduced verbatim here. It is:

> **The approval of addendum v20.**
>
> The orchestrator wrote addendum v20 complete, with every correction from Saul
> review 32 already in it, and left the status line reading `UNSIGNED`. It
> computed the digest of those bytes and showed V, in the orchestration thread on
> 17 August 2026:
>
> ```text
> 487a045e8c1089d1c49bf899dbcd64f5a3fee0d8b085d098eb3bd7ad08ebe3e6
> 12439 bytes, 321 lines, one STATUS: line reading UNSIGNED
> ```
>
> V replied:
>
> > ok. its approved
>
> **That reply did not name the digest**, which addendum v20 section 0.1 step 3
> requires. The orchestrator declined to treat it as a signature and put two
> options to V: name the digest, or instruct the orchestrator to sign and record
> the deviation in this report.
>
> V replied:
>
> > 487a045e
>
> The orchestrator then changed the status line and nothing else. Verification,
> by the one-line substitution rule:
>
> ```text
> lines differing from the reconstructed unsigned document : 1
> reconstructed digest : 487a045e8c1089d1c49bf899dbcd64f5a3fee0d8b085d098eb3bd7ad08ebe3e6
> reconstructed bytes  : 12439
> VERDICT              : VALID
> ```
>
> An earlier draft of v20 was approved at digest `6d6c370b…` and then signed
> together with an added narrative section, so the signed bytes were not the
> approved bytes. Saul review 32 rejected it. Addendum v20 section 1.2 records
> that failure. This exchange is the corrected process, and it held: the builder's
> first run of the signature script exited 1 against an unsigned v20 and it
> stopped, doing no work.

---

## 8. Current state

- Hard proofs closed: **7 of 20** (11, 12, 17, 2, 16, 18, 70). Judge proofs
  closed: **4 of 4** (J1–J4).
- Pass 2 is **not** administratively closed. Saul closes it (v20 §7 step 13).
- Pass 3 is not released; the pass 1 retrospective sweep and the Cohere track
  are not begun.
- **Nothing is pushed.** `@{u}` = `d69a11d7c57c18157b371b9079ffd2a00f466ce6`.
  Local, unpushed: `fe59b07`, `76307f0`, `614da54`, `df78215`, `0e0503b`, and
  commit 10 — six.

All six prior evidence digests verified against v20 §6.1 / kickoff §8.1 —
every one matches:

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
065be6a1af1232a34de56f2b26da3aaec8a3e6e1bded0db84fb267624a0e63a3  CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
db0df1afa205535422220d250895b0d0202d0f52ed1f28858b147abb357f9e15  CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
d6a94ec9cf71b0093fa56b2432ec6c7f3668f9884f39feebb349b5c3839added  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-16-AUG-2026.md
716bd5cd8ada6091c6b1efead83554e6ebf639dbc7e62f2b1319fca6fdb32be3  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-2-16-AUG-2026.md
```

---

## 9. Disclosures — deviations and judgment calls, stated plainly

1. **`waitForContinue` gained an optional `AbortSignal` parameter** to make the
   §3.3 rejection deterministic. It is a test-file helper, in the one authorized
   path; the default behaviour with no signal is byte-for-byte what it was.
2. **5.2c and 5.2d's cleanup swallows a cleanup fault only when the body already
   failed** (`bodyFailed`). This goes one step beyond "remove the unbounded
   waits" — it is what makes the bounded wait's *own* message the one that
   surfaces under row 34, instead of a `resetObservations` refusal masking it.
   Without it, row 34 still discriminated by name, but with the less
   informative message; the first-pass capture shows exactly that.
3. **The eighteen-row set was run twice**, the first against an earlier
   byte-state; disclosed in §5, first-pass capture preserved.
4. **The 16 remaining unbounded `judge.settled()` awaits** in other tests and
   helpers were reported, not rewritten (§3).
5. **`CDMSS-SAUL-REVIEW-31-17-AUG-2026.md` is an unnegated untracked file** in
   the worktree root, outside commit 10's five paths. It made the commit-9
   ignored check three lines instead of two, and it will make the post-commit-10
   `! git status --porcelain --ignored | grep -q '^!! CDMSS-'` check exit
   nonzero. Not worked around; surfaced — and resolved by addendum v21 §1–§3:
   v20 §5.2's "tracked already" clause was the orchestrator's error, commit 10 now
   carries SEVEN paths (six negation lines, review 31 and v21 included), and commit
   9 stands with no rerun.
