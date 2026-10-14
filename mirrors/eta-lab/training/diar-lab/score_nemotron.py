#!/usr/bin/env python3
"""Nemotron-3 bake-off scorer: arms vs pyannote.ai on V's 5 + bench20, DER with components (collar 0.25, overlap scored,
same as the phase-1 harness), speaker-count error, per-window DER, top-3 Nemotron-vs-pyannote.ai disagreements.
usage: score_nemotron.py <study_dir>  (venv with pyannote.metrics)   No audio/transcript text is read."""
import glob, json, os, statistics as st, sys
from pyannote.core import Annotation, Segment
from pyannote.metrics.diarization import DiarizationErrorRate

LAB = os.path.expanduser("~/eta-data/diar-lab"); STUDY = sys.argv[1]
NEM = os.path.expanduser("~/eta-data/nemotron"); FT = os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-diar-finetune")
V5 = {"w1.mp3": ("bw_yce79u6r_1789999200000_primary", 4), "w2.mp3": ("bw_d4t5tvg9_1789986600000_primary", 7),
      "w3.mp3": ("bw_maaacrdh_1790058600000_primary", 5), "w4.mp3": ("bw_zyjykmwa_1790057700000_primary", 3),
      "w5.mp3": ("bw_m6nq7upz_1790057700000_primary", 4)}
V_COUNT = {wid: c for wid, c in V5.values()}

def load_hyp(path, v5=False):
    d = json.load(open(path))["windows"]
    return {(V5[k][0] if v5 and k in V5 else k): v["turns"] for k, v in d.items()}

def ann(turns):
    a = Annotation()
    for i, t in enumerate(turns): a[Segment(t["start_ms"] / 1000, t["end_ms"] / 1000), i] = t["speaker"]
    return a

ref5 = json.load(open(f"{LAB}/data/v5-pyannote-segments.json"))
def ref_bench(wid):
    segs = json.load(open(f"{LAB}/data/bake20-ref/{wid}_pyannote.json"))["output"]["diarization"]
    return [{"start_ms": round(s["start"] * 1000), "end_ms": round(s["end"] * 1000), "speaker": s["speaker"]} for s in segs]
REF5 = {w: ref5[w] for w in V_COUNT}
REFB = {os.path.basename(p)[:-len("_pyannote.json")]: ref_bench(os.path.basename(p)[:-len("_pyannote.json")]) for p in glob.glob(f"{LAB}/data/bake20-ref/*_pyannote.json")}
OUTLIER = "bw_9j4z2ze3_1789989300000_primary"   # known teacher/hyp mismatch window (phase 1: DER~26 for every arm); excluded from bench means

ARMS = {
    "nemotron3": (f"{NEM}/out_v5_L4.json", f"{NEM}/out_bake20_L4.json", False),
    "local_stock_3.1": (f"{LAB}/out/armA_v5.json", f"{LAB}/out/armA_bake20.json", True),
    "local_finetuned": (f"{FT}/eval_v5.json", f"{FT}/eval_bake20.json", True),
}
def score(hyp, REF):
    rows = {}
    for wid, turns in hyp.items():
        if wid not in REF: continue
        m = DiarizationErrorRate(collar=0.25, skip_overlap=False)
        det = m.compute_components(ann(REF[wid]), ann(turns)); tot = det["total"] or 1.0
        rows[wid] = {"der": (det["missed detection"] + det["false alarm"] + det["confusion"]) / tot,
                     "miss": det["missed detection"] / tot, "fa": det["false alarm"] / tot, "conf": det["confusion"] / tot,
                     "n_hyp": len({t["speaker"] for t in turns}), "n_ref": len({t["speaker"] for t in REF[wid]})}
    return rows
if len(sys.argv) > 2:   # optional fine-tuned Nemotron arm: <tag> -> $STUDY/<tag>_v5.json, $STUDY/<tag>_bake20.json
    ARMS["nemotron_finetuned:" + sys.argv[2]] = (f"{STUDY}/{sys.argv[2]}_v5.json", f"{STUDY}/{sys.argv[2]}_bake20.json", False)
PROD = json.load(open(os.path.expanduser("~/dev/eta-lab/datasets/production-count-hist-2026-09-24.json")))["hist_1_to_6plus"]
def prod_weighted(rows20):
    """Post-stratify bench20 (excl. outlier) to PRODUCTION's teacher-count shares (bench20 has 3.6x the 6+ share and no 1-speaker windows): mean of per-bucket
    means, buckets weighted by production share renormalised over the buckets that have bench windows (bucket 1 is empty, so it is not represented)."""
    by = {}
    for r in rows20.values(): by.setdefault(min(r["n_ref"], 6), []).append(r)
    tot = sum(int(PROD[str(b)]) for b in by)
    w = {b: int(PROD[str(b)]) / tot for b in by}
    return {"b20_prodweighted_count_err_vs_pya": sum(w[b] * st.mean(abs(x["n_hyp"] - x["n_ref"]) for x in v) for b, v in by.items()),
            "b20_prodweighted_DER": sum(w[b] * st.mean(x["der"] for x in v) for b, v in by.items()),
            "b20_prodweighted_buckets": {b: len(v) for b, v in sorted(by.items())}}
per5, per20, agg = {}, {}, {}
for arm, (f5, f20, w) in ARMS.items():
    r5, r20 = score(load_hyp(f5, w), REF5), score(load_hyp(f20), REFB)
    per5[arm], per20[arm] = r5, r20
    b = {i: r for i, r in r20.items() if i != OUTLIER}
    M = lambda rows, k: st.mean(r[k] for r in rows.values())
    agg[arm] = {"v5_n": len(r5), "v5_mean_DER": M(r5, "der"), "v5_miss": M(r5, "miss"), "v5_fa": M(r5, "fa"), "v5_conf": M(r5, "conf"),
                "v5_count_err_vs_V": st.mean(abs(r5[i]["n_hyp"] - V_COUNT[i]) for i in r5),
                "b20_n_excl_outlier": len(b), "b20_median_DER": st.median(r["der"] for r in b.values()), "b20_mean_DER": M(b, "der"),
                "b20_miss": M(b, "miss"), "b20_fa": M(b, "fa"), "b20_conf": M(b, "conf"),
                "b20_count_err_vs_pya": st.mean(abs(r["n_hyp"] - r["n_ref"]) for r in b.values()),
                "outlier_DER": r20.get(OUTLIER, {}).get("der"), **prod_weighted(b)}
agg["pyannote.ai(teacher)"] = {"v5_count_err_vs_V": st.mean(abs(len({s["speaker"] for s in REF5[i]}) - V_COUNT[i]) for i in V_COUNT), "DER_vs_self": 0.0}
nem = {i: r for i, r in per20["nemotron3"].items() if i != OUTLIER}; worst = sorted(nem, key=lambda w: -nem[w]["der"])[:3]
out = {"agg": agg, "per_window_v5": per5, "per_window_bench20": per20, "top3_disagree_nemotron_vs_pyannoteai": [{"window_id": w, **nem[w]} for w in worst],
       "note": "bench20 means exclude " + OUTLIER + "; V5 windows are also inside the 20-window bench (scored there vs bake20-ref, and here vs the V5 pyannote.ai run)"}
os.makedirs(STUDY, exist_ok=True); json.dump(out, open(f"{STUDY}/nemotron_results.json", "w"), indent=1)
for a, v in agg.items(): print(a, {k: (round(x, 3) if isinstance(x, float) else x) for k, x in v.items()})
print("v5 per-window DER:", json.dumps({a: {w[3:11]: round(r['der'], 3) for w, r in per5[a].items()} for a in per5}))
print("top3:", [(w, round(nem[w]['der'], 3)) for w in worst])
