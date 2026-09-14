# ETA — P4: WHERE DID THOSE 48 WINDOWS COME FROM — ONE TABLE, READ-ONLY
**14 September 2026 · Session: `scribe` · branch `vinay/s1-auto-drain` at `fe021a3` · DB env present**

## 0. Your P3 verdict conflicts with two live readings. I am not ruling until they reconcile.

You reported: *"not a bulk close. OPD 7 and OPD 4 recorded continuously today, with windows closed live by
the chunk-upload route."*

Two readings taken at **12:48 IST**, through the operator MCP, say otherwise:

| Source | OPD 7 (`room_qyzghzaf`) | OPD 4 – Ortho (`room_ux92qpws`) |
|---|---|---|
| `scribe_diff_room` (now) | `recording: false`, `recording_session_id: null`, `last_piece_at: null`, `audio_recorded_ms: 0`, `backup_chunks_today: 0`, mic peak 0.003, state **Ready** | same, mic peak **0** |
| `scribe_day_report` for **2026-09-14** | **`sessions: []`** — no session rows today at all | not yet read |

**If OPD 7 has no session today, it cannot have recorded continuously today.** Something is wrong in one
of the three accounts, and I would rather find out which than pick the one I like. I already flipped once
on this — I argued bulk-close, accepted your refutation, and now the live data points back. **No more
inference. Get the numbers.**

The most likely explanation for the conflict, stated so you can test it rather than assume it: your
"recorded continuously" may have been read off an even spread of **`closed_at`**, and an even spread of
`closed_at` is also exactly what a timed closing process produces. The decisive column is the window's own
**start**, which `closed_at` cannot substitute for.

## 1. C25 — one table, read-only

For **both** `room_qyzghzaf` and `room_ux92qpws`, for the windows that satisfy the drain's age condition
(the same set that produced your 24-each count), report **one row per window**:

| column | note |
|---|---|
| window id | |
| **grid start** | the window's own start (`start_ms` or equivalent) — **in IST**, not epoch |
| **`closed_at`** | in IST |
| **gap** | `closed_at` minus grid start, in minutes |
| `session_id` | |
| that session's `started_at` and `ended_at` | in IST |
| `room_day_id` | and the room_day's date |

Then, **per room**, state plainly:
1. Do the grid starts fall **today**, or on 11/13 September?
2. Is the gap ~15 minutes (live close) or **hours to days** (late close)?
3. Do the `session_id`s point at sessions that **ended days ago**?
4. How many distinct sessions are involved?

**Also: what is the most recent window of any kind for each room — its grid start and `closed_at`?** That
tells us whether anything is still arriving right now.

## 2. Then, and only then, one code question

Whichever answer §1 gives, name **the exact line that set `closed_at`** on these specific windows — not
the line that *could* have. `app/api/bench/chunks/route.ts:240 → lib/bench-window.ts:379` is the live path;
find whether anything else writes that column (a reaper, `resume-processing`, a backfill, a migration) and
say which one these rows went through, with your evidence. If the evidence cannot distinguish them, **say
that** rather than choosing.

## 3. Constraints

Read-only. **Do not stop, start or command any room.** Do not enable a flag, change a tunable, run the
drain, push or deploy. `APP_DATABASE_URL` is for this query only; never echo it. Env var **NAMES only**.
Never reproduce the banned id shape. **Do not quote any transcript text** — these are real clinical rooms;
counts and timestamps only.

`scribe3` still holds the Mini for M7 — no Mini work, no test suite.

## 4. Report

`docs/handoff/ETA-P4-WINDOW-PROVENANCE-REPORT-14-SEP-2026.md`, **cap 70 lines**. The full per-window table
goes to `docs/handoff/scratch/` and is cited by path; the report carries the summary rows and your four
answers per room. Commit this kickoff with it. **Do not `git add .`.**

## 5. Context you should have

V's instruction was *"stop the kiosks and record the error — **I know they were stopped**, so there is a
bug there."* The operator view says both rooms are idle **now**, so there is currently nothing to stop.
That makes the question "what created these windows, and when" the whole of the problem rather than a
detail of it. There is a real defect here somewhere; this table is how we find which one.
