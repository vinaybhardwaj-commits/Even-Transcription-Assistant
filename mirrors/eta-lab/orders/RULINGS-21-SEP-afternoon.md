# RULINGS — 21 Sep afternoon (Fable)

## split-speaker — J0 abstain (vinay/j0-abstain, worktree ETA-j0-abstain)
1. Vote record: don't persist it now. No migration and no overloading of model/error. Return it in the J0 job result/log so it's visible per run. Persistence comes later with provenance work.
2. Empty `language_mix` `{}`: treat it as ABSENT (abstain). A language claim that names no language carries no information. Add the test.
Then commit and report READY FOR REFUTER with the commit hash. Don't merge.

## scribe — the router half goes to the Refuter too
ETA-Refuter's scope is widened to include `~/eta-router` branch `vinay/vad-endpoint` @ 6126ebc (base 86661c6). The Refuter runs on the Mini, so nothing needs pushing. Keep holding both branches.

## ETA-Refuter — addendum to refuter-SPEECH-GATE.md
Also refute the router half: `~/eta-router` `vinay/vad-endpoint` @ 6126ebc vs 86661c6. Use your own worktree of that repo (`git -C ~/eta-router worktree add /tmp/refute-vad vinay/vad-endpoint`). Check that /vad returns speech spans only, runs no transcription, and fails closed on bad input, and that production :8083 on `main` is untouched. One verdict covering both halves. After this: `vinay/j0-abstain` (split-speaker) when it reports ready, then `vinay/join-only-clips` @ 3ca19d5.

## lx — recurrence SQL
Run it yourself, read-only, the way other panes query Neon: the connection string is read at runtime from the RTF by regex and never printed, echoed or passed on a command line. SELECT only, with the circularity exclusion in the WHERE clause. If your permission classifier refuses, quote the refusal in 2 lines and stop; I'll route it to another pane. Output as ordered in lx-recurrence-unblock.md.

## scribe3 — overnight translate
Option chosen: **Yoga runs the Indic engines, qwen stays on the Mini** (3.3–7.4 nights, the measured option). Build on a new branch `vinay/overnight-translate` from 45eedda:
(a) per-job `translate` (your ~3 files + tests);
(b) the overnight driver, modelled on the night-drain, with a hard stop on submitting at 07:10 IST and a clock gate, since room_window has none;
(c) order: the 5 Jev fixture room-days first, then the rest, with the label-free proxies removing the ~12–15% that are clearly empty.
Use NO token for now: build and test against a fake, and report what scope the driver needs. I'll settle the token at deploy. Transcript-off rooms are EXCLUDED until V decides. Report READY FOR REFUTER with branch + commit. Don't deploy, don't start the driver.

## V DECISION (21 Sep, 14:5x): Transcript-off rooms are INCLUDED
scribe3: include the transcript-off rooms in the overnight driver's scope. The room flag must not stop the backlog run. Don't change the room's own transcript_enabled setting; the driver passes transcription as a per-job parameter.
