# Timbre harness (v0)

Offline feature extraction and scoring for Timbre (voice affect v1). This folder does not touch the EvenScribe app, the room pipeline, migrations, flags, or deploys. Nothing here writes a clinical note.

Python 3.11. CPU is the default device. CUDA is optional (`--device cuda`).

## Setup

From the repo root, with [uv](https://docs.astral.sh/uv/):

```bash
uv python install 3.11
uv venv --python 3.11 tools/timbre/.venv
uv pip install -p tools/timbre/.venv/bin/python -r tools/timbre/requirements-fast.txt
```

That is enough for `make test`. The fast suite does not download models and does not need torch.

Model weights are a separate install. Torch is locked to the CPU index (`https://download.pytorch.org/whl/cpu`) so `uv sync` does not pull a CUDA build. On a GPU box, install the CUDA wheel yourself and pass `--device cuda`.

```bash
uv sync --project tools/timbre --python tools/timbre/.venv/bin/python --extra models --inexact
```

`--inexact` keeps the venv from being stripped back to the lock if you already installed the fast pins. `uv.lock` is the lockfile. `requirements.txt` is the same model set for pip, and it also points at the CPU torch index.

## Tests

```bash
make -C tools/timbre test       # pytest -m 'not slow'  (offline)
make -C tools/timbre test-all   # includes @pytest.mark.slow model downloads
```

`make` uses `tools/timbre/.venv/bin/python` when that file exists. Otherwise it uses `python3`. Override with `PYTHON=...`.

Slow tests download checkpoints on first run and record one JSON object per model to `/tmp/timbre-smoke-timings.json` (override with `TIMBRE_SMOKE_LOG`). A model is skipped, not failed, when MemAvailable is below that model's `ram_gb` or when its Python package is missing. A model that loads and then returns a non-finite score fails.

GitHub Actions (`.github/workflows/timbre-tests.yml`) runs only the fast tests, and only when `tools/timbre/**` or that workflow file changes.

## Run

```bash
python -m tools.timbre.run --windows windows.csv --audio-dir DIR --out results/ \
    --models all --device cpu
```

`--models list` prints the catalog. `--models` also accepts aliases (`egemaps`, `baseline`, `whisper`, …) or a comma-separated subset.

Inputs:

- A windows CSV with `window_id, room, date, lang, phase, start_s, end_s, patient_speech_s`. Extra columns are kept. `window_id` is `<clip_id>_p<start_ms, 7 digits>`.
- One 16 kHz mono file per window, `<window_id>.wav` or `.flac`, in `--audio-dir`. A missing file is an `error` row and is retried on the next run.

Outputs, under `--out`:

- `<model name>.parquet` — one row per window.
- `features.parquet` — merged columns, plus baseline deltas.
- `manifest.json` — model ids, revisions, licence strings, and seconds of inference per second of audio.

Re-running is safe. Status `ok` and `nan` are finished and skipped. Status `error` is retried. Parquet and JSON writes are atomic (`*.tmp` then replace). A parquet that cannot be read is renamed `*.corrupt` and that model starts over.

### Scale runner

`python -m tools.timbre.scale` scores a list of consults: read-only audio from R2 bucket `eta-audio`, windows from `windows.generate_windows` (or a windows CSV), then `PurityRule`. Output is sharded and resumable. The default model set is the batch-1 provisional arousal pair (Odyssey WavLM-dim, audEERING MSP-dim) plus Vox-Profile Whisper-dim and eGeMAPS. Device `auto` uses CUDA when it is available. Whisper-family models stay on the float32 load. `--dry-run` writes a plan and a cost estimate and does not fetch audio. The population report is aggregates by room, `doctor_uid8`, and day. Queue files, shard parquets, and the audio cache are private and must not be committed. See `SCALE.md` for env vars and launch commands.

### Speech guard

`speech_guard` (`vad.py`, version `energy-spectral-v1`) runs before every extractor. Silence (RMS under 1e-3) and a narrow tone (energy concentrated on one FFT bin and low spectral flatness) return status `nan` and NaN features. The model is not called. This is an energy check so a sine wave is not scored as an emotion. It is not a clinical VAD.

### Baselines

For openSMILE functionals and for arousal / dominance / valence, `baseline.py` adds:

- `{col}__delta_self` — z-score against that patient's strictly earlier windows in the same `clip_id` (sample std, at least two earlier finite values).
- `{col}__rel_doctor` — `(x - doctor_mean) / patient_earlier_std` when doctor rows exist (`role=doctor`, or a separate doctor frame).

Embeddings and the seven WavLM class probabilities are not z-scored.

### Labels

```bash
python -m tools.timbre.evaluate --labels labels.csv --features results/features.parquet --out results/eval.json
```

`--out` takes a file or a directory (an existing directory, or a path ending in `/`); a directory gets `report.json`. The report is strict JSON (NaN becomes `null`).

`--scalar-ridge` adds a room-day grouped-CV ridge head on scalar features for models that have neither direct arousal/valence nor an embedding (eGeMAPS, ComParE). The penalty scales with the feature count. Rows report `arousal_source = ridge_oof_scalar`.

Locked metric snapshots live in `baselines/` (aggregates only; see `baselines/README.md`).

### Patient purity

`purity.py` scores how much of a window is the patient alone, from per-frame speaker evidence: speaker-embedding cosines (`embedding_purity`) or Nemotron per-frame probabilities (`probs_purity`). `PurityRule()` is the batch-1-validated keep rule (purity >= 0.6, >= 3 s pure patient speech, mean patient cosine >= 0.30). It loads no audio or model.

Optional `--outcomes outcomes.csv` joins accept/defer and unresolved-doubt counts after dropping hidden-repeat rows. That hook is not the pre-registered T-8 likelihood-ratio test.

Gold rows with `not_patient` or `unusable` are excluded. Hidden repeats (`is_repeat`) score intra-rater quadratic weighted kappa, Spearman, CCC, and exact agreement. Arousal and valence use Lin's CCC (0–1 model outputs are mapped onto 1–5 first) and Spearman. When a model has no direct A/V columns, a grouped-CV ridge head on its embedding produces the CCC. Flags `engaged`, `anxious`, `resistant`, `words_ne_tone` (CSV alias `words_tone_mismatch`) use a grouped-CV logistic head and macro-F1. Groups are `room|date`.

## Models

No checkpoint id was substituted. The Aniemore row is the same Hugging Face repo production uses; this harness loads the fp32 root, while the Mini serves the int8 subfolder.

| name | checkpoint | licence |
|---|---|---|
| `egemaps_v02.v1` | openSMILE eGeMAPSv02 functionals | audEERING Research License, non-commercial |
| `compare2016.v1` | openSMILE ComParE_2016 functionals | same |
| `audeering_msp_dim.v1` | `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim` | CC-BY-NC-SA-4.0 |
| `odyssey_wavlm_dim.v1` | `3loi/SER-Odyssey-Baseline-WavLM-Multi-Attributes` | MIT weights; MSP-Podcast terms are research |
| `voxprofile_whisper_dim.v1` | `tiantiaf/whisper-large-v3-msp-podcast-emotion-dim` | OpenRAIL on the card; GitHub repo has no SPDX licence |
| `emotion2vec_plus_large.v1` | `emotion2vec/emotion2vec_plus_large` | card says `other` (FunASR model-license); FunASR code is MIT |
| `whisper_large_v3_encoder.v1` | `openai/whisper-large-v3` encoder, mean-pooled | MIT |
| `wavlm_aniemore.v1` | `Aniemore/wavlm-emotion-v1-crosslingual` | MIT (follows `microsoft/wavlm-large`) |

Commercial openSMILE and audEERING licences are being procured (architecture issue #81, T-12). MSP-Podcast terms may still bind the Odyssey, Vox-Profile, and audEERING dimensional checkpoints. emotion2vec attribution is called out in that same issue.

Vox-Profile is not pip-installable. `extractors/voxprofile_dim.py` is an adapter of `WhisperWrapper` from `github.com/tiantiaf0627/vox-profile-release`. Upstream `forward` hardcodes CUDA and the `return_feature` branch does not return; the adapter honours `--device` and returns the pooled 256-d features plus arousal, valence, and dominance. It refuses LoRA checkpoints (no `loralib`). The catalog asks for about 12 GB free before load, because the fp32 Whisper skeleton is allocated before the checkpoint arrives.

Odyssey's published `pipeline_utils.py` targets transformers 4. The extractor keeps that architecture locally (same module names, `post_init` for transformers 5) and does not execute the remote file.

Transformers 5 loads Whisper with `dtype="auto"`. The Whisper-large-v3 config is fp16, and on CUDA that is a half conv bias against float32 mel features (`Input type (float) and bias type (c10::Half)`). The encoder and the Vox-Profile backbone are loaded in float32, and the mel features are cast to that dtype.

`catalog.py` lists a `ram_gb` floor per model. Below that, `python -m tools.timbre.run` logs the reason, skips that model, and continues with the rest. The slow test skips the same way.

## Nemotron probability files

Optional reader for `eta-audio/lab/nemotron-probs/bw_<room>_<window_start_ms>_primary.nlp`.

```python
from tools.timbre.nemotron_probs import load_nlp, patient_frames
loaded = load_nlp(path)          # or gzip bytes
mask = patient_frames(loaded.probs, doctor_slot=0, thr=0.5)
```

The container matches `tools/nemotron-worker/lab.py`: gzip of `NLP1`, a little-endian header length, a JSON header, then a `u8` matrix scaled by `scale` (255).

**Open question.** Measured production objects decompress to 720,197 bytes with `rows=90003`, `cols=8`, `frame_ms=80`. That is a canonical 90003×8 matrix, so the payload-valid reading is `rows` = frames and the duration is **7200.24 s**, which fails the 900 s check (`duration_ok` is false). Two other timebases both equal 900.03 s when `cols` is 8: `(rows/cols)*80 ms`, and `rows*10 ms`. They are the same number, and `90003 % 8 == 3`, so the product reading cannot reshape these bytes without dropping three frames. A 10 ms hop fits the stored shape. The worker writes `frame_ms: 80` in `pack_nlp` regardless of the tensor hop. This reader does not guess and does not drop samples. `loaded.sanity` carries both hypotheses. A file whose bytes actually are `frames*cols` with duration near 900 s selects that layout and sets `duration_ok`.

R2 fetch is optional and read-only (`GetObject` only, keys under `lab/nemotron-probs/*.nlp`). It uses `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` when you call `fetch_nlp_object`. Those variables are not required for the tests.

## Fixtures

`fixtures/` is synthetic. `audio/synth_consultA_p0000000.wav` is a one-second harmonic stack from `synth_speech`. `tiny.nlp` is a 2×2 matrix. `windows.csv` and `labels.csv` use invented ids. No patient audio and no real consult is in this tree.

## Smoke timings

Measured on a CPU box with about 4.7 GB MemAvailable, Python 3.11, torch 2.14.1+cpu. Audio was 4.0 s of the public-domain JFK excerpt used by the Whisper tests (`tests/jfk.flac`), not a patient recording. The figure is a second forward pass with the weights already resident: seconds of compute per second of audio.

| model | s / audio-s | revision |
|---|---:|---|
| `egemaps_v02.v1` | 0.012 | openSMILE 2.6.0 |
| `compare2016.v1` | 0.013 | openSMILE 2.6.0 |
| `audeering_msp_dim.v1` | 0.048 | `6eba34a2485e` |
| `odyssey_wavlm_dim.v1` | 0.080 | `00d0e12ba9bf` |
| `emotion2vec_plus_large.v1` | 0.046 | `6c303ba987b8` |
| `wavlm_aniemore.v1` | 0.076 | `a08f2a01c0eb` |
| `whisper_large_v3_encoder.v1` | skipped | needs 8 GB free; this box had ~4.7 |
| `voxprofile_whisper_dim.v1` | skipped | needs 12 GB free; this box had ~4.7 |

The first call in a fresh process is slower because it loads the checkpoint. Re-run with `make -C tools/timbre test-all`. Results land in `TIMBRE_SMOKE_LOG` (default `/tmp/timbre-smoke-timings.json`). A model under its `ram_gb` floor, or missing its Python package, is skipped. A loaded model that returns a non-finite score fails.

On a shared 8-vCPU box the same CPU path was about 5× slower than the table above. audEERING there was about 0.23 s per second of audio, against 0.048 s here.
