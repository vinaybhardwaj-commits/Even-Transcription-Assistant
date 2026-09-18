# ETA-E14 — why does emotion scoring fail? · DEBUGGER BRIEF (Opus) · 14 Sep 2026 · pane `ETA-Refuter`

Read `ETA-E12-SCORING-EVIDENCE-14-SEP-2026.md` (`scribe3`, evidence only — it was told not to diagnose)
and `ETA-E11-VERDICT-AND-E12-NEW-BREAK-14-SEP-2026.md` §2.

**Root cause only. Change nothing.** Emotion is live and working through its queue on its own — that is
deliberate. Let it run; every job it finishes is more evidence.

## THE FACTS, ALREADY ESTABLISHED — do not re-derive

On the clean retry of window `bw_z3gpbh6e` after the auth fix: **24 scored, 30 failed, 166 skipped.**
Every one of the 30 failed with `malformed_scores`.

- **A length signal, strong but incomplete.** Failures cluster short — 12 under 1.5 s, median 1.85 s.
  **No scored segment is under 1.5 s**, median 5.46 s. And the service's `/health` reports
  **`min_speech_s 1.5`** and `silence_rms 0.008`.
- **But length does not explain everything.** 11 failures were ~29 s. The longest failure is 29.07 s and
  the cap is 60 s, so the cap is not involved.
- **The service is not erroring.** 11 segment requests since its restart, **all HTTP 200**, no log lines,
  no tracebacks, 5 torch warnings, one lazy model load. It is answering; the client dislikes the answer.
- **`malformed_scores` is assigned in exactly one branch of the client, and only for items the service
  marked `ok: true`.**
- **`app.py` on the emotion service was modified TODAY at 11:46**, alongside the router's VAD change.
  There is no known-good "before" — this stage has never worked in production, so do not assume the
  service was ever correct.
- Warm-up: a 1 s call that always fails.
- `scribe3`'s hypothesis, explicitly unverified: the service may return `ok: true` without labels for
  audio it judges unscorable.

## WHAT I WANT

1. **The exact response shape** the service returns for a failing segment, versus a scoring one.
   Read `app.py`. If it returns `ok: true` with absent, null or empty labels for audio below
   `min_speech_s` or below `silence_rms`, that is the answer to the 30 — and the client is right to
   call it malformed while the *contract* is wrong.
2. **Whose defect is it?** Three candidates, and they lead to three different fixes:
   - the **service** should return an explicit unscorable outcome, not `ok: true` with nothing in it;
   - the **client** should plan segments against `min_speech_s` and mark sub-threshold spans
     `skipped`, not `failed`;
   - the **diarizer** should not emit sub-1.5 s turns as scorable segments at all.
   Say which, with the evidence. More than one may be true; rank them.
3. **The ~29 s failures.** These are the ones that break the tidy story. A cause that only explains the
   short segments is not the answer — say so if that is where you land, and name what the 29 s ones
   need next. **A hypothesis that explains 19 of 30 is a partial result honestly reported, not a
   finding.**
4. **The 11:46 `app.py` edit.** Is `~/eta-emotion` under version control? If so, what changed today and
   does it touch scoring or thresholds? If not, say so — an unversioned service that changed on the day
   its stage first ran is a fact worth stating plainly, whatever the diff shows.
5. **Why `skipped` and `failed` matter differently.** Zero-scored is a **window failure**
   (`emotion-window.ts:191-193`) and burns one of three attempts; `skipped` does not. So misclassifying
   an unscorable span as failed does not just mislabel — it **exhausts windows**. Confirm that reading,
   and say how many of tonight's windows are on course to exhaust.

## DO NOT

- Do **not** change code, `app.py`, flags, env vars, migrations, plists, `vercel.json` or room rows.
- Do **not** restart the emotion service. It was restarted at ~20:07 and is working.
- Do **not** re-run, retry or cancel jobs. The cron is working the queue; let it.
- Do **not** touch `lib/stt/` or `room-drain.ts` — `scribe` is editing tests there.
- Do **not** turn `ROOM_AUTO_DRAIN_ENABLED` on.
- Do **not** listen to or quote audio, transcript text, speaker names or clinical content. Durations,
  counts, ids, labels and error strings only.

## VERIFY — PASS / FAIL / UNVERIFIED

- V1 You read `app.py` and can state its response contract for a segment it will not score.
- V2 Your cause predicts **both** populations — the short failures and the ~29 s ones — or you say
  explicitly which it does not explain.
- V3 You confirmed whether `failed` vs `skipped` changes whether a window exhausts its attempts.
- V4 You changed nothing and restarted nothing.

## OUTPUT

`docs/handoff/ETA-E14-ROOTCAUSE-14-SEP-2026.md`

1. Line 1: the cause, or the two causes, in one sentence each.
2. Whose defect, ranked, with the minimal fix for each and what it costs to get wrong.
3. V1–V4.
4. What neither cause explains.

**Cap: 100 lines.** Raw evidence to `docs/handoff/scratch/E14-*-14-SEP-2026.*`.

## KNOWN FACTS

- Neon string at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf` — read, use, never print.
  `CREATE TEMP VIEW` fails in a read-only transaction; inline as a CTE.
- Emotion service: launchd `uk.llmvinayminihome.emotion`, PID 85074, port 8086, `/healthz`,
  model `Aniemore/wavlm-emotion-v1-crosslingual`, device `mps`, `EMOTION_MAX_DURATION_S` 60.
  Logs at `/Users/vinaybhardwaj/eta-emotion/logs/`.
- `EMOTION_SEGMENTS_SECRET` was rotated tonight on both sides. Auth is fixed. Any `unauthorised`
  before ~20:12 is historical.
- Tables: `room_emotion_window` (per window), `room_span_emotion` (per segment). All-time before
  tonight's retry: 2 scored, 13 failed, 166 skipped.
- The Mini is tight on memory tonight: 20% free of 24 GB, ollama resident at 9.6 GB. Do not start
  Docker; you do not need it.
