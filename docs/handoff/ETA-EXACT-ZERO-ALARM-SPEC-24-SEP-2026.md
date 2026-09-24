# Hourly exact-zero alarm, per recording room — SPEC + DRAFT (scribe, 24 Sep 2026, Fable ruling 255b)

**Status: DRAFT, and its FIRST PREMISE FAILED MEASUREMENT (see section 2b). Nothing is deployed, nothing is wired, nothing can write.** Delivered as this spec, an inert module (`lib/exact-zero-alarm.ts`) and its tests
(`tests/unit/exact-zero-alarm.test.ts`, 20 tests, real postgres). For Fable to review in daylight. The thresholds are PROPOSED and not yet calibrated (see §4).

## 1. Why, and what is new
Ruling 255: 12.7 % of the HIST tape (137 of 1,080 h) is bit-exact digital zero while the room showed "recording": four rooms, intermittent, none after 22 Sep 07:40. Bit-exact
zero is the TONOR TM20 hardware-mute signature (proved 9 Sep).

The app already has ONE detector: `SILENT_WHILE_RECORDING` (`lib/bench-bus-constants.ts`): recording, tape advancing, and **eighty consecutive polls (about two minutes)** with
`zero_ratio >= 0.98`. It lives in the recorder's poll ring, feeds the fleet card, and (through the room watchdog) was meant to alert, but the watchdog could not deliver an alert
(fixed on the watchdog train, `vinay/watchdog-outbox`). What it cannot do: see a mute that **comes and goes** (each stretch shorter than two minutes, or interrupted by one live
poll), and answer "how much of last Tuesday morning was dead?" afterwards.

This alarm is the **second, server-side check** over the *persisted* level log (`bench_level_sample`, 7 IST days): per room and IST hour, how much of the RECORDED time was exact zero.

## 2. What is measured, and its provenance (a caveat)
`zero_ratio` is computed by the Mac recorder as the share of samples with `sample == 0` over its checkpoint window (`apps/room-recorder/Sources/tapewriter/TapeWriter.swift`, "the latest
checkpoint's true peak and exact-zero ratio", B2-D7). The server only VALIDATES it (0..1, `cleanLevels`) and stores it in `bench_level_sample` with `source = 'command_poll'`.
So it means "exact zero" for the Mac recorder path. **Not verified:** any other producer of `bench_level_sample` rows. The migration 0112 column comment on `bench_listener.mic_zero_ratio` says
"near-zero", which reads like the older browser-listener meter (`lib/bench-meter.ts`, 0.98 line). The server cannot tell the two apart beyond `source`. The calibration query in §4 will show
whether the two ever disagree; until then this alarm claims exact zero only for what the recorder measured.

## 2b. What the data really is (measured 24 Sep 23:17 IST by herdr-kit, bus #1300: read-only, counts only) — THE PREMISE OF THE FIRST DRAFT FAILED
I designed section 3 onward on the belief that `bench_level_sample` carries a usable zero-ratio history. It does not:
1. **The table is 2.1 days old**, not 7: 308,317 rows, 9 rooms, `command_poll` only, from 22 Sep 14:48 IST (when migration 0112 began writing) to 24 Sep 17:45. The seven days are a retention ceiling. The exact-zero episodes (last one 22 Sep 07:40) pre-date the table, so nothing in it can show "none after 22 Sep".
2. **`zero_ratio` is almost never reported there.** Of 40,662 recording buckets (185 room-hours), 2 are measured. 14 % of all rows carry a `zero_ratio`, all from ONE room, whose maximum in the whole table is 0.0024. Eight of nine rooms never report it. 99.995 % of recording buckets are unmeasured.
3. **Why:** the Mac recorder sends `zero_ratio` in its INSTALL poll (`lib/room-install.ts`). The server keeps only the LATEST value (`room_install.zero_ratio`) and a ring of the last TEN polls (`poll_ring`), and carries `silent_polls` as a running count. There is no durable series. The level log is fed from a different path (the command poll). So a two-minute mute is flagged on the fleet card and then forgotten, which is why nobody saw 12.7 % of the tape until the audio was measured with ffmpeg.

**Consequence for this draft.** The classification is honest about it: an unreported bucket is neither ok nor zero, so today every room would read `insufficient` (UNKNOWN), never a false ok. An alarm that reads a missing zero_ratio as fine would never fire; this one cannot do that. But it also **cannot work on this table**, and the thresholds in section 4 stay uncalibrated: the base rate is unmeasurable until a durable source exists. The only measurement of the episodes is the audio-side one (hist-miner: 137 of 1,080 h).
Requested and pending: whether the install path reports `zero_ratio` for every room (bus #1322, one read-only aggregate on `room_install` and its ring).

## 2c. Options for a durable source (Fable's choice; none is built)
- **A (cheapest, proposed): the install poll also writes ONE level-log row per 15 s bucket** for a recording room (`source = 'install_poll'`, peak and zero_ratio from the poll). The alarm then reads the table it already reads, unchanged. Cost: a write in the hot production poll path, so a separate change with its own refutation, and rows at the poll cadence unless capped to one per bucket (`ON CONFLICT` on room and bucket). The existing 0112 index and 7-day retention apply.
- **B: a compact per-room-hour counter** (polls, exact-zero polls), upserted from the install poll. Less storage, but an upsert per poll and no history finer than the hour.
- **C: measure the tape, not the poll**: exact-zero ratio per uploaded piece, computed where the audio is joined. Ground truth (it is what hist-miner did), but it runs at join time, hours late, and needs the join service to report it.
- **D: do nothing server-side; alarm on the recorder.** Add an hourly "exact-zero minutes" field to the install poll from the app itself (it already counts zero samples per checkpoint). The server then only stores and alerts on one number per poll. Needs an app release (0.1.x), which is slow and a per-Mac hand.
Recommendation: A now (server-only, fast, testable), D as the durable fix in the next app release. Either way the alarm module in this branch stays the decision logic.

## 3. Definitions (each one a decision, each pinned by a test)
- **Bucket** = 15 s (`LEVEL_TIMELINE_BUCKET_SECONDS`), the timeline reader's unit.
- **Recording bucket**: `session_open` AND `tape_advancing` at some sample in it. Anything else is not counted anywhere.
- **Measured bucket**: a recording bucket in which some sample reported `zero_ratio`. A recording bucket that never reported is **unmeasured**: it is neither ok nor zero. It is left out of
  the share and named in the message, because "not reported" must never read as "fine".
- **Exact-zero bucket**: a measured bucket in which **every** reporting sample has `zero_ratio >= 0.999` (`min`, not the reader's `max`: one live sample means the microphone was alive).
  0.999 is rounding tolerance for "all zero"; it is deliberately stricter than the recorder's 0.98 "dead" line, so this alarm means the measured defect and not merely a dead-looking input.
- **Hour** = an IST hour (UTC+05:30, no DST). 00:05 IST on the 25th belongs to the hour starting 18:30Z on the 24th.

## 4. Decision rule and PROPOSED thresholds
Per room-hour: `insufficient` if fewer than **20 measured buckets** (5 minutes): never `ok`, and it includes a room that reports no `zero_ratio` at all, which is *unknown*, not healthy.
Otherwise **`alarm` iff at least 20 buckets (5 min) were exact zero AND that is at least 10 % of the measured buckets**; else `ok`. Both conditions, so a long hour with a brief mute does
not alarm and a short all-zero hour still does. Malformed counts are `insufficient`, never a quiet `ok`.

**These numbers are guesses until calibrated.** Standing rule: measure the constant first. **Result (bus #1300): it cannot be calibrated from `bench_level_sample`** (section 2b). Bus #1295 asked herdr-kit to run ONE read-only aggregate on the Mini (counts only): per room and IST hour
over the 7 retained days, recording / measured / exact-zero (min over the bucket >= 0.999) / silent (>= 0.98) buckets, plus the base rate of room-hours and the count of unreported recording buckets.
It also answers "none after 22 Sep 07:40": that date is inside the retention window. Retune `DEFAULT_THRESHOLDS`, not the rule.

## 5. Not built: how it would be wired (for review, not for merge tonight)
1. **Evaluator**: an hourly cron (about :05 IST) evaluates the previous **completed** IST hour for every room that recorded in it, through `readExactZeroHours` and `classifyHour`.
   One aggregate query over at most a two-hour window, using the existing `(room_id, ist_date, sampled_at)` index (0112). Check `EXPLAIN` on production data before wiring.
2. **A ledger, so it never double-alerts and V gets his list** (ruling 255c). Draft only, **deliberately NOT a file in `db/migrations/`**: `POST /api/run-migrations` applies every `.sql` file it finds, and an unreviewed draft must not be one.
   ```sql
   -- 0120 (DRAFT): one row per (room, IST hour). Marks, never deletes.
   CREATE TABLE room_exact_zero_hour (
     room_id text NOT NULL REFERENCES room(id), hour_start timestamptz NOT NULL,
     recording_buckets int NOT NULL, measured_buckets int NOT NULL, exact_zero_buckets int NOT NULL,
     state text NOT NULL CHECK (state IN ('ok','alarm','insufficient')), evaluated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (room_id, hour_start));
   ```
   Insert with `ON CONFLICT DO NOTHING`; an alert is queued only for a row that this statement actually inserted with `state = 'alarm'`. A re-run of the same hour changes nothing and alerts nobody.
3. **Delivery**: the watchdog alert outbox (migration 0119), with one new `kind = 'exact_zero'` (0120 also widens that CHECK), in the same single statement as the ledger insert, so the ledger row exists if and only if the alert is queued.
   The relay posts it to conductor on the bus. **No V pages** (rulings 128 and 137). The board and any tracked file carry the room id only; the bus message may carry the room name (design decision 3 of the alert path).
4. **Muted rooms** (`room_alert_state.muted_until`): the ledger row is still written, no alert is queued, exactly as the watchdog does.
5. **The hourly summary lists `insufficient` rooms separately**, so a room that records but never reports `zero_ratio` (an older app, another platform) is visible as unknown every hour.
6. **Depends on the watchdog train** (0119 applied by Fable first, the relay installed). It cannot alert before that; the ledger alone still gives V the room and date list.

## 6. Edges and failure modes
- Read fails: no alarm, and the run's heartbeat says so (same fail-safe as the watchdog: nothing is sent for a state that was not read).
- A room that stops mid-hour: its recording buckets simply stop; the rule judges only what was recorded.
- The current (incomplete) hour is never judged; only completed hours are.
- Retention is 7 IST days for the raw level log; the ledger is the long-term record.
- A hardware mute that lasts the whole hour but the room reports nothing (unmeasured): `insufficient`, listed as unknown. That is honest, and it is the case to watch.

## 7. What is tested (20 tests; 11 mutations, all killed)
Pure: the constants; boundaries on BOTH conditions (19 vs 20 buckets, 23/240 vs 24/240, 99/1000); `insufficient` never `ok`; unmeasured named and excluded from the share; malformed counts; parameterised thresholds; IST hour arithmetic; the message carries counts and times only.
Real postgres: counts per room and IST hour; `min` not `max` per bucket; the 0.999 line (0.99 is not exact zero); unreported is not measured and not zero; NULL samples do not break a bucket; only recording buckets count; hours are IST (00:05 IST); rooms stay separate, `roomId` narrows, the window is `[since, until)`; read-only.
The real-postgres test found a real bug in the first version of the query (a bound parameter used twice becomes two different positional parameters, so Postgres refused to match the GROUP BY expressions). A mocked test would not have.

## 8. Open questions for Fable
1. Thresholds, after the calibration numbers arrive.
2. One alert per alarming hour (proposed), or one per episode (consecutive alarming hours collapse to a single message plus a recovery)?
3. Should an alarming hour also mark the room `degraded` in `room_alert_state`, or stay a separate signal?
4. Who receives the daily room-and-date list for V (ruling 255c), and in what form?
5. Scope: only rooms whose app version reports `zero_ratio`, with the rest listed as unknown (proposed), or all rooms?
