# Whisper parity: Mini vs twins (REDUNDANCY-R1 Phase 3, split-speaker, 24 Sep)

Per Fable's ruling 4 (orders/RULINGS-FABLE-0650.md). Numbers and window ids only; transcripts never left memory.
Status: (a) done; (b) done (1 window WER, 5 windows coverage); (c) DONE on all 58 windows: **twins PASS** (below).

## (a) Decode-parameter diff: what actually differs
| item | Mini (production) | box / gcp-l4 twins | same? |
|---|---|---|---|
| whisper.cpp commit | e0fd1f67 | e0fd1f67 | yes |
| model file sha256 | 1fc70f77…bc69 | identical | yes |
| server flags | `--no-speech-thold 0.7 --suppress-nst`, no `--vad` | identical | yes |
| request (temperature 0.0, beam 1, best_of 1, max_context 0, verbose_json, no language, no prompt) | lib/whisper.ts form | same form (my harness) | yes |
| entropy / logprob / compression thresholds | server defaults @ e0fd1f67 | same defaults, same commit | yes |
| **temperature fallback (`temperature_inc`)** | **server default 0.2: ON** | **ON** | same, and it is the NOISE (below) |
| **post-processing** | **whisper-shim :8081** (loop collapse, 772-word lexicon @50fcc4e) | **none**: bare whisper-server | **NO** (inventory FLAG 2) |
| backend | Metal (M4 Pro) | CUDA (T4 / L4) | no (float order) |
| threads | Mini default | box/gcp default; c3 `-t 8` | c3 differs |

## Finding: every backend, the Mini included, is non-reproducible run to run
`temperature 0.0` does NOT disable whisper.cpp's fallback: when a decode fails its compression/logprob checks it retries at
0.2, 0.4, … and those retries SAMPLE. lib/whisper.ts's comment ("no fallback to a hotter temperature") is wrong.
- Same 900 s window, same server, sent twice with production's form: **box 41.5 % / 46.9 % WER against itself**;
  **Mini (through its shim) 33.2 % WER against itself** (1,588 vs 1,611 words).
- Same window, box, with `temperature_inc=0.0`: **identical output, 0.0 % WER**.
- So a ≤2 % WER-vs-Mini bar can never pass, whatever the twin. Hence ruling 4(c).
- NOT a recommendation to turn fallback off in production: fallback is also whisper's escape from repetition loops. That is
  Fable/V's call, ideally measured (loops/filler with fallback off vs on) before any change.

## (c) Coverage of labelled speech: DONE, 58/58 windows, 0 errors
Set: the 58-window VAD-v3 set, whole 900 s windows, production's exact request. Mini through its shim (serial, finished
before 08:00, ruling 15); box and gcp-l4 twins through THEIR shims (ports 8081), so the configurations are identical.
Coverage = the share of pyannote.ai-labelled speech time covered by returned segments. There are no reference
transcripts for this set, so WER-vs-truth is not measurable; coverage and word totals are the measure.

| backend | coverage of labelled speech | words (58 windows) | segment time outside labelled speech |
|---|---:|---:|---:|
| **Mini** (Metal, production) | **78.1 %** | 33,792 | 221 min |
| box T4 twin (CUDA) | **78.8 %** | 33,738 (−0.2 %) | 226 min |
| gcp-l4 twin (CUDA) | **78.8 %** | 33,259 (−1.6 %) | 226 min |

**Mini's own run-to-run variation** (same window twice, 5 windows): coverage differs by 3.1–16.4 points; words by 2–48 %.

**Per-window tails run BOTH ways** (threshold = the Mini's largest self-difference, 16.4 points):
| | twin worse than Mini by > 16.4 pts | twin BETTER by > 16.4 pts | within ±16.4 |
|---|---:|---:|---:|
| box | 6 | 4 | 48 |
| gcp-l4 | 1 | 6 | 51 |
The two CUDA twins, identically configured, also differ from EACH OTHER by > 16.4 points on 10 of 58 windows. So the
per-window swings are the temperature fallback's noise (see the finding above), not a twin losing speech; the Mini's
5-window self-variation understates that noise.

**Verdict (ruling 4c): the twins PASS.** Neither is worse than the Mini beyond the Mini's own variation in aggregate,
and both capture slightly MORE labelled speech (+0.6–0.7 points). The Mini is not the one losing words overall.
Every backend misses ~21 % of labelled speech: part is whisper, part is pyannote.ai over-labelling (VAD-v3 H1 found some
"speech" is not speech); not separable here.
Not covered: c3 (CPU; lab-mover's pass), and whether temperature_inc=0 narrows the per-window swings (ruling 16, running).

## Standing rule for future whisper comparisons (Fable ruling 72)
Use arm B, `temperature_inc=0.0`, on every server in a comparison (Mini outputs excepted: per ruling 15 the Mini side comes from
stored production runs, which are arm A). The (c) result above was measured in production form (arm A) on all backends, which is
why its per-window tails are wide; a re-run in arm B would narrow them. See FALLBACK-ARMS.md.
