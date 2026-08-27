# Room Recorder unsigned vertical-slice reset

**Date:** 27 August 2026

**Status:** governing current Room Recorder execution

**Decision owner:** V

**Committed checkpoint:** `7207fdc1abe90d126ab02856ccd2fde7252a0df0`

This reset changes the order of work. It does not discard the accepted recorder foundations or rewrite
their evidence. Where an older Room Recorder plan conflicts with this document, this document governs
until V explicitly closes or replaces the unsigned vertical-slice milestone.

## 1. Product outcome

The immediate job is to replace the working browser room kiosk with the smallest useful native process:

```text
browser closed
  -> the Home Office Mini captures its configured microphone
  -> produces the existing five-minute mono WebM/Opus pieces
  -> sends them through the existing Bench contracts
  -> sends the existing room controls and consult marks
  -> reports honest local status
```

Success is an end-to-end room, not another isolated mechanism. Existing server routes, room identity,
payloads, storage naming and brain behavior are reused rather than redesigned.

## 2. Current distribution decision

The development app remains unsigned and side-loaded on the Home Office Mini.

- Do not use the Ensocure, personal Apple Developer or any other signing identity.
- Do not request Keychain access, certificate approval, provisioning or notarization for this milestone.
- Do not create or query the canonical Secure Enclave tag.
- Keep the key-lifecycle implementation at `7207fdc` dormant and unintegrated. It may be revisited after
  the unsigned vertical slice works.
- The Data Protection Keychain/Secure Enclave path is not an unsigned-development blocker.
- Unsigned builds are development builds and use synthetic or otherwise explicitly non-clinical audio.
  They are not authorized to record patients until the local-data and release-security decision is made.

The 27 August Mini probe stopped safely. The unsigned executable returned `-34018` because it had no
application identifier or Keychain access-group entitlement. An ad-hoc copy with restricted
entitlements was rejected by AMFI. The installed Ensocure signing key was not unlocked or used. No
Secure Enclave key, canonical item, keywrap, tape or index was created by that probe.

## 3. Authorized vertical slice

Work in this order, preserving a runnable path after each step:

1. Reuse the accepted Phase 0 CoreAudio capture path for one configured primary microphone.
2. Cut continuous capture into the server's existing five-minute piece boundaries.
3. Produce the existing mono WebM/Opus derivative using the current server-compatible contract.
4. Keep a minimal disk-backed pending queue so an upload failure or process restart does not silently
   discard a completed piece.
5. Upload through the unchanged Bench APIs and reconcile retries idempotently.
6. Implement only the room actions needed to replace the browser: start, pause, resume, end and consult
   mark, using the existing command and cue contracts.
7. Show minimal honest state: ready, recording, paused, upload pending and failed/offline. Do not build
   the later polished screen.
8. Install the unsigned development build for login launch on the Home Office Mini and run one bounded
   end-to-end smoke with non-clinical audio.

Local unit tests remain useful, but integration takes priority. A new helper, format, abstraction or
test matrix is authorized only when the current vertical path needs it.

## 4. Exit gate

This milestone is complete only when one immutable candidate demonstrates all of the following on the
Home Office Mini:

- the browser room page is closed;
- the configured primary microphone records through the native process;
- start, pause, resume, end and consult mark have the same externally visible meaning as today;
- at least one real five-minute non-clinical WebM/Opus piece reaches the existing backend;
- the next piece begins at the intended boundary without an invented gap or overlap;
- a forced network failure leaves the completed piece pending, and connectivity restoration uploads it;
- process relaunch does not duplicate an acknowledged piece or silently lose a pending piece;
- local state names recording, paused, pending and failed/offline honestly;
- the process launches at login without opening the browser.

The first target is a working end-to-end room. A twelve-hour soak, destructive power test and production
rollout are not part of this exit gate.

## 5. Explicitly deferred

The following work must not interrupt the vertical slice unless V explicitly brings it back into scope:

- Secure Enclave provisioning, keywrap acceptance and wrong-device substitution;
- canonical encrypted day-tape integration;
- signing, notarization, App Store packaging, Developer ID and self-update;
- backup-microphone behavior beyond preserving existing interfaces;
- polished Phase 2 screen, setup experience and rollout UX;
- twelve-hour soak, power pull, USB-yank and other destructive acceptance protocols;
- new server endpoints, schema changes or brain behavior;
- Build C, Build D, Phase 4 and voice work;
- broad refactors, speculative abstractions and documentation for unauthorised later phases.

Accepted code may remain in the tree while deferred. Deferred does not mean rejected or deleted; it
means it cannot consume the current critical path.

## 6. Anti-drift rule

Before starting any work, ask:

> Is this required to make the unsigned Home Office Mini replace the browser and deliver the existing
> five-minute piece and controls end to end?

If the answer is no, record it as deferred and continue the vertical slice. Any scope expansion requires
V's explicit approval. Engineering agents must cite this document in handoffs and report progress by
which exit-gate bullet became true, not by test count or internal mechanism count.

## 7. Next action

Trace the existing browser's room authentication, command, cue, piece-encoding and upload contracts,
then connect the accepted native capture path to the smallest compatible end-to-end implementation.
Do not resume Secure Enclave or signing work.
