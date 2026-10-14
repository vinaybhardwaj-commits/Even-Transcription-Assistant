#!/usr/bin/env python3
"""
VAD-V3 padding/threshold sweep for Silero (baseline, no preprocessing --
H3's preprocessing variants are handled separately). Grid over threshold x
min_silence_duration_ms x speech_pad_ms, scored against pyannote.ai teacher.

Usage: python3 run_silero_grid.py --data-dir DATA_DIR --ref-dir REF_DIR \
    --log-file LOG --out results.json
"""
import argparse, itertools, json, os, time, wave
from multiprocessing import Pool
import numpy as np

GRID = {
    "threshold": [0.10, 0.15, 0.20, 0.30],
    "min_silence_duration_ms": [500, 1200, 2000],
    "speech_pad_ms": [300, 500, 800],
}


def log(msg, log_file):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    print(line, flush=True)
    if log_file:
        with open(log_file, "a") as fh:
            fh.write(line + "\n")


def read_wav_int16(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).copy(), sr


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


_WINDOWS = None
_MODEL = None


def _worker_init(data_dir, ref_dir):
    global _WINDOWS, _MODEL
    import torch
    torch.set_num_threads(1)
    from silero_vad import load_silero_vad
    _MODEL = load_silero_vad()
    files = sorted(f for f in os.listdir(data_dir) if f.endswith(".wav"))
    _WINDOWS = []
    for f in files:
        wid = f[:-4]  # full stem: windows in the same room share a 2-token prefix
        arr_i16, sr = read_wav_int16(os.path.join(data_dir, f))
        ref_files = [r for r in os.listdir(ref_dir) if r.startswith(wid + "_") and r.endswith("_pyannote.json")]
        if not ref_files:
            continue
        pyannote_ivs = pyannote_merged_intervals(os.path.join(ref_dir, ref_files[0]))
        # keep int16 in memory (half the footprint of float32) -- convert per-call below
        _WINDOWS.append((wid, arr_i16, pyannote_ivs))


def _worker_combo(combo):
    import torch
    from silero_vad import get_speech_timestamps
    thresh, min_sil, pad = combo
    t0 = time.time()
    rows = []
    for wid, arr_i16, pyannote_ivs in _WINDOWS:
        t = torch.from_numpy(arr_i16.astype("float32") / 32768.0)
        ts = get_speech_timestamps(t, _MODEL, threshold=thresh, sampling_rate=16000,
                                    min_silence_duration_ms=min_sil, speech_pad_ms=pad)
        ivs = [(s["start"] / 16000, s["end"] / 16000) for s in ts]
        cut, total = cut_stats(pyannote_ivs, ivs)
        sent = sum(e - s for s, e in ivs)
        rows.append({"wid": wid, "cut_pct": cut / total * 100 if total else 0,
                     "sent_s": sent, "total_s": total})
    tot_c = sum(r["cut_pct"] / 100 * r["total_s"] for r in rows)
    tot_p = sum(r["total_s"] for r in rows)
    tot_s = sum(r["sent_s"] for r in rows)
    worst = max(rows, key=lambda r: r["cut_pct"])
    return {
        "threshold": thresh, "min_silence_duration_ms": min_sil, "speech_pad_ms": pad,
        "overall_cut_pct": round(tot_c / tot_p * 100, 2) if tot_p else 0,
        "worst_window": worst["wid"], "worst_cut_pct": round(worst["cut_pct"], 2),
        "avg_sent_pct": round(tot_s / (len(rows) * 1800) * 100, 1),
        "all_le_2pct": all(r["cut_pct"] <= 2.0 for r in rows),
        "elapsed_s": round(time.time() - t0, 1),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--ref-dir", required=True)
    ap.add_argument("--log-file", default=None)
    ap.add_argument("--out", default="silero_grid_results.json")
    # Each worker holds all 20 windows in memory (int16, ~57MB/window = ~1.15GB)
    # plus a torch+Silero model instance. orbox3's rule caps this job at 8GB
    # total, shared with a live room-recorder -- 2 workers (~1.15GB data +
    # ~1-1.5GB torch overhead each) leaves real headroom; do not raise this
    # without also checking `free -h` on the box first (a 23-Sep incident here
    # hit near-total swap exhaustion at 8 workers x float32 storage).
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    data_dir = os.path.abspath(args.data_dir)
    ref_dir = os.path.abspath(args.ref_dir)
    combos = list(itertools.product(*GRID.values()))
    log(f"{len(combos)} param combos, {args.workers} workers", args.log_file)

    results = []
    with Pool(args.workers, initializer=_worker_init, initargs=(data_dir, ref_dir)) as pool:
        for i, r in enumerate(pool.imap_unordered(_worker_combo, combos)):
            results.append(r)
            log(f"[{i+1}/{len(combos)}] thresh={r['threshold']} min_sil={r['min_silence_duration_ms']} "
                f"pad={r['speech_pad_ms']}: cut={r['overall_cut_pct']}% worst={r['worst_cut_pct']}% "
                f"sent={r['avg_sent_pct']}% pass={r['all_le_2pct']} ({r['elapsed_s']}s)", args.log_file)

    passing = [r for r in results if r["all_le_2pct"]]
    best = max(passing, key=lambda r: r["avg_sent_pct"]) if passing else None
    json.dump({"results": results, "best_passing": best}, open(args.out, "w"), indent=2)
    log(f"SILERO GRID best passing combo: {best}", args.log_file)


if __name__ == "__main__":
    main()
