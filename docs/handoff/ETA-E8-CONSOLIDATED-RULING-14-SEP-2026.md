# ETA-E8 — consolidated ruling: E5 (no run), E6 (refutation), and the deadlock · 14 Sep 2026 · Orchestrator

Rules on `ETA-E5-THROUGHPUT-REPORT-14-SEP-2026.md` and `ETA-E6-REFUTATION-14-SEP-2026.md`.
I ran `scratch/E6-QUERIES-14-SEP-2026.sql` myself — the Refuter's session was denied live reads and it
did not work around the denial, which was right. The temp view it uses is illegal in a read-only
transaction; I inlined it as a CTE. Everything below is live, read-only, cut at 14 Sep 00:00 IST.

---

## 1. Verdicts on my own E4 evidence

| Claim | Verdict | The number |
|---|---|---|
| **C2** — one shared IST quarter-hour grid for every room | **UPHELD, source and live** | 1,307 windows: **0** off-grid, **0** not grid-aligned. `slotStartFor` is epoch-absolute; no room, session or kiosk enters it. |
| **C3** — 7–9 concurrent rooms, 28–32 windows/hour | **UPHELD** | By *recording* hour: 10 Sep **8–9 rooms, 28–32/h** for nine straight hours; 11 and 12 Sep **7 rooms, 28/h**; 09 Sep 6 rooms, 24/h. Close-hour and recording-hour cuts agree. `room_slots = windows` in every row, and the whole dataset holds **1** duplicated room-slot. None of the three inflation mechanisms is materially present. |
| **C4** — count | **UPHELD** | `closed` **1,291 with 0 clips** · `transcribed` 15 with 15 clips · `open` 183 · `failed` 1. |
| **C4** — my explanation | **BROKEN** | See §2. The missing flags were sufficient but not the only gate, and not the operative one. |
| **C1 / V5** — phase is stable per *day* | **BROKEN, and replaced by something sharper** | See §3. |
| **V6** — phase or latency | **ANSWERED, with a caveat the aggregate hides** | See §4. |

## 2. C4 — the pipeline has no head, and my own R1 is what removes it

The Refuter's §4 is the finding of the day and it is correct from source, which I have now confirmed
against live data.

`clip_r2_key` has **exactly one writer** — `roomWindowPrepare` (`lib/stt/room-drain.ts:643`), reachable
only through `drainRoomWindow`. Its callers are the auto-drain cron (`auto-drain.ts:135`) and two admin
routes behind a cookie. Diarize selects only `clip_r2_key IS NOT NULL` (`diarize-job.ts:131`); emotion
requires a diarize row `ok` (`enqueue.ts:58-60`). Therefore:

> **With `ROOM_AUTO_DRAIN_ENABLED` off, the unattended pipeline produces zero rows by construction —
> whatever `ROOM_DIARIZE_ENABLED` and `EMOTION_ENABLED` say.** 1,291 closed windows with 0 clips is
> not a symptom of dormant flags. It is the shape of a pipeline with no head.

**I turned on the two flags that cannot matter and ruled off the one that does.** §1.3 of the E4 ruling
("dormant by absence") is incomplete and R4's framing that "the flags went live today" is wrong for the
unattended path. R1's *reasons* (capacity, unmeasured service rate) stand. Its *effect* is that E5 could
not have run, and that is the deadlock in §6.

A third gate sits behind it, now measured: **`room.transcript_enabled` is TRUE on 2 of 13 rooms.**
Auto-drain's join requires it (`auto-drain.ts:113`). Only `room_ymch4bxu` (113 windows) and
`room_2qe955hy` (76) are reachable — **189 of 1,378, 13.7%**.

**And a fourth queue nobody has mentioned: `stt_subject_job` holds 229 `asr` rows in state `queued`**,
against 3 done and 1 failed. Flagged, not ruled — I do not yet know what drains it.

## 3. V5 — the Refuter was right about the unit, and the per-run cut is brutal

The honest unit is the **kiosk run**, not the day: phase re-arms on `startDay`, on resume after every
pause, and on reload/rejoin. Cut that way:

> **Inside a kiosk run, `sd_phase` is 0.0 — exactly, not approximately.** 09 Sep `room_bh6jtq4t` n=42
> sd 0.0 · 12 Sep `room_4ggnkg5x` run 0 n=23 sd 0.0, run 1 n=15 sd 0.0 · 12 Sep `room_87frpus9`
> runs 0/2/3 sd 0.0 each. Between runs the median jumps the full width of the grid: `room_87frpus9`
> on 12 Sep sits at 14.1 s, then 237.3 s, then 299.2 s.

So my per-day sd of 40–145 s on 11–12 Sep was several rigid runs averaged together — **rule 16 applied
to me, one level down, exactly as the brief warned it might be.** My cut was wrong.

The conclusion does not soften; it changes shape:

- **Within a run, the ranking is perfectly rigid** — more rigid than I claimed. A room that is losing
  loses every single tick until something restarts its kiosk.
- **Between runs it reshuffles.** 09 Sep: one run per room, no reshuffle — total starvation all day,
  the case E4 modelled. 12 Sep: 2–4 runs per room — the losers change several times.
- **Therefore the only thing currently distributing drain capacity fairly is kiosk instability.**
  Pauses, reloads and restarts are what stop one room owning the queue all day. **Stabilise the
  kiosks — which we want — and the starvation gets worse, not better.** Fairness must be built before
  reliability improves, not after.

## 4. V6 — phase dominates on a normal day; the aggregate says otherwise and the aggregate is wrong

Across all 35 room-days: mean variance of phase 2,860 vs latency 1,514,302, median latency 2,445 s.
That reads "latency dominates" — and it is an artefact of four rows. Two August test sessions carry
median latencies of 12,951 s and 72,228 s, and one 11 Sep room-day has sd 1,434 s.

On the September clinic days the picture reverses cleanly: **median upload/verify latency 7.3–14.8 s
with sd 1.0–3.1 s, against phase sd 13–100 s.** Phase is the variance; latency is a small constant.

Ruling: **rank on a recorder-side timestamp, as R6 requires** — that fixes the pathological late-verify
case. But the everyday unfairness is rotation phase, and no timestamp change touches it. R5's
round-robin is still the fix; R6 is the guard against the 18-hour outlier jumping the queue.

## 5. The ceiling is emotion, not auto-drain — R3 is withdrawn as framed

`scribe` F4, from source: emotion enqueues **one job at a time system-wide**, and none while one is
queued or running (`lib/emotion/enqueue.ts:46-47,65`), on `*/5`. Diarize takes 4 a tick (48/h).
Auto-drain takes 1 (12/h). Three queues in series; the end-to-end rate is the slowest.

> **At most 12 windows an hour can ever reach an emotion row. Demand is 28–32.**
> Raising `AUTO_DRAIN_BATCH_LIMIT` alone cannot lift end-to-end throughput past 12/h.

R3 said the cap to fix was auto-drain's. **That was the wrong cap.** The binding constraint is emotion's
`LIMIT 1`, and it is not an env var — it is structural. R3 is withdrawn and replaced:

**R3′ — the cap to derive is emotion's, and it is derived from the Mini's measured per-window emotion
time, which nobody has. That measurement is now the critical path.**

## 6. Answers to `scribe`'s three questions

1. **Which rooms may the measurement use?** The two that are Transcript-on: `room_ymch4bxu` (113) and
   `room_2qe955hy` (76). **Do not switch Transcript on in more rooms for a measurement** — that is a
   live clinical switch and changing it to make a test convenient is how a test stops measuring the
   system. Two rooms is enough for a *rate*; note the limitation. `room_2qe955hy` being "Home Office"
   is an advantage here, not a defect: throughput does not care what the audio says.
2. **Which entry point is "the auto path"?** None of the manual doors is, and that was the right call to
   stop on. The auto path is the cron, and for a backlog window it is unreachable only because of a flag
   and a 6-hour age bound. **So stop simulating it and use it** — §7.
3. **Does "done" keep the emotion row?** **Yes, and report all three stages separately.** Given §5 the
   per-stage rates are the actionable numbers and the end-to-end figure is the honest headline. Both.

## 7. The deadlock, and how it breaks

The auto-drain cannot be enabled until its service rate is measured; the service rate cannot be measured
because the auto-drain is the only unattended thing that produces the input. Simulating it produces a
measurement of the simulation.

**Ruling: the measurement is a contained live run of the shipped configuration.** Conditions, all of
which are already true or are single reversible settings:

- Nothing is recording (holiday, confirmed: 0 windows closed in the last hour).
- Only 2 of 13 rooms are Transcript-on, so the blast radius is **189 windows**, capped by the data.
- `AUTO_DRAIN_BATCH_LIMIT` stays at **1** — the shipped value is the thing under measurement.
- `AUTO_DRAIN_MAX_AGE_HOURS` is raised for the window of the run, because the backlog is 1–5 days old
  and the 6-hour bound excludes all of it. This is not on the header's forbidden list.
- `ROOM_AUTO_DRAIN_ENABLED` on for the run, **off again before clinic opens tomorrow.** This is the
  step that must not be forgotten; it is written into the kickoff as its own task.
- At 12/h the run self-limits: roughly 24 windows in two hours, and the full 189 would take 16 hours.

This measures drain, diarize and emotion rates on production infrastructure with real audio, which is
what R4 asked for and could not get any other way.

**Pending V's go-ahead** — first production run of a pipeline that has never run, on clinic audio.
Everything else is ruled.

## 8. Standing

- C2 closed, upheld · C3 closed, upheld · C4 count upheld, explanation **mine, broken** · C1/V5 **mine,
  broken**, replaced by §3 · V6 answered, §4.
- R1 stands but is **suspended for the contained run** in §7.
- R2 (do not touch the sort) stands, and §3 strengthens it: the fix is round-robin, and it is now more
  urgent because kiosk stability will remove the accidental fairness.
- R3 **withdrawn**, replaced by R3′.
- R5, R6, R7 stand.
- `stt_subject_job` 229 queued `asr` rows — new, unruled.

Orchestrator. Live queries run read-only by me. No subagents.
