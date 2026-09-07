# Decision brief: Room Recorder install and fleet module

Programme: EvenScribe / Even-Transcription-Assistant (ETA). Repo `~/dev/Even-Transcription-Assistant`, branch `feat/room-recorder`, HEAD `d7df4b1`. Native app source `apps/room-recorder/` (SwiftPM, Swift 6.2, macOS 15 floor, two CLI executables `room-recorder` and `tapewriter`, no `.app` bundle yet). Admin app: Next.js 15.5 App Router, React 19, Tailwind 3.4 with the `even-*` palette, lucide-react, jose JWT, Neon Postgres + Drizzle. Admin auth: cookie `eta_admin_session`, `verifyAdminJwt`, `benchAdminGuard()`. Pattern page: `app/admin/bench/page.tsx` + `components/admin/AdminShell.tsx` + `components/admin/BenchRoomsLive.tsx`.

## The goal in V's words

V sits at each OPD room computer (four Mac Minis, macOS 15+, shared by staff for EMR and browsing, V holds a local admin password, no MDM), opens a page on evenscribe.app, clicks a button, and the Room Recorder app downloads, installs, and enrols that room.

## What grounding found (7 Sep)

Exists: provisioning CLI (`configure / login / run / status / mark / install-launch-agent`), LaunchAgent writer (`~/Library/LaunchAgents/com.evenscribe.room-recorder.plist`, RunAtLoad + KeepAlive), server contract (`POST /room/{slug}/api/login` with 4-digit PIN → 30-day `eta_room_session` JWT aud `room`; `GET /api/bench/commands` poll upserts `bench_listener`; `/api/bench/rooms` admin CRUD; Rooms Live monitor polling `/api/admin/bench/listeners` at 3 s and `/api/admin/bench/rooms-live` at 20 s).

Absent: `.app` bundle, packaging script, signing identity (unowned), download route, release bucket, updater (R9 ratified, unbuilt, contract unratified), keychain storage (token sits in `config.json` mode 0600), token rotation, pairing code, version field on the wire, room-to-machine binding (`room` has no device column; `bench_listener` is one row per room, last writer wins, `tab_id` free text), any clinic install runbook.

Vendored ffmpeg: `Encoder/build-ffmpeg.sh` produces `.build/encoder-candidate` (FFmpeg n9.0.1 + libopus 1.6.1, SHA-pinned), stamped `production_ready:false`, "distribution blocked on legal review and the final in-house certificate". Today's builds use Homebrew ffmpeg by absolute path.

## Ratified by V on 7 Sep 2026

D1 Signing. R7 stands: in-house certificate, label `EvenScribe Room Recorder Code Signing 1`, identifiers `com.evenscribe.room-recorder` and `com.evenscribe.room-recorder.ffmpeg`. V owns the certificate. Consequence accepted: the first launch on each Mac needs one Open Anyway in System Settings → Privacy & Security with the admin password. Updates never hit Gatekeeper because the app downloads them itself (no quarantine attribute). Escrow and key-handling specifics are builder authority. The page cannot perform the Gatekeeper step; it detects that it happened.

D2 Enrolment by one-time code. Admin page mints a single-use code bound to one room, TTL 10 minutes. After install, the page's Enrol button opens `evenscribe-room://enrol?code=<code>&origin=<https origin>`. The app exchanges the code at `POST /api/room-recorder/enrol` for the 30-day room session and an `install_id`. No PIN is typed on the room Mac. Amends R8: the PIN login stays for humans and the browser; the app uses the code path.

D3 Placement. A third card inside `/admin/bench`, beside Rooms and Rooms Live. Working title "Install and fleet". Not a new page.

D4 Fleet facts. Four Mac Minis on macOS 15 or later. Staff use them for other work. V has a local admin password on each. No MDM. Assumption A1 (V to confirm in PRD review): each room Mac has one shared account that stays logged in all day; the LaunchAgent belongs to that account.

## Decisions proposed in the PRD for V to ratify at review (mark each "proposed")

P1 Bundle and self-install. Distributable is a zip of `EvenScribe Room Recorder.app` (layout per `ETA-APP-BUILD-B-DESIGN-PROVENANCE-26-AUG-2026.md` lines 433-445: `Contents/MacOS/room-recorder`, `Contents/Helpers/tapewriter`, `Contents/Helpers/ffmpeg`, Info.plist with the URL scheme and mic usage string). On first launch from any location the app copies itself to `~/Applications/EvenScribe Room Recorder.app`, writes the LaunchAgent pointing at that path, loads it, and quits; launchd starts the resident copy. No `sudo`, no `/Applications`, no `.pkg`. Rationale: everything the app does today is user-level, and the LaunchAgent must own a stable path.

P2 Release store. New private R2 bucket `eta-releases` and table `app_release` (`version`, `build_sha`, `sha256`, `size_bytes`, `r2_key`, `channel` stable|test, `published_at`, `published_by`, `withdrawn_at`, `notes`, `min_macos`). Publishing is an admin route `POST /api/admin/releases` that Claude Code calls with the artifact; the download link on the page is a 10-minute signed R2 URL minted by `GET /api/admin/releases/latest/download`. This is the new server surface the 28 Aug build plan said needs explicit ratification.

P3 Install registry. Table `room_install` (`install_id` PK `install_<12>`, `room_id` FK, `hostname`, `hardware_model`, `os_version`, `app_version`, `build_sha`, `enrolled_at`, `enrolled_by` admin id, `last_seen_at`, `mic_state` authorized|denied|not_determined|unknown, `launch_agent_loaded` bool, `tape_advancing` bool, `never_sleep` bool nullable, `retired_at`). One active install per room (partial unique index on `room_id where retired_at is null`); enrolling a new Mac into a room retires the old install row and supersedes its listener. The poll `GET /api/bench/commands` gains optional `install_id`, `app_version`, `build_sha`, `mic_state`, `tape_advancing`, `never_sleep`; the server updates `room_install.last_seen_at` and the state fields on every poll. `bench_listener.tab_id` for the app is `app_<install_id>` (this closes the three-way drift: PRD said `app_<machine>`, code mints `native_<uuid12>`, later plans said `app_<install-id>`).

P4 Enrolment table. `room_enrol_code` (`code` PK, 8 chars from an unambiguous alphabet, `room_id`, `created_by`, `created_at`, `expires_at` = +10 min, `used_at`, `install_id`). Exchange route is unauthenticated (the code is the credential), single use, 5 attempts per IP per 10 min, constant-time compare, unknown and expired and used all return the same `CODE_INVALID`. On success: issue the room session JWT (same `signRoomJwt`, 30 days), create the `room_install` row, return `{ install_id, room_slug, room_name, session }`. The app stores the session in the login keychain (generic password, service `com.evenscribe.room-recorder.room-token`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), which makes R8's keychain clause real.

P5 Session refresh. `POST /api/room-recorder/refresh` with the current valid room session returns a fresh 30-day session. The app refreshes on day 25 or later. On any poll that returns 401 it stops polling and shows `needs_enrol` in the fleet card (the server marks the install `needs_enrol` when its session would have expired). Rationale: without this every room dies silently on day 31.

P6 Guided checklist. The Install card for a room shows a numbered checklist the page fills in only from server state, polled every 3 s while the card is open:
1. Download the app. Page mints the signed link. Done when clicked (the only page-driven step, labeled "link opened", not "installed").
2. Open the app and pass Gatekeeper. Manual. The page shows the exact path: open from Downloads, dismiss the "Apple could not verify" dialog, System Settings → Privacy & Security → Open Anyway, admin password. No server signal exists for this step by itself, so it shows as "waiting" until step 3 completes.
3. Enrol this Mac. Button opens the URL scheme with a fresh code. Done when `room_enrol_code.used_at` is set. Shows the code and a countdown; a new code button after expiry.
4. Microphone permission. Done when heartbeat reports `mic_state = authorized`. Blocked with instructions if `denied`.
5. Tape advancing. Done when heartbeat reports `tape_advancing = true` for two consecutive polls.
6. Machine settings. Never sleep: done when the app reports `never_sleep = true`; otherwise shows the System Settings path. Auto-login: manual, shown as a reminder with the path, never marked done by the page.
Each step shows one of: done, waiting, blocked. Blocked shows the one thing to do. The page must never claim a step is done from its own actions except step 1's "link opened".

P7 Self-update (R9), built last. App checks `GET /api/room-recorder/release?channel=stable` every 6 hours and on launch, compares `version`, downloads the zip via a signed URL the route returns, verifies `sha256` and `codesign --verify --strict` against the expected identity, swaps `~/Applications/EvenScribe Room Recorder.app` keeping the previous copy as `.previous`, never while a recording session is open, then exits so launchd relaunches. Rollback: an admin action in the fleet card marks a release `withdrawn`; the app on its next check sees the previous version as current and swaps back.

P8 Fleet card rows. One row per room: name, bound install (hostname, model), app version vs latest, last seen (relative), mic, tape, and actions: Install on this Mac, Re-enrol, Retire install. Release-level actions in the card header: latest version, publish time, Withdraw. A room with no install shows "Not installed" and the Install button. No release published: card shows "No release published yet", Install disabled.

## Prerequisites (must exist before Build R2 can ship an artifact)

X1 Certificate created and trusted on the build Mac (V, with Claude Code driving `security` on V's Mac). Owner: V.
X2 Vendored encoder legal review: the `encoder-candidate` is `production_ready:false` pending legal review of the FFmpeg/libopus build for redistribution. V decides: ship it now with the LGPL notices bundled, or hold the app on Homebrew ffmpeg by absolute path for the four clinic Macs (which means a Homebrew install step per Mac and an unstable encoder identity). Open decision for V at PRD review.
X3 A build Mac with Xcode command line tools and the certificate.

## Build split (each is one Claude Code kickoff, each carries its own migration and changelog entry)

Build R1, server and admin. Migrations for `app_release`, `room_enrol_code`, `room_install`, poll field additions. Routes: enrol-codes mint (admin), enrol exchange, refresh, releases publish and latest and download, fleet read. The Install and fleet card in Bench with the guided checklist. No flag needed: without a release row the card shows "No release published yet" and the Install button is disabled.

Build R2, the app. Bundle assembler script (`apps/room-recorder/Packaging/`), Info.plist with URL scheme `evenscribe-room` and mic usage string, self-install on first launch, enrol exchange, keychain storage, heartbeat fields, refresh, `pmset` and mic-state reporting. Signed with the in-house certificate. Output: `EvenScribe-Room-Recorder-<version>.zip` plus sha256.

Build R3, self-update (P7).

## Rules that carry

Verify on production reality, never on the report. Labels derived, never typed (version and sha come from the build, never from a field someone fills). Claude Code stops at authorization boundaries. Every migration through Claude Code. Terminal paste blocks for V: comment-free, one command per block. The page must never claim a step is done from its own actions.
