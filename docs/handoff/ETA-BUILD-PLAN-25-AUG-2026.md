# ETA build plan — 25 August 2026

The order of work from today until the Room Recorder replaces the browser kiosk. One build
in flight at a time unless a row says otherwise. Every build gets its own kickoff, pasted
whole into Claude Code, and no kickoff is written while a fact it depends on is unknown.

**Governing documents.** Server work: `ETA-MONITORING-SURFACE-PRD-24-AUG-2026-v1.2.md`
(D1–D39) plus `ETA-PILOT-BACKLOG-24-AUG-2026.md`. App work:
`ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md` (R1–R22). Designer locks:
`DESIGNER-REC-ROOM-RECORDER-APP-25-AUG-2026.md`.

---

## The sequence

| # | Build | What it does | Spec | Kickoff | Can start when |
|---|---|---|---|---|---|
| 1 | **Build 3 (server)** | Run-waiting-audio control · re-bind the 16 windows · **day auto-opens on tape (D39)** · server half of P8 · door reports levels · backlog honesty | Monitoring PRD v1.2 | `ETA-BUILD-3-KICKOFF-25-AUG-2026.md` — **written, amended, ready** | V says go |
| 2 | **App Build A — Phase 0 harness** | The tapewriter: proves the tape survives kill −9 and a power pull, and measures the real clock drift on the real Mini | RR PRD R3, R4, R15 | `ETA-APP-BUILD-A-PHASE-0-KICKOFF-25-AUG-2026.md` — **written, ready** | With V's go. Zero file overlap with Build 3, so it may run in parallel if V allows; otherwise after Build 3 is verified |
| 3 | **Voice pre-flight (§15)** | The four voice questions answered from the 24 Aug tape (Cardiology + OPD 5) through the existing diarize service. First diarization ever on room audio. No app code | Monitoring PRD §15 | Small kickoff, written after Build A is handed over | Parallel with anything — it touches only stored tape and the Mini's diarize service |
| 4 | **App Build B — Phase 1 engine** | Capture core, day file + index, cutter, bundled encoder, sweeper, poller. Headless. A full Home Office day verified by the production server, seam 0, day record present with zero marks | RR PRD §4, §6 | **Not written. Gated on the Phase 0 report** — drift, discontinuity behavior, and fsync cost decide details the kickoff must state as facts | Phase 0 report read by V, and Build 3 verified (D39 must exist for acceptance) |
| 5 | **App Build C — Phase 2 screen** | Lamp, three verbs, setup overlay, PIN-gated quit, consent pause | RR PRD R11 | Not written. Needs counsel's Pause copy — the one external dependency | Build B verified, counsel copy in hand |
| 6 | **App Build D — Phase 3 ship** | Certificate, self-update proven twice (one rollback), install runbook, clinic rollout Cardiology first | RR PRD R7, R9 | Not written | Build C verified |
| 7 | **Phase 4 spec round** | The consult-state machine: started, paused, stopped, patient-left-for-investigations, returned, completed. **A decision round in this thread, with a divergent pass — not a Claude Code build** | RR PRD R19, R21, R22 | Kickoff exists only after V ratifies the Phase 4 spec | Pre-flight report read |

---

## Rules that hold across every row

- No kickoff with an open issue. Every fork is adjudicated with V first.
- Verification on production reality, never on the report alone. For app builds that means
  running the app and watching the tape land, not reading a build log.
- The archive always wins. Any change that could cost one piece of clinical audio does not
  ship.
- Every GitHub action runs through Claude Code. The masters live in the ETA folder on
  iCloud; each kickoff instructs Claude Code to sync `docs/handoff/` in the same commit.
- A new alarm ships only after it stays silent through an ordinary day.

## What is deliberately not planned yet

Build B, C, and D kickoff contents beyond their gates: each is written only when its gate
opens, from the facts the gate produced. The Phase 4 state machine: hardest open design in
the programme, own decision round. The clinic install day: scheduled when Build D's runbook
exists.
