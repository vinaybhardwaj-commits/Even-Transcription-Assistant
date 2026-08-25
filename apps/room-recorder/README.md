# ETA Room Recorder

This directory is the isolated home of the native macOS Room Recorder.

Development starts with the Phase 0 `tapewriter` SwiftPM harness. Do not add the Phase 1 engine until the Phase 0 report has been reviewed and accepted.

Governing documents:

- [`ETA Room Recorder PRD v1.1`](../../docs/handoff/ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md)
- [`App Build A Phase 0 kickoff`](../../docs/handoff/ETA-APP-BUILD-A-PHASE-0-KICKOFF-25-AUG-2026.md)
- [`Phase 0 test plan and debt`](../../docs/handoff/ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md)
- [`Home Office Mini runbook`](../../docs/handoff/ETA-APP-BUILD-A-PHASE-0-HOME-OFFICE-RUNBOOK-25-AUG-2026.md)
- [`ETA build plan`](../../docs/handoff/ETA-BUILD-PLAN-25-AUG-2026.md)

The archive always wins. Room Recorder work stays inside this directory unless a ratified build explicitly requires a server-contract change.

## Phase 0 harness

Build and run from this directory:

```sh
swift build -c release
.build/release/tapewriter record --out captures/bench
.build/release/tapewriter verify --dir captures/bench
.build/release/tapewriter export --dir captures/bench --wav captures/bench.wav
```

Pass `--device <uid>` to `record` to select a non-default input. The recorder prints the chosen stable UID before capture starts.

The tape is append-only 16 kHz mono signed Int16 little-endian PCM. `tape.idx` contains durable JSONL anchors and explicit restart, device, clock, format, timestamp, and overflow discontinuities. The verifier reports durable-tape drift and native microphone-clock drift separately because sample-rate conversion can buffer output between anchors.

Deterministic tests are under `Tests/TapeCoreTests`. All 20 currently pass in four suites with Apple Swift 6.4 and Testing Library 2078. They cover `TapeCore` plus the archive-critical ring, converter and writer paths exposed through `TapeCapture`. This Command Line Tools installation requires explicit macro/runtime staging in an external scratch build; the exact dependency-free recipe and remaining test debt are recorded in the Phase 0 test plan. The harness intentionally has no external dependencies.

Do not use local smoke runs as the Phase 0 acceptance report. The one-hour kill, power-pull, device-yank, full-day drift, CPU, and disk protocols must run on the Home Office Mini with the production microphone.
