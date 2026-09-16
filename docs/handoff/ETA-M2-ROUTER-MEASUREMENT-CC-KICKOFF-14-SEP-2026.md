# ETA — M2: CLOSE M1's GAPS AND MEASURE THE ROUTER — CC KICKOFF
**14 September 2026 · Session: `scribe3` · Mini only. Read-only on the services — no edits, no restarts.**

M1 is accepted (`docs/handoff/ETA-S1-ROUND2-RULINGS-14-SEP-2026.md` §7). Two jobs remain, and the second
one gates a production flag.

## 0. Rules

No code change, no env change, no service restart, no `git` command in the app repo. Synthetic audio only —
macOS `say`, never patient audio. **Run nothing else against the Mini while measuring**: M1 changed
`latency_ms` (diarize) and `sec` (router) to *include* time queued behind a previous request, so a
concurrent probe silently inflates every number.

## 1. Close M1's own not-verified list

1. **Two `/route` calls at the same time.** Confirm the semaphore holds — they run one after the other,
   neither errors, and both return the same shape as a solo call. Report both wall times and both `sec`
   values, and say explicitly how much of the second `sec` is queue wait.
2. **`/route/job` and its status endpoint.** Submit one job, poll it to completion, report the states seen
   and the final shape.
3. **Health while both of the above run.** It must stay ≤500 ms. Quote the worst number.

## 2. THE MEASUREMENT — `route`'s realtime factor at clinic length

This is the number that sets the auto-drain's cap. Two prior figures disagree by more than 20× — a 0.5 s
fixture answered in 2.5–4.5 s, while an 18 s clip that reached both the Whisper and the Indic engines took
35 s. **Neither can be extrapolated.** Measure the real thing.

- Build a **900-second** clip with `say` — the same length as a real `bench_window`. Use varied
  connected speech, not one repeated sentence, and include some non-English if `say` has a voice for it, so
  the router's per-segment language routing actually branches. Say in the report exactly how you built it.
- `POST /route` with it, `translate=false`, **locally (127.0.0.1:8083)**, nothing else running.
- Report: wall time · reported `sec` · **realtime factor (wall ÷ 900)** · number of segments · which engines
  the per-segment timeline shows · peak memory if you can get it cheaply.
- Run it **twice** and report both. If the two differ by more than 25%, run a third and say so.
- Then run the same clip with `translate=true` once, and report the delta — translation is on for room
  windows and must be in the number.

**Do not extrapolate, do not average the two prior figures, and do not recommend a cap.** Report the
measurement; the cap is the Orchestrator's ruling.

## 3. Report

`docs/handoff/ETA-M2-ROUTER-MEASUREMENT-14-SEP-2026.md` (file only, no commit), at most 400 words:
§1 results · §2 the table of runs with the realtime factor in its own column · how the clip was built ·
what you did not check. If any run fails, report the failure rather than a substitute measurement.
