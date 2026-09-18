# ETA-E12 — why does segment scoring fail 11 of 13? EVIDENCE PASS · 14 Sep 2026 · pane `scribe3`

Read `ETA-E11-VERDICT-AND-E12-NEW-BREAK-14-SEP-2026.md` §0 and §2 first.

**You are the Researcher this round, not the Debugger. Gather facts and mark anything unverified as
UNVERIFIED. Do not diagnose, do not propose a fix, do not change anything.** A separate Opus round does
the root cause, and it will be better for starting from facts rather than from someone's first theory.

## WHAT HAPPENED

At 20:16 tonight the emotion stage completed its first job ever — and scored 2 of 13 segments.

| window | planned | scored | failed | skipped | outcome |
|---|---|---|---|---|---|
| `bw_6jwz5r79_…89100000` | 13 | **2** | **11** | 0 | `ok` |
| `bw_6jwz5r79_…83700000` | 1 | 0 | 1 | 0 | `failed: emotion_zero_scored` |
| `bw_6jwz5r79_…81900000` | 1 | 0 | 1 | 0 | `failed: emotion_zero_scored` |
| `bw_z3gpbh6e_…56600000` | 54 | 0 | 0 | **166** | `failed: unauthorised` (now fixed) |

All-time `room_span_emotion`: **2 scored, 13 failed, 166 skipped.** The 2 scored carry `top_label`
`happiness` and `neutral`.

## THE FACTS I WANT

1. **Why each of the 13 failed.** `room_span_emotion` carries a `reason` and the window row carries
   `failure_history` and `timing_json`. Group the 11 + 2 failures by reason, verbatim. If they all share
   one reason, that is the answer to the whole round.
2. **What distinguishes the 2 that scored** from the 11 that did not, using only what the rows hold:
   duration, speaker index, chunk index, run start, position in the window. **Do not listen to audio.**
3. **The single-segment windows.** Two windows planned exactly 1 segment and failed it. Is a
   1-of-1 failure the same failure as the 11, or a different one? This matters because
   `emotion-window.ts:191-193` makes zero-scored a window failure, so these burn attempts against the
   3-attempt bound — at this rate most windows will exhaust.
4. **The 54-vs-166 contradiction.** Window `bw_z3gpbh6e` recorded `segments_planned` 54 and **166**
   skipped rows. Those cannot both describe one run. Establish, from the rows and from
   `lib/emotion/`, what each number actually counts. This is testing rule 15's shape — a count that
   disagrees with the rows it summarises — and it may be a bookkeeping artefact of the auth failure
   rather than a second defect. Say which, or say UNVERIFIED.
5. **The service side.** The emotion service on the Mini (port 8086) was restarted tonight at ~20:07
   and reports `loaded:false` until first use, `model: Aniemore/wavlm-emotion-v1-crosslingual`,
   `device: mps`, `max_duration_s: 60`. Its own logs for 20:00–20:20 should say what it did with each
   segment. Read them. **Report what the service said, not what you infer it meant.**
6. **The cap.** `EMOTION_MAX_DURATION_S` is 60 and `cap_s` on the window rows is 60.0. Establish
   whether any failed segment exceeded it. A segment longer than the cap failing is a different story
   from a short one failing.

## ALLOWED

Read-only SQL against live Neon (today's data included — no other pane is querying `lib/emotion/`
tables this round). Reading source at `fe021a3`. Reading Mini logs and `launchctl list`. Read-only
health probes. Scratch files under `docs/handoff/scratch/`.

## DO NOT

- Do **not** change code, flags, env vars, migrations, `vercel.json`, plists or room rows.
- Do **not** restart any Mini service. The emotion service was restarted tonight and is working;
  leave it alone.
- Do **not** submit, retry or cancel any job. Emotion is live and the cron is working through the
  eligible rows on its own — **let it**. More completed jobs are more evidence.
- Do **not** touch `lib/stt/` or `room-drain.ts` — `ETA-Refuter` is reviewing a diff there.
- Do **not** turn `ROOM_AUTO_DRAIN_ENABLED` on.
- Do **not** listen to, transcribe or quote any audio, transcript text, speaker name or clinical
  content. Durations, counts, ids, labels and error strings only.
- Do **not** propose the fix. If you think you know it, write it as one line under "hypotheses,
  unverified" at the very end and stop there.

## VERIFY — PASS / FAIL / UNVERIFIED

- V1 Every number you report came from a query or a log line you actually ran.
- V2 You distinguished what the service *said* from what you concluded.
- V3 You changed nothing and restarted nothing.
- V4 You checked whether more emotion jobs completed while you worked, and reported them separately
  from the four in the table above.

## OUTPUT

`docs/handoff/ETA-E12-SCORING-EVIDENCE-14-SEP-2026.md`

1. Line 1: the failure reason shared by the 13, verbatim — or "no single shared reason".
2. Facts 1–6.
3. V1–V4.
4. Hypotheses, unverified, at most three lines, at the very end.

**Cap: 100 lines.** Raw output to `docs/handoff/scratch/E12-*-14-SEP-2026.*`.

## KNOWN FACTS

- Neon string at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf` — read it, use it,
  never print it, never copy it into the repo. `CREATE TEMP VIEW` fails in a read-only transaction;
  inline it as a CTE.
- `EMOTION_SEGMENTS_SECRET` was rotated tonight on both sides. **Auth is fixed** — the 20:15 job
  completed. Any `unauthorised` you see before ~20:12 is the old problem, not a live one.
- Tables: `room_emotion_window` (per window), `room_span_emotion` (per segment, PK is
  window_id + diarize_run_id + speaker_idx + run_start_ms + chunk_idx).
- `room_diarize_window` holds 21 rows (19 `ok`, 2 `no_speakers`); 5 met the emotion scan's predicate.
- Docker is down on the Mini. You do not need it.
