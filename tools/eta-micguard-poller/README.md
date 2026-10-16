# eta-micguard-poller

Reads each room Mac's mic-guard heartbeat over ssh (read-only) and posts one `mic_guard` event per room to `/api/kiosk-health`. Python 3 standard library only.

## What it reads on a kiosk
One fixed read-only ssh command per room: the guard's `.last` line, the file's mtime, and today's `RESTORED` lines of the guard log. Nothing is written, nothing is installed, no sudo.

## States
ok, restored, read_error, missing, write_failed, db_missing, stale, not_installed.
- stale: `.last` older than 300 s (reason `line_old`), or ssh failed or timed out (reason `ssh_unreachable`).
- not_installed: config says `installed: false`, or the room has no `.last` file.
- A line the poller does not recognise is `read_error` with reason `unparsed`. Raw line text is never forwarded.

## Event
kind `mic_guard`, source `mini_micguard_poller`, install_id `mini-micguard-poller`, boot_id = the state file's creation epoch, seq monotonic.
Payload: `state, reason, last_line_at, age_s, restored_today, last_restored_at`.
A room posts when its state, reason or restored_today changed, or its last post is 300 s old or more. Restored times are read as IST wall-clock.

## Setup
1. Copy `kiosks.example.json` to `~/.config/eta-micguard/kiosks.json` (or set `MICGUARD_KIOSKS`) and fill in your own rooms. Keep it out of git.
2. Put the ingest token in a 0600 file at `~/.claude/secrets/kiosk_health_ingest_token` (or set `MICGUARD_TOKEN_FILE`). If the file is missing the poller logs and exits 0 without posting.
3. Optional: `MICGUARD_INGEST_URL` (default `https://evenscribe.app/api/kiosk-health`), `MICGUARD_STATE` (default `~/.local/state/eta-micguard/state.json`).
4. Copy `com.eta.micguard-poller.plist.example` to `~/Library/LaunchAgents/`, fix the paths, `launchctl load` it. It runs `poll.py --once` every 60 s.

## Test
`python3 -m unittest discover tools/eta-micguard-poller`
