# ETA — S1 FIX4 — REFUTER DELTA VERDICT
**14 Sep 2026 · ETA-Refuter (Opus) · `d5c65fa` on `vinay/s1-auto-drain` · delta over `6067ba8` · serial runs in this repo**

**PASS.**

**X1: CLOSED.** The same FIX3b probe file, unchanged, now rewrites the window row, and it agrees with its segment rows (D3).

Evidence (untracked, id-shaped tokens masked) in `docs/handoff/scratch/`: `FIX4-REFUTER-{gate,runs,mutations,probe-out}-14-SEP-2026.log`, `FIX4-REFUTER-mutate.sh.txt`, `FIX4-REFUTER-probe.{test,vitest.config}.mts`.

## D1 — the diff is the delta — PASS
- `git diff --stat 6067ba8..HEAD` → `5 files changed, 632 insertions(+), 13 deletions(-)`: `lib/emotion/store.ts`, `tests/unit/s1-emotion-zero-scored.test.ts`, and three bus documents.
- Kickoff §7 names three (the FIX4 kickoff, the FIX3b Refuter verdict, the FIX4 report); the brief's "two" is a miscount.
- `git diff --name-only 6067ba8..HEAD -- <kickoff §6 untouched list>` → `0`.

## D2 — the gate — PASS
- `tsc exit 0`
- ` Test Files  107 passed (107)` · `      Tests  2590 passed (2590)` · `npm test exit 0`
- ` ✓ Compiled successfully in 2.3s` · `build exit 0`
- `Found 9 silent-failure handler(s)` · `check:silent exit 1`. **Exactly 9**, all in untouched `app/[slug]/…` files: `finalize-text` 1, `finalize-upload` 1, `process` 5, `NoteComposerClient` 2. None is in a touched file.

## D3 — X1 closed, same probe — PASS
`npx vitest run --config docs/handoff/scratch/FIX3b-REFUTER-probe.vitest.config.mts -t X1`; the probe file's mtime is unchanged since the FIX3b run.
- FIX3b result: `"window_row":"left_final"`, window `{model:m, subfolder:int8}` over segments `{m_v2, fp16}`.
- **Now:** `"window_row":"written"`, window `{model:m_v2, subfolder:fp16, scored:2, at_changed:true}`, segments `[{scored,m_v2,fp16},{scored,m_v2,fp16}]`. `Tests  1 passed | 3 skipped (4)`.

## D4 — C9 still alive — PASS
The probe drives a real settled `ok` window through the kind twice:
`"window_row":"left_final","state":"ok","attempts_before":1,"attempts_after":1,"scored_at_moved":false`.

## D5 — cap_s NULL handling — PASS
Through the real `recordEmotionWindow` statement (`state no_segments`, so the `failed` arm is out of play):
- `NULL→NULL written:false` · `NULL→30 written:true` · `30→30 written:false` · `30→NULL written:true`
- attempts `1,1,2,2,3`.

The widened row constructor alone returns `null_null:false, null_value:true, value_null:true, value_same:false`. Probe: `Tests  3 passed (3)`.

## D6 — IDEMPOTENT — PASS
- The `c2-e2e-runner.test.ts` blob is **IDENTICAL** at `8ac9e24` and HEAD.
- In the full D2 run, both are `✓`: `… > IDEMPOTENT: the same job again for the same diarize attempt …` and the voiceprint IDEMPOTENT.

## D7 — five single-field mutations — PASS (all counts reproduced)
Each field was removed from both sides of both upserts (`substitutions=4` each) and the S1 emotion file rerun; every file `RESTORED` and `cmp`-equal:
- `model` → `1 failed` (1)
- `model_key` → `1 failed` (1)
- `subfolder` → `1 failed` (1)
- `cap_s` → `2 failed` (2)
- `room_day_id` → `1 failed` (1)

The trap is covered: each field has its own isolating case (`s1-emotion-zero-scored.test.ts:335` model alone, `:347` subfolder alone, `:359` cap_s alone, `:371` room_day_id, `:385` model_key at the store).

## D8 — the Builder's F1 — THE INERTNESS CLAIM IS TRUE; ITS CONSEQUENCE IS NOT
- **Constant write:** `lib/jobs/kinds/emotion-window.ts:198` — `model_key: EMOTION_MODEL_KEY` in `finish()`.
- **Segment-row key:** `emotion-window.ts:177` — `model_key: res.model_key ?? EMOTION_MODEL_KEY`, written at `lib/emotion/store.ts:49`.
- **Can they disagree today? No.** `lib/emotion/client.ts:91` refuses every response whose `b.model_key !== EMOTION_MODEL_KEY` (`emotion_unexpected_model`), and `scoreSegments` returns through that parser (`:151`).
  - So `res.model_key` always equals the constant, and the `??` fallback is dead.
  - Both rows always carry the same key. The F1 scenario ("if the service ever reported a different `model_key`, the segment rows would carry it") cannot happen: no segment row is written for such a response.
- **Inert?** Within one deployment, yes. `finish()` always writes the same constant; `fail()` and `no_segments` write NULL, but their `state` also differs, so `model_key` is never the deciding field.
  - It becomes live only across a deploy that changes `EMOTION_MODEL_KEY`: the stored row has the old constant, the new write has the new one, and comparing it rewrites. That is correct behaviour.
- **The queued "fix"** (write `res.model_key` in `finish()`) would change no stored value while the `:91` guard stands.
- **The comment in the code is not accurate.** `grep -n inert lib/emotion/store.ts` → nothing. `store.ts:157-158` lists `model_key` among "everything the segment rows can contradict", and today the segment rows cannot contradict it.
  - The ruled "inert until the write is fixed" comment is not in `d5c65fa`.
  - If added, it should name the guard at `client.ts:91` as the reason, not the `finish()` write.

## D9 — F2 — CONFIRMED
`room_span_emotion` has `device text` (0089, table line 34); `room_emotion_window` has no `device` column (0 matches in its DDL, none added by 0090–0092).

## Outside the delta — stated, not acted on
- **O1 — my own X1 probe mocked past the same guard.** `client.ts:91` also requires `b.model === EMOTION_MODEL_ID`.
  - In production the `model` half of X1 is reachable only across a deploy that changes that constant.
  - The `subfolder` half has no guard, so X1 was, and would be, reachable by a service-side subfolder change alone.
  - The C16 `model` tests (`:320`, `:335`) mock past the guard the same way.
- **O2 — `cap_s` jitter.** C17 says the service reads its cap once at start. Not re-verified here: the Mini was not probed, as ordered.

## Final `git status --short`
Tracked or staged entries: **0** (`git status --short | grep -v '^??'` → empty). The full output is 57 lines, all `??`; it is in `docs/handoff/scratch/FIX4-REFUTER-runs-14-SEP-2026.log` under "final git status", to stay inside the 90-line cap. The untracked entries this review created are the seven `FIX4-REFUTER-*` scratch files and this verdict.
