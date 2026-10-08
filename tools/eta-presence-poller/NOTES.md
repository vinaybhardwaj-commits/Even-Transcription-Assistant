# Notes
- Transport: tailscale ssh first, then ssh accept-new. Live tick: tailscale ssh failed on all 7 (cause not investigated); the ssh fallback worked on all 7.
- A diagnostic rig host may be added to hosts.json once its address is known.
- Sink smoke 30 Sep 09:54Z: POST of one event (machine=<test-host>, ts 2026-09-30T09:54:19Z, idle_s int, locked 0, chrome_running 1, console_user string, state ok, poller_version 1.0.0) returned 200 {ok:true,inserted:0,rejected:1,count:0}. Sink gives no reason. Cause: sink requires locked and chrome_running as JSON booleans. Fixed; re-smoke 09:58Z gave 200 inserted:1 rejected:0.
- Unknown lock state (-1) and unreachable hosts emit locked=null, chrome_running=null. Whether the sink accepts null is UNVERIFIED (not smoked).
- Secrets (superseded): read from env ETA_PRESENCE_URL / PRESENCE_INGEST_TOKEN, else files of the same names under ~/.claude/secrets. File names are assumed (I did not list the directory). Missing either -> JSONL fallback in ~/eta-data/presence/YYYY-MM-DD.jsonl.
- hosts.json format is Fable's ({hosts:[{name,target,room}]}); machine_id = name. Unreachable event: idle_s, chrome_running, console_user are null, locked is -1. Schema fields are unchanged.
- Probe is my own (probe.py in ~/oc/presence-poller could not be read). Lock: Quartz via /usr/bin/python3 only if `xcode-select -p` succeeds, else ioreg IOConsoleLocked in shell.
- POST body: JSON array of events, Authorization: Bearer. URL env PRESENCE_INGEST_URL (default https://www.evenscribe.app/api/presence). Token: env PRESENCE_INGEST_TOKEN, else PRESENCE_INGEST_TOKEN_FILE, ~/.config/eta-presence/ingest.token, a legacy token file. Delivery (poller-fix-01/02): oldest first, chunks of <=200 items and <=900,000 body chars, each accepted chunk leaves the spool; at most ~15 s of posting per tick, the rest waits (result 'partial', no backoff). 2xx is delivered (even rejected>0). 413 splits and retries, never drops. 400/422 bisect to one item, which is moved to dropped.jsonl and logged. 401/403/404/408/425/429, 5xx, 3xx, network and timeout keep the data (exponential backoff, cap 8 min) with a 24 h expiry by age. Every failed POST and every tick with a non-empty spool writes a line to poller.log (no URL, no token).

# Run
- launchd (install): cp deploy/com.eta.presence-poller.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.eta.presence-poller.plist
- nohup alternative: cd ~/dev/eta-presence-poller && nohup python3 -m poller.main >> ~/eta-data/presence/poller.log 2>&1 &
- Tests: python3 -m unittest discover -s tests
