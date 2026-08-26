# App Build B - Phase 1: the headless Room Recorder engine

**Kickoff for Claude Code. Paste this whole file.**

**Status: ACCEPTED by V on 26 August 2026. Build B implementation is authorized.**

All product decisions are settled. The Room Recorder PRD is final, App Build A Phase 0 and Build 3
are accepted, V1-V10 use the recommended option, and the accepted Build 3 source checkpoint exists.
If implementation uncovers a fact these documents do not cover, stop and report it instead of
silently changing the architecture, the wire contract, the archive semantics or an acceptance gate.

---

## 0. Exact starting point

| Role | Exact identity |
|---|---|
| Build B source base and accepted Build 3 checkpoint | `0f724319ec6cef3c149b25e6601f45871ea0c1f6` |
| Accepted immutable production deployment | `dpl_497Ns1qzVnTvZ7N7YgTt61UgMUX2` |
| Production URL | `https://even-transcription-assistant-n9xigbpoj.vercel.app` |
| Production alias | `https://www.evenscribe.app` |
| Accepted Phase 0 candidate | `3d4139e1d6a630814d88a932676a62b37172584a` |
| Phase 0 release-binary SHA-256 | `d26e776172266e41809d5a280e04bca929f1325014a57b27a18d15fd60797cc7` |
| Branch | `feat/room-recorder` |

The production deployment predates the corrective source checkpoint. Its health endpoint can
therefore report `3d4139e` while the immutable deployment identity above remains the accepted Build 3
deployment. Cache-bust health checks and report both facts; do not mistake the older health SHA for a
different deployment.

Start from the exact checkpoint above. Keep the current unrelated Phase 0, planning and Mini-script
work out of Build B source commits. Never stage PCM, WAV, PINs, room tokens, credentials, local
OpenCode configuration or unrelated Operator MCP work.

---

## 1. Read these first

| File | Why |
|---|---|
| `docs/handoff/ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md` | Binding R1-R22, current server contract, engine stages and Phase 1 acceptance. |
| `docs/handoff/ETA-APP-BUILD-B-DECISION-PACKET-26-AUG-2026.md` | Ratified V1-V10. Every recommended option is binding. |
| `docs/handoff/ETA-APP-BUILD-A-PHASE-0-EXECUTION-HANDOFF-25-AUG-2026.md` | Accepted real-Mini evidence, measured limits, hardware behavior and operational rules. |
| `docs/handoff/ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md` | Authoritative P1 reuse gates, test procedures and retained P2 debt. |
| `docs/handoff/ETA-BUILD-3-CORRECTIVE-REPORT-26-AUG-2026.md` | Accepted D39, one-microphone and strict-level production truth. |
| `docs/handoff/ETA-BUILD-PLAN-25-AUG-2026.md` | Build boundary and sequence. |
| `apps/room-recorder/README.md` | Current isolated Swift package boundary and Phase 0 commands. |
| `lib/bench-bus-constants.ts` | Normative command timing and freshness constants. |
| `lib/bench-dual.ts` | Five locked microphone events and primary/backup wire naming. |
| `lib/bench-levels.ts` | Strict level-pair semantics now enforced by production. |

The test plan's detailed procedures remain authoritative. This kickoff does not weaken a pass
condition by summarising it.

---

## 2. What this build is

Build B is the signed, supervised, headless native engine on Home Office. It turns the accepted
Phase 0 durability findings into the production pipeline:

```text
native capture
  -> authenticated encrypted day tape + fsynced index
  -> durable-range cutter + local journal
  -> bundled ffmpeg WebM/Opus derivative
  -> disk-backed upload sweeper
  -> existing production Bench APIs
```

It also includes the headless control plane needed to operate that engine: provisioning CLI,
Keychain auth, command poller, explicit browser/native maintenance handoff, LaunchAgent supervision,
recording power assertion and the Build B brain-feed substrate.

The direction of trust is one-way. The tape is authoritative. Every sidecar, piece, upload, event,
server row and live statistic is derived and disposable. A downstream failure may delay evidence; it
must never block, mutate or erase captured tape.

---

## 3. Locked decisions - do not reopen

1. Swift native code only. No Electron, Tauri, WKWebView or browser engine.
2. The server endpoints, request fields, content type, R2 naming and five-minute mono WebM/Opus
   contract remain unchanged.
3. Durable PCM/sample position is the system of record and primary clock. Gaps are facts; never
   zero-fill or invent audio.
4. Microphone health means durable sample-index growth. Process liveness, device enumeration, UID
   resolution and level readings do not prove health.
5. Stable CoreAudio UID is identity; numeric device IDs are temporary. Failed enumeration is
   unknown, never proof of absence.
6. One microphone is a normal room. No explicit second UID means no spare capture, tape, sidecar,
   piece, level, vital or alarm.
7. D39 stands. Tape opens its own room-day; no mark or key stroke gates processability.
8. Build B's hard-kill and power-loss limit is at most `2.000` seconds. Phase 0's `2.5`-second
   verifier boundary remains a compatibility test, not the product acceptance limit.
9. The full-day acceptance run is twelve uninterrupted hours. Phase 0's eight-hour waiver creates
   no precedent.
10. Each Phase 0 mechanism's complete P1 test group passes before that mechanism enters Build B
    production code.
11. Build B includes the sample-indexed level/VAD sidecar, five microphone events, pause state and
    once-per-minute `live_sink_stats`. Mark remains a Phase 2 control; short voice segments remain
    Phase 4.
12. Use the final in-house signing identity now. Sign the app and encoder; supervise with a
    LaunchAgent using `RunAtLoad` and `KeepAlive`; hold a power assertion while recording.
13. The local tape uses independently authenticated encrypted blocks and a per-day/per-lane data key
    wrapped by device-bound secure hardware. It remains range-readable while growing.
14. Bundle a pinned minimal arm64 LGPL-compatible ffmpeg build for only the required path. Record
    source, version, build flags, licence obligations, SHA-256, signing identity and exact command.
15. Provision through a CLI. Keep origin, room slug and explicit UIDs in app-owned non-secret
    configuration; keep credentials in protected credential storage.
16. Reconcile both witnesses after a crash: the local fsynced journal owns sample ranges and the
    server owns verified `(session, lane, idx)` state.
17. Native owns the room normally. Browser use requires an explicit maintenance handoff and
    controlled same-session reclaim.
18. Cut exactly at IST midnight at one sample boundary. Continue the same server session and
    monotonically increasing piece indices.
19. Idle `Ready` means command reachability only. A successful `start_day` ack is sent only after the
    first durable checkpoint advances.
20. No paid STT, diarization or LLM call belongs to this build. The twelve remaining Cardiology
    windows and historical Home Office waiting audio stay untouched.

Internal Swift target names, actors, queues, manifest encoding, authenticated-block algorithm and
size, sidecar binary layout, retry jitter and test-helper design are builder-owned choices. Use
platform-standard reviewed cryptography and document those choices before integrating them. They may
not weaken any locked property above.

---

## 4. Phase 0 facts carried forward

Phase 0 proves feasibility for one exact candidate. It does not waive Build B tests or let a changed
mechanism inherit physical evidence.

| Fact | Accepted result |
|---|---|
| H-01 hard-kill tail | `1.114562 s` |
| H-02 wall-power tail | `1.300312 s` |
| H-04 loaded checkpoint gap | `1.486085 s` maximum |
| H-04 duration | `28,824.695125 s` |
| H-04 capture blocks | `155,172` accepted, `0` dropped |
| H-04 recorder CPU | `0.277%` average, `0.400%` p95, `0.500%` max |
| H-04 RSS | `18,768 / 14,736 / 18,784 KiB` start/end/max |
| Production input | TONOR TM20, stable UID recorded in the execution handoff, 44.1 kHz at acceptance |

The accepted capture schedule was approximately 1.25 seconds. If Build B changes that cadence,
repeat loaded and destructive evidence against the `2.000`-second product limit. A clean stop never
erases historical crash-tail evidence; the worst historical tail remains controlling.

Cold boot is not presumed reliable. Permit two five-second acquisition retries. If durable growth
still does not begin, require the accepted physical fallback: unplug TONOR for at least five seconds,
then reconnect. Do not report microphone health before durable growth.

---

## 5. P1 gate before reuse

Do not first move a Phase 0 mechanism into a production target and promise to harden it later. Add or
complete its tests against the isolated mechanism, make its whole group pass, then integrate it. The
authoritative procedures and pass conditions are in the Phase 0 test plan.

| Mechanism | Required P1 exit |
|---|---|
| Cold boot/readiness | Durable growth governs readiness; exercise two retries and the five-second USB fallback. |
| SPSC ring and marker handoff | `RING-01` through `RING-06` pass, including wrap, overflow, ordering, producer handoff and TSAN. |
| AVAudioTime/discontinuities | `CAP-04` through `CAP-07` pass, including dropout, invalid timestamp, reset/overlap and wall jump. |
| Sample-rate conversion | `SRC-01` through `SRC-04` pass with a documented bounded accounting difference. |
| Durable writer | `DUR-02` through `DUR-05` and `DUR-08`/`DUR-09` pass with honest parseable recovery. |
| Index and verifier | `IDX-02` through `IDX-08` and `VER-02` through `VER-08` pass. |
| WAV evidence export | `WAV-02` through `WAV-05` pass. |

The Phase 0 P2 register also remains visible:

- `CLI-06`: invalid-argument behavior is deterministic and non-mutating. V5 makes equivalent
  provisioning validation mandatory in this product CLI.
- `PERF-06`: test sleep/wake or prove production provisioning prevents sleep.
- Bare Command Line Tools `swift test` runtime wiring remains documented until full Xcode or an
  Apple toolchain correction removes the workaround.
- Swift 6.4 nonexistent search-path warnings remain named if the active toolchain still emits them.

Also run every applicable acceptance-gate test in test-plan sections 5.2-5.10. In particular retain
`CAP-08`, `RING-07`, `SRC-05/06`, `DUR-01/06/10`, `IDX-01`, `VER-01/09`, `WAV-01/06/07` and
`PERF-01` through `PERF-05`. Build B's stricter `2.000`-second limit supersedes only the production
verdict, not `VER-02`'s test of the inherited 2.5-second Phase 0 parser boundary.

---

## 6. What to build

### 6.1 Capture and encrypted archive

- One independent capture lane for each explicitly configured stable UID.
- Convert native input to logical 16 kHz mono signed Int16 samples.
- The callback performs no allocation, lock, logging, file I/O, network or encoding work.
- Append true samples into independently authenticated encrypted blocks. Make prior committed blocks
  recoverable if the final block or process is torn.
- Fsync tape and index in an order that never lets committed index state exceed durable audio.
- Write versioned sample/time anchors and explicit restart, device, clock, format, invalid-timestamp,
  capture-discontinuity and overflow facts.
- Retain local tape for 14 days after verified upload. Never delete a day while any derived piece is
  unverified.

### 6.2 Clock, cutter and journal

- Sample position is the primary clock. Wall time comes from fsynced sample/monotonic/wall anchors
  and a fitted drift per continuous segment.
- A stale or insufficient fit is locally `uncertain`, never confidently guessed.
- Wake the cutter approximately every ten seconds and read only durable sample ranges.
- Normal pieces are five minutes. Close short at restart, device loss, clock jump, format change,
  pause and IST midnight.
- Continuous piece N and N+1 share one sample boundary and therefore one timestamp boundary.
- Persist every range reservation before derivative work: room, session, lane, day, idx, sample
  range, timestamps, uncertainty, levels and state.
- The sample-indexed `<lane>.lvl` sidecar derives level and voice activity from the same samples and
  clock as the tape. Prove alignment, restart and torn-tail recovery.

### 6.3 Encoder

- Vendor and sign the ratified minimal arm64 ffmpeg artifact.
- The child reads one immutable logical sample range and writes one temporary WebM/Opus derivative.
- It never opens the growing tape for mutation.
- Freeze the exact command only after independent playback and a production wire smoke.
- A killed encoder leaves tape and journal untouched and retries the identical sample range.

### 6.4 Sweeper and reconciliation

- Scan disk oldest first: presign, PUT, HEAD byte verification, chunk-row registration, done.
- Retry forever from disk with 5-to-60-second backoff. Network loss cannot lose queue state.
- Preserve server idempotence on `(session, lane, idx)`.
- Allocate new indices above the maximum locally reserved/committed and server-reported index.
- On recovery, reconcile older local work through `already_verified`, object HEAD and missing-row
  registration. Crash at reservation, journal fsync, encode, PUT, HEAD or row write must not reuse an
  index, omit a range or upload one range twice under different identities.

### 6.5 Provisioning, authentication and headless control

- Provide `configure`, `login`, `start`, `stop` and `status` CLI operations.
- Test fresh configuration, invalid/locked PIN, expired credential, missing main UID and explicit
  no-spare configuration. Keep logs secret-free.
- Hold the 30-day room credential in Keychain/protected credential storage.
- Give maintenance handoff and reclaim a headless CLI path. Naming is builder-owned, but the actions
  must durably flush and stop native capture without ending the server session, permit temporary
  browser ownership, then reclaim the same session without duplicate indices.

### 6.6 Poller and brain substrate

- Use `tab_id` in the form `app_<machine>`.
- Preserve polling cadence: 1.5 seconds recording, 3 seconds idle and 5 seconds hidden; listener
  freshness remains 10 seconds, command expiry 15 seconds and the operator ack wait 8 seconds.
- Handle existing start, pause, resume and end commands and ack each through the existing route.
- Start ack waits for first durable checkpoint growth. The ordinary healthy-path start must complete
  inside the existing 8-second operator wait; never ack optimistically to make that deadline. A
  slower acquisition remains pending only within the existing 15-second command lifetime and must
  fail by name if durable growth never begins. Pause is a true capture gap and a brain signal.
  Resume starts a clean segment. End stops capture first, closes the final range, gets that final
  piece verified, ends the server session and only then acks, preserving the current `end_day`
  contract. If derivative/network work fails, keep the tape and fail the command by name rather than
  claiming the day ended cleanly.
- Post the five locked events: `mic_primary_lost`, `mic_primary_restored`,
  `mic_backup_unavailable`, `mic_backup_error`, `mic_backup_restored`.
- Post `live_sink_stats` once per minute and carry pause state. Brain/event/network failure is
  isolated from tape.
- Emit level pairs atomically. Preserve genuine `0/0`; omit absent, partial, non-finite,
  out-of-range or impossible `avg > peak` measurements.

### 6.7 Signing, launchd and process identity

- Create or select the one final in-house signing identity, record its fingerprint and trust it on
  Home Office once.
- Sign the app bundle and bundled encoder with that identity.
- Install a LaunchAgent with `RunAtLoad` and `KeepAlive` and hold a recording power assertion.
- Prove `kill -9` automatically relaunches into the same tape and server session.
- Replace the bundle with another build signed by the same identity and prove microphone permission
  survives.

### 6.8 IST midnight

- At exactly IST midnight, close the old piece and encrypted day files and open the new day's files
  at one shared sample integer.
- Continue the same server session and monotonically increasing lane indices.
- The first verified post-midnight piece creates/finds the new room-day through D39.
- Test this synthetically. Run the twelve-hour acceptance wholly within one IST date so midnight and
  full-day evidence stay separate.

---

## 7. Exact server contract

Use only the PRD's existing routes:

1. PIN login at `POST /room/{slug}/api/login`.
2. Session open at `POST /api/bench/sessions`; pause, resume and end through the existing session
   `PATCH` route.
3. Presign at `POST /api/bench/upload-url`, then presigned `PUT`, then `HEAD` byte check.
4. Verify/register at `POST /api/bench/chunks` with existing fields only: `idx`, `content_type`,
   `started_at`, `ended_at`, `duration_ms`, `size_bytes`, `gap_before_ms`, atomic level fields, and
   `source:"backup"` only for an explicit spare lane.
5. Post the five existing microphone event kinds through `POST /api/bench/events`.
6. Poll `GET /api/bench/commands`; ack through `POST .../{id}/ack`.
7. Use `POST /api/bench/brain-proxy` only for existing allowed Build B traffic.

Do not add a field, endpoint, migration, alternate content type, new R2 naming rule or new server auth
path. If the native path cannot make an object the accepted server already verifies, the native path
is wrong.

---

## 8. Build order

1. **Provenance and design records.** Fix the candidate boundary; record crypto/block, manifest,
   sidecar, ffmpeg and signing choices without changing locked behavior.
2. **P1 hardening.** Complete each isolated Phase 0 test group before reusing that mechanism.
3. **Encrypted archive.** Integrate capture, conversion, authenticated tape and durable index with
   no network.
4. **Local derivation.** Add cutter, range journal, sidecar, discontinuity cuts and midnight cut.
5. **Encoder.** Pin, document and sign ffmpeg; prove deterministic range retry and playback.
6. **Mock wire.** Build sweeper/reconciliation against a local mock and run every crash boundary.
7. **Control plane.** Add provisioning, Keychain auth, poller, brain substrate and one-mic truth.
8. **Product identity.** Bundle, sign, install LaunchAgent, assert power and prove TCC continuity.
9. **Home Office destructive tests.** Hard kill, encoder kill, network/brain outage, microphone yank,
   wall-power pull, cold boot, maintenance handoff and synthetic midnight.
10. **Production smoke.** One short Home Office primary-only session against the pinned deployment.
    Verify one piece, D39 day and zero marks. No paid processing.
11. **Twelve-hour acceptance.** Only after all earlier gates pass, run one fixed candidate for twelve
    uninterrupted hours within one IST date.
12. **Report.** Freeze source and binary hashes and present every gate before any rollout decision.

Keep commits narrow enough that a failed gate can be located without rewriting evidence. A source
change after a candidate is fixed invalidates that candidate's later physical evidence.

---

## 9. Do not touch

- No server behavior, schema, migration, operator-page or clinician-facing change.
- No Phase 2 lamp, room-screen controls, setup overlay, PIN-gated quit or counsel Pause copy.
- No ordinary Mark control. Build B carries pause state and the feed substrate only.
- No updater, download/swap, rollback, clinic install runbook or clinic rollout. Those remain Build D.
- No Phase 4 short-segment intake, diarization, voice signatures, database matching or consult-state
  machine.
- No hidden probe recording while idle.
- No external local range-read service, mark-aligned recuts, server-uploaded anchor log or nightly
  tape/server reconciliation. Internal range reads needed by the cutter are in scope.
- No clinic-room test. Home Office is the only live Build B room.
- No new alarm before it stays silent through an ordinary day.
- Do not modify Voice Control, Accessibility or Dictation settings and do not synthesize input.
- Do not run the twelve Cardiology windows, Home Office historical waiting audio or any paid model.

The parallel voice pre-flight is separate work and gates Phase 4 only.

---

## 10. Safety and stop rules

Before every Home Office live protocol:

- Confirm production says the room is not already recording and identify its active listener.
- Confirm the browser kiosk is not competing for ordinary room ownership.
- Confirm Voice Control is off by read-only inspection.
- Record source SHA, signed app hash, encoder hash, certificate fingerprint, macOS/Swift versions,
  stable microphone UID and exact test directory.
- Use a unique immutable evidence directory. Never reuse one after a failed or changed candidate.

Stop immediately and preserve evidence if any test shows:

- lost committed tape or a result above `2.000` seconds;
- invented/zero-filled audio;
- an index beyond durable tape, reused index or omitted/duplicated sample range;
- false microphone health without durable growth;
- spare artifacts in an explicit one-microphone configuration;
- a network, encoder, brain or UI failure blocking capture;
- a server-contract change appearing necessary;
- a product choice not settled by the governing documents.

Never reboot, power-cycle, log out or update the Home Office Mini outside the named protocol and V's
physical coordination. FileVault is enabled; an unattended reboot can strand the machine before
login.

---

## 11. Acceptance matrix

All physical evidence comes from one fixed Build B candidate and exact signed binaries.

| Gate | Required proof |
|---|---|
| Automated P1 | Every group in section 5 passes before reuse; applicable acceptance tests and retained P2 status reported. |
| Encryption | Growing range read, wrong-key rejection, tamper rejection, torn-final-block recovery and power-loss recovery. |
| Hard kill | `kill -9`; automatic LaunchAgent relaunch; same tape/session; worst loss at most `2.000 s`; no invented samples. |
| Wall power | First verification before resumed capture; committed encrypted tape/index recover; same day/session continues; loss at most `2.000 s`. |
| Encoder kill | Tape untouched; identical sample range retried; independently playable and server-accepted object. |
| Crash matrix | Reservation, journal fsync, encode, PUT, HEAD and row-write crashes yield exactly one identity per range and no index reuse. |
| Disk/write faults | Full disk, permission, append and sync failures are loud; committed archive remains parseable; no false health. |
| Network/brain faults | Capture continues; retries stay on disk; event/stats/brain failures cannot damage tape. |
| Device yank | At least five minutes before and after an approximately 60-second TONOR yank; honest loss/resume facts and measured gap; no zero fill. |
| Output route | Output change/removal does not become a microphone-loss event while input remains healthy. |
| Cold boot | Two retries and durable-growth readiness; exercise/report physical replug fallback if required. |
| TCC/signing | Same final identity signs app/encoder; replacement build preserves microphone permission. |
| Maintenance | Browser excluded normally; handoff does not end session; controlled reclaim has no duplicate index or tape loss. |
| Midnight | One shared sample boundary; no gap/overlap; same session; monotonic indices; second D39 room-day. |
| Provisioning | Fresh configure/login/start/status/stop; invalid/locked PIN; expired credential; missing main UID; explicit no-spare; secret-free logs. |
| Idle/start | Idle reachable with unknown mic health; start ack follows first durable checkpoint; no-growth start fails loudly within command semantics. |
| Brain substrate | Sidecar alignment/recovery, five events, pause state and one-minute stats; archive survives forced brain failure. |
| One microphone | Home Office produces no backup file, object, row, level, vital or alarm. |
| Twelve hours | At least `691,200,000` logical output samples and `144` nominal five-minute rotations unless a named true boundary closes a piece short. |
| Production | Every produced piece accepted and verified by the pinned deployment; continuous seams are exactly zero; true gaps only. |
| D39 | Room-day exists with zero marks; report session/day IDs and whether start ack or first verified piece opened it. |
| Listening | Opening, middle, closing and every destructive boundary are intelligible with no corruption, repetition, buzz, fabricated silence or stale pre-resume audio. |
| Resources | CPU average/p95/max, RSS start/end/max, archive/index/sidecar/spool growth, checkpoint gaps, converter bound and drop counts retained. |
| No paid work | No STT, diarization or LLM call; twelve Cardiology windows remain untouched. |

---

## 12. Gate before report

1. Swift formatting/lint passes.
2. Debug and release builds pass on the development Mac and Home Office Mini.
3. Full Swift test suite, P1 groups, TSAN and fault-injection suites pass.
4. App and encoder signatures, hashes and ffmpeg provenance verify.
5. No secret, raw clinical audio or protected key material exists in Git or logs.
6. Every destructive and physical protocol in section 11 passes on one fixed candidate.
7. The production smoke passes before the twelve-hour run.
8. The twelve-hour run and human listening checks pass.
9. Existing repository TypeScript tests, typecheck and build pass if any shared docs/package changes
   make those checks relevant. No server source change is expected.
10. `git diff --check` passes and the final diff contains only intended Build B and synchronized
    handoff work.

Do not push, deploy, install in a clinic room or start Build C as an implied next step. Report first.

---

## 13. Report back with

- Exact source SHA, clean-worktree proof and every signed binary SHA-256.
- App and ffmpeg signing identities; ffmpeg source/version/build flags/licence record and command.
- Crypto/block, manifest/journal and sidecar format decisions and their recovery evidence.
- Every P1 and applicable acceptance-test result by ID; every remaining P2 item.
- Verbatim verifier output for hard kill and power pull, including current and worst historical tail.
- Every deliberate and unexpected discontinuity, with sample positions, clocks and interpretation.
- Reservation/encode/upload reconciliation matrix and proof of no range or index reuse.
- Session, room-day, piece and object identities from the production smoke and twelve-hour run.
- Piece counts, continuous seams, true gaps, uncertain timestamps, D39 origin and zero-mark count.
- One-microphone proof from local disk, server rows, listener/card and operator door.
- Sidecar alignment, event delivery, pause and minute-stat evidence, including forced failure isolation.
- Maintenance handoff, midnight, LaunchAgent, power assertion and same-identity TCC evidence.
- CPU, memory, disk, checkpoint, converter and dropped-block measurements.
- Exact listened ranges and V's observations.
- Confirmation that no paid call ran, no Cardiology recovery window ran and nothing in section 9 was
  touched.
- Every anomaly or premise contradiction, named rather than silently worked around.

V read and accepted this kickoff on 26 August 2026. Build B starts from the exact checkpoint in
section 0 and follows the ordered gates above.
