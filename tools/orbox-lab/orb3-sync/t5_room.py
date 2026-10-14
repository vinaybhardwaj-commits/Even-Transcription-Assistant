"""Room responses deconvolved from a recorded run (T2), one per mic. Used by t5_sim.py.

usage: t5_room.py RUNDIR SYNC_JSON OUT.npz
taps are (delay in samples from the detected arrival, amplitude); band 0.9-8.5 kHz, taps under 3e-3 of the peak zeroed.
"""
import sys
import json
import numpy as np
import beacon_gen as bg
import beacon_sync as bs

FS = bg.FS
PRE = 2400                 # 50 ms of the window before the arrival
L = 72000                  # 1.5 s window
NF = 2 * L                 # FFT length (zero-padded: no wrap-around)
TAIL_S = 0.6               # keep taps from -20 ms to this after the arrival
HEAD_S = 0.020
BAND = (900.0, 8500.0)
SKIRT = 100.0
TAP_FLOOR = 3e-3


def band_window(f):
    w = np.zeros_like(f)
    lo, hi = BAND
    w[(f >= lo) & (f <= hi)] = 1.0
    up = (f >= lo - SKIRT) & (f < lo)
    w[up] = 0.5 * (1 - np.cos(np.pi * (f[up] - (lo - SKIRT)) / SKIRT))
    dn = (f > hi) & (f <= hi + SKIRT)
    w[dn] = 0.5 * (1 + np.cos(np.pi * (f[dn] - hi) / SKIRT))
    return w


def deconvolve(x, arrivals):
    sweep = bg.make_sweep()
    xs = np.zeros(NF)
    xs[PRE:PRE + len(sweep)] = sweep
    X = np.fft.rfft(xs)
    f = np.fft.rfftfreq(NF, 1 / FS)
    num = np.zeros(len(f), complex)
    den = np.zeros(len(f))
    for a in arrivals:
        k0 = int(np.floor(a)) - PRE
        frac = a - np.floor(a)
        seg = x[k0:k0 + L]
        Y = np.fft.rfft(seg * np.hanning(L) ** 0 , NF) * np.exp(2j * np.pi * f * frac / FS)   # advance by the fractional sample
        num += Y * np.conj(X)
        den += np.abs(X) ** 2
    H = num / (den + 1e-3 * den.max()) * band_window(f)
    h = np.fft.irfft(H, NF)
    d = np.arange(NF)
    d = np.where(d > NF // 2, d - NF, d)            # circular index -> signed delay in samples
    keep = (d >= -int(HEAD_S * FS)) & (d <= int(TAIL_S * FS))
    order = np.argsort(d[keep])
    return d[keep][order], h[keep][order]


def main(rundir, sync_json, out):
    sj = json.load(open(sync_json))
    res = {}
    for n in sj["mics"]:
        x = bs.load(f"{rundir}/{n}.wav")
        d, h = deconvolve(x, sj["arrivals"][n]["beacon_samples"])
        pk = np.abs(h).max()
        keep = np.abs(h) > TAP_FLOOR * pk
        d, hk = d[keep], h[keep]
        # noise rms from the quietest half of 0.5 s blocks
        blocks = x[:len(x) // 24000 * 24000].reshape(-1, 24000)
        rms = np.sqrt(np.mean(blocks ** 2, axis=1))
        res[n + "_d"] = d
        res[n + "_a"] = hk
        res[n + "_noise"] = float(np.median(rms))
        print(f"{n}: peak at {int(d[np.argmax(np.abs(hk))]):+d} samples, {len(d)} taps, "
              f"span {d.min() / FS * 1e3:+.1f}..{d.max() / FS * 1e3:+.1f} ms, noise rms {res[n + '_noise']:.2e}")
    np.savez(out, **res)


if __name__ == "__main__":
    main(*sys.argv[1:4])
