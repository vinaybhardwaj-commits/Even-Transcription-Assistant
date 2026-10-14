#!/usr/bin/env python3
"""Fine-tune pyannote's segmentation model on our room windows, using pyannote.ai
teacher labels (orders/DIAR-LAB.md Phase 2, step 1 — the main lever).

Durability (orders/DIAR-LAB.md "Durability + repeatability"):
  - training code lives here, in eta-lab git
  - config is a flat, fully-specified dict, fixed seed, dumped into the run record
  - the run record (git sha, dataset id, config, env lock hash, metrics, checkpoint
    sha256 + R2 key) is written to eta-lab/runs/<run_id>.json
  - the shipped model on the Mini is referenced by run_id, never by a bare path

Usage:
    python train_segmentation.py --manifest ../../datasets/<id>.json --data-dir /home/eta/eta-data/diar-train/<id>/ \
        --out-dir ~/eta-lab-night/diar-lab/runs/<run_id>/ --max-epochs 1 --seed 42

This is deliberately a thin wrapper around pyannote.audio's own fine-tuning
recipe (Model.from_pretrained + a pyannote.database Protocol built from the
manifest's RTTM files + a pytorch_lightning Trainer) — no custom training loop,
so upstream bugfixes and the documented recipe keep applying.
"""
import argparse
import hashlib
import json
import os
import random
import subprocess
import sys
import time

import numpy as np
from lib_diar_train import sha256_file, weights_sha256
import torch


def set_seed(seed: int):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    try:
        from pytorch_lightning import seed_everything
        seed_everything(seed, workers=True)
    except ImportError:
        pass


def git_sha() -> str:
    # The GPU boxes hold an rsync copy of this directory, not a git checkout, so the sha is
    # passed in (DIARLAB_GIT_SHA) by whoever syncs the code. UNKNOWN is recorded, never guessed.
    env = os.environ.get("DIARLAB_GIT_SHA")
    if env:
        return env
    r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=os.path.dirname(os.path.abspath(__file__)),
                        capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else "UNKNOWN"


def env_lock_hash() -> str:
    """Hash of the pinned package versions actually running this, not a lockfile
    on disk (uv doesn't lock this ad-hoc venv) — same effect: reproducible env fingerprint."""
    import importlib.metadata as m
    pkgs = ["torch", "torchaudio", "numpy", "huggingface-hub", "pyannote.audio", "pytorch-lightning"]
    versions = {p: (m.version(p) if _has(p) else None) for p in pkgs}
    blob = json.dumps(versions, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()[:16], versions


def _has(pkg):
    import importlib.metadata as m
    try:
        m.version(pkg)
        return True
    except m.PackageNotFoundError:
        return False


def build_protocol(manifest: dict, data_dir: str, protocol_dir: str):
    """Build a pyannote.database custom Protocol (database.yml + per-split .lst/.rttm)
    from the manifest, pointing at the wav/RTTM files under data_dir. pyannote's own
    custom-protocol format (pyannote/database/custom.py): Protocols -> Database ->
    SpeakerDiarization -> ProtocolName -> {train,development,test}: {uris, annotation}."""
    from pyannote.database import registry, FileFinder

    os.makedirs(protocol_dir, exist_ok=True)
    by_split = {"train": [], "development": [], "test": []}
    wav_by_uri = {}
    split_map = {"train": "train", "val": "development", "test": "test"}

    # Early nights have few room-days, so the deterministic room-day hash can leave val empty.
    # Rule (recorded in the run record, never silent): if no window is val, hold out ONE WHOLE
    # room-day (the last by id) from train as val -- still split by room-day, never by window.
    holdout_room_day = None
    if not any(w["split"] == "val" for w in manifest["windows"]):
        room_days = sorted({w["room_day_id"] for w in manifest["windows"] if w["split"] == "train"})
        if len(room_days) >= 2:
            holdout_room_day = room_days[-1]
    manifest_windows = []
    for w in manifest["windows"]:
        if holdout_room_day and w["room_day_id"] == holdout_room_day:
            w = {**w, "split": "val"}
        manifest_windows.append(w)

    for w in manifest_windows:
        uri = w["window_id"]
        wav = os.path.join(data_dir, w["ist_date"], f"{uri}.wav")
        rttm = os.path.join(data_dir, w["ist_date"], f"{uri}.rttm")
        if not (os.path.exists(wav) and os.path.exists(rttm)):
            print(f"WARN: missing materialized files for {uri}, skipping", file=sys.stderr)
            continue
        split = split_map.get(w["split"])
        if split is None:
            continue
        by_split[split].append((uri, rttm))
        wav_by_uri[uri] = wav

    import soundfile as sf
    for split, entries in by_split.items():
        if not entries:
            continue
        with open(os.path.join(protocol_dir, f"{split}.lst"), "w") as f:
            f.write("\n".join(uri for uri, _ in entries) + "\n")
        with open(os.path.join(protocol_dir, f"{split}.rttm"), "w") as out:
            for uri, rttm_path in entries:
                with open(rttm_path) as rf:
                    out.write(rf.read())
        # UEM: which region of each file is annotated. pyannote's SpeakerDiarization task
        # requires an `annotated` entry per file (file["annotated"] is iterated in
        # Task.prepare_data). The teacher labelled the whole window (silence included),
        # so the annotated region is the full file duration.
        with open(os.path.join(protocol_dir, f"{split}.uem"), "w") as uem:
            for uri, _ in entries:
                duration = sf.info(wav_by_uri[uri]).duration
                uem.write(f"{uri} NA 0.000 {duration:.3f}\n")

    database_yml = os.path.join(protocol_dir, "database.yml")
    lines = ["Protocols:", "  DiarLab:", "    SpeakerDiarization:", "      Smoke:"]
    for split in ("train", "development", "test"):
        if by_split[split]:
            lines.append(f"        {split}:")
            lines.append(f"          uri: {split}.lst")
            lines.append(f"          annotation: {split}.rttm")
            lines.append(f"          annotated: {split}.uem")
    with open(database_yml, "w") as f:
        f.write("\n".join(lines) + "\n")

    registry.load_database(database_yml)
    protocol = registry.get_protocol("DiarLab.SpeakerDiarization.Smoke", {"audio": FileFinder()})

    # FileFinder needs a way to map uri -> wav path; simplest robust route for a
    # handful of files: monkey-patch a preprocessor that looks up our dict directly.
    def _find_audio(file_dict):
        return wav_by_uri[file_dict["uri"]]
    protocol.preprocessors["audio"] = _find_audio

    build_protocol.holdout_room_day = holdout_room_day
    return protocol, len(by_split["train"]), len(by_split["development"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--data-dir", required=True, help="output of build_dataset.py for this manifest")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--base-model", default="pyannote/segmentation-3.0")
    ap.add_argument("--max-epochs", type=int, default=1)
    ap.add_argument("--num-workers", type=int, default=0,
                    help="dataloader workers; 0 keeps sampling order deterministic (needed for the repeatability proof)")
    ap.add_argument("--lr", type=float, default=5e-5,
                    help="pyannote hard-codes Adam(lr=1e-3), too aggressive for fine-tuning a converged model; explicit + recorded")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--device", default="cuda", choices=["cpu", "cuda", "mps"])
    args = ap.parse_args()

    set_seed(args.seed)
    os.makedirs(args.out_dir, exist_ok=True)

    with open(args.manifest) as f:
        manifest = json.load(f)

    protocol_dir = os.path.join(args.out_dir, "protocol")
    protocol, n_train, n_val = build_protocol(manifest, args.data_dir, protocol_dir)
    print(f"# dataset_id={manifest['dataset_id']} train_n={n_train} val_n={n_val}", file=sys.stderr)
    if not n_train:
        print("# no materialized training windows — run build_dataset.py against this manifest first", file=sys.stderr)
        sys.exit(1)

    run_id = f"run-{time.strftime('%Y-%m-%d-%H%M%S')}-{manifest['dataset_id'][-8:]}"
    lock_hash, versions = env_lock_hash()

    config = {
        "run_id": run_id,
        "base_model": args.base_model,
        "dataset_id": manifest["dataset_id"],
        "train_n": n_train,
        "val_n": n_val,
        "max_epochs": args.max_epochs,
        "seed": args.seed,
        "num_workers": args.num_workers,
        "lr": args.lr,
        "val_holdout_room_day": getattr(build_protocol, "holdout_room_day", None),
        "device": args.device,
        "git_sha": git_sha(),
        "env_lock_hash": lock_hash,
        "env_versions": versions,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    print(f"# config: {json.dumps(config)}", file=sys.stderr)

    # --- actual fine-tune (pyannote.audio's own documented recipe) ----------
    # SMOKE RUN: proves the pipeline end-to-end (manifest -> protocol -> model ->
    # checkpoint -> run record). train_n is tiny (a manually-fetched sample, not
    # the real nightly volume) so these numbers are not meaningful as a model
    # result — that's expected and stated in the run record, not hidden.
    from pyannote.audio import Model
    from pyannote.audio.tasks import SpeakerDiarization
    from pytorch_lightning import Trainer

    checkpoint_path = os.path.join(args.out_dir, f"{run_id}.ckpt")
    error = None
    best_path, best_score = None, None
    final_loss = None
    final_val_loss = None
    val_der = None
    try:
        set_seed(args.seed)  # re-seed immediately before model/task construction
        model = Model.from_pretrained(args.base_model)
        specs = model.specifications
        base_powerset = bool(getattr(specs, "powerset", False))
        # The task's DEFAULT head is multi-label; segmentation-3.0 is powerset (max 3 speakers/chunk, 2/frame).
        # Without matching those, training silently rebuilds the classifier head and the checkpoint can no
        # longer be swapped into the 3.1 pipeline (found by the de-risk eval, 24 Sep).
        head_kw = {}
        if base_powerset:
            head_kw = dict(max_speakers_per_chunk=len(specs.classes), max_speakers_per_frame=specs.powerset_max_classes)
        print(f"# base head: powerset={base_powerset} {head_kw}", file=sys.stderr)
        task = SpeakerDiarization(protocol, duration=specs.duration, batch_size=2,
                                  num_workers=args.num_workers, **head_kw)
        model.task = task
        model.configure_optimizers = lambda: torch.optim.Adam(model.parameters(), lr=args.lr)
        from pytorch_lightning.callbacks import ModelCheckpoint
        ckpt_cb = ModelCheckpoint(dirpath=args.out_dir, filename="best", monitor="loss/val", mode="min",
                                  save_top_k=1) if n_val else None
        trainer = Trainer(max_epochs=args.max_epochs, accelerator=args.device, devices=1,
                           deterministic=True, logger=False, enable_checkpointing=bool(ckpt_cb),
                           callbacks=[ckpt_cb] if ckpt_cb else None, enable_progress_bar=False)
        trainer.fit(model)
        if bool(getattr(model.specifications, "powerset", False)) != base_powerset:
            raise RuntimeError("head changed during fine-tune (powerset flag differs from base) -- checkpoint not swappable")
        cm = trainer.callback_metrics
        final_loss = float(cm["loss/train"]) if "loss/train" in cm else None
        final_val_loss = float(cm["loss/val"]) if "loss/val" in cm else None
        val_der = float(cm["DiarizationErrorRate"]) if "DiarizationErrorRate" in cm else None
        trainer.save_checkpoint(checkpoint_path)  # last epoch
        if ckpt_cb and ckpt_cb.best_model_path:
            best_path = ckpt_cb.best_model_path
            best_score = float(ckpt_cb.best_model_score)
    except Exception as e:
        import traceback
        error = f"{type(e).__name__}: {e}"
        print(f"# TRAINING FAILED: {error}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)

    checkpoint_sha = None
    if error is None and os.path.exists(checkpoint_path):
        from lib_diar_train import sha256_file, weights_sha256
        checkpoint_sha = sha256_file(checkpoint_path)

    is_smoke = "smoke" in manifest["dataset_id"]
    run_record = {
        **config,
        "status": (("SMOKE_OK" if is_smoke else "OK") if error is None else ("SMOKE_FAILED" if is_smoke else "FAILED")),
        "reason": (error if error is not None else
                   ("smoke run on a hand-fetched sample (not the nightly volume) — proves wiring, "
                    "results not meaningful as a model quality signal" if is_smoke else
                    "real run on the verified nightly dataset; quality is judged only by the held-out evaluation")),
        "final_loss": final_loss,
        "final_val_loss": final_val_loss,
        "best_val_checkpoint_path": best_path,
        "best_val_loss": best_score,
        "best_val_checkpoint_sha256": (sha256_file(best_path) if best_path and os.path.exists(best_path) else None),
        "val_der": val_der,
        "checkpoint_path": checkpoint_path if error is None else None,
        "checkpoint_sha256": checkpoint_sha,
        "weights_sha256": (weights_sha256(checkpoint_path) if error is None and os.path.exists(checkpoint_path) else None),
        "best_val_weights_sha256": (weights_sha256(best_path) if best_path and os.path.exists(best_path) else None),
        "checkpoint_r2_key": None,  # R2 has no working credentials yet; checkpoint stays local
        "metrics": None,
    }
    runs_dir = os.path.join(os.path.dirname(__file__), "..", "..", "runs")
    os.makedirs(runs_dir, exist_ok=True)
    run_record_path = os.path.join(runs_dir, f"{run_id}.json")
    with open(run_record_path, "w") as f:
        json.dump(run_record, f, indent=1)
    print(f"# WROTE {run_record_path} (status={run_record['status']})", file=sys.stderr)


if __name__ == "__main__":
    main()
