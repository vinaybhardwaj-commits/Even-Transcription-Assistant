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

B0's code stabilization is complete locally and its named clean baseline is commit `5befcf1`. B1 is not
complete. The next action is the production resident owner/factory that binds the capture facade and
canonical retained lane/control stores to those identities and origins, then exposes the journal calls
with which `RoomEngine` brackets session and acknowledgement effects. The package dependency, CLI
preflight and default factory selection remain pending. Build C, Build D, clinic rollout and Phase 4
remain gated.

### 6.6 B1 durable command-control slice

Implemented locally on 28 August 2026 after baseline commit `5befcf1`:

- added the serialized authenticated `ArchiveRoomControlJournal` compare-and-append interface with
  exact-state idempotency, stale/divergent rejection, non-regressing command clocks and retained named
  failure recovery;
- made the eligible resident construction seam return capture and control owners as one runtime while
  preserving the disabled path's zero-construction behavior;
- bracketed fresh start, pause, resume and end effects with the ratified durable success and failure
  states, including capture-before-resume-patch ordering and explicit start/resume compensation;
- required the resident owner to reserve and verify final derivative ranges before the server end patch;
- validated command acknowledgement IDs/status, retried recovered ACK-ready states without replaying
  effects, and recorded `command_not_pending` as an unobservable ACK outcome;
- added ratified `command_noop` and `command_refused` decision states so already-satisfied and
  policy-refused commands reach durable ACK boundaries without fabricating session effects;
- blocked relaunch reconciliation from restarting capture across ambiguous start, unfinished end,
  unfinished pause and compensated resume states; and
- added fault tests proving that post-start and resume journal failures stop capture, ambiguous start/end
  never adopt capture, and final verification failure never patches server end.
- completed relaunch continuation for every intermediate start, pause, resume and end state: an ambiguous
  `start_intent` remains fail-closed, `session_opened` compensates instead of assuming capture, durable
  capture witnesses reconcile only against the exact authoritative session, pause retries its idempotent
  patch, resume compensates failed patches, and end reserves and verifies final ranges before patching;
- made the newest control for the exact active session authoritative, so stale controls cannot stop or
  restart a replacement session and a newer end supersedes older capture-producing recovery regardless
  of opaque command-ID order;
- separated observed server effects from subsequent journal writes. A post-patch journal failure now
  retains the retryable pre-patch state and retries the idempotent patch after relaunch instead of sending
  a false failure acknowledgement;
- required capture-producing recovery to match the server's current session and compatible status, so a
  known absent session and an authoritative pause are never treated as permission to record;
- made `start_day` with `override_pause:true` retain the resume control/acknowledgement family while using
  the original server command ID, and changed an already-existing server recording into local capture
  reconciliation rather than a session that start compensation could end; and
- strengthened the resident control test journal with the production payload transition validator and
  added crash-point, replacement-session, causal-order, nil-session, patch-failure, post-effect journal
  failure and override-pause tests; and
- deferred eligible resident-runtime construction until the canonical server room ID is available from
  either the active session or command poll, while keeping the factory mandatory, waiting for retained
  recovery, rejecting room-identity changes and forbidding fallback to the plaintext sibling launcher.

That B1 control checkpoint passed 397 tests in 38 suites, 48 focused Thread Sanitizer tests in three
suites, a release build, strict Swift formatting and `git diff --check`. No physical, signing,
production or destructive gate is claimed.

B1 remains incomplete. The start/pause/resume/end relaunch continuations are implemented, but maintenance
handoff/reclaim and rollover remain owned by their dedicated coordinators rather than `RoomEngine`, and
effectfully superseded intermediate controls remain fail-closed pending an explicit terminalization
contract. Deferred construction resolves canonical room identity and retained-recovery store ordering.

### 6.7 Primary resident owner and verified derivative pipeline

Implemented locally on 28 August 2026:

- made `RoomRecorderCore` depend directly on `TapeCapture` and added a concrete primary-only resident
  owner that opens or reuses the canonical retained daily lane, proves first authenticated growth,
  recreates capture generations after pause, preserves server-provided lane indices and never creates
  backup state;
- added the eligible production runtime factory and canonical daily `_control` owner. Factory creation
  creates control identity only; it does not open a microphone or create a primary/backup audio lane;
- made resident service and final-range operations asynchronous and gave finalization an explicit room,
  session and per-lane index context, so a freshly constructed owner can finish a paused session after
  relaunch without process-memory identity;
- composed deterministic cutter reservation, level sidecar, pinned streaming encoder, immutable encrypted
  spool and unchanged Bench delivery into one local pipeline. Final reservation is durably complete before
  the control journal enters `final_ranges_reserved`, and final verification requires exact contiguous
  `.done` coverage before the server end patch;
- extended retained delivery recovery to advance authenticated `.reserved` and `.encoded` work through
  spooling and verification when the production encoder is available, while preserving the prior
  fail-closed classification when it is not; and
- added synthetic owner/factory, pre-spool restart, pipeline idempotency and final-coverage tests. The
  primary-only owner test produces authenticated tape/index, one deterministic reservation, encrypted
  spool and a verified mock chunk row without any backup artifact.

The current local gate passes 403 tests in 39 suites, 78 focused Thread Sanitizer tests in six suites, a
release build, strict Swift formatting and `git diff --check`. No physical, signing, production or
destructive gate is claimed.

The runtime factory is intentionally not selected in the CLI. Exact live IST rollover remains open: a
native input block that straddles midnight must be split on the callback without allocation or locking,
the boundary must enter the SPSC ring in order, the old writer must close at that exact sample and the new
daily writer must continue from it without stopping the producer. A timer-driven stop/start would violate
the ratified exact-seam and keep-capture-flowing contract. The current ring/writer API does not yet expose
that operation. Daily `_control` ownership must rotate with the audio lane in the same implementation.

Deletion is also deliberately deferred. The frozen V1 delivery journal records no authenticated
verification time, so it cannot prove when a 14-day post-verification interval starts. V chose indefinite
retention rather than adding an unratified receipt/format or using an unsafe filesystem-clock surrogate.
No archive or spool deletion path is enabled.

### 6.8 Exact live rollover transport slice

Implemented locally on 28 August 2026:

- the audio callback classifies the next IST midnight without calendar work on the callback and publishes
  timing boundaries, prior overflow, the pre-midnight prefix, one dedicated rollover fence and the
  post-midnight suffix as one capacity-checked SPSC transaction;
- a rejected transaction publishes none of those items and retains the same midnight target for the next
  accepted callback; boundary-equals-start and boundary-equals-end publish no empty audio item;
- the old resident writer finalizes its resampler and authenticated old-day tail before the fence, retains
  the fence for handoff and invokes replacement-consumer construction immediately after releasing ring
  ownership, independently of command polling or network progress;
- the replacement writer requires the new retained lane's initial sample to equal the old authenticated
  sample end, consumes the exact retained fence and continues with the already-buffered suffix without
  stopping the capture session;
- the primary owner creates or authenticates a fresh adjacent-day primary identity, rotates to a fresh
  adjacent `_control` identity, preserves ownership of commands begun on older control days, reserves the
  final old-day tail before deriving the new day and verifies every daily segment before end-day can patch
  the server session;
- synthetic tests cover interior and block-edge splits, atomic capacity failure, retained-fence consumer
  handoff, an active producer crossing into a second encrypted store, two-day control recovery and
  two-day final delivery with contiguous session-global samples and monotonic chunk indices.

The local gate passes 414 tests in 39 suites, 36 focused Thread Sanitizer tests in four suites, a release
build, strict Swift formatting and `git diff --check`. This is not rollover completion and does not make
the CLI factory selectable. The live path does not yet persist and resume the complete authenticated
`ArchiveRolloverPlan` through every crash point. A crash between old-day closure, final reservation,
new-day durability and control rotation must be reconstructed and resumed through the ratified
`ArchiveRolloverCoordinator` before this checkpoint can be promoted. Startup must also prove that
encoder-capable retained recovery is mandatory whenever resident archive capture is enabled.

## 7. Log rules from this reset

- Append future execution results here; do not create another current-status log.
- Label every result as accepted, implemented locally, contract/test seam or not started.
- Do not call a Build B subsystem production-complete until it is part of the same signed fixed
  candidate that passes the applicable acceptance matrix.
- Treat test counts as evidence, never as percentage completion.
- Record candidate-invalidating source or binary changes explicitly.
