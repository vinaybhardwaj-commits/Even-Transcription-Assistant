#!/usr/bin/env python3
"""W34.2 step 1: per-chunk acoustic metrics from lab tape copies (read-only). Numbers only, no text.
Run with ~/vad/venv/bin/python. Output: JSONL, one row per chunk, resumable.
Usage: chunk_metrics.py [--workers 6] [--limit N]
"""
import json, os, subprocess, sys, argparse
import numpy as np
from scipy import signal
from multiprocessing import Pool

TAPES = os.path.expanduser("~/eta-data/tapes")
OUT = os.path.expanduser("~/eta-data/acoustics/work/chunk_metrics.jsonl")
SR = 48000
HBINS = np.arange(-121, 1)  # 1-dB bins: [-121..0]; index = floor(dB)+121, floors at -120
NFFT = 1024
_vad = None

def decode(path):
    p = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                       capture_output=True, timeout=300)
    if p.returncode != 0 and not p.stdout:
        raise RuntimeError(p.stderr.decode()[:200])
    return np.frombuffer(p.stdout, dtype=np.float32)

def db(p):
    return 10 * np.log10(np.maximum(p, 1e-12))

def get_vad():
    global _vad
    if _vad is None:
        import torch
        torch.set_num_threads(1)
        from silero_vad import load_silero_vad
        _vad = load_silero_vad()
    return _vad

def hist(vals):
    v = np.clip(np.floor(vals), -120, 0).astype(int) + 120
    return np.bincount(v, minlength=121).tolist()

def rt60_from_decays(x16, segs, floor_db):
    """Crude blind RT60: fit slope of the 10-ms energy envelope after speech offsets (T20-style, -5..-25 dB)."""
    hop, win = 160, 320
    n = (len(x16) - win) // hop
    if n < 20:
        return []
    fr = np.lib.stride_tricks.sliding_window_view(x16, win)[::hop][:n]
    env = db((fr.astype(np.float64) ** 2).mean(1))
    out = []
    for i, (s, e) in enumerate(segs):
        nxt = segs[i + 1][0] if i + 1 < len(segs) else len(x16)
        if nxt - e < 0.6 * 16000 or e - s < 0.4 * 16000:
            continue
        a = max(0, e // hop - 10)
        b = min(n, e // hop + 50)
        w = env[a:b]
        if len(w) < 30:
            continue
        pk = int(np.argmax(w[:20]))
        pv = w[pk]
        if pv - floor_db < 30:
            continue
        seg = w[pk:]
        idx = np.where((seg <= pv - 5) & (seg >= pv - 25))[0]
        if len(idx) < 6:
            continue
        # contiguous from first crossing of -5 to first crossing below -25
        below = np.where(seg < pv - 25)[0]
        end = below[0] if len(below) else len(seg)
        idx = idx[idx < end]
        if len(idx) < 6:
            continue
        t = idx * 0.01
        slope, _ = np.polyfit(t, seg[idx], 1)
        if slope >= -8:  # <8 dB/s means RT60>7 s: noise, not a decay
            continue
        rt = -60.0 / slope
        if 0.05 < rt < 3.0:
            out.append(round(float(rt), 3))
    return out

def process(rec):
    path = os.path.join(TAPES, rec["path"])
    row = {"id": rec["id"], "room_id": rec["room_id"], "session_id": rec["session_id"],
           "started_at": rec["started_at"], "size_bytes": rec["size_bytes"], "dur_ms": rec["duration_ms"]}
    try:
        x = decode(path)
    except Exception as ex:
        row["error"] = str(ex)[:120]
        return row
    N = len(x)
    row["n"] = N
    row["dur_s"] = round(N / SR, 2)
    if N < SR * 5:
        row["error"] = "short"
        return row
    row["zero_sample_share"] = float((x == 0).mean())
    row["clip_share_999"] = float((np.abs(x) >= 0.999).mean())
    row["clip_share_98"] = float((np.abs(x) >= 0.98).mean())
    row["peak"] = float(np.abs(x).max())
    nf = N // SR
    fr = x[: nf * SR].reshape(nf, SR).astype(np.float64)
    rms = fr.__pow__(2).mean(1)
    rdb = db(rms)
    row["frame_zero_share"] = float((rms == 0).mean())
    # VAD at 16 kHz
    x16 = signal.resample_poly(x, 1, 3).astype(np.float32)
    import torch
    from silero_vad import get_speech_timestamps
    ts = get_speech_timestamps(torch.from_numpy(x16), get_vad(), sampling_rate=16000, return_seconds=False)
    segs = [(t["start"], t["end"]) for t in ts]
    mask = np.zeros(nf * 100 + 100, bool)  # 10 ms
    for s, e in segs:
        mask[s // 160: e // 160 + 1] = True
    m1 = mask[: nf * 100].reshape(nf, 100)
    dil = np.convolve(mask.astype(float), np.ones(61), "same") > 0  # +-0.3 s
    d1 = dil[: nf * 100].reshape(nf, 100)
    speech_fr = m1.mean(1) >= 0.5
    quiet_fr = ~d1.any(1)
    row["vad_speech_s"] = round(float(sum(e - s for s, e in segs) / 16000), 2)
    row["n_frames"] = nf
    row["n_speech_frames"] = int(speech_fr.sum())
    row["n_quiet_frames"] = int(quiet_fr.sum())
    row["hist_quiet"] = hist(rdb[quiet_fr]) if quiet_fr.any() else None
    row["hist_speech"] = hist(rdb[speech_fr]) if speech_fr.any() else None
    row["hist_all"] = hist(rdb)
    if quiet_fr.sum() >= 5:
        row["noise_p10"] = float(np.percentile(rdb[quiet_fr], 10))
        row["noise_med"] = float(np.median(rdb[quiet_fr]))
    if speech_fr.sum() >= 3:
        # speech level over speech-active 10-ms samples (power mean)
        sm = np.repeat(mask[: nf * 100], SR // 100)
        xs = x[: nf * SR]
        row["speech_dbfs"] = float(db((xs[sm].astype(np.float64) ** 2).mean()))
        # speech PSD (Welch over speech samples only, segment by segment)
        acc = np.zeros(NFFT // 2 + 1)
        cnt = 0
        for s, e in segs:
            s48, e48 = s * 3, e * 3
            if e48 - s48 < NFFT * 4:
                continue
            f, p = signal.welch(x[s48:e48], SR, nperseg=NFFT, noverlap=NFFT // 2)
            acc += p * (e48 - s48)
            cnt += e48 - s48
        if cnt:
            row["psd_speech"] = (acc / cnt).tolist()
            row["psd_speech_n"] = cnt
    # noise PSD from quiet frames (for tilt/bandwidth SNR-by-band)
    if quiet_fr.sum() >= 10:
        qi = np.where(quiet_fr)[0]
        acc = np.zeros(NFFT // 2 + 1); k = 0
        for i in qi[:60]:
            f, p = signal.welch(x[i * SR:(i + 1) * SR], SR, nperseg=NFFT, noverlap=NFFT // 2)
            acc += p; k += 1
        row["psd_noise"] = (acc / k).tolist()
    fl = row.get("noise_p10", -80.0)
    row["rt60"] = rt60_from_decays(x16, segs, fl)
    return row

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    recs = [json.loads(l) for l in open(os.path.join(TAPES, "manifest.jsonl"))]
    done = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            try: done.add(json.loads(l)["id"])
            except Exception: pass
    todo = [r for r in recs if r["id"] not in done and os.path.exists(os.path.join(TAPES, r["path"]))]
    if a.limit: todo = todo[: a.limit]
    print(f"todo {len(todo)} of {len(recs)}", flush=True)
    with open(OUT, "a") as fo, Pool(a.workers) as pool:
        for i, row in enumerate(pool.imap_unordered(process, todo, chunksize=2)):
            fo.write(json.dumps(row) + "\n"); fo.flush()
            if i % 100 == 0: print(i, flush=True)
    os.chmod(OUT, 0o640)

if __name__ == "__main__":
    main()
