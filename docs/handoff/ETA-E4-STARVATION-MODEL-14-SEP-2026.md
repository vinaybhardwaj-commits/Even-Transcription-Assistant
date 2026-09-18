# ETA-E4 — 6-room × 9-hour starvation model, post-fix (`fe021a3`) · 14 Sep 2026 · Builder
Read-only. No code, flag, migration or drain run. A simulation of the selector at `lib/stt/auto-drain.ts:109-128`, not live data.

## 1. The two baselines, side by side (post-fix code; rooms ranked R1…R6 by kiosk rotation phase, R6 closes last)
Windows enqueued per room, by the hour of the cron tick. Clinic 09–17 (9 h, 36 windows a room); 18–21 is the after-clinic tail.

| Room | A: all six on — total · in clinic · 09 10 11 12 13 14 15 16 17 · 18 19 20 21 | B: R6 Transcript off — total · in clinic · 09…17 · 18 19 20 21 |
|---|---|---|
| R1 | **12**/36 · **0** · 0 0 0 0 0 0 0 0 0 · 2 4 4 2 | **14**/36 · **0** · 0 0 0 0 0 0 0 0 0 · 4 6 4 0 |
| R2 | **12**/36 · **0** · 0 0 0 0 0 0 0 0 0 · 3 4 4 1 | **14**/36 · **0** · 0 0 0 0 0 0 0 0 0 · 4 6 4 0 |
| R3 | **12**/36 · **0** · 0 0 0 0 0 0 0 0 0 · 3 4 4 1 | 36/36 · 35 · 2 4 4 4 4 4 4 4 4 · 2 0 0 0 |
| R4 | 36/36 · 35 · 2 4 4 4 4 4 4 4 4 · 2 0 0 0 | 36/36 · 35 · 3 4 4 4 4 4 4 4 4 · 1 0 0 0 |
| R5 | 36/36 · 35 · 3 4 4 4 4 4 4 4 4 · 1 0 0 0 | 36/36 · 35 · 3 4 4 4 4 4 4 4 4 · 1 0 0 0 |
| R6 | 36/36 · 35 · 3 4 4 4 4 4 4 4 4 · 1 0 0 0 | off — never offered, 0 ticks taken |
| **Sum** | **144 of 216** · 72 aged out · 0 wasted ticks | **136 of 180** · 44 aged out · **0 wasted ticks** |

Median close→enqueue lag: fed rooms 1–13 min; starved rooms 181–195 min (their 12–14 are only the last ~3 h of the day).

## 2. Verdict on N2 — DISPROVED for the current code
- **One Transcript-off room takes zero slots.** C8's `JOIN room r … r.transcript_enabled = TRUE` (`auto-drain.ts:113`) runs before `LIMIT` (`:127`), so its windows are never offered and C6's cooldown is never even reached. Wasted ticks: 0 of 180.
- **The other five rooms go up, not down.** Same five rooms, same phases: 108/180 in A → 136/180 in B. With the off room at the oldest phase instead: 132 → 136. Over 2,000 random phase sets B is **136 every time** (A is 144 every time).
- **N2's "144 → 69–82 of 180" compared unlike things.** 144 is the six-room total over 216 windows; 180 is the five-room subset.
- **Calibration — the model does reproduce the pre-fix defect.** Same model, pre-fix selector (no join, no cooldown): the five rooms get **0–110 of 180, median 72** over 2,000 phase sets. N2's 69–82 sits at that median. Off room at the newest phase: **0/180**, 177 wasted ticks. At the oldest: 110/180, 67 wasted.
- N3 also reproduces exactly: all-on, 144 of 216 drained, 72 aged out.

## 3. Does any room starve another? — YES, in BOTH baselines, and Transcript-off is not the cause
- **Mechanism.** Six rooms close 24 windows an hour; the cron takes 12 (cap 1, `*/5`). The order is `closed_at DESC` (`:126`). `closed_at = NOW()` is written when the chunk that covers the slot's end is verified (`lib/bench-window.ts:379`, called from `app/api/bench/chunks/route.ts:240`). Chunks rotate on a 5-min `setTimeout` from `startDay` (`lib/use-room-recorder.ts:72,1266`), not on the wall clock. So each kiosk closes its windows at a **fixed offset** after every grid line, and the same rooms are "newest" at every tick.
- **Result.** Each 15-min grid gives 3 ticks. They go to the 3 latest-phase rooms, every time. The rest get **nothing from 09:00 to 18:00**. After clinic they get 12–14 each, newest-first, and 22–24 of their 36 windows age out at 6 h. Starved rooms: **3 in A, 2 in B**, in **2,000 of 2,000** random phase sets.
- **How robust is this to timing noise?** (300 phase sets each; "zero-in-clinic" = some room drains nothing 09–18)

| per-window close jitter / drift per rotation | A: total · worst room · sets with a zero-in-clinic room | B: total · worst room · sets |
|---|---|---|
| ±10 s / 0 | 143–145 · 12–13 · 297/300 | 135–137 · 14–20 · 285/300 |
| ±30 s / 0.5 s | 144–145 · 12–17 · 269/300 | 136–137 · 14–21 · 220/300 |
| ±90 s / 1 s | 143–145 · 12–21 · 17/300 | 136–137 · 14–24 · 5/300 |
| ±150 s / 0 (order ≈ random) | 143–145 · 14–22 · 0/300 | 135–137 · 16–26 · 0/300 |

Totals do not depend on timing. Which room gets the slot does. Only near-random close order removes zero-in-clinic rooms. Even then the worst room drains 14–26 of 36.
- **C6 stress bound (not the question asked).** A Transcript-ON room whose every offer is refused before the claim: post-fix the other five get 96/180 (66 wasted ticks); pre-fix 0/180 (177 wasted). The cooldown bounds the damage but does not remove it. Post-fix, a single room reaches this only through the scan→drain `flag_off` race: `no_room_day` and `not_grid_aligned` are filtered by the selector, `too_long` needs more than 30 min (`bench-join.ts:103`), and `join_failed` hits every room.

## 4. Model inputs (from `fe021a3`; code unchanged since — `git diff fe021a3 HEAD` outside `docs/` touches only migration 0093)
`AUTO_DRAIN_BATCH_LIMIT` 1, `AUTO_DRAIN_MAX_AGE_HOURS` 6, `AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES` 60 (`:56,59,62`, defaults). Cron `*/5` (`vercel.json`). 15-min IST grid. The drain enqueues every Transcript-on offer (join configured, 15 min < 30 min cap). Upload latency 20 s, tick delay 15 s; 0/0, 60/45 and 5/55 give identical totals. All kiosks started 08:55–09:00 and ended after 18:00.

## 5. Flags — not settled by this model
- **F1. The model counts enqueues, not transcripts.** It does not model `/api/jobs/run` throughput or job failures. A failed job puts the window back to `closed` (`room-drain.ts:414`) and back into the newest-first race.
- **F2. The phase stability that drives §3 is INFERRED from code, not measured.** The Orchestrator can check it live. Read-only, not run by me; it assumes `end_ms` is epoch ms and `bench_session.room_id` exists, as the selector's own join does:
  `SELECT s.room_id, COUNT(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM w.closed_at) - w.end_ms/1000.0) AS med_close_lag_s, stddev_samp(EXTRACT(EPOCH FROM w.closed_at) - w.end_ms/1000.0) AS sd_s FROM bench_window w JOIN bench_session s ON s.id = w.session_id WHERE w.closed_at IS NOT NULL AND w.grid_aligned AND w.closed_at >= NOW() - INTERVAL '3 days' GROUP BY s.room_id;`
  Distinct per-room medians with sd under ~30 s would mean §3's zero-in-clinic case is the expected day.
- **F3. `ROOM_AUTO_DRAIN_ENABLED` — this is not a pass.** N2 is closed. But with six rooms recording, the shipped order starves 2–3 rooms for the whole clinic day, whether Transcript is on or off. Throughput (N3) and fairness are separate rulings. The file's own header forbids oldest-first and a higher cap without a measurement (`auto-drain.ts:22-24`), so I have designed no fix.
- **F4.** I wrote the model, its jitter variant and their output to `docs/handoff/scratch/E4-STARVATION-*-14-SEP-2026.*` so the Refuter can rerun them (`python3`, ~15 s). These are three bus files beyond the report. All are untracked. No commit.

Subagents: none.
