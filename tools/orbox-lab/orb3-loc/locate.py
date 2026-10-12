"""Locate where each sweep was played from, in 2D, from three synced recordings (O17).

usage: locate.py --sync sync.json --geometry geom.json --signal {beacon,probe} mic1.wav mic2.wav pi.wav
                 [--out events.json] [--sigma-us 50] [--mc 300]

Needs beacon_sync.py and beacon_gen.py (O9 v3) next to it. No sound is played.
Clock model (beacon_sync): arrival_k - arrival_1 = c0_k + b_k * arrival_1 + (g_k(source) - g_k(anchor)) + g_k(anchor)
with g_k(P) = (|M_k - P| - |M_1 - P|) / c. c0 mixes the clock offset a_k with the beacon speaker's own g, so a_k
needs that speaker's position: geometry point "spk_left" is the ANCHOR. With 3 mics in 2D the anchor cannot be solved for.
TDOA of a source for mic k (mic1 clock): tdoa_k = (t_k - t_1) - b_k t_1 - c0_k + g_k(anchor).
"""
import argparse
import json
import os
import numpy as np
import scipy.signal as ss
import scipy.ndimage as ndi
from scipy.optimize import least_squares

import beacon_gen as bg
import beacon_sync as bs

FS = bg.FS
BOX = (-2.0, 5.0, -2.0, 6.0)      # x0, x1, y0, y1, metres
GRID_M = 0.01
SIGMA_US = 50.0
AMBIG_REL, AMBIG_ADD = 2.0, 2.0   # AMBIGUOUS when a second minimum has chi2 <= (1 + AMBIG_REL) * best + AMBIG_ADD, i.e. 3x best + 2 (O18)
DIRECT_FRAC, DIRECT_BACK_S = 0.30, 0.030   # O18: earliest arrival at >= 30 % of the max, up to 30 ms before the max (beacon_sync keeps 50 % / 20 ms)
EPS_M = 0.003                     # distances use sqrt(d^2 + EPS^2): smooth at a mic, where |X - M| has no gradient
MIN_SEP_M = 0.30                  # two minima closer than this are one minimum
PROBE_T, PROBE_F1, PROBE_F2, PROBE_FADE = 2.0, 200.0, 7000.0, 0.02
CAND_RATIO = 12.0                 # candidate peak over the median of the smoothed matched filter
WIN_S = 0.12                      # search half-window around the predicted arrival
MERGE_S = 0.15
ROUND_GAP_S = 13.0                # probe sweeps closer than this belong to one round (11 s apart in a round)


def probe_sweep(fs=FS):
    """The map_gen.py sweep: 2 s exponential 200-7000 Hz, 20 ms linear fades."""
    t = np.arange(int(PROBE_T * fs)) / fs
    k = PROBE_T / np.log(PROBE_F2 / PROBE_F1)
    sw = np.sin(2 * np.pi * PROBE_F1 * k * (np.exp(t / k) - 1))
    n = int(PROBE_FADE * fs)
    w = np.ones_like(sw)
    w[:n] = np.linspace(0, 1, n)
    w[-n:] = np.linspace(1, 0, n)
    return sw * w


class Geo:
    def __init__(self, path, names, calibrated=False):
        g = json.load(open(path))
        p = {k: np.array(v, float)[:2] for k, v in g["points"].items() if v is not None}   # 2D: heights dropped
        for n in names + ([] if calibrated else ["spk_left"]):
            if n not in p:
                raise SystemExit(f"geometry lacks point '{n}'")
        self.mics = np.array([p[n] for n in names])
        self.anchor = p.get("spk_left")
        self.anchor_sigma = float(g.get("spk_left_sigma_m", 0.2))
        self.temp_c = float(g.get("temp_c", 24))
        self.c = bs.speed_of_sound(self.temp_c)


def gterm(mics, P, c):
    """(|M_k - P| - |M_1 - P|)/c for k = 2..N, one point P of shape (2,)."""
    d = np.sqrt((mics[:, 0] - P[0]) ** 2 + (mics[:, 1] - P[1]) ** 2 + EPS_M ** 2)
    return (d[1:] - d[0]) / c


# ---------------------------------------------------------------- solver
_grid_cache = {}


def _grid(mics, step, c):
    key = (mics.tobytes(), step, c)
    if key not in _grid_cache:
        xs = np.arange(BOX[0], BOX[1] + step / 2, step)
        ys = np.arange(BOX[2], BOX[3] + step / 2, step)
        X, Y = np.meshgrid(xs, ys, indexing="ij")
        d = np.stack([np.sqrt((X - m[0]) ** 2 + (Y - m[1]) ** 2 + EPS_M ** 2) for m in mics])
        _grid_cache[key] = (xs, ys, (d[1:] - d[0]) / c)
    return _grid_cache[key]


def _resid(p, mics, c, tdoa, sigma):
    return (gterm(mics, p, c) - tdoa) / sigma


def refine(p0, mics, c, tdoa, sigma):
    r = least_squares(_resid, np.clip(p0, [BOX[0], BOX[2]], [BOX[1], BOX[3]]), args=(mics, c, tdoa, sigma),
                      bounds=([BOX[0] - 2, BOX[2] - 2], [BOX[1] + 2, BOX[3] + 2]))
    return r.x, float(np.sum(r.fun ** 2))


def solve(tdoa, mics, c, sigma_s=SIGMA_US * 1e-6, step=GRID_M):
    """Grid search then local refine. Returns (best xy, chi2, second xy or None, second chi2, ambiguous)."""
    tdoa = np.asarray(tdoa, float)
    xs, ys, model = _grid(mics, step, c)
    cost = np.sum(((model - tdoa[:, None, None]) / sigma_s) ** 2, axis=0)
    size = max(3, int(MIN_SEP_M / step) | 1)
    is_min = cost == ndi.minimum_filter(cost, size=size, mode="nearest")
    ij = np.argwhere(is_min)
    order = np.argsort(cost[is_min])
    cands = []
    for q in ij[order][:12]:
        p, chi = refine(np.array([xs[q[0]], ys[q[1]]]), mics, c, tdoa, sigma_s)
        if all(np.hypot(*(p - o)) >= MIN_SEP_M for o, _ in cands):
            cands.append((p, chi))
    cands.sort(key=lambda t: t[1])
    best = cands[0]
    if len(cands) < 2:
        return best[0], best[1], None, None, False
    sec = cands[1]
    return best[0], best[1], sec[0], sec[1], bool(sec[1] <= (1 + AMBIG_REL) * best[1] + AMBIG_ADD)


def ellipse(samples):
    cov = np.cov(np.asarray(samples).T)
    w, v = np.linalg.eigh(cov)
    w = np.sqrt(np.maximum(w, 0))
    return {"major_m": float(w[1]), "minor_m": float(w[0]),
            "angle_deg": float(np.degrees(np.arctan2(v[1, 1], v[0, 1])) % 180)}


def monte_carlo(p, tdoa, mics, c, sigma_s, n, anchor_sigma, anchor, rng):
    """1-sigma ellipses: TDOA noise alone, and with the anchor position uncertain (a wrong anchor shifts a_k)."""
    s_noise, s_total = [], []
    base = gterm(mics, anchor, c)
    for _ in range(n):
        e = rng.normal(0, sigma_s, len(tdoa))
        s_noise.append(refine(p, mics, c, tdoa + e, sigma_s)[0])
        shift = gterm(mics, anchor + rng.normal(0, anchor_sigma, 2), c) - base
        s_total.append(refine(p, mics, c, tdoa + e + shift, sigma_s)[0])
    return ellipse(s_noise), ellipse(s_total)


# ---------------------------------------------------------------- detection
def candidates(x, ref):
    """Rough event times (s) of ref in x: peaks of the smoothed matched-filter magnitude."""
    B = 1 << 21
    out = []
    for s in range(0, len(x), B):
        seg = x[s:s + B + len(ref) - 1]
        if len(seg) < len(ref):
            break
        out.append(np.abs(ss.fftconvolve(seg, ref[::-1], mode="valid")))
    env = ndi.maximum_filter1d(np.concatenate(out), 480)
    pk, _ = ss.find_peaks(env, height=CAND_RATIO * np.median(env), distance=int(5 * FS))
    return pk / FS


def direct_arrival(x, ref, lo_s, hi_s, fs=FS):
    """Locator direct path (O18, R14 P4): of the matched-filter peaks within DIRECT_BACK_S before the window max, the earliest
    with envelope >= DIRECT_FRAC of the max. Returns (sample, {"ratio", "lead_ms", "early"}) or None. "early" is kept for
    walk_sync/locate callers: a peak >= GUARD_EARLY of the max before the chosen one cannot exist by construction, so it is False."""
    lo = max(0, int(lo_s * fs))
    hi = min(len(x), int(hi_s * fs) + len(ref))
    if hi - lo < len(ref) + 10:
        return None
    env = bs.matched_envelope(x[lo:hi], ref)
    g = int(np.argmax(env))
    if env[g] < bs.MIN_PEAK_RATIO * np.median(env):
        return None
    a = max(0, g - int(DIRECT_BACK_S * fs))
    seg = env[a:g + 1]
    pk, _ = ss.find_peaks(seg)
    cand = [int(a + q) for q in pk if seg[q] >= DIRECT_FRAC * env[g]]
    p = min(cand + [g])
    return lo + bs.parabolic(env, p), {"ratio": float(env[p] / env[g]), "lead_ms": float((g - p) / fs * 1e3), "early": False}


def level_db(x, a, dur):
    sos = ss.butter(4, (200.0, 7000.0), btype="bandpass", fs=FS, output="sos")
    k0 = max(0, int(a) - 2400)
    y = ss.sosfilt(sos, x[k0:int(a + dur * FS)])
    return float(10 * np.log10(np.mean(y ** 2) + 1e-20))


def detect_events(xs, names, sync, signal):
    """Events seen by every mic: {kind, t1, arr: {mic: sample}, info: {mic: {...}}}."""
    b = {n: sync["drift_ppm"].get(n, 0.0) * 1e-6 for n in names}
    c0 = {n: sync["c0_ms"].get(n, 0.0) * 1e-3 for n in names}
    if signal == "probe":
        kinds = [("probe", probe_sweep(), PROBE_T)]
    else:
        sw = bg.make_sweep()
        kinds = [("beacon", sw, bg.SWEEP_S), ("check", sw[::-1].copy(), bg.SWEEP_S)]
    events = []
    for kind, ref, dur in kinds:
        cl = sorted((t if n == names[0] else (t - c0[n]) / (1 + b[n])) for n in names for t in candidates(xs[n], ref))
        groups = []
        for t in cl:
            if groups and t - groups[-1][-1] < MERGE_S:
                groups[-1].append(t)
            else:
                groups.append([t])
        for g in groups:
            t1 = float(np.median(g))
            arr, info = {}, {}
            for n in names:
                pred = t1 if n == names[0] else t1 + b[n] * t1 + c0[n]
                r = direct_arrival(xs[n], ref, pred - WIN_S, pred + WIN_S)
                if r is None:
                    break
                arr[n], info[n] = r[0], dict(r[1], level_db=level_db(xs[n], r[0], dur))
            if len(arr) == len(names):
                events.append({"kind": kind, "t1": arr[names[0]] / FS, "arr": arr, "info": info})
    return sorted(events, key=lambda e: e["t1"])


def group_rounds(events, signal):
    """Probe: a sweep within ROUND_GAP_S of the previous one shares its round. Beacon: one round per event."""
    r, last = 0, None
    for e in events:
        if signal != "probe" or last is None or e["t1"] - last > ROUND_GAP_S:
            r += 1
        last = e["t1"]
        e["round"] = r
    return events


# ---------------------------------------------------------------- main
def parse_calib(text):
    """'1:mic1,2:mic2,3:pi' -> {1: 'mic1', 2: 'mic2', 3: 'pi'}"""
    return {int(k): v for k, v in (item.split(":") for item in text.split(","))}


def calibrate(ev, calib, names, mics, c, b, place_sigma_m, rng, n_draw=200):
    """Per-mic clock offset a_k from rounds with the phone at a known mic (ruling 1).
    est_r = mean over the round's sweeps of (t_k - t_1) - b_k t_1 - g_k(mic position). a = mean of est_r.
    Returns a, residual table, and n_draw alternative a's with the placement of each round off by place_sigma_m."""
    est, pos = [], []
    for r, mic in sorted(calib.items()):
        es = [e for e in ev if e["round"] == r]
        if not es:
            raise SystemExit(f"calibration round {r} has no events")
        P = mics[names.index(mic)]
        raw = np.mean([(np.array([e["arr"][n] / FS for n in names[1:]]) - e["t1"]) - b * e["t1"] for e in es], axis=0)
        est.append(raw - gterm(mics, P, c)); pos.append(P)
    est = np.array(est)
    a = est.mean(axis=0)
    resid = est - a
    alts = []
    for _ in range(n_draw):
        d = np.mean([gterm(mics, P, c) - gterm(mics, P + rng.normal(0, place_sigma_m / np.sqrt(2), 2), c) for P in pos], axis=0)
        alts.append(a + d)                         # offsets if the phone had really been off the mic by that much
    return a, resid, np.array(alts)


def monte_carlo_alt(p, raw, a_alts, mics, c, sigma_s, n, rng):
    """Ellipses for a calibrated event: TDOA noise alone, and noise plus a calibration-offset draw."""
    a0 = a_alts.mean(axis=0)
    s_noise, s_total = [], []
    for _ in range(n):
        e = rng.normal(0, sigma_s, len(raw))
        s_noise.append(refine(p, mics, c, raw - a0 + e, sigma_s)[0])
        s_total.append(refine(p, mics, c, raw - a_alts[rng.integers(len(a_alts))] + e, sigma_s)[0])
    return ellipse(s_noise), ellipse(s_total)


def run(wavs, sync, geo, signal, sigma_us=SIGMA_US, mc=300, seed=17, calib=None, place_sigma_m=0.10):
    names = [os.path.splitext(os.path.basename(p))[0] for p in wavs]
    if names != sync["mics"]:
        raise SystemExit(f"wav order {names} differs from sync.json mics {sync['mics']}")
    if calib and signal != "probe":
        raise SystemExit("--calib needs --signal probe")
    g = Geo(geo, names, calibrated=bool(calib))
    xs = {n: bs.load(p) for n, p in zip(names, wavs)}
    ev = group_rounds(detect_events(xs, names, sync, signal), signal)
    b = np.array([sync["drift_ppm"][n] * 1e-6 for n in names[1:]])
    c0 = np.array([sync["c0_ms"][n] * 1e-3 for n in names[1:]])
    rng = np.random.default_rng(seed)
    sig = sigma_us * 1e-6
    extra = {}
    if calib:
        a_off, resid, alts = calibrate(ev, parse_calib(calib) if isinstance(calib, str) else calib, names, g.mics, g.c, b, place_sigma_m, rng)
        extra["calibration"] = {"rounds": calib, "a_ms": {n: float(v * 1e3) for n, v in zip(names[1:], a_off)},
                                "resid_us": {n: [float(x * 1e6) for x in resid[:, i]] for i, n in enumerate(names[1:])},
                                "resid_rms_us": float(np.sqrt(np.mean(resid ** 2)) * 1e6), "resid_max_us": float(np.abs(resid).max() * 1e6),
                                "placement_sigma_m": place_sigma_m}
        if "c0_left_ms" in sync:                  # speakers from the calibrated offsets (ruling 2)
            sp = {}
            for side in ("left", "right"):
                gs = np.array([sync[f"c0_{side}_ms"][n] * 1e-3 for n in names[1:]]) - a_off
                p, chi, p2, chi2, amb = solve(gs, g.mics, g.c, sig)
                el, el_c = monte_carlo_alt(p, gs + a_off, alts, g.mics, g.c, sig, mc, rng)
                sp[side] = {"x": float(p[0]), "y": float(p[1]), "chi2": chi, "inconsistent": bool(chi > 9.0), "ambiguous": amb,
                            "alt": None if p2 is None else {"x": float(p2[0]), "y": float(p2[1]), "chi2": chi2},
                            "ellipse": el, "ellipse_with_calib": el_c}
            sp["separation_m"] = float(np.hypot(sp["left"]["x"] - sp["right"]["x"], sp["left"]["y"] - sp["right"]["y"]))
            extra["speakers"] = sp
    else:
        g_anchor = gterm(g.mics, g.anchor, g.c)
    out = []
    for e in ev:
        t1 = e["t1"]
        tk = np.array([e["arr"][n] / FS for n in names[1:]])
        raw = (tk - t1) - b * t1
        tdoa = raw - a_off if calib else raw - c0 + g_anchor
        p, chi, p2, chi2, amb = solve(tdoa, g.mics, g.c, sig)
        if calib:
            el, el_a = monte_carlo_alt(p, raw, alts, g.mics, g.c, sig, mc, rng)
        else:
            el, el_a = monte_carlo(p, tdoa, g.mics, g.c, sig, mc, g.anchor_sigma, g.anchor, rng)
        out.append({"id": (e["kind"][0].upper() if signal == "beacon" else "R") + str(e["round"]),
                    "kind": e["kind"], "round": e["round"], "t_s": t1, "x": float(p[0]), "y": float(p[1]),
                    "chi2": chi, "inconsistent": bool(chi > 9.0), "ellipse": el, "ellipse_with_anchor": el_a, "ambiguous": amb,
                    "alt": None if p2 is None else {"x": float(p2[0]), "y": float(p2[1]), "chi2": chi2},
                    "tdoa_us": {n: float(v * 1e6) for n, v in zip(names[1:], tdoa)},
                    "levels_db": {n: e["info"][n]["level_db"] for n in names},
                    "pick": {n: {"ratio": e["info"][n]["ratio"], "lead_ms": e["info"][n]["lead_ms"]} for n in names}})
    res = {"signal": signal, "mics": names, "c_mps": g.c, "temp_c": g.temp_c, "sigma_us": sigma_us, "dimension": "2D (heights ignored)",
           "mode": "calibrated" if calib else "anchor", "events": out}
    if not calib:
        res.update({"anchor": g.anchor.tolist(), "anchor_sigma_m": g.anchor_sigma})
    res.update(extra)
    return res


def text_report(res, mics_xy):
    names, evs = res["mics"], res["events"]
    labels = {"mic1": "M1", "mic2": "M2", "pi": "P"}
    rows = []
    if res["signal"] == "probe":
        for r in sorted({e["round"] for e in evs}):
            es = [e for e in evs if e["round"] == r]
            xy = np.mean([[e["x"], e["y"]] for e in es], axis=0)
            rows.append({"label": str(r), "x": xy[0], "y": xy[1], "n": len(es), "amb": any(e["ambiguous"] for e in es), "alt": next((e["alt"] for e in es if e["ambiguous"]), None), "bad": any(e["inconsistent"] for e in es),
                         "levels_db": {n: float(np.mean([e["levels_db"][n] for e in es])) for n in names},
                         "a": float(np.mean([e["ellipse_with_anchor"]["major_m"] for e in es])),
                         "b": float(np.mean([e["ellipse_with_anchor"]["minor_m"] for e in es]))})
    else:
        for e in evs:
            rows.append({"label": e["id"], "x": e["x"], "y": e["y"], "n": 1, "amb": e["ambiguous"], "alt": e["alt"] if e["ambiguous"] else None, "bad": e["inconsistent"], "levels_db": e["levels_db"],
                         "a": e["ellipse_with_anchor"]["major_m"], "b": e["ellipse_with_anchor"]["minor_m"]})
    pts = np.array([[r["x"], r["y"]] for r in rows] + mics_xy.tolist())
    x0, y0 = pts.min(axis=0) - 0.3
    x1, y1 = pts.max(axis=0) + 0.3
    grid = [["  "] * 10 for _ in range(10)]
    cell = lambda x, y: (min(9, int((x - x0) / (x1 - x0) * 10)), min(9, int((y - y0) / (y1 - y0) * 10)))
    for r in rows:
        i, j = cell(r["x"], r["y"])
        lab = r["label"][0] if res["signal"] == "beacon" else r["label"]
        grid[j][i] = lab.rjust(2) if grid[j][i] == "  " else "**"
    for n, m in zip(names, mics_xy):
        i, j = cell(*m)
        grid[j][i] = labels.get(n, n[:2]).rjust(2)
    lines = [f"Room 2D: x {x0:.2f}..{x1:.2f} m (right), y {y0:.2f}..{y1:.2f} m (up); cell {(x1 - x0) / 10:.2f} x {(y1 - y0) / 10:.2f} m; ** = several."]
    lines += ["|" + "".join(f"{c:>3}" for c in grid[j]) + " |" for j in range(9, -1, -1)]
    lines.append("mics: " + ", ".join(f"{n} ({m[0]:.2f},{m[1]:.2f})" for n, m in zip(names, mics_xy)))
    for r in rows:
        near = names[int(np.argmin(np.linalg.norm(mics_xy - np.array([r["x"], r["y"]]), axis=1)))]
        loud = max(r["levels_db"], key=r["levels_db"].get)
        lines.append(f"{r['label']:>4}: ({r['x']:+.2f}, {r['y']:+.2f}) m  1-sigma {r['a']:.2f} x {r['b']:.2f} m"
                     f"  nearest {near}  loudest {loud}{('  AMBIGUOUS: other root (%+.2f, %+.2f)' % (r['alt']['x'], r['alt']['y'])) if r['amb'] else ''}{'  INCONSISTENT (chi2>9: TDOAs outside what the geometry allows)' if r['bad'] else ''}")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("wavs", nargs="+")
    ap.add_argument("--sync", required=True)
    ap.add_argument("--geometry", required=True)
    ap.add_argument("--signal", choices=["beacon", "probe"], required=True)
    ap.add_argument("--out", default="events.json")
    ap.add_argument("--sigma-us", type=float, default=SIGMA_US)
    ap.add_argument("--mc", type=int, default=300)
    ap.add_argument("--calib", help="round:mic list, e.g. 1:mic1,2:mic2,3:pi (phone held at that mic); needs --signal probe")
    ap.add_argument("--place-sigma-m", type=float, default=0.10, help="1-sigma placement error of a calibration round")
    a = ap.parse_args(argv)
    res = run(a.wavs, json.load(open(a.sync)), a.geometry, a.signal, a.sigma_us, a.mc, calib=a.calib, place_sigma_m=a.place_sigma_m)
    json.dump(res, open(a.out, "w"), indent=1)
    print(text_report(res, Geo(a.geometry, res["mics"], calibrated=bool(a.calib)).mics))
    if "calibration" in res:
        c = res["calibration"]
        print(f"calibration: a_ms {c['a_ms']}  3-point residual rms {c['resid_rms_us']:.0f} us, max {c['resid_max_us']:.0f} us")
    for side, v in res.get("speakers", {}).items():
        if side != "separation_m":
            print(f"speaker {side}: ({v['x']:+.2f}, {v['y']:+.2f}) m  1-sigma with calib {v['ellipse_with_calib']['major_m']:.2f} x {v['ellipse_with_calib']['minor_m']:.2f}"
                  f"{('  AMBIGUOUS: other root (%+.2f, %+.2f)' % (v['alt']['x'], v['alt']['y'])) if v['ambiguous'] else ''}{'  INCONSISTENT' if v['inconsistent'] else ''}")
    if "speakers" in res:
        print(f"speaker separation {res['speakers']['separation_m']:.2f} m")
    return res


if __name__ == "__main__":
    main()
