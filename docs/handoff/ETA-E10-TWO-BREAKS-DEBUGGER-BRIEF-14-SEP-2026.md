# ETA-E10 — two breaks from the first live run · DEBUGGER BRIEF (Opus) · 14 Sep 2026

Read `ETA-E9-VERDICT-FIRST-LIVE-RUN-14-SEP-2026.md` first, **including §9, which withdraws the
hypothesis in §4**. Root-cause work only. You are not fixing anything in this round.

## CONTEXT

The auto-drain ran live on production for 2 h 13 m tonight (16:40–18:53 IST) and is now **off again**
(`ROOM_AUTO_DRAIN_ENABLED=0`, deployment `4fTUJfFG1`, commit `fe021a3`). It fired reliably — 25
attempts, 11.5 an hour against a `*/5` cron at cap 1. Everything downstream of it broke. **Zero
windows completed end to end.** Two independent failures, and you are after the cause of both.

## BREAK 1 — `whisper_unavailable`, 21 of 25 drains

Every failed `room_window` job carries exactly `room_window_failed: whisper_unavailable`. **84%.**

What is already ruled out — do not re-establish these:

- **Not the service.** All nine Mini services answer right now: whisper 8080 `/health` 200, 8081
  `/healthz` 200, indic 8082, router 8083, status 8084, sravaani 8085, emotion 8086, diarize 8001,
  relay 8787 (426, correct for a websocket). launchd: `uk.llmvinayminihome.whisper` pid 1813 and
  `whisper-shim` pid 1816, both running.
- **Not the engine row.** `stt_engine` where id = `whisper`: `enabled=TRUE`, `fanout_enabled=TRUE`,
  `is_paid=FALSE`, cost 0. Migrations 0091/0093 disabled gemini, deepgram, elevenlabs,
  elevenlabs_scribe and ekascribe only.
- **Not a dead path.** **4 of the 25 succeeded.** It is intermittent, which is the most useful fact in
  this brief and should shape where you look first.

Where to look, in the order I would look:

1. **The probe's path.** 8080 serves `/health` and **404s `/healthz`**; 8081 does the exact opposite.
   Any caller that asks the wrong path gets a 404, and any caller that reads "not a 2xx" as "down"
   reports `unavailable` on a healthy service. This programme has already been bitten by exactly this
   (testing rule 6: a shim answering every non-`/healthz` path with a static 404 made a transcription
   probe that had never once tested transcription). **Find who raises `whisper_unavailable` and on
   what evidence.** If it is a liveness probe rather than a failed transcription call, that is the bug.
2. **Concurrency.** whisper.cpp's server is effectively single-request. Six `diarize_window` jobs ran
   in the same window at 47–71 s each. If the drain's whisper call and something else contend, a
   refusal under load would look exactly like this.
3. **The tunnel.** Vercel reaches the Mini through Cloudflare. An intermittent tunnel gives the same
   4-in-25 shape. Distinguish this from (1) and (2) by evidence, not by plausibility.

## BREAK 2 — emotion never enqueued anything

Zero `emotion_window` jobs were created in the whole run. Not one failure — **no job at all.**

By the scan's stated predicate in `lib/emotion/enqueue.ts:58-60` (`state = 'ok'` AND
`last_run_id IS NOT NULL`) there were **5 eligible rows**, four of them present from 16:56 onward, all
with `room_day_id`, `clip_r2_key`, `diarized_at` and `speakers_json` populated, attempts = 1, no error.
Roughly 22 cron ticks passed.

So the input is well-formed and the scan is not starved. The cause is upstream of the predicate.
Candidates, none confirmed:

- `EMOTION_ENABLED` set in Vercel but not actually live in the running deployment.
- The emotion cron missing from `vercel.json`, or registered and not firing.
- A further condition in `enqueue.ts` that neither the E5 Builder nor I have read — an attempt bound, a
  window-age bound, or a **consent gate** (see `ETA-C3-EMOTION-CONSENT-DECISION-MEMO-13-SEP-2026.md`).

**Read `lib/emotion/enqueue.ts` end to end before theorising.** Both of my hypotheses about this file
today have been wrong, and the second one died to a single query.

## SCOPE

Root cause, evidence, and a named minimal fix for each break. **No fix is implemented this round.**

## ALLOWED

Read-only SQL against live Neon; source reading at `fe021a3`; curl and `launchctl list` on the Mini;
reading logs; scratch files under `docs/handoff/scratch/`. You may make **read-only** probe calls to
the Mini services to establish which path each answers.

## DO NOT

- Do **not** change code, flags, env vars, migrations, `vercel.json` or room rows.
- Do **not** turn `ROOM_AUTO_DRAIN_ENABLED` back on. It is off deliberately and clinic opens tomorrow.
- Do **not** enqueue, retry or submit a job — with one exception: to separate "the stage is broken"
  from "the stage is unfed" you may submit **one** `emotion_window` job by hand against one of the 5
  eligible rows. Report it as a manual probe, clearly separated, and do it only if reading the source
  cannot settle it.
- Do **not** restart, reconfigure or redeploy any Mini service.
- Do **not** deploy, push, merge or open a PR.
- Do **not** quote transcript text, speaker names or clinical content. Counts, timings, ids, room ids
  and error strings only.

## VERIFY — PASS / FAIL / UNVERIFIED

- V1 You identified the exact line that raises `whisper_unavailable` and what it tests.
- V2 You can explain why **4** succeeded and 21 did not — a cause that predicts intermittency, not one
  that predicts total failure. **If your explanation would have failed all 25, it is the wrong cause.**
- V3 You read `lib/emotion/enqueue.ts` completely and can name every condition between a diarize row
  and an enqueued job.
- V4 You changed nothing.

## OUTPUT

`docs/handoff/ETA-E10-ROOTCAUSE-14-SEP-2026.md`

1. Break 1: cause, the evidence, the minimal fix, and what it would cost to get wrong.
2. Break 2: same.
3. V1–V4.
4. Anything you found that neither break explains.

**Cap: 110 lines.** Raw evidence to `docs/handoff/scratch/E10-*-14-SEP-2026.*`.

## KNOWN FACTS

- DB string at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf`. Read it, use it, never
  print it, never copy it into the repo.
- Run window 16:40–18:53 IST today. `scribe_job`: `room_window` 4 done / 21 failed;
  `diarize_window` 6 done / 0 failed (p50 47.6 s, p90 65.5 s, max 70.9 s); `emotion_window` none.
- `bench_window`: `closed` 1,442 · `open` 183 · `transcribed` 19 · `failed` **8**, seven of which hold
  a clip. Those seven are the natural test set for a fix.
- `room_diarize_window` 21 rows (19 `ok`, 2 `no_speakers`); `room_emotion_window` **0 rows, all time**.
- `auto_drain_refused_at` is NULL on every row — the drain's cooldown never engaged.
- Only 2 of 13 rooms have `transcript_enabled`. All 25 slots went to `room_2qe955hy`; `room_ymch4bxu`,
  with 113 eligible windows, got zero. That is the starvation, and it is **not** your problem this
  round — do not chase it.
- Docker is down on the Mini. You do not need it.
- Router is `/healthz` on 8083. Its `results` IndexError was fixed today; if you see one, say so.
