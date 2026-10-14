# Room alert relay (herdr-kit, Fable ruling 137)

Pulls the Room Watchdog's alert outbox from the app (read-only MCP tool `scribe_room_alerts`) and posts each alert to the bus.
Bus only, no board sink. Runs on the Mini as a LaunchAgent. It makes outgoing calls only. Code: `room-alert-relay.py`; tests:
`python3 kit/test_room_alert_relay.py` (41 tests; 24 mutations killed); template: `com.eta-lab.room-alert-relay.plist`.

**STATUS: built and tested against mocks. NOT installed, NOT running.** It cannot run for real until ALL of these are true:
1. The read door is in production: branch `vinay/watchdog-outbox` rides its own train after 7e7d4e3, and Fable has applied migration 0119 by hand first.
2. A dedicated read-only token exists (an `SCRIBE_MCP_TOKENS` entry with scopes `["read"]`) and is saved at `~/.claude/secrets/room_alerts_relay_token`
   (mode 600, on the Mini). The relay reads it from that file; it is never on argv, never in the plist, never logged.
3. `RELAY_MCP_URL` in the plist is the app's `/api/mcp` URL (header form, Bearer). Not the `/api/mcp/<key>` form: that puts the token in the URL.
   The relay refuses any URL that is not `https://` (checked before anything is sent) and refuses EVERY redirect (301/302/303 would otherwise carry the
   Bearer token to another host; eta-refuter #516, proven with a canary). Both fall into SILENT (a).

**What it does each poll (60 s):** call the tool with `after_id`, an adaptive `lookback_minutes`, `limit=50`; post `new` then `late` rows to `conductor`
(urgent for offline / degraded / fleet_outage, normal for recovered) under bus thread `room-alert-<id>`, skipping any id whose thread exists; advance the
cursor to the highest id in `new` only after every post succeeded; page again at once while `new_truncated`; write `bus/relay-room-alerts.last-poll`.

**Late-committer window (scribe #517).** `late` is every row with id <= the cursor created in the last `lookback_minutes`, so it holds the recent already-delivered
alerts and reaches its cap of 200 only in a fleet-wide storm. A row can commit late by about the cron's 60 s, so the relay asks for 3 minutes plus the gap since its last
successful door read (10 minutes on the very first poll), capped at the tool's ceiling of 60. A relay that was down still covers rows that committed late just before it
stopped. **Known limit:** after an outage longer than 60 minutes a row that committed late right before the outage falls outside the window and is missed.
The `new` set (id > cursor) is unaffected and always catches everything after a restart.

**SILENT conditions** (posted once when they start, one recovery when they clear, then re-armed; the current set is re-posted at process start at most
once per 30 minutes unless it changed):
- (a) the door cannot be read: no URL/token, network error, non-200, bad body, `ok` not exactly `true`, missing lists, a row without an integer id.
- (b) the heartbeat is not provably healthy: only `state == "ok"` with `age_s` a real, non-bool, finite number with 0 <= age_s <= 300 counts.
- (c) `late_truncated` is true: the late set has no cursor, so paging cannot fetch more; rows committed late may be unseen. (Paging `late` again does not help.)
- `bus`: posting failed, cursor not advanced; visible only in the last-poll file (the bus is the thing that is down).

**F6(c), for conductor:** each cycle read `bus/relay-room-alerts.last-poll` (one line: `epoch=<unix> iso=<IST> status=OK|SILENT:<a,b,c,bus> cursor=<n>`).
If `epoch` is more than 10 minutes old, or the file is missing once the relay is installed, post. The file, the state file and the lock
(`bus/relay-room-alerts.*`) are gitignored beside `bus.db*`.

**Single instance:** a kernel flock on `bus/relay-room-alerts.lock` for the process's life (pid in the file is for humans only).

**Token path and the first-poll check (eta-refuter #583, ruling 154).** The relay's token is registered through the additive `SCRIBE_MCP_TOKENS_EXTRA`
(a plain readable Vercel variable that Fable sets; herdr-kit only mints the token file). It audits as `mcp:extra:room-alert-relay`. The production
`SCRIBE_MCP_TOKENS` is write-only, so nobody can confirm beforehand that it is fully readable, and ONE unparseable old entry (no scope list, or a non-hash
key) makes the app ignore EVERY extra entry, the relay's included. That fails loud: the relay goes SILENT (a) with `http 401`, and Vercel logs
`[mcp-auth] SCRIBE_MCP_TOKENS is not fully readable; ignoring all N entries`. **After the deploy the relay's FIRST poll must return 200. If it returns 401, read
that Vercel log line before suspecting the token or its hash.** (The hash is `sha256` of the bare 64-character token, no trailing newline.)

**Install (only when the prerequisites hold):** copy the plist to `~/Library/LaunchAgents/`, set `RELAY_MCP_URL`, `launchctl bootstrap gui/501 <plist>`.
**Stop:** `launchctl bootout gui/501/com.eta-lab.room-alert-relay`.
