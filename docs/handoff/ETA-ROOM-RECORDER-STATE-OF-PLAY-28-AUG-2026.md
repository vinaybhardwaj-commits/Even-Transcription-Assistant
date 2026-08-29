# Even Scribe Room Recorder - engineering state of play

**Date:** 28 August 2026 · **updated 29 August 2026 for engineering handover**
**Audience:** engineering, product and operations
**Repository:** https://github.com/vinaybhardwaj-commits/Even-Transcription-Assistant
**Branch:** `feat/room-recorder` — https://github.com/vinaybhardwaj-commits/Even-Transcription-Assistant/tree/feat/room-recorder
**Committed baseline:** `33e9359` (`Add retained archive delivery recovery`)
**Current phase:** App Build B, headless native engine
**Overall verdict:** substantial foundations, incomplete product integration, not production-ready

## 29 August handover update

The branch is published. Clone the repository above and check out `feat/room-recorder`.

- **Remote tip:** `f8726fe` — a **work-in-progress snapshot committed 29 August for this handover.
  It is not accepted Build B evidence.** The last accepted checkpoint is `5befcf1`
  (`Build resident encrypted capture foundation`, 28 August). Everything between them is the
  28 August working tree, committed so engineering can inspect it.
- **Body of this document:** written 28 August against baseline `33e9359`. The completion log
  (`ETA-ROOM-RECORDER-BUILD-B-COMPLETION-27-AUG-2026.md`) carries the sections that landed after it.
- **Live status, verified 29 August through the operator door:** the unsigned development build
  runs on the Home Office Mini as the LaunchAgent, polling and listening. It recorded a short
  session on 29 August; both pieces verified by the production server; the room-day opened itself
  with zero consult marks (D39); no spare lane, no backup pieces.
- **Deployment caveats for OPD test installs:** the build is unsigned — each Mac needs a one-time
  Gatekeeper approval and one microphone permission click, and both reset with every new binary
  until the signing identity lands at B4. There is no room screen (Build C). What is testable is
  the headless engine: tape, uploads, remote commands.
- Raw audio evidence stays on the Home Office Mini by design; it is not in Git.

## Executive summary

The team is building a native macOS Room Recorder to replace the unreliable browser kiosk without
changing the existing server, audio-piece or command contracts. The system is designed around an
encrypted local PCM archive as the source of truth. Five-minute WebM/Opus pieces, uploads, events,
statistics and room-day state are derived from that archive and can be recovered after downstream
failure.

The programme has completed its server prerequisite, the physical capture feasibility harness and a
large body of archive, derivation, encoder, spool and recovery engineering. That work is real and
valuable. The resident production recorder that assembles those parts does not yet exist. Current
uncommitted code defines the resident-owner contract, selection gate and lifecycle routing, but the
production CLI cannot construct that owner. Enabled resident mode therefore fails closed rather than
recording.

The honest position is **40-50% through Build B implementation and 20-25% through Build B release
readiness**. Build B is not complete, signed, deployable or approved for patient use. The revised plan
estimates 5-8 weeks for one senior engineer to finish and accept Build B. The provisional allowance
through the room screen, updater and first controlled clinic rollout is 10-16 weeks, excluding unknown
server/R2 work until the Build D update contract is ratified. Phase 4 voice-driven consult state is a
separate 4-7-week programme after its pre-flight and design gate.

## Product outcome

The Room Recorder must:

- launch at login, restart after failure and hold the Mac awake while recording;
- capture true microphone samples through native Swift code with no browser engine;
- lose no more than 2.000 seconds after hard process or wall-power failure;
- retain an authenticated encrypted local archive for 14 days after verified upload;
- derive the exact existing five-minute mono WebM/Opus pieces and use unchanged Bench APIs;
- report health only from durable tape/index growth;
- record real gaps and never invent or zero-fill audio;
- support one microphone as a normal configuration with no phantom backup state;
- obey listener-gated Start/Pause/Resume/End and preserve consent semantics;
- provide the Build B Brain substrate without performing paid STT, diarization or inference locally.

## Architecture

```text
CoreAudio input tap
  -> single-producer/single-consumer ring
  -> authenticated encrypted PCM tape + index
  -> sample-exact cutter + durable journal + level/VAD sidecar
  -> bundled minimal FFmpeg/libopus encoder
  -> immutable encrypted spool
  -> oldest-first reconciliation and unchanged Bench upload APIs

command poller + events/stats ---------------> unchanged Bench control/Brain APIs
LaunchAgent + power assertion ---------------> process and recording supervision
```

The callback boundary is strict: no disk, crypto, encoder, network, logging, locks or allocation-heavy
work occurs on the audio callback. One writer consumer owns each lane ring. Capture durability cannot
depend on the encoder, network, Brain or UI.

## Roadmap status

| Programme stage | Status | Current truth |
|---|---|---|
| Build 3 server prerequisite | Accepted | D39 and one-microphone server truth are deployed and accepted. |
| Build A Phase 0 harness | Accepted | Real Home Office hard-kill, wall-power, microphone-yank and controlled-load evidence exists for candidate `3d4139e`. |
| Build B headless engine | Implemented locally | Library foundations are strong; resident product integration, control, identity and acceptance remain. |
| Build C room screen | Not started | Waits for the Build B final report, its own kickoff and counsel-approved Pause copy. |
| Build D update and rollout | Not started | Waits for Build C acceptance and a kickoff that resolves the update-distribution contract. |
| Parallel voice pre-flight | Not started | Can run separately; gates Phase 4 only. |
| Phase 4 consult intelligence | Not started | Requires voice pre-flight and a separately ratified design. |

## Build B delivery status

| Original Build B step | Status | Assessment |
|---|---|---|
| 1. Design/provenance | Implemented locally | Architecture is documented; final certificate and signed artifact values remain absent by design. |
| 2. Isolated P1 hardening | Implemented locally | All named mechanism groups have software evidence; fixed-candidate physical rows remain. |
| 3. Encrypted archive | Implemented locally | Format, crypto, tape/index and key lifecycle exist. Resident capture does not write the production archive yet. |
| 4. Local derivation | Implemented locally | Cutter, journal, sidecar and midnight foundations exist, but are not attached to resident live capture. |
| 5. Encoder | Implemented locally | FFmpeg 9.0.1/libopus 1.6.1 build inputs and spool path exist. Final signing, legal package and production wire freeze remain. |
| 6. Mock wire/reconciliation | Implemented locally | Delivery and retained-lane recovery are substantial; formal candidate closure of every crash boundary remains. |
| 7. Control plane | Contract/test seam | Legacy poller and server client exist; Keychain, exact cadence, events/stats, durable commands, maintenance and optional backup remain. |
| 8. Product identity | Not started | A plist writer exists, but no final signed app bundle, nested signing, verified bootstrap, power assertion or TCC proof exists. |
| 9. Destructive acceptance | Not started | Build A evidence cannot transfer to changed Build B mechanisms. |
| 10. Production smoke | Not started | Earlier unsigned smoke is useful predecessor evidence, not the canonical Build B gate. |
| 11. Twelve-hour acceptance | Not started | Requires one frozen signed candidate after all earlier gates. |
| 12. Final report | Not started | Cannot close before acceptance. |

## What has been accomplished

### Accepted prerequisites

- Build 3 server corrections and D39 room-day opening passed at source checkpoint `0f72431`.
- Build A proved native capture feasibility on the Home Office Mini.
- Build A measured a 1.114562-second hard-kill tail, 1.300312-second wall-power tail, a true
  microphone gap with no zero fill, and an eight-hour controlled run with zero dropped blocks.
- The Build A eight-hour waiver and 2.5-second verifier boundary do not weaken Build B's twelve-hour
  and 2.000-second gates.

### Capture and archive foundations

- Stable-UID CoreAudio capture, SPSC ring, conversion to logical 16 kHz mono Int16 and explicit
  timing/discontinuity classification.
- Durable writer and parser recovery across torn PCM/index, injected I/O failure and full disk.
- Canonical authenticated record envelopes, HKDF purpose separation and AES-256-GCM block sealing.
- Paired encrypted tape/index persistence with tape-before-index durability and authenticated repair.
- Secure Enclave P-256 daily keywrap lifecycle with no software-key fallback.
- Authenticated growing snapshots, range reads and strict wrong-key/tamper rejection.

### Derivation, midnight and delivery foundations

- Sample-exact five-minute reservation journal and deterministic replay.
- Sample-indexed level/VAD sidecar with torn-tail recovery.
- Session-global samples across IST day boundaries with fresh per-day/per-lane roots and stream IDs.
- Day-level `_control` sibling layout and per-lane exact sample boundaries at one shared midnight
  instant.
- Pinned minimal encoder inputs, authenticated range streaming and immutable encrypted spool.
- Oldest-first delivery coordinator, duplicate-safe Bench adapter and retained-lane startup recovery.

### Current resident integration seam

The uncommitted working tree adds:

- persisted resident-archive selection and matching preflight receipt requirements;
- fail-closed errors for missing, failed, mismatched or unavailable resident runtime;
- `RoomResidentCaptureOwning` lifecycle routing for start, service, levels, pause, resume, end,
  supersession and cancellation;
- a real in-memory Secure Enclave capability probe returning only a public-key hash;
- focused resident lifecycle, index-preservation and key-probe tests.

The current local gate passed 337 tests in 35 suites, strict formatting, debug and release builds and
`git diff --check`. This is local software evidence only. It is not a signed candidate, physical test
or production acceptance.

## What does not exist yet

The following are material product gaps, not documentation cleanup:

- a concrete production `RoomResidentCaptureOwning` implementation and factory;
- resident AVAudioEngine/ring ownership feeding encrypted primary and optional backup lanes;
- live composition of archive, cutter, sidecar, encoder, spool, delivery and retention;
- the purpose-specific `_control` keywrap/journal opener;
- real archive-root and signed-encoder preflight plus CLI receipt persistence;
- Keychain storage for the 30-day room credential;
- complete `configure/login/preflight/start/stop/status/handoff/reclaim` CLI behavior;
- exact `app_<install-id>` listener identity and 1.5/3/5-second poll behavior;
- durable command outcomes and expiry handling;
- strict omission of unavailable levels rather than synthesized `0/0`;
- five microphone events, pause signal and once-per-minute `live_sink_stats`;
- explicit optional second-device configuration and backup runtime;
- complete 14-day-after-verified-coverage retention/deletion;
- final app bundle, certificate, nested encoder signing and distribution package;
- LaunchAgent bootstrap verification, recording power assertion and same-identity TCC proof;
- one fixed-candidate destructive matrix, production smoke, twelve-hour run and final report.

## Why progress felt circular

Three planning problems created that impression:

1. The original Build B step names mixed isolated foundations with production integration. A
   standalone archive proof could be marked complete while the resident app still used plaintext
   `tapewriter`.
2. Temporary unsigned resets became additional status documents. They were valid checkpoints, but
   their later supersession made the active plan hard to see.
3. Test growth was visible and integration readiness was not. The test suite reduced real technical
   risk, but a rising test count did not move signing, packaging or physical acceptance.

The revised plan fixes this by using one finite B0-B7 path and four status labels: accepted,
implemented locally, contract/test seam and not started.

## Remaining critical path

1. Stabilize and commit the current resident selection/control/preflight seam.
2. Implement the concrete primary-lane resident capture owner and authenticated durable readiness.
3. Assemble live archive, derivation, encoder, spool, delivery and retention; then add explicit backup.
4. Close Keychain, preflight, CLI, exact poller, events/stats and maintenance ownership.
5. Build and sign one supervised app bundle with the final identity and power assertion.
6. Pass automated/fault gates and freeze one immutable candidate.
7. Run the coordinated Home Office destructive matrix.
8. Run the pinned production smoke and twelve-hour acceptance.
9. Issue the Build B report before Build C.

Detailed estimates and exit criteria are in
`ETA-ROOM-RECORDER-REVISED-BUILD-PLAN-28-AUG-2026.md`.

## Schedule outlook

| Milestone | One-engineer planning range | Notes |
|---|---:|---|
| Build B accepted | 5-8 weeks | External certificate and physical access can extend elapsed time. |
| Build C accepted | Additional 2-3 weeks | Requires counsel copy and designer review. |
| Build D and first controlled clinic room | Additional 3-5 weeks provisional | Excludes unknown server/R2 work until the update contract is ratified. |
| Clinic-ready browser replacement | 10-16 weeks provisional from current state | Approximately 45-73 remaining engineer-days, excluding unknown update-contract implementation. |
| Phase 4 voice-driven consult state | Additional 4-7 weeks | Separate pre-flight and decision gate. |

These ranges assume one focused senior engineer. Two engineers can overlap control/packaging/UI work,
but cannot safely parallelize ownership of the resident capture core or fixed-candidate evidence.

## Principal risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Resident integration exposes timing or durability defects | Build B estimate expands | Integrate primary-only first and preserve one-writer ownership; run fault gates before adding backup. |
| Final signing identity is unavailable | No product bundle or TCC proof | Name an operations owner and create/trust the identity before B4. |
| TONOR/CoreAudio remains unreliable after cold boot | Start may require physical recovery | Preserve durable-growth readiness and the accepted five-second USB replug fallback; test on fixed candidate. |
| Secure Enclave key loss | Retained local tape can become unrecoverable | Document no-escrow behavior, protect device lifecycle and never delete before server verification plus retention. |
| Unchanged server contract has ambiguous create/ACK windows | Availability can be lost | Continue to fail closed and require operator/reaper recovery rather than invent success. |
| Physical or review scheduling delays | Elapsed schedule expands | Book certificate, legal, Home Office, counsel and designer gates before their engineering stages finish. |
| Update announcement/distribution contract is undefined | Build D scope and estimate can expand | Resolve it in the required Build D kickoff; obtain V approval for any new server or R2 surface. |
| More intermediate redesign documents | Team loses the active path again | Use only the revised plan, rolling build log and dated state report for current status. |

## Decisions and support needed from the team

No new product architecture decision is currently required to begin the next implementation stage.
The engineering team needs named owners and dates for:

- final signing certificate creation, custody and Home Office trust;
- FFmpeg LGPL distribution review and retained compliance materials;
- Home Office destructive-test and twelve-hour windows;
- production smoke authorization;
- counsel-approved Pause copy and designer availability for Build C;
- the Build D update manifest, authentication, publishing and rollback contract;
- first Cardiology rollout ownership and rollback criteria;
- voice pre-flight privacy/operations approval if Phase 4 remains a programme goal.

## Repository state at this report

- `feat/room-recorder` is 10 commits ahead of `origin/feat/room-recorder` at committed HEAD `33e9359`.
- The working tree contains intended uncommitted resident archive changes across Room Recorder source,
  tests and four handoff documents: design provenance, the completion log, this report and the revised
  plan.
- `RoomEngineResidentCaptureTests.swift` is currently untracked and belongs to that intended work.
- Four unrelated Mini automation/runbook files remain untracked and are not Build B evidence.
- No commit, push, deployment or physical protocol was performed as part of this planning review.

## Current governing documents

1. `ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md` - product requirements R1-R22.
2. `ETA-APP-BUILD-B-DECISION-PACKET-26-AUG-2026.md` - ratified V1-V10.
3. `ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md` - original Build B gates.
4. `ETA-ROOM-RECORDER-BUILD-B-COMPLETION-27-AUG-2026.md` - rolling execution log and current
   authorization.
5. `ETA-BUILD-PLAN-25-AUG-2026.md` - broader programme order and later-build kickoff rules.
6. `ETA-ROOM-RECORDER-REVISED-BUILD-PLAN-28-AUG-2026.md` - current sequence and estimates; V directed
   execution to continue under it on 28 August 2026.
7. `ETA-APP-BUILD-B-DESIGN-PROVENANCE-26-AUG-2026.md` - technical design choices.

## Bottom line

The project has not wasted its foundation work, but it has over-reported how close those foundations
are to a shippable recorder. The next objective is not another standalone mechanism. It is one
resident primary-lane vertical path from real microphone samples through encrypted durable tape to a
verified server piece, followed by control/security closure and one fixed signed candidate. Build B
should be judged only by that candidate and its acceptance evidence.
