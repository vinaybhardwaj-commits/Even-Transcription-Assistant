#!/usr/bin/env python3
"""No-training probe (refuter C1 follow-up): what speaker counts does the training dataloader actually deliver under different sampling settings?
Builds the train manifest (with crops, no oversampling) from a dataset manifest, restores the base model on CPU only to reuse NeMo's own train dataset
class, iterates ~240 items per setting and prints the histogram of ACTIVE speakers per item next to the teacher counts of the entries.
usage (box, NeMo venv): delivered_counts_probe.py <dataset_manifest.json> <out.json>"""
import json, os, sys, tempfile, time
import torch
from omegaconf import OmegaConf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import train_nemotron as t
from nemo.collections.asr.models import SortformerEncLabelModel
from huggingface_hub import hf_hub_download

man = json.load(open(sys.argv[1])); tmp = tempfile.mkdtemp(prefix="dcp-")
paths, n_train, n_val, _, skipped = t.build_nemo_manifests(man, os.path.expanduser("~/eta-data/diar-train"), tmp, crop_over8=True)
entries = [json.loads(l) for l in open(paths["train"])]
ent_hist = {}
for e in entries: k = str(min(e["num_speakers"], 6)); ent_hist[k] = ent_hist.get(k, 0) + 1
print("train entries", len(entries), "teacher-count hist of entries", dict(sorted(ent_hist.items())), "mean", round(sum(e["num_speakers"] for e in entries) / len(entries), 2), flush=True)
model = SortformerEncLabelModel.restore_from(hf_hub_download("nvidia/Nemotron-3-Diarization", "Nemotron-3-Diarization.nemo"), map_location="cpu")
SETTINGS = [(105, 1.5), (105, 4.0), (300, 1.5), (300, 4.0), (600, 1.5)]
out = {"entries_hist": ent_hist, "entries_mean": sum(e["num_speakers"] for e in entries) / len(entries), "settings": {}}
for sess, bias in SETTINGS:
    torch.manual_seed(42)
    cfg = OmegaConf.create(OmegaConf.to_container(model.cfg.train_ds, resolve=True))
    cfg.manifest_filepath, cfg.batch_size, cfg.num_workers, cfg.session_len_sec, cfg.subsegment_nspk_bias, cfg.shuffle = paths["train"], 4, 0, sess, bias, True
    model.setup_training_data(cfg); dl = model._train_dl
    hist, n, s, t0 = {}, 0, 0, time.time()
    for batch in dl:
        _, _, targets, tlens, *_ = batch
        fr = torch.arange(targets.shape[1])[None, :] < tlens[:, None]
        for c in ((targets > 0.5) & fr[:, :, None]).any(dim=1).sum(-1).tolist():
            k = str(min(int(c), 6)); hist[k] = hist.get(k, 0) + 1; n += 1; s += c
        if n >= 240: break
    out["settings"][f"session{sess}_bias{bias}"] = {"n_items": n, "mean_active_speakers": round(s / max(1, n), 3), "hist_0_to_6plus": dict(sorted(hist.items()))}
    print(f"session_len {sess}s nspk_bias {bias}: items {n} mean {s / max(1, n):.2f} hist {dict(sorted(hist.items()))} ({time.time() - t0:.0f}s)", flush=True)
json.dump(out, open(sys.argv[2], "w"), indent=1)
