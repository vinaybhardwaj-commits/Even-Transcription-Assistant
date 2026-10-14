#!/usr/bin/env python3
"""
VAD-V3, H3 -- "Silero needs preprocessing". Re-run Silero on the 20 bake
windows after: high-pass 80Hz, loudness-normalize (RMS-based proxy for -23
LUFS), denoise (spectral-gating via noisereduce, a fast proxy for
DeepFilterNet3/RNNoise), and combinations. Scores each variant against the
pyannote.ai teacher the same way as VAD-v2's run_ab.py/run_c.py.

Usage: python3 h3_preprocessing.py --data-dir DATA_DIR --ref-dir REF_DIR \
    --log-file LOG --out h3_results.json
"""
import argparse, json, os, time, wave
import numpy as np
from scipy.signal import butter, sosfiltfilt

SR = 16000



def _dur(path):
    with wave.open(path, "rb") as _w:
        return _w.getnframes() / _w.getframerate()


def log(msg, log_file):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    print(line, flush=True)
    if log_file:
        with open(log_file, "a") as fh:
            fh.write(line + "\n")


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


def cut_stats(pyannote_ivs, keep_ivs):
    total = sum(e - s for s, e in pyannote_ivs)
    if total == 0:
        return 0.0, 0.0
    cut = 0.0
    for ps, pe in pyannote_ivs:
        covered = 0.0
        for ss, se in keep_ivs:
            if se <= ps:
                continue
            if ss >= pe:
                break
            covered += max(0.0, min(pe, se) - max(ps, ss))
        cut += max(0.0, (pe - ps) - covered)
    return cut, total


def highpass_80hz(arr):
    sos = butter(4, 80, btype="highpass", fs=SR, output="sos")
    return sosfiltfilt(sos, arr).astype("float32")


def loudness_normalize(arr, target_rms=0.1):
    rms = np.sqrt(np.mean(arr ** 2) + 1e-12)
    if rms < 1e-6:
        return arr
    gain = target_rms / rms
    return np.clip(arr * gain, -1.0, 1.0).astype("float32")


def denoise(arr):
    import noisereduce as nr
    return nr.reduce_noise(y=arr, sr=SR, stationary=False).astype("float32")


def silero_intervals(arr, model, get_ts):
    import torch
    t = torch.from_numpy(arr)
    ts = get_ts(t, model, threshold=0.15, sampling_rate=SR,
                min_silence_duration_ms=1200, speech_pad_ms=500)
    return [(s["start"] / SR, s["end"] / SR) for s in ts]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--ref-dir", required=True)
    ap.add_argument("--log-file", default=None)
    ap.add_argument("--out", default="h3_results.json")
    ap.add_argument("--variants", default=None, help="comma list; default all")
    args = ap.parse_args()

    import torch
    torch.set_num_threads(1)
    from silero_vad import load_silero_vad, get_speech_timestamps
    model = load_silero_vad()

    variants = {
        "baseline": lambda a: a,
        "highpass80": highpass_80hz,
        "loudnorm": loudness_normalize,
        "denoise": denoise,
        "highpass+loudnorm": lambda a: loudness_normalize(highpass_80hz(a)),
        "highpass+denoise": lambda a: denoise(highpass_80hz(a)),
        "all3": lambda a: loudness_normalize(denoise(highpass_80hz(a))),
    }

    if args.variants:
        variants = {k: v for k, v in variants.items() if k in args.variants.split(",")}
    data_dir = os.path.abspath(args.data_dir)
    ref_dir = os.path.abspath(args.ref_dir)
    files = sorted(f for f in os.listdir(data_dir) if f.endswith(".wav"))
    log(f"{len(files)} windows x {len(variants)} variants", args.log_file)

    results = {v: [] for v in variants}
    for i, f in enumerate(files):
        wid = f[:-4]  # full stem: windows in the same room share a 2-token prefix
        arr, sr = read_wav(os.path.join(data_dir, f))
        ref_files = [r for r in os.listdir(ref_dir) if r.startswith(wid + "_") and r.endswith("_pyannote.json")]
        if not ref_files:
            continue
        pyannote_ivs = pyannote_merged_intervals(os.path.join(ref_dir, ref_files[0]))
        for vname, vfn in variants.items():
            t0 = time.time()
            try:
                proc = vfn(arr)
                ivs = silero_intervals(proc, model, get_speech_timestamps)
            except Exception as e:
                log(f"  {vname} FAILED on {wid}: {e}", args.log_file)
                continue
            cut, total = cut_stats(pyannote_ivs, ivs)
            sent = sum(e - s for s, e in ivs)
            cut_pct = cut / total * 100 if total else 0.0
            results[vname].append({"wid": wid, "cut_pct": cut_pct, "sent_s": sent, "total_s": total, "dur_s": _dur(os.path.join(data_dir, f))})
        log(f"[{i+1}/{len(files)}] {wid} done ({time.time()-t0:.1f}s/variant last)", args.log_file)

    summary = {}
    for vname, rows in results.items():
        if not rows:
            continue
        tot_c = sum(r["cut_pct"] / 100 * r["total_s"] for r in rows)
        tot_p = sum(r["total_s"] for r in rows)
        tot_s = sum(r["sent_s"] for r in rows)
        worst = max(rows, key=lambda r: r["cut_pct"])
        summary[vname] = {
            "overall_cut_pct": round(tot_c / tot_p * 100, 2) if tot_p else 0,
            "worst_window": worst["wid"], "worst_cut_pct": round(worst["cut_pct"], 2),
            "avg_sent_pct": round(tot_s / sum(r["dur_s"] for r in rows) * 100, 1),
            "all_le_2pct": all(r["cut_pct"] <= 2.0 for r in rows),
            "n_windows_over_2pct": sum(1 for r in rows if r["cut_pct"] > 2.0),
        }
    json.dump({"rows": results, "summary": summary}, open(args.out, "w"), indent=2)
    log(f"H3 SUMMARY: {json.dumps(summary, indent=2)}", args.log_file)


if __name__ == "__main__":
    main()
