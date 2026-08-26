# App Build B decision packet - 26 August 2026

**Status: RATIFIED by V on 26 August 2026. V1-V10 use the recommended option.**

Build 3 and App Build A Phase 0 are accepted. The gate on App Build B is open, but the build-plan
rule still applies: no kickoff is written while a fact it depends on is unknown. This packet names
only the product and acceptance choices that the existing PRDs do not settle. Internal Swift names,
queues, manifest encoding and test helper design remain builder choices.

Governing sources:

- `ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md`
- `ETA-APP-BUILD-A-PHASE-0-EXECUTION-HANDOFF-25-AUG-2026.md`
- `ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md`
- `ETA-BUILD-3-CORRECTIVE-REPORT-26-AUG-2026.md`
- `ETA-BUILD-PLAN-25-AUG-2026.md`

---

## Locked facts - do not reopen

1. Native Swift, never Electron, Tauri, WKWebView or another browser wrapper.
2. The current server endpoints, request fields and five-minute WebM/Opus contract do not change.
3. Durable PCM is the system of record. Sample count is its clock. Gaps are index facts; audio is
   never zero-filled or invented.
4. Microphone health means durable sample-index growth, never merely a running process, an
   enumerated device, a resolved UID or a level reading.
5. Stable CoreAudio UID is identity. A numeric device id is temporary. Failed enumeration is
   unknown, never proof that the device is absent.
6. One microphone is a normal room. Without an explicitly selected second UID there is no backup
   capture, tape, piece, level, vital or alarm.
7. D39 stands: tape opens its own room-day. No mark or key stroke gates processability.
8. Build B's hard-kill loss target is at most 2.000 seconds. Phase 0's 2.5-second verifier threshold
   is not the production acceptance threshold.
9. The Phase 0 eight-hour substitute does not define Build B's full-day duration.
10. The P1 test group for each Phase 0 mechanism passes before that mechanism enters production
    Build B code.
11. No paid STT, diarization or LLM call is part of Build B acceptance. The twelve remaining
    Cardiology windows stay untouched.

---

## V1 - Brain-feed substrate in Build B

**Question.** Phase 1's short module list omits the brain feed, while PRD R20 says the sidecar and
brain-facing surface ship in version 1 before voice work.

**Recommendation: include the substrate in Build B.** Build the sample-indexed `<lane>.lvl`
level/voice-activity sidecar, the five existing microphone events, pause state and once-per-minute
`live_sink_stats`. Mark remains a Phase 2 control; short voice segments remain Phase 4.

**Alternative.** Build only the sidecar now and defer all server-facing brain traffic.

**Acceptance consequence.** The chosen Build B scope must prove sidecar alignment and crash
recovery. Under the recommendation it must also prove event delivery and stats cadence, with every
brain/network failure isolated from tape.

**V decision:** `[x] recommended` `[ ] alternative`

---

## V2 - Signing, TCC identity and launchd

**Question.** PRD R7/R10 require stable signing and LaunchAgent supervision, but the build plan puts
certificate and rollout work in Build D. Build B nevertheless requires the day to continue after
`kill -9`; Phase 0 proved only manual restart.

**Recommendation: use the final in-house signing identity and LaunchAgent in Build B.** Sign both
the app bundle and bundled encoder with that identity. Include `RunAtLoad`, `KeepAlive` and the
recording power assertion. Leave updater, rollback and clinic rollout to Build D.

**Alternatives.** Temporary signing plus launchd, or manual launch with supervision deferred. The
manual option cannot satisfy automatic same-day continuation and does not prove product TCC.

**Acceptance consequence.** Under the recommendation, `kill -9` must relaunch automatically onto
the same tape and session, and microphone permission must survive a same-identity replacement build.

**V decision:** `[x] recommended` `[ ] temporary signing + launchd` `[ ] defer supervision`

---

## V3 - Encrypted range-readable tape

**Question.** PRD R13 requires 14-day encrypted local tape with its key held in Mac secure hardware,
but does not select the file design.

**Recommendation: independently authenticated encrypted blocks.** Use a per-day/per-lane symmetric
data key wrapped by device-bound secure hardware. Each block is independently recoverable and
range-readable, so the cutter can read a growing tape and a crash cannot invalidate the whole day.

**Alternatives.** FileVault alone, or encrypting only after the day closes. Neither creates the
required app-owned at-rest boundary while recording.

**Acceptance consequence.** Add range-read, wrong-key, tamper, torn-final-block and power-loss
tests. Retention must never remove a day while any derived piece remains unverified.

**V decision:** `[x] recommended` `[ ] FileVault only` `[ ] encrypt after close`

---

## V4 - Bundled ffmpeg

**Question.** R7 requires vendored, signed ffmpeg but does not name the artifact, license posture or
encoding recipe.

**Recommendation: a pinned minimal arm64 LGPL-compatible build** containing only the required
WebM/Opus path, subject to confirming its build flags and distribution obligations. Record source,
version, configuration, license, SHA-256 and signing identity. Freeze one exact command after a wire
smoke against production.

**Alternatives.** A standard full ffmpeg build, or a new in-house container/codec implementation.

**Acceptance consequence.** Kill the encoder child mid-piece, prove tape is untouched, retry the
same sample range, validate independent playback, and verify production accepts every piece.

**V decision:** `[x] recommended` `[ ] full ffmpeg` `[ ] in-house encoder`

---

## V5 - Headless provisioning and control

**Question.** Build B has no Phase 2 setup screen, but it needs the server origin, room slug, PIN and
explicit stable microphone UID selection.

**Recommendation: a provisioning CLI.** Provide `configure`, `login`, `start`, `stop` and `status`.
Store non-secret origin/slug/UID configuration in an app-owned file and credentials in protected
credential storage. No spare exists unless configuration explicitly names a second UID.

**Alternatives.** A temporary native setup window, or Home Office values hard-coded for Phase 1.

**Acceptance consequence.** Test fresh provisioning, invalid/locked PIN, expired credentials,
missing main UID, explicit no-spare configuration and secret-free logs.

**V decision:** `[x] recommended` `[ ] temporary setup window` `[ ] Home Office hard-code`

---

## V6 - Crash reconciliation of local and server indices

**Question.** Server `next_idx` knows verified rows only; local tape may also hold reserved, encoded,
uploaded or not-yet-registered pieces after a crash.

**Recommendation: reconcile both witnesses.** The fsynced local journal is authoritative for sample
ranges. The server is authoritative for whether `(session, lane, idx)` is verified. Allocate above
the maximum locally committed/reserved and server-reported index, then reconcile each older local
piece through `already_verified`, object HEAD and row registration.

**Alternatives.** Trust server `next_idx` alone, or trust the local journal alone. Either can omit or
overwrite evidence after a crash at the opposite side of the wire.

**Acceptance consequence.** Crash at reservation, journal fsync, encoding, PUT, HEAD and row-write
boundaries. Every sample range must land exactly once with no index reuse.

**V decision:** `[x] recommended` `[ ] server authoritative` `[ ] local authoritative`

---

## V7 - Browser/native ownership

**Question.** The command bus is last-poll-wins. The browser and native recorder cannot safely act as
ordinary simultaneous room clients.

**Recommendation: native owns the room normally, with explicit maintenance handoff.** Maintenance
mode durably flushes and stops native capture without ending the server session, permits temporary
browser ownership, then requires controlled native reclaim.

**Alternatives.** Forbid the browser entirely after install, or support unrestricted bidirectional
takeover.

**Acceptance consequence.** Prove normal browser exclusion, maintenance handoff without duplicate
indices or `PATCH end`, and controlled same-session reclaim.

**V decision:** `[x] recommended` `[ ] browser forbidden` `[ ] unrestricted coexistence`

---

## V8 - IST midnight

**Question.** D39 keys room-days from a piece's own IST date, but the local cut boundary is not set.

**Recommendation: cut exactly at IST midnight.** Close the current piece and local day files at one
sample boundary, open the next day's files, and continue the same server session and monotonically
increasing piece indices.

**Alternatives.** Let a piece cross midnight and assign it by start time, or end/recreate the server
session at midnight.

**Acceptance consequence.** A synthetic midnight test must show one shared sample boundary, no gap
or overlap, continuous session indices and a second room-day from the first post-midnight piece.

**V decision:** `[x] recommended` `[ ] crossing piece` `[ ] new session at midnight`

---

## V9 - Meaning of a full Home Office day

**Question.** Build B requires a full day, and V's one-candidate Phase 0 eight-hour waiver does not
carry forward.

**Recommendation: twelve uninterrupted hours**, plus separate destructive protocols. This is
repeatable, exceeds the waived run materially and covers 144 five-minute rotations.

**Alternatives.** Twenty-four uninterrupted hours, or an ordinary variable-length workday with a
ratified minimum.

**Acceptance consequence.** This sets the minimum sample count, piece count, disk forecast and
opening/middle/closing listening points.

**V decision:** `[x] 12 hours` `[ ] 24 hours` `[ ] ordinary day; minimum: ______`

---

## V10 - Idle readiness and start acknowledgement

**Question.** The operator calls an idle listening client `Ready`, while the recorder may claim
microphone health only from durable tape growth.

**Recommendation: keep those meanings separate.** Idle `Ready` means command reachability only and
makes no microphone claim. On `start_day`, acknowledge success only after the first durable
checkpoint advances; the accepted two five-second acquisition retries and physical USB fallback
govern failure.

**Alternatives.** Record hidden probe audio while idle, or report every idle room unavailable.

**Acceptance consequence.** Test an idle reachable room with unknown mic health, successful start
within the command timeout, and loud refusal when durable growth never begins.

**V decision:** `[x] recommended` `[ ] hidden probe` `[ ] idle unavailable`

---

## Builder-owned implementation choices

The kickoff may delegate these while preserving the decisions above:

- Internal Swift target names, actors, queues and file decomposition.
- Persistent cookie/Keychain mechanics, provided the 30-day room JWT survives relaunch and no
  credential enters logs, tape, manifests or R2.
- A versioned manifest serialization carrying every sample/time/uncertainty fact.
- Sidecar binary layout and voice-activity calculation, within R20's sample-indexed requirement.
- Clock-fit implementation, provided jumps segment the fit and stale anchors fail closed to
  `uncertain`.
- Retry jitter and temporary names within oldest-first 5-to-60-second retry behavior.
- Test fixtures, local mock server and whether WAV export remains an evidence-only utility.

---

## Closure before Build B code

1. V marked V1-V10 above on 26 August 2026. Complete.
2. V separately authorized the accepted Build 3 source checkpoint. It is
   `0f724319ec6cef3c149b25e6601f45871ea0c1f6`; no unrelated scripts, credentials or local OpenCode
   configuration entered it. Complete.
3. `ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md` pins that commit, production deployment
   `dpl_497Ns1qzVnTvZ7N7YgTt61UgMUX2`, Phase 0 candidate `3d4139e`, and all decisions above. Complete.
4. V read and accepted that kickoff on 26 August 2026. Complete; Build B implementation is
   authorized.
