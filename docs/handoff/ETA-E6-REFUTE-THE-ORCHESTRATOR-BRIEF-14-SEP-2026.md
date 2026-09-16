# ETA-E6 — refute the Orchestrator's E4 evidence · REFUTER BRIEF · 14 Sep 2026

You are refuting **me**, not a Builder. The document under attack is
`ETA-E4-RULING-STARVATION-CAP-AND-THROUGHPUT-14-SEP-2026.md`. I ran four read-only queries against
live Neon this afternoon and hung three rulings and a shutdown of `ROOM_AUTO_DRAIN_ENABLED` off them.
Nobody has checked them. A brief is a claim, not a fact — and so is a ruling.

Read the ruling first, then `ETA-E4-STARVATION-MODEL-14-SEP-2026.md` for what it rules on.

## GOAL

Decide, with evidence, whether each of my four claims survives. I want the ones that break, named.

## THE CLAIMS

**C1 — Phase is rigid within a day.** I cut close lag (`closed_at − end_ms`) per room **per day** and
got sd 1.8–30 s around medians separated 45 → 298 s, and called that the model's ±10 s row, where
297/300 phase sets starve a room. **Attack it here:** 09 and 10 Sep are tight; **11 and 12 Sep are
not** — sd 40–145 s. I leaned on the clean days. Which pattern is the clinic's normal day? If the
looser days are normal, my ruling sits on the wrong row of the model's table and the starvation is
milder than I said.

**C2 — The competition I inferred is real.** This is the claim I am least sure of and it is load-
bearing. My whole argument assumes every room's windows share the **same wall-clock 15-minute grid**,
so that within one grid line the room with the larger close lag has the later `closed_at` and wins
the `closed_at DESC` sort every time. **If `grid_aligned` anchors to something per-room or per-session
rather than a shared IST quarter-hour, the rooms are not ranked against each other the way I claimed
and C1 does not imply starvation at all.** Establish what the grid is actually anchored to, from
source. Do not take my word or the model's.

**C3 — 7 to 9 concurrent rooms, 28–32 windows an hour**, against the model's 6/24. Check the count is
rooms genuinely recording concurrently and not an artefact of how I counted (`COUNT(DISTINCT room_id)`
over windows closed in an hour, joined `bench_window` → `bench_session`). Rebinds, re-opened sessions
and two sessions for one room would all inflate it. I have been wrong on a room-count question
before, in the other direction.

**C4 — 1,378 closed grid-aligned windows, 0 diarize rows, 0 emotion rows**, and my explanation that
this is because `ROOM_DIARIZE_ENABLED` / `EMOTION_ENABLED` did not exist in Vercel before today.
**Attack the explanation, not the count.** If there is a second reason the pipeline produced nothing
— a broken enqueue scan, a migration never applied in production, a path that was never wired — then
turning two flags on has not fixed it, and `ETA-E5` will measure a pipeline that still cannot run.
That would be the most valuable thing you find today.

## SCOPE

- Read-only SQL against live Neon, **restricted to `closed_at < 2026-09-14 00:00 Asia/Kolkata`.**
  `scribe` is running the E5 measurement on today's data in parallel; excluding today keeps your
  counts clean and keeps you out of its way.
- Source reading at `fe021a3` for C2 and C4.
- Rerun the model's three scratch files if useful:
  `docs/handoff/scratch/E4-STARVATION-*-14-SEP-2026.*` (`python3`, ~15 s). Note their room count is 6
  and C3 disputes that — rerunning at 8 rooms is worth one paragraph.

## ALLOWED CHANGES

Read-only SQL; scratch files under `docs/handoff/scratch/`. Nothing else.

## DO NOT

- Do **not** change code, flags, env vars, migrations or `vercel.json`.
- Do **not** run, enqueue or retry any job — `scribe` owns the Mini and the job path this round.
- Do **not** touch anything under `lib/stt/auto-drain.ts` or `lib/emotion/`.
- Do **not** query or reason about data from 14 Sep.
- Do **not** quote transcript text from real room audio. Counts, timings, ids, error strings only.
- Do **not** deploy, push, merge or open a PR.

## WHAT TO VERIFY — verdict each as UPHELD / BROKEN / UNVERIFIED, with the evidence inline

C1, C2, C3, C4 above. Plus:

- **V5.** Whether my per-day cut is the right cut at all, or whether the honest unit is per room per
  **session**, or per room per **kiosk uptime run**. If a kiosk restarts mid-day its phase resets, and
  a day is then two phases averaged — which would mean my per-day sd is itself the aggregation error I
  accused the 7-day figure of. **If you find that, say so plainly; it inverts my own rule 16 against
  me and I would rather hear it from you than discover it next week.**
- **V6.** Whether close lag is dominated by kiosk rotation phase or by per-room upload/verify latency.
  Either way it is a fixed per-room offset and the starvation conclusion survives, but the *fix* differs
  — say which it is.

## OUTPUT

`docs/handoff/ETA-E6-REFUTATION-14-SEP-2026.md`.

1. One line per claim: C1 C2 C3 C4 V5 V6 — UPHELD / BROKEN / UNVERIFIED.
2. For each BROKEN: what the correct figure or fact is, and which ruling in the E4 document it
   invalidates, by name (R1–R7).
3. Anything I should have checked and did not.

**Cap: 100 lines.** Raw output to `docs/handoff/scratch/E6-*-14-SEP-2026.*`.

## KNOWN FACTS

- The DB connection string is at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf`
  (outside the repo, not tracked). **Read it, use it, never print it, never copy it into the repo.**
- Tables: `bench_window` (state is only ever `open` or `closed`), `bench_session`,
  `room_diarize_window`, `room_emotion_window`, `scribe_job`, `stt_window_measure`, `stt_window_score`.
  `room_diarize_window` and `room_emotion_window` key on `window_id`; neither has `created_at`.
- `room_diarize_window`: 15 rows all time, all `ok`. `room_emotion_window`: 0 rows all time.
- `scribe_job` last 7 days: 13 rows, 10 `failed`.
- `auto_drain_refused_reason` is NULL on all 1,507 rows — auto-drain has never selected anything.
- Docker is down on the Mini; the unit suites will not run. Do not start it — `scribe` needs the box.
- Router `/healthz`, not `/health`, on 8083.

If C2 breaks, stop and report immediately — every other number in the ruling becomes decorative and
I would rather know in twenty minutes than in ninety.
