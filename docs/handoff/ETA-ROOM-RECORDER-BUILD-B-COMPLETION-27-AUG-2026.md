# Even Scribe - Room Recorder Build B Completion

**Date:** 27 August 2026
**Status:** governing current Room Recorder execution
**Authorized by:** V
**Committed predecessor:** `f316fbf`

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

Completed locally on 27 August 2026:

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
