# ETA-E14 — why emotion scoring fails · ROOT CAUSE · 14 Sep 2026 · Debugger (pane `ETA-Refuter`)
**Cause 1, all 43 failures, both populations.** The emotion service's 11:46 edit today answers every span that fails its new amplitude gate with `ok: true, unscorable: true, status: "skipped", labels: {}`. The Vercel client predates that shape, reads "`ok: true` without seven numeric labels" as `malformed_scores`, and stores the span as `failed`.

**Cause 2, why the ~29 s chunks have no speech.** whisper.cpp's VAD time-mapping gives a Whisper segment that crosses removed silence original-time bounds spanning the whole gap. Turns built from those segments swallow minutes of silence, and the planner cuts them into 29 s chunks that are mostly silence.

Evidence only: nothing changed, nothing restarted, no job touched. Raw: `scratch/E14-EMOTION-APP-DIFF-14-SEP-2026.txt`, `scratch/E14-WHISPER-VAD-SPANS-14-SEP-2026.txt`. Neon was not queried: this session's permission layer has refused production reads twice, so I used scribe3's E12 query output and the Mini's own files.

## 1. The contract, from `~/eta-emotion/app.py` (V1)
`score_segments` (`app.py:1044-1093`) returns exactly seven per-segment shapes:

| Case | Shape returned | What the client stores |
|---|---|---|
| deadline passed | `ok:false, error:"request_deadline_exceeded"` | the error text (`client.ts:99`) |
| over `max_duration_s` | `ok:false, error:"segment_longer_than_max_duration_s"` | the error text |
| past the end of the audio | `ok:false, error:"segment_beyond_audio"` | the error text |
| shorter than 0.1 s | `ok:false, error:"segment_too_short_for_model"` (`SEGMENT_MIN_S` = 0.1, `:928`) | the error text |
| **gate fails** (`:1064-1080`) | **`ok:true, unscorable:true, status:"skipped", skip_reason, labels:{}, top:[], duration_s, inference_s:0.0`** | **`malformed_scores`** |
| classified | `ok:true`, all seven labels, `duration_s`, `inference_s` | scored |
| inference throws | `ok:false, error:"inference_failed: …"` | the error text |

- **Only the gate-fails row can become `malformed_scores`.** `client.ts:102-110` marks an `ok:true` item malformed when any of the seven labels is missing. `{}` has none.
- **A real classification cannot become `malformed_scores`.** The 26 scored rows prove the model's label names match the client's seven. A NaN probability cannot reach one segment either: Starlette's JSONResponse refuses NaN, the outer `except` (`:1161`) turns the whole call into `ok:false`, and the client then fails the call rather than one segment.
- **This is proof by exhaustion over the running code.** PID 85074 started 20:02:43, and launchd runs `~/eta-emotion/app.py`, mtime 11:46.

**The gate** (`app.py:563-588`, thresholds `:57-60`):
- **`near_silent`:** RMS < 0.008 **and** peak < 0.02. **`insufficient_speech`:** `speech_s_est` < 1.5 s, the sum of 20 ms frames whose peak amplitude is ≥ 0.02.
- **It is amplitude, not a VAD.** `speech_s_est` can never exceed the clip length, so **any span under 1.5 s is unscorable by arithmetic, whatever it contains.**
- **The 1 s warm-up is always unscorable.** It always reports `ok:false`, and it never loads the model: E12 Fact 5's `wavlm ready in 9.2s` came on the first real call.
- **Unlike `/inference` (`:815`), the segments path logs nothing per segment.** That is why E12 found "0 per-segment lines".

## 2. The 11:46 edit (question 4)
**`~/eta-emotion` is not under version control** (`git rev-parse`: "not a git repository"). Its only history is five dated `app.py.bak-*` files.
- **Today's diff against `app.py.bak-vad-20260914114433`: 0 lines removed, 90 added**, in five hunks: the thresholds (`:55-60`); `audio_energy`, `silence_skip_reason`, `unscorable_body` (`:561-613`); the `/health` fields (`:741-742`); the gate on `/inference` (`:809-820`); and **the gate on `/inference/wavlm/segments` (`:1063-1079`)**.
- **The edit introduced both the gate and the shape that fails**, the same morning as the router VAD change. The service README documents the shape (`README.md:107-125`). The client, from C3 on 13 Sep, never learned it.
- Before 11:46 this endpoint would have tried to score every span ≥ 0.1 s. The stage never ran in production before, so "was it right before" is unknowable, as the brief says.

## 3. Both populations (V2)
**Short spans (bw_z3gpbh6e retry: 30 failed, median 1.85 s).**
- **The 12 failures under 1.5 s are proven** by the arithmetic above.
- **The 18 at 1.5–10 s are consistent but UNVERIFIED per segment.** Each needs its clip's amplitude, and I did not fetch or analyse patient audio.
- **The two single-span windows fit the same rule:** `…81900000` (0.50 s) and `…83700000` (0.38 s) are both under 1.5 s.

**The ~29 s chunks (window `…89100000`, 11 failed, 2 scored).**
- **The matching Whisper call.** Whisper's stderr has a full-window call with 10 VAD speech bursts, 7.91 s in total. Its first two are at original **5.86–6.24 s** and **294.34–296.64 s**, adjacent in compressed time (vad 0.00–0.38 and 0.58–2.88).
- **Run A is exactly that span.** It is one turn over clip **5.86–296.56 s**, 290.7 s long, containing about 2.7 s of speech.
- **Why.** whisper.cpp adds mapping points at both edges of every removed gap (`~/whisper.cpp/src/whisper.cpp:6752-6763`) and interpolates linearly (`:7927-7964`). A segment starting in burst 1 and ending in burst 2 maps to original bounds covering the whole 288 s gap.
- **Run B fits the interpolation.** Its start at 716.15 s lies inside the gap between the bursts at 682.40 and 766.75, a point interpolated in the 0.2 s zero-padding.
- **Run A is predicted chunk by chunk.** Chunk 9 (267.49–296.56) contains the 2.3 s burst and scored. Chunks 0–8 contain at most the 0.38 s burst, and all failed.
- **Run B is NOT predicted chunk by chunk.** Chunk 1 holds 1.76 s of VAD speech (766.75–768.77) yet failed. Chunk 2 overlaps VAD speech by only ~0.04 s yet scored. The service's amplitude gate and Silero VAD disagree about what is "speech". Which of the two B outcomes is right needs the clip's frame peaks. **UNVERIFIED.**

**Honest count.**
- **Cause 1 covers all 43 failures at the response-shape level, proven.** Why each span is unscorable is proven for 12 of the 30 (length) and 9 of the 11 (run A); consistent but unverified for the other 18 plus 2 (run B).

## 4. Whose defect, ranked, with the minimal fix and the cost of getting it wrong
1. **Client and store: they do not know `unscorable`, and it still counts toward window failure.**
   - **Minimal fix:** parse `unscorable: true` as its own outcome (`client.ts:99-110`), write the row `skipped` with the service's `skip_reason`, and exclude unscorable spans from `zero_scored`. A window whose planned spans are all unscorable is a fact about the audio, like `no_segments`, not a failure.
   - **Cost of getting it wrong, three ways:**
     - Relabel rows `skipped` but leave `planned > 0 AND scored = 0` (`store.ts:232`) alone: windows still fail and exhaust, just with a nicer word (§5).
     - Treat unscorable as a low-confidence score: invents emotion on silence.
     - Catch every non-numeric result as unscorable: hides a real model fault.
2. **Upstream turn bounds (cause 2), a transcript defect that reaches beyond emotion.**
   - **Minimal fix:** plan emotion runs from the VAD speech spans, or clip each turn to them, not from Whisper segment bounds.
   - **Cost of getting it wrong:** dropping `--vad` brings back loop-on-silence (M4–M7, repeat ratio 0.370); clipping turns everywhere changes cue timings the day view and diarize already read, and can cut real speech at burst edges.
   - It also explains why A9 scored `neutral` over 27 s of silence plus 2.3 s of speech: the label is diluted by the silence (§6).
3. **The planner: it plans spans the service will refuse by arithmetic.**
   - **Minimal fix:** drop planned spans under the service's `min_speech_s` (read from `/health`, never a constant) before planning, as straddles are, so they never enter `planned`.
   - **It fixes only the 12 sub-1.5 s spans and both single-span windows.** It cannot see amplitude.
   - **Cost of getting it wrong:** hard-coding 1.5 drifts silently the day the service's env changes.
4. **The service: `ok: true` with nothing in it is an ambiguous success, and it changed its contract unversioned the day its stage first ran.**
   - **Minimal fix:** put `~/eta-emotion` under version control, and version the contract. Switching the gate to `ok:false` alone **does not help**: the client would store the reason but still write `failed` and still exhaust.
   - **Cost of getting it wrong:** lowering `MIN_SPEECH_S` or `SPEECH_ABS` to "make it score" assigns emotions to silence and noise.
- **The brief's third candidate, the diarizer, is misattributed.** Turn bounds come from Whisper's `stt_turn` cues; diarize only assigns a speaker to them. Its defect, if any, is being fed silence-swallowing turns.

## 5. `failed` vs `skipped`, and exhaustion (V3)
- **Confirmed, with a correction.** A window with planned > 0 and nothing scored is `failed/emotion_zero_scored` (`store.ts:232`; job fails at `emotion-window.ts:202`), and the scan retries `failed` while `attempts < 3` (`enqueue.ts:63`). **Only straddle turns become `skipped` without harm, because they never enter `planned`** (`emotion-window.ts:117-126,195`). **So what protects a window is keeping unscorable spans out of `planned`, or out of the zero-scored rule, not the row label.**
- **Deterministic re-failure.** A retry re-scores identical audio through the same gate, so every attempt fails the same way.
- **On course to exhaust:**
  - As of E12's 20:28 read: **`…81900000` and `…83700000`** (attempt 1, one span each, 0.50 s and 0.38 s). Both are certain to fail attempts 2 and 3, then park.
  - Since then the service log shows **17** HTTP-200 segment calls after its restart against E12's 11. That is consistent with those retries running; the current attempt counts are UNVERIFIED without Neon.
  - Any future window whose every planned span is under 1.5 s, or silence-swallowing, joins them.
- **`ok` windows are final and not retried**, so `…89100000` and bw_z3gpbh6e keep their partial scores.

## 6. What neither cause explains
1. **Run B's per-chunk split** (§3): the service's amplitude gate and whisper's Silero VAD disagree on two chunks.
2. **The 18 failures at 1.5–10 s** on bw_z3gpbh6e: probably low-amplitude speech (far-field frames under 0.02 peak), but unmeasured.
3. **Scored ≠ valid.** A9 got a label over 29 s that are 92% silence. A span that passes the gate by 2 s is scored as if it were all speech. This is a quality question for E1/E2-style validation, not a failure.
4. **The warm-up does not warm.** It is always unscorable, so the first real batch pays the model's cold load.

## V1–V4
- **V1 PASS.** §1: the contract table, from `app.py:1044-1093` and `:590-613`.
- **V2 PARTIAL, stated.** Cause 1 predicts both populations at the shape level. Why each is unscorable is proven for 12 of 30 short and 9 of 11 long; run B's 2 and the 18 mid-length are UNVERIFIED.
- **V3 PASS, with the correction in §5.**
- **V4 PASS.** Nothing changed. No restart, no job, no Docker. `app.py`, the plist, the logs and whisper.cpp were read-only. I read the plist's env with secrets redacted.

Subagents: none.
