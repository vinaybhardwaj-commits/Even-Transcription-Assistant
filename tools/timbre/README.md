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
- `{col}__rel_doctor` — `(x - doctor_mean) / patient_earlier_std` when doctor rows exist (`role=doctor`, or a separate doctor frame). This stays empty when the windows file has no doctor rows. `--doctor-ref` replaces it, for the columns listed below, with patient minus the doctor reference audio.

Embeddings and the seven WavLM class probabilities are not z-scored.

### Doctor reference

Doctor-relative features are **off by default** and superseded for Timbre v1 (11 Oct 2026 decision). The code stays for an explicit comparison. Nothing in `run` or `evaluate` turns it on unless `--doctor-ref` or `--include-rel` is passed.

`--doctor-ref` builds a doctor reference for each patient window from the same clip, then runs every selected extractor on that audio. The reference is the doctor's own segments nearest the window: at most `--doctor-budget-s` seconds (default 15), and only speech within `--doctor-horizon-s` seconds (default 60). A longer segment is clipped on the side closest to the window. The extractor result is cached per clip and span, so windows that share a span do not score it twice.

Two inputs, same selector:

- **Diarization segments** (`--segments` CSV, JSON list, or JSONL). Times are on the clip clock (`start_s`/`end_s` or `start_ms`/`end_ms`). A segment is the doctor when `role` is `doctor` or `clinician`, or when `speaker_idx` matches the window's `doctor_speaker_idx` / `doctor_slot` (or `--doctor-slot` when the row is blank). Overlap segments are dropped. `doctor_uid8` filters only when both the segment and the window have it. A `segments_json` column on the windows CSV is used for a clip that is not in `--segments`.
- **Nemotron probabilities** (`--nemotron-dir`). Used when `diar_src` is `nemotron` (even if `--segments` is also passed), and when a clip has no segments. Files are gzip NLP1, looked up as `<clip_id>.nlp`, `<window_id>.nlp`, or the path in `nlp_path` / `nlp_key`. Doctor frames are single-speaker frames of the doctor slot at `--doctor-thr` (default 0.5). Frame 0 is clip time `nlp_origin_s` (default 0).

Clip audio is `<clip_id>.wav` or `.flac` in `--clip-audio-dir`, 16 kHz mono, on the same clock as `start_s`. It is not the per-window file in `--audio-dir`.

Columns added for arousal, valence, dominance, and for eGeMAPS F0, loudness and rate:

- `{col}__rel_doctor` — patient minus doctor.
- `{col}__rel_doctor_ratio` — where a ratio is meaningful. Linear loudness and rate use patient/doctor when both are > 0. F0 level features are semitones, so the ratio is the Hz ratio `2 ** ((patient − doctor) / 12)`. Slopes, spread, and dB loudness stay difference-only.
- `{model}__rel_doctor_cosine` — cosine of the two embeddings.

`doctor_ref_source`, `doctor_ref_status`, `doctor_ref_reason`, `doctor_ref_s` and `doctor_ref_n_spans` record the selection. `doctor_ref_s` is 0 when doctor speech was sought and none fell inside the horizon. A missing source, missing slot, or missing probability file leaves `doctor_ref_s` empty and sets the reason (`no_source`, `doctor_slot_missing`, `nlp_missing`, `doctor_unidentified`, `clip_audio_missing`, …).

```bash
python -m tools.timbre.run \
    --windows windows.csv \
    --audio-dir /path/to/window-wavs \
    --clip-audio-dir /path/to/clip-wavs \
    --segments /path/to/segments.jsonl \
    --out results/ \
    --models all \
    --device cpu \
    --doctor-ref \
    --doctor-budget-s 15 \
    --doctor-horizon-s 60
```

Nemotron, when the windows CSV carries `diar_src=nemotron` and `doctor_slot` (or you pass `--doctor-slot`):

```bash
python -m tools.timbre.run \
    --windows windows.csv \
    --audio-dir /path/to/window-wavs \
    --clip-audio-dir /path/to/clip-wavs \
    --nemotron-dir /path/to/nlp \
    --out results/ \
    --models all \
    --device cpu \
    --doctor-ref \
    --doctor-slot 0
```

A segments JSONL row looks like this (synthetic ids):

```json
{"clip_id":"synth_consultA","start_ms":1500,"end_ms":4000,"speaker_idx":0,"role":"doctor","overlap":false,"doctor_uid8":"d0000001"}
```

### Labels

```bash
python -m tools.timbre.evaluate --labels labels.csv --features results/features.parquet --out results/eval.json
```

`--out` takes a file or a directory (an existing directory, or a path ending in `/`); a directory gets `report.json`. The report is strict JSON (NaN becomes `null`).

`--scalar-ridge` adds a room-day grouped-CV ridge head on scalar features for models that have neither direct arousal/valence nor an embedding (eGeMAPS, ComParE). The penalty scales with the feature count. Rows report `arousal_source = ridge_oof_scalar`.

`--include-rel` puts `__rel_doctor`, `__rel_doctor_ratio` and `__rel_doctor_cosine` into that scalar head, and concatenates them onto an embedding ridge. Without the flag those columns are left out (a relative column is often missing on windows that had no doctor speech; a row with any missing relative value is left out of the fit). For eGeMAPS pass both flags. Direct arousal/valence scores are unchanged.

```bash
python -m tools.timbre.evaluate \
    --labels labels.csv \
    --features results/features.parquet \
    --out results/eval.json \
    --scalar-ridge \
    --include-rel
```

Locked metric snapshots live in `baselines/` (aggregates only; see `baselines/README.md`).

### Patient purity

`purity.py` scores how much of a window is the patient alone, from per-frame speaker evidence: speaker-embedding cosines (`embedding_purity`) or Nemotron per-frame probabilities (`probs_purity`). `frame_patient_scores` is the per-frame Nemotron view (patient dominance and the second-highest speaker probability). `PurityRule()` is the one keep rule (purity >= 0.6, >= 3 s pure patient speech, mean patient cosine >= 0.30). `PurityRule.judge(embedding=..., probs=...)` fuses both scores first: purity and pure-patient seconds are the worse of the two. It loads no audio or model.

Optional `--outcomes outcomes.csv` joins accept/defer and unresolved-doubt counts after dropping hidden-repeat rows. That hook is not the pre-registered T-8 likelihood-ratio test.

Gold rows with `not_patient` or `unusable` are excluded. Hidden repeats (`is_repeat`) score intra-rater quadratic weighted kappa, Spearman, CCC, and exact agreement. Arousal and valence use Lin's CCC (0–1 model outputs are mapped onto 1–5 first) and Spearman. When a model has no direct A/V columns, a grouped-CV ridge head on its embedding produces the CCC. Flags `engaged`, `anxious`, `resistant`, `words_ne_tone` (CSV alias `words_tone_mismatch`) use a grouped-CV logistic head and macro-F1. Groups are `room|date`.

### Text lane and fusion

`TEXT_LANE.md` is the operator note. Jev scores masked patient text only, behind `TIMBRE_TEXT_LANE=1`, and never sees audio. `--fusion` (with `--text-scores`) adds voice-only, text-only, and late-fused Spearman / CCC / macro-F1 on one room-day GroupKFold. Without that flag the report is unchanged.

```bash
python -m tools.timbre.text_lane mask --in windows.csv --out masked.jsonl
TIMBRE_TEXT_LANE=1 TIMBRE_JEV_MOCK=1 python -m tools.timbre.text_lane score --in masked.jsonl --out scores.jsonl
python -m tools.timbre.evaluate --labels labels.csv --features results/features.parquet \
  --out results/eval.json --fusion --text-scores scores.jsonl --voice-model audeering_msp_dim.v1
```

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
| `clef_omni_valence.v1` | `@cf/cloudflare/clef-omni` (Workers AI) | Cloudflare Workers AI terms. Patient audio is approved for Timbre. |

Commercial openSMILE and audEERING licences are being procured (architecture issue #81, T-12). MSP-Podcast terms may still bind the Odyssey, Vox-Profile, and audEERING dimensional checkpoints. emotion2vec attribution is called out in that same issue.

Vox-Profile is not pip-installable. `extractors/voxprofile_dim.py` is an adapter of `WhisperWrapper` from `github.com/tiantiaf0627/vox-profile-release`. Upstream `forward` hardcodes CUDA and the `return_feature` branch does not return; the adapter honours `--device` and returns the pooled 256-d features plus arousal, valence, and dominance. It refuses LoRA checkpoints (no `loralib`). The catalog asks for about 12 GB free before load, because the fp32 Whisper skeleton is allocated before the checkpoint arrives.

Odyssey's published `pipeline_utils.py` targets transformers 4. The extractor keeps that architecture locally (same module names, `post_init` for transformers 5) and does not execute the remote file.

Transformers 5 loads Whisper with `dtype="auto"`. The Whisper-large-v3 config is fp16, and on CUDA that is a half conv bias against float32 mel features (`Input type (float) and bias type (c10::Half)`). The encoder and the Vox-Profile backbone are loaded in float32, and the mel features are cast to that dtype.

`catalog.py` lists a `ram_gb` floor per model. Below that, `python -m tools.timbre.run` logs the reason, skips that model, and continues with the rest. The slow test skips the same way.

## Nemotron probability files

Optional reader for `eta-audio/lab/nemotron-probs/bw_<room>_<window_start_ms>_primary.nlp`.

```python
from tools.timbre.nemotron_probs import load_nlp, patient_frames
loaded = load_nlp(path, expected_duration_s=900)  # or gzip bytes
mask = patient_frames(loaded.probs, doctor_slot=0, thr=0.5)
```

The container matches `tools/nemotron-worker/lab.py`: gzip of `NLP1`, a little-endian header length, a JSON header, then a `u8` matrix scaled by `scale` (255). Column `i` is NeMo `speaker_i`. ETA turn labels `spkN` are a different index (first-speech order); see slot mapping below.

**Frame step.** The worker writes `frame_ms: 80` in every file. Production objects are `rows=90003`, `cols=8`, which is 90,003 frames (`90003 % 8 == 3`, so reading `rows` as frames×cols cannot reshape these bytes). `90003 × 10 ms = 900.03 s` (the 15-minute window). `90003 × 80 ms = 7200.24 s`. `load_nlp` infers the hop as duration / frame count (`resolve_frame_step`), snaps to a whole millisecond in 1..100 ms when the ratio is within 2%, and uses that hop when it explains the known duration better than the header. Pass the real audio length as `expected_duration_s` (a bench window is 900). A disagreement raises `FrameStepWarning` and is stored on `loaded.frame_step_warning`. The header value stays on `loaded.header_frame_ms` and `loaded.header["frame_ms"]`. A ratio that is not a sane hop (a 100-frame file against a 900 s duration) keeps the header and still warns. The matrix is not reshaped and no samples are dropped. `loaded.frame_ms` is the hop to use. `loaded.candidates[].duration_s` is still the header clock. `slots.py` maps column `i` (NeMo `speaker_i`) to the doctor and the patient.

R2 fetch is optional and read-only (`GetObject` only, keys under `lab/nemotron-probs/*.nlp`). `fetch_nlp_object` / `--r2-key` read these environment variables and never print them:

- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The bucket is `eta-audio`. Tests pass a fake `client` and do not set the variables.

## Patient slots and windows

`slots.py` decides which probability column is the doctor and which is the patient.

* Doctor, ETA signal: an identity row with a clinician id and cosine >= 0.65 (`DIARIZE_BATCH_THRESHOLD`). A `speaker_label` of `spkN` is aligned onto a column with `turns` (`align_labels`); it is not used as the column index. A claim under 0.65 does not fall through to the centroid.
* Doctor, centroid: cosine of each column's ECAPA vector to the doctor centroid. The vector is the mean of that column's dominant frames (`frame_embeddings`) or a row of `slot_embeddings`. Accept at cosine >= 0.65 with a lead of 0.05 over the next column (`PULSE_ROOM_MIN_MARGIN`).
* If the ETA signal and the centroid name different columns, status is `ambiguous`.
* Patient: the other column with the most exclusive talk (only speaker at or above 0.5). A runner-up with at least 75% of that talk is `ambiguous` (translator or attender). Confidence is the minimum of the doctor cosine and `1 - rival_talk/patient_talk`. Explicit `--doctor-slot` and `--patient-slot` skip the match (confidence 1, source `given`).

`nemotron_windows.py` keeps frames where the patient column passes `frame_patient_scores`, then slices those spans to 3–15 s with at least 3 pure seconds. An ambiguous decision writes no windows. The CSV is the candidate-window schema (`window_id,room,date,lang,phase,start_s,end_s,patient_speech_s,role`) plus `diar_src=nemotron`. `window_id` is `<clip_id>_p<start_ms, 7 digits>`.

```bash
python -m tools.timbre.nemotron_windows \
  --nlp timeline.nlp --duration-s 900 \
  --clip-id CLIP --room ROOM --date 2026-01-01 --lang en --phase open \
  --embeddings slots.npy --centroid doctor.npy \
  --out windows.csv
```

`slots.npy` is `(speakers, dim)`, `doctor.npy` is the centroid. `--frame-embeddings` is `(frames, dim)` instead of `--embeddings`. `--eta-json` is an identity dict or list, and `--turns-json` is `[[start_ms, end_ms, "spkN"], ...]` when the identity uses labels. Exit 0 when the map is ok (the CSV may still be header-only if no span is long enough), exit 3 when the map is ambiguous, exit 1 on a bad file.

```bash
python -m tools.timbre.nemotron_windows \
  --r2-key lab/nemotron-probs/bw_ROOM_STARTMS_primary.nlp \
  --duration-s 900 \
  --clip-id CLIP --room ROOM --date 2026-01-01 --lang en --phase open \
  --embeddings slots.npy --centroid doctor.npy \
  --out windows.csv
```

That key form is `bw_<room>_<window_start_ms>_primary.nlp` under `lab/nemotron-probs/`. The command reads `R2_ENDPOINT`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` from the environment.

## Fixtures

`fixtures/` is synthetic. `audio/synth_consultA_p0000000.wav` is a one-second harmonic stack from `synth_speech`. `tiny.nlp` is a 2×2 matrix. `windows.csv` and `labels.csv` use invented ids. `fixtures/text/` is invented sentences and a Scribe-shaped speaker export. No patient audio and no real consult is in this tree.

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

## Clef-omni valence

`clef_omni_valence.v1` is an API extractor (no local weights). It posts one 16 kHz mono WAV per patient window to Workers AI `@cf/cloudflare/clef-omni`. Question set `timbre-clef-v1` asks a 1–5 valence score (very negative … very positive), a diagnostic 1–5 arousal score, and three noul questions (`anxious`, `engaged`, `one_patient`). The valence column is the expected value of the 1–5 distribution. `arousal_ev` is not the Timbre arousal score.

The call refuses unless `TIMBRE_CLEF=1`. `TIMBRE_CLEF_MOCK=1` is a deterministic offline mock and still needs that switch. Auth is `CF_WORKERS_AI_TOKEN`. `CF_ACCOUNT_ID` may be omitted when `R2_ENDPOINT` is `https://<account>.r2.cloudflarestorage.com`.

```bash
TIMBRE_CLEF=1 CF_WORKERS_AI_TOKEN=... CF_ACCOUNT_ID=... \
  python -m tools.timbre.clef_omni \
  --windows windows.csv --audio-dir DIR --out results/clef/

TIMBRE_CLEF=1 TIMBRE_CLEF_MOCK=1 \
  python -m tools.timbre.clef_omni \
  --windows windows.csv --audio-dir DIR --out results/clef/
```

Optional: `TIMBRE_CLEF_CACHE`, `TIMBRE_CLEF_COST_LOG`. Default concurrency is 4. Clips over 8 MiB or 300 s are refused, and a request never carries more than 4 clips. Retries back off on 429 and 5xx. The cache key is the wav sha256 plus `timbre-clef-v1`. A billed cost-log line is that call's input tokens times US$0.15 per million. Mock runs and cache hits are logged with `billed` false. Logs do not contain audio or the token.

When the windows CSV already has `purity` and `pure_patient_s`, a window that fails `PurityRule` is `unscorable` with reason `purity` and no valence. Columns that were never written are not treated as a failure. `python -m tools.timbre.run --models clef_omni_valence.v1` uses the same client but does not read those purity columns.

`calibrate.py` centre-scales Odyssey arousal and Clef valence per room, else per `doctor_uid8`, else with the global median and IQR (minimum cell size default 8). An isotonic map fitted on gold batches 1 and 2 then sends the centred value onto the 1–5 rater scale. The raw column is kept. The JSON stores aggregates only.

```bash
python -m tools.timbre.calibrate fit \
  --scores results/features.parquet --labels gold.csv \
  --score-col odyssey_wavlm_dim.v1__arousal --gold-col arousal \
  --out results/odyssey_arousal.calib.json

python -m tools.timbre.calibrate fit \
  --scores results/features.parquet --labels gold.csv \
  --score-col clef_omni_valence.v1__valence --gold-col valence \
  --out results/clef_valence.calib.json

python -m tools.timbre.calibrate apply \
  --scores results/features.parquet \
  --calibration results/clef_valence.calib.json \
  --out results/features.calibrated.parquet
```

## v1 pipeline

`python -m tools.timbre.pipeline` is the production-shaped path. It does not write a clinical note. Output under `--out` is private: it contains window ids and must not be committed. The log line is counts only.

Order of operations:

1. Sessions/clips (local `--audio-dir` or R2 `--r2`) plus a speaker source (`--speaker nemotron` or `--speaker segments`) and doctor voiceprints.
2. Patient windows from `nemotron_windows` (Nemotron probabilities) or from an existing `--windows` CSV.
3. `PurityRule.judge`. Purity and pure-patient seconds are the worse of the embedding score and the Nemotron probability score. A failed window is `unscorable` with a reason (`no_voiceprint`, `no_patient`, `low_purity`, `short_pure_speech`, `low_patient_cosine`, `overlap`, `too_short`, `attender_speaks_for_patient`) and is not sent to a model.
4. Odyssey WavLM-dim arousal, direct. audEERING MSP-dim runs only when Odyssey does not return a finite arousal (`audeering_fallback`).
5. Clef-omni valence, audio only, when `TIMBRE_CLEF=1`. The stored value is the 1–5 expected value.
6. `calibrate.py` apply, per room then per doctor, from the saved JSON files.
7. Per-window table (`windows.parquet`: raw and calibrated arousal/valence, purity, reason) and per-consult aggregates (`consults.json`: median, trajectory open/mid/close, percent of windows scorable).

The Jev text lane v2 is off unless `--text-lane` is set. It also needs `TIMBRE_TEXT_LANE=1`. Question set is `timbre-text-v2`. Transcript text is not written to the table or the log.

```bash
TIMBRE_CLEF=1 CF_WORKERS_AI_TOKEN=... HF_TOKEN=... \
  R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=eta-audio \
  python -m tools.timbre.pipeline \
  --sessions clips.csv \
  --audio-dir /path/to/clips \
  --speaker nemotron \
  --nemotron-dir /path/to/nlp \
  --voiceprints voiceprints.json \
  --embeddings-dir /path/to/frame-embeddings \
  --calibration-arousal results/odyssey_arousal.calib.json \
  --calibration-valence results/clef_valence.calib.json \
  --out results/v1/

# local windows CSV, no R2
TIMBRE_CLEF=1 TIMBRE_CLEF_MOCK=1 \
  python -m tools.timbre.pipeline \
  --windows windows.csv --audio-dir /path/to/windows --out results/v1/

# optional text lane (off by default)
TIMBRE_CLEF=1 TIMBRE_TEXT_LANE=1 \
  python -m tools.timbre.pipeline \
  --windows windows.csv --audio-dir DIR --text-lane --text-in patient.jsonl --out results/v1/
```

`CF_ACCOUNT_ID` may be omitted when `R2_ENDPOINT` is `https://<account>.r2.cloudflarestorage.com`. `HF_TOKEN` is read by the Hugging Face libraries when Odyssey or audEERING weights are downloaded. The pipeline does not print it.

Voiceprints JSON is `{"d0…": [centroid floats]}` or `{"doctors": {"d0…": {"centroid": [...]}}}`. Frame embeddings are `<clip_id>.npy` with shape `(frames, dim)`, aligned to the Nemotron hop. A windows CSV may instead carry `cos_patient` / `probs`, or the aggregate columns `purity`, `pure_patient_s`, and `cos_patient_mean`.

### Evaluation (no leakage)

Calibration for the gold report is cross-fitted. With `--batch-col` and two or more batches, the map is fit on batch 1 and applied to batch 2, then the reverse. `--cv room-day` uses GroupKFold on `room|date` instead. A single batch falls through to that room-day split. A fold that shares a window with the rows it scores is refused. The report has raw and calibrated Spearman and CCC per batch and pooled, plus the per-room scorable rate. Window ids are not in the report or the log.

```bash
python -m tools.timbre.pipeline evaluate \
  --scores results/v1/windows.parquet \
  --gold-labels batch1.csv batch2.csv \
  --batch-col batch \
  --out results/v1/eval.json

python -m tools.timbre.pipeline evaluate \
  --scores results/v1/windows.parquet \
  --gold-labels gold.csv \
  --batch-col batch \
  --cv room-day \
  --out results/v1/eval-roomday.json
```

`--gold-labels` and `--batch-col` are also accepted on the score command. That run still cross-fits; it does not score a window with a map fit on that window.
