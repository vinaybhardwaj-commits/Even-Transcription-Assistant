"""Clock offset and drift between N audio recordings from a chirp beacon (v3).

usage: beacon_sync.py mic1.wav mic2.wav [micN.wav ...] [--duration 360]
                      [--geometry geo.json] [--usb-events file] [--out sync.json] [--legacy-s]
The first wav is the reference clock. Mic names are the wav basenames.

v3: an interference guard drops spoilt beacons before the fit, the fit rejects outliers (>50 us),
and each mic (the reference too) is re-detected with a sweep stretched by its own absolute drift
against the speaker clock, taken from the period of its beacon arrivals. Rule a of the guard counts
only as a second opinion. --legacy-s keeps the O9 fixed b*s step for comparison only.
"""
import argparse
import json
import os
import sys
import numpy as np
import soundfile as sf
import scipy.signal as ss

import beacon_gen as bg

VERSION = "v3"
FS = bg.FS
WIN_S = 1.5          # search half-window around the scheduled time
FIRST_SEARCH_S = 15  # first beacon is searched in [0, this] of the file
DIRECT_BACK_S = 0.020
DIRECT_FRAC = 0.5
MIN_PEAK_RATIO = 8.0  # global max must exceed this times the window median
OUTLIER_US = 50.0     # drop the beacon with the largest |residual| above this
MIN_BEACONS = 6
GUARD_PRE_S = 0.5     # pre-beacon level window
GUARD_BAND = (300.0, 8000.0)
GUARD_DB = 10.0       # rule (a): level above the mic's median pre-beacon level
GUARD_A_RESID_US = 20.0  # rule (a) alone is not enough: needs rule (b) or a first-fit residual over this
GUARD_CHOSEN = 0.7    # rule (b): chosen peak under this fraction of the max ...
GUARD_EARLY = 0.3     # ... and a peak at least this fraction sits within DIRECT_BACK_S before it
MAX_PASSES = 3
CONVERGED_PPM = 0.01


def matched_envelope(x, ref):
    """Envelope of the cross-correlation of x with ref. Index i = ref starts at sample i of x."""
    c = ss.fftconvolve(x, ref[::-1], mode="full")[len(ref) - 1:len(x)]
    return np.abs(ss.hilbert(c))


def parabolic(y, p):
    if p <= 0 or p >= len(y) - 1:
        return float(p)
    ym, y0, yp = y[p - 1], y[p], y[p + 1]
    den = ym - 2 * y0 + yp
    return float(p) if den == 0 else p + 0.5 * (ym - yp) / den


def arrival(x, ref, lo_s, hi_s, fs=FS):
    """(sub-sample arrival in samples of the file clock, info) of ref in x within [lo_s, hi_s], or None.

    info["ratio"] is the chosen peak over the window max; info["early"] is True when a peak of at
    least GUARD_EARLY of the max sits within DIRECT_BACK_S before the chosen one.
    """
    lo = max(0, int(lo_s * fs))
    hi = min(len(x), int(hi_s * fs) + len(ref))
    if hi - lo < len(ref) + 10:
        return None
    env = matched_envelope(x[lo:hi], ref)
    g = int(np.argmax(env))
    if env[g] < MIN_PEAK_RATIO * np.median(env):
        return None
    back = int(DIRECT_BACK_S * fs)
    a = max(0, g - back)
    seg = env[a:g + 1]
    pk, _ = ss.find_peaks(seg)
    cand = [int(a + q) for q in pk if seg[q] >= DIRECT_FRAC * env[g]]
    p = min(cand + [g])
    pre = env[max(0, p - back):p + 1]
    ppk, _ = ss.find_peaks(pre)
    early = bool(any(pre[q] >= GUARD_EARLY * env[g] for q in ppk if q < len(pre) - 1))
    return lo + parabolic(env, p), {"ratio": float(env[p] / env[g]), "early": early}


def load(path):
    x, fs = sf.read(path, dtype="float64")
    if fs != FS:
        raise SystemExit(f"{path}: sample rate {fs}, need {FS}")
    return x if x.ndim == 1 else x[:, 0]


def measure(x, sweep, check, n_beacons):
    """Per-beacon (arrival, info) lists for beacons and check chirps; None where missed."""
    b, c = [], []
    first = arrival(x, sweep, 0, FIRST_SEARCH_S)
    if first is None:
        return [None] * n_beacons, [None] * n_beacons
    t0 = first[0] / FS
    for i in range(n_beacons):
        sched = t0 + i * bg.PERIOD_S
        bi = arrival(x, sweep, sched - WIN_S, sched + WIN_S) if i else first
        ci = arrival(x, check, sched + bg.CHECK_DELAY_S - WIN_S, sched + bg.CHECK_DELAY_S + WIN_S)
        b.append(bi)
        c.append(ci)
    return b, c


def templates(stretch):
    """Sweep and check chirp as a clock reading `stretch` times true time holds them."""
    if stretch == 1.0:
        sweep = bg.make_sweep()
        return sweep, sweep[::-1].copy()
    return bg.make_sweep_stretched(stretch), bg.make_check_stretched(stretch)


def pos(m, i):
    return None if m[i] is None else m[i][0]


def pre_levels_db(x, arrivals):
    """Mean power (dB, 300-8000 Hz) in the GUARD_PRE_S before each arrival; None where missed."""
    sos = ss.butter(4, GUARD_BAND, btype="bandpass", fs=FS, output="sos")
    y = ss.sosfilt(sos, x)
    out = []
    for a in arrivals:
        if a is None:
            out.append(None)
            continue
        k1 = int(a)
        k0 = max(0, k1 - int(GUARD_PRE_S * FS))
        out.append(10 * np.log10(np.mean(y[k0:k1] ** 2) + 1e-20) if k1 - k0 > 100 else None)
    return out


def guard_rules(x, beacons):
    """({beacon: text} for rule a, {beacon: text} for rule b) for one mic."""
    arr = [None if m is None else m[0] for m in beacons]
    lv = pre_levels_db(x, arr)
    seen = [v for v in lv if v is not None]
    med = float(np.median(seen)) if seen else 0.0
    fa, fb = {}, {}
    for i, m in enumerate(beacons):
        if m is None:
            continue
        if lv[i] is not None and lv[i] > med + GUARD_DB:
            fa[i] = "a: pre-beacon level %.1f dB above median" % (lv[i] - med)
        if m[1]["ratio"] < GUARD_CHOSEN and m[1]["early"]:
            fb[i] = "b: chosen peak %.2f of max with an earlier peak >= %.1f of max" % (m[1]["ratio"], GUARD_EARLY)
    return fa, fb


def first_fit_resid_us(meas, names):
    """{mic: {beacon: |residual| us}} from a plain fit of each mic against the reference over all
    beacons. The reference gets the largest residual it shows in any pair."""
    ref = names[0]
    out = {n: {} for n in names}
    for n in names[1:]:
        idx = [i for i in range(len(meas[ref][0])) if meas[ref][0][i] is not None and meas[n][0][i] is not None]
        if len(idx) < 3:
            continue
        a1 = np.array([meas[ref][0][i][0] for i in idx]) / FS
        y = np.array([meas[n][0][i][0] for i in idx]) / FS - a1
        _, _, r = fit(a1, y)
        for i, v in zip(idx, np.abs(r) * 1e6):
            out[n][i] = float(v)
            out[ref][i] = max(out[ref].get(i, 0.0), float(v))
    return out


def guard(xs, meas, names):
    """({mic: {beacon: rule text}}, [rule-a-only beacons not confirmed]). Rule b always counts.
    Rule a counts when rule b also fires or the first-fit residual is over GUARD_A_RESID_US."""
    rs = first_fit_resid_us(meas, names)
    flags, a_only = {}, []
    for n in names:
        fa, fb = guard_rules(xs[n], meas[n][0])
        f = dict(fb)
        for i, t in fa.items():
            if i in fb:
                f[i] = t + "; " + fb[i]
            elif rs[n].get(i, 0.0) > GUARD_A_RESID_US:
                f[i] = t + "; first-fit residual %.0f us" % rs[n][i]
            else:
                a_only.append({"beacon": i, "mic": n, "rule": t, "first_fit_resid_us": rs[n].get(i)})
        flags[n] = f
    return flags, a_only


def abs_drift(m, banned):
    """e = slope of arrival (s) against i * PERIOD_S, minus 1: the mic's drift against the speaker
    clock. Beacons over OUTLIER_US from the line are dropped, worst first. None if under MIN_BEACONS."""
    idx = [i for i in range(len(m)) if m[i] is not None and i not in banned]
    while len(idx) >= MIN_BEACONS:
        x = np.array(idx, float) * bg.PERIOD_S
        y = np.array([m[i][0] for i in idx]) / FS
        slope, _, r = fit(x, y)
        w = int(np.argmax(np.abs(r)))
        if abs(r[w]) * 1e6 <= OUTLIER_US:
            return slope - 1.0
        idx = idx[:w] + idx[w + 1:]
    return None


def scale_bias_s(ref, eps=2e-4, fs=FS):
    """O9 fixed step, kept for --legacy-s: seconds of start-time bias per unit clock-rate error."""
    up = ss.resample_poly(ref, 16, 1)
    n = len(ref) + 2000
    pad = np.concatenate([up, np.zeros(16 * 2000)])
    t = np.arange(n) / (1.0 + eps) * 16
    x = np.interp(t, np.arange(len(pad)), pad)
    env = matched_envelope(np.concatenate([np.zeros(500), x]), ref)
    return (parabolic(env, int(np.argmax(env))) - 500) / fs / eps


def speed_of_sound(temp_c):
    return 331.3 + 0.606 * temp_c


def fit(x1, y):
    A = np.stack([x1, np.ones_like(x1)], axis=1)
    (b, c0), *_ = np.linalg.lstsq(A, y, rcond=None)
    r = y - (b * x1 + c0)
    return float(b), float(c0), r


def robust_fit(name, m_ref, m_n, banned):
    """Fit mic n against the reference, dropping the worst beacon while |resid| > OUTLIER_US.

    banned: beacon indices excluded before the fit (interfered). Returns a dict.
    """
    idx = [i for i in range(len(m_ref)) if i not in banned and m_ref[i] is not None and m_n[i] is not None]
    dropped = []
    while True:
        if len(idx) < MIN_BEACONS:
            return {"status": "too_few_beacons", "idx": idx, "dropped": dropped}
        a1 = np.array([m_ref[i][0] for i in idx]) / FS
        y = np.array([m_n[i][0] for i in idx]) / FS - a1
        b, c0, r = fit(a1, y)
        w = int(np.argmax(np.abs(r)))
        if abs(r[w]) * 1e6 <= OUTLIER_US:
            return {"status": "ok", "idx": idx, "dropped": dropped, "b": b, "c0": c0, "r": r, "a1": a1}
        dropped.append({"beacon": idx[w], "mic": name, "reason": "residual over %g us" % OUTLIER_US,
                        "resid_us": float(r[w] * 1e6)})
        idx = idx[:w] + idx[w + 1:]


def run(paths, duration=360, geometry=None, usb_events=None, legacy_s=False):
    names = [os.path.splitext(os.path.basename(p))[0] for p in paths]
    n_b = int(duration // bg.PERIOD_S)
    sweep, check = templates(1.0)
    xs = {n: load(p) for n, p in zip(names, paths)}
    ref = names[0]
    geo = None
    if geometry:
        geo = json.load(open(geometry))
        pts = {k: np.array(v, float) for k, v in geo["points"].items()}
        c_snd = speed_of_sound(geo.get("temp_c", 20))
        for n in names + ["spk_left", "spk_right"]:
            if n not in pts:
                raise SystemExit(f"geometry file lacks point '{n}'")

    def gterm(spk, n):
        return (np.linalg.norm(pts[n] - pts[spk]) - np.linalg.norm(pts[ref] - pts[spk])) / c_snd

    meas = {n: measure(xs[n], sweep, check, n_b) for n in names}      # pass 0: plain templates
    flags, a_only = guard(xs, meas, names)
    interfered = [{"beacon": i, "mic": n, "rule": r} for n in names for i, r in sorted(flags[n].items())]

    def fit_all():
        return {n: robust_fit(n, meas[ref][0], meas[n][0], set(flags[ref]) | set(flags[n])) for n in names[1:]}

    def abs_all():
        return {n: abs_drift(meas[n][0], set(flags[n])) for n in names}

    fits = fit_all()
    ppm = lambda d: {n: (None if v is None else v * 1e6) for n, v in d.items()}
    ab = abs_all()
    passes = [{"pass": 0, "stretch_ppm": None, "abs_drift_ppm": ppm(ab),
               "drift_ppm": {n: f["b"] * 1e6 for n, f in fits.items() if f["status"] == "ok"}}]
    if not legacy_s:
        for p in range(1, MAX_PASSES + 1):
            used = ab
            for n in names:
                sw, ck = templates(1.0 + (used[n] or 0.0))
                meas[n] = measure(xs[n], sw, ck, n_b)
            fits = fit_all()
            ab = abs_all()
            passes.append({"pass": p, "stretch_ppm": ppm(used), "abs_drift_ppm": ppm(ab),
                           "drift_ppm": {n: f["b"] * 1e6 for n, f in fits.items() if f["status"] == "ok"}})
            if all((ab[n] is None) == (used[n] is None) and
                   (ab[n] is None or abs(ab[n] - used[n]) * 1e6 < CONVERGED_PPM) for n in names):
                break
        s_b = s_c = None
    else:
        s_b, s_c = scale_bias_s(sweep), scale_bias_s(check)

    ok = [i for i in range(n_b) if all(meas[n][0][i] is not None for n in names)]
    bad = [n for n, f in fits.items() if f["status"] != "ok"]
    out = {"version": VERSION, "status": "ok" if not bad else "too_few_beacons",
           "mics": names, "ref": ref, "n_beacons": len(ok), "passes": passes,
           "dropped": [d for f in fits.values() if f["status"] == "ok" for d in f["dropped"]],
           "removed_before_stop": [d for f in fits.values() if f["status"] != "ok" for d in f["dropped"]],
           "interfered": interfered, "rule_a_unconfirmed": a_only, "abs_drift_ppm": ppm(ab),
           "legacy_s": legacy_s, "n_used": {}, "arrivals": {}, "mic_status": {n: f["status"] for n, f in fits.items()},
           "c0_ms": {}, "drift_ppm": {}, "resid_rms_us": {}, "resid_max_us": {},
           "check_tdoa_std_us": {}, "check_tdoa_range_us": {},
           "geometry": geo, "usb_events": [],
           "stretch_bias_s": {"beacon": s_b, "check": s_c}}
    for n in names:
        out["arrivals"][n] = {
            "beacon_samples": [pos(meas[n][0], i) for i in ok],
            "beacon_s": [pos(meas[n][0], i) / FS for i in ok],
            "check_samples": [pos(meas[n][1], i) for i in ok],
        }
    for n in names[1:]:
        f = fits[n]
        out["n_used"][n] = len(f["idx"])
        if f["status"] != "ok":
            for k in ("drift_ppm", "c0_ms", "resid_rms_us", "resid_max_us", "check_tdoa_std_us", "check_tdoa_range_us"):
                out[k][n] = None
            continue
        b, c0, r = f["b"], f["c0"], f["r"]
        if legacy_s:
            c0 -= b * s_b
        out["drift_ppm"][n] = b * 1e6
        out["c0_ms"][n] = c0 * 1e3
        out["resid_rms_us"][n] = float(np.sqrt(np.mean(r ** 2)) * 1e6)
        out["resid_max_us"][n] = float(np.abs(r).max() * 1e6)
        if geo:
            g = gterm("spk_left", n)
            out.setdefault("a_ms", {})[n] = (c0 - g) * 1e3
            out.setdefault("g_ms", {})[n] = g * 1e3
        else:
            out.setdefault("offset_note", {})[n] = "a and g UNSPLIT: c0 is their sum"
        ck = [i for i in f["idx"] if meas[ref][1][i] is not None and meas[n][1][i] is not None]
        if len(ck) >= 2:
            c1 = np.array([meas[ref][1][i][0] for i in ck]) / FS
            cd = np.array([meas[n][1][i][0] for i in ck]) / FS - c1 - b * c1
            if legacy_s:
                cd = cd - b * s_c
            out["check_tdoa_std_us"][n] = float(np.std(cd) * 1e6)
            out["check_tdoa_range_us"][n] = float((cd.max() - cd.min()) * 1e6)
            out.setdefault("check_n", {})[n] = len(ck)
            if geo:
                a = c0 - gterm("spk_left", n)
                pred = gterm("spk_right", n)
                out.setdefault("check_minus_predicted_us", {})[n] = float(np.mean(cd - a - pred) * 1e6)
        else:
            out["check_tdoa_std_us"][n] = None
            out["check_tdoa_range_us"][n] = None
    if usb_events and os.path.exists(usb_events):
        out["usb_events"] = [l.rstrip("\n") for l in open(usb_events) if l.strip()]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("wavs", nargs="+")
    ap.add_argument("--duration", type=float, default=360)
    ap.add_argument("--geometry")
    ap.add_argument("--usb-events")
    ap.add_argument("--out", default="sync.json")
    ap.add_argument("--legacy-s", action="store_true", help="O9 fixed b*s step, comparison only")
    a = ap.parse_args(argv)
    if len(a.wavs) < 2:
        raise SystemExit("need at least 2 wav files")
    res = run(a.wavs, a.duration, a.geometry, a.usb_events, a.legacy_s)
    json.dump(res, open(a.out, "w"), indent=1)
    for n in res["mics"][1:]:
        if res["mic_status"][n] != "ok":
            print(f"{n}: {res['mic_status'][n].upper()} ({res['n_used'][n]} beacons usable, need {MIN_BEACONS})")
            continue
        print(f"{n}: drift {res['drift_ppm'][n]:+.3f} ppm  abs {res['abs_drift_ppm'][n]:+.3f} ppm  c0 {res['c0_ms'][n]:+.4f} ms  "
              f"resid rms {res['resid_rms_us'][n]:.1f} us max {res['resid_max_us'][n]:.1f} us  "
              f"check std {res['check_tdoa_std_us'][n]} range {res['check_tdoa_range_us'][n]}")
    print(f"status {res['status']}  passes {[round(p['drift_ppm'].get(res['mics'][1], float('nan')), 4) for p in res['passes']]}  "
          f"n_beacons {res['n_beacons']}  dropped {len(res['dropped'])}  removed_before_stop {len(res['removed_before_stop'])}  interfered {len(res['interfered'])}  "
          f"usb_events {len(res['usb_events'])}")
    if res["status"] != "ok":
        sys.exit(2)
    return res


if __name__ == "__main__":
    main()
