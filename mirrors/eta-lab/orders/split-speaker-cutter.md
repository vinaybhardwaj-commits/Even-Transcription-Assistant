# ORDER — write cut_clips.py — 20 Sep 07:30

You were right to stop, and right that telling me where the pilot is stuck beats producing the
file. I passed V a command to run a script that does not exist; that was my error, caught by you
before it wasted his time. Thank you.

Here is the one fact you asked for, plus the three judgement calls that go with it.

## Where the window audio comes from
**R2, via `bench_window.clip_r2_key`.** Not a local copy.

That is the canonical audio and — this is the reason, not just the preference — it is the exact
bytes the diarizer read. The offsets in `manifest.clips[].segs` were computed against it, so any
other source risks offsets that are subtly wrong in a way neither you nor V would notice: he
would hear the wrong half-second and answer honestly about the wrong speaker. Same bytes in,
same offsets out.

If a window in the manifest has a null `clip_r2_key`, DROP that clip and report the count. Do not
substitute another source. A pilot of 19 real clips is fine; a pilot with two clips cut from the
wrong audio is worthless and we would not know which two.

## Concatenate or longest run: CONCATENATE
Join that label's `segs` into one wav, in time order, with a short silence between segments so V
can hear the joins rather than being fooled by a hard cut.

Reason: the question he is answering is "is this the same person as me", and more speech is a
better sample than the single longest run. A 4-second longest run invites a coin-flip.

**Cap each clip at about 25 seconds** of concatenated speech, taking the longest segments first,
then restoring time order for playback. Past that he is spending attention without gaining
certainty, and 22 clips must stay inside 20 minutes.

## Output
`clips/<id>.wav` exactly as `serve.py:50` and `selftest.py` expect. Plain PCM wav — no
re-encoding beyond what ffmpeg needs to concatenate, and no normalisation, filtering or noise
reduction. He is judging a voice; do not process the thing he is judging.

## The privacy line, unchanged and absolute
stdout gets **counts and alignment offsets only**. Never a window id, a label, a room, a
clinician or patient name, or a path that identifies a patient. Not in stdout, not in a log, not
in a filename, not in an error message — errors are where this usually leaks, so check your
failure paths specifically. The `<id>` in `clips/<id>.wav` stays the opaque id the manifest
already uses.

## Do NOT touch F6(b)
ETA-Refuter has already completed it — mutation-proved, gate green at 3150 passed / 1 skipped /
0 failures, and it declined the remainder-to-last-row scheme with reasoning I accept. Abandon
your mid-edit and do not commit it. Two panes editing one file is the thing I most want to avoid,
and this is my fault for leaving that item ambiguous between you. The qid double-underscore you
already applied is correct and stays.

Your ownership is the pilot, start to finish. Nothing else.

## Then
Cut the clips, confirm all 22 exist (or report the dropped count), run your self-test, and tell
me the link is live. V is waiting on this and it is the highest-value 20 minutes on the board.
