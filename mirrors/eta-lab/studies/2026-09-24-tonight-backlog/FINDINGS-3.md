# Tonight's backlog build: 20-21 Sep + failed 22 Sep recovery (24 Sep 2026)

Order `orders/queue/eta-lab-t4:yoga-drain/001-yoga-drain-3.md`. Read-only against production (`kit/neon-select.mjs`) until Fable runs it.
Ids and counts only; room ids are opaque; the feeder logs counts only. Measured 24 Sep ~04:55 IST.

## 1. The set (`SUBMIT-LIST-3.csv`, 291 windows, ranked likely-speech first)
| set | n | what |
|---|---|---|
| C20 | 48 | 20 Sep closed, room switch ON |
| D21 | 171 | 21 Sep closed, room switch ON (2 have a clip) |
| F22 | 39 | of the 128 recovery windows: latest job `failed` (all `join_already_running`), window still `closed` |
| G22 | 33 | of the 128: job still queued/running now (some stale, see 3a); joins the feed if it fails or is cancelled |

C20 + D21 = **219**, matching the order. The other 56 of the 128 are already `transcribed` (45) or `silent` (11).
All 291: grid_aligned, room_day present, primary mic, switch ON now, no refusal reason.
**HELD, not in the feed: 37 windows of 20 Sep in rooms whose switch is OFF now** (`HELD-SWITCH-OFF-3.csv`: 28 start before 07:00 / after 21:00 IST, 9 unknown). Reasons: (a) no switch history exists to say it was on that day; (b) a direct `room_window` job does NOT check the switch until the cue write, so it would run the whole engine pass and then fail `cues_refused`, burning an attempt; (c) transcribing them needs `switch_override:true`, which needs `write` scope and V's call. Recommend skip.

Audio class is INFERRED, as in FINDINGS-2 (no level log before 22 Sep 19:53 IST): same-room neighbour within 30 min already judged, else the IST-hour speech share of that day's processed windows. Feed set: likely_speech 208, hour_speech 8, unknown 2, likely_silence 73 (expected speech windows about 200). 20 Sep was a Sunday: 15% speech among its processed windows, so C20 is mostly silence (35 of 48 likely silent).

## 2. Refund: `RECOVERY-3.sql` supersedes RECOVERY-2 step 2
RECOVERY-2's exact-string match is wrong now. Since drain-join-busy, a job that outwaits its bound writes `join_failed: join_already_running after N busy retries over Ns`: **44 of the 56 refundable rows** carry that suffix (34 at attempts 1, 9 at attempts 2, 1 EXHAUSTED at attempts 3 with the window still `closed`). RECOVERY-3 matches the prefix, any attempts >= 1, and also reopens a window parked `bench_window.state='failed'` (1 today, 21 Sep, attempts 5). Only the join-mutex answer is refunded: the 2 `whisper_unavailable` rows (attempts 1) and 11 `join_failed: join_failed` job failures are real faults and are left. Validated as a SELECT today: 56 rows, all 22 Sep; the count grows as the 33 live jobs fail. It never touches `last_error`.
Note the window-state subtlety: a direct-submitted job never claims the window (it stays `closed` through the whole job), so `recordFailure` never parks such a window; attempts just climb. Only windows claimed by `drainRoomWindow` (cron/admin) get parked `failed`.

## 3. Two things that must happen before 20:45
a. **Stale busy-waiters from the 22-23 Sep bulk submit.** Snapshot 04:53 IST: 20 room_window jobs live, 12 of them `running` with no update for 20+ min (at 04:46 it was 27 running + 5 queued, so it is draining slowly). The stale ones sit at step `prepare`, lease NULL, last touched ~03:52 IST, each carrying `join_busy_first_at_ms` about an hour old. When a runner claims one it is past the 15-minute bound and FAILS as join_failed, burning a window attempt. They also count toward "in flight", so the feeder submits nothing while they sit there (correct, and visible in its logs as `stale`). At ~20:30: list live room_window jobs; cancel any left with `scribe_job_cancel` (needs write; safe: their windows are still `closed`), then run RECOVERY-3, which also refunds whatever they burned before then.
b. Book the slot in `DRAIN-BOOKINGS.md` (Mini): the feed shares Whisper/router with overnight-translate and night-drain.

## 4. The paced feeder (`feeder-3.mjs`, 7 unit tests green, dry run against production green)
- `node feeder-3.mjs` = dry run (SELECT only, no token): today `list 291, eligible_now 265, in_flight 20, stale 12, would_submit_now 0` (the cap holding, as designed). `--go` submits.
- Cap: at most 3 queued+running room_window jobs, counted across EVERY actor (hard ceiling 3). Submits in rank order, and only windows production says are still closed, switch ON, subject attempts < 3 and no live job, so a stale list cannot cause a bad submit. Each window at most twice per run.
- Starts submitting at 20:45 IST (waits if started earlier), stops submitting at 07:30 IST (in-flight jobs finish alone).
- Breaker: 3 of the last 6 settled jobs failed -> pause 15 min; second trip exits 3. Auth refused exits 2; 3 consecutive submit errors exits 4.
- Logs counts only (JSON lines to stdout and `~/feeder-logs/feeder-3.log`): in_flight, stale, sent, eligible_left, done, failed, error classes. No window/room/job id, no token, no text.
- Runtime estimate from the measured 154-185 s per window at concurrency 1: about 9-11 h for ~200 speech windows plus the silent tail against a 10.75 h window. Tight: rank order means any leftover is the likely-silence tail, and the feeder is resumable (re-run tomorrow night; it only takes what is still closed).

## 5. Submit path: recommendation
Facts: the box/Mini token is read-scope; `scribe_job_submit` needs `invoke`; `room_window` needs `write` ONLY for `switch_override`. The admin routes (`/api/admin/bench/drain`, `/api/admin/drain-windows` POST) need a signed-in admin cookie (far broader than one job kind, and a person's session), and the cron GET is limited by `AUTO_DRAIN_MAX_AGE_HOURS` (max 48 h) so it cannot reach 20-21 Sep.
**Least privilege: one new `SCRIBE_MCP_TOKENS` entry, actor `night-feeder`, scopes `["read","invoke"]`, NO `write`.** It can queue work and read the queue; it cannot cancel jobs, override a switch, or post room commands. Precedent: `mcp:overnight-translate` already submits as its own keyed actor (383 jobs), so the map and per-actor labelling already work.
What Fable must do (daylight, per the 21 Sep ruling that a keyed-token edit is a daylight job):
1. Add the entry to `SCRIBE_MCP_TOKENS` in the production env, preserving every existing entry (count before and after; a malformed map silently disables every keyed token). Generate the token into a 0600 file, never on a command line, never printed.
2. Promote a production deployment (env bakes at build time here). Verify the door answers 200 to a read call with the new token.
3. Install the token on the box at `~/.claude/secrets/night_feeder_token` (mode 0600) and tell me, or run the feeder yourself.
Fallback with no production change: run the feeder under Fable's existing `operator-v1` token. It works (same door, same tool), but that token holds write, so the least-privilege guarantee then rests on the code only, and jobs are labelled as operator-v1.

## 6. Runbook for tonight
1. (daylight) token per section 5. 2. By ~20:30: cancel the stale waiters, run `RECOVERY-3.sql` STEP 0, review, COMMIT. 3. Book the slot. 4. On the box: `cd /home/eta/dev/eta-wt-orphan-reaper && nohup node /home/eta/dev/eta-lab/studies/2026-09-24-tonight-backlog/feeder-3.mjs --go >/dev/null 2>&1 &` (any ETA checkout with node_modules works). 5. Watch the counts in `~/feeder-logs/feeder-3.log`; stop it any time with `pkill -f feeder-3.mjs` (in-flight jobs finish normally).
6. Still pending from before: RECOVERY.sql (56 orphaned `transcribing`; the reaper branch `vinay/room-window-reaper` prevents new ones).
