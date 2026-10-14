# Untranscribed 22 Sep windows, extended study (24 Sep 2026)

Read-only against production (`kit/neon-select.mjs`). Order: `orders/queue/eta-lab-t4:yoga-drain/001-yoga-drain-2.md`.
Ids and counts only — room ids are opaque, no names, no text.

## The set
`bench_window.state='closed'`, `closed_at` 22 Sep 08:00–18:59 IST: **128 windows** (the order counted 53 + 66 at 00:40; 9 more had reached `closed` by ~01:15).
All 128: grid_aligned, room_day present, primary mic, `auto_drain_refused_reason` NULL, room switch currently ON, no live job.

| set | n | clip | prior jobs | cause |
|---|---|---|---|---|
| A: closed 08:00–15:59 IST | 62 | all | 2 (61), 3 (1), latest `failed` | `join_failed: join_already_running` on all 62; `stt_subject_job` attempts 1 (61) / 2 (1) |
| B: closed 16:00–18:59 IST | 66 | none | 0 (61), 1 (5) | 61 never offered, nothing refused them; 4 failed `join_already_running`; 1 `cancelled_for_serial_retry` |

## Causes
- **False failures, not faults.** From 15:49 IST a third drainer (admin_route, 424 serial jobs, 334 failed `join_already_running`; ledger ETA-OVERNIGHT-FATALS-ROOTCAUSE) saturated the join service's one-at-a-time mutex; the cron drain's windows lost the same race. `drain-join-busy` (5301fd7) turns that answer into a wait.
- **Set B's 61 never had a job**: the drain was starved during the saturation (no window in hour 16 IST has any processed state at all), and by the time the join cleared they were past the age horizon. Never refused (no refusal reason), never offered.
- **Not stranded**: all 128 are already `closed` with attempts <3, so no state repair is needed (unlike the 56 `transcribing`). They are only outside auto-drain's horizon — direct submit is enough.
- **Transcript switch "at the time": UNVERIFIED.** No switch-history table, and `audit_log` has no switch rows. All 128 rooms have it ON now; no refusal reason was ever stamped, so it did not block an offer.

## Real consult audio vs silence (UNVERIFIED — no level log before 22 Sep 19:53 IST, `peak_level` NULL, chunk bytes/s is flat ~3.8 kB/s for speech and silence alike)
Classified by same-room neighbour windows (±30 min) that the drain already judged, else by IST hour:
- likely speech **62** (A 48, B 14)
- unknown **46** (A 2, B 44 — their neighbours are also unprocessed; hour 16 has no measured base rate)
- likely silence **17** (A 9, B 8)
- after-hours **3** (started before 08:00 IST)
Hour base rate of speech among processed windows that day: 08h 38%, 09h 50%, 10–12h 80–92%, 13–15h 62–73%, 17–18h ~50–67% (n small). By that rate ~18 of B's 66 are speech. Silent windows skip the engine (E11 silence path), so submitting everything costs join + VAD for the silent ones, not a full transcription.

## Recovery
`RECOVERY-2.sql`: refund the 67 false attempts (exactly `join_failed: join_already_running`, attempts 1–2; validated read-only: 128 rows, 128 switch-on, 0 live, refund = 67), then direct submit from `SUBMIT-LIST-2.csv` (32 batches of 4, likely-speech first). **≤4 in flight**: the join service does one join at a time and the busy wait caps at 15 min, so a deep queue would fail jobs and burn attempts. ~5–7 h serial for all 128 (~3 h for the 62 likely-speech); adds to the 56 in RECOVERY.sql and to the emotion/night-drain load — book the DRAIN-BOOKINGS lock first. Pre-condition: the train with `drain-join-busy` deployed.
