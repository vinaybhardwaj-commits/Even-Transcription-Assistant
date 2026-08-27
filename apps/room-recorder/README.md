# ETA Room Recorder

This directory is the isolated home of the native macOS Room Recorder.

> **Current governing milestone:**
> [`Unsigned archive integration`](../../docs/handoff/ETA-ROOM-RECORDER-UNSIGNED-ARCHIVE-INTEGRATION-27-AUG-2026.md).
> The unsigned browser-replacement path is accepted at `53f2354`. Current work is the explicit,
> no-network development integration into the authenticated tape/index format. Its published fixed test
> key is non-confidential. Secure Enclave, signing, canonical encrypted archive wiring and later roadmap
> work remain parked.
> The standalone slice passed on the Home Office Mini as `unsigned-archive-705cfb9b5cba`; its governing
> handoff records the exact source, binary and archive hashes. No next scope is selected yet.
>
> The bounded 27 August implementation cut is
> [`Unsigned EOD build`](../../docs/handoff/ETA-ROOM-RECORDER-UNSIGNED-EOD-BUILD-27-AUG-2026.md).

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
- [`App Build B encrypted index persistence P1`](../../docs/handoff/ETA-APP-BUILD-B-ARCHIVE-INDEX-PERSISTENCE-P1-KICKOFF-26-AUG-2026.md)
- [`App Build B archive key lifecycle P1`](../../docs/handoff/ETA-APP-BUILD-B-ARCHIVE-KEY-LIFECYCLE-P1-KICKOFF-27-AUG-2026.md)
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

Deterministic tests are under `Tests/TapeCoreTests`. The configured gate now reports 200 tests in 17
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

The focused archive key-lifecycle suite reports 23 tests in an ordinary build and 24 in a
probe-enabled build. The additional compile-gated test proves that probe path arguments are rejected
unless their raw strings are absolute, before any file URL is constructed.

The archive key-lifecycle slice is implemented for review but is not accepted. Its real Secure
Enclave provider and compile-gated `ArchiveKeywrapProbe` have not been executed on either Mac; no
permanent key has been created by this work. The probe now permits only candidate-specific test tags,
never the canonical production tag. Target-Mini mechanism proof, independent re-review, an immutable
candidate commit, signing and capture integration remain required.

Do not use local smoke runs as the Phase 0 acceptance report. The one-hour kill, power-pull, device-yank, full-day drift, CPU, and disk protocols must run on the Home Office Mini with the production microphone.
