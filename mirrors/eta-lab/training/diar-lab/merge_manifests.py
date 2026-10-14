#!/usr/bin/env python3
"""Merge every real nightly-export manifest (datasets/diar-train-<date>-<id>.json) into one
training dataset manifest. Excludes the hand-built smoke manifest and vad-v3 test set. Dedupes by
label_id. The merged id is derived from the sorted label ids, so the same inputs always give the
same dataset id (repeatable). Prints the written path on stdout."""
import glob, hashlib, json, os, sys, time

DATASETS = os.path.expanduser("~/dev/eta-lab/datasets")
files = sorted(f for f in glob.glob(os.path.join(DATASETS, "diar-train-2026-*.json"))
               if "smoke" not in f and "merged" not in f)
by_label = {}
for f in files:
    for w in json.load(open(f))["windows"]:
        by_label.setdefault(w["label_id"], w)
# Fail closed: only windows whose wav+rttm on THIS box hash-match their manifest entry are trained on.
# (Manifests built elsewhere -- e.g. another pane's box -- can carry hashes we cannot reproduce.)
ROOT = os.path.expanduser(os.environ.get("DIARLAB_VERIFY_ROOT", "~/eta-data/diar-train"))
def _sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.exists(p) else None
windows, excluded = [], []
for k in sorted(by_label):
    w = by_label[k]
    base = os.path.join(ROOT, w["ist_date"], w["window_id"])
    if _sha(base + ".wav") == w["audio_sha256"] and _sha(base + ".rttm") == w["rttm_sha256"]:
        windows.append(w)
    else:
        excluded.append({"window_id": w["window_id"], "label_id": k})
        print(f"EXCLUDED (hash not verifiable on this box): {w['window_id']}", file=sys.stderr)
by_label = {w["label_id"]: w for w in windows}
if not windows:
    sys.exit("no windows to merge")
h = hashlib.sha256("\n".join(sorted(by_label)).encode()).hexdigest()[:8]
dataset_id = f"diar-train-merged-{time.strftime('%Y-%m-%d')}-{h}"
out = os.path.join(DATASETS, f"{dataset_id}.json")
json.dump({"dataset_id": dataset_id, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "source_manifests": [os.path.basename(f) for f in files],
           "excluded_unverified": excluded, "windows": windows}, open(out, "w"), indent=1)
print(out)
