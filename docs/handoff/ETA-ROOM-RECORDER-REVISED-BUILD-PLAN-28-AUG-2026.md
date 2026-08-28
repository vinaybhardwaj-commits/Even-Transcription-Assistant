# Even Scribe Room Recorder - revised build and completion plan

**Date:** 28 August 2026
**Status:** current planning baseline; V directed execution to continue on 28 August 2026
**Scope:** Build B through clinic-ready browser replacement, with the Phase 4 path shown separately
**Committed code baseline:** `33e9359` on `feat/room-recorder`
**Current execution authority:** `ETA-ROOM-RECORDER-BUILD-B-COMPLETION-27-AUG-2026.md`

## 1. Why this reset is necessary

The original plan has produced strong, well-tested foundations, but its progress labels no longer show
how far the product is from running as the production Room Recorder. Standalone archive, derivation,
encoder, spool and recovery proofs were real progress. They did not, by themselves, complete the
resident production pipeline, its control plane, signed packaging or physical acceptance.

This plan does not weaken the PRD, V1-V10, the unchanged server contract or any acceptance gate. It
replaces the current execution sequence with a finite integration and release path.
Historical plans remain evidence of the decisions and work performed at the time; they are not the
current schedule.

The reset makes four distinctions explicit:

1. **Accepted:** the required implementation and its applicable evidence gate have passed.
2. **Implemented locally:** production-shaped code exists and automated local evidence passes, but it
   is not yet part of one accepted candidate.
3. **Contract or test seam:** interfaces and tests describe required behavior, but no production
   implementation owns that behavior.
4. **Not started:** no material production implementation exists.

Only **accepted** work closes a release gate. Test counts are supporting evidence, not a measure of
product completion.

## 2. Finish lines

The programme has two distinct finish lines. They must not be collapsed into one moving definition of
"the project."

### 2.1 Clinic-ready browser replacement

Complete when Builds B, C and D are accepted:

- the signed resident Mac app owns capture and survives process and power failure;
- the encrypted local archive remains authoritative and produces the unchanged server pieces;
- the headless control plane, screen, consent controls, provisioning and updater are complete;
- Home Office acceptance and update/rollback pass;
- the install runbook exists and the first Cardiology rollout is deliberately accepted.

This is the version 1 Room Recorder delivery milestone.

### 2.2 Voice-driven consult-state product

Complete after the parallel voice pre-flight, a separately ratified Phase 4 design, and Phase 4
implementation and acceptance. This adds live identified-voice consult state and the short-segment
server surface. It is not required to replace the browser recorder safely.

## 3. Current re-estimate

### 3.1 Build B

| Measure | Estimate | Meaning |
|---|---:|---|
| Implementation complete | **40-50%** | Most archive and delivery libraries exist; the resident runtime, control plane and product packaging do not. |
| Release/acceptance ready | **20-25%** | Prerequisite and local evidence is strong, but no signed fixed Build B candidate or current physical acceptance exists. |
| Remaining one-engineer effort | **23-37 engineer-days** | Includes integration contingency but not waiting for external people or credentials. |
| Likely one-engineer elapsed time | **5-8 weeks** | Assumes focused work, prompt reviews and timely access to signing and Home Office protocols. |

The percentages are planning judgment, not earned-value accounting. The implementation range weights
archive/capture foundations at 40%, resident assembly at 20%, control/security at 15%, product
identity at 10%, and candidate acceptance/reporting at 15%. Release readiness is lower because local
subsystem evidence cannot substitute for one signed fixed candidate. These percentages should be
updated only at B-stage exits, not after individual tests or helpers.

These are planning ranges, not delivery commitments. The largest uncertainty is integration between
real-time capture, encrypted persistence, derivation and command lifecycle under crash recovery. The
second largest is signing and physical acceptance, which cannot be completed by code alone.

### 3.2 Programme to clinic-ready replacement

| Stage | Remaining engineering effort | Likely elapsed time | Gate |
|---|---:|---:|---|
| Build B: signed headless engine | 23-37 days | 5-8 weeks | Fixed-candidate report accepted |
| Build C: room screen | 10-16 days | 2-3 weeks | Designer and consent acceptance |
| Build D: updater and rollout | 12-20 days provisional | 3-5 weeks provisional | Excludes unknown server/R2 work until the update contract is ratified; then update, rollback, TCC and first-room runbook are accepted |
| **Total from current state** | **45-73 engineer-days provisional** | **10-16 weeks provisional** | Clinic-ready browser replacement; excludes unknown update-contract implementation |

With two experienced engineers, some control-plane, packaging, UI and operational work can overlap,
but the resident capture critical path and fixed-candidate evidence cannot. A provisional
two-engineer elapsed range is **7-11 weeks** to clinic-ready replacement if external dependencies are
available; it excludes unknown server/R2 work until the Build D update contract is ratified.

### 3.3 Phase 4 after the recorder

- Voice pre-flight: 2-4 engineer-days, runnable in parallel and gating Phase 4 only.
- Divergent design and ratification: 3-5 working days plus decision availability.
- Server, voice, app and acceptance implementation: 20-35 engineer-days, approximately 4-7 weeks.

## 4. What is already closed

| Area | Status | Evidence boundary |
|---|---|---|
| Build 3 server prerequisite and D39 | Accepted | Corrective checkpoint `0f72431` and pinned production deployment. |
| Build A Phase 0 harness | Accepted | Fixed candidate `3d4139e`; hard kill, wall power, device yank and eight-hour controlled load. The eight-hour waiver applies only to Build A. |
| Build B design and isolated P1 mechanisms | Implemented locally | Required software gates passed for ring, timing/discontinuity, converter, durable writer, index/verifier, WAV and readiness groups. Fixed-candidate physical rows still remain. |
| Encrypted archive formats and persistence | Implemented locally | Authenticated envelopes, crypto, tape/index persistence, keywrap lifecycle and range reading. |
| Local cutter, journal, sidecar and midnight foundations | Implemented locally | Deterministic reservations, replay, live-safe snapshots, exact rollover and recovery. |
| Pinned encoder and encrypted spool | Implemented locally | FFmpeg/libopus source lock, range streaming, immutable encrypted spool and delivery journal. Final signing, distribution review and production smoke remain. |
| Delivery reconciliation and retained-lane recovery | Implemented locally | Oldest-first retry and startup recovery barrier at `33e9359`. |
| Resident selection and lifecycle routing | Contract/test seam | Current uncommitted work gates selection and routes lifecycle calls, but no concrete resident owner exists. |

No Build B subsystem is called production-complete until it belongs to the same signed fixed candidate
that passes the Build B acceptance matrix.

## 5. What remains in Build B

### B0. Stabilize the current baseline

**Estimate:** 1-2 engineer-days
**Depends on:** none

Work:

- review and commit only the intended resident gate, `_control` layout and Secure Enclave probe work;
- preserve the default-off bounded non-clinical predecessor path while B1 is developed;
- retain the current 337-test/35-suite local result and rerun the relevant focused, debug, release,
  format and diff gates from a clean candidate;
- record one exact committed baseline for resident integration.

Exit:

- clean intended worktree at a named commit;
- enabled-but-ineligible resident mode fails closed;
- disabled mode performs no resident archive, key or encoder work;
- no Build B candidate records through the plaintext sibling `tapewriter` path;
- no unrelated Mini automation files enter the candidate.

### B1. Build the concrete resident capture owner

**Estimate:** 4-6 engineer-days
**Depends on:** B0

Work:

- make `RoomRecorderCore` own the real `TapeCapture` integration;
- compose `CaptureSession` and `AudioRing` with exactly one encrypted writer consumer per configured
  microphone;
- implement primary-only first, then explicit optional backup without creating phantom spare state;
- open daily audio and `_control` keywrap/journal state with the canonical Secure Enclave lifecycle;
- prove first authenticated durable tape/index growth before start succeeds;
- implement service, pause, resume, final drain, unexpected stop and restart recovery;
- keep disk, crypto, encoding, network, logging and allocation-heavy work off the audio callback.

Exit:

- the production factory exists and is selected only after successful preflight;
- no sibling `tapewriter` process owns capture in enabled resident mode;
- primary-only capture grows authenticated tape/index and restarts from it;
- pause/end boundaries are durably closed and no sample is invented;
- lane failure isolation and durable-growth health tests pass.

### B2. Assemble the local production pipeline

**Estimate:** 4-6 engineer-days
**Depends on:** B1

Work:

- run cutter, range journal and level/VAD sidecar against the growing resident archive;
- connect the pinned encoder, encrypted spool and delivery coordinator;
- preserve server-provided per-lane next indexes across restart and midnight;
- complete retained archive recovery and 14-day post-verification retention/deletion rules;
- make encoder, disk, network and Brain failures independent of capture;
- close primary-only and optional-backup local end-to-end tests.

Exit:

- one synthetic resident session produces authenticated tape, deterministic reservations, playable
  WebM/Opus, immutable spool records and duplicate-safe mock delivery;
- every durable sample range is either not yet reserved or has exactly one durable identity;
- no day can be deleted before complete verified coverage plus 14 days;
- synthetic midnight preserves the server session and monotonic lane indexes while rolling each
  lane at its own exact sample boundary for the shared IST instant.

### B3. Close security and the headless control plane

**Estimate:** 4-6 engineer-days
**Depends on:** B1; most work can proceed alongside B2

Work:

- implement archive-root durability, Secure Enclave and signed-encoder preflight probes and receipt
  persistence;
- move the 30-day room credential from `config.json` into Keychain;
- complete CLI `configure`, `login`, `preflight`, `start`, `stop`, `status`, maintenance handoff and
  same-session reclaim;
- use `app_<install-id>` listener identity and exact 1.5/3/5-second polling cadence;
- enforce command expiry and durable command outcome recovery rather than process-memory-only replay;
- omit absent or invalid levels instead of synthesizing `0/0`;
- post the five locked microphone events, pause signal and once-per-minute `live_sink_stats`;
- support an explicitly configured second UID only, with no backup artifacts otherwise.

Exit:

- all V5, V7 and V10 provisioning/control cases pass;
- start ACK follows first durable growth and end ACK follows final verification/session end;
- expired credential, missing primary, explicit no-spare, ambiguous create/ACK and Brain outage paths
  fail by name without damaging tape;
- browser maintenance handoff and controlled reclaim retain one session and non-reused indexes.

### B4. Create the product identity and supervised bundle

**Estimate:** 3-5 engineer-days, excluding certificate procurement delay
**Depends on:** B2 and B3

Work:

- create or select the final in-house signing identity and record its fingerprint;
- preserve FFmpeg/libopus source, hashes, flags, notices, relinking materials and distribution review;
- assemble the app bundle and sign nested encoder code first with the same identity;
- install and verify the LaunchAgent, not just write its plist;
- hold and release the recording power assertion correctly;
- prove same-identity replacement preserves microphone permission.

Exit:

- one signed app bundle with one signed nested encoder and immutable hashes;
- `codesign` verification, dependency closure and provenance pass;
- LaunchAgent bootstrap/status/relaunch and recording power assertion pass;
- no Homebrew or ad-hoc production dependency remains.

### B5. Close automated candidate gates and freeze

**Estimate:** 2-4 engineer-days
**Depends on:** B4

Work:

- run full debug/release, formatting, Swift tests, TSAN and fault-injection suites;
- run archive tamper/wrong-key/torn-tail, disk/write and complete crash-boundary matrices;
- independently decode/play encoder output and run the complete mock-wire reconciliation matrix;
- verify secrets, raw audio and protected key material are absent from source and logs;
- fix all blockers, then freeze a single immutable source and binary candidate.

Exit:

- every software row in the original Build B acceptance matrix has retained evidence;
- zero known blocker or material finding remains;
- source SHA, app hash, encoder hash and certificate fingerprint are fixed;
- any source or binary change invalidates the candidate and returns to B5.

### B6. Run fixed-candidate physical and production acceptance

**Estimate:** 2-3 engineer-days and 3-5 elapsed days, including the 12-hour run
**Depends on:** B5 and V-coordinated Home Office access

Work, in order:

1. Home Office destructive matrix: hard kill, encoder kill, network/Brain outage, TONOR yank,
   output-route change, wall-power pull, cold boot, maintenance handoff and synthetic midnight.
2. Short primary-only production smoke against the pinned deployment.
3. Twelve uninterrupted hours wholly inside one IST date.
4. Human listening at opening, middle, closing and every destructive boundary.

Exit:

- every physical row in kickoff section 11 and every applicable section 12 gate passes on the same
  fixed candidate; the bullets below are a summary, not a replacement for that matrix;
- worst loss is at most 2.000 seconds with no invented audio;
- automatic relaunch resumes the same tape and server session;
- every produced object is accepted and verified, continuous seams are zero and true gaps are named;
- D39 room-day exists with zero marks;
- no backup artifact exists in Home Office primary-only configuration;
- at least 691,200,000 logical samples and normally 144 five-minute rotations are accounted for;
- resource, listening and no-paid-work evidence is retained.

### B7. Issue the Build B completion report

**Estimate:** 1-2 engineer-days
**Depends on:** B6

Exit:

- the report includes every item required by kickoff section 13;
- Build B is explicitly accepted before Build C starts;
- unresolved anomalies become named blockers or debt, never silent waivers.

### Build B integration contingency

**Estimate:** 2-3 engineer-days

This is not another execution stage. It is explicit planning allowance for defects found when the
resident runtime, control plane and signed bundle first converge. B0-B7 sum to 21-34 engineer-days;
this allowance produces the stated 23-37-day Build B range. Unused contingency is not scope for new
features.

## 6. Build C - room screen

**Estimate:** 10-16 engineer-days, 2-3 elapsed weeks
**Entry gate:** accepted Build B report and counsel-approved Pause copy

Work:

1. Build the native lamp states: off, recording, paused and finished for today.
2. Add Start, Pause and Mark consult using the accepted engine/control paths.
3. Add the setup overlay with selected microphone, level and explicit spare-device presence.
4. Add PIN-gated quit and prevent casual termination.
5. Prove UI failure cannot affect capture and Pause creates a true archive gap and Brain signal.
6. Complete accessibility, desktop/mobile-equivalent window sizing where relevant, and designer
   screenshot review.

Exit:

- R11 visual and interaction acceptance passes;
- counsel copy is exact;
- a passer-by cannot close the app;
- the UI displays engine/Brain truth and never owns recording state.

## 7. Build D - updater, installation and first rollout

**Estimate:** 12-20 engineer-days, 3-5 elapsed weeks
**Entry gate:** accepted Build C

This is a provisional planning allowance for kickoff, client updater, packaging, acceptance and
rollout. It excludes any unknown server/R2 implementation. The estimate is not bounded until the
kickoff ratifies the update announcement/distribution contract.

Work:

1. Write and obtain acceptance of the required Build D kickoff. Resolve the currently undefined update
   announcement/distribution contract: existing or new manifest location, schema, authentication,
   publishing ownership and rollback ownership. If this requires a new server or R2 surface, obtain
   explicit V ratification before implementation; Build B's unchanged-server boundary may not be
   silently repurposed.
2. Implement the ratified update discovery, signed bundle download, checksum/signature validation,
   atomic replacement and retained rollback version.
3. Block update while recording and let LaunchAgent relaunch the app.
4. Prove one normal update and one rollback on Home Office with microphone permission retained.
5. Write the one-page install/provisioning/recovery runbook.
6. Prepare observability and rollback criteria, then roll out one clinic room at a time, Cardiology
   first.

Exit:

- update and rollback preserve the archive, configuration, Keychain credential and TCC identity;
- installation is repeatable from the runbook;
- first-room production monitoring passes its agreed observation window before broader rollout.

## 8. Parallel voice pre-flight and Phase 4

The voice pre-flight should run in parallel once ownership and privacy approval are confirmed. It uses
the stored 24 August Cardiology and OPD 5 tape and the existing diarization service. It does not gate
Build B-D.

Phase 4 starts only after:

- the voice pre-flight answers the four monitoring-PRD questions;
- a divergent design round resolves the consult state machine and short-segment intake;
- V ratifies the new server and app boundary.

Phase 4 then implements and accepts consult started, paused, stopped, left for investigations,
returned, resumed and completed, with the lamp reflecting server Brain state within seconds.

## 9. Dependencies requiring named owners

| Dependency | Needed by | Owner/action |
|---|---|---|
| Final in-house signing identity and trust installation | B4 | Engineering/operations must create, escrow appropriately and approve the certificate. |
| FFmpeg LGPL distribution review | B4 | Engineering plus legal/operations must retain notices, source and relinking materials. |
| Home Office physical access and V coordination | B6 | Schedule destructive protocols, TCC, USB and power actions. |
| Production smoke authorization | B6 | Confirm room ownership, listener and pinned deployment window. |
| Counsel-approved Pause copy | Build C | Counsel/product must supply exact text before UI acceptance. |
| Designer review availability | Build C | Schedule screenshot and behavior review. |
| Clinic rollout window and rollback owner | Build D | Operations/product must name the room, time and stop criteria. |
| Update announcement/distribution contract | Build D kickoff | Engineering/product must identify or ratify the manifest, auth, publishing and rollback surfaces before the estimate can be treated as bounded. |
| Stored-audio privacy approval and diarize availability | Voice pre-flight | Product/operations must authorize the defined existing-tape analysis. |

## 10. Execution discipline from this point

1. Keep this plan, the rolling completion log and the current state-of-play report as the only three
   current-facing status documents.
2. Do not create another Build B slice kickoff unless a genuinely unresolved product decision
   requires V ratification. Preserve the roadmap requirement for separate Build C and Build D
   kickoffs after their entry gates open.
3. Close one B-stage exit before calling the next stage active. B2 and B3 may overlap only because
   they have separate owners and converge at B4.
4. Every status update must use one exact evidence label: accepted, implemented locally,
   contract/test seam or not started.
5. Review at integration boundaries and candidate freeze; do not restart broad design review after
   every small implementation change.
6. Do not optimize for test count. Add tests for an identified risk or exit criterion.
7. Maintain one evidence index and one immutable candidate directory. Never reuse evidence after a
   source or binary change.
8. Keep the original stop rules: no server-contract drift, invented audio, false health, index/range
   inconsistency, secret leakage, destructive deletion or uncoordinated physical action.

## 11. Supersession and authority

This document changes planning and status presentation only. It does not independently ratify a new
product decision or waive an existing gate.

Authority order for implementation remains:

1. `ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md`
2. `ETA-APP-BUILD-B-DECISION-PACKET-26-AUG-2026.md`
3. `ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md`
4. `ETA-ROOM-RECORDER-BUILD-B-COMPLETION-27-AUG-2026.md`
5. `ETA-BUILD-PLAN-25-AUG-2026.md` for the broader programme order and later-build kickoff rules
6. This revised plan for current sequencing and estimates after explicit acceptance
7. `ETA-APP-BUILD-B-DESIGN-PROVENANCE-26-AUG-2026.md` for builder-owned technical choices

The unsigned reset, archive integration and local derivation documents remain valid historical
evidence. Their scope stops and "no next work" statements are superseded by the later entire-Build-B
authorization and this revised sequence. The 26 August state-of-play is a historical chronology, not
the current status report.

## 12. Immediate next action

V directed execution to continue under this plan. B0 is stabilized locally but still awaits its named
commit. B1 now has the direct encrypted audio-ring writer, serialized `CaptureSession` facade and
canonical retained lane/`_control` opening with authenticated control recovery. The immediate next
action is the production resident owner/factory. Server command identity delivery and the
session-global initial sample origin policy are now explicit server IDs and authenticated retained
lineage respectively. `RoomEngine` remains the network owner and will bracket its effects through the
resident runtime's durable journal interface. The next implementation slice is that interface and
effect ordering, followed by package/CLI factory selection. Do not start Build C, updater work, clinic
rollout or Phase 4 while Build B remains open.
