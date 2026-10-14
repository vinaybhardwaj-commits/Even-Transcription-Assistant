#!/usr/bin/env python3
"""
Cut 10s clips from disputed_spans.json's top spans (for H1 Whisper truth-check
+ the listening pack) plus N control clips (pyannote+Silero agree it's speech,
high confidence) from good windows. Clips stay local -- never pushed to a
public path; only counts/manifest go in git per the order's "not allowed".

Usage: python3 extract_clips.py --data-dir .../bake20 --spans disputed_spans.json \
    --ref-dir .../bake20-ref --probs-dir /home/eta/vad/work --out-dir clips
"""
import argparse, glob, json, os, wave
import numpy as np

FRAME_S = 512 / 16000.0
GOOD_WINDOWS_FOR_CONTROLS = ["bw_pwwnz89z", "bw_yce79u6r", "bw_j45jmzam"]


def write_clip(arr, sr, start_s, dur_s, out_path):
    i0 = int(start_s * sr)
    i1 = int((start_s + dur_s) * sr)
    seg = arr[i0:i1]
    pcm = (np.clip(seg, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def read_wav(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0, sr


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--ref-dir", required=True)
    ap.add_argument("--probs-dir", required=True)
    ap.add_argument("--spans", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--per-window", type=int, default=3)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    spans = json.load(open(args.spans))
    manifest = []

    for wid, info in spans.items():
        wav_files = glob.glob(os.path.join(args.data_dir, f"{wid}_*_primary.wav"))
        if not wav_files:
            print(f"SKIP {wid}: no wav")
            continue
        arr, sr = read_wav(wav_files[0])
        for k, sp in enumerate(info["top_spans"][:args.per_window]):
            dur = min(10.0, sp["dur_s"])
            out_name = f"{wid}_disputed_{k}.wav"
            write_clip(arr, sr, sp["start_s"], dur, os.path.join(args.out_dir, out_name))
            manifest.append({"clip": out_name, "wid": wid, "kind": "disputed",
                              "start_s": sp["start_s"], "dur_s": dur,
                              "silero_mean_prob": sp["mean_prob"]})
            print(f"wrote {out_name} ({dur:.1f}s, silero_prob={sp['mean_prob']:.3f})")

    # controls: middle of a solid pyannote+Silero-agree speech interval on 3 good windows
    n_controls = 0
    for wid in GOOD_WINDOWS_FOR_CONTROLS:
        wav_files = glob.glob(os.path.join(args.data_dir, f"{wid}_*_primary.wav"))
        ref_files = glob.glob(os.path.join(args.ref_dir, f"{wid}_*_pyannote.json"))
        probs_files = [f for f in glob.glob(os.path.join(args.probs_dir, f"{wid}_*_primary.probs.npy"))
                       if "SEQCHECK" not in f]
        if not (wav_files and ref_files and probs_files):
            continue
        arr, sr = read_wav(wav_files[0])
        probs = np.load(probs_files[0])
        ivs = pyannote_merged_intervals(ref_files[0])
        long_ivs = sorted(ivs, key=lambda iv: -(iv[1] - iv[0]))
        for s, e in long_ivs:
            f0, f1 = int(s / FRAME_S), int(e / FRAME_S)
            if f1 <= f0 or f1 > len(probs):
                continue
            if probs[f0:f1].mean() > 0.8 and (e - s) >= 10.0:
                mid = s + (e - s) / 2 - 5.0
                out_name = f"{wid}_control.wav"
                write_clip(arr, sr, mid, 10.0, os.path.join(args.out_dir, out_name))
                manifest.append({"clip": out_name, "wid": wid, "kind": "control",
                                  "start_s": round(mid, 2), "dur_s": 10.0,
                                  "silero_mean_prob": float(probs[f0:f1].mean())})
                print(f"wrote {out_name} (control, silero_prob={probs[f0:f1].mean():.3f})")
                n_controls += 1
                break

    json.dump(manifest, open(os.path.join(args.out_dir, "manifest.json"), "w"), indent=2)
    print(f"\n{len(manifest)} clips total ({n_controls} controls)")


if __name__ == "__main__":
    main()
