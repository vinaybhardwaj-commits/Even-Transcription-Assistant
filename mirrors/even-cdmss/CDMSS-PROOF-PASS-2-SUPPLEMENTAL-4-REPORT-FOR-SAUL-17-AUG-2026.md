# CDMSS proof pass 2 — supplemental report 4 for Saul (the shared 5.2b cleanup)

Date: 17 August 2026 (the path addendum v22 §6.2 prescribes; the work itself ran on
18 August 2026 UTC, 03:26Z–03:38Z, and every timestamp in this report and its
evidence file is the true clock time — nothing is backdated).
Authority: **Saul review 33.** Governing addendum:
`CDMSS-RERANK-TELEMETRY-ADDENDUM-v22-17-AUG-2026.md`, signed by V over a digest
that the builder **verified by one-line substitution before any other work**
(section 1 below). Addenda v15 to v21 govern everything v22 does not touch.
Addendum v19 is preserved unchanged, with its false signature line intact, as
review 31 ruled; v20 §1 is the truthful record. The supplemental-3 report's stale
wording stands as documentary errata (review 33) and is not rewritten.

Base: commit 10 at `f6e918895aeca2bc4be9e659d18b1db3d717b11e`.
Commit 11 (the shared cleanup repair): `a4d61ae0b9c292829e058bcfff2a27f07b95aa5d`
— exactly one path, `lib/__tests__/explicit-judge-equivalence.test.ts`.
`judge-server-stub.ts` is untouched. Commit 12 is the commit carrying this
report (five paths per v22 §6.2); its SHA is in the builder's covering report.

**Nothing is pushed.** `@{u}` remains `d69a11d7c57c18157b371b9079ffd2a00f466ce6`;
eight commits will be held local when commit 12 lands.

---

## 1. The signature verification — full script output (v22 §0.1, kickoff §1.1)

Run verbatim from the worktree, before any other work:

```text
claimed   : 25af48ec9ad714dfc97c34fcd2aa10dd69dd074f3f111f29ceb7f47390910806
recomputed: 25af48ec9ad714dfc97c34fcd2aa10dd69dd074f3f111f29ceb7f47390910806
VERDICT   : VALID
exit=0
```

Exactly one `STATUS:` line; replacing it alone with `STATUS: UNSIGNED` reproduced
the named digest. No other line was deleted, added or moved.

Stop conditions 2–4: `git rev-parse HEAD` → `f6e918895aeca2bc4be9e659d18b1db3d717b11e`;
`git status --porcelain` → empty; `git rev-parse @{u}` → `d69a11d7c57c18157b371b9079ffd2a00f466ce6`.
All PASS.

---

## 2. The repair — one shared bounded cleanup helper (v22 §2)

All in `lib/__tests__/explicit-judge-equivalence.test.ts`, the only path commit
11 changes. Line numbers are those of the committed file.

### 2.1 The helper (lines 228–262)

```ts
async function destroyAndAwaitAfterRejectedWait(held: http.ClientRequest, waitError: unknown, what: string, timeoutMs = 5000): Promise<never> {
  held.destroy();
  await new Promise<void>((resolve, reject) => {
    if (held.closed) { resolve(); return; }
    const timer = setTimeout(() => {
      const cause = waitError instanceof Error ? waitError.message : String(waitError);
      reject(new Error(`bounded cleanup timed out after ${timeoutMs} ms waiting for ${what} to terminate after destroy (the original wait error was: ${cause})`));
    }, timeoutMs);
    held.once('close', () => { clearTimeout(timer); resolve(); });
  });
  throw waitError;
}
```

The three required steps, in order:

1. **Destroy** — `held.destroy()`.
2. **Boundedly await termination** — the request's **own** terminal signal, its
   `'close'` event, which follows both the destroy's `'error'` and a response's
   end. **It does not use `judge.settled()`** — the recorder never counted a
   request accepted while recording was off, so `settled()` cannot see it; that
   blindness is the finding. On expiry it fails **by name**, stating what it
   waited for and carrying the original wait error's message so neither cause is
   lost. A request that had already terminated before the helper ran (the wait
   rejected on the request's own error, whose `'close'` follows synchronously) is
   recognised via `closed` and not waited for again.
3. **Rethrow the original wait error**, unchanged (`throw waitError`). The return
   type `Promise<never>` says it never returns normally.

The runtime facts the helper rests on were probed on this Node (v22.20.0) against
`127.0.0.1` before the helper was written, in a scratchpad file outside the
worktree: `closed` is a real getter on `OutgoingMessage.prototype`;
`destroy()` → `'error'` (ECONNRESET) → `'close'`, with `closed` still `false`
immediately after `destroy()` (termination is asynchronous — which is what makes
"awaited" testable); and `'close'` follows `'error'` synchronously, so by the
microtask in which the awaiting caller resumes, `closed` is already `true`.

### 2.2 Actual 5.2b uses it on the failure path (lines 328–341)

```ts
    try {
      await waitForContinue(reqA, "request '/v1/mid-off-on' acceptance");
    } catch (waitError) {
      // THE FAILURE PATH (v22 §2.2, review 33). The wait rejected: the SHARED helper — the one
      // 5.2b-fail exercises — destroys the request, boundedly awaits its termination, and rethrows
      // the wait error. NOT `reqA.end()`: releasing the body is the SUCCESS path's release, and on
      // this path it left the request neither terminated nor awaited while `judge.settled()` in the
      // outer finally, blind to a request the recorder never counted, returned at once.
      await destroyAndAwaitAfterRejectedWait(reqA, waitError, "request '/v1/mid-off-on'");
    }
    judge.setRecording(true);            // ← toggled ON while the request is in flight
    reqA.end('ABCD');   // THE SUCCESS PATH: the body, released — the request completes and `aDone` sees its response
    await aDone;
    await judge.settled();
```

`reqA.end('ABCD')` stays for the success path; on rejection the request is
destroyed and awaited by the helper, which rethrows. The `try…finally` that
released the body on both paths is gone; the toggle-then-release order on the
success path is unchanged. 5.2b's three `await judge.settled()` (pre-wait, body,
`finally`) are untouched.

### 2.3 5.2b-fail exercises the same helper (lines 357–424)

```ts
    let closeSeen = false;
    reqA.on('close', () => { closeSeen = true; });
    reqA.on('error', () => {});
    reqA.on('response', (res) => { res.resume(); });
    const controller = new AbortController();
    controller.abort();   // ← the wait is made to reject, deterministically, before it is even awaited
    let surfaced: Error | null = null;
    let closedWhenSurfaced = false;
    try {
      try {
        await waitForContinue(reqA, "request '/v1/mid-off-on-fail' acceptance", 5000, controller.signal);
      } catch (waitError) {
        // EXACTLY 5.2b's failure path — the same shared helper, the same call shape.
        await destroyAndAwaitAfterRejectedWait(reqA, waitError, "request '/v1/mid-off-on-fail'");
      }
      assert.fail('the aborted wait must reject, and the shared cleanup must rethrow it');
    } catch (e) {
      surfaced = e instanceof Error ? e : new Error(String(e));
      closedWhenSurfaced = closeSeen;
    }
    assert.ok(surfaced, 'an error surfaced');
    assert.match(surfaced.message, /aborted before acceptance/, 'the real cause — the wait error — is what surfaces');
    assert.match(surfaced.message, /mid-off-on-fail/, 'and it names what was waited for');
    assert.equal(reqA.destroyed, true, 'the request was destroyed');
    assert.equal(closedWhenSurfaced, true, "the helper awaited the request's termination — close had fired before the wait error resurfaced");
    assert.equal(reqA.closed, true, 'and the request is terminated now');
    await judge.settled();
    assert.equal(judge.inFlight(), 0, 'nothing in flight — the unrecorded request moved no counter and nothing leaked');
    const next = await postSettled(judge, '/v1/mid-off-on-fail-next', '{}');
    assert.equal(next.status, 200, 'the next request on the shared server succeeds');
    assert.deepEqual(judge.snapshot(), [], 'recording was off throughout — nothing observed');
```

**5.2b-fail calls the helper; it does not duplicate its logic.** The previous
`aSettled` promise, its `reqA.destroy()`, its unbounded `await aSettled` and its
separately-captured `cleanupError` are all gone. The test's listeners are
observers only: `closeSeen` records the request's own terminal event, and
`closedWhenSurfaced` — sampled at the moment the rethrown error is caught — is
what proves the helper **awaited** termination rather than merely calling
`destroy()`. Every 5.2b-fail assertion after the helper is a named `assert.*`;
none waits on anything. The helper does not use `judge.settled()`; the
`await judge.settled()` calls that remain in 5.2b-fail (pre-wait, body, `finally`)
are three of the sixteen recorded waits and are byte-identical to before.

Could 5.2b-fail now pass while actual 5.2b still leaked? No: both call the one
function `destroyAndAwaitAfterRejectedWait` with the same call shape, and
auxiliary check A1 (§5.1) forced actual 5.2b's **own** wait to reject with the
request live on the shared server and observed the real path run the helper.

### 2.4 The header correction (v22 §4)

Line 9 **as it was**:

```text
 * key sites (§3.7b), and 5.4's deterministic acceptance signal (§3.7c). Addendum v19 (signed by V,
```

Lines 9–11 **as they now read**:

```text
 * key sites (§3.7b), and 5.4's deterministic acceptance signal (§3.7c). Addendum v19 (16 August 2026,
 * under Saul review 30; NOT signed by V — addendum v20 §1 records the chronology, and review 31
 * preserves v19 unchanged as historical evidence) governs the recorder repair round: the once-sampled
```

Every other `v19 §…` reference in the file is a section citation and was not
rewritten. Four header lines were also **added** (lines 19–22), citing v22 as the
governing addendum for this round in the same form the header already uses for
v18, v20 — disclosed in §9.

### 2.5 The sixteen waits — untouched (v22 §5)

The sixteen `await judge.settled()` sites are byte-identical, in the same order,
before and after commit 11 (verified by diffing the two files' `await
judge.settled()` line contents: identical). Their line numbers shifted with the
insertions and are now 147, 155, 164, 304, 313, 341, 354, 368, 418, 423, 614,
716, 863, 895, 920 and 927. None was bounded, moved or rewritten. They remain
recorded test-harness debt for the separate bounded-settlement hardening task,
which is not authorized here.

---

## 3. Typecheck, test counts, commit 11

- `npm run typecheck`: exit 0.
- `npm test`: **3217** at `f6e9188` (measured before any edit) → **3217** after
  (5.2b-fail was rewritten, none added), 0 failures.
- No cast, non-null assertion, `@ts-ignore` or `@ts-expect-error` was added;
  `tsconfig.json` unchanged; no bare sleep; no socket to any host but
  `127.0.0.1`.
- Staging validations against `f6e9188`: `git status --porcelain
  --untracked-files=all` → `M  lib/__tests__/explicit-judge-equivalence.test.ts`;
  `git diff --cached --stat f6e9188` → 1 file, 95 insertions, 38 deletions;
  `git diff --cached --name-only f6e9188` → exactly the one path;
  `git diff --exit-code` → 0. The ignored check showed exactly the two expected
  lines (`!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v22-17-AUG-2026.md`,
  `!! CDMSS-SAUL-REVIEW-33-17-AUG-2026.md`).
- Commit 11: `a4d61ae0b9c292829e058bcfff2a27f07b95aa5d`. `git diff --name-only
  f6e9188..HEAD` → exactly the one path. `git status --porcelain` empty after.

---

## 4. The nineteen-row mutation table, before the gate (v22 §3)

Rows 1–14 and 31–35, neither more nor fewer; rows 15–30 not run. Every row's
exact unified diff, exact command, exit status, STARTED/ENDED and named failures
are in `CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-4-17-AUG-2026.md` Part 1. Rows
1–14 and 31–34 were applied from the previous round's recorded diffs (the stub is
byte-identical since) and re-diffed; row 35 is new and mutates the sandbox copy
of the **test file**. Named failures against the committed bytes:

| # | Named test that failed | Also failed | Exit |
|---|---|---|---|
| 1 | 5.5b | 5.5a, 5.2d (the constant moved) | 1 |
| 2 | 5.5a | — | 1 |
| 3 | 5.7 | J1.1, J1.2, J1.3 | 1 |
| 4 | 5.7 | — | 1 |
| 5 | 5.4 | — | 1 |
| 6 | 5.6 | — | 1 |
| 7 | 5.6 | — | 1 |
| 8 | 5.10 | J1.1 | 1 |
| 9 | 5.8 | — | 1 |
| 10 | 5.5b | 5.2d | 1 |
| 11 | 5.2 | 5.2b, 5.2b-fail | 1 |
| 12 | 5.3 | — | 1 |
| 13 | 5.9 | 5.9b | 1 |
| 14 | 5.11 | — | 1 |
| 31 | 5.3 (through the descriptor-faithful snapshot) | — | 1 |
| 32 | 5.11 | — | 1 |
| 33 | 5.2d — the oversized mid-flight toggle test | — | 1 |
| 34 | 5.2c's bounded zero-in-flight assertion. **Run in isolation by test name.** Fails by name in ~10 s (`acceptance wait timed out after 5000 ms waiting for 5.2c's return to zero in-flight after the on→off toggle`); no hang. | — | 1 |
| **35** | **5.2b-fail — the shared cleanup helper DEFEATED** (body reduced to `throw waitError;` — no destroy, no bounded await). **Run in isolation by test name.** Fails **by name** with `the request was destroyed — false !== true` (`ERR_ASSERTION`) 121 ms into the test; whole run 327 ms; **no timeout**. | — | 1 |

Identical named tests to the supplemental-3 run for rows 1–14 and 31–34.

**Row 35's isolation command, exactly as executed:**

```text
node --test --import tsx --test-name-pattern='^5\.2b-fail ' /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
STARTED: 2026-08-18T03:33:34Z
ENDED: 2026-08-18T03:33:34Z
```

**Row 35's mutation diff:**

```diff
@@ -249,15 +249,6 @@
  *      cleanup error masking it. The return type says so: this never returns normally.
  */
 async function destroyAndAwaitAfterRejectedWait(held: http.ClientRequest, waitError: unknown, what: string, timeoutMs = 5000): Promise<never> {
-  held.destroy();
-  await new Promise<void>((resolve, reject) => {
-    if (held.closed) { resolve(); return; }
-    const timer = setTimeout(() => {
-      const cause = waitError instanceof Error ? waitError.message : String(waitError);
-      reject(new Error(`bounded cleanup timed out after ${timeoutMs} ms waiting for ${what} to terminate after destroy (the original wait error was: ${cause})`));
-    }, timeoutMs);
-    held.once('close', () => { clearTimeout(timer); resolve(); });
-  });
   throw waitError;
 }
```

**Row 35 failed by name and did not time out**: `not ok 1 - 5.2b-fail — …`,
`failureType: 'testCodeFailure'`, `code: 'ERR_ASSERTION'`, `duration_ms: 121.3`,
file total `duration_ms: 327.1`.

**Row 34's isolation command, exactly as executed:**

```text
cd /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry && node --test --import tsx --test-name-pattern='^5\.2c ' /Users/vinaybhardwaj/cdmss-pass2-sandbox/repo/lib/__tests__/explicit-judge-equivalence.test.ts
exit=1
```

**The four hashes (v22 §3.1 / kickoff §6), all equal:**

```text
4d9b32f328ceb76384f21894e6fd8c945114efbfa622907ad1df5da3a9943708  hash 1 — worktree, before the table
4d9b32f328ceb76384f21894e6fd8c945114efbfa622907ad1df5da3a9943708  hash 2 — sandbox baseline copy
4d9b32f328ceb76384f21894e6fd8c945114efbfa622907ad1df5da3a9943708  hash 3 — worktree, after the table
4d9b32f328ceb76384f21894e6fd8c945114efbfa622907ad1df5da3a9943708  hash 4 — git show HEAD:… after commit 11
```

The tested bytes are the committed bytes. The nineteen rows were run once,
against these bytes; there is no superseded pass this round. Sandbox at
`/Users/vinaybhardwaj/cdmss-pass2-sandbox/repo`, shape verified (dotfiles present,
`lib/__tests__` present with both files, `.git` and `.next` absent, `node_modules`
a symlink, stub `cmp`-identical to the worktree), deleted after the table; no git
command inside it; each mutated file restored with `cp` and verified with `cmp`
after its row.

---

## 5. Auxiliary sandbox checks — not table rows, disclosed

Two further sandbox runs, made to verify the repair reaches the **real** path.
They are not rows, are not rows 15–30, and changed nothing in the worktree;
captures under `…/mutation/auxiliary-not-table-rows/`, transcribed in the
evidence file Part 1.

### 5.1 A1 — actual 5.2b's own wait rejects at acceptance, request live on the shared server

An abort fired from `reqA`'s own `'continue'` event, so `waitForContinue`
rejected at exactly the moment the request was accepted, uncounted, on the
shared server — review 33's scenario. Whole-file run: **5.2b failed by name with
the original wait error** (`100-continue wait for request '/v1/mid-off-on'
acceptance: aborted before acceptance`), rethrown by the shared helper after
destroy-and-await; **the other 20 tests all passed** (5.2b-fail and the next
shared-server requests included), whole file 339 ms, no hang. Had the helper not
run on 5.2b's real failure path, control would have fallen through to
`judge.setRecording(true); reqA.end('ABCD')` and 5.2b would have passed. It did
not.

### 5.2 A2 — the helper defeated the other way: destroy without awaiting

`held.destroy(); throw waitError;`. Isolation run of 5.2b-fail: fails **by name**
at `the helper awaited the request's termination — close had fired before the
wait error resurfaced: false !== true`, 110 ms into the test; no timeout. This is
the assertion that distinguishes "awaited" from "destroyed and moved on", and it
would equally catch a helper that awaited `judge.settled()` (which returns at
once for an uncounted request).

---

## 6. The gate

Run once, from commit 11 (`a4d61ae`), AFTER the nineteen-row table, strictly in
order — no command started before the previous one had exited. Raw transcripts
are in `CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-4-17-AUG-2026.md` Part 2. **Every
command carries STARTED and ENDED timestamps — the nine numbered commands, both
command-6 preconditions and all five lines, command 7 itself, the auxiliary
check, and both build-pair runs.** Window: 2026-08-18T03:36:12Z to
2026-08-18T03:37:48Z. Capture directory `$HOME/cdmss-pass2-gate-cleanup-17-aug-2026`
— new, nothing overwritten.

| Command | STARTED | ENDED | Exit |
|---|---|---|---|
| 1. `npm test` — 3217 tests, 3217 pass, 0 fail | 03:36:13Z | 03:36:34Z | 0 |
| 2. `npm run typecheck` | 03:36:34Z | 03:36:37Z | 0 |
| 3. keyed production build | 03:36:37Z | 03:37:11Z | 0 |
| 4. `npm run architecture:check` — all 8 rules + coverage green | 03:37:11Z | 03:37:11Z | 0 |
| 5. `npm run architecture:map` | 03:37:11Z | 03:37:12Z | 0 |
| 6. precondition 1 `git diff --exit-code -- lib/architecture/map.generated.ts` | 03:37:12Z | 03:37:12Z | 0 |
| 6. precondition 2 `git diff --cached --exit-code -- lib/architecture/map.generated.ts` | 03:37:12Z | 03:37:12Z | 0 |
| 6. line 1 `npm run architecture:map` | 03:37:12Z | 03:37:12Z | 0 |
| 6. line 2 `cp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"` | 03:37:12Z | 03:37:12Z | 0 |
| 6. line 3 `npm run architecture:map` | 03:37:12Z | 03:37:13Z | 0 |
| 6. line 4 `cmp lib/architecture/map.generated.ts "$CAPTURE/gen1.ts"` | 03:37:13Z | 03:37:13Z | 0 |
| 6. line 5 `git diff --exit-code -- lib/architecture/map.generated.ts` | 03:37:13Z | 03:37:13Z | 0 |
| 7. `bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'` | 03:37:13Z | 03:37:13Z | 0 |
| aux. `git diff --exit-code data/reasoning-registry/prompts.generated.json` | 03:37:13Z | 03:37:13Z | 0 |
| 8. `npm run reasoning:governance` — GREEN, 0 ungoverned model calls | 03:37:13Z | 03:37:14Z | 0 |
| 9. `npm run changelog:coverage` — GREEN, 19 shipped engine versions documented | 03:37:14Z | 03:37:14Z | 0 |
| Build pair 1 — refusal (`CDMSS_TELEMETRY_HMAC_KEY=`) | 03:37:14Z | 03:37:14Z | 1 (nonzero EXPECTED; error names the key) |
| Build pair 2 — keyed | 03:37:14Z | 03:37:48Z | 0 |

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
states this beside the transcript. Registry output: 88737 bytes; 30 prompts ·
7 rubrics · 36 builders · 19 features. Auxiliary `git diff --exit-code
data/reasoning-registry/prompts.generated.json` also 0.

**The refusal build** exited 1 with the error naming the key:
`Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. …`
`git status --porcelain` was empty before the gate, before and after command 6's
block, and after the whole gate; the ignored list held exactly the two expected
CDMSS lines throughout.

---

## 7. The seven evidence digests

Verified before the gate and again after it — every one matches its pinned value
(v20 §6.1 for the first six; commit `f6e9188`'s message for the seventh):

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
065be6a1af1232a34de56f2b26da3aaec8a3e6e1bded0db84fb267624a0e63a3  CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
db0df1afa205535422220d250895b0d0202d0f52ed1f28858b147abb357f9e15  CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
d6a94ec9cf71b0093fa56b2432ec6c7f3668f9884f39feebb349b5c3839added  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-16-AUG-2026.md
716bd5cd8ada6091c6b1efead83554e6ebf639dbc7e62f2b1319fca6fdb32be3  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-2-16-AUG-2026.md
f80c7591ad1cdd1df7dfaebed95c1c2575c0173d93282866742d494959c89b2a  CDMSS-GATE-EVIDENCE-PASS-2-SUPPLEMENTAL-3-17-AUG-2026.md
```

---

## 8. Current state

- Hard proofs closed: **7 of 20** (11, 12, 17, 2, 16, 18, 70). Judge proofs
  closed: **4 of 4** (J1–J4). None reopened.
- Pass 2 is **not** administratively closed. Saul closes it (v22 §8 step 13).
- Pass 3 is not released; the pass 1 retrospective sweep and the Cohere track
  are not begun.
- The sixteen unbounded `judge.settled()` waits remain recorded test-harness
  debt for a separate bounded-settlement hardening task (v22 §5).
- **Nothing is pushed.** `@{u}` = `d69a11d7c57c18157b371b9079ffd2a00f466ce6`.
  Local, unpushed: `fe59b07`, `76307f0`, `614da54`, `df78215`, `0e0503b`,
  `f6e9188`, `a4d61ae`, and commit 12 — eight.

---

## 9. Disclosures — deviations and judgment calls, stated plainly

1. **Four header lines added** (test file lines 19–22) citing addendum v22 as
   this round's governing addendum, in the form the header already uses for v18
   and v20. Kickoff §4 authorized only the v19 correction on line 9; this addition
   is in the one authorized path and asserts nothing false, but it is beyond the
   letter of §4.
2. **Two auxiliary sandbox runs, A1 and A2 (§5),** beyond the nineteen-row table.
   Neither is a table row, neither is a row 15–30, both were sandbox-only. A1
   exists because the finding was "demonstrated, not applied", and the strongest
   evidence that the real path now applies the helper is to make the real path
   fail. Disclosed rather than folded into the table.
3. **The helper's expiry message carries the original wait error's message.**
   v22 §2.1 asks that the helper both fail by name on expiry and rethrow the
   original wait error; on the one path where those meet — the request does not
   terminate within the bound after destroy — the builder chose a named expiry
   error that quotes the wait error, so neither cause is hidden. On every other
   path the wait error is rethrown unchanged.
4. **`judge.setRecording(true)` in 5.2b moved out of the `try`** so that the
   `catch` covers exactly the wait. It is a no-throw setter and its order relative
   to `reqA.end('ABCD')` on the success path is unchanged.
5. **A runtime probe file** was written and run in the session scratchpad
   (outside the worktree; loopback only; not `node -e`) to confirm the
   `ClientRequest` facts in §2.1 before the helper was written. It is not part
   of the deliverable.
6. **Dates.** The prescribed paths say 17-AUG-2026; the work ran 18 August 2026
   UTC. Every timestamp is the true clock time.
7. **Test count did not change** (3217 → 3217): 5.2b-fail was rewritten in place,
   not added. Reported as observed.
