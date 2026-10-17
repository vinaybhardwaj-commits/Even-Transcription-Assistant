# BC-SENTINEL-S6-BUILD — room-sentinel state to Rooms Live (bc/s6, branch bc/sentinel-s6 from 24843eab)

## Files
- lib/sentinel-ingest.ts (new): kind/source constants, the 8-code / mic_class / mode closed sets, strict `validateSentinelPayload` (all keys required; zr/peak in [0,1]|null; last_* words 1..64|null; unknown code or shape -> reject).
- lib/sentinel-read.ts (new, cloned from micguard-read): newest sentinel row per room, one bound query on kiosk_health_events (kind='sentinel', (kind,ts) index, 24 h window); row > 600 s old by received_at -> NO DATA (view null); unrecognised code/class/mode fail closed (null / "unknown" / "shadow"); failed read -> `{byRoom:{},ok:false}`, never throws.
- app/api/kiosk-health/route.ts: new kind `sentinel` on the poller-token path (sha256 vs KIOSK_HEALTH_POLLER_TOKEN_SHA256, same as micguard poll.py); poller now scoped to (mic_guard, mini_micguard_poller) OR (sentinel, mini_sentinel_forwarder); one malformed sentinel row -> whole request 400 {ok:false,error:"bad_sentinel"}; daemon token unaffected. Storage: the existing kiosk_health_events table (0126) — no new table (the micguard path has one, so no STOP).
- lib/sentinel-read.ts read is fanned into lib/rooms-live/snapshot.ts `buildSnapshot` (`safe("sentinel", ...)` in the main Promise.all, pinned clock `now`): RoomRow gets `sentinel: SentinelView | null`, attached LAST in the row literal so JSON key order = old shape + sentinel. Row-level because it is for every caller (the staff-facing board is the point); mic_guard stays admin-only in the route.
- app/api/rooms-live/now/route.ts: no sentinel code left in the route (it reads from the snapshot); admin branch only adds mic_guard.
- lib/rooms-live/present.ts: `sentinelCopy(code, device)` — device-aware (S1 split); TONOR muted = "Ask the doctor to unmute the TONOR mic." (brief's words); webcam/unknown muted = "The microphone is muted. Ask the doctor to check the microphone."; DEVICE_MISSING reuses S1 UNPLUGGED_STEP; OK/unknown -> null (no line).
- components/rooms-live/RoomTile.tsx: display-only SentinelLine (data-code/data-mode test ids); no actions added.
- Mini: tools/room-guardian/mini/subscriber/sentinel_forward.py (new) — per-room latest health line -> POST /api/kiosk-health; at most once per 60 s or on code change; failed (non-2xx) post NOT marked so it retries on the next line; no code on the line posts nothing (OK never invented); token from the micguard poller's config/env (MICGUARD_TOKEN_FILE default ~/.claude/secrets/kiosk_health_ingest_token, URL env default https://www.evenscribe.app/api/kiosk-health), never logged or audited (audit line carries room/code/status only); state <home>/data/sentinel-forward-state.json, audit <home>/logs/sentinel-forward-audit.jsonl; background worker mirrors start_day idle-exit.
- Flag plumbing (shared, one line each, not S0/S3 files): router/ubus_bus.py load_cfg `sentinel_forward` (default false), subscriber.py param, run_subscriber.py wiring (background=True).
- Tests: tests/unit/kiosk-health-sentinel.test.ts (new, 9: valid incl. all 8 codes, 400 unknown code, 400 other shape violations, 401, 401-no-hash, daemon ok, poller scope both ways, mixed); tests/unit/sentinel-read.test.ts (new, 11: fresh, 600 s+1 stale, multi-room, unknown code, junk payload, failed read, ...); tests/unit/rooms-live-sentinel.test.ts (new, 12: copy per class, tile render, OK/absent no line, buildSnapshot attach fresh/stale/failed-read); tools/room-guardian/mini/tests/test_sentinel_forward.py (new, 12: extract, rate-limit, retry-on-fail, seq-never-reused, token config + no-log, flag on/off = network/no network, background worker).
- Updated for the row-shape/query change: tests/unit/rooms-live-api.test.ts:71 (key list + sentinel), tests/unit/micguard-read.test.ts (SNAP rooms carry sentinel:null; the route now issues no kiosk_health query itself — the read lives in buildSnapshot), tests/unit/rooms-live-present.test.ts (wording test also strips the S6 TONOR sentinel line).

## Assumptions (spec gaps -> safer reading)
- A1: the poller token gets sentinel scope by pairing (kind,source), not a new token: the brief says "the same auth path micguard poll.py uses"; adding a second token env would have needed a Vercel var (build-time baked).
- A2: `machine` field = room slug (the subscriber knows slugs, not Mac hostnames); room_id = slug too.
- A3: health-line field fallbacks zr<-zero_ratio_2s<-zero_ratio, peak<-peak_2s (the line's names were not all fixed by the plan).
- A4: extra unknown payload keys are tolerated (the generic ingest envelope accepts arbitrary payloads; strictness is on the sentinel contract keys).
- A5: sentinel is visible to ALL /api/rooms-live/now callers (staff-facing board is the point); mic_guard remains admin-only.
- A6: copy for the 7 non-TONOR codes beyond the brief's one line is my safe call, reusing S1 strings where one exists.

## Gate (each summary line)
- typecheck: `tsc --noEmit` rc 0.
- vitest full (tip, load ~1): `Test Files  3 failed | 447 passed | 1 skipped (451)` / `Tests  3 failed | 9327 passed | 5 skipped (9335)`. The 3: e11-silent-room-window SWEEP and no-identity-literals FAIL IDENTICALLY at base 24843eab (verified in a throwaway worktree: `Tests  2 failed | 41 passed (43)`; the offenders are tools/eta-consult-steward/tests/* and unclassified services/+tools/router-fix/* sites, all tracked-and-unmodified at base); steward-pg fails only under concurrent docker-pg load in the full suite and PASSES isolated at both base (`Tests  16 passed (16)`) and tip (with arch17: `Tests  32 passed (32)`). New failures vs base: 0.
- build: `✓ Compiled successfully in 15.0s`, rc 0.
- check:silent: rc 1, `Found 9 silent-failure handler(s)` — the 9 accepted pre-existing at 1193083, none in changed files.
- Mini suite `tools/room-guardian/mini/tests/run.sh`: `Ran 414 tests ... OK (skipped=15)`.
- Kiosk suite (rule 7): Linux, UNPROVEN — hangs on this host (timeout 240 s, mid t_control.sh) with ZERO diff in tools/room-guardian/kiosk/ vs base, so the hang is environmental; new failures vs base: 0.
- scrub: `bash scripts/steward/scrub.sh 24843eab..HEAD` rc 0.
