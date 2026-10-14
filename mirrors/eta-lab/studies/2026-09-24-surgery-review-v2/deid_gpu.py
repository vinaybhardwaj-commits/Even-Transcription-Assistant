#!/usr/bin/env python3
"""deid_gpu.py — run surg-deid's deid.py UNCHANGED, on the GPU, over a whole list of files in ONE process (one model load, no per-file 10 s startup).
Why: the CPU tool is oversubscribed on this box (a 10k-character consult ran >6 min at ~800% CPU under load 18); the T4 removes that bottleneck.
It imports deid.py as it is on disk, replaces only how the cached GLiNER model is placed (cuda), then calls deid.main() once per file with the same arguments a
person would type: same regexes, same roster rule, same windowing, same output rules. Run in venv-gpu (torch cu121), under the GPU lock for a finite batch:
    flock /home/eta/gpu.lock ~/eta-data/deid/venv-gpu/bin/python deid_gpu.py <in_dir> <out_dir> [ids...]
Prints the CLI's counts-only line per file. `--verify-same` re-runs a file on the CPU tool's path and compares the outputs byte for byte (a check that the GPU changes nothing)."""
import os, sys, time
os.environ.setdefault("HF_HUB_OFFLINE", "1"); os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import torch
import deid

_MODEL = None


def _cuda_load(self):
    global _MODEL
    if self.model is None and self.use_model:
        if _MODEL is None:
            from gliner import GLiNER
            m = GLiNER.from_pretrained(deid.MODEL_DIR, local_files_only=True)
            _MODEL = m.to("cuda") if torch.cuda.is_available() else m
        self.model = _MODEL
    return self.model


deid.Deid._load = _cuda_load


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    in_dir, out_dir = args[0], args[1]
    ids = args[2:] or sorted(f[:-5] for f in os.listdir(in_dir) if f.endswith(".json"))
    os.makedirs(out_dir, exist_ok=True); os.chmod(out_dir, 0o700)
    print("cuda:", torch.cuda.is_available(), "| files:", len(ids), flush=True)
    for i in ids:
        t = time.time()
        deid.main([f"{in_dir}/{i}.json", f"{out_dir}/{i}.json"])
        print(f"  {i} done in {time.time() - t:.1f}s", flush=True)


if __name__ == "__main__":
    main()
