#!/usr/bin/env python3
"""Evaluate a diar_run20.py output against pyannote.ai reference (bake20-ref) for the
20-window bake-off set: DER, JER (collar 0.25s), speaker-count diff, frame agreement.
No audio or transcript text is used or printed.
"""
import json, sys, argparse, os
from itertools import permutations

from pyannote.core import Annotation, Segment
from pyannote.metrics.diarization import DiarizationErrorRate, JaccardErrorRate

FRAME_MS = 100
REF_DIR = os.path.expanduser(os.environ.get("DIARLAB_REF_DIR", "~/diar-lab/data/bake20-ref"))

def turns_to_annotation(turns):
    ann = Annotation()
    for t in turns:
        ann[Segment(t["start_ms"] / 1000, t["end_ms"] / 1000)] = t["speaker"]
    return ann

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
            total = sum(conf.get((l, s) if swap else (s, l), 0) for s, l in zip(small, perm))
            best = max(best, total)
    else:
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

def load_ref(window_id):
    with open(os.path.join(REF_DIR, f"{window_id}_pyannote.json")) as f:
        d = json.load(f)
    segs = d["output"]["diarization"]
    turns = [{"start_ms": round(s["start"] * 1000), "end_ms": round(s["end"] * 1000), "speaker": s["speaker"]} for s in segs]
    return turns

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hyp", required=True)
    args = ap.parse_args()

    with open(args.hyp) as f:
        hyp = json.load(f)

    der_metric = DiarizationErrorRate(collar=0.25, skip_overlap=False)
    jer_metric = JaccardErrorRate(collar=0.25)

    rows = []
    for window_id, w in hyp["windows"].items():
        try:
            ref_turns = load_ref(window_id)
        except FileNotFoundError:
            print(f"SKIP {window_id}: no reference", file=sys.stderr)
            continue
        hyp_turns = w["turns"]
        ref_ann = turns_to_annotation(ref_turns)
        hyp_ann = turns_to_annotation(hyp_turns)
        ref_count = len(ref_ann.labels())
        hyp_count = w["n_speakers"]

        der = der_metric(ref_ann, hyp_ann)
        jer = jer_metric(ref_ann, hyp_ann)

        max_ms = max([t["end_ms"] for t in hyp_turns] + [t["end_ms"] for t in ref_turns] + [1])
        n_frames = max_ms // FRAME_MS + 1
        hyp_frames = turns_to_frames(hyp_turns, n_frames)
        ref_frames = turns_to_frames(ref_turns, n_frames)
        agreement, n_both = best_frame_agreement(hyp_frames, ref_frames)

        rows.append({
            "window_id": window_id,
            "hyp_count": hyp_count, "pyannote_count": ref_count,
            "abs_speaker_count_diff": abs(hyp_count - ref_count),
            "der": round(der, 4), "jer": round(jer, 4),
            "frame_agreement": round(agreement, 4) if agreement is not None else None,
            "elapsed_sec": w.get("elapsed_sec"),
        })

    print(json.dumps(rows, indent=1))
    if rows:
        n = len(rows)
        mean_der = sum(r["der"] for r in rows) / n
        mean_jer = sum(r["jer"] for r in rows) / n
        mean_cnt_diff = sum(r["abs_speaker_count_diff"] for r in rows) / n
        aggs = [r["frame_agreement"] for r in rows if r["frame_agreement"] is not None]
        median_agree = sorted(aggs)[len(aggs) // 2] if aggs else None
        print(f"# n={n} mean_der={mean_der:.4f} mean_jer={mean_jer:.4f} mean_abs_speaker_count_diff={mean_cnt_diff:.2f} median_frame_agreement={median_agree}", file=sys.stderr)

if __name__ == "__main__":
    main()
