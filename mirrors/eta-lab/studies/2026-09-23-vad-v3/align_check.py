#!/usr/bin/env python3
"""
Audio-vs-teacher alignment check (independent re-implementation of eta-refuter-2's method, 24 Sep).
Per window: the lag (s) maximising the Pearson correlation between the audio's 100 ms log-energy envelope
and the teacher speech mask, searched over +-10 s. Positive lag = audio sits LATE relative to the labels.
Computed for the whole window and for each half, so a mid-window shift (e.g. after a padded gap) shows up
as first-half ~0 and second-half != 0. Windows with < 5 s of teacher speech in the span are skipped.
Numbers only. Usage: python3 align_check.py --data-dir D --ref-dir R --out out.json
"""
import argparse, json, os, wave
import numpy as np

FR = 0.1


def env_and_mask(wav, ref):
    with wave.open(wav, "rb") as w:
        sr = w.getframerate(); x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64)
    n = int(len(x) / sr / FR)
    fl = int(sr * FR)
    e = np.log(np.sqrt((x[:n * fl].reshape(n, fl) ** 2).mean(axis=1)) + 1.0)
    m = np.zeros(n)
    for s in json.load(open(ref))["output"]["diarization"]:
        m[int(s["start"] / FR):int(np.ceil(s["end"] / FR))] = 1.0
    return e, m[:n]


def best_lag(e, m, lo, hi, maxlag=100):
    if m[lo:hi].sum() * FR < 5.0:
        return None, None
    best = (None, -2.0)
    for L in range(-maxlag, maxlag + 1):
        a, b = lo + L, hi + L
        if a < 0 or b > len(e):
            continue
        ee, mm = e[a:b], m[lo:hi]
        if ee.std() < 1e-9 or mm.std() < 1e-9:
            continue
        c = float(np.corrcoef(ee, mm)[0, 1])
        if c > best[1]:
            best = (L * FR, c)
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True); ap.add_argument("--ref-dir", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rows = []
    for f in sorted(x for x in os.listdir(a.data_dir) if x.endswith(".wav")):
        wid = f[:-4]
        e, m = env_and_mask(os.path.join(a.data_dir, f), os.path.join(a.ref_dir, wid + "_pyannote.json"))
        n = len(e); h = n // 2
        whole = best_lag(e, m, 0, n); first = best_lag(e, m, 0, h); second = best_lag(e, m, h, n)
        rows.append({"wid": wid, "lag_whole_s": whole[0], "corr_whole": None if whole[1] is None else round(whole[1], 3),
                     "lag_first_half_s": first[0], "corr_first": None if first[1] is None else round(first[1], 3),
                     "lag_second_half_s": second[0], "corr_second": None if second[1] is None else round(second[1], 3)})
    json.dump(rows, open(a.out, "w"), indent=1)
    sc = [r for r in rows if r["lag_whole_s"] is not None]
    ok = [r for r in sc if abs(r["lag_whole_s"]) <= 0.3 and all(r[k] is None or abs(r[k]) <= 0.3 for k in ("lag_first_half_s", "lag_second_half_s"))]
    print(f"{len(rows)} windows, {len(sc)} scored, {len(ok)} within +-0.3 s in whole AND both halves")
    for r in sc:
        if r not in ok:
            print("  FLAG", r["wid"], {k: r[k] for k in r if k != "wid"})


if __name__ == "__main__":
    main()
