# Rulings by V, 7 Sep 2026, on the v0.9 open items

Bias stated by V: simplicity and ease at install time. Security and PHI concerns are out of scope for this module by V's instruction (stakeholders, sysadmins and leadership have signed off). Do not write security sections. Keep only what a builder needs.

P1 RULED: Terminal one-liner, no Gatekeeper. The page shows a Copy button with one command. V pastes it in Terminal on the room Mac and presses Return. curl sets no quarantine attribute, so Gatekeeper never appears and no admin password is needed. The Download button and the self-copy-from-Downloads sequence are gone. D1 (in-house certificate) stands, but its Gatekeeper consequence no longer applies on the install path.

P2 RULED: Vercel Blob, not R2. `@vercel/blob` is already a dependency with a token in the project. Claude Code uploads the zip to Blob (client upload or server upload, builder's choice), then registers the release. The bootstrap script downloads from the Blob URL. No new bucket, no new key. `app_release.r2_key` becomes `blob_url`.

P3 RULED: keep the install registry as drafted (room_install, six poll fields, tab_id = app_<install_id>).

P4 RULED: one paste does everything. On the page V picks the room and clicks Copy. The command is `curl -fsSL "https://www.evenscribe.app/api/room-recorder/bootstrap/<token>" | bash`. The token is single-use, TTL 30 minutes, bound to the room and to a server-minted `install_id`. The server returns a bash script that: downloads the zip from Blob, verifies sha256, expands into `~/Applications/EvenScribe Room Recorder.app`, runs `room-recorder enrol --token <token> --origin <origin>` (the app exchanges the token at `POST /api/room-recorder/enrol` for the session and stores session + install_id + origin in the keychain), runs the existing `install-launch-agent`, and `launchctl bootstrap gui/$UID` loads it. The enrol code table, the URL scheme, the Allow dialog, and D5's hello route are all gone. Step 2 proof comes from the app's first authenticated poll carrying `install_id` and `launched_by = launchd`. Table `room_enrol_code` becomes `room_bootstrap_token` (token PK, room_id, install_id, created_by, created_at, expires_at, used_at).

P5 RULED: install sessions last 365 days, no refresh code. The enrol exchange signs the room JWT with a 365-day TTL for app installs. Human PIN logins stay at 30 days. The fleet card shows "session expires in N days" and warns at 30 days. Re-enrol = paste again (a new token retires the old install).

P6 RULED: five steps. 1 Command copied (page-driven, labelled exactly that). 2 App running on <hostname> (<model>, <os>), started by launchd, <time>, from the first poll with this install_id; blocked if launched_by = user. 3 Microphone allowed (mic_state = authorized; blocked with the System Settings path if denied). 4 Tape advancing (two consecutive polls true). 5 Machine settings: never sleep detected from the app's pmset report; auto-login shown as a reminder with the path, never marked done.

P7 RULED: keep self-update as drafted, Build R3, after R1 and R2 are proven on the four Macs. Download source is Blob.

P8 RULED: keep fleet rows as drafted. Actions per row: Copy install command, Retire. Re-enrol is the same Copy button.

A1 RULED: holds. Each room Mac has one user for that room, logged in once and left all day. The app installs under that user.

X2 RULED: ship the vendored ffmpeg now, LGPL notices bundled inside the app. The legal hold is lifted by this ruling. `Encoder/build-ffmpeg.sh` output goes into `Contents/Helpers/ffmpeg`, signed with the in-house certificate. Homebrew ffmpeg is no longer used by the app.

Consequences for §3 operator walkthrough (rewrite it): V at the Mac, logged in as the room user, opens /admin/bench in any browser, finds the room row, clicks Copy install command, opens Terminal (Spotlight, type Terminal), pastes, Return. Terminal prints progress lines from the script and ends with "Installed and enrolled as <room name>. Close this window." Within seconds step 2 turns done with the hostname. The mic prompt appears (from tapewriter, foreground prompt from launchd context, builder to prove); V clicks Allow, step 3 done. Step 4 done when the tape advances. Step 5 as ruled. Total on the Mac: one paste, one Return, one Allow, plus the System Settings visits for never sleep and auto-login if not already set.

Open questions for the builder to establish on the first real Mac (not for V): whether launchd-started tapewriter raises the mic prompt in the foreground for the logged-in user; whether `launchctl bootstrap gui/$UID` works from a script piped to bash (it should; fallback `launchctl load`). Build R2 acceptance keeps the "no Terminal by V beyond the one paste" test.

Build split stays R1 (server + card), R2 (app + packaging + bootstrap CLI verb), R3 (self-update). R1 no longer has any prerequisite. R2 needs X1 (certificate) and X3 (build Mac) only.
