# ETA — M2: CLOSE M1's GAPS AND MEASURE THE ROUTER — REPORT
**14 September 2026 · Builder · read-only · no edit, no restart, no git, no commit**

## §1 results (63 s clip made with `say`, the one M1 used)
1. **Two `/route` calls sent at the same time.** Both returned 200 and `ok:true`, with the same shape and the same `language_timeline` as a solo call. Request B got the lock first: wall 36.00 s, `sec` 35.91. Request A ran after it: wall 64.69 s, `sec` 64.61. About **36.0 s of A's `sec` is queue wait**; about 28.6 s is its own work. No errors.
2. **`/route/job`.** Submitted with a local-only file server as `audio_url`, all other body fields at their defaults. The status endpoint showed: `running {0/0}` at 0.1 s, `running {0/1}` at 2.1 s, `done {1/1}` at 30.3 s. `queued` was never seen, because the thread overwrites it before the first poll. Final: `ok:true`, `error:null`, `sec` 28.72. Keys: `dominant_language, engine_versions, error, job_id, language_timeline, ok, progress, sec, segments, state, transcript_english, transcript_native`. Segment keys and timeline match `/route`.
3. **Health during both.** 123 polls during item 1, worst **17.7 ms**. 59 polls during item 2, worst **37.3 ms**. All returned 200.

## §2 — `/route` on the 900 s clip, 127.0.0.1:8083, nothing else running
| Run | translate | HTTP | wall | `sec` | **RTF (wall ÷ 900)** | segments | engines in timeline |
|---|---|---|---|---|---|---|---|
| 1 | false | 200 | 322.42 s | 322.35 | **0.358** | 32 (silero-vad) | whisper 30, sravaani 2 |
| 2 | false | 200 | 293.38 s | 293.31 | **0.326** | 32 | whisper 30, sravaani 2 |
| 3 | true | 200 | 307.95 s | 307.86 | **0.342** | 32 | whisper 30, sravaani 2 |

- **Spread.** Runs 1 and 2 differ by 9.9%, so no extra run.
- **Translate delta.** Run 3 was 14.57 s slower than run 2 and 14.47 s faster than run 1. The whole difference is inside the run-to-run spread.
- **Languages.** The timeline is identical in all three runs: 30 `en`, one `kn` (141.2–171.1 s) and one `und` (313.5–341.1 s). No segment was won by indicconformer.
- **Candidates.** The service default, `en,kn,hi,ta,te,ml,mr,bn`.
- **Outside traffic.** The router access log shows no `POST /route` other than mine during any run.
- **Peak RSS** (from `ps`, sampled every 2 s): router 106–146 MB, indic 2.75 GB, sravaani 2.14–2.25 GB, whisper 45–70 MB. The ollama runner reached 10.1 GB in run 3. In run 2 it was not loaded; in run 1 it was already resident at 7.3 GB. So run 3's time includes loading the model.

## How the clip was built
A script cycled 12 distinct English paragraphs (fictional, generic) through the voices Rishi, Tara, Aman, Samantha and Daniel. After every two English paragraphs came one non-English paragraph: Hindi (Lekha), Kannada (Soumya), Tamil (Vani) or Telugu (Geeta), written in native script. Each render starts with 600 ms of silence. There were 81 renders. They were joined with ffmpeg and cut to exactly 900.000 s, 16 kHz mono PCM, 28.8 MB. The 26 non-English passages are 6–11 s each.

## Not checked
- **Memory.** RSS does not capture Metal/unified GPU memory, so whisper's figure understates it.
- **Engine traffic.** Nothing checked whether anything called whisper, indic, sravaani or ollama directly during the runs; only the router log was checked.
- **Real audio.** Room audio as webm was not tried, and neither were non-default candidates.
- **Correction to the kickoff.** M1's clip was 63 s, not 18 s.
