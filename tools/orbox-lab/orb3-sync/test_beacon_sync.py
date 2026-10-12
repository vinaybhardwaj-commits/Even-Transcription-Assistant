"""T1 synthetic test for beacon_sync. Builds 2-mic and 3-mic cases from beacon_track.wav."""
import json
import os
import sys
import tempfile
import numpy as np
import soundfile as sf
import scipy.signal as ss

import beacon_gen as bg
import beacon_sync as bs

FS = bg.FS
C = 343.0
OVS = 8
PLAY_LAG_S = 3.1
RT60 = 0.5
DR_DB = -3.0
SNR_DB = 25.0
TRACK = os.environ.get("BEACON_TRACK", "beacon_track.wav")

# per-mic truth: start offset (s), drift (ppm), distance to left / right speaker (m)
MICS = [
    dict(name="mic1", o=+7.300e-3, eps=+38e-6, dl=1.20, dr=1.60),
    dict(name="mic2", o=-2.150e-3, eps=-21e-6, dl=1.55, dr=1.35),
    dict(name="mic3", o=+11.00e-3, eps=+5e-6, dl=2.05, dr=0.95),
]


def reverb_tail(rng):
    n = int(RT60 * FS)
    t = np.arange(n) / FS
    h = rng.standard_normal(n) * np.exp(-6.9078 * t / RT60)
    h[:int(0.005 * FS)] = 0.0  # reflections start 5 ms after the direct path
    return h * np.sqrt(10 ** (-DR_DB / 10) / np.sum(h ** 2))


def render(track, events, m, rng, n_out):
    """events: (channel, start_s, stop_s, distance_m). Mic clock: tau = (1+eps)(t+d/c)+o."""
    out = np.zeros(n_out)
    for ch, t0, t1, d in events:
        i0, i1 = int((t0 - 0.05) * FS), int((t1 + 0.05) * FS)
        seg = ss.resample_poly(track[i0:i1, ch], OVS, 1)
        tau0 = (1 + m["eps"]) * (PLAY_LAG_S + i0 / FS + d / C) + m["o"]
        k0 = int(tau0 * FS) - 1
        k = np.arange(k0, k0 + int((i1 - i0) * (1 + m["eps"])) + 4)
        t_seg = ((k / FS - m["o"]) / (1 + m["eps"]) - d / C - PLAY_LAG_S - i0 / FS)
        pos = t_seg * FS * OVS
        ok = (pos >= 1) & (pos < len(seg) - 2)
        direct = np.zeros(len(k))
        direct[ok] = np.interp(pos[ok], np.arange(len(seg)), seg)
        wet = ss.fftconvolve(direct, reverb_tail(rng))[:len(k)]
        sig = direct + wet
        sel = (k >= 0) & (k < n_out)
        out[k[sel]] += sig[sel]
    return out


def case(mics, rng, tmp, label, geometry=None):
    dur = 360
    track, tb, tc = bg.make_track(dur)
    ev = []
    n_out = int((dur + 10) * FS)
    paths = []
    for m in mics:
        e = [(0, t, t + 0.5, m["dl"]) for t in tb] + [(1, t, t + 0.5, m["dr"]) for t in tc]
        x = render(track, e, m, rng, n_out)
        sig_rms = np.sqrt(np.mean(x[np.abs(x) > 1e-4] ** 2))
        x += rng.standard_normal(n_out) * sig_rms * 10 ** (-SNR_DB / 20)
        os.makedirs(os.path.join(tmp, label), exist_ok=True)
        p = os.path.join(tmp, label, f"{m['name']}.wav")
        sf.write(p, np.clip(x, -1, 1), FS, subtype="PCM_16")
        paths.append(p)
    res = bs.run(paths, dur, geometry)
    m1 = mics[0]
    print(f"== {label}: n_beacons {res['n_beacons']}  status {res['status']}  dropped {len(res['dropped'])}  interfered {len(res['interfered'])}")
    ok = res["status"] == "ok" and not res["dropped"] and not res["interfered"]
    print(f"{'mic':5} {'drift true':>11} {'est':>9} {'err':>7} | {'c0 true ms':>11} {'est':>9} {'err us':>7}")
    for m in mics[1:]:
        b_t = (1 + m["eps"]) / (1 + m1["eps"]) - 1
        c_t = m["o"] - (1 + b_t) * m1["o"] + (1 + m["eps"]) * (m["dl"] - m1["dl"]) / C
        b_e, c_e = res["drift_ppm"][m["name"]], res["c0_ms"][m["name"]]
        eb, ec = b_e - b_t * 1e6, (c_e - c_t * 1e3) * 1e3
        good = abs(eb) <= 0.5 and abs(ec) <= 20
        ok &= good
        print(f"{m['name']:5} {b_t * 1e6:+11.3f} {b_e:+9.3f} {eb:+7.3f} | {c_t * 1e3:+11.4f} {c_e:+9.4f} {ec:+7.1f}  "
              f"{'PASS' if good else 'FAIL'}  resid rms {res['resid_rms_us'][m['name']]:.1f} us, "
              f"check range {res['check_tdoa_range_us'][m['name']]:.1f} us")
        if geometry:
            print(f"      geometry: a_ms {res['a_ms'][m['name']]:+.4f}  g_ms {res['g_ms'][m['name']]:+.4f}  "
                  f"check-minus-predicted {res['check_minus_predicted_us'][m['name']]:+.1f} us")
    return ok


def main():
    rng = np.random.default_rng(9)
    if not os.path.exists(TRACK):
        x, _, _ = bg.make_track(360)
        sf.write(TRACK, x, FS, subtype="PCM_16")
    # made-up geometry: speakers and mics placed so distances match MICS dl/dr
    geo = {"frame": "room corner origin, x along the longer wall, y along the shorter wall, z up, metres",
           "points": {"spk_left": [0, 0, 1], "spk_right": [2.4286, 1.0250, 1],
                      "mic1": [1.20, 0, 1], "mic2": [1.55, 0, 1], "mic3": [2.05, 0, 1]},
           "temp_c": 20}
    with tempfile.TemporaryDirectory() as tmp:
        gp = os.path.join(tmp, "geo.json")
        json.dump(geo, open(gp, "w"))
        ok = case(MICS[:2], rng, tmp, "2mic")
        ok &= case(MICS, rng, tmp, "3mic")
        # made-up geometry matches the 2-mic distances (dl 1.20/1.55, dr 1.60/1.35)
        ok &= case(MICS[:2], rng, tmp, "2mic-geo", gp)
    print("T1", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
