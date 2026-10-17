Serving model: claude-sonnet-5-5 (brief names no Opus refuter; reruns below are mine, independent of both builders).
# GUARDIAN R16e VERDICT (cloud-guardian-r16e-refute). Base 41b88298 (R16d-3)
A = cloudpane/cloud-guardian-r16e/r16e c589d84b. B = cloudpane/cloud-guardian-r16e-w/r16e 14adf303.
## Summary
- A: PASS-WITH-FIXES (no MUST; one ruling-wording question for Fable, three SHOULD test gaps).
- B: FAIL (MUST: breaks two pinned R16d/R16d-3 tests and one more; no build report on the branch).
- Ship A.
## How I ran it (Linux, no macOS)
- The macOS suite cannot run here: BSD date -j and stat -f, root-owned files, ACLs, launchd, pinned /usr/bin. I used a test-only BSD date/stat shim in scratch (outside the repo). Full run.sh hangs on Linux at t_control test_hup_of_main (pid-wait), so I ran every t_*.sh except t_control.sh and t_install.sh (version assertions in t_control:902 and t_usb:336 checked by diff instead).
- BASE 41b88298: `tests: 253 functions, 1281 assertions passed, 497 failed (0 leaked sandbox dirs)`
- A: `tests: 264 functions, 1344 assertions passed, 497 failed (0 leaked sandbox dirs)`. First pass had 4 base-only failures that flip on timing (probe_leaves_no_descendant, usb r15 x3); zero A-only failures in either pass.
- B: `tests: 262 functions, 1329 assertions passed, 504 failed (0 leaked sandbox dirs)`. 7 more failed assertions than base, 3 B-only functions (B1-B3 below).
- The 497 base failures are the Linux/root environment (ACL, install, launchd, usb, root-readable chmod 000). No sqlite3 here.
- shellcheck 0.11.0 -x on canary.sh common.sh t_r16e.sh: rc 0 for A and for B. No perl/python/osascript/jq in changed lib code in either (perl appears only in tests, as in the base tests).
- scrub.sh origin/guardian/fr1-c1-r16..<tip> (gitleaks 8.21.2): A rc 0, B rc 0.
- mini/tests not rerun (neither build touches mini/).
## Rulings 1-3 by reading
- Ruling 3: both set GUARDIAN_VERSION c1-0.4.8-r16e at lib/common.sh:7 and change only the two version assertions (t_control:902, t_usb:336). `git diff --stat` on tests/ vs base: only those 2 lines plus new t_r16e.sh.
- Ruling 1, A: canary.sh:301-302 kill then mode, before outside_window and consult. Event word for kill and shadow is `would_do` (canary_play_aborted :320-323), audit line `canary aborted: kill play=2 slot=...`. Not `aborted:kill` as ruled; see A1.
- Ruling 1, B: canary.sh kill then mode first in canary_play_gate, words `aborted:kill` and `aborted:mode`. Matches the ruling text, breaks pinned tests (B1, B2).
- Ruling 2, A: canary_gap_speech scans every byte from play 1's measured end (P_END_FILE/P_END_SIZE, set in canary_play_once :234, copied :344, reset per slot :333); loudest 2 s window, hop 0.25 s; gate call placed after speech_recent so end-of-gap speech keeps `recorder_busy`; gap speech elsewhere gives `aborted:speech`; noted via note_speech.
- Ruling 2, B: canary_gap_speech with canary_rms_peak2s (hop 0.5 s) before speech_recent; every hit gives `aborted:recorder_busy` (including start and middle); speech_seen written directly. State carried in locals p1_file/p1_end and passed as gate args.
## Mutants (all executed against the real t_r16e tests in a scratch copy; sed applied, diff checked)
- Ordered M1 (kill-first removed) and M2 (window back to last 2 s): both killed in both builds, as the builders report (A: 58/6 and 46/18; B: kill tests red, gap start/middle red).
- A own mutants: a1 kill line removed KILLED (2 fns); a2 mode line removed KILLED (shadow test); a3 gap call removed KILLED (start/middle/late); a5 CANARY_P1_SIZE=0 KILLED (silence-still-plays); a7 kill word changed to aborted:kill KILLED (3 fns); a4 per-slot reset of P1_FILE/P1_SIZE removed SURVIVED (184 assertions pass); a6 hop 0.25 s -> 2 s SURVIVED (63 pass).
- B own mutants: b1 kill line removed KILLED; b3 gap call removed KILLED; b4 rolled-segment offset forced 0 KILLED; b5 hop 0.5 s -> 2 s KILLED (middle); b2 mode line removed SURVIVED (52 pass, no shadow-between-plays test); b6 unreadable size fail-open SURVIVED (52 pass).
## Findings, A
- A1 SHOULD (for Fable): ruling 1 says `aborted:kill`; A emits `would_do` because pinned t_r16d.sh:181 (test_r16d_kill_switch_between_plays_gives_one_play_and_would_do) expects would_do. Builder disclosed it. Repro: `r16e_kill` hook, event result is would_do, audit says aborted: kill. Fable decides: keep (existing word, zero pinned-test edits) or change the word and edit t_r16d.sh:181. One-line either way.
- A2 SHOULD: mutant a4 survives. Without the per-slot reset (canary.sh:333), a long-lived process would carry slot N's P1 file/size into slot N+1 play 1 and scan stale offsets. guardian.sh:126 calls canary_cycle per tick; if the process is long-lived this is live. Add a test with two consecutive slots in one process.
- A3 SHOULD: mutant a6 survives. A 1 s speech burst inside a coarse hop is still diluted above the gate, so no test pins hop size. Add a short (0.5 s) loud burst case or accept hop as unpinned.
- A4 NIT: A's abort tests omit the "not retried" check that r3_case in t_r16d3 has (slot stays committed). Behaviour is unchanged (commit precedes the gate) but unproven by the new tests.
- A5 NIT: canary_gap_speech returns "no speech" when the tape size is unreadable (fail-open; the earlier rms_dbfs_2s gate already needed a readable tape, so practically unreachable).
## Findings, B
- B1 MUST: test_r16d_kill_switch_between_plays_gives_one_play_and_would_do (t_r16d.sh:181) FAILS. Repro: run it; event is `aborted:kill`, test wants `would_do`.
- B2 MUST: test_r16d3_mutant_gate_before_play2_removed FAILS ("mutation did not apply" x3). B reshaped the call line `canary_play_gate "$ckey" ${p1_file:+...} || {`, so the R16d-3 in-suite sed no longer matches. A kept the line's shape and says so.
- B3 MUST: test_direct_call_in_shadow_makes_no_afplay_call FAILS: wants would_do, gets `aborted:mode`. Same cause as B1 (mode now gates first).
- B4 SHOULD: no test for a shadow flip between plays (mutant b2 survives). B's mode word is `mode`, not `mode_not_heal`.
- B5 SHOULD: no GUARDIAN-R16E-BUILD.md on the branch (brief says each carries one); only OUTBOX.md, whose line says "9 fns 52 pass 0 fail" and never mentions the three red existing tests. B did not run the full suite.
- B6 NIT: unreadable tape size fails closed (good) but untested (b6 survives).
- B7 NIT: every gap hit is `recorder_busy`; no `aborted:speech` distinction (not required by the rulings).
## Edge risks (both unless noted)
- Kill during play 1: caught by act_step inside canary_play_once (would_do, existing test passes in A and B-base paths). Kill after play 1: gate catches (A would_do, B aborted:kill).
- Speech exactly at gap boundaries: start 0-2 s, middle 6.5-8.5 s, late 10.5-12.5 s caught; end 13-15 s caught by the existing arm in A, by the gap scan in B. Silence still plays twice (both). Speech shorter than 2 s is diluted by the 2 s window; a loud 0.5 s burst still clears the gate, not pinned by a test.
- Play 1 ended under 15 s ago / gap shorter than 2 s of bytes: range under 2 bytes is empty and passes; a short range is measured whole. Clock skew: the scan uses byte offsets, not time, so skew cannot move the window. Only note_speech/speech_seen use the clock.
- Rolled segment: A scans the last 17 s of the new file; B scans the new file from byte 0. Both cover the gap.
- Gate failure leaves the slot committed (commit precedes the loop): the event carries the committed slot and night in both; r3_case (B) proves no retry, A's tests do not (A4).
- Residual risk both: tape lag over about 4.5 s puts play 1's tone tail past the measured end, the gap scan reads it as speech and aborts play 2 (fails closed). A flagged it; B did not.
## R16d-3 behaviour intact
- A: outside_window, committed slot/night in events, 15 s gap, one aborted event plus audit line, no escalate: all t_r16d3 tests pass in A.
- B: same tests pass except B2 (mutant mechanics only; the real aborts still work).
## Recommendation
Ship A (c589d84b). It adds zero new failures against base, edits no existing test beyond two version lines, keeps the R16d-3 mutant mechanics, and ships a build report. B follows the ruling's `aborted:kill` word literally but turns three existing tests red and has no report. If Fable wants `aborted:kill`, apply that one-word change to A plus the t_r16d.sh:181 edit; do not take B. Fix A2 (and A4) before the Mini run.
