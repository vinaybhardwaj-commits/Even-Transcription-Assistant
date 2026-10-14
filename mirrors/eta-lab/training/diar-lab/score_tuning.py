#!/usr/bin/env python3
"""Score each heldout_<tag>.json (from tune_clustering.sh) against the held-out teacher RTTMs.
usage: score_tuning.py <tune_dir> <out_md>   (run with the venv that has pyannote.metrics)"""
import glob, json, os, statistics as st, subprocess, sys
d, out_md = sys.argv[1:3]
env = {**os.environ, "DIARLAB_REF_DIR": f"{d}/ref"}
EV = os.path.dirname(os.path.abspath(__file__)) + "/eval/eval20.py"
res = {}
for hyp in sorted(glob.glob(f"{d}/hyp/heldout_*.json")):
    tag = os.path.basename(hyp)[8:-5]
    r = subprocess.run([sys.executable, EV, "--hyp", hyp], capture_output=True, text=True, env=env)
    rows = json.loads(r.stdout)
    res[tag] = {"n": len(rows), "median_DER": st.median(x["der"] for x in rows), "mean_DER": st.mean(x["der"] for x in rows),
                "median_JER": st.median(x["jer"] for x in rows), "mean_abs_count_diff": st.mean(x["abs_speaker_count_diff"] for x in rows),
                "per_window_DER": {x["window_id"]: x["der"] for x in rows}}
json.dump(res, open(f"{d}/tuning_results.json", "w"), indent=1)
md = ["| config | n | mean DER | median DER | median JER | abs count diff |", "|---|---|---|---|---|---|"]
for t, v in sorted(res.items(), key=lambda kv: kv[1]["mean_DER"]):
    md.append(f"| {t} | {v['n']} | {v['mean_DER']:.3f} | {v['median_DER']:.3f} | {v['median_JER']:.3f} | {v['mean_abs_count_diff']:.2f} |")
open(out_md, "w").write("\n".join(md) + "\n"); print("\n".join(md))
