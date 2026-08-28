# Even Scribe - Room Recorder Build B Completion

**Date:** 27 August 2026
**Status:** governing current Room Recorder execution
**Authorized by:** V
**Committed predecessor:** `f316fbf`
**Current committed baseline:** `33e9359`
**Re-estimated:** 28 August 2026
**Current plan:** `ETA-ROOM-RECORDER-REVISED-BUILD-PLAN-28-AUG-2026.md`
**Current team report:** `ETA-ROOM-RECORDER-STATE-OF-PLAY-28-AUG-2026.md`
**28 August planning status:** V directed execution to continue under the revised plan

## 1. Authorization

V selected **Entire Build B** after the unsigned one-day local derivation checkpoint closed. Execute
steps 4 through 12 in the ratified order from
`ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md`. This authorization supersedes the prior stop after
local derivation, but it does not relax any security boundary, stop rule, physical-coordination rule,
server contract or acceptance gate.

## 2. Ratified architecture

V ratified these previously unresolved choices:

1. Logical sample position is session-global and monotonically increasing across IST day boundaries.
2. Every configured lane receives a fresh random 256-bit root key and fresh random stream UUID for
   each IST day. Daily record sequences and purpose nonce domains restart only under that fresh
   root/stream identity.
3. The old and new day meet at one session-global sample integer. Each daily tape/index envelope may
   therefore begin at a nonzero logical sample position after the first day.
4. Capture runs inside the resident `room-recorder` executable. FFmpeg is the only production helper.
   The standalone `tapewriter` remains a development/probe tool, not the resident capture owner.
5. The same server session and monotonically increasing lane chunk indices continue across midnight.

## 3. Execution order

1. Close local derivation with the control/manifest codecs, transition replay, live-safe snapshots,
   exact IST rollover and synthetic crash recovery.
2. Retain and verify FFmpeg/libopus sources; build the minimal arm64 encoder; implement authenticated
   range streaming, encrypted spool, immutable manifest and journal transitions.
3. Build a local mock wire and prove reconciliation at every reservation, sync, encode, PUT, HEAD and
   row-registration crash boundary.
4. Integrate production archive keys, Keychain room credentials, durable command control, exact poll
   behavior, five microphone events, pause signal, minute stats and maintenance handoff/reclaim.
5. Assemble one signed app bundle, sign nested code first with the same final identity, install the
   LaunchAgent, hold the recording power assertion and prove relaunch/TCC continuity.
6. Freeze one immutable candidate, then run the Home Office destructive matrix, production smoke and
   twelve-hour within-day acceptance before issuing the final report.

## 4. Non-negotiable boundaries

- The current server routes, fields, MIME, R2 naming and authentication path do not change.
- No software key fallback, ad-hoc production signature, Homebrew production encoder, invented audio,
  zero fill, hidden gap, optimistic ACK or destructive deletion is permitted.
- Capture durability remains independent of encoder, network, brain and UI health.
- No paid processing, Cardiology recovery work, clinic-room test, rollout, Build C or Build D work.
- Never reboot, power-cycle, log out, yank USB, approve first-use TCC or alter production room ownership
  outside the named protocol and V's physical coordination.
- Stop and preserve evidence on tape loss, more than 2.000 seconds of loss, range/index inconsistency,
  false health, a server-contract conflict or any new unsettled product choice.

## 5. Completion

Build B is complete only when one fixed signed candidate passes every step 4-12 gate and the final
report records source and binary hashes, certificate and encoder provenance, full fault evidence,
production identities, twelve-hour measurements and human listening observations. Report before any
rollout decision.

## 6. Execution progress

### 6.1 Durable formats and midnight foundation

Implemented locally on 27 August 2026:

- strict canonical manifest and control payloads, complete journal/control replay validation, exact
  spool byte logical units and immutable manifest identities;
- session-global nonzero daily archive origins authenticated against the retained preceding day;
- writer-owned immutable authenticated snapshots that preserve lane-lock lifetime while capture
  continues;
- append-stable live level/VAD derivation across repeated snapshots, short observations,
  discontinuities and 60-record boundaries;
- fresh wrapped daily lane identities exposed only through nonsecret keywrap/stream facts;
- deterministic rollover command identity over the complete old/new plan;
- primary-only and multi-lane exact-seam validation;
- process-crash-safe idempotent recovery at every rollover transition and named durable failures;
- correct covered-sample count versus session-global sample end reporting.

Independent review found and the implementation repaired journal/control history gaps, unsafe start
failure shortcuts, spool range mismatch, manifest duplication, raw-root exposure, empty-day origin
ambiguity, snapshot lock release, live-sidecar instability, in-memory-only rollover recovery and one
keywrap identity TOCTOU. Final re-review found no remaining material issue.

The fresh local gate passed 283 tests in 28 suites, release build, strict Swift formatting and
`git diff --check`. Seven destructive/probe/soak fixtures remain opt-in and are not claimed by this
checkpoint. The next execution stage is the pinned minimal encoder and immutable encrypted spool.

### 6.2 Encoder, encrypted spool and retained delivery recovery

Implemented locally on 28 August 2026:

- pinned FFmpeg/libopus provenance and build inputs;
- authenticated range streaming into immutable encrypted spool records;
- complete reservation-to-verification journal witnesses and oldest-first delivery recovery;
- builder-owned retained lane catalog and startup recovery barrier, persisted and default off;
- unchanged Bench routes, fields, MIME, authentication and object naming.

### 6.3 Resident archive integration

Contract/test seam added locally on 28 August 2026:

- day-level `archive-v1/<YYYY-MM-DD>/_control/` layout is distinct from audio lane discovery;
- primary and backup share the IST midnight instant but authenticate their own exact sample boundary;
- resident archive selection is persisted, defaults off and requires a matching successful preflight
  receipt;
- `RoomEngine` now refuses enabled-but-ineligible configurations before polling or capture, and routes
  eligible start, service, levels, pause, resume, end, supersession and cancellation through one
  resident capture owner without invoking the legacy launcher;
- the canonical archive key has a real in-memory Secure Enclave encrypt/decrypt capability probe that
  returns only its public-key hash and creates no archive artifacts.

The direct encrypted audio-ring consumer, `CaptureSession` facade and retained control-key journal
opener are now implemented locally as B1 slices; the archive-root and signed-encoder probes, preflight
CLI, Keychain room credential and production owner factory are not yet complete. Until they are, an
eligible configuration without an injected resident owner fails closed by name; the default disabled
path preserves the bounded non-clinical predecessor behavior. No Build B candidate may record through
that plaintext sibling-process path.

### 6.4 Planning reset and candid re-estimate

Completed on 28 August 2026:

- audited the governing PRD, build plan, V1-V10 packet, Build B kickoff, completion authorization,
  historical state reports, recent commits and current Room Recorder source;
- separated accepted evidence, locally implemented foundations, contract/test seams and unstarted
  production work;
- confirmed that standalone archive, derivation, encoder, spool and recovery work is substantial but
  does not close resident production integration;
- confirmed that no concrete resident capture owner/factory, final signed bundle or current Build B
  physical candidate exists;
- re-estimated Build B at 40-50% implementation complete and 20-25% release/acceptance ready;
- proposed a replacement for the overlapping remaining sequence using finite stages B0-B7 in
  `ETA-ROOM-RECORDER-REVISED-BUILD-PLAN-28-AUG-2026.md`;
- issued the point-in-time engineering report
  `ETA-ROOM-RECORDER-STATE-OF-PLAY-28-AUG-2026.md`.

The current uncommitted resident integration gate was locally verified with 337 tests in 35 suites,
strict Swift formatting, debug and release builds, and `git diff --check`. No signing, Secure Enclave
target-Mini acceptance, destructive physical protocol, production smoke or twelve-hour run is claimed.

The proposed one-senior-engineer planning range is 23-37 remaining engineer-days, including a 2-3 day
integration contingency, or approximately 5-8 elapsed weeks, to Build B acceptance if signing,
reviews and Home Office coordination are available.
The clinic-ready browser replacement through Builds C and D has a provisional allowance of 45-73
remaining engineer-days, or approximately 10-16 elapsed weeks. That allowance excludes unknown
server/R2 work: Build D's update-distribution contract must be settled in its required kickoff before
the programme estimate is bounded. These are planning ranges, not waived gates or delivery
commitments.

### 6.5 B0 stabilization and first B1 capture slice

Implemented locally on 28 August 2026:

- serialized the Secure Enclave capability probe through the canonical cross-process provisioning
  lock and structurally authenticated discovered lane and `_control` keywrap metadata;
- made primary-only resident state explicit, kept failed finalization retryable and made resident loss
  fail health rather than advertise a recording;
- prevented supersession cleanup from restarting capture and required an unfinished generation to
  finalize before a later start;
- added a direct `AudioRing` to `ArchiveLaneStore` writer with no plaintext staging, one cooperative
  writer consumer, 16 kHz one-second authenticated records, short real boundary records, rational
  native-rate accounting, levels, durable-generation readiness and authenticated restart continuation;
- made writer stop/join idempotent, released archive locks and ring ownership before returning, and
  prevented historical durable growth from masking a later writer failure;
- added the package-scoped resident capture facade with stable-device authorization, bounded
  generation-specific readiness, serialized stop/drain, service health and cancellation that can stop
  an in-flight readiness attempt without deadlock;
- added the independent Secure Enclave-backed retained `_control/control.journal` lifecycle with
  held-descriptor authentication, create-only cleanup, strict existing-open policy and post-open path
  identity validation;
- added authenticated control preparation that publishes `control.json` and `keywrap.eak` while
  preserving the rule that `control.journal` is absent until the first durable command;
- made retained startup recovery authenticate every present control history and fail closed on replay,
  keywrap or ciphertext tampering;
- ratified and encoded explicit server command identities on command-driven start, resume, pause and
  end lifecycle causes, while naming relaunch reconciliation and local cleanup as non-command causes
  instead of fabricating command IDs;
- ratified authenticated retained lane lineage as the session-global sample-origin authority. The
  resolver returns zero only with no retained witness and fails closed on device substitution, future
  or duplicate days, invalid ranges and discontinuous daily seams;
- ratified `RoomEngine` as the owner of server network effects and the caller that brackets them with
  durable resident control-journal transitions. The resident runtime does not receive network
  credentials or perform session create, patch or acknowledgement calls;
- retained deterministic bounded tape-index marker coalescing. Zero-sample terminal events cannot be
  represented by the audio index without inventing samples and remain the responsibility of B1's
  day-level `_control` journal.

The current local gate passed 367 tests in 37 suites, 64 focused Thread Sanitizer tests in four suites,
a release build, strict Swift formatting and `git diff --check`. Independent review found no remaining
high or medium issue in the capture or control slices. No physical, signing, production or destructive
gate is claimed.

B0's code stabilization is complete locally, but its named clean baseline commit is still pending; no
commit was created without an explicit commit instruction. B1 is not complete. The next action is the
production resident owner/factory that binds the capture facade and canonical retained lane/control
stores to those identities and origins, then exposes the journal calls with which `RoomEngine` brackets
session and acknowledgement effects. The package dependency, CLI preflight and default factory
selection remain pending. Build C, Build D, clinic rollout and Phase 4 remain gated.

## 7. Log rules from this reset

- Append future execution results here; do not create another current-status log.
- Label every result as accepted, implemented locally, contract/test seam or not started.
- Do not call a Build B subsystem production-complete until it is part of the same signed fixed
  candidate that passes the applicable acceptance matrix.
- Treat test counts as evidence, never as percentage completion.
- Record candidate-invalidating source or binary changes explicitly.
