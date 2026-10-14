# parakeet-med smoke test findings (27 Sep 2026, real HF Jobs runs on l4x1)

Three real GPU runs against `clin_en_3` (23.12s, English, full text known from the whisper-med-merged/medasr smoke
tests on the same clip: a full asthma consult with 2 drugs and doses — see those jobs' logs, not repeated here).

## Run 1: `model.transcribe([path], timestamps=True)`, F3's local-attention config
Empty hypothesis: `text=''`, `y_sequence` a zero-length tensor. Also surfaced a real extraction bug independent of
the empty result (`hyp.timestamp` is a dict with a `"segment"` key, not an object with a `.segment` attribute —
`getattr()` on it silently always returned `None`, and the `or str(hyp)` fallback dumped megabytes of raw tensor
repr into the track's text field when `hyp.text` was `""` rather than missing).

## Run 2: `model.transcribe([path])` (no timestamps), F3's local-attention config
Real text, but badly truncated: **`'Good morning, tell me what is the problem.'`** — stops after the first
sentence. Peak GPU memory only 5.06GB (nowhere near the L4's 24GB, so this clip was never at OOM risk in the first
place — the F3 attention change wasn't even being stress-tested here).

## Run 3 (diagnostic — `engine_parakeet_med_diag.py`, same clip): NO attention-model change, plain `.transcribe()`
Text is longer but still clearly wrong: **`'Good morning, tell me what is the problem? Doctor, it has been five
days. So Monteluk has 10 Miller food, right?'`** — this skips the ENTIRE middle of the consult (the asthma
diagnosis, the chest x-ray instruction, "take montelukast... twice a day after food", "also take prednisolone...")
and jumps straight to a garbled fragment of the closing line. Both medasr and whisper-med-merged transcribed this
exact clip completely and correctly (see their own smoke-test logs).

## Runs 4-7 (Fable's 4-iteration debugging cap, all on `clin_en_3`, all with no timestamps)
Isolating exactly which knob (if any) controls the truncation, each tested independently:

- **Run 4** (`engine_parakeet_med_diag2.py`): explicit `decoding_cfg.strategy = "greedy_batch"`, F3's attention fix
  still applied. Result: WORSE — `'Good morning.'` only (2 words, shorter than run 2/3's output).
- **Run 5** (`engine_parakeet_med_diag3.py`): pre-loaded `soundfile`-read numpy array passed directly to
  `.transcribe()` instead of a file path (ruling out a file-reading/Lhotse-dataloader truncation), no attention
  change, default decode. Confirmed the audio itself loads correctly: 369,953 samples @ 16kHz = 23.12s exactly,
  real signal (`max_abs=0.8939`, not silence/corruption). **The raw `Hypothesis` object was logged for the first
  time**: `score=-1277.6499`, a well-formed 40-token `y_sequence`, decoding to the exact same truncated text as
  runs 2/3. Not corruption, not an empty/degenerate result — a confident-looking but genuinely incomplete decode.
- **Run 6** (`engine_parakeet_med_diag4.py`): explicit `greedy.max_symbols` bumped 10→200 and
  `max_symbols_per_step` set to 10, confirmed via printed before/after config dump that the change took effect.
  Result: **byte-identical** to run 5 (same score, same exact 40 tokens, same text). This decode-config knob has
  zero effect on the actual behaviour — rules out a per-utterance/per-step symbol-budget cap as the cause.
- **Run 7** (`engine_parakeet_med_diag5.py`): forced the whole model to uniform fp32 (no autocast/mixed precision),
  also printed the installed `nemo` version: **`3.0.0`** (a very recent major release — the PEP-723 script let `uv`
  resolve latest, no version was pinned anywhere for this model). Result: again **byte-identical** to runs 5/6.

## Conclusion
The truncated output is **fully deterministic and insensitive to decoding strategy, symbol budget, and numeric
precision** — every config knob tried produced either the exact same result or a worse one. This rules out the
surface-level fixes available and points most strongly at a **version incompatibility between `nemo_toolkit==3.0.0`
and this community checkpoint** (very plausibly fine-tuned/tested against an older NeMo release, before this
major-version bump). Not fixed within the 4-iteration debugging cap Fable set (bus 21:47/23:08).
Untested, for whoever picks this up next: a pinned OLDER `nemo_toolkit[asr]` version (needs figuring out which
release the checkpoint's own README benchmarks were likely computed against); the OTHER `.nemo` file in the repo as
a side-by-side check (diagnostic only — STEP0-FACTS already ruled it out for the real bake-off due to its own
catastrophic-forgetting problem, but it would show whether the truncation is checkpoint-specific or affects both
files, i.e. systemic to this NeMo version).

**Status**: `parakeet-med` FAILED-AT-SMOKE (ADDENDUM-18) — withdrawn from W50 before any scored write. This is a
real, disclosed finding after genuine investigation, not a silently-accepted partial result or an unexamined guess.
