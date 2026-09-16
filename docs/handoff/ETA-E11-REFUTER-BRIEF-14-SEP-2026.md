# ETA-E11 — refute the silent-window fix · REFUTER BRIEF · 14 Sep 2026 · pane `ETA-Refuter`

You did not build this. `scribe` did. Read `ETA-E11-VERDICT-AND-E12-NEW-BREAK-14-SEP-2026.md` §1 for
my acceptance and the two reds I waived, then `ETA-E10-ROOTCAUSE-14-SEP-2026.md` §1 for the diagnosis,
then `ETA-E11-SILENT-WINDOW-FIX-CC-KICKOFF-14-SEP-2026.md` for what was ordered.

**Nothing is pushed or merged. You are the gate.**

## GOAL

Decide whether the diff on `vinay/s1-auto-drain` is safe to push. **Rerun the tests yourself** — do not
take the Builder's counts. It reported 9 of 9 mutations caught; verify that number is real and that the
mutations discriminate.

## THE CHANGE

One branch in `roomWindowSegment` (`lib/stt/room-drain.ts` ~:737) on exactly
`full.error === EMPTY_TRANSCRIPT`, finishing the window as a silent success — one `stt_silence` cue, a
marker with `segment_count` 0, zero turns, window `transcribed`, no routed-engine call, no attempt
consumed — plus a table-driven test pinning all three empty-transcript paths to the same answer.

## ATTACK THESE, IN THIS ORDER

1. **The exact-match comparison.** The whole fix hinges on `full.error === EMPTY_TRANSCRIPT` and not a
   substring. The Builder says one crafted case, `http_502: empty_transcript`, is what makes the
   substring mutation fail. **Delete that single row and rerun.** If the substring version then passes,
   the suite depends on one fixture nobody will recognise as load-bearing — say so, and say what
   should guard it instead.
2. **The reverse refusal (the dangerous direction).** A real Whisper outage must still fail loudly.
   Prove it for a 500, a timeout, and a network error — separately, not as one case. **A fix that
   swallows a real outage is worse than the bug it replaces**, because the symptom becomes silence in
   both senses.
3. **No attempt consumed.** Assert it across two consecutive silent drains of the same window, and
   check what happens when the silence write itself fails — the Builder chose to consume an attempt
   there. Is that reachable, and is it right?
4. **No routed-engine call.** This is the money guard: 21 of 25 real windows were silent, and each one
   continuing to the engine step means a 900 s window to route (~200 s of Mini time) or to Sarvam, the
   one paid engine we still use. Prove the skip, and prove the flag that drives it cannot be set the
   other way by an existing caller.
5. **The three-path test.** The Builder's own insight is that a table of known paths confirms those
   paths agree but **cannot notice a fourth**. Judge whether the test as written would fail if someone
   added a new caller of `transcribeWithWhisper` tomorrow. If it would not, say what would.
6. **The mutation count.** Rerun all 9. Report the number you get, not the number you were given.

## THE TWO REDS I WAIVED — check my judgement

- The 4 REQUIRED PROOF suites need Docker, which is down. With `ETA_ALLOW_SKIP_E2E=1`, 2,513 pass.
  I accepted the skip as the person the flag's text requires. **If you can get Docker up cheaply, run
  them and tell me what I waived.** If you cannot, say so and do not pretend otherwise (rule 8).
- `swift test`: 1 of 600 red, `lockFailed(errno 35)` in an archive test, in Swift this diff does not
  touch; the filtered re-run could not build (toolchain macro error). Confirm the diff touches no Swift.

## DO NOT

- Do **not** fix anything you find. Report it. If the diff must change, `scribe` changes it.
- Do **not** push, merge, open a PR, or deploy.
- Do **not** turn `ROOM_AUTO_DRAIN_ENABLED` back on. It is `0` deliberately; clinic opens tomorrow.
- Do **not** touch `lib/emotion/` — `scribe3` is gathering evidence there this round.
- Do **not** re-drain the 7 parked windows.
- Do **not** quote transcript text or clinical content.

## OUTPUT

`docs/handoff/ETA-E11-REFUTER-VERDICT-14-SEP-2026.md`

1. **PUSH / DO NOT PUSH**, first line, with the one reason that decides it.
2. Attacks 1–6, each UPHELD / BROKEN / UNVERIFIED with what you ran.
3. Your mutation count against the Builder's 9.
4. My two waivers: sound or not.
5. Anything the brief should have told you to check.

**Cap: 100 lines.**

## KNOWN FACTS

- The bug: Whisper answered all 25 drains HTTP 200; 21 windows had no speech;
  `room-drain.ts:737-744` mapped every `!full.ok` to `whisper_unavailable`. 7 windows × 3 attempts = 21.
- `bench.ts:1786-1795` and `transcribe-range.ts:205-224` already had the rule. The job path did not.
  `room-drain.ts:534` carries a comment naming this exact defect class.
- `drainRoomWindow` takes a `failed` window only with `force:true` (`:464-466`), which only
  `POST /api/admin/bench/drain` passes — so this fix does not recover the 7 parked windows, and is not
  meant to.
- Docker down on the Mini. Neon string at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf`
  — read it, use it, never print it.
