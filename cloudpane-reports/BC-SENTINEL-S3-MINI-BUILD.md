# BC-SENTINEL-S3-MINI-BUILD (lane bc-s3m, branch bc/sentinel-s3-mini)

## Build 1 (brief bc-s3m.md)
- consult_hold.py: consult_live decision + `live()` + background snapshot; subscriber.py: `CONTROL_RE_V3` (form 3, sort_keys) + canonical/validate + `Subscriber(consult_live=)`; run_subscriber.py wiring; ubus_bus.py: `consult_live_publish` (default false, literal-true-only).
- `tests/test_consult_live.py` (23 tests initially). Nothing in kiosk/, no TypeScript, no config file.

## FIX ROUND (fable: SENTINEL-CONSULT-OPEN-SPEC-17OCT.md BINDING where it differs)
- (a) an open older than 4 h with no close: FALSE source=no_event (was absent). (b) URL-driven open only: TRUE, confidence medium (`url_open`); a POST open survives a later URL close. (c) multi-machine rooms: ALL machines fresh else absent (pinned). (d) snapshot older than 60 s (new `LIVE_SNAPSHOT_MAX_AGE_S`; the hold keeps its 90 s): whole map absent + `snapshot_stale` record. (e) status record per the spec §1 table — room_id, consult_live, source (9 tokens), ts UTC ISO 8601, event_ts, hb_age_s, confidence — one line per room per change at `<home>/state/consult_live.jsonl`; written whenever the hold is built (the spec's bench day is status-file-only, before the wire); `heal_eligible()`: only a high-confidence post_open true may drive a heal — medium NEVER.
- Files: `subscriber/consult_hold.py` (spec §2 rule table in `_room_live_rec`, record writer, 60 s bound, `heal_eligible`, build/probe), `tests/test_consult_live.py` (rewritten: 29 tests = spec §5 cases 1-13 incl. mutants a/b/c + control-line contract).
- Wire unchanged: form 3, bools, sort_keys; flag-off byte-identical to base (golden strings); consult_open bytes unchanged (case 12, 20 scenarios).

## Tests (exact summary lines)
- Base (bffc52f7, temp worktree): `Ran 402 tests in 46.589s` / `OK (skipped=15)`.
- Full mini suite (`tests/run.sh`: shellcheck + unittest): `Ran 431 tests in 51.252s` / `OK (skipped=15)`, exit 0. +29 vs base, 0 new failures, 0 new skips.
- New file alone: `Ran 29 tests in 0.056s` / `OK`.
- Mutants (spec §5.13; each applied, run, reverted — all killed): (a) stale-hb returns false: `FAILED (failures=3)`; (b) prefix machine match: `FAILED (failures=1)` — case 10, opd-4-ortho cross-wired to TRUE; (c) medium confidence heals: `FAILED (failures=1)` — case 13c.
- TS/swift/kiosk gates: not run (no such files touched).

## Assumptions
- Case 12 "20 recorded snapshots": no recorded corpus exists in the repo, so 20 synthetic snapshots (room counts 1-5, kill on/off, mixed hold values); flag-off line == base serialisation byte for byte, flag-on line carries the same consult_open substring.
- The status file is written whenever the hold is built (consult_open_publish on) regardless of the wire flag — required by the spec's rollout step (3) "status file only, no wire".
- Decision order: newest POST open (<= 4 h) > newest POST close > newest enc open (<= 4 h, url_open) > newest enc close > no_event. Hence a URL open newer than a POST close does NOT re-open (post_close wins — fail-safe false).
- hb_age_s = the OLDEST (max) heartbeat age across the mapped machines; null when any mapped machine has no hb row.
- Brief's base count (40 tests, 7 skipped) is stale for origin/main; measured base is 402/15.

## Open risks
- The kiosk form-3 parser still ships first (release order); the flag stays default false until every kiosk accepts it.
- The S3 bench (1 clinic day consult_live vs scribe_now per room) needs the Mini; not run in this lane — the status file is ready for it.
- `heal_eligible()` is the Mini-side expression of the S5 consumer rule; the kiosk-side S5 heal must apply the same medium-never gate.
