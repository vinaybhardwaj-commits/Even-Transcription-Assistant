# CDMSS — Proof 11: retrospective mutation sweep. Evidence

**Date:** 22 August 2026 (IST)
**Kickoff:** `CDMSS-TELEMETRY-PROOF11-SWEEP-KICKOFF-21-AUG-2026.md` (Saul Rep 43 A5, transcribed).
**Base:** branch `t4b` @ **`cb46330`**, pinned before execution and confirmed equal to `origin/t4b`.
**Commit:** this document only. **No executable file changed in this pass, in the worktree or in the index.**
**Pushed:** **No.**

---

## 0. RESULT IN ONE LINE

**All five rows failed to discriminate. Proof 11 has two recorded proof gaps and is not genuinely
closed.** Nothing was repaired. `lib/__tests__/attempt-taxonomy.test.ts` was observed unchanged
throughout and its bytes are the committed bytes.

This is §6's expected case, and per §1 it is a **successful sweep**: the holes are now on the record
before the closing ledger is signed. Both gaps were named in advance by Saul; both are now
demonstrated by execution rather than by argument.

---

## 1. Pinned BEFORE execution (§2)

Recorded before the first mutation was written.

```
pass-5 SHA        cb46330433f07310228c392b1b3bb68e22b66c6e
origin/t4b        cb46330433f07310228c392b1b3bb68e22b66c6e   (equal)
worktree status   clean
```

Blob hashes of the three files the sweep touches or observes:

| File | `git hash-object` (worktree) | `git rev-parse HEAD:<path>` | sha256 |
|---|---|---|---|
| `lib/transport-attribution-core.ts` | `f0b148bc` | `f0b148bc` | `8848d128…983b3` |
| `lib/llm.ts` | `006be6d6` | `006be6d6` | `a433c5d4…e82fd` |
| `lib/__tests__/attempt-taxonomy.test.ts` | `fd94a6c3` | `fd94a6c3` | `fd01b19e…16ee5` |

Full blobs: `f0b148bc73715e9f35f1f5b93c431579aa36b3d6`,
`006be6d6a5f9f001dff85c2ac43133e0715346bc`, `fd94a6c3b41ed79c973e468b2c35b941a678dffd`.

## 2. Sandbox (§4)

`…/scratchpad/sandbox-p11` — a full copy of the worktree taken outside it, with `.git`, `.next` and
`node_modules` removed and `node_modules` symlinked back to
`/Users/vinaybhardwaj/dev/Even-CDMSS/node_modules`.

**Shape verified before use:** `.git` absent · `.next` absent · `node_modules` a symlink ·
`lib/__tests__` present · dotfiles present (`.env.example`, `.github`, `.gitignore`, `.npmrc`) ·
path outside the worktree.

**No git command was run inside the sandbox.** Pristine copies of all three files were held in
`…/scratchpad/pristine-p11`, **outside** the sandbox; every restore is a `cp` from there, verified
by `cmp` against both the pristine copy and the worktree original. `git checkout --` was never used.

**Sandbox baseline, unmutated, before any row:** `node --test --import tsx
lib/__tests__/attempt-taxonomy.test.ts`, cwd = sandbox — **11 pass / 0 fail**, exit 0.
07:41:02 → 07:41:03 IST.

## 3. The five rows, in Rep 43's order

Row 1 command: `node --test --import tsx --test-name-pattern '^11\.7 ' lib/__tests__/attempt-taxonomy.test.ts`
Rows 2–5 command: `node --test --import tsx --test-name-pattern '^11\.3 ' lib/__tests__/attempt-taxonomy.test.ts`
cwd = the sandbox for every row. The name pattern is what makes it **only** the named test: each run
reports `# tests 1`, `# skipped 0` — the named test ran, alone, and was not filtered away.

| Row | Mutation | Named test | STARTED | ENDED | exit | Result | Discriminated? |
|---|---|---|---|---|---|---|---|
| 1 | one committed taxonomy literal replaced | 11.7 | 07:41:21 | 07:41:22 | **0** | `ok 1 - 11.7 …` | **NO** |
| 2 | intended-local success disabled, AST call retained | 11.3 | 07:45:58 | 07:45:59 | **0** | `ok 1 - 11.3 …` | **NO** |
| 3 | OpenRouter success disabled, AST push retained | 11.3 | 07:46:13 | 07:46:14 | **0** | `ok 1 - 11.3 …` | **NO** |
| 4 | Vertex success disabled, AST push retained | 11.3 | 07:46:27 | 07:46:27 | **0** | `ok 1 - 11.3 …` | **NO** |
| 5 | fallback-local success disabled, AST call retained | 11.3 | 07:46:40 | 07:46:41 | **0** | `ok 1 - 11.3 …` | **NO** |

Every row exited **0**. No row produced a timeout, and no collateral test was involved — each run
contained exactly one test.

### Row 1 — `lib/transport-attribution-core.ts`

```diff
@@ -43,7 +43,7 @@
 export const TRANSPORT_ATTEMPT_OUTCOMES = [
-  'http_429', 'http_other', 'timeout', 'transport_error', 'bad_response', 'success',
+  'http_429', 'http_other', 'MUTANT_not_timeout', 'transport_error', 'bad_response', 'success',
 ] as const;
```

```tap
TAP version 13
# Subtest: 11.7 — an outcome INSIDE the six is not a defect, in all three locations
ok 1 - 11.7 — an outcome INSIDE the six is not a defect, in all three locations
1..1
# tests 1
# pass 1
# fail 0
# skipped 0
```

Restored by `cp`; `cmp` vs pristine and vs worktree both identical.

### Row 2 — `lib/llm.ts`, intended-local arm

```diff
@@ -357,7 +357,7 @@
       return attachTransportAttribution(await llm.chat.completions.create(params, reqOpts), {
         dispatched_provider: 'ollama', dispatched_model: (params as { model?: string }).model ?? null,
-        cloud_response_received: false, attempts: [...attempts, localAttemptSuccess()],
+        cloud_response_received: false, attempts: [...attempts, ...(false ? [localAttemptSuccess()] : [])],
       });
```

The `localAttemptSuccess()` **CallExpression survives**; the intended-local success attempt is no
longer recorded. `ok 1 - 11.3 …`, `# pass 1 / # fail 0`, exit 0.

### Row 3 — `lib/llm.ts`, OpenRouter tier

```diff
@@ -432,7 +432,7 @@
         endProviderCall('openrouter');
-        attempts.push({ tier: 'openrouter', attempt: attempts.filter((a) => a.tier === 'openrouter').length + 1, outcome: 'success', status: 200 });
+        if (false) attempts.push({ tier: 'openrouter', attempt: attempts.filter((a) => a.tier === 'openrouter').length + 1, outcome: 'success', status: 200 });
```

The `attempts.push({ … outcome: 'success' … })` **CallExpression survives**, tier literal intact; the
push never executes. `ok 1 - 11.3 …`, exit 0.

### Row 4 — `lib/llm.ts`, Vertex tier

```diff
@@ -502,7 +502,7 @@
       endProviderCall('gemini');
-      attempts.push({ tier: 'vertex', attempt: attempts.filter((a) => a.tier === 'vertex').length + 1, outcome: 'success', status: 200 });
+      if (false) attempts.push({ tier: 'vertex', attempt: attempts.filter((a) => a.tier === 'vertex').length + 1, outcome: 'success', status: 200 });
```

`ok 1 - 11.3 …`, exit 0.

### Row 5 — `lib/llm.ts`, fallback-local (substitution) arm

```diff
@@ -560,7 +560,7 @@
     return attachTransportAttribution(await llm.chat.completions.create(params, reqOpts), {
       dispatched_provider: 'ollama', dispatched_model: (params as { model?: string }).model ?? null,
-      cloud_response_received: false, attempts: [...attempts, localAttemptSuccess()],
+      cloud_response_received: false, attempts: [...attempts, ...(false ? [localAttemptSuccess()] : [])],
     });
```

`ok 1 - 11.3 …`, exit 0.

**In rows 2–5 the mutation reaches production behaviour and nothing else.** Each disabled site is a
real success record: row 3 and row 4 remove the only evidence that a cloud tier answered, and rows 2
and 5 restore precisely the D14 defect the site was written to fix — a local call that *made a real
request and reported `attempts: []`*, which is the shape that licenses a false `not_served`
downstream. The instrument would go blind on all four arms and 11.3 would stay green.

## 4. Two controls, OUTSIDE the five rows

Added so the result cannot be dismissed as a path artefact — a row that passes because the test read
the *worktree* file rather than the sandbox one would look identical to a row that passes because the
proof is weak. Both controls are sandbox-only, in the two allowed files, and both were restored.

**C1 — delete the OpenRouter push outright** (removing the AST node rather than disabling it):

```
not ok 1 - 11.3 — all four success sites record `success`, …
  expected: 2
  actual: 1
exit 1, # pass 0 / # fail 1
```

**C2 — change `localAttemptSuccess()`'s returned outcome** in `transport-attribution-core.ts` from
`'success'` to `'transport_error'`:

```
not ok 1 - 11.3 — all four success sites record `success`, …
exit 1, # pass 0 / # fail 1
```

C1 proves 11.3's `readFileSync('lib/llm.ts')` resolves to the **sandbox** file and its count
assertions are live. C2 proves the `../transport-attribution-core` import resolves to the **sandbox**
file too. **Both reads are live; the rows are not vacuous.** The discriminator is exactly where §3
predicted it would be: 11.3 fails when the *syntax* is removed and passes when only the *execution*
is disabled.

## 5. What this proves about the proof (§6)

### Gap A — test 11.7 verifies a constant against itself

`attempt-taxonomy.test.ts:388` builds its valid inputs by iterating the production constant:

```ts
for (const good of TRANSPORT_ATTEMPT_OUTCOMES) { … loc.put(m, [{ …, outcome: good, … }]); assert.equal(defects(m), 0, …) }
```

and `lib/retrieval-telemetry-core.ts:1037` decides validity with the **same imported constant**:

```ts
if (!(TRANSPORT_ATTEMPT_OUTCOMES as readonly unknown[]).includes(outcome)) { v.push(defect); return; }
```

The expectation and the thing expected are one object. **11.7 cannot fail for any substitution of any
taxonomy literal, in any number, in any order** — both sides move together by construction. It is not
weak evidence for the committed six; it is *no* evidence for them. This is pass 2 row 1's blind spot
exactly, one file over: the fixture derived from the production constant.

Note what 11.7 *does* still prove, so the repair is scoped honestly: it proves the validator does not
flag a value the array contains — the "a branch that flagged everything would pass 11.6" half its own
comment claims. That half survives. The half about the **committed six specifically** does not.

11.1 pins the six literals by `deepEqual` and would have caught row 1 — but 11.1 is a different test,
and Rep 43's row runs 11.7 alone. The sweep's finding is about 11.7's own claim, which its name makes
("an outcome INSIDE the six"), not about whether some other test in the file happens to cover it.

### Gap B — test 11.3 observes syntax, not execution

11.3 counts `CallExpression` nodes in `lib/llm.ts` — two `attempts.push({… outcome: 'success' …})`
and two `localAttemptSuccess()` — and separately asserts the *shape* of `localAttemptSuccess()`'s
return value. It never executes `chatWithFallback`, so it cannot observe whether any of the four
sites runs.

The AST guard is a genuine improvement on the two regexes it replaced, and its own comment is right
that "a comment cannot produce a CallExpression". **But that closes the commented-out attack, not the
disabled attack.** Rows 2–5 leave the node in the tree and take the execution away: `if (false)` for
the pushes, a `false ?` guard for the helper calls. Four production success records vanish and the
test that exists to prove "all four success sites record `success`" reports green on all four.

Anything that removes execution while leaving a call node — an `if (false)`, an early `return`, an
unreachable branch, a dead code path, a wrapping condition that is never true in production — is
invisible to 11.3. **Proof 11's second half is a syntax pin wearing an execution proof's name.**

## 6. Four-hash byte equality (§7)

```
lib/transport-attribution-core.ts
  worktree-before   f0b148bc73715e9f35f1f5b93c431579aa36b3d6
  sandbox-baseline  f0b148bc73715e9f35f1f5b93c431579aa36b3d6
  worktree-after    f0b148bc73715e9f35f1f5b93c431579aa36b3d6
  git show HEAD     f0b148bc73715e9f35f1f5b93c431579aa36b3d6   ✓
lib/llm.ts
  worktree-before   006be6d6a5f9f001dff85c2ac43133e0715346bc
  sandbox-baseline  006be6d6a5f9f001dff85c2ac43133e0715346bc
  worktree-after    006be6d6a5f9f001dff85c2ac43133e0715346bc
  git show HEAD     006be6d6a5f9f001dff85c2ac43133e0715346bc   ✓
lib/__tests__/attempt-taxonomy.test.ts
  worktree-before   fd94a6c3b41ed79c973e468b2c35b941a678dffd
  sandbox-baseline  fd94a6c3b41ed79c973e468b2c35b941a678dffd
  worktree-after    fd94a6c3b41ed79c973e468b2c35b941a678dffd
  git show HEAD     fd94a6c3b41ed79c973e468b2c35b941a678dffd   ✓
```

sha256 of `git show HEAD:<path>` equals sha256 of the worktree file on all three. `git status` clean,
`HEAD` still `cb46330`. **The observed test is byte-identical to the committed test.**

Sandbox restored and re-verified by `cmp` on all three files, then **deleted**; the pristine copies
were deleted with it.

**Unmutated baseline re-run after restore** (§5's instruction, retained even though §6 applies):
`node --test --import tsx lib/__tests__/attempt-taxonomy.test.ts`, cwd = sandbox, 07:47:23 → 07:47:24
IST — **11 pass / 0 fail**, exit 0. **The nine-command gate was NOT run:** nothing executable changed.

## 7. Deviations and flags

**1. The stop rule was ambiguous, and V ruled.** §1 says "stop immediately" on a non-discriminating
row; §6 says record and stop but qualifies it — "do not proceed to remaining rows **if you judge the
gap material**" — and supplies a recording template *for rows 2–5*, which presupposes they run in the
expected case. Row 1 failed to discriminate and the sweep was **halted and escalated to V** before any
further row. V directed rows 2–5 to run. The judgment recorded with it: gap A is material to proof 11
but **not** to rows 2–5, which observe an independent test (11.3) through an independent mechanism, so
stopping at row 1 would have left Saul's second named weakness unmeasured. **If Saul reads §1 as
absolute, rows 2–5 are surplus evidence, not a violation of the no-repair rule — nothing was repaired
and nothing was adjusted to make a row fail.**

**2. Two controls were added beyond Rep 43's five rows.** C1 and C2 (§4). They are not mutations of
the five and are not offered as rows; they exist because five all-passing rows are indistinguishable
from five misrouted rows without them. Same two files, sandbox only, restored and hash-verified.
**Flagged for Saul as an addition to the prescribed method.**

**3. `--test-name-pattern` is how "only test 11.7 / only test 11.3" was achieved.** Rep 43 says which
test to run but not the mechanism. Each run reports `# tests 1 / # skipped 0`, so the named test
genuinely executed alone rather than being filtered out and silently counted as absent.

**4. NOTHING WAS REPAIRED.** No row was adjusted. `attempt-taxonomy.test.ts` was never opened for
write, in the worktree or the sandbox. **Both gaps await a prospective test-repair authorization**,
which this pass does not hold and does not request in this document.

**5. Proof 11's ledger status is now in question.** It is currently counted **closed**. On this
evidence its first half (11.1, 11.2, 11.4, 11.5, 11.5b) stands, and of the two rows swept, **11.7
proves nothing about the committed six and 11.3 proves nothing about execution**. Saul's call, not
mine — but the closing ledger should not be signed on the current count.
