#!/usr/bin/env python3
"""
VAD v2, Arms A and B -- portable runner (box, orbox3, or anywhere with the same data).

Arm A: Silero VAD (threshold=0.15, min_silence_duration_ms=1200, speech_pad_ms=500) AND
       level-log agreement -- a span is cut only where Silero says silent AND the window's
       level log also shows no activity there. Uses REAL bench_level_sample rows when the
       --level-log export covers a window; falls back to an RMS-energy proxy (same signal
       the level log measures) for any window the export doesn't cover, and says so per
       window in the log -- never silently substitutes one for the other.
Arm B: energy-only VAD (adaptive RMS/dBFS gate + hangover), no Silero, no model at all.

Usage:
    python3 run_ab.py --data-dir DATA_DIR --level-log level-log-export.json \
        --log-file /path/to/lab-mover.log --out results.json

DATA_DIR must contain <window_id>.wav (16kHz mono PCM) directly, and a sibling
<basename>-ref/ directory (i.e. DATA_DIR/../<DATA_DIR-name>-ref/) with
<window_id>_pyannote.json teacher files -- matches the box's bake20 / bake20-ref layout.
"""
import argparse, json, os, sys, time, wave
import numpy as np

SR = 16000
WINDOW = 512  # Silero frame size at 16kHz


def log(msg, log_file):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    print(line, flush=True)
    if log_file:
        with open(log_file, "a") as fh:
            fh.write(line + "\n")


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


def read_wav_16k_mono(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == SR, f"expected {SR}Hz, got {w.getframerate()}"
        assert w.getnchannels() == 1, "expected mono"
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32)


def union_intervals(a, b):
    all_ivs = sorted(a + b)
    merged = []
    for s, e in all_ivs:
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


def energy_active_intervals(pcm, bucket_s=1.0, active_mult=1.10, floor_pctile=3):
    """Proxy for 'level log shows activity': per-1s RMS vs the window's own low-percentile floor."""
    bucket = int(bucket_s * SR)
    n = len(pcm) // bucket
    rms = np.array([np.sqrt(np.mean(pcm[i * bucket:(i + 1) * bucket] ** 2) + 1e-9) for i in range(n)])
    floor = max(np.percentile(rms, floor_pctile), 1.0)
    active = rms > (floor * active_mult)
    ivs = [(i * bucket_s, (i + 1) * bucket_s) for i, a in enumerate(active) if a]
    merged = []
    for s, e in ivs:
        if merged and s <= merged[-1][1] + 1e-9:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return merged


def real_level_log_active_intervals(samples, window_start_epoch_s, rms_active_frac=0.02):
    """Real bench_level_sample rows -> activity intervals. Each row's own interval is treated
    as active if peak/avg clears a small floor (silence_rms-style threshold, matching the
    emotion service's own silence gate order-of-magnitude: 0.008 on a [0,1] float scale)."""
    ivs = []
    for s in samples:
        if s.get("sampled_at") is None:
            continue
        # samples are point-in-time; treat each as covering a short interval around itself.
        # (row cadence unknown without more real data -- this is a best-effort real-data path,
        # not exercised by this dataset since no window here has any real rows.)
        t = s["sampled_at"]
        peak = s.get("peak") or 0.0
        if peak > rms_active_frac:
            ivs.append((t, t + 1.0))
    return ivs


def energy_vad_arm_b(pcm, frame_s=0.1, floor_pctile=3, active_mult=1.10, hangover_s=0.5, min_on_s=0.3):
    frame = int(frame_s * SR)
    n = len(pcm) // frame
    rms = np.array([np.sqrt(np.mean(pcm[i * frame:(i + 1) * frame] ** 2) + 1e-9) for i in range(n)])
    floor = max(np.percentile(rms, floor_pctile), 1.0)
    active = rms > (floor * active_mult)
    hang_frames = int(round(hangover_s / frame_s))
    active_hang = active.copy()
    last_active = -10 ** 9
    for i in range(n):
        if active[i]:
            last_active = i
        if i - last_active <= hang_frames:
            active_hang[i] = True
    ivs = [(i * frame_s, (i + 1) * frame_s) for i, a in enumerate(active_hang) if a]
    merged = []
    for s, e in ivs:
        if merged and s <= merged[-1][1] + 1e-9:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return [(s, e) for s, e in merged if e - s >= min_on_s]


def compute_silero_probs(model, pcm):
    import torch
    audio = torch.from_numpy(pcm / 32768.0)
    model.reset_states()
    probs = []
    with torch.no_grad():
        for start in range(0, len(audio), WINDOW):
            chunk = audio[start:start + WINDOW]
            if len(chunk) < WINDOW:
                chunk = torch.nn.functional.pad(chunk, (0, WINDOW - len(chunk)))
            probs.append(model(chunk, SR).item())
    return np.array(probs, dtype=np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--level-log", default=None)
    ap.add_argument("--log-file", default=None)
    ap.add_argument("--out", default="run_ab_results.json")
    args = ap.parse_args()

    import torch
    torch.set_num_threads(int(os.environ.get("OMP_NUM_THREADS", "4")))
    from silero_vad import get_speech_timestamps_from_probs, load_silero_vad

    data_dir = os.path.abspath(args.data_dir)
    ref_dir = data_dir.rstrip("/") + "-ref"
    level_log_by_window = {}
    if args.level_log and os.path.exists(args.level_log):
        rows = json.load(open(args.level_log))
        for r in rows:
            level_log_by_window.setdefault(r["window_id"], []).append(r)

    log(f"start data_dir={data_dir} ref_dir={ref_dir} level_log={args.level_log}", args.log_file)
    model = load_silero_vad()
    files = sorted(f for f in os.listdir(data_dir) if f.endswith(".wav"))
    log(f"{len(files)} windows to score", args.log_file)

    arm_a_rows, arm_b_rows = [], []
    for i, f in enumerate(files):
        wid = f.replace(".wav", "")
        wav_path = os.path.join(data_dir, f)
        ref_path = os.path.join(ref_dir, wid + "_pyannote.json")
        pyannote_ivs = pyannote_merged_intervals(ref_path)
        pcm = read_wav_16k_mono(wav_path)

        probs = compute_silero_probs(model, pcm)
        ts = get_speech_timestamps_from_probs(
            probs.tolist(), sampling_rate=SR, threshold=0.15,
            min_silence_duration_ms=1200, speech_pad_ms=500, min_speech_duration_ms=250,
            return_seconds=True, audio_length_samples=len(probs) * WINDOW,
        )
        silero_ivs = [(t["start"], t["end"]) for t in ts]

        real_samples = level_log_by_window.get(wid, [])
        has_real = any(s.get("sampled_at") is not None for s in real_samples)
        if has_real:
            level_ivs = real_level_log_active_intervals(real_samples, 0.0)
            source = "real_bench_level_sample"
        else:
            level_ivs = energy_active_intervals(pcm)
            source = "rms_proxy_no_real_coverage"

        keep_a = union_intervals(silero_ivs, level_ivs)
        cut_a, total = cut_stats(pyannote_ivs, keep_a)
        sent_a = sum(e - s for s, e in keep_a)
        arm_a_rows.append({"wid": wid, "pyannote_s": total, "cut_s": cut_a,
                            "cut_pct": cut_a / total * 100 if total else 0.0,
                            "sent_s": sent_a, "level_log_source": source})

        keep_b = energy_vad_arm_b(pcm)
        cut_b, _ = cut_stats(pyannote_ivs, keep_b)
        sent_b = sum(e - s for s, e in keep_b)
        arm_b_rows.append({"wid": wid, "pyannote_s": total, "cut_s": cut_b,
                            "cut_pct": cut_b / total * 100 if total else 0.0, "sent_s": sent_b})

        log(f"[{i+1}/{len(files)}] {wid}: armA={arm_a_rows[-1]['cut_pct']:.2f}%({source}) "
            f"armB={arm_b_rows[-1]['cut_pct']:.2f}%", args.log_file)

    def summarize(rows):
        tot_p = sum(r["pyannote_s"] for r in rows)
        tot_c = sum(r["cut_s"] for r in rows)
        tot_s = sum(r["sent_s"] for r in rows)
        worst = max(rows, key=lambda r: r["cut_pct"])
        return {"overall_cut_pct": tot_c / tot_p * 100 if tot_p else 0.0,
                "worst_window": worst["wid"], "worst_cut_pct": worst["cut_pct"],
                "avg_sent_s": tot_s / len(rows), "all_le_2pct": all(r["cut_pct"] <= 2.0 for r in rows)}

    result = {"arm_a": {"rows": arm_a_rows, "summary": summarize(arm_a_rows)},
              "arm_b": {"rows": arm_b_rows, "summary": summarize(arm_b_rows)}}
    json.dump(result, open(args.out, "w"), indent=2)
    log(f"ARM A summary: {result['arm_a']['summary']}", args.log_file)
    log(f"ARM B summary: {result['arm_b']['summary']}", args.log_file)
    log(f"done, wrote {args.out}", args.log_file)


if __name__ == "__main__":
    main()
