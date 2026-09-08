# ETA Room Recorder — Install and Fleet PRD v1.0 FINAL

**7 September 2026 · Version 1.0 FINAL**

**Status: v1.0 FINAL, ratified by V 7 September 2026. Kickoff-ready for Build R1. Build R2 waits on X1 and X3.**

**Supersedes:** `ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v0.9`.
**Amends:** `ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1`. R7 consequence only, R8, and R9.

Inputs, all binding: the rulings of 7 September 2026, the decision brief `DECISION-BRIEF.md` of
7 September 2026, and the Room Recorder PRD v1.1. The rulings win over both other inputs.

---

## 1. Decisions log

Every row below is ratified. The column "what breaks if reversed" states the cost of changing
the row after a build starts.

### 1.1 Ratified decisions

| # | Decision | Status | What breaks if reversed |
|---|---|---|---|
| **D1** | **Signing.** In-house certificate, label `EvenScribe Room Recorder Code Signing 1`, identifiers `com.evenscribe.room-recorder` and `com.evenscribe.room-recorder.ffmpeg`. V owns the certificate. The Gatekeeper consequence no longer applies, because `curl` writes no quarantine attribute on the install path. | RATIFIED 7 Sep 2026 | The microphone permission binds to the signing identity. A new identity forces a fresh microphone grant on all four Macs. |
| **D2** | **Enrolment by one-time code.** Superseded by D9 on the same day. The URL scheme, the 8-character code and the typed Enrol step are gone. | RATIFIED THEN SUPERSEDED 7 Sep 2026 | Nothing. D9 replaces this row in full. |
| **D3** | **Placement.** A third card inside `/admin/bench`, beside Rooms and Rooms Live. Working title "Install and fleet". Not a new page. | RATIFIED 7 Sep 2026 | A new page needs its own route, guard, shell and navigation. |
| **D4** | **Fleet facts.** Four Mac Minis on macOS 15 or later. Staff use them for other work. V holds a local admin password on each. No MDM. | RATIFIED 7 Sep 2026 | The user-level install, the LaunchAgent path and the no-`sudo` rule all follow from these facts. |
| **D5** | **Pre-enrolment hello ping.** An unauthenticated `POST /api/room-recorder/hello` from the unenrolled app. | RATIFIED THEN WITHDRAWN 7 Sep 2026 | Nothing. The one-paste enrolment of D9 enrols the app before its first poll, so an unauthenticated ping has no work left to do. |
| **D6** | **Bundle and terminal one-liner.** The distributable is a zip of `EvenScribe Room Recorder.app`. The bootstrap script places the bundle in `~/Applications`. The app performs no self-copy. No `sudo`, no `/Applications`, no `.pkg`, no Download button. | RATIFIED 7 Sep 2026 | A `.pkg` needs an installer certificate and an admin password for each install. A browser download restores Gatekeeper. |
| **D7** | **Release store on Vercel Blob.** `@vercel/blob` is already a dependency with a token in the project. The publisher uploads the zip to Blob and then registers the release. `app_release.blob_url` holds the download address. | RATIFIED 7 Sep 2026 | Build R1 routes, the fleet card header, the bootstrap script and the R3 updater all read `app_release`. A new store needs a new bucket and a new key. |
| **D8** | **Install registry.** Table `room_install`, one active install per room, the poll field additions of §4.3, and app `tab_id` of `app_<install_id>`. | RATIFIED 7 Sep 2026 | The fleet card has no row source. The three-way `tab_id` drift returns. |
| **D9** | **One paste does everything.** The page mints a single-use token with a 30-minute TTL, bound to one room and to a server-minted `install_id`. The command is `curl -fsSL "https://www.evenscribe.app/api/room-recorder/bootstrap/<token>" \| bash`. The server returns the bash script of §4.4. Table `room_bootstrap_token` replaces `room_enrol_code`. | RATIFIED 7 Sep 2026 | The install returns to a multi-step manual sequence with a browser download, a Gatekeeper visit and a typed code. |
| **D10** | **Install sessions last 365 days.** The enrol exchange signs the room JWT with a 365-day TTL for app installs. Human PIN logins stay at 30 days. There is no refresh route. Re-enrolment is a second paste, which retires the old install. | RATIFIED 7 Sep 2026 | A 30-day session kills all four rooms silently one month after install. |
| **D11** | **Guided checklist, five steps.** Steps 1 to 5 of §6. Each step reads server state. Step 1 is the one page-driven step and carries the label "Command copied". | RATIFIED 7 Sep 2026 | The card becomes a set of buttons with no truth behind them. |
| **D12** | **Self-update, Build R3.** The contract of §7. Checked on launch and every 6 hours, verified by sha256 and by signature, never during a recording session. Withdraw is the rollback. The download source is Blob. | RATIFIED 7 Sep 2026 | Every future app change becomes a walk to four rooms. |
| **D13** | **Fleet card rows.** One row for each room, with the fields and the two actions of §6. | RATIFIED 7 Sep 2026 | The card cannot answer "which room is dark" in one look. |

### 1.2 Assumption

| # | Assumption | Status | What breaks if wrong |
|---|---|---|---|
| **A1** | Each room Mac has one user account for that room. Staff log in once and leave the account logged in all day. The app installs under that user. | RATIFIED 7 Sep 2026 | A LaunchAgent runs only for its own user. A logout or a user switch stops the app. |

### 1.3 Prerequisites

| # | Prerequisite | Owner | State | Blocks |
|---|---|---|---|---|
| **X1** | Certificate created and trusted on the build Mac. Claude Code drives `security` on V's Mac. | V | Open | Build R2 |
| **X2** | Vendored encoder decision. | V | **Closed 7 Sep 2026.** Ship the vendored encoder now with the LGPL notices bundled inside the app. | Nothing |
| **X3** | A build Mac with the Xcode command line tools and the certificate installed. | V | Open | Build R2 |

Build R1 has no prerequisite. Build R2 waits on X1 and X3.

---

## 2. Problem statement

Four clinic rooms are dark. R16 of the Room Recorder PRD holds the clinic rooms for the app.
The app has no `.app` bundle, no packaging script, no signing identity, no download route and
no installer. The only way to put software in a room today is to walk to the room.

A walk to each room costs one visit for each Mac for each change. It also costs the room. Staff
share the Mac for EMR work, so the visit must happen between patients.

This module removes four costs. It removes the download step, because the script downloads the
zip. It removes the Gatekeeper visit, because `curl` writes no quarantine attribute. It removes
the typed credential on the room Mac, because the token in the command carries the enrolment. It
removes the manual LaunchAgent work, because the script installs and loads the agent.

This module cannot remove two things. It cannot remove the microphone permission click, which
macOS shows to the app in the foreground. It cannot remove the machine settings in System
Settings, which are never sleep and automatic login.

---

## 3. The operator's day

V stands at one OPD Mac, logged in as the room user. A release is published.

| # | V does | The Mac shows | The page shows after |
|---|---|---|---|
| 1 | Open `/admin/bench` in any browser. Find the Install and fleet card. Find the room row. | The Bench page. | The row reads "Not installed" with a Copy install command action. |
| 2 | Click Copy install command. | Nothing. | The card opens the five-step checklist. Step 1 turns done with the label "Command copied". Steps 2 to 5 read waiting. |
| 3 | Open Spotlight. Type Terminal. Press Return. | A Terminal window. | No change. |
| 4 | Paste the command. Press Return. | Terminal prints the progress lines of §4.4 and ends with "Installed and enrolled as \<room name\>. Close this window." | Within seconds step 2 turns done with the hostname, the model, the OS version and the start time. |
| 5 | Click Allow on the microphone prompt. | The standard macOS microphone prompt with the app usage string. | Within seconds step 3 turns done. A Do Not Allow turns step 3 blocked, with the System Settings path. |
| 6 | Wait. | Nothing visible. The app opens the day tape and writes to it. | After two consecutive polls with `tape_advancing = true`, step 4 turns done. |
| 7 | If never sleep is off, open System Settings and turn on "Prevent automatic sleeping when the display is off". If automatic login is off, open System Settings and set automatic login to the room account. | The settings change. | Never sleep turns done on the next poll with `never_sleep = true`. Automatic login stays a reminder and never turns done. |
| 8 | Close the checklist. | Nothing. | The room row reads hostname, app version, last seen, mic state, tape state and session expiry. |

V repeats these steps at the other three Macs. The whole cost at each Mac is one paste, one
Return, one Allow, and the System Settings visits if the two machine settings are not already
set.

---

## 4. Server contract

Existing files this module touches:
`app/api/bench/commands/route.ts`, `lib/bench-commands.ts`, `lib/room-auth.ts`,
`app/api/bench/rooms/route.ts`, `components/admin/BenchClient.tsx`,
`components/admin/BenchRoomsLive.tsx`.

### 4.1 Tables

Migrations are `007x` placeholders. Claude Code assigns the real numbers at kickoff.

**`app_release`** (D7)

| Column | Type | Constraint |
|---|---|---|
| `id` | text | primary key, `rel_<12>` |
| `version` | text | not null, unique with `channel` |
| `build_sha` | text | not null, derived from the build |
| `sha256` | text | not null, 64 hex characters, computed by the server |
| `size_bytes` | bigint | not null, greater than zero |
| `blob_url` | text | not null, unique, the Vercel Blob download address |
| `channel` | text | not null, `stable` or `test` |
| `published_at` | timestamptz | not null, default now |
| `published_by` | text | not null, admin id |
| `withdrawn_at` | timestamptz | nullable |
| `notes` | text | nullable |
| `min_macos` | text | not null, default `15.0` |

**`room_bootstrap_token`** (D9)

| Column | Type | Constraint |
|---|---|---|
| `token` | text | primary key, opaque, minted by the server |
| `room_id` | text | not null, foreign key to `room` |
| `install_id` | text | not null, foreign key to `room_install` |
| `created_by` | text | not null, admin id |
| `created_at` | timestamptz | not null, default now |
| `expires_at` | timestamptz | not null, `created_at` plus 30 minutes |
| `used_at` | timestamptz | nullable |

The token is single use. The enrol route sets `used_at` inside the same transaction that issues
the session. A second exchange of the same token fails.

**`room_install`** (D8)

| Column | Type | Constraint |
|---|---|---|
| `install_id` | text | primary key, `install_<12>`, minted by the server at token mint |
| `room_id` | text | not null, foreign key to `room` |
| `created_at` | timestamptz | not null, default now |
| `enrolled_at` | timestamptz | nullable, set at the enrol exchange |
| `enrolled_by` | text | not null, admin id from the token row |
| `session_expires_at` | timestamptz | nullable, set at the enrol exchange |
| `launched_by` | text | nullable, `launchd` or `user`, from the latest poll |
| `hostname` | text | nullable until the first poll |
| `hardware_model` | text | nullable until the first poll |
| `os_version` | text | nullable until the first poll |
| `app_version` | text | nullable until the first poll |
| `build_sha` | text | nullable until the first poll |
| `last_seen_at` | timestamptz | nullable |
| `mic_state` | text | not null, `authorized`, `denied`, `not_determined` or `unknown`, default `unknown` |
| `launch_agent_loaded` | boolean | not null, default false |
| `tape_advancing` | boolean | not null, default false |
| `never_sleep` | boolean | nullable |
| `retired_at` | timestamptz | nullable |

Partial unique index on `room_id where retired_at is null and enrolled_at is not null`. One
active enrolled install for each room. A nightly job deletes unenrolled rows whose token expired
more than 24 hours ago.

### 4.2 Routes

| Method and path | Auth | Request | Response 200 | Errors |
|---|---|---|---|---|
| `POST /api/admin/releases` | admin JWT, `benchAdminGuard()` | `{ blob_url, channel, manifest }`, where `manifest` is the packaging script's `release.json` | `{ release }` | 400 `BAD_BUNDLE`, 400 `SHA_MISMATCH`, 409 `VERSION_EXISTS`, 401 |
| `GET /api/admin/releases` | admin JWT | `?channel=` | `{ releases[] }` | 401 |
| `POST /api/admin/releases/{id}/withdraw` | admin JWT | none | `{ release }` | 404, 401 |
| `POST /api/admin/rooms/{roomId}/bootstrap-token` | admin JWT | none | `{ token, install_id, command, expires_at }` | 404 `ROOM_UNKNOWN`, 409 `NO_RELEASE`, 401 |
| `GET /api/room-recorder/bootstrap/{token}` | none, the token is the credential | none | `text/x-shellscript` body, the script of §4.4 | 404 `TOKEN_INVALID`, 429 `BOOTSTRAP_RATE_LIMITED` |
| `POST /api/room-recorder/enrol` | none, the token is the credential | `{ token }` | `{ install_id, room_slug, room_name, session }` | 400 `TOKEN_INVALID`, 429 `ENROL_RATE_LIMITED` |
| `GET /api/admin/bench/fleet` | admin JWT | none | `{ rows[], latest_release }` | 401 |
| `POST /api/admin/installs/{installId}/retire` | admin JWT | none | `{ install }` | 404, 401 |
| `GET /api/room-recorder/release` | room session JWT | `?channel=stable` | `{ version, sha256, size_bytes, blob_url }` | 404 `NO_RELEASE`, 401 |

`GET /api/room-recorder/release` ships in Build R3. The other eight routes ship in Build R1.

**Publishing.** The publisher uploads the zip straight to Vercel Blob and then calls
`POST /api/admin/releases` with the returned `blob_url` and the `release.json` the packaging
script wrote. This project needs no presign route of its own. The builder may add a
`handleUpload` route if a client upload path needs one. That choice is the builder's.

The packaging script derives `version` and `build_sha` from the bundle `Info.plist`. It computes
`sha256` and `size_bytes` from the zip it produced. The server streams the Blob object, checks
`size_bytes`, recomputes `sha256`, and refuses with `SHA_MISMATCH` on any difference. No field
is typed by a person.

**Bootstrap-token mint.** The route creates the `room_install` row and the
`room_bootstrap_token` row in one transaction. It returns the exact one-liner in `command`. The
page copies that string without changing it.

```
curl -fsSL "https://www.evenscribe.app/api/room-recorder/bootstrap/<token>" | bash
```

**Bootstrap fetch.** The route returns the script with content type `text/x-shellscript`. It
does not consume the token, because the script needs the same token for the enrol call. An
unknown, expired or used token returns `TOKEN_INVALID`.

**Enrol exchange.** The route validates the token, marks it used, sets `enrolled_at`,
`session_expires_at` and `room_id` on the install row, retires any other active install for that
room, and returns the room session JWT with a 365-day TTL (D10). Unknown, expired and used
tokens all return `TOKEN_INVALID`.

### 4.3 Poll field additions

`GET /api/bench/commands` gains seven optional fields, in `app/api/bench/commands/route.ts` and
`lib/bench-commands.ts`: `install_id`, `app_version`, `build_sha`, `mic_state`,
`tape_advancing`, `never_sleep` and `launched_by`. Existing fields and cadences do not change. A
poll that carries `install_id` writes `last_seen_at` and the six state columns on that
`room_install` row. A poll without `install_id` behaves exactly as it behaves today.

### 4.4 The bootstrap script

The server renders this body for each token. The server substitutes the token, the origin, the
Blob URL, the sha256, the version and the room name.

```bash
#!/bin/bash
set -euo pipefail

APP="EvenScribe Room Recorder.app"
DEST="$HOME/Applications"
PLIST="$HOME/Library/LaunchAgents/com.evenscribe.room-recorder.plist"
TOKEN="<token>"
ORIGIN="<https origin>"
BLOB_URL="<blob_url>"
EXPECTED_SHA="<sha256>"
TMP="$(mktemp -d)"

echo "Downloading EvenScribe Room Recorder <version>..."
curl -fsSL -o "$TMP/app.zip" "$BLOB_URL"

echo "Verifying the download..."
ACTUAL_SHA="$(shasum -a 256 "$TMP/app.zip" | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "Checksum mismatch. Install stopped. Nothing was changed."
  exit 1
fi

echo "Stopping any earlier copy..."
launchctl bootout "gui/$(id -u)/com.evenscribe.room-recorder" 2>/dev/null || true

echo "Installing into ~/Applications..."
mkdir -p "$DEST"
ditto -x -k "$TMP/app.zip" "$TMP/expanded"
rm -rf "$DEST/$APP"
ditto "$TMP/expanded/$APP" "$DEST/$APP"

echo "Enrolling this Mac..."
"$DEST/$APP/Contents/MacOS/room-recorder" enrol --token "$TOKEN" --origin "$ORIGIN"

echo "Installing the LaunchAgent..."
"$DEST/$APP/Contents/MacOS/room-recorder" install-launch-agent

echo "Starting the app..."
launchctl bootstrap "gui/$(id -u)" "$PLIST" || launchctl load "$PLIST"

rm -rf "$TMP"
echo "Installed and enrolled as <room name>. Close this window."
```

The script writes only inside `$HOME`. The script never calls `sudo`. The script runs with
stdin owned by the pipe, so no command inside it may read from the keyboard. The `enrol` verb
takes everything from its arguments. The existing `login` verb, which requires a TTY, is not
used on this path. A re-install on a Mac that already runs the app is the same paste: the
`bootout` line stops the earlier copy first, and the enrol exchange retires the earlier install.

### 4.5 Listener supersession rule

`bench_listener` holds one row for each room. The last writer wins.

1. The app listener `tab_id` is `app_<install_id>`. The app writes no other form.
2. An enrol exchange sets `retired_at` on any other active install for that room.
3. A poll from a retired install returns 409 `RETIRED`. The app stops polling.
4. The retired install never writes `bench_listener` again, so the new install owns the row.
5. `POST /api/admin/installs/{installId}/retire` performs the same supersession by hand.

---

## 5. App contract

### 5.1 Bundle layout

Layout per `ETA-APP-BUILD-B-DESIGN-PROVENANCE-26-AUG-2026.md` lines 433 to 445. X2 is closed, so
the vendored encoder ships inside the bundle.

```
EvenScribe Room Recorder.app/
  Contents/
    Info.plist
    MacOS/room-recorder
    Helpers/tapewriter
    Helpers/ffmpeg
    Resources/LGPL-NOTICES.txt
```

`Contents/Helpers/ffmpeg` is the output of `Encoder/build-ffmpeg.sh`, signed with the in-house
certificate under identifier `com.evenscribe.room-recorder.ffmpeg`. The app no longer uses
Homebrew ffmpeg. `Resources/LGPL-NOTICES.txt` carries the FFmpeg and libopus notices.

### 5.2 Info.plist keys

| Key | Value |
|---|---|
| `CFBundleIdentifier` | `com.evenscribe.room-recorder` |
| `NSMicrophoneUsageDescription` | **APPROVED by V, 8 Sep 2026:** "EvenScribe records this consultation room so the clinician's notes can be written from what was said." Lives in `apps/room-recorder/Packaging/MicrophoneUsageDescription.txt` so changing it is one line and a rebuild. |
| `LSUIElement` | `true` |
| `LSMinimumSystemVersion` | `15.0` |
| `CFBundleShortVersionString` | the build version, written by the packaging script |

The bundle declares no `CFBundleURLTypes`. The URL scheme is gone with D2.

### 5.3 The enrol CLI verb

The app gains one CLI verb. The bootstrap script calls it.

```
room-recorder enrol --token <token> --origin <https origin>
```

1. The verb rejects any `--origin` that is not an https URL on an allowed host. The allowed host
   list is a compile-time constant.
2. The verb posts `{ token }` to `POST /api/room-recorder/enrol` at that origin.
3. On 200 the verb writes the session, the `install_id` and the origin to the keychain. It exits
   with status 0.
4. On any other response the verb prints the failure and exits with a non-zero status. The
   script then stops, because `set -e` is active.

5. **The device.** On a Mac with no existing config the verb takes the CURRENT system default
   audio input and stores its UID. There is no `--device` argument, no prompt, and no refusal when
   several inputs exist. On a re-enrol the existing config KEEPS its device — a room already
   recording is not moved onto whatever was plugged in most recently. Ruled by V, 8 Sep; see §12.6.

The app performs no self-copy and registers no URL scheme. The script places the bundle.

### 5.4 Keychain item

One generic password item in the login keychain.
Service `com.evenscribe.room-recorder.room-token`.
Accessibility `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
The item holds the room session JWT, the `install_id` and the origin. `config.json` holds no
token.

### 5.5 Heartbeat additions and derivations

The app adds the seven poll fields of §4.3 to every poll. The cadences of R2 do not change.
There is no refresh call, because D10 gives the install session a 365-day TTL.

| Reported value | How the app derives it |
|---|---|
| `install_id` | read from the keychain item written at enrolment |
| `app_version` | `CFBundleShortVersionString` of the running bundle |
| `build_sha` | a build-time constant written by the packaging script |
| `mic_state` | `AVCaptureDevice.authorizationStatus(for: .audio)`, mapped to the four strings |
| `never_sleep` | run `pmset -g`, parse the `sleep` value, report true when the value is 0 |
| `tape_advancing` | the existing tape health signal of R5, which is the durable sample index growing |
| `launch_agent_loaded` | the LaunchAgent plist exists at the resident path and `launchctl` lists the label |
| `launched_by` | `launchd` when the parent process id is 1, else `user` |
| `input_device_name` | CoreAudio's name for the device `config.json` names, read at the moment of the poll. Omitted when that device is not attached. **Added 8 Sep by V's ruling; see §12.6.** |

**Invariant.** No reported value is typed by a person. No reported value is a constant that
stands in for a measurement. Every value in the table comes from the machine at the moment of
the poll. This rule caught two silent labelling incidents.

---

## 6. The fleet card (D13, D11)

Placement is D3. A third card inside `/admin/bench`, beside Rooms and Rooms Live, in
`components/admin/BenchClient.tsx`. It follows the pattern of
`components/admin/BenchRoomsLive.tsx`.

**Header.** Latest stable version, publish time, and a Withdraw action. With no published
release the header reads "No release published yet" and every Copy install command action is
disabled.

**Rows.** One row for each room.

| Field | Source |
|---|---|
| Room name | `room` |
| Bound install | `room_install.hostname` and `hardware_model`, or "Not installed" |
| App version | `room_install.app_version`, next to the latest release version |
| Last seen | `room_install.last_seen_at`, shown as a relative time |
| Mic | `room_install.mic_state` |
| Tape | `room_install.tape_advancing` |
| Session | `room_install.session_expires_at`, shown as "session expires in N days". A warning appears at 30 days or fewer. |
| Actions | Copy install command, Retire |

Copy install command calls the bootstrap-token route and puts the returned `command` on the
clipboard. The same action re-enrols a room, because a new token retires the old install.

**States.** `not_installed`, `enrolling`, `healthy`, `needs_attention`, `retired`.
`needs_attention` covers mic denied, tape not advancing, a session expiring within 30 days, and
a last seen older than the alarm window. The alarm window value is UNKNOWN, builder to establish
against an ordinary day, per R18.

**Polling.** The fleet read polls every 20 seconds while the card is open. The open checklist
polls every 3 seconds. Both cadences match the existing Rooms Live monitor.

**Checklist steps.** Five steps. Each step shows exactly one of done, waiting or blocked. A
blocked step shows one instruction.

| # | Step | Turns done when | Turns blocked when |
|---|---|---|---|
| 1 | Command copied | The page copies the command. This is the only page-driven step. | Never. |
| 2 | App running on \<hostname\> (\<model\>, \<os\>), started by launchd, \<time\> | The first poll carrying this `install_id` reports `launched_by = launchd`. | That poll reports `launched_by = user`. The instruction is to report it. |
| 3 | Microphone allowed | A poll reports `mic_state = authorized`. | A poll reports `mic_state = denied`. The instruction gives the System Settings path. |
| 4 | Tape advancing | Two consecutive polls report `tape_advancing = true`. | Never. It stays waiting. |
| 5 | Machine settings | Never sleep turns done on a poll with `never_sleep = true`. | Never. Automatic login stays a reminder with its System Settings path and never turns done. |

**The rule.** The page never asserts completion from its own actions. The single exception is
step 1, which carries the label "Command copied" and never the label "Installed".

---

## 7. Self-update, Build R3 (D12, amends R9)

1. The app calls `GET /api/room-recorder/release?channel=stable` on launch and every 6 hours.
2. The app compares the returned `version` with its own `CFBundleShortVersionString`. A
   different version is an update, in either direction. This makes withdraw a rollback.
3. If a recording session is open, the app does nothing and checks again at the next tick.
4. The app downloads the zip from the `blob_url` the route returned.
5. The app computes the sha256 of the downloaded bytes and compares it with the returned
   `sha256`. A mismatch stops the update and reports the failure.
6. The app expands the zip to a staging directory and runs `codesign --verify --strict`. It
   checks the authority against the expected in-house identity. A mismatch stops the update.
7. The app moves the current `~/Applications/EvenScribe Room Recorder.app` to
   `~/Applications/EvenScribe Room Recorder.app.previous`, replacing any earlier copy.
8. The app moves the staged bundle into place.
9. The app exits. launchd restarts it under KeepAlive.
10. The new copy reports its `app_version` and `build_sha` on the next poll. The fleet card shows
    the change. This is the only proof that the update landed.

The downloaded bundle carries no quarantine attribute, so no update meets Gatekeeper. The signing
identity is stable per D1, so the microphone permission survives every update.

**Rollback.** An admin marks a release withdrawn in the fleet card header. The release route then
returns the previous release that is not withdrawn. Each app sees a different version at its next
check and performs steps 3 to 10 with the older bundle.

---

## 8. Build split

Each build is one Claude Code kickoff. Each build carries its own migration and its own changelog
entry. A build without its changelog entry is not accepted.

### Build R1, server and admin

**Prerequisite:** none. R1 is kickoff-ready.

Scope. Migrations `007x` for `app_release`, `room_bootstrap_token` and `room_install`, and the
poll field additions of §4.3. The eight Build R1 routes of §4.2. The bootstrap script renderer of
§4.4. The Install and fleet card with the five-step checklist. No feature flag. Without a release
row the card reads "No release published yet" and the copy action is disabled.

Acceptance evidence V must see on production.

1. The three tables and the partial unique index present, read from the production database.
2. `/admin/bench` shows the Install and fleet card with four rooms and "No release published yet".
3. A release registered from a real Blob upload, with the server-computed `sha256` matching the
   local file.
4. A minted bootstrap token, its row in `room_bootstrap_token`, and the returned `command` string
   matching the one-liner of §4.2 exactly.
5. `GET /api/room-recorder/bootstrap/<token>` returning `text/x-shellscript` whose body contains
   the real Blob URL, the real sha256 and the real room name.
6. The same token posted twice to the enrol route. The second attempt returns `TOKEN_INVALID`.
7. An expired token posted to both bootstrap and enrol. Both return `TOKEN_INVALID`.
8. A poll posted by hand with a valid `install_id` and `launched_by = launchd`, after which an
   open checklist turns step 2 done and shows the hostname. The same poll with
   `launched_by = user` turns step 2 blocked.
9. An existing browser room kiosk still polls and records with no change in behaviour.

### Build R2, the app

**Prerequisite:** X1 and X3.

Scope. The bundle assembler script in `apps/room-recorder/Packaging/`, the Info.plist of §5.2,
the vendored encoder of §5.1, the `enrol` CLI verb of §5.3, the keychain item of §5.4, and the
heartbeat additions and derivations of §5.5. Signed with the in-house certificate. Output is
`EvenScribe-Room-Recorder-<version>.zip` and its sha256.

Acceptance evidence V must see on production.

1. The release published through `POST /api/admin/releases`, with `version` and `build_sha`
   matching the built bundle, and the server-computed `sha256` matching the local file.
2. One Mac taken from a blank state to recording with exactly one paste and one microphone Allow
   by V. V uses no other Terminal command.
3. The two items of §9 proven on that Mac, with the evidence each item names.
4. The checklist reaching done on steps 1, 2, 3 and 4 from server state alone.
5. `room_install` holding the true hostname, model, OS version, app version and build sha.
6. `security find-generic-password` showing the keychain item, and `config.json` holding no token.
7. A restart of the Mac, after which the app returns by itself and the tape advances again.
8. A second Mac enrolled into the same room. The first install shows `retired_at` set, and its
   next poll returns 409.
9. The bundled encoder in use, proven by the running helper path in the app log, with no Homebrew
   ffmpeg installed on that Mac.

### Build R3, self-update

**Prerequisite:** R1 and R2 proven on all four Macs.

Scope. §7 in full, the `GET /api/room-recorder/release` route, and the Withdraw action behaviour
in the fleet card header.

Acceptance evidence V must see on production.

1. One normal update on Home Office. The fleet card shows the new version after the swap.
2. One withdraw. The same Mac returns to the previous version at its next check.
3. The microphone permission unchanged across both swaps, with no new macOS prompt.
4. An update attempted while a session records. The app defers, and the log shows the deferral.
5. A deliberately corrupted zip. The app stops the update and reports it. The resident copy is
   unchanged.

---

## 9. Builder must establish on the first real Mac

These two items are for the builder, not for V. The builder proves each one during Build R2 and
reports the result before the build is accepted.

1. **Foreground microphone prompt from a launchd-started process.** tapewriter starts under
   launchd, not from a double click. The builder must establish that macOS raises the microphone
   prompt in the foreground for the logged-in room user. Evidence is a screenshot of the prompt
   and the following poll reporting `mic_state = authorized`. If the prompt does not appear, the
   builder stops and reports before Build R1 ships the step 3 copy.
2. **`launchctl bootstrap` from a script piped to bash.** The builder must establish that
   `launchctl bootstrap gui/$(id -u)` loads the agent when the script runs through
   `curl ... | bash`. The fallback in the script is `launchctl load`. Evidence is the launchd log
   and a poll reporting `launch_agent_loaded = true` and `launched_by = launchd`.

Two values in this document are UNKNOWN and the builder establishes them as well. They are the
`NSMicrophoneUsageDescription` string of §5.2 (**closed 8 Sep**, see §12.4) and the last-seen alarm window
of §6.

---

## 10. Out of scope

This module does not build any of the following.

1. MDM of any kind.
2. An Apple Developer ID certificate and notarization.
3. A `.pkg` installer or any installer that needs `sudo`.
4. Support for a Mac with more than one account in daily use.
5. Windows or any platform that is not macOS.
6. Remote uninstall. Retire marks a row. It does not remove software from a Mac.
7. Any change to the audio wire format. R2 of the Room Recorder PRD holds. The pieces stay five
   minutes of webm/opus, mono, on the same keys, through the same routes.

---

## 11. Open items for V

None. Every decision is ratified.

---

## 12. Build R1 addendum, 7 September 2026, evening

Build R1 shipped and was promoted the same evening. Production serves `61b6e13`. Migration
`0075_room_install` applied at 16:14 UTC. Report: `docs/handoff/ETA-INSTALL-BUILD-R1-REPORT-7-SEP-2026.md`
(commit `ecbd8e4`). Commits: `2c217f2` docs, `86c7c11` build, `35aed03` fix, `bf7ce0b` report,
`74e6d82` fleet filter fix, `61b6e13` runbook fix, `ecbd8e4` promote evidence.

### 12.1 Rulings by V on the builder's six questions, all accepted

| # | Ruling |
|---|---|
| R1-1 | `room_install` carries three columns beyond §4.1: `first_seen_at`, `tape_poll_streak`, `tape_advancing_since`. Step 4's "two consecutive polls" and step 2's start time need them. §4.1 is amended. |
| R1-2 | `launch_agent_loaded` is derived from `launched_by = launchd`, not sent as an eighth poll field. |
| R1-3 | Rate limits are 30 per minute on bootstrap and 10 per minute on enrol, per IP, in process. |
| R1-4 | R18's alarm window inherits `LISTENER_OFFLINE_MS`. It carries into Build R2. |
| R1-5 | The origin in the command comes from `ROOM_RECORDER_ORIGIN`, default `https://www.evenscribe.app`. Never from `APP_URL`, whose deployed value is a dead host. |
| R1-6 | `check:silent` reports 9 findings at `d7df4b1` before this build. Not this build's. |

### 12.2 Facts established during acceptance

- Vercel Blob store `eta-releases` (`store_P2RwHyh5DGHotPi6`, region sin1, public access)
  created 7 Sep and linked to the project for preview and production. Public access is
  required: the §4.4 script downloads with no credential. D7's premise that a token already
  existed was wrong. The store did not exist before this build.
- `vercel promote` of a preview rebuilds the same commit against the production environment.
  Production runs a fresh build of `61b6e13`, not the artifact acceptance ran on.
- Vercel Blob deletion lags at the edge by about 30 seconds. R3 must rest rollback on withdraw,
  never on a 404.
- The fleet read filters rooms the way `lib/admin/rooms-live.ts` does, plus one clause: a room
  with a live install is shown whatever its state.
- Acceptance: items 2, 3, 4, 5, 6, 8, 9 proven on preview, item 9 proven again on production
  across the alias flip (Home Office kiosk never dropped). Items 1 and 7 partial.

### 12.3 Carried into Build R2

1. Item 1: read `pg_indexes` for `uq_room_install_active_room` from a SQL session. Inferred so far.
2. Item 7: prove the expired arm of `TOKEN_INVALID` with a real token left 30 minutes.
3. Delete the probe install row `install_7fs9pxt8gdcf` (§8.5 of the report has the statements).
   The nightly job never removes it because it was enrolled.
4. `room_bootstrap_token.install_id` has no foreign key. Add it in R2's migration.
5. A kiosk recording across a deploy is still unobserved.
6. Prerequisites X1 (certificate) and X3 (build Mac) are still open. R2 cannot ship a zip
   without them.


### 12.4 Ratified 8 September 2026

**X1 CLOSED.** The in-house signing identity exists, is trusted for code signing, and has been
proven to sign and verify.

| | |
|---|---|
| Common name | `EvenScribe Room Recorder Code Signing 1` |
| Identity SHA-1 | `187DD424FB866204111113D60C6F88A21D098EDB` |
| Certificate SHA-256 | `903EDCE6F78C2199DFF45939D492041FED0C0A8394DDABB985278349BB281643` |
| Subject | `CN=EvenScribe Room Recorder Code Signing 1, C=IN` |
| Validity | 7 Sep 2026 → 4 Sep 2036 |
| Location | login keychain, `Vinays-Mac-mini-3` |

Both values are public. The SHA-1 is pinned in `Packaging/build-bundle.sh` — by hash rather than
by name, because a name is ambiguous and D1 binds the microphone grant on all four Macs to this
exact identity. Proven 8 Sep: a scratch binary signed with it reads
`Authority=EvenScribe Room Recorder Code Signing 1`, satisfies
`-R '= anchor trusted and certificate leaf = H"187dd424…"'`, and FAILS that requirement when
pinned to any other leaf — so the check discriminates rather than merely passing.

**ESCROW IS STILL OPEN AND IS V'S.** The private key was never exported. From the first clinic
install onwards D1 makes it unlosable without a fresh microphone grant on every Mac, so the
`.p12` export should happen before Build R2's first paste, not after.

**BUILDS HAPPEN AT THE CONSOLE.** No scripted `unlock-keychain`, no second keychain. Established
8 Sep in both directions: `codesign` over SSH fails with `errSecInternalComponent`; the same
command at the console succeeds. `security find-identity -v` succeeds in BOTH, so it cannot be
used as the guard — `build-bundle.sh` trial-signs a disposable file in preflight instead.

**DEPLOYMENT TARGET IS macOS 15.0, SET EXPLICITLY.** The toolchain on the build Mac defaults to
`macosx28.0`, which would not launch on the clinic Macs.

### 12.5 Carried out of Build R2's first session

1. ~~The Swift test suite could not be compiled~~ **CLOSED 8 Sep, without Xcode.** Command Line
   Tools 27.0.0.0.1787197235 ships `Testing.framework`, so `swift test` resolves the module and
   the macro plugin. Xcode is NOT installed on the build Mac and was not needed. Two caveats
   stand: `swift test` works only through the Xcode-style build system (`swift build
   --build-tests` uses the legacy one and cannot load `TestingMacros`), and the framework is not
   on the runtime search path, so it and `lib_TestingInterop.dylib` must be staged into the
   `.xctest` bundle before the tests will launch. Staging them into `PackageFrameworks` instead
   shadows the real framework and silently disables the macros — do not.
   **451 tests in 39 suites pass.** The three `RoomEngineRemote` test doubles are now verified.
   Compiling the suite also found two stale `pollCommands` call sites that `148d04d` missed.
2. `production_ready` in `build-provenance.json` flips in `Packaging/build-bundle.sh` after
   signing, not in `Encoder/build-ffmpeg.sh` as the R2 kickoff worded it. That script signs
   nothing, so the flag there would have been false. Deviation flagged, intent met.
3. Items 1 and 7 of Build R1's acceptance remain partial (§12.3), both needing a SQL path into
   production.

### 12.6 Ruled 8 September 2026 — the device, after the first paste failed

The first real paste on Home Office got through download, checksum and install, then died on
`RoomRecorderCore.RoomConfigurationError error 6` **after** the server had spent the enrol token
and the keychain had been written. The script had already booted the old agent out, so Home Office
was left with nothing polling.

**Cause.** `RoomConfiguration.residentDefault` filled `deviceUID` from `stableDeviceUID()`, which
read the `hw.uuid` sysctl. That OID does not exist on macOS 26/27 — `sysctl hw.uuid` answers
`unknown oid` — so the guard threw `invalidDeviceUID`.

**Two separate mistakes, and the second is the worse one.** `deviceUID` is an AUDIO DEVICE: it is
passed to `tapewriter record --device`, reported as the session's mic label, and sealed into the
archive index as `stableDeviceUID`. A machine UUID there names no input, so repairing the sysctl
alone would have produced an enrol that succeeded and a room that recorded nothing.

**Read the error code, do not count the cases.** `error 6` was first read off the enum's
declaration order as `unsafeRoot` and sent the diagnosis to the filesystem. Swift bridges cases
carrying associated values FIRST, so 6 is `invalidDeviceUID`. `RoomInstallDeviceTests` now pins
the whole mapping.

**V's ruling.**

| | |
|---|---|
| At enrol | Take the current system default audio input, store its UID in `config.json`. |
| Argument | None. No `--device`, no prompt, no refusal when several inputs exist. |
| Re-enrol | An existing config KEEPS its device. Only a first enrol chooses one. |
| Poll | Report the device NAME as an eighth field, same rules as the others: derived, never typed, omitted rather than guessed. |
| Fleet card | Show it on the row beside the mic state. |
| `hw.uuid` | Deleted entirely, not repaired. Nothing needs a machine identifier — `install_id` is server-minted. If a future caller needs one, `IOPlatformUUID` via IOKit is the supported route. |

Migration `0077_install_input_device_name` adds the column. Not run.

### 12.7 Ruled 8 September 2026 — the session had no reader

The re-paste enrolled cleanly and then never polled. `status.json` read
`{"state":"offline","last_error":"missingSessionCookie"}` while the machine held a perfectly good
365-day session.

**Cause.** §5.4 says the session lives in the keychain and `config.json` holds no token. Only the
writing half existed. `enrol` saved the record and nilled `etaRoomSession`; `run` built its
`BenchClient` from `config.json` alone. `RoomKeychain.load()` WAS already called in
`RoomEngine.init` — for `installID` and `listenerTabID` — and the `session` field it returned was
read and discarded. `enrolled.session.token` appeared exactly once in the whole codebase, at the
write. Every poll went out with no cookie.

**V's ruling.**

| | |
|---|---|
| Home | The keychain is the only home for the session. `config.json` never holds it. |
| Where | Loaded in `RoomEngine.load`, where the client is constructed — so every entry point gets it, not only `run`. |
| No session | Refuse loudly with a distinct state `needs_enrol`, and stop. Never poll unauthenticated in a loop. |
| Test | Prove the READ. The suite covered `enrol` writing the item and nothing covered anything reading it. |

Enforcement is structural, not conventional: `RoomPersistence.saveConfiguration` strips the session
on the way to disk, so no future writer can put a token in a file by forgetting to. The refusal
exits ZERO, because the LaunchAgent carries `KeepAlive = { SuccessfulExit: false }` and a non-zero
exit would have launchd restart it for ever.

**Third instance of the standing rule.** A stated guarantee is not an implemented one.

1. R1: `room_bootstrap_token.install_id` was specified as a foreign key in §4.1 and shipped without
   one. Caught by V reading the migration against the spec (§12.3 item 4, fixed by `0076`).
2. R2: `production_ready` was asserted for the vendored encoder while the bundle it described was
   signed after the verify step, so the zip carried a broken signature and the build reported green.
3. R2: §5.4's "the session lives in the keychain" — written, never read.

Each was a sentence everyone believed. In all three the half with a test was the half that was
real; the other half had prose. `input_device_name` and the keychain read now both have tests
because of this, and §12.6's device rule is enforced by `applyEnrolment` rather than by a comment.

### 12.8 The same bug twice — 0.1.2 fixed the read and still could not poll

0.1.2 shipped §12.7's fix and the re-paste polled with `missingSessionCookie` exactly as before.

`RoomEngine.load` hydrated the session correctly and handed it to `remoteFactory`. The CLI's `run`
passed `remoteFactory: { _ in bench }` — **a factory that ignores its argument** — with `bench`
built from `loadConfiguration()`, which by §5.4 carries no session. The hydrated configuration was
computed, passed, and discarded.

The tests did not catch it and could not have. `loadHandsTheKeychainSessionToTheClientItBuilds`
asserts the factory RECEIVES the session, which was true. Production's factory threw it away.

**The fix.** `RoomEngine.startingConfiguration(rootURL:enrolmentReader:)` is now the single source
of a starting configuration: it loads from disk, adds the keychain session, and refuses with
`needs_enrol` when there is none. `load` uses it, `run` uses it, and `markConsult` — which had the
same defect and would have posted unauthenticated — uses it. `login` is the one exemption and is
marked `SESSION_EXEMPT` in the source, because it is the verb that obtains a session.

**The guard is source-level, because the defect is in what a caller does with a correct value.**
`noClientIsBuiltFromABareOnDiskConfiguration` walks `Sources/` and fails on any `BenchClient`
built from a configuration that did not come through `startingConfiguration`. Its first version
did not discriminate — it scanned raw lines and was satisfied by the word `startingConfiguration`
appearing in the COMMENT above the offending call, so it passed with the bug deliberately
reintroduced. It now strips comments before applying the rule, and reads the exemption marker from
the raw line. Verified in both directions: passes clean, fails with 0.1.2's bug restored, passes
again on revert.

**Fourth instance of the standing rule**, and the sharpest: the guarantee was implemented, tested,
and still not delivered, because the test asserted the half that worked.

### 12.9 §9 hazard 1 is NOT established — the microphone prompt does not appear

Driven by the builder on Home Office, 8 September, with V out of the loop for the debug cycles.

**What works.** The paste installs, enrols, and polls. Steps 2 and 5 turn DONE on the first poll,
which establishes §9 hazard 2: `launchctl bootstrap` from `curl | bash` gives
`launched_by = launchd`. All eight poll fields arrive, `input_device_name` included.

**What does not.** `start_day` reaches the app and tapewriter dies with
`microphone permission was not granted`. Two defects were found and fixed:

1. `tapewriter`'s embedded `CFBundleIdentifier` was `com.evenscribe.tapewriter` while its signature
   says `com.evenscribe.room-recorder.tapewriter`. Wrong on its own terms.
2. The HELPER was doing the asking. tapewriter is a bare Mach-O child; TCC attributes a request to
   the responsible process, which is the bundled app, and the app had never asked. The app now
   requests at startup so the dialog comes from the thing with a bundle and §5.2's usage string.

**It still fails.** After a successful `tccutil reset Microphone com.evenscribe.room-recorder`, the
app asks and is denied IMMEDIATELY with no dialog on screen. macOS writes a denial rather than
prompting. The likely mechanism is that a resident `LSUIElement` binary started by launchd, with no
`NSApplication`, has no UI context for TCC to attach a prompt to.

**And enabling it by hand did not take.** With both entries switched on in System Settings, the app
still reports `denied` across a fresh process (`runs = 2`). Its designated requirement is
identity-based and correct — `identifier "com.evenscribe.room-recorder" and certificate leaf =
H"187dd424…"` — so a grant should survive a rebuild. It did not.

**THE RISK THIS RAISES IS D1's WHOLE PREMISE.** If TCC is binding the grant to the cdhash rather
than to the designated requirement, then every new version loses the microphone and R3's acceptance
item 3 — "the microphone permission unchanged across both swaps, with no new macOS prompt" —
cannot hold. That must be settled before R3, and probably before the clinic installs.

Per §9's own instruction the builder stopped and reported. **§12.10 resolves it.** Open for V: whether to make the resident app a real `NSApplication` so TCC can
present the prompt, or to establish a different grant path.

**Two TCC entries exist on the build Mac** — the unsigned 27 Aug copy under `EvenScribeBench` and
the current signed bundle. The unsigned one is keyed by path and can never satisfy the signed app's
request; it is stale and should be removed, mainly because a pane that reads "on" while the app
reads `denied` is how an operator loses an hour.

### 12.10 §9 hazard 1 CLOSED — the hardened runtime, and what D1 depends on

**Root cause: the bundle was signed `--options runtime` and carried NO ENTITLEMENTS.** Under the
hardened runtime a process may not open an audio input without
`com.apple.security.device.audio-input`. The refusal happens INSIDE the process:
`AVCaptureDevice.requestAccess` returns denied immediately, no dialog is drawn, and `tccd` is never
asked — its log has nothing to say about the app at all.

That single fact explains every symptom: the instant denial, the missing prompt, the empty TCC log,
and why `tccutil reset` and switching the app on by hand in System Settings both changed nothing.

Two earlier fixes were each NECESSARY AND NEITHER SUFFICIENT, which is why the cause took three
cycles to find:

1. The helper was doing the asking (§12.9). tapewriter is a bare Mach-O child and TCC attributes to
   the responsible process, which is the bundled app.
2. The resident app was a plain command-line binary with no run loop. It is now an `NSApplication`
   with `.accessory` policy — no Dock icon, no menu bar, no window, which is what §5.2's
   `LSUIElement` always meant, now true of the process and not only of the plist. R3 needs this
   shape anyway: a self-update needs an app identity to replace.

`build-bundle.sh` now FAILS the build if the entitlement is absent from the signed bytes. A bundle
that signs cleanly without it looks perfect and cannot open a microphone.

**THE GRANT SURVIVES A VERSION SWAP — D1 HOLDS.** The open question of §12.9 is answered. 0.1.6 held
the grant; 0.1.7 was installed by the ordinary paste with NO `tccutil reset`:

| | |
|---|---|
| cdhash before | `1d5b804bc28d153f71deca9965fb55123688c4c8` |
| cdhash after | `1e72c93a9cb18a44d496be7f9065e622db7dfdd2` |
| designated requirement | unchanged — `identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424…"` |
| result | `microphone authorized`, immediately, no prompt |

TCC binds the grant to the DESIGNATED REQUIREMENT, not to the cdhash. R3 acceptance item 3 — "the
microphone permission unchanged across both swaps, with no new macOS prompt" — is achievable, and
D1's premise that the in-house certificate carries the grant across versions is sound.

### 12.11 `tape_advancing` was measuring the piece cursor

With the microphone granted, the room recorded for ten minutes, wrote 20 MB of durable audio with a
growing index and an empty error log — and the card still read `tape=false/streak=0`.

`currentDurableSampleIndex` returned `segment.nextSample`, the PIECE-CUTTING cursor, assigned in
`publishAvailable` once every five minutes. `tapeIsAdvancing` compares it between polls four seconds
apart, so it reported false on almost every poll and §6 step 4 — which needs two consecutive polls —
could essentially never turn done.

It now reads the durable frontier from the index tapewriter appends to. A record lands there only
after its audio is durable, so the index growing IS §5.5's "durable sample index growing" — one
`stat` per poll rather than re-reading a file that reaches tens of megabytes over a clinic day.

**Checklist green on 0.1.7**, Home Office, `install_5bt4ue32w3vv`:
steps 2, 3, 4 and 5 DONE; `tape=true streak=7`, advancing since `05:34:30.711Z`;
`mic=authorized`; `DEVICE=TONOR TM20 Audio Device`; `launched_by=launchd`; `never_sleep=true`.

**Still open:** the stale unsigned microphone entry. `tccutil` takes bundle identifiers only and the
old unsigned binary has none, so it cannot be targeted; a bare `tccutil reset Microphone` would wipe
the working grant too. It needs the "−" button in System Settings, or the old binary moved aside.
