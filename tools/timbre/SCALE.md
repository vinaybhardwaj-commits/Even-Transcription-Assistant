# Timbre scale runner

Batch scoring for every consult in a sessions list. This stays inside `tools/timbre/`. It does not write a clinical note, and it does not touch the app, migrations, or deploys.

The provisional models are the batch-1 arousal pair plus the two secondaries:

| role | catalog name |
|---|---|
| arousal | `odyssey_wavlm_dim.v1` |
| arousal | `audeering_msp_dim.v1` |
| secondary | `voxprofile_whisper_dim.v1` |
| secondary | `egemaps_v02.v1` |

`--models batch1` selects those four. `--models` also accepts `all` or any catalog name or alias (`odyssey`, `audeering`, `voxprofile`, `egemaps`, …).

Device `auto` uses CUDA when `torch.cuda.is_available()` is true, otherwise CPU. Whisper-family checkpoints (`voxprofile_whisper_dim.v1`, `whisper_large_v3_encoder.v1`) load in **float32**. That is the existing extractor fix (`extractors/whisper_encoder.py`, `extractors/voxprofile_dim.py`): transformers 5 would otherwise build a half conv bias against float32 mel features. This runner never passes a half dtype. The earlier GPU pass wrapped `run.main` in `run_wrapped_gpu.py`. This runner calls `build_extractor` directly.

Catalog extractors score one window per forward. `--batch-size` is the number of windows fetched, scored, logged, and committed together. An extractor that implements `extract_batch(audios, sr)` runs one forward over that batch and must keep the float32 Whisper load. The result list must be one dict per window, the same shape as `extract`.

## What is written

`--out` is private operational state. Do not commit it. It holds window ids, object keys, and audio.

| path | what | commit? |
|---|---|---|
| `plan.json` | counts, dtype policy, estimate | no |
| `manifest.json` | the same, plus per-model totals after a run | no |
| `throughput.jsonl` | one line per batch: model, device, dtype, audio seconds, s/audio-s | no |
| `rates_measured.json` | measured s/audio-s for a later `--rates` file | no |
| `report/population.json` | aggregates by room, `doctor_uid8`, and day | only if you have confirmed it has no ids |
| `queue/shard-NNNN.json` | work items, including window ids and R2 keys | no |
| `shards/shard-NNNN/<model>.parquet` | scores keyed by `window_id` + `model_version` | no |
| `merged/features.parquet` | current kept windows, harness merge | no |
| `cache/<sha256>.wav` | fetched audio, mode `0600` | no |

`model_version` is the catalog name (`odyssey_wavlm_dim.v1`), which already includes the extractor version. A row with status `ok` or `nan` for that pair is finished and is not scored again. `error` is retried. A different `model_version` is a different key, so the old row stays in the shard file. `--rescore` scores the current version again.

Shard index is a hash of `clip_id`, so every window of a consult stays on one shard and the object is fetched once per model pass (the local cache serves the later models). `--shard N` scores only that shard. Run one process per output directory, or one process per shard index. A lock file is held while a shard scores; a lock whose pid is gone is taken over.

Windows that fail the purity rule are not queued. A row already scored for one of them is left in the shard parquet and omitted from the merge. Nothing is deleted.

Cells in the population report with fewer than `--min-group-n` windows (default 5) are counted and omitted. If the whole scored set is smaller than that, the report keeps the count and withholds the distribution. The report has no `window_id`, clip id, object key, or audio.

## Inputs

Clips CSV (the runner cuts windows):

```text
clip_id,room,date,lang,phase,doctor_uid8,r2_key,duration_s,role
synthA,ROOM-A,2026-01-01,en,consult,d0000001,consult-clips/synth/synthA/consult.flac,120,patient
```

Required columns: `clip_id`, `room`, `date`, `r2_key`, `duration_s`. Window ids are `<clip_id>_p<start_ms zero-padded to 7 digits>`, from `windows.generate_windows`. The default grid is `--window-s 10 --hop-s 10` (no overlap). A tail shorter than `--min-window-s` (default: the window length) is left out. That grid is an operator setting, not a measured clinical constant.

A CSV that already has `window_id` is not cut again. It needs the usual windows columns plus `r2_key` (the consult object; `start_s` / `end_s` are sliced out of it).

Purity CSV, joined on the same window id. A window with no row is dropped. `PurityRule()` is the batch-1 keep rule: purity >= 0.6, pure patient speech >= 3 s, mean patient cosine >= 0.30 when that value is present.

```text
window_id,purity,pure_patient_s,cos_patient_mean
synthA_p0000000,0.91,8.2,0.62
```

Frame evidence is accepted instead of those three columns. `cos_patient` (and optional `cos_other`, `hop_s`) is scored with `embedding_purity`. `probs` (JSON matrix, `patient_slot`, optional `frame_s` / `doctor_slot`) is scored with `probs_purity`.

Audio objects must be 16 kHz mono `.wav` or `.flac`. Keys must sit under an allowed prefix. The default prefixes are `consult-clips/` and `clips/`. `timeline.json` and any other suffix are refused. `GetObject` is the only call. There is no list and no write.

## Estimate

```text
compute_hours = audio_hours * s_per_audio_s
cost_usd      = compute_hours * gpu_usd_per_hour
```

`audio_hours` is the sum of kept window lengths (overlapping windows are counted twice, because both are scored), summed across models. `cost_usd` is null unless every selected model has a rate and `--gpu-usd-per-hour` is set.

Published rates are the CPU smoke figures in the harness README, not a GPU quote:

| model | s/audio-s | source |
|---|---:|---|
| `egemaps_v02.v1` | 0.012 | CPU smoke |
| `audeering_msp_dim.v1` | 0.048 | CPU smoke |
| `odyssey_wavlm_dim.v1` | 0.080 | CPU smoke |
| `compare2016.v1` | 0.013 | CPU smoke |
| `emotion2vec_plus_large.v1` | 0.046 | CPU smoke |
| `wavlm_aniemore.v1` | 0.076 | CPU smoke |
| `voxprofile_whisper_dim.v1` | UNVERIFIED | not measured on the smoke box |
| `whisper_large_v3_encoder.v1` | UNVERIFIED | not measured on the smoke box |

After a GPU run, pass `rates_measured.json` as `--rates`. Keys starting with `_` are ignored.

## Environment

Set these on the process. Do not put them in the image, the command line of a shared log, or git.

| variable | required | purpose |
|---|---|---|
| `HF_TOKEN` or `HUGGING_FACE_HUB_TOKEN` | to download weights | Hugging Face. The runner does not read it into the plan |
| `R2_ENDPOINT` | to fetch audio | R2 S3 endpoint |
| `R2_ACCESS_KEY_ID` | to fetch audio | read-only key |
| `R2_SECRET_ACCESS_KEY` | to fetch audio | read-only secret |
| `R2_BUCKET` | no | default `eta-audio` |
| `TIMBRE_AUDIO_PREFIXES` | no | comma-separated key prefixes; default `consult-clips/,clips/` |
| `TIMBRE_SESSIONS` | container, if no CLI args | clips or windows CSV |
| `TIMBRE_PURITY` | container, if no CLI args | purity CSV |
| `TIMBRE_OUT` | container, if no CLI args | private output directory |
| `TIMBRE_MODELS` | no | default `batch1` |
| `TIMBRE_DEVICE` | no | `auto` (default), `cpu`, or `cuda` |
| `TIMBRE_WINDOW_S` | no | default `10` |
| `TIMBRE_HOP_S` | no | default `10` |
| `TIMBRE_MIN_WINDOW_S` | no | default: window length |
| `TIMBRE_BATCH_SIZE` | no | default `4` |
| `TIMBRE_SHARDS` | no | default `16` |
| `TIMBRE_SHARD` | no | score one shard |
| `TIMBRE_GPU_USD_PER_HOUR` | no | turns compute hours into `cost_usd` |
| `TIMBRE_RATES` | no | JSON file of s/audio-s |
| `TIMBRE_MIN_GROUP_N` | no | default `5` |
| `TIMBRE_CACHE_DIR` | no | default `OUT/cache` |
| `TIMBRE_DRY_RUN` | no | `1` adds `--dry-run` |
| `TIMBRE_RESCORE` | no | `1` adds `--rescore` |
| `TIMBRE_REPORT_ONLY` | no | `1` rebuilds the population report |

`--dry-run` does not need R2 or a GPU. It writes `plan.json` only.

`boto3` is not in the fast test install. Tests inject a fake client. A real fetch needs the models extra (`boto3`) or the Docker image.

## Launch

Dry-run, from the repo root (no audio, no weights):

```bash
python -m tools.timbre.scale \
  --sessions sessions.csv \
  --purity purity.csv \
  --out /tmp/timbre-scale \
  --dry-run \
  --gpu-usd-per-hour 1.50
```

GPU VM, after the CUDA torch install described in the harness README:

```bash
python -m tools.timbre.scale \
  --sessions sessions.csv \
  --purity purity.csv \
  --out /data/timbre-scale \
  --device auto \
  --models batch1 \
  --batch-size 8 \
  --shards 16
```

One shard of a resumed run:

```bash
python -m tools.timbre.scale \
  --sessions sessions.csv \
  --purity purity.csv \
  --out /data/timbre-scale \
  --device auto \
  --shard 3 \
  --shards 16
```

Rebuild the population report from a finished merge:

```bash
python -m tools.timbre.scale --report-only --out /data/timbre-scale --min-group-n 5
```

Image (context is this directory):

```bash
docker build -f tools/timbre/Dockerfile -t timbre-scale tools/timbre
```

GPU VM via Docker. The entrypoint is `python -m tools.timbre.entrypoint`. Arguments after the image name are scale CLI arguments.

```bash
docker run --gpus all --rm \
  -e HF_TOKEN \
  -e R2_ENDPOINT -e R2_ACCESS_KEY_ID -e R2_SECRET_ACCESS_KEY \
  -e R2_BUCKET=eta-audio \
  -v /data/sessions.csv:/in/sessions.csv:ro \
  -v /data/purity.csv:/in/purity.csv:ro \
  -v /data/timbre-scale:/out \
  timbre-scale \
  --sessions /in/sessions.csv \
  --purity /in/purity.csv \
  --out /out \
  --device auto \
  --models batch1
```

The same image with env vars and no CLI arguments:

```bash
docker run --gpus all --rm \
  -e HF_TOKEN \
  -e R2_ENDPOINT -e R2_ACCESS_KEY_ID -e R2_SECRET_ACCESS_KEY \
  -e R2_BUCKET=eta-audio \
  -e TIMBRE_SESSIONS=/in/sessions.csv \
  -e TIMBRE_PURITY=/in/purity.csv \
  -e TIMBRE_OUT=/out \
  -e TIMBRE_DEVICE=auto \
  -e TIMBRE_MODELS=batch1 \
  -v /data/sessions.csv:/in/sessions.csv:ro \
  -v /data/purity.csv:/in/purity.csv:ro \
  -v /data/timbre-scale:/out \
  timbre-scale
```

Dry-run inside the image:

```bash
docker run --rm \
  -e TIMBRE_DRY_RUN=1 \
  -e TIMBRE_GPU_USD_PER_HOUR=1.50 \
  -v /data/sessions.csv:/in/sessions.csv:ro \
  -v /data/purity.csv:/in/purity.csv:ro \
  -v /tmp/timbre-scale:/out \
  timbre-scale \
  --sessions /in/sessions.csv --purity /in/purity.csv --out /out
```

Hugging Face Job or Space: use this image as the Docker SDK image. The process is the entrypoint above; a Space that expects an HTTP server will exit when the batch finishes, so a Job (or a GPU VM) is the run that matches the entrypoint. Pass `HF_TOKEN` and the three `R2_*` values as secrets, and mount or bake nothing that contains audio, transcripts, or window ids. A flavor with a GPU is required for `TIMBRE_DEVICE=auto` to leave CPU. After the job, copy `report/population.json` and `rates_measured.json` out. Leave the shard parquets and the cache on the private volume.

CPU-only image, for a dry-run build check:

```bash
docker build --build-arg BASE_IMAGE=python:3.11-slim-bookworm \
  -f tools/timbre/Dockerfile -t timbre-scale tools/timbre
```

The default base is `pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime`. `funasr` is not installed; `emotion2vec` is not in `batch1`.
