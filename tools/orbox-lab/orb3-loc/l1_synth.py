"""L1: 15 sources (10 inside the mic triangle, 5 outside) through the full chain: render 3 mics -> beacon_sync -> locate.

usage: l1_synth.py OUT_DIR [--anchor-err-x 0.0 --anchor-err-y 0.0]    (true left speaker = geometry spk_left + error)
Render: tau_k = (1+eps_k)(T + d_k/c) + o_k, analytic signals (no resampling), per-mic RT60 0.5 s reverb (direct-to-reverb -3 dB,
reflections from 5 ms, as O10), 1/d level, white noise. Sources are at mic height (2D truth).
"""
import argparse, json, os, sys, time
import numpy as np, scipy.signal as ss, soundfile as sf
import beacon_gen as bg, beacon_sync as bs, locate as L

FS, RT60, DR_DB = bg.FS, 0.5, -3.0
DUR = 450
CLK = {"mic1": (+7.300e-3, +38e-6), "mic2": (-2.150e-3, -21e-6), "pi": (-1.0814, +5e-6)}   # start offset s, drift
INSIDE = [(1.22, 0.5), (1.22, 1.5), (1.22, 2.6), (0.5, 0.4), (1.9, 0.4), (0.9, 1.2), (1.55, 1.2), (1.22, 0.15), (0.75, 1.9), (1.7, 1.9)]
OUTSIDE = [(-1.0, -1.0), (3.5, -1.0), (4.0, 3.0), (-1.2, 3.0), (1.2, 5.0)]
PROBE_AMP = 0.25


def probe_u(u):
    """Analytic map_gen sweep at source times u (s since its start)."""
    k = L.PROBE_T / np.log(L.PROBE_F2 / L.PROBE_F1)
    inside = (u >= 0) & (u < L.PROBE_T)
    uu = np.where(inside, u, 0.0)
    w = np.minimum(1.0, np.minimum(uu, L.PROBE_T - uu) / L.PROBE_FADE)
    return np.where(inside, PROBE_AMP * w * np.sin(2 * np.pi * L.PROBE_F1 * k * (np.exp(uu / k) - 1)), 0.0)


def beacon_u(u): return bg.sweep_at(u)
def check_u(u): return bg.sweep_at((int(round(bg.SWEEP_S * FS)) - 1) / FS - u)


def reverb_tail(rng):
    n = int(RT60 * FS)
    t = np.arange(n) / FS
    h = rng.standard_normal(n) * np.exp(-6.9078 * t / RT60)
    h[:int(0.005 * FS)] = 0.0
    return h * np.sqrt(10 ** (-DR_DB / 10) / np.sum(h ** 2))


def render(events, mic_xy, name, c, rng, n_out):
    o, eps = CLK[name]
    out = np.zeros(n_out)
    for fn, T, dur, P in events:
        d = float(np.hypot(*(np.array(P) - mic_xy)))
        k0 = int(((1 + eps) * (T + d / c) + o) * FS) - 4
        k = np.arange(k0, k0 + int(dur * (1 + eps) * FS) + 8)
        u = ((k / FS - o) / (1 + eps)) - d / c - T
        direct = fn(u) / max(d, 0.3)
        sig = direct + ss.fftconvolve(direct, reverb_tail(rng))[:len(k)]
        sel = (k >= 0) & (k < n_out)
        out[k[sel]] += sig[sel]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--geometry", default="geom.json")
    ap.add_argument("--anchor-err", type=float, nargs=2, default=[0.0, 0.0])
    ap.add_argument("--mc", type=int, default=100)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    names = ["mic1", "mic2", "pi"]
    g = L.Geo(a.geometry, names)
    rng = np.random.default_rng(10)
    pl = g.anchor + np.array(a.anchor_err)                 # true left speaker
    pr = np.array(json.load(open(a.geometry))["points"]["spk_right"][:2])
    pts = INSIDE + OUTSIDE
    ev = []
    for i in range(DUR // 30):
        tb = 3.0 + 30.0 * i
        ev += [(beacon_u, tb, bg.SWEEP_S, pl), (check_u, tb + 15, bg.SWEEP_S, pr)]
    probes = []
    for i, P in enumerate(pts):
        T = 3.0 + 30.0 * i + 7.0
        ev.append((probe_u, T, L.PROBE_T, P)); probes.append((T, P))
    n_out = int((DUR + 10) * FS)
    paths = []
    for n, m in zip(names, g.mics):
        x = render(ev, m, n, g.c, rng, n_out)
        x += rng.standard_normal(n_out) * 0.002
        p = os.path.join(a.out, n + ".wav"); sf.write(p, np.clip(x, -1, 1), FS, subtype="PCM_16"); paths.append(p)
    sync = bs.run(paths, DUR)
    json.dump(sync, open(os.path.join(a.out, "sync.json"), "w"))
    print(f"sync: status {sync['status']} n_beacons {sync['n_beacons']} drift {sync['drift_ppm']} resid_rms_us {sync['resid_rms_us']}")
    res = L.run(paths, sync, a.geometry, "probe", mc=a.mc)
    json.dump(res, open(os.path.join(a.out, "events.json"), "w"), indent=1)
    errs = []
    print(f"{'pt':>3} {'where':7} {'truth':>14} {'est':>14} {'err m':>6} {'1s major/minor':>15} {'amb'}")
    for i, (T, P) in enumerate(probes):
        e = [e for e in res["events"] if abs(e["t_s"] - (g_arr(T, g, names, P))) < 0.5]
        if not e:
            print(f"{i + 1:>3} {'in' if i < 10 else 'out':7} {str(P):>14}  NOT FOUND"); errs.append(np.nan); continue
        e = e[0]; err = float(np.hypot(e["x"] - P[0], e["y"] - P[1])); errs.append(err)
        el = e["ellipse_with_anchor"]
        print(f"{i + 1:>3} {'in' if i < 10 else 'out':7} {str(P):>14} {(round(e['x'], 2), round(e['y'], 2))!s:>14} {err:6.3f} {el['major_m']:7.2f}/{el['minor_m']:.2f} {'AMBIG' if e['ambiguous'] else ''}")
    errs = np.array(errs)
    print(f"median error: all {np.nanmedian(errs):.3f} m, inside {np.nanmedian(errs[:10]):.3f} m, outside {np.nanmedian(errs[10:]):.3f} m; "
          f"not found {int(np.isnan(errs).sum())}; extra events {len(res['events']) - int((~np.isnan(errs)).sum())}")


def g_arr(T, g, names, P):
    """Mic1-file time of a source started at true time T."""
    o, eps = CLK["mic1"]
    return (1 + eps) * (T + float(np.hypot(*(np.array(P) - g.mics[0]))) / g.c) + o


if __name__ == "__main__":
    main()
