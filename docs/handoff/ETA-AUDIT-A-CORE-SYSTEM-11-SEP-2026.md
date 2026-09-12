# ETA / Scribe — Core System Audit (A: Core System)

Read-only research pass over `$HOME/mnt/MiniDev/Even-Transcription-Assistant`, HEAD `5dff406`
(branch `vinay/release-b1`), 2026-09-11. All facts below are cited `path:line`; anything not
directly read in code is marked UNVERIFIED. Note quality is out of scope (another researcher owns
it) — this pass targets (1) remote operability, (2) operator visibility (plumbing vs content).

Mid-audit note: `device_bash` on the user's Mac hung/wedged partway through this session (all
`cat`/`grep`/`wc` calls started erroring). The remainder of the pass was done via
`device_list_dir` + `device_stage_files` (still working), which is why later citations came from
staged copies rather than live shell greps — content is identical, just a different read path.

## Facts

### 1. Shape (docs/ARCHITECTURE.md, docs/README.md)
- Single Next.js 15.5 App Router project on Vercel (`bom1`) + Neon Postgres (HTTP driver) + R2
  (audio) + Resend (email) + a private Mac‑Mini backend (Ollama/Whisper/pyannote/Sarvam relay)
  reached only over Cloudflare tunnels. `docs/ARCHITECTURE.md:1-15`.
- Room Recorder (Swift, native macOS) is a separate, isolated app under `apps/room-recorder/`;
  version `0.1.16` at `apps/room-recorder/Packaging/VERSION`. Confirmed: current HEAD is
  `5dff406 room-recorder: 0.1.16 — B1 ledger-hold proof (two canary failures)` on
  `vinay/release-b1`.
- `apps/room-recorder/Sources` has ~65 Swift files across `RoomRecorderCore` (engine/config/
  self-update/keychain — 10,525 lines), `TapeCore` (archive/crypto/spool — the encrypted
  resident-archive subsystem), `tapewriter` (capture/ring/resampler), and two CLI targets
  (`RoomRecorderCLI`, `TapewriterCLI`).
- `apps/room-recorder/README.md:1-40`: unsigned browser-replacement path accepted; Secure Enclave
  signing, canonical encrypted archive wiring "remain parked"; archive key-lifecycle slice
  "implemented for review but is not accepted" — no permanent key created by this work.
- `apps/room-recorder/AGENTS.md:1-13`: governing doc is
  `ETA-ROOM-RECORDER-BUILD-B-COMPLETION-27-AUG-2026.md`; "Session-global samples cross midnight;
  each lane receives a fresh root and stream UUID per IST day."

### 2. Command/listener channel — PULL model, not push
- The server never talks to a kiosk directly. `RoomEngine.run()` polls
  `GET /api/bench/commands` every **1.5 s** while ready/recording (`RoomEngine.swift:1045`
  `Task.sleep(nanoseconds: 1_500_000_000)`), with exponential backoff to 30 s on error
  (`RoomEngine.swift:1068`, `min(backoffNanoseconds * 2, 30_000_000_000)`).
- Command vocabulary is exactly 4 kinds: `start_day | pause_day | resume_day | end_day`
  (`Sources/RoomRecorderCore/BenchClient.swift:172-176`, mirrored server-side in
  `lib/bench-commands.ts:23` `COMMAND_KINDS`). There is **no** remote command for: switch update
  channel, force an update check now, change input device, restart the process, or pull logs.
- Server write path: `POST /api/admin/bench/command` (`app/api/admin/bench/command/route.ts:1-159`)
  is "the monitor's ONLY write" — queues one of the 4 kinds via `insertCommand`
  (`route.ts:2-8`). Every command is audited to `audit_log` as `bench.command`
  (`route.ts:20-22,60-74`, added 22 Aug 2026). This is the same decision path
  `scribe_start_recording` (MCP) uses (`route.ts:6-8`) — confirmed by `Scribe_MCP` tool
  description ("remote tape control ... through the room kiosk's listener").
- `start_day` has a pre-check (`decideStart`) that can refuse with `kiosk_not_listening` (no live
  poll) or `room_paused` (consent pause, needs `override_pause:true`) — `route.ts:126-139`.
  `pause_day`/`resume_day`/`end_day` have no pre-check; they queue even against a dead kiosk and
  simply expire unseen (`route.ts:150-152`).
- Freshness window: a listener counts as "listening" only if `last_poll_at` is within
  **10 s** (`LISTENER_FRESH_MS = 10_000`, `lib/bench-bus-constants.ts:10`). Pending commands expire
  after **15 s** unpolled (`COMMAND_EXPIRY_SECONDS = 15`, same file:9). MCP tools wait up to
  **8 s** for an ack, polling every 400 ms (`ACK_WAIT_MS/ACK_POLL_MS`, same file:24-25).
- **Documented incident (D38, `lib/bench-bus-constants.ts:32-53`)**: 24 Aug 2026 — an operator
  stopped two clinic rooms remotely; both went silent within seconds, and *stopping is what makes
  the kiosk stop polling*, so there was no channel left to start them again remotely. At 16:33 one
  was only listening again because someone walked downstairs and reloaded it by hand; the other
  had been unreachable for 16 minutes. Fix shipped: an idle-but-open room self-reports on its own
  slower beat (`POLL_IDLE_MS = 3_000`, same file:55) so an open-but-idle page is distinguishable
  from a dead one — but this only helps if a browser tab/page is still open; it does not by itself
  give a remote way to relaunch a killed kiosk.
- Note: the timing/D38/POLL_IDLE constants above live in `lib/bench-bus-constants.ts`, which the
  file's own header says is written to be safe to import into "the kiosk bundle" (i.e. it targets
  the **browser** Room Bench kiosk). The **native** Room Recorder Swift app polls unconditionally
  every 1.5 s regardless of visibility (`RoomEngine.swift:1045`) as long as its process is alive —
  so the specific "tab closed → silence" failure mode is a browser-kiosk problem; the parallel
  native-app failure mode is "the resident process/launchd job is not running," which is exactly
  what self-update's canary/rollback exists to prevent (see §4).

### 3. What's fixed at first-enrol / walk-required, vs remote
- **Enrol is walk-required by construction.** `RoomEnrolment.exchange` posts a one-time bootstrap
  token to `/api/room-recorder/enrol`; the whole point of the design is "nothing here reads from
  the keyboard" because it runs inside a `curl | bash` pipe **on the clinic Mac itself**
  (`Sources/RoomRecorderCore/RoomEnrolment.swift:1-13`). There is no remote-exec path for this in
  the codebase — someone has to be at (or SSH'd into) the Mac to paste the bootstrap command.
  Per prior-session facts, only Cardiology has `sshd`, so enrol/re-enrol on the other 3 rooms is
  walk-required today.
- **Microphone/input device is chosen once, locally, and is NOT remotely changeable.**
  `RoomConfiguration.residentDefault` takes "the machine's CURRENT default audio input" at first
  enrol only, with "No `--device` argument, no prompt" (`RoomConfiguration.swift:211-234`).
  `applyEnrolment` (used on every re-enrol) *deliberately does not touch `deviceUID`* — "a re-enrol
  on a Mac that is already recording keeps the input the room is already using," specifically so a
  re-enrol can't silently move a live room onto a different plugged-in device
  (`RoomConfiguration.swift:502-518`). There is no command kind, config field, or route anywhere in
  this codebase that lets an operator remotely pick or switch which microphone a room records
  from — the only way to change it is to change the OS default input on the Mac itself and then
  re-enrol (still local), or presumably unplug/replug devices physically.
- **`update_channel` (stable/test) is a per-Mac, config.json-only field — "the only valve R3
  has," and deliberately has no remote setter.** `RoomConfiguration.swift:169-178`: "PER MAC, in
  `config.json`, because the alternative — a channel the server assigns — puts the valve on the
  same side of the wire as the thing it is meant to protect against." `:301-305`: "A hand-edited
  config.json is how Home Office reaches `test` ... there is no verb for it and deliberately so."
  So moving a room onto the canary (`test`) channel, or pulling a misbehaving room back onto
  `stable`, requires hand-editing a file on that specific Mac — no remote command, no admin route.
  (Publishing a *build* to a channel, `POST /api/admin/releases`, IS remote/curl-able — see §5 —
  but which Mac reads which channel is fixed locally.)
- **Session token lives only in the macOS Keychain, never in `config.json`.**
  `RoomConfiguration.saveConfiguration` strips `etaRoomSession` before every disk write
  (`RoomConfiguration.swift:410-422`); `RoomKeychain.swift` is the sole persistence for it. This
  means config.json alone (e.g. read over some future remote-file-read tool) can never leak or be
  used to reconstruct a session — but it also means recovering a de-authed install (expired/rotated
  session) requires a fresh `enrol`, i.e. walk-required per above.

### 4. Self-update / canary / rollback / ledger-hold (RoomSelfUpdate.swift, RoomEngine.swift)
- Update check interval: **6 hours** (`checkInterval: TimeInterval = 6 * 60 * 60`,
  `RoomSelfUpdate.swift:56`), but it is evaluated **after every successful poll**, not on a
  separate timer (`RoomEngine.swift:855-861`: "HERE, AFTER A SUCCESSFUL POLL, AND NOT AT THE TOP
  OF THE LOOP" — so effectively "6h since last check, checked opportunistically on the ~1.5s poll
  cadence"), and is deferred while a session is open, firing instead the moment a session ends
  (`RoomEngine.swift:804-816`, R3‑10).
- Canary window: **180 s** (`canaryWindow: TimeInterval = 180`, `RoomSelfUpdate.swift:149`), sliced
  into 2 s checks (`canarySlice: TimeInterval = 2`, `:153`) — matches known fact "canary ack ~2 s."
  Retry hold after repeated failure: **6 hours** (`retryHold: TimeInterval = 6 * 60 * 60`,
  `RoomSelfUpdate.swift:159`) — the "ledger-hold" — held on disk so it survives restarts
  (`RoomEngine.swift:826-828`, `.heldAfterRepeatedFailure`).
- The canary is a **shell-side artifact** (`update-canary.json`, written by the swap script, not
  the app — `RoomSelfUpdate.swift:306-349`) and is acknowledged purely by "pollCommands RETURNED"
  — i.e. the new build successfully reached the server and got an answer at all
  (`RoomEngine.swift:978-985`). This is a **plumbing** check (did the process launch and reach the
  network), not a check that the new build is actually recording/encoding audio correctly.
- Rollback is entirely inside the swap script (shell, embedded as a heredoc in
  `RoomSelfUpdate.swift:1000-1320`), keyed off the same canary file; if the new version doesn't
  poll within the canary window, the script restores the previous bundle
  (`RoomSelfUpdate.swift:1014-1023`, `CANARY_REASON`/`CANARY_KEPT_REASON` literals).
- `/api/room-recorder/release?channel=` is fetched with `reloadIgnoringLocalCacheData`
  (no caching) and **every non-2xx or decode failure is silently `nil`** — "a room must never read
  'I could not ask' as a reason to remove the software it is recording with"
  (`BenchClient.swift:467-491`). There is no remote push of a release; it is purely poll-and-pull.
- There is **no remote way to force an update check right now** — only the automatic 6 h /
  session-end trigger. An operator wanting to push 0.1.17 onto a specific room today has to either
  wait for the natural trigger or walk in and bump something locally.

### 5. Server receiving path (app/api/**, lib/**)
- `/api/room-recorder/enrol` — bootstrap token → session (walk-required trigger; see §3).
- `/api/bench/commands` (GET, poll) / `/api/bench/commands/[id]/ack` (POST) — the listener/command
  bus described in §2. Implementation: `lib/bench-commands.ts` (`pollCommands`, `insertCommand`,
  etc., 21 KB); D4 "last-poll-wins" supersession for two tabs on one room
  (`bench-commands.ts:13-15`).
- `/api/admin/bench/command` — admin/MCP write door (§2).
- `/api/admin/bench/fleet` (GET only) — "the card's only read," feeds both the fleet table (20 s
  poll) and an open-install checklist (3 s poll); explicitly **read-only and fail-safe**: on any
  internal fetch failure it still returns a 200 with a `degraded` array naming which part failed,
  never a 500 (`app/api/admin/bench/fleet/route.ts:1-52`). Per known facts, this route is
  proxy-blocked from Cowork shells — so even this read-only operator surface is not reachable from
  here today, only from a real browser/curl session with admin auth.
- `/api/admin/bench/drain` — **MANUAL ONLY**, explicitly documented: "Nothing schedules this: there
  is no cron, and the chunk route enqueues but never drains" (`app/api/admin/bench/drain/route.ts:
  1-14`). POST drains one window or up to `limit` queued windows of a session; still gated by a
  per-room "Transcript switch" enforced inside `drainRoomWindow`, not in the route
  (`:11-13`). Confirms known fact: room tape window close only enqueues, no drain cron.
- `/api/admin/releases` — POST registers an already-uploaded Vercel Blob bundle to a channel
  (`stable`/`test`); GET lists by channel. Both accept an admin cookie **or** `Bearer
  MIGRATION_SECRET`, "so V can drive publication with curl" (`app/api/admin/releases/route.ts:
  19-22`). **Nothing here is believed** — version/build_sha come from the manifest, sha256/size are
  recomputed server-side by re-streaming the blob and refused on mismatch (`:9-17`). This route
  IS remotely operable; what is NOT remote is steering an individual Mac onto the channel it reads
  (see §3).
- `/api/admin/bench/fleet`, `/api/admin/bench/windows`, `/api/admin/bench/listeners`,
  `/api/admin/bench/rooms-live`, `/api/admin/bench/processing`, `/api/admin/bench/run-waiting` all
  exist under `app/api/admin/bench/` (listed by directory scan; not all individually read this
  pass — flagged for a follow-up read if needed).
- `docs/DATA-MODEL.md` is **stale** — it documents only migrations 0001–0027 (STT Engine Lab era)
  and does not mention `bench_session`/`bench_command`/`bench_window`/`bench_listener`/
  `room_install`/`release` tables at all. Ground truth from the actual migrations directory
  (65 files, 0001–0061+ seen): `0041_room_bench.sql`, `0042_brain_tables.sql`,
  `0043_bench_event.sql`, `0044_bench_command.sql` (the command/listener bus — comment in
  `bench-commands.ts:6-7` notes "Migration 0044 has NOT run anywhere at build time" as of that
  file's writing — inferred SQL, verify against live DB), `0045_bench_chunk_source.sql`,
  `0057_bench_window.sql`. Anyone updating docs should refresh DATA-MODEL.md to cover these — it
  currently reads as if the STT Lab tables are the whole schema.

### 6. Checks: plumbing vs content — worked examples
- **`update-canary.json` (self-update):** plumbing. Success = "the new binary launched and
  `pollCommands` got an HTTP answer." Does not verify the new binary is actually capturing audio,
  writing to the tape, or that ffmpeg/encoder paths still resolve.
- **Vercel cron `reap-stuck` (hourly):** plumbing/timing. Sweeps encounters stuck in `processing`
  past N minutes by wall-clock age (`app/api/admin/reap-stuck/route.ts:1-22`); also now sweeps
  `bench_session` rows via `lib/bench-reaper.ts`, purely on `last_primary_at`/`last_backup_at`
  chunk timestamps vs a cap — never inspects audio content (`lib/bench-reaper.ts:11-35`).
- **Documented false-negative from a timing-only check (`ENDED_DISAGREES`, `lib/bench-bus-
  constants.ts:58-107`):** session `bs_g3dwud4p`, Home Office, 22–23 Aug — a day-rollover reaper
  stamped `ended_at` at 19:00:36 purely on schedule; the kiosk was never told and kept writing
  chunks until 00:58:46 (6 hours later, "All 108 of them are present and verified. No audio was
  lost"), but the operator monitor showed **NOT RECORDING** the whole time. This is the canonical
  case of a plumbing check ("session row says ended") silently disagreeing with content reality
  ("tape was still running") with no alarm for 6 hours. The fix is a *named disagreement* surfaced
  on screen (`ENDED_DISAGREES` state), not a content check per se.
- **`measure-windows` (nightly cron, 20:30 UTC):** the one job that does inspect real audio — it
  runs "local Whisper on one frozen ~90-second clip" per window as a "tuning fork" canary
  (`app/api/admin/measure-windows/route.ts:1-12`), explicitly justified as free (no paid engine) so
  it's allowed to run unattended, unlike the paid STT drain which must stay manual
  (`:8-12`, referencing PRD §1.6 "paid runs happen only when an operator presses a button"). This
  is the one genuinely **content-aware** automated check found in this pass; everything else
  scheduled is status/timing/byte-count plumbing.
- **`resume-processing` (every 3 min) / `diarize-windows` (every 5 min):** not read in depth this
  pass (device_bash outage cut the session short) — flagged as open questions below.
- **STT drain (`/api/admin/bench/drain`):** manual-only, and even then the route itself does no
  content check — it delegates to `drainRoomWindow`, which is presumably where WER/agreement
  scoring against gold would live (STT adapters are explicitly out of scope for this researcher).

### 7. Test suite shape
- Server (`tests/`): **66 unit test files** (vitest, TS) under `tests/unit/` + 1 Playwright spec
  (`tests/e2e/recording.spec.ts`) + `tests/e2e/global-setup.ts`. Heavy concentration on the Bench/
  Room subsystem specifically: `bench-commands.test.ts`, `bench-reaper.test.ts`,
  `bench-window.test.ts`, `room-controls.test.ts`, `room-install.test.ts`,
  `room-install-update.test.ts` (21 KB — self-update-adjacent), `room-release-route.test.ts`,
  `room-drain.test.ts`, `room-switches.test.ts`, `ended-disagrees.test.ts` +
  `ended-disagrees-monitor.test.ts`, `tuning-fork.test.ts`, `window-measure.test.ts`,
  `mic-health-b2.test.ts` (23 KB) — i.e. the areas this audit flags (commands bus, install/update,
  reaping, ended-disagrees) are all under direct unit test.
- Room Recorder (Swift, `apps/room-recorder/Tests/TapeCoreTests`): per
  `apps/room-recorder/README.md:24-34`, the "configured gate" reports **283 tests in 28 suites**
  (Apple Swift 6.4 / Testing Library 2078); named suite groups `RING-*`, `CAP-*`, `SRC-*`, `DUR-*`,
  `IDX-*`, `VER-*`, `WAV-*`, `DGR-*` are complete at an "isolated/software boundary." The converter
  soak and two ENOSPC fixtures are opt-in, not part of ordinary runs. A separate, narrower
  archive-key-lifecycle suite reports 23 tests ordinarily / 24 with a probe flag
  (`README.md:41-45`) — that slice is explicitly **not accepted for production** (no Secure
  Enclave provider executed on either Mac, no permanent key created).

## Remote-vs-walk matrix

| Capability | Remote today? | Code path | What blocks remote |
|---|---|---|---|
| Start / pause / resume / end a recording | **Yes** | `POST /api/admin/bench/command` → bus → kiosk polls & executes (`RoomEngine.swift:1282` `handle(_:)`) | Requires a *listening* kiosk (poll within 10 s, `LISTENER_FRESH_MS`); if the kiosk process/tab is dead there is nothing to instruct (`kiosk_not_listening`, D38 incident) |
| Override a consent-pause to force-start | **Yes** | `override_pause:true` on the command; decided in `RoomCommandDecider.decide` (`RoomEngine.swift:79-100`) | Same kiosk-liveness requirement as start |
| Publish a new build to `stable`/`test` | **Yes** | `POST /api/admin/releases`, admin cookie or `Bearer MIGRATION_SECRET` (curl-able) | n/a — this part is already remote |
| Move a specific Mac onto `test`/`stable` | **No** | `updateChannel` is read only from local `config.json`; no route/command sets it (`RoomConfiguration.swift:169-178,301-305`) | Deliberate design choice ("the only valve R3 has… no verb for it and deliberately so") |
| Force an update check now (skip the 6 h wait) | **No** | `checkForUpdateIfDue` only fires on the 6 h schedule or session-end (`RoomEngine.swift:804-861`); no command kind for it | No such command kind exists in `BenchCommandKind`/`COMMAND_KINDS` |
| Select/switch which microphone a room uses | **No** | Device UID set once at first enrol from OS default (`RoomConfiguration.swift:211-234`); explicitly preserved (not reset) on every re-enrol (`:502-518`) | No field, command, or route anywhere touches `deviceUID` remotely |
| First enrol / re-enrol a Mac | **No** | `curl \| bash` bootstrap token exchange must run on that Mac; "nothing here reads from the keyboard" is designed for a local pipe, not remote exec (`RoomEnrolment.swift:1-13`) | Only Cardiology has sshd (per known facts); other 3 rooms need someone physically present |
| Recover a de-authed / retired install | **No** | Session lives only in Keychain (`RoomConfiguration.swift:410-422`); a retired install just stops polling (`RoomEngine.swift:1035-1046`) and needs a fresh local enrol | Same as enrol above |
| Drain a window through paid STT | **Yes (manual, admin-gated)** | `POST /api/admin/bench/drain`, no cron (`app/api/admin/bench/drain/route.ts:1-14`) | Not a gap — deliberately manual per PRD §1.6 (cost control), but means nobody remote-triggers it automatically either |
| View fleet/install health | **Partially** | `GET /api/admin/bench/fleet`, read-only, fail-safe (`fleet/route.ts:1-52`) | Per known facts, proxy-blocked from Cowork shells specifically — reachable from an operator's own browser/curl, just not from this MCP/agent context |
| Repair an orphaned session (no kiosk owns it) | **Yes** | `close_orphan` kind in the same admin command route, runs **server-side**, not queued to a kiosk (`app/api/admin/bench/command/route.ts:95-123`) | Not a gap — designed for exactly the case where the kiosk is unreachable |

## Checks: plumbing vs content

| Check | Cadence | What it actually measures | Plumbing or content |
|---|---|---|---|
| Self-update canary (`update-canary.json`) | Once per update, 180 s window, 2 s slices | New process launched and got any HTTP answer from `/api/bench/commands` | Plumbing |
| `reap-stuck` cron | Hourly | Wall-clock age of `encounter.status='processing'`; `bench_session` age vs last chunk timestamp | Plumbing/timing |
| `ENDED_DISAGREES` monitor state | Continuous (derived) | Session row `ended_at` vs chunk `started_at` (capture clock) — a *disagreement* flag, not a content re-check | Plumbing, but explicitly designed to surface a plumbing/reality mismatch rather than hide it |
| `measure-windows` cron (nightly, 20:30 UTC) | Nightly | Runs local Whisper on a ~90 s clip per window ("tuning fork") + level/duration measurement | **Content** (the one automated content check found) |
| STT drain (`/api/admin/bench/drain`) | Manual only | Actual paid ASR/scribe run against the window's audio | Content, but human-gated, not automatic |
| `resume-processing` / `diarize-windows` crons | 3 min / 5 min | Not read this pass | Unknown — open question |

## Open questions
1. `resume-processing` and `diarize-windows` cron bodies were not read (device_bash outage cut the
   session) — need to confirm whether either does any content-level check or is pure state
   machine/retry plumbing.
2. `lib/room-install.ts` (52 KB, staged but not read in depth) almost certainly contains
   `applyInstallPoll`, `createRelease`, `readFleet`, `cleanupExpiredInstalls` — the fullest picture
   of the install/fleet data model lives there and deserves a dedicated pass.
3. `db/migrations/0044_bench_command.sql`'s own comment in `lib/bench-commands.ts:6-7` says the
   migration "has NOT run anywhere at build time" as of that writing and the SQL there is
   "INFERRED" — worth confirming against the live DB that the bus tables match what the code
   assumes.
4. Whether the native Room Recorder's continuous 1.5 s poll (independent of any UI/tab) actually
   closes the D38 gap for the *native app* specifically, or whether an equivalent "process died
   silently" failure mode exists for it that has just never been triggered/observed yet — the code
   shows no independent liveness/heartbeat check for the resident process itself beyond the poll
   succeeding.
5. Whether `LISTENER_OFFLINE_MS` (10 min, "somebody has to walk there") is surfaced anywhere as an
   actionable alert, or is just a documented threshold with no automated paging.
6. `docs/DATA-MODEL.md` needs a refresh — it stops at migration 0027 and omits the entire Bench/
   Room/Release schema (0041–0061+) that this audit's core subject matter lives in.
