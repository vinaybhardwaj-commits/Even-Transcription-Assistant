"""L2 helper: for every anchor P_L on a grid, solve the right speaker P_R from the check TDOAs; report the smallest |P_L - P_R| with chi2 <= 4."""
import json, sys, numpy as np, locate as L
d = json.load(open(sys.argv[1])); g = L.Geo(sys.argv[2], d["mics"]); sig = 50e-6
mean = lambda k, m: np.mean([e["tdoa_us"][m] for e in d["events"] if e["kind"] == k]) * 1e-6
gl0 = L.gterm(g.mics, g.anchor, g.c)                      # the anchor the json was made with
dtd = np.array([mean("check", m) - mean("beacon", m) for m in d["mics"][1:]])   # g_R - g_L, anchor independent
print("g_R - g_L (us):", dict(zip(d["mics"][1:], np.round(dtd * 1e6, 1))), " max |baseline tdoa| mic2:", round(2.44 / g.c * 1e6))
best = None
for x in np.arange(-2, 5.01, 0.1):
    for y in np.arange(-2, 6.01, 0.1):
        gl = L.gterm(g.mics, np.array([x, y]), g.c)
        p, chi, *_ = L.solve(gl + dtd, g.mics, g.c, sig, step=0.05)
        if chi <= 4 and (best is None or np.hypot(*(p - [x, y])) < best[0]):
            best = (float(np.hypot(*(p - [x, y]))), (round(x, 1), round(y, 1)), p.round(2).tolist())
print("smallest speaker separation over all anchors with a consistent right-speaker solution (m), P_L, P_R:", best)
# O18 L5: left speaker restricted to within 0.5 m of mic1 (V: speakers sit on the computer near mic1), 0.05 m grid
seps, fits, tot = [], [], 0
for x in np.arange(-0.5, 0.501, 0.05):
    for y in np.arange(-0.5, 0.501, 0.05):
        if np.hypot(x, y) > 0.5:
            continue
        tot += 1
        p, chi, *_ = L.solve(L.gterm(g.mics, np.array([x, y]), g.c) + dtd, g.mics, g.c, sig, step=0.05)
        if chi <= 4:
            seps.append(float(np.hypot(*(p - [x, y])))); fits.append((round(x, 2), round(y, 2), p.round(2).tolist()))
print(f"left within 0.5 m of mic1: {len(seps)} of {tot} spots fit (chi2<=4); separation min {min(seps):.2f} median {np.median(seps):.2f} max {max(seps):.2f} m" if seps else f"left within 0.5 m of mic1: 0 of {tot} spots fit")
