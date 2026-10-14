#!/usr/bin/env python3
"""
VAD-V3 ensembles + padding sweep. Computes each base arm's kept intervals ONCE per
window (cached to --cache-dir as JSON, intervals only), then scores ensembles offline:

  S_base  Silero 0.15/1200/500 on the raw audio
  S_den   Silero on spectral-gating denoised audio (noisereduce)
  S_all3  Silero on highpass80 -> denoise -> loudnorm audio
  B       VAD-v2 Arm B (energy-only + 0.5s hangover)
  W0      WebRTC aggressiveness 0 (+0.5s hangover)

  Ensembles: union(S_all3,W0), union(S_den,W0), union(S_all3,B), vote2of3(S_all3,W0,B)
  Padding sweep (post-hoc, extend every kept interval by p seconds each side, merge):
  p in {0, 0.5, 1, 2} applied to S_all3 and to union(S_all3,W0).

Scored against pyannote.ai teacher with the full-stem window id (same-room bug fixed).
Counts/intervals only. Not run: pyannote seg-3.0 (VAD-v2 arm C) intervals were never saved.
"""
import argparse, json, os, sys, time, wave
from multiprocessing import Pool
import numpy as np

SIB = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SIB)
sys.path.insert(0, os.path.join(SIB, "..", "2026-09-23-vad-v2"))
SR = 16000


def log(msg, lf):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    print(line, flush=True)
    if lf:
        open(lf, "a").write(line + "\n")


def merge(ivs, gap=0.0):
    out = []
    for s, e in sorted(ivs):
        if out and s <= out[-1][1] + gap:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def union(*lists):
    return merge([iv for l in lists for iv in l])


def vote(lists, k):
    ev = []
    for l in lists:
        for s, e in l:
            ev.append((s, 1)); ev.append((e, -1))
    ev.sort(key=lambda x: (x[0], x[1]))
    out, cnt, start = [], 0, None
    for t, d in ev:
        prev = cnt
        cnt += d
        if prev < k <= cnt:
            start = t
        elif prev >= k > cnt and start is not None:
            out.append((start, t)); start = None
    return merge(out)


def pad(ivs, p, dur):
    return merge([(max(0.0, s - p), min(dur, e + p)) for s, e in ivs])


def cut_stats(ref, keep):
    total = sum(e - s for s, e in ref)
    if total == 0:
        return 0.0, 0.0
    cut = 0.0
    for ps, pe in ref:
        cov = 0.0
        for ss, se in keep:
            if se <= ps:
                continue
            if ss >= pe:
                break
            cov += max(0.0, min(pe, se) - max(ps, ss))
        cut += max(0.0, (pe - ps) - cov)
    return cut, total


def teacher(path):
    segs = json.load(open(path))["output"]["diarization"]
    return merge([(s["start"], s["end"]) for s in segs])


def base_intervals(job):
    """Compute the 5 base arms for one window; returns (wid, dur, {arm: intervals})."""
    wav_path, cache = job
    wid = os.path.basename(wav_path)[:-4]
    cpath = os.path.join(cache, wid + ".json")
    if os.path.exists(cpath):
        d = json.load(open(cpath)); return wid, d["dur"], {k: [tuple(x) for x in v] for k, v in d["arms"].items()}
    import torch
    torch.set_num_threads(1)
    from silero_vad import load_silero_vad, get_speech_timestamps
    from run_ab import energy_vad_arm_b
    from h3_preprocessing import highpass_80hz, loudness_normalize, denoise
    from run_webrtc import webrtc_intervals
    with wave.open(wav_path, "rb") as w:
        raw = w.readframes(w.getnframes()); dur = w.getnframes() / w.getframerate()
    i16 = np.frombuffer(raw, dtype=np.int16)
    x = i16.astype("float32") / 32768.0
    model = load_silero_vad()

    def sil(a):
        ts = get_speech_timestamps(torch.from_numpy(a.astype("float32")), model, threshold=0.15, sampling_rate=SR,
                                   min_silence_duration_ms=1200, speech_pad_ms=500)
        return [(t["start"] / SR, t["end"] / SR) for t in ts]

    arms = {
        "S_base": sil(x),
        "S_den": sil(denoise(x)),
        "S_all3": sil(loudness_normalize(denoise(highpass_80hz(x)))),
        "B": energy_vad_arm_b(i16.astype("float32")),
        "W0": webrtc_intervals(raw, 0),
    }
    json.dump({"dur": dur, "arms": arms}, open(cpath, "w"))
    return wid, dur, arms


def score(name, per_window):
    cuts = np.array([c for c, _, _, _ in per_window])
    tot_c = sum(c * t / 100 for c, t, _, _ in per_window)
    tot_t = sum(t for _, t, _, _ in per_window)
    sent = sum(s for _, _, s, _ in per_window); dur = sum(d for _, _, _, d in per_window)
    return {"arm": name, "overall_cut_pct": round(tot_c / tot_t * 100, 2), "worst_cut_pct": round(float(cuts.max()), 2),
            "p95_cut_pct": round(float(np.percentile(cuts, 95)), 2), "windows_over_2pct": int((cuts > 2).sum()),
            "n_windows": len(cuts), "audio_sent_pct": round(sent / dur * 100, 1),
            "passes_every_window_le_2pct": bool((cuts <= 2).all())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--ref-dir", required=True)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--log-file", default=None)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.cache_dir, exist_ok=True)
    files = sorted(f for f in os.listdir(a.data_dir) if f.endswith(".wav"))
    log(f"{len(files)} windows, {a.workers} workers", a.log_file)
    jobs = [(os.path.join(a.data_dir, f), a.cache_dir) for f in files]
    res = []
    with Pool(a.workers) as pool:
        for i, r in enumerate(pool.imap_unordered(base_intervals, jobs)):
            res.append(r); log(f"[{i+1}/{len(files)}] {r[0]} base arms done", a.log_file)

    ens = {}
    arms_all = ["S_base", "S_den", "S_all3", "B", "W0"]
    for name in arms_all:
        ens[name] = lambda A, d, n=name: A[n]
    ens["U(S_all3,W0)"] = lambda A, d: union(A["S_all3"], A["W0"])
    ens["U(S_den,W0)"] = lambda A, d: union(A["S_den"], A["W0"])
    ens["U(S_all3,B)"] = lambda A, d: union(A["S_all3"], A["B"])
    ens["vote2of3(S_all3,W0,B)"] = lambda A, d: vote([A["S_all3"], A["W0"], A["B"]], 2)
    for p in (0.5, 1.0, 2.0):
        ens[f"S_all3+pad{p}s"] = lambda A, d, p=p: pad(A["S_all3"], p, d)
        ens[f"U(S_all3,W0)+pad{p}s"] = lambda A, d, p=p: pad(union(A["S_all3"], A["W0"]), p, d)

    table = []
    per_window_out = {}
    for name, fn in ens.items():
        rows = []
        for wid, dur, A in sorted(res):
            ref = teacher(os.path.join(a.ref_dir, wid + "_pyannote.json"))
            keep = merge(fn(A, dur))
            c, t = cut_stats(ref, keep)
            rows.append((c / t * 100 if t else 0.0, t, sum(e - s for s, e in keep), dur))
            per_window_out.setdefault(name, []).append({"wid": wid, "cut_pct": round(rows[-1][0], 2)})
        table.append(score(name, rows))
    json.dump({"table": table, "per_window_cut_pct": per_window_out}, open(a.out, "w"), indent=2)
    for r in table:
        log(f"{r['arm']:26s} overall={r['overall_cut_pct']:6.2f}% p95={r['p95_cut_pct']:6.2f}% worst={r['worst_cut_pct']:6.2f}% "
            f">2%={r['windows_over_2pct']}/{r['n_windows']} sent={r['audio_sent_pct']}% pass={r['passes_every_window_le_2pct']}", a.log_file)


if __name__ == "__main__":
    main()
