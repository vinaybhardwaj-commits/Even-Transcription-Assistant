# App Build A — Phase 0: the tapewriter harness

**Kickoff for Claude Code. Paste this whole file.**

PRD: `docs/handoff/ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md` — read R3, R4, R14, R15 and §4
first. If the PRD is not in `docs/handoff/`, copy it there from this kickoff's bundle in the
same commit as your work, together with this kickoff and
`ETA-BUILD-PLAN-25-AUG-2026.md`.

## 0. What this is

The first native code of the Room Recorder. Not the app. A ~200-line command-line harness
that answers the three questions the whole engine design rests on, on the real machine with
the real microphone, before any engine code exists:

1. After a hard kill or a power cut, how much tape is lost? (Must be ≤ ~2 seconds.)
2. What is the real drift between the microphone's sample clock and the Mac's clock?
3. How often do capture discontinuities happen, and does the index record them honestly?

Nothing here talks to a server. Nothing here encodes audio. Raw PCM and an index, that is
all. **The design is only ratified contingent on this harness's report. If the report
contradicts a PRD premise, stop and say so — do not adapt silently.**

## 1. Where it lives

New SwiftPM package at `apps/room-recorder/` in the repo. Executable target `tapewriter`.
Swift only, no third-party dependencies, builds with `swift build -c release` on macOS with
the command-line tools. No Xcode project file.

## 2. The tapewriter

`tapewriter record --out <dir> [--device <uid>]`

- Open the input device by its stable unique id (`--device`), default input if omitted.
  Print the chosen device's name and unique id at start.
- Capture via AVAudioEngine input tap. Convert to 16 kHz, mono, 16-bit little-endian PCM.
- Append every buffer to `<dir>/tape.pcm`. The write path does no allocation, no locks, no
  logging on the audio thread — hand buffers to a writer thread over a lock-free hand-off.
- Every ~2 s: `F_FULLFSYNC` the tape file, then append one JSON line to `<dir>/tape.idx`
  and fsync it too:
  `{"byte_offset": n, "samples": n, "mono_ns": n, "wall_ns": n, "device": "uid", "rms": x}`
  where `mono_ns` is monotonic time, `wall_ns` is wall clock, and `rms` is the RMS (0..1)
  of the samples since the previous record.
- On device loss: append `{"discontinuity": "device_lost", ...}` with both clocks, retry
  acquisition every 5 s, and on success append `{"discontinuity": "resumed", ...}`. Tape
  bytes are only ever true samples — never fill (R14).
- On start against an existing tape: do not truncate, append a
  `{"discontinuity": "restart"}` record first.
- Ctrl-C closes cleanly with a final index record. SIGKILL is expected to be survivable —
  that is the point.

## 3. The verifier

`tapewriter verify --dir <dir>` prints a report:

- Total samples, total duration by sample math, wall-clock span from first to last record,
  and the difference between the two.
- Per-record drift: samples-elapsed versus monotonic-elapsed, in ms and in ppm; the fitted
  overall ppm; the largest single-step anomaly.
- Every discontinuity, with cause and both clocks.
- Tail loss: bytes in `tape.pcm` past the last index record, expressed in seconds — this is
  what a crash at that moment would have cost.
- A hard verdict line: worst tail loss ≤ 2.5 s → `PASS`, else `FAIL`.

Also: `tapewriter export --dir <dir> --wav <file>` wraps the raw PCM in a WAV header so a
human can listen to it. No resampling, no processing.

## 4. The test protocol (run with V, on the Home Office Mini)

Run from a terminal — macOS will attribute the microphone permission to the terminal, which
is fine for the harness; the app's own permission story is Phase 3's problem.

1. **One-hour bench.** Record an hour. Kill −9 at ~30 minutes. Restart. Verify. Listen to
   30 seconds around the kill point in the exported WAV.
2. **Power pull.** While recording, pull the Mini's power at the wall. Boot, verify, report
   tail loss.
3. **Device yank.** While recording, unplug the microphone for ~60 s and replug. Verify the
   discontinuity pair and that the gap equals the unplugged time.
4. **Full day.** Record a whole day untouched. Verify. This is the drift measurement the
   PRD's clock design depends on.

## 5. Gate before you report

- `swift build -c release` clean on macOS. `tapewriter verify` runs on the produced data.
- No third-party dependencies. No network calls anywhere in the target.
- CPU while recording ≤ a few percent on the Mini; report the measured figure.

## 6. Report back with

- The verifier output for all four protocol runs, verbatim.
- Worst tail loss per crash event, and whether the 2 s fsync cadence actually held under
  load (largest observed gap between index records).
- The fitted drift in ppm for the full-day run, and what that means in ms per five-minute
  piece.
- Every discontinuity observed outside the deliberate yank, with your reading of the cause.
- Anything that contradicts a premise in PRD R3/R4 — named plainly, not worked around.
- Measured CPU and disk numbers.
