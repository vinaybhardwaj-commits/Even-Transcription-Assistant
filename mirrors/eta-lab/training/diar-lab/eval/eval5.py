#!/usr/bin/env python3
"""Evaluate a diar_run.py/diar_run4.py output against pyannote.ai reference segments
and V's speaker counts, for the 5 V-listen windows.
Metrics: speaker-count abs error vs V, and frame agreement vs pyannote.ai (optimal
one-to-one label mapping via brute-force permutation on the confusion matrix, since
speaker counts here are small, <=9). No audio or transcript text is used or printed.
"""
import json, sys, argparse
from itertools import permutations

from pyannote.core import Annotation, Segment
from pyannote.metrics.diarization import DiarizationErrorRate, JaccardErrorRate

FRAME_MS = 100

W2WID = {
    "w1.mp3": ("bw_yce79u6r_1789999200000_primary", 4),
    "w2.mp3": ("bw_d4t5tvg9_1789986600000_primary", 7),
    "w3.mp3": ("bw_maaacrdh_1790058600000_primary", 5),
    "w4.mp3": ("bw_zyjykmwa_1790057700000_primary", 3),
    "w5.mp3": ("bw_m6nq7upz_1790057700000_primary", 4),
}

def turns_to_frames(turns, n_frames):
    frames = [None] * n_frames
    for t in turns:
        f0 = t["start_ms"] // FRAME_MS
        f1 = min(n_frames, t["end_ms"] // FRAME_MS + 1)
        for f in range(max(0, f0), f1):
            frames[f] = t["speaker"]
    return frames

def best_frame_agreement(hyp_frames, ref_frames):
    hyp_labels = sorted(set(f for f in hyp_frames if f is not None))
    ref_labels = sorted(set(f for f in ref_frames if f is not None))
    n_both = sum(1 for h, r in zip(hyp_frames, ref_frames) if h is not None and r is not None)
    if n_both == 0 or not hyp_labels or not ref_labels:
        return None, n_both
    # confusion counts
    conf = {}
    for h, r in zip(hyp_frames, ref_frames):
        if h is None or r is None:
            continue
        conf[(h, r)] = conf.get((h, r), 0) + 1
    small, large = (hyp_labels, ref_labels) if len(hyp_labels) <= len(ref_labels) else (ref_labels, hyp_labels)
    swap = len(hyp_labels) > len(ref_labels)
    if len(large) <= 8:
        best = 0
        for perm in permutations(large, len(small)):
            total = 0
            for s, l in zip(small, perm):
                key = (l, s) if swap else (s, l)
                total += conf.get(key, 0)
            best = max(best, total)
    else:
        # greedy fallback for large label sets: repeatedly take the best remaining pair
        pairs = sorted(conf.items(), key=lambda kv: -kv[1])
        used_s, used_l = set(), set()
        best = 0
        for (a, b), cnt in pairs:
            s, l = (a, b) if not swap else (b, a)
            if s in used_s or l in used_l:
                continue
            used_s.add(s); used_l.add(l)
            best += cnt
    return best / n_both, n_both

def turns_to_annotation(turns):
    ann = Annotation()
    for t in turns:
        ann[Segment(t["start_ms"] / 1000, t["end_ms"] / 1000)] = t["speaker"]
    return ann

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hyp", required=True)
    ap.add_argument("--ref", default="/home/vinay/diar-lab/data/v5-pyannote-segments.json")
    args = ap.parse_args()

    with open(args.hyp) as f:
        hyp = json.load(f)
    with open(args.ref) as f:
        ref_all = json.load(f)

    der_metric = DiarizationErrorRate(collar=0.25, skip_overlap=False)
    jer_metric = JaccardErrorRate(collar=0.25)

    rows = []
    for w, (wid, v_count) in W2WID.items():
        if w not in hyp["windows"]:
            continue
        turns = hyp["windows"][w]["turns"]
        n_speakers = hyp["windows"][w]["n_speakers"]
        elapsed = hyp["windows"][w]["elapsed_sec"]
        ref_segs = ref_all.get(wid, [])
        ref_speaker_count = len(set(s["speaker"] for s in ref_segs))
        max_ms = max([t["end_ms"] for t in turns] + [s["end_ms"] for s in ref_segs] + [900_000])
        n_frames = max_ms // FRAME_MS + 1
        hyp_frames = turns_to_frames(turns, n_frames)
        ref_frames = turns_to_frames(ref_segs, n_frames)
        agreement, n_both = best_frame_agreement(hyp_frames, ref_frames)
        ref_ann = turns_to_annotation(ref_segs)
        hyp_ann = turns_to_annotation(turns)
        der = der_metric(ref_ann, hyp_ann)
        jer = jer_metric(ref_ann, hyp_ann)
        rows.append({
            "window": w, "window_id": wid,
            "v_count": v_count, "hyp_count": n_speakers, "pyannote_count": ref_speaker_count,
            "abs_err_vs_v": abs(n_speakers - v_count),
            "abs_err_vs_pyannote": abs(n_speakers - ref_speaker_count),
            "frame_agreement_vs_pyannote": round(agreement, 4) if agreement is not None else None,
            "der_vs_pyannote": round(der, 4), "jer_vs_pyannote": round(jer, 4),
            "elapsed_sec": elapsed,
        })
    print(json.dumps(rows, indent=1))
    if rows:
        mean_abs_err_v = sum(r["abs_err_vs_v"] for r in rows) / len(rows)
        aggs = [r["frame_agreement_vs_pyannote"] for r in rows if r["frame_agreement_vs_pyannote"] is not None]
        mean_agree = sum(aggs) / len(aggs) if aggs else None
        mean_der = sum(r["der_vs_pyannote"] for r in rows) / len(rows)
        mean_jer = sum(r["jer_vs_pyannote"] for r in rows) / len(rows)
        print(f"# mean_abs_speaker_count_err_vs_V={mean_abs_err_v:.2f} mean_frame_agreement_vs_pyannote={mean_agree} mean_der_vs_pyannote={mean_der:.4f} mean_jer_vs_pyannote={mean_jer:.4f}", file=sys.stderr)

if __name__ == "__main__":
    main()
