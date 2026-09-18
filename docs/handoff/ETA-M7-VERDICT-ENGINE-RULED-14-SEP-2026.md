# ETA — M7 VERDICT: the engine question is answered, and two of my rulings were wrong
**14 September 2026 · Orchestrator · S7/S22 ruled on real room audio**

## 1. THE RULING — route is the slow lane's decode. Whisper-alone is not.

On ten real 300-second OPD windows, one room, one day:

| | whisper alone | route |
|---|---|---|
| repeat_ratio (M5 rule A), pooled | **0.384** | **0.018** |
| characters removed by M4 collapse | **0.418** | **0.020** |
| windows containing loops | **6 of 9** | 1 of 9 |
| native script emitted | **none — Latin only, all 10 windows** | **7 of 9 windows** (Kannada, Devanagari, 246 Gujarati tokens) |
| realtime factor, pooled | 0.025× | 0.234× |

**42% of whisper's output on real room audio is redundant text.** That is not a tuning problem, it is
unusable as a clinical transcript. Route produces 2%.

**Cost is affordable.** Route pooled at 0.234× realtime means a 900 s window costs ~210 s of Mini time.
Six rooms × 9 clinic hours = 216 windows, ≈ 12.6 hours — it fits a night, on hardware we already own and
do not pay per minute for. The 9.43× ratio is wall-clock on free compute, not money.

**PRD v1.2 S22 is no longer provisional. S7's Whisper-on-Mini probe is settled: it is a probe, never the
decode.**

## 2. My M6 verdict was an artifact of the synthetic clip — withdrawn

I ruled on M6 that **"route drops Indic speech"**, from 17 Kannada tokens in the whole synthetic clip and
zero of the 625 romanised characters near any non-Latin route token.

**On real audio route emitted native script in 7 of 9 windows.** Kannada in five, Devanagari in two, and
246 Gujarati tokens in one — which M6's five-script census had been filing under "other". Route was not
dropping Indic; the synthetic clip was not exercising it.

What survives from M6 is narrower and still true: **IndicConformer won only 1 of 65 segments.** The Indic
content is being caught by **SraVaani** (22 Kannada, 3 Gujarati, 2 Hindi, 4 undetermined), not by the
engine the override rule was written for. The override at `:439–443` is still mis-scoped; it is just less
damaging than I concluded, because another engine covers for it.

## 3. My sequencing ruling was also wrong — the VAD gate is not the lever

In `ETA-PROGRAMME-INTEGRATION` I ruled that PR #2's VAD gate must land **before** the bake-off, because it
would delete most of whisper's disadvantage and so the bake-off would measure a problem about to disappear.

**Whisper already runs with VAD on.** Its plist carries `--vad --vad-model …silero… --no-speech-thold 0.7
--suppress-nst`. Pre-decode silence gating is in place, and whisper still returns a 0.384 repeat ratio.

So the VAD gate is worth having, but it is not what is causing this. **The remaining untested variable is
`--max-context -1`** — full previous-text context, whisper.cpp's `condition_on_previous_text=true`, the
setting PR #2 mandates be off. That is now the prime suspect, not a co-suspect.

## 4. The loop pattern is a BAND, and that is the finding

Whisper's loops occur in **all 7 windows between 0.047 and 0.512 speech ratio, and in none at 0.006, 0.627
or 0.726.**

Not "silence causes loops". **Sparse, intermittent speech causes loops.** At near-total silence whisper
emits almost nothing (14 characters at 0.006). At continuous speech there is no gap to carry context
across (zero loops at 0.627 and 0.726). In between — speech islands separated by silence, which is exactly
what an OPD consultation sounds like — context carries across each gap and the model repeats itself.

**This explains the 13 September corpus figure of ~44% of non-empty jobs**, and it predicts that the
windows which loop are the clinically busy-but-not-continuous ones. It also explains why M4's synthetic
clip, continuous speech throughout, produced 51 characters of repetition and nothing more.

## 5. Load-bearing caveats

- **One room, one day, 300 s windows.** All ten came from a single export bundle whose filename refers to
  OPD-7. The 24 local files are only 12 unique recordings. No cross-room claim is available.
- **Route changed under the experiment** — see §6. The route arm is not the code M3 timed or M6 read.
- Speech ratio was measured with Python silero-VAD, which is neither whisper-server's ggml VAD nor route's
  own per-span gate. It is a consistent yardstick across arms, not either engine's own view.
- Rule C compares whisper's ~4–5 s segments against route's up-to-30 s VAD spans; those counts are not
  like-for-like and should not be quoted as a ratio.
- W03's route arm is missing (HTTP 500), so all pooled route figures are over 9 windows.

## 6. UNATTRIBUTED CHANGE TO A PRODUCTION SERVICE — and it crashes

`~/eta-router/router_server.py` was **edited today at 11:44:15** and the router **restarted at 11:46:36**.
The backup `.bak-vad-20260914114415` matches the sha256 of the file M6 read. The change adds a silence
gate. **Neither the Builder nor I made it**, and no kickoff covers it.

**It contains a crash.** Skipped spans `continue`, but `results = [None] * len(seg_jobs)` is still indexed
by the original span index, so `results[idx] = fut.result()` raises `IndexError`, re-raised at `:559` as an
HTTP 500. **Any window where a silent span falls before the last span will 500.** It fired on 1 of 10
windows here; the other 9 skipped nothing, which is likely why an earlier smoke test missed it.

**Not currently an outage**: `ROOM_AUTO_DRAIN_ENABLED` is off and no room is recording, so route is serving
no production traffic. But route **is** the room path's engine (migrations 0084/0086), so this must not
still be there when the drain is switched on.

**Ruled: do not revert unilaterally.** A parallel effort may own this — `out/` also holds a `vad_smoke`
folder from today. Reverting mid-flight is the collision this programme has spent the day avoiding, and the
backup means nothing is lost either way. **V confirms ownership first; then either the owner fixes it or we
restore `a4700494…`, which is one command.**

## 7. What follows

1. **W1 — whisper's forced English.** Already written. Now an *improvement to the winner*, not a
   prerequisite for the verdict: route uses whisper for 33 of its 65 segments, so fixing it improves route.
2. **W2 — `--max-context`.** Promoted to the leading candidate for the looping, per §3. Its own round, its
   own baseline, one variable.
3. **The router's silent-span crash** — §6, owner first.
4. **The override's scope** (`:439–443`) — still mis-scoped, now lower priority, since SraVaani covers the
   Indic content IndicConformer is losing.
5. **A second room and a second day** before any claim generalises beyond OPD-7.
