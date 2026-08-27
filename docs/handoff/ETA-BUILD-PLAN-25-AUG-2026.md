# ETA build plan — 25 August 2026

The order of work from today until the Room Recorder replaces the browser kiosk. One build
in flight at a time unless a row says otherwise. Every build gets its own kickoff, pasted
whole into Claude Code, and no kickoff is written while a fact it depends on is unknown.

> **Current execution override, 27 August 2026:** V reset Room Recorder delivery to the unsigned,
> side-loaded end-to-end milestone in
> `ETA-ROOM-RECORDER-UNSIGNED-VERTICAL-SLICE-RESET-27-AUG-2026.md`. That reset governs current work
> wherever it conflicts with the sequence below. Secure Enclave, signing, canonical encrypted archive,
> destructive tests and later builds are parked until the existing browser contract works end to end
> from the native process. Scope may expand only with V's explicit approval.
>
> **Post-reset decision:** that exit gate passed and was committed at `53f2354`. Current execution is the
> unsigned, development-only no-network archive integration defined in
> `ETA-ROOM-RECORDER-UNSIGNED-ARCHIVE-INTEGRATION-27-AUG-2026.md`; signing and production key security
> remain parked.

**Governing documents.** Server work: `ETA-MONITORING-SURFACE-PRD-24-AUG-2026-v1.2.md`
(D1–D39) plus `ETA-PILOT-BACKLOG-24-AUG-2026.md`. App work:
`ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md` (R1–R22). Designer locks:
`DESIGNER-REC-ROOM-RECORDER-APP-25-AUG-2026.md`.

---

## The sequence

| # | Build | What it does | Spec | Kickoff | Can start when |
|---|---|---|---|---|---|
| 1 | **Build 3 (server)** | Run-waiting-audio control · re-bind the 16 windows · **day auto-opens on tape (D39)** · server half of P8 · door reports levels · backlog honesty | Monitoring PRD v1.2 | **ACCEPTED 26 Aug** — deployed as `dpl_497Ns1qzVnTvZ7N7YgTt61UgMUX2`; field evidence in `ETA-BUILD-3-CORRECTIVE-REPORT-26-AUG-2026.md` | Closed |
| 2 | **App Build A — Phase 0 harness** | The tapewriter: proves the tape survives kill −9 and a power pull, and measures the real clock drift on the real Mini | RR PRD R3, R4, R15 | **ACCEPTED 26 Aug** — H-01 through H-04 complete on fixed candidate `3d4139e` | Closed |
| 3 | **Voice pre-flight (§15)** | The four voice questions answered from the 24 Aug tape (Cardiology + OPD 5) through the existing diarize service. First diarization ever on room audio. No app code | Monitoring PRD §15 | Small kickoff, written after Build A is handed over | Parallel with anything — it touches only stored tape and the Mini's diarize service |
| 4 | **App Build B — Phase 1 engine** | Capture core, encrypted day tape + index, cutter, bundled encoder, sweeper, poller and brain-feed substrate. Headless. A twelve-hour Home Office day verified by production, seam 0, day record present with zero marks | RR PRD §4, §6 | **ACCEPTED 26 Aug** — `ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md` pins accepted checkpoint `0f72431`; V1-V10 ratified in the decision packet | IN FLIGHT: V accepted the kickoff on 26 Aug |
| 5 | **App Build C — Phase 2 screen** | Lamp, three verbs, setup overlay, PIN-gated quit, consent pause | RR PRD R11 | Not written. Needs counsel's Pause copy — the one external dependency | Build B verified, counsel copy in hand |
| 6 | **App Build D — Phase 3 ship** | Self-update proven twice (one rollback), install runbook, clinic rollout Cardiology first; inherits Build B's final signing identity | RR PRD R7, R9 | Not written | Build C verified |
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

Build C and D kickoff contents beyond their gates: each is written only when its gate opens,
from the facts the gate produced. The Phase 4 state machine: hardest open design in
the programme, own decision round. The clinic install day: scheduled when Build D's runbook
exists.
