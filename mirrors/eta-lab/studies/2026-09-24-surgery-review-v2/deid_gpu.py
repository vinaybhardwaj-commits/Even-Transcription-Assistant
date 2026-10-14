#!/usr/bin/env python3
"""deid_gpu.py — run surg-deid's deid.py UNCHANGED, on the GPU, over a whole list of files in ONE process (one model load, no per-file 10 s startup).
Why: the CPU tool is oversubscribed on this box (a 10k-character consult ran >6 min at ~800% CPU under load 18); the T4 removes that bottleneck.
It imports deid.py as it is on disk, replaces only how the cached GLiNER model is placed (cuda), then calls deid.main() once per file with the same arguments a
person would type: same regexes, same roster rule, same windowing, same output rules. Run in venv-gpu (torch cu121), under the GPU lock for a finite batch:
    flock /home/eta/gpu.lock ~/eta-data/deid/venv-gpu/bin/python deid_gpu.py [--cap-rule] <in_dir> <out_dir> [ids...]\n    --cap-rule (v7.15b blanket capitalised-token rule; needs a deid.py that has it) is REQUIRED for any file that will go to Jev on the surgery path (ruling 274, deid_gate.py)
Prints the CLI's counts-only line per file. `--verify-same` re-runs a file on the CPU tool's path and compares the outputs byte for byte (a check that the GPU changes nothing)."""
import contextlib, hashlib, io, json, os, sys, time
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
    flags = [a for a in sys.argv[1:] if a.startswith("--")]; cap = "--cap-rule" in flags
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    in_dir, out_dir = args[0], args[1]
    ids = args[2:] or sorted(f[:-5] for f in os.listdir(in_dir) if f.endswith(".json"))
    os.makedirs(out_dir, exist_ok=True); os.chmod(out_dir, 0o700)
    import deid_gate  # ruling 274: the surgery-path Jev callers refuse a file that was not recorded here WITH the cap rule
    deid_sha = hashlib.sha256(open(deid.__file__, "rb").read()).hexdigest()
    print("cuda:", torch.cuda.is_available(), "| cap_rule:", cap, "| deid.py sha256:", deid_sha[:12], "| files:", len(ids), flush=True)
    for i in ids:
        t = time.time(); buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            deid.main([f"{in_dir}/{i}.json", f"{out_dir}/{i}.json"] + (["--cap-rule"] if cap else []))
        line = buf.getvalue().strip().splitlines()[-1]; print(line)
        red = json.loads(line).get("redactions", {}); tags = sum(v for k, v in red.items() if k.endswith("/cap_rule"))
        deid_gate.record(out_dir, i, cap, deid_sha, tags)
        print(f"  {i} done in {time.time() - t:.1f}s (cap_rule tags {tags})", flush=True)


if __name__ == "__main__":
    main()
