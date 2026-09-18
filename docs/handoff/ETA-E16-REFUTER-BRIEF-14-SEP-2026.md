# ETA-E16 — refute the speech-fraction build · REFUTER BRIEF · 14 Sep 2026, 21:50

**Commit `f4f51c6ab76814717f52e5459529cdb54c7ae0d6`**, branch `vinay/e16-emotion-speech-fraction`,
worktree `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-e16`, on top of `ccd12b0`.
Nine files, 925 insertions, 53 deletions. Not pushed. Migration **0097 not applied**.

Read `ETA-E16-REPORT-14-SEP-2026.md` (the no-build report), `ETA-E16-RULING-BUILD-OPTION-A-14-SEP-2026.md`
(why the diarizer and not the service), and §1 of `ETA-E16-E17-VERDICTS-AND-THE-RESAMPLER-14-SEP-2026.md`.

**Rerun everything yourself. The Builder reports 16 of 16.**

## WHY THIS ONE MATTERS MORE THAN THE OTHERS

This round produces a number a clinician may one day read as *"how much of this span was this person
actually speaking"*. **A wrong `speech_ms` is worse than none** — it is a confident measure of the wrong
thing, and unlike a missing number, nobody will question it.

## ATTACK THESE, IN THIS ORDER

**1. The two mutations with no behavioural proof.** Both are on the zero-scored SQL rule and are caught
**only by a check on the statement's text**; their behavioural proof sits in `s1-emotion-zero-scored`,
which did not run because Docker is down. A statement-text check is the assertion testing rule 2 says
may only ever *supplement* a behavioural one. **If you can get Docker up, run it and tell me what the
waiver concealed. If you cannot, say so, and say what those two mutations do not prove.**

**2. The reverse refusal — the dangerous direction.** A span the service genuinely fails must still
fail, still count, and still consume an attempt. E16 exists to stop windows exhausting on unscorable
spans; **a version that also swallows real failures would look identical in every metric we have** and
would quietly stop recording that the model could not score real speech. Prove it separately for a
service error, a timeout, and a malformed response.

**3. `/health` without `min_speech_s` now fails the window.** This is a **new failure mode E16
introduces**. The live service does report 1.5 — but it was restarted at 20:07 tonight and came back
with `loaded:false` while it lazily loaded its model. Establish what `/health` returns during that
window, and whether a service restart can now fail windows that would previously have scored. If it
can, that is a regression hiding inside a correctness fix.

**4. `speech_basis NOT NULL DEFAULT 'pre_speech_fraction'`.** I accepted this as *better* than the
nullable column I originally approved, on the Builder's argument that the default also marks rows
written by production code between the migration landing and the deploy. **Test that claim.** Write a
row the way current production code writes one, with 0097 applied and the new code not yet deployed,
and confirm it is marked pre-fix. And confirm no existing reader breaks on a column that is now NOT NULL.

**5. The measurement is supposed NOT to match the service.** The fixture reproduces E14's 13 span
bounds and the database's per-chunk speech to within 10 ms — but that is diarizer against diarizer.
The whole ruling rests on the diarizer and the service measuring **different quantities**. So: confirm
the code never assumes they agree, and that a service `unscorable` answer on a span the planner
considered scorable is handled as its own outcome — the run-B case, where they disagreed in both
directions.

**6. The `segments_json` re-run hazard.** The Builder flagged it and correctly did not build around it:
a diarize re-run of an `ok` window keeps the old `segments_json` while moving turns to the new run, so
if speaker numbers change, `speech_ms` is measured against the wrong speaker. **I ruled it out of scope.
Attack that ruling.** E16 now *depends* on `segments_json` being right in a way nothing did before.
Establish whether a re-run can actually occur on an `ok` window in production, and how wrong the number
gets when it does. **If you can show it is reachable, this blocks the merge and I will reverse myself.**

**7. The mutation count.** Rerun all 16. Report the number you get, not the number you were given.

## DO NOT

- Do **not** fix anything. Report it; `scribe` changes it.
- Do **not** apply migration 0097. It runs before deploy, at my call.
- Do **not** push, merge, open a PR, or deploy.
- Do **not** touch `vinay/s1-auto-drain` — `scribe` is working there on E11's last two items.
- Do **not** turn `ROOM_AUTO_DRAIN_ENABLED` on.
- Do **not** restart the emotion service.
- Do **not** quote transcript text, speaker names or clinical content.

## OUTPUT

`docs/handoff/ETA-E16-REFUTER-VERDICT-14-SEP-2026.md`

1. **MERGE-READY / NOT MERGE-READY** on line 1, with the one reason that decides it.
2. Attacks 1–7, each UPHELD / BROKEN / UNVERIFIED with what you actually ran.
3. Your mutation count against the Builder's 16.
4. Whether my out-of-scope ruling on the `segments_json` hazard survives.
5. Anything this brief should have told you to check.

**Cap: 100 lines.**

## KNOWN FACTS

- Worktrees: main (`vinay/s1-auto-drain` @ `e925901`, E17 committed), `-e16` (this commit), `-slice-e`.
  **Work only in `-e16`.**
- E16 changes: `speech_ms` and `speech_basis` on `room_span_emotion`; spans under `min_speech_s` of
  *diarized* speech never enter `planned` and are written `unscorable`; no cutoff on the fraction;
  service `unscorable` answers excluded from `planned > 0 AND scored = 0` (`store.ts:232`).
- A9 now records **2,280 ms of speech over 29,070 ms = 0.078** and is still scored — that is intended.
- E14's exhausted-window shape (one 0.50 s span) now ends `no_segments`: nothing sent, no attempt used.
- With `min_speech_s` 2.5 on the wire, 3 of A9's spans are sent instead of 4 — the threshold is read.
- Docker is down; the four REQUIRED PROOF suites are **unrun, not green** (rule 8).
- `swift test` passes all 600 in a fresh worktree — tonight's `TestingMacros` failure was the main
  clone's corrupted `.build`, not a real break.
- Neon string at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf` — read, use, never print.
