# ETA-E11 — a quiet room is not a failed read · CC KICKOFF · 14 Sep 2026 · pane `scribe`

Read `ETA-E10-ROOTCAUSE-14-SEP-2026.md` §1 first. It is proven, not hypothesised, and this brief
implements the fix it names. Do not re-derive the diagnosis.

## THE DEFECT, IN ONE LINE

Whisper answered all 25 drains with HTTP 200. **21 windows contained no speech.**
`lib/whisper.ts:323-325` turns a 200-with-no-text into `{ok:false, error: EMPTY_TRANSCRIPT}`, and
`roomWindowSegment` (`lib/stt/room-drain.ts:737-744`) maps **every** `!full.ok` to
`whisper_unavailable`. So "the room was quiet" and "Whisper is down" wear one name, and a silent
window burns all 3 attempts — 7 windows × 3 = the 21 failures.

**This is the K5 rule, missing on its third path.** `lib/mcp/tools/bench.ts:1786-1795` and
`lib/jobs/kinds/transcribe-range.ts:205-224` ("A QUIET ROOM IS NOT A FAILED READ") both already
short-circuit `EMPTY_TRANSCRIPT` to success. The `room_window` job path, built in C1b, did not inherit
it — and `room-drain.ts:534` already carries a comment naming this exact defect class.

## GOAL

A silent window finishes as a **silent success**. A real Whisper outage still fails loudly. Nothing
else changes.

## THE FIX (the shape is ruled; the implementation is yours)

At `lib/stt/room-drain.ts:737`, before `recordFailure`, branch on **exactly** `full.error ===
EMPTY_TRANSCRIPT`. On that branch, finish the window as the silent outcome that
`bench.ts:1786-1795` already defines:

- one `stt_silence` cue;
- a complete marker with `segment_count` 0;
- zero turns;
- window state `transcribed`;
- **no routed-engine call**;
- **no attempt consumed.**

Every other error — `http_*`, `timeout_*`, `network:` — keeps `whisper_unavailable` and keeps
consuming an attempt. Compare the error **exactly**; do not catch on a substring, a prefix, or
`!full.ok`.

## RULED: do NOT extract a shared helper this round

The Debugger observed that a shared helper for Whisper's result is the durable fix. It is, and it is
**not** this round. A helper changes two paths that currently work in order to fix a third, and
`ETA-CI-IS-DECORATIVE-FINDING-14-SEP-2026.md` says we have no CI that would catch it if the refactor
broke them. Refactoring working code behind a gate that does not run is how the third path got broken
in the first place.

**Instead, build the thing that catches the next divergence: one test that pins all three paths to the
same answer for an empty transcript.** Table-driven over the three call sites, asserting the same
outcome from each. That test is cheaper than the refactor, it fails loudly when a fourth path is added
without the rule, and it is the precondition for doing the extraction safely later. Name the
extraction as a follow-up in your report; do not do it.

## THE 7 PARKED WINDOWS

Seven `bench_window` rows sit in `failed` holding a clip, with `stt_subject_job` at `attempts`=3,
state `failed`. They are the natural proof the fix works.

**Check before you plan a re-drain: does `drainRoomWindow` accept a window in `failed` at all?** The
Debugger flagged this and did not resolve it. If it refuses, say so and stop — recovering them is a
separate decision and it is mine, not yours.

## VERIFY — and the mutation check is mandatory

- V1 A window whose Whisper call returns 200-with-empty-text finishes `transcribed`, with one
  `stt_silence` cue and a marker with `segment_count` 0. **Behavioural — call it and assert the
  outcome.** A source-text grep is not evidence (testing rule 2).
- V2 A window whose Whisper call returns a 500, a timeout, or a network error **still** fails
  `whisper_unavailable`. The refusal must not have become universal in the other direction — rule 7
  cuts both ways, and a fix that swallows a real outage is worse than the bug.
- V3 The silent branch **consumes no attempt**. Assert the attempt counter across two consecutive
  silent drains of the same window.
- V4 The silent branch makes **no routed-engine call**. This is the one that protects the money:
  21 of 25 windows going on to Sarvam is the cost of getting it wrong.
- V5 The three-path test exists and fails when any one path's empty-transcript handling is removed.
- V6 **Mutation check.** Remove each new rule from the source in turn, confirm its test fails, restore
  exactly, report the count. Include in the mutations: the exact-equality comparison (change it to a
  substring match and to `!full.ok`), and the no-attempt-consumed rule.

## DO NOT

- Do **not** extract the shared helper. Ruled above.
- Do **not** touch `lib/whisper.ts:323-325`. `EMPTY_TRANSCRIPT` is correct where it is; the bug is in
  what the caller does with it.
- Do **not** make `empty_transcript` retryable.
- Do **not** change Whisper's flags. Dropping `--vad` brings back the loop-on-silence behaviour that
  M4–M7 measured at a 0.370 repeat ratio.
- Do **not** re-drain the 7 parked windows.
- Do **not** turn `ROOM_AUTO_DRAIN_ENABLED` back on — it is off deliberately and clinic opens tomorrow.
- Do **not** touch anything in `lib/emotion/`. Break 2 is being handled separately and is not a code fix.
- Do **not** deploy, push, merge or open a PR. Commit to the branch only if the tests are green, and say so.
- Do **not** quote transcript text or clinical content.

## OUTPUT

`docs/handoff/ETA-E11-SILENT-WINDOW-FIX-REPORT-14-SEP-2026.md`

1. The diff, by file and line count.
2. V1–V6 with the mutation count.
3. The `failed`-state answer for `drainRoomWindow`.
4. The shared-helper extraction, named as a follow-up with what it would touch.
5. Flags: anything you could not test, anything you assumed.

**Cap: 110 lines.**

## KNOWN FACTS

- Tree `vinay/s1-auto-drain` @ `fe021a3`; `lib`, `app` and `vercel.json` are identical to HEAD.
- `DRAIN_MAX_ATTEMPTS` is 3. A failed attempt returns the window to `closed` (`room-drain.ts:414`), so
  newest-first auto-drain re-picks the same window — that is why 7 windows produced 21 failures.
- The underlying string `whisper_unavailable: empty_transcript` is already written to
  `stt_subject_job.last_error` (`room-drain.ts:401`). The information was there; nothing read it.
- Docker is down on the Mini, so the real-Postgres suites will not run. Say which suites you could not
  run rather than reporting green on a suite that did not execute (testing rule 8).
- Whisper runs `--vad --no-speech-thold 0.7 --suppress-nst` and answered every one of 69 `POST
  /inference` calls with HTTP 200. It is healthy. It was always healthy.
