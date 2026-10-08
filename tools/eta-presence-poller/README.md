# eta-presence-poller
Polls room machines over ssh for idle, lock and browser state and posts presence events to the sink (jsonl spool fallback). See `NOTES.md`.
Config: copy `hosts.example.json` to `hosts.json` (git-ignored). Token and URL come from env (`PRESENCE_INGEST_TOKEN`, `PRESENCE_INGEST_URL`) or local files; none are in this repo. `deploy/com.eta.presence-poller.plist` has placeholder paths.
Tests: `python3 -m unittest discover -s tests`
Snapshot of a private repo (no history).
