# ETA-E4 RULING — starvation, the cap, and the thing underneath · 14 Sep 2026 · Orchestrator

Rules on `ETA-E4-STARVATION-MODEL-14-SEP-2026.md`. I ran F2's query myself and three more, read-only,
against live Neon. No code, flag or migration changed by this document.

---

## 1. What the live data says

### 1.1 F2 — ANSWERED, and it confirms the model rather than refuting it

F2 said §3's fixed per-room phase was inferred from code, not measured. It is now measured.

Close lag = `closed_at − end_ms`, grid-aligned windows only, **cut per room per day** (≥5 windows):

| Day | rooms, median lag s (sd s) |
|---|---|
| 09 Sep | 45.3 (2.7) · 66.9 (2.5) · 143.2 (1.8) · 222.6 (9.2) · 263.1 (44.2) · 287.2 (17.0) |
| 10 Sep | 33.4 (99.5) · 54.4 (2.5) · 54.9 (1.8) · 71.0 (109.8) · 161.2 (13.1) · 238.8 (30.0) · 260.7 (64.3) · 265.9 (4.6) · 298.1 (56.8) |
| 11 Sep | 114.2 (60.9) · 141.8 (43.0) · 196.2 (66.4) · 209.7 (64.6) · 228.5 (145.1) · 259.3 (87.7) · 287.0 (53.2) |
| 12 Sep | 28.4 (101.9) · 66.0 (84.1) · 131.0 (83.4) · 204.7 (44.5) · 228.2 (36.9) · 237.7 (94.7) · 240.5 (41.8) |

On the clean days the dispersion is **1.8–30 s** around medians separated by **45 → 298 s** inside a
900 s grid. That is the **±10 s row** of the model's own robustness table — the row where
**297 of 300** phase sets contain a room that drains nothing between 09:00 and 18:00.

The 7-day aggregate looked different (sd 70–93 s) and I nearly ruled on it. That sd is **drift between
days**, not jitter within a day; cutting by day removes it. Aggregating over a span longer than the
mechanism's cycle destroyed the structure under test. **§3 stands, on live data.**

### 1.2 The model understates the load — it is not six rooms

Distinct rooms closing windows per hour (IST), last 7 days:

- **10 Sep 11:00–19:00 — 8 to 9 concurrent rooms, 29–32 windows an hour.**
- **12 Sep 10:00–18:00 — 7 to 8 concurrent rooms, 28 windows an hour, sustained 8 hours.**
- 11 Sep 14:00–19:00 — 7 rooms. 09 Sep 15:00–19:00 — 6 rooms.

The model assumed 6 rooms / 24 an hour. At cap 1 on `*/5` the drain takes **12 an hour**. The real
deficit is **2.3–2.7×**, not 2×. Every number in §1 of the model is therefore optimistic.

### 1.3 The pipeline the drain feeds has never processed a room window

| | last 7 days |
|---|---|
| Closed, grid-aligned `bench_window` | **1,378** across 9 rooms |
| Of those, with a `room_diarize_window` row | **0** |
| Of those, with a `room_emotion_window` row | **0** |
| `room_diarize_window`, **all time** | 15 (state `ok`; manual probes) |
| `room_emotion_window`, **all time** | **0 rows** |
| `scribe_job`, last 7 days | 13 total — 10 failed, 3 done |
| `auto_drain_refused_reason` populated | 0 of 1,507 |

This is explained, not mysterious: `ROOM_DIARIZE_ENABLED` and `EMOTION_ENABLED` **did not exist as
variables in Vercel until I created them today**. The system was dormant by absence. But the
consequence is the ruling:

> **We have zero measured service rate for the room-window pipeline, and no history to infer one from.**

F1 was the right flag. Its answer is worse than it feared. A fairness argument about the order in
which we hand work to a consumer whose throughput is unknown and whose observed output is zero rows
is an argument about the wrong thing.

---

## 2. Rulings

**R1 — `ROOM_AUTO_DRAIN_ENABLED` stays OFF.** Not because N2 is open. N2 is **disproved and closed**;
I accept §2 in full, including that the Transcript-off join runs before `LIMIT` and wastes no ticks.
It stays off for two new reasons: the drain has under half the capacity the live room count needs
(§1.2), and it would be feeding a consumer with no measured service rate (§1.3).

**R2 — The sort is not the defect. Do not touch `closed_at DESC` yet.** Under a 2.3–2.7× deficit
every deterministic order starves someone; a fair order **redistributes** the same 70-odd lost
windows an hour, it does not recover them. Fixing the order first would convert a visible failure
(three rooms with nothing) into an invisible one (nine rooms each missing two windows in three),
and I would rather have the visible one until the capacity is right. Ordering is worth fixing only
once the drain can clear the day.

**R3 — Cap 1 is known wrong; its replacement is not mine to pick yet.** `auto-drain.ts:22-24`
forbids a higher cap without a measurement. §1.2 is that measurement for *demand* — 28–32 closes an
hour. It is not a measurement of *service*. The cap must be derived from the smaller of the two, and
we only have one. No cap change until R4 reports.

**R4 — The next work is a throughput measurement on the existing backlog, not a code change.**
Brief: `ETA-E5-THROUGHPUT-MEASUREMENT-CC-KICKOFF-14-SEP-2026.md`. Nothing is recording today, the
flags went live today, and 1,378 real clinic windows are sitting unprocessed. That is the cleanest
measurement opportunity this programme will get.

**R5 — The fairness property, for after R4 and not before.** When ordering is fixed the property is:
*within any 15-minute grid, no Transcript-on room holding a closed window goes unserved while another
room is served twice; within a room, newest-first is preserved.* Explicitly **not** oldest-first —
that trades the freshness the header wanted for a fairness we can get while keeping it.

**R6 — Late-verified windows are a second ordering hazard, independent of phase.** Two rooms show
close lags to **64,517 s (17.9 h)**, sd 17,850. Under `closed_at DESC` a window whose chunk is
verified 18 hours late arrives with a *fresh* `closed_at` and jumps the entire queue ahead of
material recorded minutes ago. Record it; do not fix it yet. Whatever replaces the sort in R5 must
rank on something the recorder controls, not on when verification happened to land.

**R7 — The 1,378-window backlog needs a disposition decision, which is V's, not mine.** They are not
at risk of deletion — `AUTO_DRAIN_MAX_AGE_HOURS=6` only means auto-drain will never pick them up, so
they stay in Neon and R2, drainable by hand. But they are 7 days of real consultations with no
transcript, no diarization and no emotion scoring, and someone has to decide whether we process them
or let them stand as archive. Not a build decision.

---

## 3. Carried to the testing rules — rule 16

> **16. An aggregate taken over a span longer than the mechanism's cycle can hide the mechanism.**
> The same close-lag data gave opposite answers at 7-day and 1-day granularity: aggregated, sd 70–93 s
> (order looks random, no starvation); per day, sd 1.8–30 s (order is fixed, starvation every day).
> The 7-day figure was not noisy — it was measuring day-to-day drift and answering a question nobody
> asked. Before trusting a dispersion, check that the window you took it over is shorter than the
> thing you think is stable.

Companion to rule 14: there, a mutation could not fail; here, a statistic could not detect.

---

## 4. What is now closed

- N2 — **closed, disproved.** One Transcript-off room costs the others nothing; they gain.
- N3 — reproduced by the model, but its 216-window premise is superseded by §1.2. Reopen against the
  real room count after R4.
- F2 — **closed, confirmed.**
- F1 — **open, and promoted to the critical path.** R4 answers it.
- F3 — **ruled**: R1, R2, R3.
- F4 — the three scratch files stand; the Refuter may rerun them, but §1.2 changes their room count.

Orchestrator. Measurements run read-only against live Neon by me. No subagents.
