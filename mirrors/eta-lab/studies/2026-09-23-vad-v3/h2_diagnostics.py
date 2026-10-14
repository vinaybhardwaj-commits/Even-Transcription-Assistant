#!/usr/bin/env python3
"""
VAD-V3, H2 -- "the signal is unusual". Per-window acoustic diagnostics on the
20 bake windows: spectral roll-off/bandwidth, spectral flatness, SNR estimate,
noise floor, clipping %, DC offset. Compares the 4 known Silero outliers
(bw_jk5s2tfs, bw_d5aype5r, bw_wwq9p6eb, bw_maaacrdh) against the 16 good ones.
No transcript/patient text -- numbers only.

Usage: python3 h2_diagnostics.py --data-dir DATA_DIR --out h2_results.json
"""
import argparse, json, os, wave
import numpy as np

OUTLIERS = {"bw_jk5s2tfs", "bw_d5aype5r", "bw_wwq9p6eb", "bw_maaacrdh"}


def read_wav_16k_mono(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    arr = np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0
    return arr, sr


def frame_signal(arr, sr, frame_s=0.032, hop_s=0.016):
    n = int(frame_s * sr)
    h = int(hop_s * sr)
    frames = []
    for i in range(0, len(arr) - n, h):
        frames.append(arr[i:i + n])
    return np.array(frames) if frames else np.zeros((0, n))


def spectral_stats(frames, sr):
    if len(frames) == 0:
        return {}
    win = np.hanning(frames.shape[1])
    spec = np.abs(np.fft.rfft(frames * win, axis=1)) + 1e-12
    freqs = np.fft.rfftfreq(frames.shape[1], 1.0 / sr)
    power = spec ** 2
    total = power.sum(axis=1, keepdims=True)
    cum = np.cumsum(power, axis=1) / total
    rolloff_idx = (cum >= 0.85).argmax(axis=1)
    rolloff_hz = freqs[rolloff_idx]
    centroid = (power * freqs).sum(axis=1) / total.squeeze()
    bandwidth = np.sqrt(((freqs - centroid[:, None]) ** 2 * power).sum(axis=1) / total.squeeze())
    gm = np.exp(np.mean(np.log(spec), axis=1))
    am = np.mean(spec, axis=1)
    flatness = gm / am
    return {
        "rolloff_hz_p50": float(np.median(rolloff_hz)),
        "rolloff_hz_p90": float(np.percentile(rolloff_hz, 90)),
        "bandwidth_hz_p50": float(np.median(bandwidth)),
        "spectral_flatness_p50": float(np.median(flatness)),
    }


def snr_and_floor(arr):
    frame = 1600  # 100ms @16kHz
    n = len(arr) // frame
    if n == 0:
        return {}
    rms = np.array([np.sqrt(np.mean(arr[i * frame:(i + 1) * frame] ** 2) + 1e-12) for i in range(n)])
    rms_db = 20 * np.log10(rms + 1e-9)
    noise_floor_db = float(np.percentile(rms_db, 10))
    signal_db = float(np.percentile(rms_db, 90))
    snr_db = signal_db - noise_floor_db
    return {"noise_floor_dbfs": noise_floor_db, "signal_p90_dbfs": signal_db, "snr_db": snr_db}


def clip_and_dc(arr):
    clip_pct = float(np.mean(np.abs(arr) >= 0.998) * 100)
    dc = float(np.mean(arr))
    return {"clip_pct": clip_pct, "dc_offset": dc}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--out", default="h2_results.json")
    ap.add_argument("--log-file", default=None)
    args = ap.parse_args()

    data_dir = os.path.abspath(args.data_dir)
    files = sorted(f for f in os.listdir(data_dir) if f.endswith(".wav"))
    rows = []
    for f in files:
        wid = "_".join(f.split("_")[:2]) if f.startswith("bw_") else f.replace(".wav", "")
        arr, sr = read_wav_16k_mono(os.path.join(data_dir, f))
        frames = frame_signal(arr, sr)
        row = {"file": f, "wid": wid, "sr": sr, "outlier": wid in OUTLIERS}
        row.update(spectral_stats(frames, sr))
        row.update(snr_and_floor(arr))
        row.update(clip_and_dc(arr))
        rows.append(row)
        print(f"{wid}: outlier={row['outlier']} snr={row.get('snr_db',0):.1f}dB "
              f"floor={row.get('noise_floor_dbfs',0):.1f}dBFS "
              f"rolloff_p50={row.get('rolloff_hz_p50',0):.0f}Hz "
              f"flatness={row.get('spectral_flatness_p50',0):.3f} "
              f"clip={row['clip_pct']:.3f}% dc={row['dc_offset']:.5f}")

    def agg(key, subset):
        vals = [r[key] for r in subset if key in r]
        return float(np.median(vals)) if vals else None

    outliers = [r for r in rows if r["outlier"]]
    good = [r for r in rows if not r["outlier"]]
    keys = ["snr_db", "noise_floor_dbfs", "rolloff_hz_p50", "bandwidth_hz_p50",
            "spectral_flatness_p50", "clip_pct", "dc_offset"]
    summary = {k: {"outliers_median": agg(k, outliers), "good_median": agg(k, good)} for k in keys}
    json.dump({"rows": rows, "summary": summary}, open(args.out, "w"), indent=2)
    print("\nSUMMARY (outliers vs 16 good, median):")
    for k, v in summary.items():
        print(f"  {k}: outliers={v['outliers_median']} good={v['good_median']}")


if __name__ == "__main__":
    main()
