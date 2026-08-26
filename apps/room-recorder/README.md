# ETA Room Recorder

This directory is the isolated home of the native macOS Room Recorder.

Phase 0 is accepted. App Build B Phase 1 starts by completing the mechanism-specific P1 hardening
gates before any Phase 0 component is reused in the production engine.

Governing documents:

- [`ETA Room Recorder PRD v1.1`](../../docs/handoff/ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md)
- [`App Build A Phase 0 kickoff`](../../docs/handoff/ETA-APP-BUILD-A-PHASE-0-KICKOFF-25-AUG-2026.md)
- [`Phase 0 test plan and debt`](../../docs/handoff/ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md)
- [`Home Office Mini runbook`](../../docs/handoff/ETA-APP-BUILD-A-PHASE-0-HOME-OFFICE-RUNBOOK-25-AUG-2026.md)
- [`App Build B Phase 1 kickoff`](../../docs/handoff/ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md)
- [`App Build B DUR P1 evidence`](../../docs/handoff/ETA-APP-BUILD-B-DUR-P1-KICKOFF-26-AUG-2026.md)
- [`App Build B IDX/VER P1 evidence`](../../docs/handoff/ETA-APP-BUILD-B-IDX-VER-P1-KICKOFF-26-AUG-2026.md)
- [`App Build B builder design`](../../docs/handoff/ETA-APP-BUILD-B-DESIGN-PROVENANCE-26-AUG-2026.md)
- [`App Build B WAV P1 evidence`](../../docs/handoff/ETA-APP-BUILD-B-WAV-P1-KICKOFF-26-AUG-2026.md)
- [`App Build B cold-boot P1 evidence`](../../docs/handoff/ETA-APP-BUILD-B-COLD-BOOT-P1-KICKOFF-26-AUG-2026.md)
- [`App Build B pre-archive capture disposition`](../../docs/handoff/ETA-APP-BUILD-B-PRE-ARCHIVE-CAPTURE-DISPOSITION-26-AUG-2026.md)
- [`App Build B archive envelope P1`](../../docs/handoff/ETA-APP-BUILD-B-ARCHIVE-ENVELOPE-P1-KICKOFF-26-AUG-2026.md)
- [`App Build B archive crypto P1`](../../docs/handoff/ETA-APP-BUILD-B-ARCHIVE-CRYPTO-P1-KICKOFF-26-AUG-2026.md)
- [`App Build B encrypted tape persistence P1`](../../docs/handoff/ETA-APP-BUILD-B-ARCHIVE-TAPE-PERSISTENCE-P1-KICKOFF-26-AUG-2026.md)
- [`App Build B encrypted index codec P1`](../../docs/handoff/ETA-APP-BUILD-B-ARCHIVE-INDEX-CODEC-P1-KICKOFF-26-AUG-2026.md)
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

Deterministic tests are under `Tests/TapeCoreTests`. The configured gate now reports 149 tests in 15
suites with Apple Swift 6.4 and Testing Library 2078; the converter soak and two isolated APFS ENOSPC
fixtures remain opt-in for ordinary runs. `RING-01` through `RING-06`, `CAP-02` through `CAP-07`,
`SRC-01` through `SRC-04`, `DUR-02` through `DUR-05`, `DUR-07` through `DUR-09`, `IDX-02` through
`IDX-08`, `VER-02` through `VER-08`, `WAV-02` through `WAV-05`, and `DGR-01` through `DGR-09` are
complete at their isolated/software boundary. The full routine gate
passes normally and under Thread Sanitizer, the converter soak passes at 44.1, 48, 96 and 192 kHz,
and both disposable-volume ENOSPC acceptance fixtures pass independently. The suites cover `TapeCore` plus the archive-critical
ring, capture timeline, converter and durable-writer paths exposed through `TapeCapture`.
This Command Line Tools installation requires explicit macro/runtime staging in an external scratch
build; the exact dependency-free recipe and remaining test debt are recorded in the Phase 0 test
plan. The harness intentionally has no external dependencies.

Do not use local smoke runs as the Phase 0 acceptance report. The one-hour kill, power-pull, device-yank, full-day drift, CPU, and disk protocols must run on the Home Office Mini with the production microphone.
