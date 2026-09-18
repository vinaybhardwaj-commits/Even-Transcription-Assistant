# ETA-E9 — VERDICT on the first live run of the pipeline · 14 Sep 2026 · Orchestrator

The run is **over and the flag is off**. `ROOM_AUTO_DRAIN_ENABLED=0`, `AUTO_DRAIN_MAX_AGE_HOURS` back to
`6`, production redeployed as `4fTUJfFG1` (commit `fe021a3`) and serving. Clinic tomorrow is safe.

`scribe` was blocked by its permission layer at step 1 and then lost its reads, so the 30-minute
sampling never happened. I measured the run myself, read-only, after the fact. Window
**16:40–18:53 IST, 2 h 13 m.**

---

## 1. The headline

> **The drain works. Everything downstream of it does not.**
> 25 drain attempts, **21 failed**. Zero windows reached an emotion row. The pipeline's first live run
> delivered **0 completions end to end**.

## 2. The numbers

| Stage | Attempts | Done | Failed | Rate | Timing |
|---|---|---|---|---|---|
| **drain** (`room_window`) | **25** | 4 | **21** | **11.5/h** — matches the 12/h cron cap | p50 36.3 s · p90 76.6 s · max 99.3 s |
| **diarize** (`diarize_window`) | 6 | **6** | 0 | fed only by what drained | p50 47.6 s · p90 65.5 s · max 70.9 s |
| **emotion** (`emotion_window`) | **0** | 0 | 0 | **0/h** | never fired |

Window states moved `closed` 1,452 → 1,442 · `transcribed` 16 → 19 · `failed` 1 → **8** (7 of which
keep their clip). `room_diarize_window` 15 → 21 (19 `ok`, 2 `no_speakers`). `room_emotion_window`
**still 0 rows, all time**.

**The drain fires reliably.** 25 attempts in 2 h 13 m is 11.5 an hour against a `*/5` cron at cap 1 —
essentially every tick. My earlier worry that it was firing at half rate was wrong; the single job at
16:52 was simply the deploy having just landed. **No refusals were recorded** (`auto_drain_refused_at`
is still NULL everywhere), so C6's cooldown never engaged.

## 3. Break #1 — `whisper_unavailable`, 21 of 25, one cause

Every failure carries the same string: `room_window_failed: whisper_unavailable`. **84%.**

It is not the service and not the engine configuration:

- **All nine Mini services answer.** whisper 8080 `/health` 200 (it does not serve `/healthz`), 8081
  `/healthz` 200, indic 8082, router 8083, status 8084, sravaani 8085, emotion 8086, diarize 8001,
  relay 8787 (426, which is correct for a websocket). launchd shows `uk.llmvinayminihome.whisper`
  (1813) and `whisper-shim` (1816) both running.
- **The engine row is healthy.** `stt_engine` `whisper`: `enabled=TRUE`, `fanout_enabled=TRUE`,
  `is_paid=FALSE`, cost 0. Migrations 0091 and 0093 did not touch it — they disabled gemini, deepgram,
  elevenlabs, elevenlabs_scribe and ekascribe, exactly as ordered.
- **And 4 attempts succeeded.** So the path is not dead, it is *intermittent* — which rules out a
  missing env var or a wrong hostname and points at reachability under load, concurrency, or a probe
  that reports unavailable for the wrong reason.

Note the shape of the probe risk, because it is testing rule 6 again in the same programme:
**8080 serves `/health` and 404s `/healthz`; 8081 does the opposite.** Any probe that asks the wrong
path gets a 404 and, if it treats "not a 2xx" as down, reports `unavailable` on a perfectly healthy
service. That is a hypothesis, not a finding — it is the Debugger's first place to look.

## 4. Break #2 — emotion never fires at all

Nineteen `room_diarize_window` rows in state `ok` were sitting there for the last hour of the run and
**not one `emotion_window` job was created.** E8 §5 predicted a structural ceiling of 12 an hour.
Observed is **zero** an hour, which is a different and worse problem: the ceiling is academic while the
scan selects nothing.

The concrete hypothesis, from `lib/emotion/enqueue.ts:58-60`: the scan requires a diarize row that is
`ok` **and carries a `last_run_id`**. If those 19 rows have a NULL `last_run_id`, the scan is correct
and the input is malformed — which would be the third instance today of a stage selecting on a column
the stage before it did not write.

## 5. The starvation, observed live — this is no longer a model

Two rooms were eligible. `room_ymch4bxu` holds **113** backlog windows; `room_2qe955hy` holds 76.

> **All 25 slots went to `room_2qe955hy`. `room_ymch4bxu` got zero, for two hours and thirteen
> minutes.**

The mechanism is exactly the one E4 described and E6 upheld: `closed_at DESC` ranks rooms against each
other, `room_2qe955hy`'s newest window is 13 Sep against `room_ymch4bxu`'s 12 Sep, and the loser stays
the loser on every single tick. **100% / 0% across the whole run.** R5's round-robin is no longer a
precaution against a simulated harm; it is a fix for something we have now watched happen on
production.

## 6. What this changes

- **R1 is reinstated and hardened.** The drain stays off. It now has two named downstream breaks, not
  just an unmeasured service rate.
- **R3′ stands but is deferred.** Deriving emotion's cap is pointless until emotion runs at all.
- **R5 is promoted.** The fairness fix has live evidence behind it.
- **E8 §5's 12/h ceiling is unconfirmed and untestable for now** — nothing reached the stage it bounds.
- **New: 7 windows sit in `failed` state holding a clip.** They are recoverable work, not loss, and
  they are the natural test set for whatever fixes §3.
- **`scribe`'s permission block cost us the sampling but nothing else**, and its instinct to write the
  BEFORE snapshot before touching anything was right: `scratch/E9-BEFORE-14-SEP-2026.json` is now the
  only record of the room switches. **No room was ever switched** — the blocked `UPDATE` ran none of
  its parts — so the 2-of-13 state is unchanged and needs no restoration.

## 7. On the two documents that disagreed

`scribe` flagged that E8 §6.1 ("do not switch Transcript on in more rooms for a measurement") and the
E9 kickoff (which orders it, citing V's authorisation) contradict each other. It was right to stop and
ask rather than pick one. **E9 stood** — V's authorisation was explicit and later. The question is now
moot: the permission layer blocked the write, the run went ahead on two rooms, and two rooms turned out
to be enough to demonstrate the starvation more clearly than nine would have.

The lesson is mine to carry: when a later brief reverses an earlier ruling, **the reversal belongs in
the ruling document**, not only in the brief that supersedes it. I left a contradiction on the bus and
an agent spent its permission budget discovering it.

## 8. Next

1. **Debugger, Opus** — root-cause `whisper_unavailable`. Brief: `ETA-E10-WHISPER-UNAVAILABLE-DEBUGGER-BRIEF-14-SEP-2026.md`.
2. **One query** — do those 19 `ok` diarize rows carry a `last_run_id`? Settles §4 in a minute.
3. R5 round-robin moves up the queue on the strength of §5.

Orchestrator. Measurements read-only by me. Vercel change made by a delegated browser agent and
confirmed by re-read.

---

## 9. CORRECTION to §4 — the `last_run_id` hypothesis is WRONG

I ran the one-minute query in §8.2 before briefing the Debugger, and it refutes what §4 proposed.

`room_diarize_window` state × `last_run_id`:

| state | rows | with `last_run_id` | with `diarized_at` | with `speakers_json` |
|---|---|---|---|---|
| `ok` | 19 | 5 | 19 | 19 |
| `no_speakers` | 2 | 2 | 2 | 2 |

All 21 rows carry a `room_day_id` and a `clip_r2_key`. **All six rows diarized tonight carry a
`last_run_id`**, at attempts=1 with no error — 16:56:55, 17:01:45, 17:05:51, 17:45:59, 18:21:33,
18:41:32.

**By the scan's own predicate (`state = 'ok'` AND `last_run_id IS NOT NULL`) there were 5 eligible
rows, four of them sitting there from 16:56 onward.** The emotion cron had nearly two hours and
roughly 22 ticks to pick up work that met its stated condition, and it created **nothing**.

So the input is not malformed. The scan is not starved. **The emotion stage did not run**, and the
reason is upstream of the predicate — the flag not actually being live in the running deployment, the
cron not firing, or a gate in `enqueue.ts` that neither E5 nor I have read (an attempt bound, a consent
condition, a window-age condition). That is now a question for the Debugger, and it is a cleaner
question than the one I asked in §4.

Worth noting against my own record: §4 named a hypothesis and called it a hypothesis, and one query
killed it in under a minute. The cheaper cousin of the mutation check — *a 30-second experiment beats
an argument from reading* — paid for itself again. The mistake would have been putting §4 in a brief
as a known fact.
