# diar-lab phase 2: durable, repeatable training pipeline

Per `orders/DIAR-LAB.md` "Phase 2 spec" and "Durability + repeatability". Owner: diar-lab (lane L4).

## Pieces
- `lib_diar_train.py` — shared Neon read (via `kit/neon-select.mjs`, read-only) and R2 client helpers. No transcript text or audio ever printed.
- `nightly_export.py` — finds new pyannote.ai teacher labels (`diarize_window_label`, `engine='pyannoteai'`) not yet in a dataset manifest, materializes clip audio + RTTM under `~/eta-data/diar-train/<ist_date>/`, writes a new manifest to `../../datasets/<dataset_id>.json`. Split is BY ROOM-DAY (deterministic hash of `room_day_id`, 80/10/10), never by window. V's 5 hand-checked windows and the 20 bench windows are hard-excluded (permanent test set, never trained on) even if a label exists for them.
- `build_dataset.py <manifest> --out-dir <dir>` — rebuilds a dataset from its manifest (R2 + Neon), verifying every audio/RTTM sha256 against the manifest. This is the "Proof" step from the durability spec: run it twice into two clean dirs and diff the hashes.
- `train_segmentation.py` — fine-tunes `pyannote/segmentation-3.0` (or community-1's segmentation) on a materialized dataset. Writes a run record to `../../runs/<run_id>.json` (git sha, dataset id, config, env fingerprint, metrics, checkpoint sha256 + R2 key). **As of this writing it is scaffolding, not yet executed** — see Status below.

## Status (2026-09-23, first pass)
- `nightly_export.py --dry-run` verified against real data: 33 pyannote.ai teacher labels exist in Neon right now, correctly detected, correctly excludes the permanent test-window ids.
- **R2 credentials are not present on this box** (`R2_ACCOUNT_ID`/`R2_ENDPOINT`/`R2_BUCKET`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, names match `Even-Transcription-Assistant/.env.example`) — the clip-fetch step (`nightly_export.py` without `--dry-run`, and all of `build_dataset.py`) is untested against real R2 and will raise a clear `RuntimeError` naming the missing var until they're provided.
- `train_segmentation.py` writes a run record with `status: SCAFFOLD_NOT_RUN` and does not fabricate a training result — the actual fine-tune call (pyannote.audio's documented recipe: `Model.from_pretrained` + `SpeakerDiarization` task + a `pytorch_lightning.Trainer`) is written as a clear comment block, not executed, both because R2 access blocks materializing real audio and because 33 windows is too small a set for a first real run to mean anything yet (teacher labels are still accumulating overnight).
- **eta-train R2 bucket**: not yet confirmed to exist; per the durability spec it needs creating "via the ETA repo's R2 tooling or ask Fable" — not done by this pipeline, flagged separately.

## Next steps once R2 access exists
1. Run `nightly_export.py` for real once enough labels have accumulated (spec: first run Thursday ~07:30 on that night's labels, or sooner if the label volume supports a meaningful toy run).
2. Run `build_dataset.py` twice into two clean directories, diff the hashes (the "Proof" step) — do this before any real training run.
3. Run `train_segmentation.py` for a short toy run (uncomment the training block) twice, compare metrics for the nondeterminism check the spec asks for.
4. Only after both proofs pass, run the first real fine-tune.
