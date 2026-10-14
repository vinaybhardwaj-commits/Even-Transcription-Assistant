#!/usr/bin/env python3
"""
VAD-V3 -- find "pyannote.ai says speech, Silero says silence" disputed spans
on the 4 known outlier windows. Feeds H1 (Whisper truth check) and the
listening pack. No transcript/patient text -- span timestamps + durations only.

Silero probs cached as .npy, one prob per 512-sample (32ms) frame @16kHz, no
overlap (matches how vad/analyze.py computed them for VAD-v2).

Usage: python3 disputed_spans.py --probs-dir /home/eta/vad/work \
    --ref-dir /home/eta/eta-data/diar-lab/data/bake20-ref --out disputed_spans.json
"""
import argparse, glob, json, os
import numpy as np

FRAME_S = 512 / 16000.0  # 32ms
OUTLIERS = ["bw_jk5s2tfs", "bw_d5aype5r", "bw_wwq9p6eb", "bw_maaacrdh"]
SILERO_SILENCE_THRESH = 0.20  # "near-zero probability" per the order's own framing


def pyannote_merged_intervals(ref_path):
    d = json.load(open(ref_path))
    segs = d["output"]["diarization"]
    ivs = sorted((s["start"], s["end"]) for s in segs)
    merged = []
    for s, e in ivs:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def find_disputed(probs, pyannote_ivs):
    n = len(probs)
    is_speech_ref = np.zeros(n, dtype=bool)
    for s, e in pyannote_ivs:
        f0, f1 = int(s / FRAME_S), int(e / FRAME_S) + 1
        is_speech_ref[max(0, f0):min(n, f1)] = True
    silero_silent = probs < SILERO_SILENCE_THRESH
    disputed = is_speech_ref & silero_silent

    spans = []
    i = 0
    while i < n:
        if disputed[i]:
            j = i
            while j < n and disputed[j]:
                j += 1
            spans.append({"start_s": round(i * FRAME_S, 2), "end_s": round(j * FRAME_S, 2),
                          "dur_s": round((j - i) * FRAME_S, 2),
                          "mean_prob": float(probs[i:j].mean())})
            i = j
        else:
            i += 1
    return sorted(spans, key=lambda s: -s["dur_s"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probs-dir", required=True)
    ap.add_argument("--ref-dir", required=True)
    ap.add_argument("--out", default="disputed_spans.json")
    ap.add_argument("--min-dur", type=float, default=0.5)
    args = ap.parse_args()

    result = {}
    for wid in OUTLIERS:
        probs_files = glob.glob(os.path.join(args.probs_dir, f"{wid}_*_primary.probs.npy"))
        probs_files = [f for f in probs_files if "SEQCHECK" not in f]
        ref_files = glob.glob(os.path.join(args.ref_dir, f"{wid}_*_pyannote.json"))
        if not probs_files or not ref_files:
            print(f"SKIP {wid}: missing probs or ref")
            continue
        probs = np.load(probs_files[0])
        pyannote_ivs = pyannote_merged_intervals(ref_files[0])
        spans = find_disputed(probs, pyannote_ivs)
        spans = [s for s in spans if s["dur_s"] >= args.min_dur]
        total_pyannote_s = sum(e - s for s, e in pyannote_ivs)
        total_disputed_s = sum(s["dur_s"] for s in spans)
        result[wid] = {
            "n_spans_ge_min_dur": len(spans),
            "total_disputed_s": round(total_disputed_s, 1),
            "total_pyannote_speech_s": round(total_pyannote_s, 1),
            "pct_of_pyannote_speech_disputed": round(100 * total_disputed_s / total_pyannote_s, 1) if total_pyannote_s else 0,
            "top_spans": spans[:6],
        }
        print(f"{wid}: {len(spans)} spans >={args.min_dur}s, "
              f"{total_disputed_s:.1f}s disputed / {total_pyannote_s:.1f}s pyannote-speech "
              f"({result[wid]['pct_of_pyannote_speech_disputed']}%)")

    json.dump(result, open(args.out, "w"), indent=2)


if __name__ == "__main__":
    main()
