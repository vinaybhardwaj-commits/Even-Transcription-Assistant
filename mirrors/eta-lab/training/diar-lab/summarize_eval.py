#!/usr/bin/env python3
"""Score baseline (Arm A, stock 3.1) vs the fine-tuned checkpoint vs pyannote.ai on V's 5 + the 20 bench windows.
usage: summarize_eval.py <study_dir> <ft_v5.json> <ft_bake20.json> <run_id>"""
import json, os, statistics as st, subprocess, sys
study, ft5, ft20, run_id = sys.argv[1:5]
LAB = os.path.expanduser("~/eta-data/diar-lab"); EV = os.path.dirname(os.path.abspath(__file__)) + "/eval"
env = {**os.environ, "DIARLAB_REF_DIR": f"{LAB}/data/bake20-ref"}
def rows(script, hyp, extra=()):
    r = subprocess.run([sys.executable, f"{EV}/{script}", "--hyp", hyp, *extra], capture_output=True, text=True, env=env)
    return json.loads(r.stdout)
def s5(rs): return {"mean_DER": st.mean(r["der_vs_pyannote"] for r in rs), "mean_JER": st.mean(r["jer_vs_pyannote"] for r in rs),
                    "mean_frame_agree": st.mean(r["frame_agreement_vs_pyannote"] for r in rs),
                    "mean_abs_count_err_vs_V": st.mean(r["abs_err_vs_v"] for r in rs)}
def s20(rs):
    d = sorted(r["der"] for r in rs); ex = [x for x in d if x < 5]
    return {"median_DER": st.median(d), "mean_DER_excl_outlier": st.mean(ex), "median_JER": st.median(r["jer"] for r in rs),
            "median_frame_agree": st.median(r["frame_agreement"] for r in rs),
            "mean_abs_count_diff": st.mean(r["abs_speaker_count_diff"] for r in rs), "n": len(rs)}
ref5 = ["--ref", f"{LAB}/data/v5-pyannote-segments.json"]
res = {"baseline_A_stock_3.1": {"v5": s5(rows("eval5.py", f"{LAB}/out/armA_v5.json", ref5)), "bench20": s20(rows("eval20.py", f"{LAB}/out/armA_bake20.json"))},
       f"finetuned_{run_id}": {"v5": s5(rows("eval5.py", ft5, ref5)), "bench20": s20(rows("eval20.py", ft20))}}
os.makedirs(study, exist_ok=True); json.dump(res, open(f"{study}/results.json", "w"), indent=1)
b, f = res["baseline_A_stock_3.1"], res[f"finetuned_{run_id}"]
def line(name, k, sub):
    return f"| {name} | {b[sub][k]:.3f} | {f[sub][k]:.3f} | {f[sub][k]-b[sub][k]:+.3f} |"
md = [f"# First real segmentation fine-tune: `{run_id}` vs stock 3.1 (both scored against pyannote.ai)", "",
      "Reference = pyannote.ai precision-3 (strong, not ground truth); V's 5 speaker counts are the only human truth.", "",
      "| metric | stock 3.1 | fine-tuned | delta |", "|---|---|---|---|",
      line("V's 5: mean DER", "mean_DER", "v5"), line("V's 5: mean JER", "mean_JER", "v5"),
      line("V's 5: frame agreement", "mean_frame_agree", "v5"), line("V's 5: abs speaker-count err vs V", "mean_abs_count_err_vs_V", "v5"),
      line("bench20: median DER", "median_DER", "bench20"), line("bench20: mean DER excl. outlier", "mean_DER_excl_outlier", "bench20"),
      line("bench20: median JER", "median_JER", "bench20"), line("bench20: median frame agreement", "median_frame_agree", "bench20"),
      line("bench20: mean abs speaker-count diff", "mean_abs_count_diff", "bench20"), "",
      "Medians here are the standard median (mean of the two middle values; earlier Phase-1 notes used the upper-middle value, e.g. stock 0.232 vs 0.229 here). Lower is better for DER/JER/count error; higher for frame agreement. Target (order): within 3 DER points of pyannote.ai and no worse on V's 5."]
open(f"{study}/RESULTS.md", "w").write("\n".join(md) + "\n"); print("\n".join(md))
