#!/usr/bin/env python3
"""
VAD-V3 candidate: WebRTC VAD, aggressiveness 0-3, with padding/hangover
(same pad/merge treatment as VAD-v2's arms so results are comparable).
Portable: box, orbox3, air (pure CPU, no torch needed).

Usage: python3 run_webrtc.py --data-dir DATA_DIR --ref-dir REF_DIR \
    --log-file LOG --out results.json
"""
import argparse, json, os, time, wave
import numpy as np
import webrtcvad

SR = 16000
FRAME_MS = 30  # webrtcvad requires 10/20/30ms frames
FRAME_LEN = SR * FRAME_MS // 1000



def _dur(path):
    with wave.open(path, "rb") as _w:
        return _w.getnframes() / _w.getframerate()


def log(msg, log_file):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    print(line, flush=True)
    if log_file:
        with open(log_file, "a") as fh:
            fh.write(line + "\n")


def read_wav_pcm16(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    return raw, sr


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


def webrtc_intervals(raw_pcm, aggressiveness, hangover_s=0.5, min_dur_s=0.3):
    vad = webrtcvad.Vad(aggressiveness)
    frame_bytes = FRAME_LEN * 2  # int16
    n_frames = len(raw_pcm) // frame_bytes
    flags = []
    for i in range(n_frames):
        chunk = raw_pcm[i * frame_bytes:(i + 1) * frame_bytes]
        flags.append(vad.is_speech(chunk, SR))
    flags = np.array(flags, dtype=bool)
    hang_frames = int(hangover_s * 1000 / FRAME_MS)
    extended = flags.copy()
    last_active = -10**9
    for i, f in enumerate(flags):
        if f:
            last_active = i
        elif i - last_active <= hang_frames:
            extended[i] = True
    ivs = []
    i = 0
    while i < len(extended):
        if extended[i]:
            j = i
            while j < len(extended) and extended[j]:
                j += 1
            dur = (j - i) * FRAME_MS / 1000.0
            if dur >= min_dur_s:
                ivs.append((i * FRAME_MS / 1000.0, j * FRAME_MS / 1000.0))
            i = j
        else:
            i += 1
    return ivs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--ref-dir", required=True)
    ap.add_argument("--log-file", default=None)
    ap.add_argument("--out", default="webrtc_results.json")
    args = ap.parse_args()

    data_dir = os.path.abspath(args.data_dir)
    ref_dir = os.path.abspath(args.ref_dir)
    files = sorted(f for f in os.listdir(data_dir) if f.endswith(".wav"))
    log(f"{len(files)} windows x 4 aggressiveness levels", args.log_file)

    results = {a: [] for a in range(4)}
    for i, f in enumerate(files):
        wid = f[:-4]  # full stem: windows in the same room share a 2-token prefix
        raw_pcm, sr = read_wav_pcm16(os.path.join(data_dir, f))
        assert sr == SR, f"expected {SR}Hz, got {sr}"
        ref_files = [r for r in os.listdir(ref_dir) if r.startswith(wid + "_") and r.endswith("_pyannote.json")]
        if not ref_files:
            continue
        pyannote_ivs = pyannote_merged_intervals(os.path.join(ref_dir, ref_files[0]))
        t0 = time.time()
        for agg in range(4):
            ivs = webrtc_intervals(raw_pcm, agg)
            cut, total = cut_stats(pyannote_ivs, ivs)
            sent = sum(e - s for s, e in ivs)
            results[agg].append({"wid": wid, "cut_pct": cut / total * 100 if total else 0,
                                  "sent_s": sent, "total_s": total, "dur_s": _dur(os.path.join(data_dir, f))})
        log(f"[{i+1}/{len(files)}] {wid} done ({time.time()-t0:.1f}s)", args.log_file)

    summary = {}
    for agg, rows in results.items():
        if not rows:
            continue
        tot_c = sum(r["cut_pct"] / 100 * r["total_s"] for r in rows)
        tot_p = sum(r["total_s"] for r in rows)
        tot_s = sum(r["sent_s"] for r in rows)
        worst = max(rows, key=lambda r: r["cut_pct"])
        summary[f"agg{agg}"] = {
            "overall_cut_pct": round(tot_c / tot_p * 100, 2) if tot_p else 0,
            "worst_window": worst["wid"], "worst_cut_pct": round(worst["cut_pct"], 2),
            "avg_sent_pct": round(tot_s / sum(r["dur_s"] for r in rows) * 100, 1),
            "all_le_2pct": all(r["cut_pct"] <= 2.0 for r in rows),
        }
    json.dump({"rows": results, "summary": summary}, open(args.out, "w"), indent=2)
    log(f"WEBRTC SUMMARY: {json.dumps(summary, indent=2)}", args.log_file)


if __name__ == "__main__":
    main()
