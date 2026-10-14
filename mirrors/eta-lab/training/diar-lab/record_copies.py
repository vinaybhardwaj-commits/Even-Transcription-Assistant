#!/usr/bin/env python3
"""After a run: record BOTH copies (gcp-l4 original + box second copy) with sha256 in the run record.
usage: record_copies.py <run_record.json> <run_id> ; expects the run dir already rsynced to
/home/eta/eta-train/runs/<run_id>/ on this box. Fails loudly if a copy's hash differs from the original."""
import hashlib, json, os, sys
rec_path, run_id = sys.argv[1], sys.argv[2]
rec = json.load(open(rec_path))
box_dir = f"/home/eta/eta-train/runs/{run_id}"
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()
copies, ok = [], True
for label, path_key, sha_key in (("last", "checkpoint_path", "checkpoint_sha256"),
                                 ("best_val", "best_val_checkpoint_path", "best_val_checkpoint_sha256"),
                                 ("last_nemo", "last_nemo_path", "last_nemo_sha256"),
                                 ("best_nemo", "best_nemo_path", "best_nemo_sha256")):
    src, want = rec.get(path_key), rec.get(sha_key)
    if not src or not want: continue
    box_path = os.path.join(box_dir, os.path.basename(src))
    got = sha(box_path) if os.path.exists(box_path) else None
    good = got == want; ok &= good
    copies.append({"which": label,
                   "gcp-l4": {"path": src, "sha256": want},
                   "box(eta-lab-t4)": {"path": box_path, "sha256": got}, "identical": good})
rec["checkpoint_copies"] = copies
rec["checkpoint_r2_key"] = None  # eta-train bucket credentials are a daytime item
json.dump(rec, open(rec_path, "w"), indent=1)
print("copies verified" if ok else "COPY MISMATCH", file=sys.stderr)
sys.exit(0 if ok else 1)
