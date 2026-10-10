# nemotron-worker (epic #23, ticket a)

The box worker that fills `diarize_nemotron_window` with SHADOW Nemotron turns. It talks only to the three merged
routes (`app/api/diarize/nemotron/{pending,ingest,heartbeat}`) with the bearer `NEMOTRON_WORKER_TOKEN`, and holds no
database credential. Nothing clinician-facing reads these rows.

## What it does
- Heartbeat every 60 s: worker id, host, GPU, model revision, config hash, windows in the last 24 h.
- `GET /pending?worker_id=&limit=` claims windows (15-min lease). `limit` = concurrency (default 1).
- For each window:
  1. Fetch the presigned clip into a private temp dir (0700) and sha256 it while streaming.
  2. Decode to 16 kHz mono (ffmpeg).
  3. Run Nemotron, holding `~/gpu.lock` for the inference only.
  4. Delete the audio.
  5. `POST /ingest`. Turns are integer ms from the clip start, labels `spk0..`, sorted. A re-run of the same clip gives the same payload, so the server answers `duplicate`.
- Failures post `status: failed` with:
  - `fetch_failed`: no hash, audio_ms 0.
  - `decode_failed`: terminal on the server; the hash is sent.
  - `infer_failed`, `gpu_oom`, `too_many_speakers` / `too_many_turns`.
- Back-off on 404 `disabled`, 503 `not_configured` / `db` / `clip_sign`, 401, 5xx and network errors: 30 s doubling to 15 min, ±20 %. Reset on the first 200. 409, `duplicate`, 403 `blind_room_day` and 404 `unknown_window` move on. An ingest 503 or network error is retried 4 times with the identical body.
- Manners:
  - Waits for free VRAM before each claim (default 2048 MiB) and takes `~/gpu.lock` per inference, the box's per-job convention.
  - Runs under `nice -n 10` and `ionice -c 3`.
  - Rate cap: 60 windows/hour by default.
- SIGTERM stops new claims. A fetched window is finished and posted, then the worker exits 0. A window still waiting for the GPU is abandoned unposted: its lease lapses and the server offers it again.
- Base URL: `https://www.evenscribe.app` by default. Any other host is refused unless `NEMOTRON_ALLOW_OTHER_BASE_URL=1` is set.
- Any 3xx from the server is never followed: the worker exits with code 3, since a redirect would carry the bearer to another host. Clips are fetched over https only, with no redirects; anything else posts `fetch_failed`.
- At startup it deletes this user's `nemo-w-*` temp dirs that are over an hour old, left behind by a killed run. Model output with NaN or inf times posts `infer_failed`.
- Never logged: clip URLs, the token, turns, audio paths. The log and `status.json` carry ids, codes, counts and timings.

## LAB lane and probabilities (migration 0143)
- **Lab jobs.** `nemotron_lab_run` (submitted with `scribe_job_submit`, lab only) queues items in `nemotron_lab_item`. The worker asks `GET /api/diarize/nemotron/lab/claim` ONLY when `/pending` answered 200 with no windows, so a production window is never delayed by lab work; the server also answers `reason: production_pending` and claims nothing while any window is claimable. One lab item per cycle, the same rate cap and the same `~/gpu.lock` per inference (and per embedding) as production.
- **Allow-list.** The server validates the overrides (preset enum, post-processing `key: number`, a bounded list of front-end steps, speaker limits, `return_probs`, `return_embeddings` ecapa|titanet); the worker validates AGAIN (`lab.py`) before anything reaches ffmpeg or NeMo, and builds the ffmpeg `-af` string from numbers only. A refused spec posts `failed / bad_spec` and fetches nothing.
- **Results** go to `POST /api/diarize/nemotron/lab/ingest` and land only in `nemotron_lab_item`. Probability / embedding files are PUT to presigned URLs for keys the SERVER chose (`lab/nemotron/<run>/<idx>/…`); a failed upload posts `failed / upload_failed` (retried up to 3 attempts).
- **Production probabilities.** `/pending` now also returns `probs_key` + `probs_put_url`; the worker saves the per-frame speaker probabilities (80 ms frames, NLP1: gzip, u8-quantised) there and posts `probs_r2_key`. Best effort: a failed upload posts the window without the pointer. An older server that sends no URL gets the old body exactly.
- `NEMOTRON_LAB=0` (or `--no-lab`) never asks `/lab/claim`. Embedders are local files only: `NEMOTRON_TITANET_NEMO` (a titanet-large `.nemo`) and `NEMOTRON_ECAPA_DIR` (a speechbrain ecapa directory); unset = `embedder_unavailable` on the item (turns kept)).
- **UNVERIFIED on a live box:** the NeMo calls in `engine_nemo.py` (`include_tensor_outputs`, `postprocessing_yaml`, the two non-stock presets, the embedders). The tests use a stub engine.

## Engine version (what each row is keyed on)
- Stock: `model = nvidia/Nemotron-3-Diarization`, `model_rev = f667ed73aee57d40cc39428eb768b4fd87a0a29e`. It comes from the pinned HF revision, loaded from the local HF cache with `HF_HUB_OFFLINE=1`.
- `config` holds the offline 30.4 s setting: spkcache 264, fifo 40, chunk 340, right context 40, update period 300. `config_hash = c80a0d84…96c6`.
- Fine-tune: OFF unless `NEMOTRON_FINETUNE_CKPT=/path/to.nemo`. Then `model = eta/Nemotron-3-Diarization-ft`, `model_rev` = the file's sha256, and `config.checkpoint = ft-<sha16>`. Its rows never share a key with stock rows.

## On the box
```
# once: the token gating-lead mints, mode 0600
mkdir -p ~/.config/eta-nemotron && chmod 700 ~/.config/eta-nemotron
( umask 077; cat > ~/.config/eta-nemotron/token )      # paste, then Ctrl-D

cd <checkout>/tools/nemotron-worker
./nemotron-worker.sh start         # base URL https://www.evenscribe.app
./nemotron-worker.sh status        # pid, status.json (state, counts, last codes), GPU memory
./nemotron-worker.sh logs 40
./nemotron-worker.sh stop          # SIGTERM; waits up to 180 s for the window in hand
```
- Python: `~/eta-data/nemotron/venv-nemo-main` (NeMo `cf724ac`, torch 2.14 cu126). Override it with `NEMOTRON_PYTHON`.
- Optional knobs: `NEMOTRON_CONCURRENCY`, `NEMOTRON_RATE_PER_HOUR`, `NEMOTRON_MIN_FREE_VRAM_MIB`, `NEMOTRON_GPU_LOCK` (`''` disables it), `NEMOTRON_TMP_ROOT`, `NEMOTRON_WORKER_ID` (default `box-<hostname>`), `NEMOTRON_STATE_DIR`.

## Tests and measurement
- `python3 -m unittest discover -s tools/nemotron-worker/tests -v`: standard library only, with a fake server and a stub engine.
- `measure.py CLIP...` (on the box, in the NeMo venv) prints the speed and VRAM of the real engine. It prints counts and timings only.
