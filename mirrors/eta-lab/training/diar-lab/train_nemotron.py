#!/usr/bin/env python3
"""Fine-tune nvidia/Nemotron-3-Diarization on pyannote.ai teacher labels (ruling 24c; replaces train_segmentation.py as the programme's trainer).
Same durable/repeatable rules as before: dataset manifest in git (datasets/<id>.json), materialized wav+rttm from build_dataset.py, fixed seed,
explicit lr, run record in git (runs/<run_id>.json) with weights_sha256 of the state_dict (file hashes differ across identical runs),
split by room-day (manifest 'val'; else hold out the last train room-day whole, recorded), permanent test set (V5 + bench20) never trained on.
usage: train_nemotron.py --manifest datasets/<id>.json --data-dir <dir> --out-dir <dir> [--max-steps 300 --lr 1e-5 --batch-size 8 --seed 42]
Runs in the NeMo venv (NeMo-Speech@cf724ac, see studies/2026-09-24-nemotron-bakeoff/requirements-freeze-*.txt)."""
import argparse, glob, hashlib, json, os, random, subprocess, sys, time

import numpy as np
import soundfile as sf
import torch

MAX_SPK = 8


def git_sha():
    env = os.environ.get("DIARLAB_GIT_SHA")
    if env: return env
    r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=os.path.dirname(os.path.abspath(__file__)), capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else "UNKNOWN"


def state_sha(sd):
    h = hashlib.sha256()
    for k in sorted(sd):
        h.update(k.encode()); h.update(sd[k].detach().cpu().float().numpy().tobytes())
    return h.hexdigest()


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()


def rttm_speakers(path):
    return len({l.split()[7] for l in open(path) if l.startswith("SPEAKER")})


def count_terms(preds, targets, tlens):
    """Per-item peak probabilities (masked) and the teacher count of the chunk: peaks [B,8], tgt [B]."""
    import torch
    fr = torch.arange(preds.shape[1], device=preds.device)[None, :] < tlens[:, None]
    peaks = (preds.float() * fr[:, :, None]).max(dim=1).values
    tgt = ((targets > 0.5) & fr[:, :, None]).any(dim=1).sum(-1).float()
    return peaks, tgt


def soft_count_loss(preds, targets, tlens, kind="soft", tau=0.1):
    """Variant C / C': L1 between a differentiable predicted speaker count and the teacher's count of the training chunk, per item, averaged.
    kind='soft'  : count = sum over the 8 output channels of the channel's PEAK probability (variant C).
    kind='sharp' : count = sum_k sigmoid((peak_k - 0.5) / tau), which tracks the thresholded readout (peak > 0.5) so sub-threshold 'leak' peaks over empty channels
                   do not stand in for a missing speaker (variant C', refuter #609); note its gradient vanishes for peaks far below 0.5.
    Gradient path: loss -> |count - tgt| -> peaks -> p at each channel's argmax frame -> logits -> encoder/head. Permutation-free (no channel matching)."""
    import torch
    peaks, tgt = count_terms(preds, targets, tlens)
    cnt = peaks.sum(-1) if kind == "soft" else torch.sigmoid((peaks - 0.5) / tau).sum(-1)
    return (cnt - tgt).abs().mean()


def install_count_loss(model, weight, kind="soft", tau=0.1, log_every=25):
    """Add weight * soft_count_loss to NeMo's own training loss by capturing the forward pass (no second forward). Off unless weight > 0.
    Also logs, on the TRAIN chunks (refuter #609, the soft-vs-hard loophole): mean soft count, mean HARD count (peak > 0.5), teacher count, and the sub-threshold
    mass (sum of peaks in (0.1, 0.5)); if the soft count reaches the teacher's while the hard count does not, the loss is being gamed."""
    cap, acc, curve = {}, {"n": 0, "soft": 0.0, "hard": 0.0, "tgt": 0.0, "sub": 0.0, "term": 0.0}, []
    fwd, step = model.forward, model.training_step
    def fwd_wrap(*a, **k):
        out = fwd(*a, **k); cap["out"] = out; return out
    def step_wrap(batch, batch_idx):
        res = step(batch, batch_idx)
        out = cap.pop("out"); preds = out[0] if isinstance(out, (tuple, list)) else out
        preds, targets, tlens = model._align_predictions_and_targets(preds, batch[2], batch[3])
        extra = weight * soft_count_loss(preds, targets, tlens, kind, tau)
        with __import__("torch").no_grad():
            peaks, tgt = count_terms(preds, targets, tlens)
            acc["n"] += 1; acc["term"] += float(extra); acc["soft"] += float(peaks.sum(-1).mean()); acc["hard"] += float((peaks > 0.5).sum(-1).float().mean())
            acc["tgt"] += float(tgt.mean()); acc["sub"] += float(((peaks > 0.1) & (peaks <= 0.5)).float().mul(peaks).sum(-1).mean())
        if acc["n"] % log_every == 0:
            curve.append({"batches": acc["n"], **{k: round(acc[k] / log_every, 4) for k in ("term", "soft", "hard", "tgt", "sub")}})
            for k in ("term", "soft", "hard", "tgt", "sub"): acc[k] = 0.0
        return {"loss": res["loss"] + extra}
    model.forward, model.training_step = fwd_wrap, step_wrap
    return {"curve": curve, "acc": acc}


B_INFO = {}


def _read_rttm(path):
    segs = []
    for l in open(path):
        p = l.split()
        if p and p[0] == "SPEAKER": segs.append((float(p[3]), float(p[3]) + float(p[4]), p[7]))
    return sorted(segs)


def crop_window(wid, rttm_path, wav_dur, out_dir, crop_len=180.0, gap_min=0.3, search=30.0, min_crop=45.0):
    """Variant B: split a window with > MAX_SPK teacher speakers into crops that each hold <= MAX_SPK. Boundaries are placed in silences (a gap of
    >= gap_min s in the merged speech of all speakers) nearest each nominal multiple of crop_len, within +-search s, so NO turn is ever split. Each crop
    gets its own RTTM: only the segments inside it, speakers re-indexed by first appearance (times stay absolute; the manifest offset/duration select the crop)."""
    segs = _read_rttm(rttm_path)
    merged = []
    for b, e, _ in segs:
        if merged and b <= merged[-1][1] + gap_min: merged[-1][1] = max(merged[-1][1], e)
        else: merged.append([b, e])
    gaps = [((merged[i][1] + merged[i + 1][0]) / 2) for i in range(len(merged) - 1) if merged[i + 1][0] - merged[i][1] >= gap_min]
    bounds, k = [0.0], 1
    while k * crop_len < wav_dur - min_crop:
        cand = [g for g in gaps if abs(g - k * crop_len) <= search and g > bounds[-1] + min_crop]
        if cand: bounds.append(min(cand, key=lambda g: abs(g - k * crop_len)))
        k += 1
    bounds.append(wav_dur)
    out, dropped = [], 0
    for i in range(len(bounds) - 1):
        lo, hi = bounds[i], bounds[i + 1]
        inside = [s for s in segs if s[0] >= lo and s[1] <= hi]
        interior = [x for x in (lo, hi) if 0 < x < wav_dur and x in bounds[1:-1]]
        assert not [s for s in segs for x in interior if s[0] < x < s[1]], "a turn crosses a crop boundary"
        if i == len(bounds) - 2: inside = [s for s in segs if s[0] >= lo]        # last crop: keep turns that run a few ms past the file end
        order = []
        for _, _, spk in inside:
            if spk not in order: order.append(spk)
        if not (2 <= len(order) <= MAX_SPK) or hi - lo < min_crop: dropped += 1; continue
        path = os.path.join(out_dir, f"{wid}__crop{i}.rttm")
        with open(path, "w") as f:
            for b, e, spk in inside: f.write(f"SPEAKER {wid}__crop{i} 1 {b:.3f} {e - b:.3f} <NA> <NA> SPK{order.index(spk)} <NA> <NA>\n")
        out.append({"offset": round(lo, 3), "duration": round(hi - lo, 3), "num_speakers": len(order), "rttm_filepath": path})
    return out, dropped


def build_nemo_manifests(manifest, data_dir, out_dir, crop_over8=False, balance_hist=None):
    holdout = None
    if not any(w["split"] == "val" for w in manifest["windows"]):
        rds = sorted({w["room_day_id"] for w in manifest["windows"] if w["split"] == "train"})
        if len(rds) >= 2: holdout = rds[-1]
    lines, skipped = {"train": [], "val": []}, []
    for w in manifest["windows"]:
        split = "val" if (holdout and w["room_day_id"] == holdout) else w["split"]
        if split not in lines: continue                                   # 'test' room-days stay untouched
        wav = os.path.join(data_dir, w["ist_date"], w["window_id"] + ".wav"); rt = wav[:-4] + ".rttm"
        if not (os.path.exists(wav) and os.path.exists(rt)):
            skipped.append((w["window_id"], "missing files")); continue
        n = rttm_speakers(rt)
        if n > MAX_SPK and crop_over8 and split == "train":
            crops, dropped = crop_window(w["window_id"], rt, sf.info(wav).duration, out_dir)
            B_INFO.setdefault("crops", []).append({"window_id": w["window_id"], "teacher_speakers": n, "crops_kept": len(crops), "crops_dropped": dropped, "crop_speakers": [c["num_speakers"] for c in crops]})
            for c in crops: lines[split].append({"audio_filepath": wav, **c, "_bucket_src": min(c["num_speakers"], 6)})
            continue
        if n > MAX_SPK or n == 0:
            skipped.append((w["window_id"], f"{n} speakers")); continue
        lines[split].append({"audio_filepath": wav, "offset": 0.0, "duration": round(sf.info(wav).duration, 3), "num_speakers": n, "rttm_filepath": rt, "_bucket_src": min(n, 6)})
    if balance_hist:        # variant B: oversample TRAIN entries toward a POPULATION target (never the test histogram); multiplicity in [1, 4]
        from collections import Counter
        tr = lines["train"]; c = Counter(r["_bucket_src"] for r in tr); tot = sum(c.values())
        tgt = {int(k): v for k, v in json.load(open(balance_hist))["hist_1_to_6plus"].items()}; tt = sum(tgt.values())
        mult = {b: max(1, min(4, round((tgt[b] / tt) / (c[b] / tot)))) if c[b] else 1 for b in range(1, 7)}
        B_INFO["balance"] = {"target_hist": tgt, "train_hist_before": {b: c[b] for b in range(1, 7)}, "multiplicity": mult, "entries_before": tot}
        lines["train"] = [r for r in tr for _ in range(mult[r["_bucket_src"]])]
        B_INFO["balance"]["entries_after"] = len(lines["train"]); B_INFO["balance"]["train_hist_after"] = dict(sorted(Counter(r["_bucket_src"] for r in lines["train"]).items()))
    for sp in lines:
        for r in lines[sp]: r.pop("_bucket_src", None)
    paths = {}
    for s, rows in lines.items():
        paths[s] = os.path.join(out_dir, f"nemo_{s}.jsonl")
        with open(paths[s], "w") as f:
            for r in rows: f.write(json.dumps(r) + "\n")
    return paths, len(lines["train"]), len(lines["val"]), holdout, skipped


V5_COUNTS = {"bw_yce79u6r_1789999200000_primary": 4, "bw_d4t5tvg9_1789986600000_primary": 7, "bw_maaacrdh_1790058600000_primary": 5,
             "bw_zyjykmwa_1790057700000_primary": 3, "bw_m6nq7upz_1790057700000_primary": 4}


def _parse_seg(seg):
    if isinstance(seg, str):
        p = seg.split(); return p[2]
    return str(seg[2])


def _parse_full(seg):
    if isinstance(seg, str):
        p = seg.split(); return float(p[0]), float(p[1]), p[2]
    return float(seg[0]), float(seg[1]), str(seg[2])


def rttm_segments(path):
    return [(b, e, spk) for b, e, spk in _read_rttm(path)]


def mean_der(hyp_segs_list, rttm_paths):
    """Mean per-window DER vs the teacher RTTM (pyannote.metrics, collar 0.25, overlap scored: the same DER every table in this study uses)."""
    from pyannote.core import Annotation, Segment
    from pyannote.metrics.diarization import DiarizationErrorRate
    def ann(segs):
        a = Annotation()
        for i, (b, e, spk) in enumerate(segs):
            if e > b: a[Segment(b, e), i] = spk
        return a
    ders = []
    for hyp, rt in zip(hyp_segs_list, rttm_paths):
        ders.append(DiarizationErrorRate(collar=0.25, skip_overlap=False)(ann(rttm_segments(rt)), ann(hyp)))
    return sum(ders) / len(ders)


class MinorWeightedBCE(__import__("torch").nn.Module):
    """Variant D loss: BCE whose POSITIVE frames of a minor speaker are up-weighted. Weight of speaker channel k of an item = clip((S_max / S_k)^gamma, 1, cap),
    S_k = active frames of k in the labels handed to the loss (so the weight follows the speaker through NeMo's permutation search), S_max = the item's largest S_k;
    negatives weight 1; mean over valid frames x channels. Brief speakers are kept as labelled; nothing is dropped or relabelled."""
    def __init__(self, gamma=0.5, cap=4.0):
        super().__init__(); self.gamma, self.cap = gamma, cap

    def forward(self, logits=None, probs=None, labels=None, target_lens=None):
        import torch, torch.nn.functional as F
        x = logits if logits is not None else probs
        fr = torch.arange(x.shape[1], device=x.device)[None, :] < target_lens[:, None]                  # [B, T]
        lab = labels.float() * fr[:, :, None]
        S = lab.sum(dim=1)                                                                               # [B, C] active frames per speaker
        w_spk = ((S.max(dim=1, keepdim=True).values / S.clamp(min=1.0)) ** self.gamma).clamp(1.0, self.cap)   # [B, C]
        w = 1.0 + (w_spk[:, None, :] - 1.0) * lab                                                        # positives only
        el = F.binary_cross_entropy_with_logits(x.float(), lab, reduction="none") if logits is not None else F.binary_cross_entropy(x.float().clamp(1e-7, 1 - 1e-7), lab, reduction="none")
        m = fr[:, :, None].float()
        return (el * w * m).sum() / (m.sum() * x.shape[-1]).clamp(min=1.0)


def make_count_callback(pl, val_items, v5_items, every, target, patience, val_rttms=None, select_metric="count"):
    """Speaker-COUNT scoring at every checkpoint (ruling 45). Selection/stopping uses the VAL windows' count error vs the teacher's
    count (held-out room-days, not the test set); V's 5 human counts are scored at every checkpoint for the record but never used to select
    or stop (selecting on them would make the permanent test set a tuning set)."""
    class CountEval(pl.Callback):
        def __init__(self):
            self.hist, self.best_val, self.best_step, self.best_sd, self.bad, self.last, self.stop_reason = [], None, None, None, 0, -1, None
            self.eval_seconds = 0.0

        def _run(self, m, paths):
            """Offline 30.4 s decode of each wav; returns a list of [(start_s, end_s, speaker)] per window."""
            sm = m.sortformer_modules
            old = (sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period)
            was = m.training; m.eval()
            try:
                sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period = 264, 40, 340, 40, 300
                m._check_streaming_parameters()
                out = [[_parse_full(x) for x in segs] for segs in m.diarize(audio=list(paths), batch_size=1, verbose=False)]
            finally:
                sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period = old
                m._check_streaming_parameters(); m.train(was)
            return out

        def _score(self, trainer, m):
            step = int(trainer.global_step)
            if step == self.last: return
            self.last = step; _t0 = time.time()
            vsegs = self._run(m, [p for p, _ in val_items]); vc = [len({x[2] for x in sg}) for sg in vsegs]
            v5 = [len({x[2] for x in sg}) for sg in self._run(m, [p for p, _ in v5_items])] if v5_items else []
            val_mae = sum(abs(c - t) for c, (_, t) in zip(vc, val_items)) / len(val_items)
            val_der = mean_der(vsegs, val_rttms) if val_rttms else None
            rec = {"step": step, "val_count_mae_vs_teacher": round(val_mae, 4), "val_count_bias": round(sum(c - t for c, (_, t) in zip(vc, val_items)) / len(val_items), 4),
                   "val_der_vs_teacher": round(val_der, 4) if val_der is not None else None,
                   "v5_count_mae_vs_V": round(sum(abs(c - t) for c, (_, t) in zip(v5, v5_items)) / len(v5_items), 4) if v5_items else None, "v5_counts": v5}
            self.hist.append(rec); print("# count-eval", json.dumps(rec), file=sys.stderr, flush=True)
            sel = val_der if select_metric == "der" else val_mae            # ruling 210 / PREREG-D: selection metric is DER in the D run, count otherwise
            if self.best_val is None or sel < self.best_val - 1e-9:
                self.best_val, self.best_step, self.bad = sel, step, 0
                self.best_sd = {k: v.detach().cpu().clone() for k, v in m.state_dict().items()}
            else:
                self.bad += 1
            if select_metric == "count" and val_mae <= target: self.stop_reason = f"val count MAE {val_mae:.3f} <= target {target} at step {step}"
            elif self.bad >= patience: self.stop_reason = f"no val-{select_metric} improvement for {patience} checks (best {self.best_val:.3f} at step {self.best_step})"
            if self.stop_reason: trainer.should_stop = True
            self.eval_seconds += time.time() - _t0

        def on_train_start(self, trainer, m): self._score(trainer, m)          # step 0 = the untuned base model

        def on_train_batch_end(self, trainer, m, outputs, batch, batch_idx):
            st = int(trainer.global_step)
            if st > 0 and st % every == 0: self._score(trainer, m)
    return CountEval()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True); ap.add_argument("--data-dir", required=True); ap.add_argument("--out-dir", required=True)
    ap.add_argument("--base-model", default="nvidia/Nemotron-3-Diarization")
    ap.add_argument("--nemo-path", default=None, help="local .nemo (default: HF cache/download of the base model)")
    ap.add_argument("--max-steps", type=int, default=300); ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--warmup-steps", type=int, default=20); ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--session-len-sec", type=int, default=105); ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--device", default="gpu")
    ap.add_argument("--val-audio-16k-dir", default=None, help="16 kHz mono <window_id>.wav for the manifest's val windows (enables count scoring)")
    ap.add_argument("--v5-audio-dir", default=None, help="16 kHz mono <window_id>.wav for V's 5 windows (count logged at every checkpoint, never used to select)")
    ap.add_argument("--count-every", type=int, default=50); ap.add_argument("--count-target", type=float, default=0.2)
    ap.add_argument("--count-patience", type=int, default=4)
    ap.add_argument("--crop-over8", action="store_true", help="variant B: crop windows with > 8 teacher speakers (train only) into <= 8-speaker crops at silences instead of skipping them")
    ap.add_argument("--balance-hist", default=None, help="variant B: JSON with hist_1_to_6plus of a POPULATION (all teacher-labelled production windows); oversample train toward it")
    ap.add_argument("--subsegment-nspk-bias", type=float, default=None, help="NeMo train_ds.subsegment_nspk_bias (sampling multiplier per active speaker; released config 1.5): larger favours chunks with more speakers (variant B2; see delivered_counts_probe.py)")
    ap.add_argument("--max-time", default=None, help="Lightning graceful wall-clock cap DD:HH:MM:SS (e.g. 00:03:00:00 = 3 h): training stops after the current step and the best checkpoint / run record are still written")
    ap.add_argument("--select-metric", choices=["count", "der"], default="count", help="checkpoint selection/stopping metric on VAL: count error vs teacher (default) or DER vs teacher (variant D, PREREG-D)")
    ap.add_argument("--minor-weighted-bce", action="store_true", help="variant D: replace NeMo's BCE with MinorWeightedBCE (positive frames of minor speakers up-weighted)")
    ap.add_argument("--minor-weight-gamma", type=float, default=0.5); ap.add_argument("--minor-weight-cap", type=float, default=4.0)
    ap.add_argument("--count-loss-weight", type=float, default=0.0, help="variant C/C': weight of the speaker-count loss (0 = off). Choose on VAL only.")
    ap.add_argument("--count-loss-kind", choices=["soft", "sharp"], default="soft", help="soft = sum of channel peaks (C); sharp = sum sigmoid((peak-0.5)/tau) (C')")
    ap.add_argument("--count-loss-tau", type=float, default=0.1)
    ap.add_argument("--precision", choices=["bf16-mixed", "16-mixed"], default="bf16-mixed", help="T4 (Turing) has no native bf16: use 16-mixed there. Default keeps every earlier run's behaviour.")
    ap.add_argument("--freeze-encoder", action="store_true", help="variant A (ruling 94): encoder frozen, head-only (sortformer_modules); proven by an encoder weights hash before/after and an optimizer param-group check")
    a = ap.parse_args()

    import lightning.pytorch as pl
    from lightning.pytorch import seed_everything
    from lightning.pytorch.callbacks import ModelCheckpoint
    from omegaconf import OmegaConf
    from nemo.collections.asr.models import SortformerEncLabelModel
    import importlib.metadata as md

    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    seed_everything(a.seed, workers=True); random.seed(a.seed); np.random.seed(a.seed); torch.manual_seed(a.seed)
    os.makedirs(a.out_dir, exist_ok=True)
    manifest = json.load(open(a.manifest))
    paths, n_train, n_val, holdout, skipped = build_nemo_manifests(manifest, a.data_dir, a.out_dir, a.crop_over8, a.balance_hist)
    print(f"# dataset_id={manifest['dataset_id']} train_n={n_train} val_n={n_val} holdout={holdout} skipped={len(skipped)}", file=sys.stderr)
    if not n_train: sys.exit("no materialized training windows: run build_dataset.py first")

    nemo_path = a.nemo_path
    base_rev = None
    if not nemo_path:
        from huggingface_hub import hf_hub_download, HfApi
        nemo_path = hf_hub_download(a.base_model, "Nemotron-3-Diarization.nemo")
        base_rev = os.path.basename(os.path.dirname(nemo_path))
    versions = {p: md.version(p) for p in ("torch", "lightning", "nemo-toolkit", "numpy") if p}
    run_id = f"run-{time.strftime('%Y-%m-%d-%H%M%S')}-nemotron-{manifest['dataset_id'][-8:]}"
    config = {"run_id": run_id, "trainer": "train_nemotron.py", "base_model": a.base_model, "base_model_snapshot": base_rev,
              "base_model_nemo_sha256": sha256_file(nemo_path), "dataset_id": manifest["dataset_id"], "train_n": n_train, "val_n": n_val,
              "val_holdout_room_day": holdout, "skipped_windows": skipped, "excluded_test_room_days": manifest.get("excluded_test_room_days"),
              "val_room_days": manifest.get("val_room_days"), "train_room_days": manifest.get("train_room_days"), "manifest_counts": manifest.get("counts"), "max_steps": a.max_steps, "lr": a.lr, "warmup_steps": a.warmup_steps,
              "batch_size": a.batch_size, "session_len_sec": a.session_len_sec, "seed": a.seed, "precision": a.precision,
              "nemo_speech_commit": os.environ.get("NEMO_SPEECH_COMMIT", "cf724ac337d1ebc7d0dda1e23fb80916f52927a5"),
              "git_sha": git_sha(), "env_versions": versions, "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    print("# config:", json.dumps(config), file=sys.stderr)

    error, best_path, best_score, last_nemo, best_nemo, metrics, freeze_proof = None, None, None, None, None, {}, None
    delivered = {"n_items": 0, "hist": {}, "sum": 0}; fit_stats = None; count_loss_stats = None
    try:
        model = SortformerEncLabelModel.restore_from(nemo_path, map_location="cpu")
        count_loss_stats = install_count_loss(model, a.count_loss_weight, a.count_loss_kind, a.count_loss_tau) if a.count_loss_weight > 0 else None
        if a.minor_weighted_bce: model.loss = MinorWeightedBCE(a.minor_weight_gamma, a.minor_weight_cap)
        freeze = None
        if a.freeze_encoder:
            enc_names = {n for n, _ in model.named_parameters() if n.startswith("encoder.")}
            head_params = [p for n, p in model.named_parameters() if n not in enc_names]
            freeze = {"encoder_sha_before": state_sha(model.encoder.state_dict()), "encoder_params": sum(p.numel() for n, p in model.named_parameters() if n in enc_names),
                      "head_params": sum(p.numel() for p in head_params), "head_param_ids": {id(p) for p in head_params}, "enc_param_ids": {id(p) for n, p in model.named_parameters() if n in enc_names}}
            for n, p in model.named_parameters():
                if n in enc_names: p.requires_grad_(False)
            model.setup_optimizer_param_groups = lambda: setattr(model, "_optimizer_param_groups", [{"params": head_params}])
        tr = OmegaConf.create(OmegaConf.to_container(model.cfg.train_ds, resolve=True))
        tr.manifest_filepath, tr.batch_size, tr.num_workers, tr.session_len_sec, tr.shuffle = paths["train"], a.batch_size, 0, a.session_len_sec, True
        if a.subsegment_nspk_bias is not None: tr.subsegment_nspk_bias = a.subsegment_nspk_bias
        va = OmegaConf.create(OmegaConf.to_container(model.cfg.validation_ds, resolve=True))
        va.manifest_filepath, va.batch_size, va.num_workers = paths["val"], 1, 0
        model.cfg.optim.lr = a.lr; model.cfg.lr = a.lr
        model.cfg.optim.sched.warmup_steps = a.warmup_steps; model.cfg.optim.sched.min_lr = min(1e-6, a.lr)
        ckpt_cb = None    # selection is by speaker-count error (CountEval), not loss/F1
        count_cb = None
        if a.val_audio_16k_dir:
            val_items, val_rttms = [], []
            for l in open(paths["val"]):
                r = json.loads(l); wid = os.path.basename(r["audio_filepath"])[:-4]
                val_items.append((os.path.join(a.val_audio_16k_dir, wid + ".wav"), r["num_speakers"])); val_rttms.append(r["rttm_filepath"])
            v5_items = [(os.path.join(a.v5_audio_dir, w + ".wav"), c) for w, c in V5_COUNTS.items()] if a.v5_audio_dir else []
            count_cb = make_count_callback(pl, val_items, v5_items, a.count_every, a.count_target, a.count_patience, val_rttms, a.select_metric)
        class DeliveredCounts(pl.Callback):      # refuter C1: what the dataloader ACTUALLY hands the model (random <=105 s chunks, inactive speakers dropped)
            def on_train_batch_start(self, tr, m, batch, batch_idx):
                if delivered["n_items"] >= 240: return
                _, _, targets, tlens, *_ = batch
                fr = torch.arange(targets.shape[1], device=targets.device)[None, :] < tlens[:, None]
                act = ((targets > 0.5) & fr[:, :, None]).any(dim=1).sum(-1).tolist()
                for c in act:
                    delivered["n_items"] += 1; delivered["sum"] += c; k = str(min(int(c), 6)); delivered["hist"][k] = delivered["hist"].get(k, 0) + 1
        cbs = [c for c in [count_cb] if c] + [DeliveredCounts()]
        if freeze is not None:
            class KeepEncoderEval(pl.Callback):     # frozen encoder = no dropout / stochastic depth either; Lightning and CountEval flip train mode
                def on_train_batch_start(self, tr, m, batch, batch_idx): m.encoder.eval()
            cbs.append(KeepEncoderEval())
        trainer = pl.Trainer(max_time=a.max_time, devices=1, accelerator=a.device, precision=a.precision, max_steps=a.max_steps, max_epochs=10000,
                             deterministic="warn", logger=False, enable_checkpointing=False, callbacks=cbs or None,
                             enable_progress_bar=False, log_every_n_steps=10, gradient_clip_val=1.0, check_val_every_n_epoch=4 if n_val else 1,
                             num_sanity_val_steps=0, limit_val_batches=1.0 if n_val else 0)
        model.set_trainer(trainer); model.setup_training_data(tr)
        if n_val: model.setup_validation_data(va)
        seed_everything(a.seed, workers=True)
        _t_fit = time.time(); torch.cuda.reset_peak_memory_stats() if torch.cuda.is_available() else None
        trainer.fit(model)
        fit_stats = {"fit_wall_seconds": round(time.time() - _t_fit, 1), "count_eval_seconds": round(count_cb.eval_seconds, 1) if count_cb else None,
                     "steps_run": int(trainer.global_step), "peak_gpu_mem_gb": round(torch.cuda.max_memory_allocated() / 1e9, 2) if torch.cuda.is_available() else None}
        fit_stats["train_seconds_per_step_excl_count_eval"] = round((fit_stats["fit_wall_seconds"] - (fit_stats["count_eval_seconds"] or 0)) / max(1, fit_stats["steps_run"]), 3)
        freeze_proof = None
        if freeze is not None:
            opt_ids = {id(p) for g in trainer.optimizers[0].param_groups for p in g["params"]}
            freeze_proof = {"encoder_sha256_before": freeze["encoder_sha_before"], "encoder_sha256_after": state_sha(model.encoder.state_dict()),
                            "encoder_params": freeze["encoder_params"], "head_params_trainable": freeze["head_params"],
                            "optimizer_param_count": sum(p.numel() for g in trainer.optimizers[0].param_groups for p in g["params"]),
                            "encoder_params_in_optimizer": len(opt_ids & freeze["enc_param_ids"]), "optimizer_only_head": opt_ids <= freeze["head_param_ids"],
                            "encoder_requires_grad_any": any(p.requires_grad for p in model.encoder.parameters())}
            freeze_proof["identical"] = freeze_proof["encoder_sha256_before"] == freeze_proof["encoder_sha256_after"]
            print("# freeze proof", json.dumps(freeze_proof), file=sys.stderr, flush=True)
            if not (freeze_proof["identical"] and freeze_proof["optimizer_only_head"] and not freeze_proof["encoder_requires_grad_any"]):
                raise RuntimeError("FREEZE PROOF FAILED: " + json.dumps(freeze_proof))
        metrics = {k: float(v) for k, v in trainer.callback_metrics.items() if torch.is_tensor(v) and v.numel() == 1}
        last_nemo = os.path.join(a.out_dir, f"{run_id}.nemo"); model.to("cpu").save_to(last_nemo)
        last_sha = state_sha(model.state_dict())
        if count_cb and count_cb.best_sd is not None:
            best_score = count_cb.best_val
            best_sha = state_sha(count_cb.best_sd); model.load_state_dict(count_cb.best_sd); best_nemo = os.path.join(a.out_dir, f"{run_id}-best.nemo"); model.save_to(best_nemo)
    except Exception as e:
        import traceback; error = f"{type(e).__name__}: {e}"; traceback.print_exc(file=sys.stderr)

    rec = {**config, "status": "OK" if error is None else "FAILED", "reason": error or "real run on the verified nightly dataset; quality judged only by held-out evaluation (V5 + bench20 vs pyannote.ai)",
           "metrics": metrics, "best_val_metric": ("val_der_vs_teacher" if a.select_metric == "der" else "val_count_mae_vs_teacher"), "select_metric": a.select_metric,
           "minor_weighted_bce": ({"gamma": a.minor_weight_gamma, "cap": a.minor_weight_cap} if a.minor_weighted_bce else None), "best_val_score": best_score,
           "best_step": count_cb.best_step if count_cb else None, "stop_reason": (count_cb.stop_reason or ("max_time (graceful cap)" if (a.max_time and fit_stats and fit_stats["steps_run"] < a.max_steps) else "max_steps")) if count_cb else None,
           "count_curve": count_cb.hist if count_cb else None, "variant": "+".join(x for x, on in (("A_head_only", a.freeze_encoder), ("B_crops", a.crop_over8), ("B_balanced", bool(a.balance_hist)), ("B2_nspk_bias", a.subsegment_nspk_bias is not None), ("C_count_loss_" + a.count_loss_kind, a.count_loss_weight > 0), ("D_minor_weighted_bce", a.minor_weighted_bce), ("D_select_der", a.select_metric == "der")) if on) or "full", "count_loss_weight": a.count_loss_weight, "count_loss_kind": a.count_loss_kind, "count_loss_tau": a.count_loss_tau,
           "count_loss_train_curve": (count_loss_stats["curve"] if count_loss_stats else None), "subsegment_nspk_bias": a.subsegment_nspk_bias, "fit_stats": fit_stats, "session_len_sec_used": a.session_len_sec, "freeze_proof": freeze_proof, "variant_B_info": B_INFO or None,
           "delivered_speaker_hist_first240": {"n_items": delivered["n_items"], "mean": round(delivered["sum"] / max(1, delivered["n_items"]), 3), "hist_1_to_6plus": dict(sorted(delivered["hist"].items()))}, "count_selection_note": ("best checkpoint = lowest val-window DER vs teacher (PREREG-D); val count error and V5 counts are logged per checkpoint but NOT used to select or stop" if a.select_metric == "der" else "best checkpoint = lowest val-window count error vs teacher; V5 counts and val DER are logged per checkpoint but NOT used to select or stop"), "max_time": a.max_time,
           "last_nemo_path": last_nemo, "last_nemo_sha256": sha256_file(last_nemo) if last_nemo else None, "last_weights_sha256": last_sha if last_nemo else None,
           "best_nemo_path": best_nemo, "best_nemo_sha256": sha256_file(best_nemo) if best_nemo else None, "best_weights_sha256": best_sha if best_nemo else None,
           "checkpoint_r2_key": None}
    runs = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "runs"); os.makedirs(runs, exist_ok=True)
    out = os.path.join(runs, f"{run_id}.json"); json.dump(rec, open(out, "w"), indent=1)
    print(f"# WROTE {out} (status={rec['status']})", file=sys.stderr)
    sys.exit(0 if error is None else 1)


if __name__ == "__main__":
    main()
