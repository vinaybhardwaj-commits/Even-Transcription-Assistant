# diar-lab phase 2: durability + repeatability proof (2026-09-23)

Per orders/DIAR-LAB.md "Durability + repeatability" item 5. Smoke scale: results are NOT a model-quality signal.

## 1. Dataset rebuild from manifest -> identical hashes: PASSED
Manifest `datasets/diar-train-smoke-2026-09-23.json` (12 windows, room-day split, teacher = pyannote.ai `precision-3`,
audio via the K1/K2-fixed `kit/clip_fetch_core.py`). Rebuilt into two clean directories; RTTM regenerated fresh from Neon
each time. For all 12 windows: manifest sha256 == rebuild_1 == rebuild_2 (audio and RTTM).
Caveat: the audio "source" in that proof was the already-fetched local copy, not a second live fetch; a second live
Scribe fetch of the same window is not guaranteed byte-identical (ffmpeg re-encode), which is why the manifest pins the
sha256 and `build_dataset.py` fails loudly on mismatch rather than assuming reproducibility.

## 2. Retrain 1 epoch twice -> identical result: PASSED (same GPU, corrected head; supersedes the first version of this proof)
| | run 1 (`run-2026-09-23-190306-26-09-23`) | run 2 (`run-2026-09-23-190354-26-09-23`) |
|---|---|---|
| train loss | 0.3001030683517456 | 0.3001030683517456 |
| val loss | 0.25481030344963074 | 0.25481030344963074 |
| val DER | 0.2582587003707886 | 0.2582587003707886 |
| weights sha256 (state_dict, last and best) | 2d9ed43fa9eb786a... | 2d9ed43fa9eb786a... |
| checkpoint FILE sha256 | 01836ab4... | 61e22d4b... (differs, see below) |
Setup: gcp-l4 (NVIDIA L4, driver 580.178.04), torch 2.2.2+cu121, pyannote.audio 3.3.2, seed 42 via Lightning `seed_everything(workers=True)`,
`num_workers=0`, `deterministic=True`, `CUBLAS_WORKSPACE_CONFIG=:4096:8`, lr 5e-5, env pinned in `requirements-freeze-gcp-l4.txt`, code git sha in each record.
**The repeatability criterion is the weights hash, not the file hash.** Lightning writes callback state (`ModelCheckpoint.best_model_path`) into the
checkpoint, and the two runs wrote to different directories, so the files differ by bytes while every one of the 54 weight tensors is identical
(verified by hashing all four files' state_dicts). Both hashes are recorded: `weights_sha256` for reproducibility, `checkpoint_sha256` for copy integrity.
Not claimed: bit-identity across different GPUs or torch/CUDA builds.

## 3. Bugs found and fixed on the way (all in git history)
1. `pyannote.database` custom protocol: deprecated `uris:` key makes the loader look for a `.lst` file loader -> use `uri:`.
2. `SpeakerDiarization` task iterates `file["annotated"]` -> needs a UEM per file (added, full labelled window).
3. Run record read the wrong metric key (`loss` vs `loss/train`) and logged `-1.0`; fixed. Box code is an rsync copy, so the git sha is passed via `DIARLAB_GIT_SHA`.
4. Earlier ad-hoc audio fetch used the `-ss`-before-`-i` pattern flagged as K1; all smoke audio was re-fetched through the fixed shared tool.
5. **Wrong head (found by de-risk eval, 24 Sep 00:15):** the task's default head is multi-label, the base model's is powerset. Fine-tuning silently rebuilt the classifier
   and the checkpoint could not be swapped into the 3.1 pipeline (`'ParamDict' object has no attribute 'threshold'`). Now the task uses the base limits
   (3 speakers/chunk, 2/frame) and the run FAILS if the head changes. Earlier records are in `runs/superseded/`.
6. pyannote hard-codes `Adam(lr=1e-3)`: too aggressive for fine-tuning; lr is now explicit (default 5e-5) and recorded; the val-best checkpoint is kept next to the last one.

## 4. Rebuild from manifest with a SECOND LIVE FETCH (24 Sep ~00:20 IST)
`build_dataset.py` now fetches via `kit/clip_fetch_core` (Scribe read-scope; the R2 path was dead). Rebuilt the merged dataset
(19 windows from two manifests) into a clean directory: **16/16 windows exported on this box came back byte-identical (audio + RTTM)
to their manifest hashes** -- a real second fetch+decode, not a local copy. **3 windows from another pane's manifest
(`diar-train-2026-09-23-1a61baea.json`: bw_7tedad86_1790159400000, bw_eznumztb_1790149500000, bw_25prz6ry_1790161200000) did not:** RTTM matches,
rebuilt length is correct (899.979 s), audio bytes differ; their original files are not on this box so the cause is unknown
(gap padding or a different ffmpeg/encode there). `merge_manifests.py` now fails closed: it only trains on windows whose wav+rttm
hash-match on the box doing the training, and lists the rest under `excluded_unverified`. Owner of that manifest (herdr-kit) should re-export or explain.
Unattended pipeline: `nightly_pipeline.sh 07:30 5` (export -> verified merge -> commit manifest -> rsync -> fine-tune on gcp-l4 under `gpu.lock`).
