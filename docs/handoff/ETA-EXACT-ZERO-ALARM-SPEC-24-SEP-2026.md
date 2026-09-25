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

## 2b-2. The install-poll null on app 0.1.24: NOT established, and why (herdr-kit #1325 and #1332, eta-refuter #1333; corrected 23:45 IST)
Measured at 23:27-23:35 IST: on the ten rooms running app 0.1.24 every one of the poll ring's ten polls has `peak` and `zero_ratio` null; the one room on 0.1.22.2 sends numbers. The stored columns (`peak`, `zero_ratio`, `silence_ms`) are STICKY (`COALESCE` in the poll UPDATE, `lib/room-install.ts`), and the fleet card (`BenchInstallFleet.tsx:726`) shows the sticky value as current, so it can show a week-old reading (for example about 36 % zero on two rooms) as today's. That stale display is a defect either way.
**What this does NOT show:** that 0.1.24 stopped measuring. The 0.1.22 source (the newest in this repo) returns absence for BOTH `peak` and `zero_ratio` whenever no capture is running (`RoomEngine.currentSignal()`), and the ring was read after every kiosk had stopped recording (20:28; every ring has `rec` false). A Mac with no active capture would send null on any version. The 0.1.24 source is not in this repo (`apps/room-recorder/CHANGELOG.md` stops at 0.1.22).
**Two checks that decide it** (read-only, counts only; herdr-kit): (1) `tape_advancing` per room in the same ring: true in the ten rooms with null peak means a real version behaviour, false or null means no capture; (2) the same ring query while the clinic is RECORDING, about 08:15-08:30 IST on 25 Sep. If the ten Macs then report `peak` and `zero_ratio`, the alarm has coverage on them and this section was the time of day. If they still send null while recording, `SILENT_WHILE_RECORDING` and `CLIPPING` have been blind on the clinic Macs since 17 Sep and that goes to Fable at once.
What IS solid regardless: the level log during clinic hours holds 40,662 recording buckets of which 2 carry a `zero_ratio` (the command-poll path), and `bench_level_sample.zero_ratio` has two definitions under one `source` (Mac recorder bit-exact; web recorder RMS <= 0.0015, `lib/bench-dual.ts`), so a web-recorded room's "alarm" would mean near-silence, not exact zero. My pick for that is a producer marker at write time (a distinct `source` per client), with the alarm text saying "near-silence" for any non-Mac producer.

## 2b-3. Settled from history (herdr-kit #1341, 23:37 IST, read-only, counts only): the level log has NO `zero_ratio` during capture, in any room, on any version
`bench_level_sample`, last two days, source `command_poll`: **264,283 capturing rows (`session_open` AND `tape_advancing`) across all nine rooms, 0 with a `zero_ratio`**, in every room, including the 0.1.22.2 room (41,677 capturing rows, all null). Capture spans 23 Sep 07:50 to 24 Sep 20:28, two clinic days. The rows that DO carry a `zero_ratio` are all in that one room, at times when it was NOT capturing.
So section 2b-2's version question does not decide anything for THIS table: it is not a 0.1.24 regression, the command-poll path simply does not carry `zero_ratio` while a room is recording, on either version. **The alarm as drafted (reading `bench_level_sample`) has zero coverage in every room today.** It would report every recording hour as `insufficient` (UNKNOWN), never ok, which is the right failure mode, and it is useless as an alarm. The thresholds cannot be calibrated from this table at all.
What remains OPEN, and decides which durable source (2c) is viable: whether the INSTALL poll (`room_install.poll_ring`, the path that feeds `SILENT_WHILE_RECORDING`) carries `peak` and `zero_ratio` while a room is capturing. That is check 2 (herdr-kit, about 08:15-08:30 IST on 25 Sep, the ring while the clinic records). If it does, option A (persist it into the level log) works and is server-only. If it does not, only options C (measure the tape) or D (an app release) can work, and `SILENT_WHILE_RECORDING`'s `zero_ratio` fallback has been unable to fire on the clinic Macs.
Unexplained, noted so it is not lost: a room reports numbers only when NOT capturing. That is the opposite of what `RoomEngine.currentSignal()` would give (absence when there is no capture), so the command-poll level payload probably comes from a different meter than the recorder's tape index.

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

## 9. Ruling 345 (25 Sep 2026): OPTION E ADOPTED, IN SHADOW — this section supersedes §§2b-2c and §8 where they disagree

DECISION (Fable, r345): the v1 source is the level log's `peak`, not `zero_ratio`. The measure is "share of capturing polls with peak 0, per room per IST hour", worded **"near-silence (peak below -86 dBFS)", never "zero"**. Thresholds are set in SHADOW for 48 hours by scribe; NO pages until Fable rules on the numbers. The zero_ratio route fix (1e75667, on the watchdog train) stays useful as the bit-exact number but is not on this path.

WHAT `peak` IS (eta-refuter #1856): the Mac's `mic_peak` is one 1.25 s RMS window from the tape index per poll, printed with 4 decimals, so `peak = 0` means RMS below about 5e-5 (-86 dBFS): a superset of bit-exact zero. It is a sampled point per poll, not a per-sample count, so no zero FRACTION exists.

DEFINITION (replaces §3's bucket definitions for v1):
- capturing sample = `session_open AND tape_advancing AND peak IS NOT NULL` in `bench_level_sample`;
- near-silent sample = `peak = 0`;
- hour share = near-silent / capturing samples in the IST hour; an hour is JUDGED only with at least 100 capturing samples (else `insufficient`, never `ok`);
- proposed ALARM: judged hour with share >= 0.10. One message per EPISODE (consecutive alarming hours), one recovery, a re-notice only past 3 h (ruling 279); a SEPARATE signal, not `room_alert_state.degraded`; a room with no capturing samples is listed UNKNOWN, never green.

FIRST CALIBRATION (25 Sep 09:00 IST, bench_level_sample 7 IST days, 9 rooms, counts only; posted as #1970): 171 capturing hours in the eight non-OPD-4 rooms, none at 5% or more (largest: one Dietary Room hour in the 1-5% bin); OPD 4: 14 hours, of which 7 at 10% or more (2 in 10-25%, 3 in 25-50%, 2 at 50% or more). At 10% the rule fires on 7 OPD 4 hours and 0 of the 171 others; 5% gives the same 7 (the 5-10% bin is empty). LIMITS: one positive room and two episodes (23 Sep 15:00-20:00, 24 Sep 12:00-14:00 IST), so this checks "no false alarm on healthy rooms, alarm on the one known fault" and is NOT a false-negative rate; the level log is 7 days deep, so the 11-14 Sep episode is outside it.

SHADOW: an hourly job (read-only, this session) appends per-room per-hour `n` and `z` to a jsonl; 48-hour summary on 27 Sep for Fable's ruling on the numbers.

WHAT THE DRAFT MODULE NEEDS (not done): `lib/exact-zero-alarm.ts` reads `zero_ratio` in 15-second buckets; option E needs a peak-based variant (sample counts per hour, the rule above, the UNKNOWN list), its tests and mutations, and the alarm wording. It stays inert until Fable's ruling on the numbers. The device-context columns of ruling 346 (migration 0120) will let a fired alarm say WHICH input the room was on.
