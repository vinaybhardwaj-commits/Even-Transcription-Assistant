"""T5: high drift with a realistic channel. Offline; writes wavs under OUT, runs v2 and --legacy-s.

usage: t5_sim.py ROOM.npz OUT_DIR [--ppm 0,3,-3,40,-40,150,-150] [--ref-ppm 40,-40,150,-150] [--procs 10]
Mic1 is the reference (clock = true time, or drifting by --ref-ppm: file room/mic1_<p>ppm.wav). Mic2 reads tau = (1+e)t + O2. The beacon is the analytic
sweep (beacon_gen.sweep_at, no resampling) summed over the room-response taps; each recorded sample
is evaluated at its own true time, so the drift is exact. Truth for a real channel is
c0(e) = (1+e)(c0_0 - O2) + O2 with c0_0 the zero-drift result; for the flat channel it is O2.
"""
import os
import sys
import json
import argparse
import numpy as np
import soundfile as sf
from multiprocessing import Pool

import beacon_gen as bg
import beacon_sync as bs
import t5_room as R

FS = bg.FS
O2 = -4.285e-3
T_FIRST = 5.123456       # true time of the first beacon start (s)
N_B = 12
CHUNK = 64
N_OUT = int((360 + 10) * FS)


def render_task(args):
    """One beacon through one set of taps. Returns (k_lo, samples)."""
    idx, amps, e, o, tb = args                      # idx: tap delays in samples, sorted
    k_first = int(np.floor(((tb + idx[0] / FS) * (1 + e) + o) * FS)) - 2
    k_last = int(np.ceil(((tb + idx[-1] / FS + bg.SWEEP_S) * (1 + e) + o) * FS)) + CHUNK + 12
    y = np.zeros(k_last - k_first + 1)
    for c in range(0, len(idx), CHUNK):
        j = idx[c:c + CHUNK]
        a = amps[c:c + CHUNK]
        d = j / FS
        k_lo = int(np.floor(((tb + d[0]) * (1 + e) + o) * FS)) - 2
        w = int(bg.SWEEP_S * (1 + e) * FS) + len(j) + 8
        k = np.arange(k_lo, k_lo + w)
        u = ((k / FS - o) / (1 + e) - tb)[None, :] - d[:, None]
        v = bg.sweep_at(u)                      # analytic sweep on the unstretched (speaker) clock
        y[k_lo - k_first:k_lo - k_first + w] += a @ v
    return k_first, y


def render(taps, e, o, procs, pool):
    idx, amp = taps
    tasks = [(idx, amp, e, o, T_FIRST + bg.PERIOD_S * i) for i in range(N_B)]
    parts = pool.map(render_task, tasks)
    x = np.zeros(N_OUT)
    for k0, y in parts:
        x[k0:k0 + len(y)] += y
    return x


def write(path, x, noise, rng):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    x = x + rng.standard_normal(len(x)) * noise
    sf.write(path, np.clip(x, -1, 1), FS, subtype="PCM_16")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("room")
    ap.add_argument("out")
    ap.add_argument("--ppm", default="0,3,-3,40,-40,150,-150")
    ap.add_argument("--ref-ppm", default="", help="room channel only: also render the reference mic drifting by these")
    ap.add_argument("--procs", type=int, default=10)
    a = ap.parse_args()
    room = np.load(a.room)
    ppms = [float(p) for p in a.ppm.split(",") if p]
    ref_ppms = [float(p) for p in a.ref_ppm.split(",") if p]
    rng = np.random.default_rng(11)
    flat = (np.array([0]), np.array([1.0]))
    channels = {"room": ((room["mic1_d"], room["mic1_a"]), (room["mic2_d"], room["mic2_a"]),
                         float(room["mic1_noise"]), float(room["mic2_noise"])),
                "flat": (flat, flat, 1e-3, 1e-3)}
    results = []
    with Pool(a.procs) as pool:
        for ch, (h1, h2, n1, n2) in channels.items():
            m1 = f"{a.out}/{ch}/mic1.wav"
            if not os.path.exists(m1):
                write(m1, render(h1, 0.0, 0.0, a.procs, pool), n1, rng)
            print(ch, "mic1 ready", flush=True)
            for rp in (ref_ppms if ch == "room" else []):
                m1d = f"{a.out}/{ch}/mic1_{rp:+g}ppm.wav"
                if not os.path.exists(m1d):
                    write(m1d, render(h1, rp * 1e-6, 0.0, a.procs, pool), n1, rng)
                print(ch, "mic1", rp, "ppm ready", flush=True)
            for ppm in ppms:
                e = ppm * 1e-6
                m2 = f"{a.out}/{ch}/mic2_{ppm:+g}ppm.wav"
                if not os.path.exists(m2):
                    write(m2, render(h2, e, O2, a.procs, pool), n2, rng)
                print(ch, ppm, "mic2 ready", flush=True)
    print("render done", flush=True)


if __name__ == "__main__":
    main()
