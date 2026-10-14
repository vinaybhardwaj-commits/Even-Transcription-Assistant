# CDMSS proof pass 2 — supplemental report 2 for Saul (the recorder and documentary repair)

Date: 17 August 2026 (work executed against the 16 August kickoff)
Authority: **Saul review 30.** Governing addendum:
`CDMSS-RERANK-TELEMETRY-ADDENDUM-v19-16-AUG-2026.md`, signed by V
(`STATUS: SIGNED by V, 16 August 2026` — read, not grepped). Addenda v15 to v18
govern everything v19 does not touch.

Base: commit 6 at `76307f0f8ca40b238cdd75ed2dbe286613b282bf`.
Commit 7 (the recorder and comment repair):
`614da5425439264ffd8a56dea6f704a6b14463c7` — exactly the three authorized test
paths. Commit 8 is the commit carrying this report; its SHA is in the builder's
covering report, since a commit cannot contain its own hash.

Review 30 **closed all six held proofs** — pass 2's nine are technically done
(2, 16, 17, 18, 70, J1, J2, J3, J4) — and held administrative completion on six
narrow defects: three in the recorder, three documentary. All six are cleared
here. Commits 1 to 6 stand. **Nothing is pushed**: review 30 holds `fe59b07`
and `76307f0` (and now `614da54` and commit 8) local; `@{u}` remains
`d69a11d7c57c18157b371b9079ffd2a00f466ce6`.

---

## 1. Stop conditions

1. Addendum v19 §0 read in full: exactly one `STATUS:` line —
   `STATUS: SIGNED by V, 16 August 2026`. It names V. PASS.
2. `git rev-parse HEAD` printed `76307f0f8ca40b238cdd75ed2dbe286613b282bf`. PASS.
3. `git status --porcelain` printed nothing. PASS.
4. `git rev-parse @{u}` printed `d69a11d7c57c18157b371b9079ffd2a00f466ce6` —
   two commits unpushed, staying that way. PASS.

---

## 2. Proof 17, quoted VERBATIM (the documentary omission, v19 §3.4)

Source: `CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md`, §6, the
numbering authority. The previous supplemental report quoted proofs 2, 16, 18
and 70 and omitted 17; proof 17 is closed, and this is the documentary
compliance review 30 required:

> 17. The judge path cannot reach `inputOrder()`: a per-batch throw warns, continues, and leaves `rerank_soft_failed` false.

---

## 3. The v18 symbol erratum, restated (v19 §2, §3.4)

Addendum v18 §3.1 reads:

> production assembles it in `lib/opd-note-audit.ts`, in `finaliseTelemetry`

**No such symbol exists.** The symbol is `writeRetrievalTerminals`. The
corrected text, per addendum v19 §2:

> production assembles it in `lib/opd-note-audit.ts`, in `writeRetrievalTerminals`

The assembly line v18 quotes —
`defectsByRole.primary = validateManifest({ ...primaryPayload, operational: primaryOperational })` —
is correct and exists verbatim at that site, so no work built from the
instruction is wrong. The error is the function name only, and it was the
orchestrator's. Addendum v18 is not edited; this erratum stands as the
correction, as review 30 directed.

---

## 4. The three recorder repairs

### 4.1 The recording decision is sampled once (v19 §3.1)

`judge-server-stub.ts`: acceptance used to read `recording`, and the `data`,
`end` and `close` handlers each re-read its current value. A mid-flight toggle
could produce an observation with `seq: -1`, lose an accepted observation, or
leak the in-flight count. The decision is now captured once, at acceptance:

```ts
const recordThisRequest = recording;
const seq = recordThisRequest ? nextSeq++ : -1;
const socketId = recordThisRequest ? socketIdentityOf(req.socket) : -1;
if (recordThisRequest) inFlight += 1;
```

…and `recordThisRequest` is used through the `data` handler's limit check, the
`end` handler's observation push, and the `close` handler's in-flight
decrement. The module-level flag is never read again for a request already
accepted — after the repair, `recording` is read only at its declaration and in
`setRecording`.

**Two new mid-flight tests** in `explicit-judge-equivalence.test.ts`, both
asserting the in-flight count, because a leak there is the failure mode that
hides behind a passing observation check:

- **5.2b, off→on**: a request is accepted while recording is off (acceptance
  observed through `Expect: 100-continue` — the server auto-writes 100 Continue
  in the same synchronous block that samples the decision, so the client's
  `continue` event proves the sampling happened while off), recording is turned
  on mid-flight, the request completes. Asserts: `judge.inFlight() === 0`, an
  empty snapshot (no observation, so no `seq: -1` artifact), and that the
  sequence counter never advanced — the next recorded request is seq 0.
- **5.2c, on→off**: accepted while recording is on (bounded in-flight wait),
  recording turned off mid-flight. Asserts: `judge.inFlight() === 0`, exactly
  one observation with the full 10-byte body, and a real `seq`
  (`notEqual(seq, -1)`, `seq >= 0`).

Both fail against the pre-repair recorder: off→on produced a `seq: -1`
observation; on→off lost the accepted observation.

### 4.2 The snapshot is descriptor-faithful (v19 §3.2)

`snapshot()` cloned with object spread, which drops non-enumerable properties —
so `Reflect.ownKeys(judge.snapshot()[0])` could never see a non-enumerable
stored authorization field, and the 5.3 no-headers guard was blind to it
(mutation row 29's symbol is enumerable and never exercised this). The clone is
now built from own-property descriptors, and the body is still a copied Buffer:

```ts
return observations.map((o) => {
  const clone: JudgeObservation = Object.create(Object.getPrototypeOf(o), Object.getOwnPropertyDescriptors(o));
  clone.body = Buffer.from(o.body);
  return clone;
});
```

Faithful AND defensive together: the existing defensive-snapshot tests (5.7 —
array push, object write, Buffer write all stay out of the store) still pass,
run before the table and inside it (rows 3 and 4 still discriminate against a
shared-array and a shared-Buffer snapshot respectively). v15 §5.7 is unchanged.

### 4.3 Bounded, fail-loud acceptance waits (v19 §3.3)

The v18-era acceptance poll in 5.4 had no timeout and no request-error
rejection, and the release did not cover a failure before the wait resolved —
it could hang the file, and a test that hangs instead of failing has an
invisible failure mode. One helper now carries the three required properties:

```ts
function waitForInFlight(judge: JudgeServer, target: number, held: http.ClientRequest, what: string, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    let done = false;
    const fail = (e: Error) => { if (!done) { done = true; reject(e); } };
    held.on('error', (e) => fail(new Error(`acceptance wait for ${what}: request error: ${e.message}`)));
    const tick = () => {
      if (done) return;
      if (judge.inFlight() === target) { done = true; resolve(); return; }
      if (Date.now() - startedAt > timeoutMs) {
        fail(new Error(`acceptance wait timed out after ${timeoutMs} ms waiting for ${what}`));
        return;
      }
      setImmediate(tick);
    };
    tick();
  });
}
```

1. **Bounded** — on expiry it rejects with a message stating what it waited
   for, and the rejection surfaces as the named test's failure.
2. **Request-error rejection** — a socket error rejects instead of stalling
   (and the listener stays attached, so a late error cannot crash the process).
3. **Outer-`finally` release** — in both 5.4 and 5.6, the held request's
   release (`req.end(...)`) sits in a `finally` OUTSIDE the acceptance wait, so
   it runs whether or not the wait resolved.

**Applied to 5.6 as well: its 30 ms sleep is gone** (it was left in under v18,
which authorized only 5.4; v19 authorizes it). A companion `waitForContinue`
with the same bounded/fail-loud/error-rejecting shape serves 5.2b, where the
in-flight counter cannot move.

---

## 5. The two comment corrections (v19 §3.5)

**Proof 70's review-28 comments, `rerank-pass-2.test.ts`** — comment-only, no
assertion moved. Two sites:

1. The file header's "WHAT THIS FILE DOES NOT CLAIM" bullet. Was:
   > Nothing about "the base-to-commit production byte comparison" review 28 named. That phrase is defined nowhere in the corpus; addendum v15 §4.3 declines it pending clarification. Proof 70's byte requirement is the SOURCE-PARITY sentence quoted from kickoff v11, and that is what 70.4 asserts.

   Now:
   > Nothing beyond source parity for proof 70's byte requirement. Review 28's "base-to-commit production byte comparison" is RESOLVED, not declined: review 29 defined it as the repository production-path diff, recorded that the condition PASSED, and withdrew addendum v15 §4.3's decline (addendum v18 §1.4). Proof 70's own byte requirement remains the SOURCE-PARITY sentence quoted from kickoff v11, and that is what 70.4 asserts.

2. Test 70.4's opening comment. Was:
   > It is not a wire comparison; see this file's header on the review 28 phrase that v15 §4.3 declines.

   Now:
   > It is not a wire comparison. Review 28's "base-to-commit production byte comparison" is RESOLVED (addendum v18 §1.4): review 29 defined it as the repository production-path diff and recorded that the condition passed; v15 §4.3's decline is withdrawn.

**The socket-identity / sequence-numbering analogy** — found in
`lib/__tests__/judge-server-stub.ts`, the module comment above the socket-id
WeakMap (not in a test). It said:

> The counter only ever grows — an identity is never reused, exactly like `seq`.

That misstates the relationship: `resetObservations` returns the **seq**
counter to 0, so seq values recur across resets, while the socket-identity
counter is never reset. It now reads:

> The counter only ever grows and an identity is never reused — UNLIKE `seq`, which `resetObservations` returns to 0 and whose values therefore recur across resets (v19 §3.5 corrects the earlier "exactly like `seq`" analogy, which misstated this). Identity is a property of the SOCKET, not of the observation store, so no reset touches it.

---

## 6. Corrected timestamp wording (v19 §3.6)

**What the previous evidence (`CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-16-AUG-2026.md`)
actually holds, stated plainly:** its numbered commands 1–6, 8, 9, the
command-7 auxiliary check and the keyed build each carry STARTED and ENDED
timestamps, but **command 7's own transcript carries no timestamps at all, and
the refusal build carries a start timestamp with no ENDED line.** Any earlier
wording implying per-command timestamp completeness for the whole gate
overstated what that file holds. The ordered gate log in that capture is
sufficient to establish sequence, and review 30 required no gate rerun.

**This round's evidence** (`CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-2-16-AUG-2026.md`)
records STARTED and ENDED timestamps for **every** command — the nine numbered
commands, both command-6 preconditions and all five lines, command 7 itself,
the auxiliary check, and both build-pair runs, the refusal included.

---

## 7. The mutation table — thirty-two rows, run BEFORE the gate

All thirty rows of addendum v18 re-ran in full — v19 §3.1 and §3.2 change the
recorder itself, and rows 1–14 all name recorder tests, so the old runs prove
nothing about the new recorder — plus the two new rows. Every row failed its
named test **by name**; no file-level timeouts; every row's exact unified diff,
exact command and exit status are in the new evidence document, Part 1.

| # | Named test that failed | Also failed (collateral) |
|---|---|---|
| 1 | 5.5b | 5.5a (the constant's source pin) |
| 2 | 5.5a | — |
| 3 | 5.7 | J1.1, J1.2, J1.3 (snapshot poisoned for the wire compare) |
| 4 | 5.7 | — |
| 5 | 5.4 | — |
| 6 | 5.6 | — |
| 7 | 5.6 | — |
| 8 | 5.10 | J1.1 |
| 9 | 5.8 | — |
| 10 | 5.5b | — |
| 11 | 5.2 | 5.2b (the new off→on mid-flight test) |
| 12 | 5.3 | — |
| 13 | 5.9 | 5.9b |
| 14 | 5.11 | — |
| 15 | J2.1, J2.2 | 17.1, 18.1, 18.3, 70.1, 70.2, 70.3 |
| 16 | J2.1, J2.2 | 17.1, 18.1 |
| 17 | 70.1 | 70.2, 70.3 |
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
| 29 | 5.3 (enumerable symbol) | — |
| 30 | J4.2 | J4.1 |
| **31** | **5.3 — the no-headers check, through the descriptor-faithful snapshot.** A NON-ENUMERABLE `authorizationHeader` stored via `Object.defineProperty`; the spread-based snapshot dropped it, and only the §3.2 fix surfaces it. This is precisely the case row 29 (enumerable symbol) misses. | — |
| **32** | **5.11 — the parsed-API guard (v15 §5.11).** A hidden non-enumerable `rawBodyBytes` on the parsed `JudgeRequest`; `judge.requests` hands back the stored objects directly and `Reflect.ownKeys` sees the hidden key. | — |

Sandbox: built per kickoff v3 §9.1, shape verified, deleted after the table.
No git command ran inside it (cwd stayed at the worktree; imports resolved from
the sandbox).

---

## 8. Typecheck, test counts, commit 7

- `npm run typecheck`: exit 0.
- `npm test`: 3213 at `76307f0` → **3215** after the repairs (the two additions
  are 5.2b and 5.2c). 0 failures both times.
- Commit 7: `614da5425439264ffd8a56dea6f704a6b14463c7`, exactly three paths:

```text
lib/__tests__/explicit-judge-equivalence.test.ts | 206 +++++++++++++++++++----
lib/__tests__/judge-server-stub.ts               |  39 ++++-
lib/__tests__/rerank-pass-2.test.ts              |  13 +-
3 files changed, 212 insertions(+), 46 deletions(-)
```

`git diff --cached --name-only 76307f0` listed exactly the three paths (the
`rerank-pass-2.test.ts` delta is comment-only); `git diff --exit-code` exited
0; the ignored check showed exactly the two expected lines (v19 addendum +
review 30). Not pushed.

---

## 9. The gate

Run once, from commit 7, AFTER the 32-row mutation table, strictly in order —
no command started before the previous one had exited. Raw transcripts are in
`CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-2-16-AUG-2026.md` Part 2. **Every
command carries STARTED and ENDED timestamps this round — the nine numbered
commands, command 6's preconditions and five lines, command 7 itself, the
auxiliary check, and both build-pair runs** (v19 §3.6 / kickoff §8). Run
window: 2026-08-17T05:15:14Z to 2026-08-17T05:16:51Z.

| Command | Exit |
|---|---|
| 1. `npm test` — 3215 tests, 3215 pass, 0 fail | 0 |
| 2. `npm run typecheck` | 0 |
| 3. keyed production build (`env VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build`) | 0 |
| 4. `npm run architecture:check` | 0 |
| 5. `npm run architecture:map` | 0 |
| 6. the APPROVED no-`git add` form — two preconditions and five lines | all 0 |
| 7. `bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'` — quotes preserved; STARTED 05:16:15Z, ENDED 05:16:15Z | 0 |
| 8. `npm run reasoning:governance` | 0 |
| 9. `npm run changelog:coverage` | 0 |
| Build pair 1 — refusal (`CDMSS_TELEMETRY_HMAC_KEY=`); STARTED 05:16:15Z, ENDED 05:16:16Z | 1 (nonzero EXPECTED; error names the key) |
| Build pair 2 — keyed; STARTED 05:16:16Z, ENDED 05:16:50Z | 0 |

**Command 6, the approved form — no `git add` was used.** Both preconditions
(`git diff --exit-code` and `git diff --cached --exit-code` on the map) exited
0; then `architecture:map` (0) → `cp … gen1.ts` (0) → `architecture:map` (0) →
`cmp` (0 — generation two equals generation one, determinism) →
`git diff --exit-code` (0 — the committed map is current; no git write). The
generator printed 90492 "bytes" (UTF-16 code units) on both runs; `wc -c` read
90494 both times — the two differ by design.

**Command 7's quotes** were preserved by the heredoc method that worked last
round: the command line was written into the capture file through a
single-quoted heredoc before executing the identical line, so the quotes
survive byte-for-byte; the evidence states this beside the transcript.

**The refusal build** exited 1 with the error naming the key:

```text
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3). Set it in Vercel Production before deploying.
```

`git status --porcelain` was empty before the gate, before and after command
6's block, and after the whole gate; `--ignored` showed only the two expected
CDMSS lines (the v19 addendum and review 30) plus standard build artifacts.
Capture directory: `$HOME/cdmss-pass2-gate-recorder-16-aug-2026` — new, nothing
overwritten.

---

## 10. Evidence integrity

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
065be6a1af1232a34de56f2b26da3aaec8a3e6e1bded0db84fb267624a0e63a3  CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
db0df1afa205535422220d250895b0d0202d0f52ed1f28858b147abb357f9e15  CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
d6a94ec9cf71b0093fa56b2432ec6c7f3668f9884f39feebb349b5c3839added  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-16-AUG-2026.md
```

The first three match the kickoff's pinned values exactly. The fourth and fifth
are computed and recorded as required (the fifth also matches the shasum in
commit 6's message). No earlier evidence file, report, addendum or review was
edited in this round.

---

## 11. Disclosures — deviations and judgment calls, stated plainly

1. **5.2b's acceptance signal uses `Expect: 100-continue`.** An unrecorded
   request moves no counter, so the bounded in-flight wait cannot observe its
   acceptance; the server's automatic `100 Continue` is written in the same
   synchronous block that runs the request handler and samples the recording
   decision, so the client's `continue` event is a sound acceptance signal. The
   companion `waitForContinue` helper carries the same bounded, fail-loud,
   error-rejecting properties as `waitForInFlight`. No stub change was needed
   for this.
2. **Mutation row 19 remains implemented as a catch-rethrow** (as in the v18
   round): the catch's containment (`console.warn`) becomes `throw e;`,
   functionally equivalent to removing the per-batch try/catch. The exact diff
   is recorded.
3. **Rows 31 and 32 were applied as multi-line edits** (an
   `Object.defineProperty` wrapper around the existing push literal) rather
   than single-line seds; their exact unified diffs are recorded like every
   other row's.
4. **The `void aDone.catch(() => {})` lines** beside the held requests in 5.4,
   5.6, 5.2b and 5.2c mark the response promise handled if the bounded wait
   rejects first, so a rejected fixture promise cannot surface as an unhandled
   rejection while `await` still observes it later. This is part of the
   fail-loud plumbing, noted for completeness.
