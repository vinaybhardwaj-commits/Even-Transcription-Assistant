# ETA — S1 MERGE, PART 3 — ONE QUESTION, READ-ONLY
**14 September 2026 · Session: `scribe` (same session, DB env present) · branch `vinay/s1-auto-drain` at `fe021a3`**

Your Part 2 report is accepted. 0091 and 0092 are applied, no lock timeout fired,
`auto_drain_refused_at` and `auto_drain_refused_reason` exist as nullable with no default, version 92
recorded. The C23 table is exactly the shape I asked for and **F1 is the right flag to have raised.**

## 1. F1 — I have partial evidence already; go and test it, do not explore

Your two candidate causes were real recording or late closing. **The room list says it cannot be real
recording.** From `scribe_list_rooms`, read this morning:

- `room_qyzghzaf` (OPD 7) — `last_session_at` **2026-09-13T03:46:40Z**, status `ended`.
- `room_ux92qpws` (OPD 4 – Ortho) — `last_session_at` **2026-09-11T04:41:44Z**, status `ended`.

Neither room has had a session today. Yet each has **24 windows whose `closed_at` falls inside the last
6 hours**. Audio recorded on 11 and 13 September cannot have been closed within the last six hours by the
act of recording. **So something closed them late, in bulk, today.** That is the hypothesis. Test it.

### C24 — the query, read-only

For `room_qyzghzaf` and `room_ux92qpws`, for the 24 windows each that satisfy the drain's age condition,
report per room:
- the **min and max window start time** (the window's own grid start, not `closed_at`);
- the **min and max `closed_at`**;
- the **spread between them** — i.e. how long after the audio each window was closed;
- whether the 24 `closed_at` values are **clustered** (a bulk close) or **spread evenly** (a live day);
- which `bench_session` each belongs to, and that session's `ended_at`.

Then name, from the code, **which process closes a window late**. Candidates to check, not to assume: the
hourly reap-stuck cron, the day-rollover reaper that ends a still-recording session at IST midnight, and
`resume-processing`. Cite the file and line that performs the close. **Do not change any of them.**

**If the clustering confirms a bulk close, say so plainly and stop.** The ruling that follows is mine.

## 2. Why this matters more than it looks

`AUTO_DRAIN_MAX_AGE_HOURS` gates on `closed_at`. If a reaper can close a batch of days-old windows today,
then that gate is **not** an audio-recency filter — it is a "recently closed" filter, and on any day after
a reaper run the drain would pick up days-old audio as though it were fresh. On an ordinary day the two
readings coincide; after a backfill or a reaper sweep they do not. We shipped that selector this morning,
so I want the distinction established before `ROOM_AUTO_DRAIN_ENABLED` is ever set, not after.

**24 windows × 15 minutes = exactly 6 hours** is not a coincidence: it is the maximum the window can hold.
That is a saturation artefact, and it is what tipped you off. Good catch.

## 3. F3 — not yours, and not a blocker

You could not read production's `AUTO_DRAIN_MAX_AGE_HOURS` or `AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES`, and
you were right to say the counts assume code defaults. There is no Vercel CLI or token in your session.
**V checks both in the Vercel dashboard when he promotes.** If either is set to a non-default value the
C23 counts need re-running; state that as a caveat in your report and leave it there.

## 4. Standing constraints, unchanged

Read-only. **Do not enable any flag. Do not change any tunable. Do not run the drain. Do not push. Do not
promote.** `APP_DATABASE_URL` is still for §1 only — no other table, no other round; never echo it. Env var
**NAMES only, never values**. Never reproduce the banned id shape.

`scribe3` is running M7 on the Mini; **do not start any Mini work** and do not run the test suite while it
is live.

## 5. Report

Append a **PART 3** section to your existing report, or a new file — say which. The per-room table from
§1, the named closing process with its file and line, your verdict on clustered-vs-spread, and the F3
caveat. Commit this kickoff with it. **Do not `git add .`.**

## 6. One more thing, for the record

`room_2qe955hy` (Home Office) is **Transcript ON with zero recent windows**. That makes it the clean room
for the first real auto-drain run once V records into it. Nothing to do now — noting it so it is not
rediscovered later.
