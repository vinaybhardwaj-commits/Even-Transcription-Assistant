"""L3: ambiguity flag. A flagged source must have a second exact solution (re-checked by hand); an unflagged one must have none
(checked on a 0.1 m brute-force grid). The far side of the mic1-mic2 line is only sometimes ambiguous with the Pi off-axis."""
import numpy as np, locate as L
g = L.Geo("geom.json", ["mic1", "mic2", "pi"]); rng = np.random.default_rng(3); ok = []
def chk(name, good): ok.append(good); print(("PASS " if good else "FAIL ") + name)
tdoa = lambda P: L.gterm(g.mics, np.array(P, float), g.c)
def brute_second(P):
    """Another exact solution >= 0.3 m away, found independently: every 0.05 m grid cell within 300 us of the TDOAs is refined; a root has chi2 < 1."""
    xs, ys, model = L._grid(g.mics, 0.05, g.c)
    err = np.max(np.abs(model - tdoa(P)[:, None, None]), axis=0)
    X, Y = np.meshgrid(xs, ys, indexing="ij")
    far = (err < 300e-6) & (np.hypot(X - P[0], Y - P[1]) >= 0.3)
    for i, j in np.argwhere(far)[::3]:
        q, chi = L.refine(np.array([xs[i], ys[j]]), g.mics, g.c, tdoa(P), 50e-6)
        if chi < 1.0 and np.hypot(*(q - P)) >= 0.3:
            return True
    return False
cases = [(-1.0, -1.0), (3.5, -1.0), (1.22, -1.5), (0.3, -1.2), (2.2, -1.8), (1.22, 1.5), (0.8, 0.9), (1.7, 1.9)]
for P in cases:
    p, chi, p2, chi2, amb = L.solve(tdoa(P), g.mics, g.c)
    pn, _, _, _, ambn = L.solve(tdoa(P) + rng.normal(0, 50e-6, 2), g.mics, g.c)
    alt_ok = amb and p2 is not None and np.max(np.abs(tdoa(p2) - tdoa(P))) < 5e-6
    print(f"  {P}: best {p.round(2).tolist()} second {None if p2 is None else p2.round(2).tolist()} flag {amb} (with 50 us noise: {ambn}) brute-force second exists: {brute_second(P)}")
    chk(f"{P}: flag matches brute force" + (" and the alt reproduces the TDOAs" if amb else ""), amb == brute_second(P) and (alt_ok or not amb))
far = [(x, y) for x in np.arange(-1.5, 4.0, 0.5) for y in np.arange(-2.0, -0.4, 0.5)]
fl = [P for P in far if L.solve(tdoa(P), g.mics, g.c)[4]]
print(f"  far side grid (y < 0, 0.5 m steps): {len(fl)} of {len(far)} flagged; flagged x range {min(p[0] for p in fl):.1f}..{max(p[0] for p in fl):.1f}" if fl else "  none flagged")
chk("at least one far-side source is flagged", len(fl) > 0)
print("L3", "PASS" if all(ok) else "FAIL")
