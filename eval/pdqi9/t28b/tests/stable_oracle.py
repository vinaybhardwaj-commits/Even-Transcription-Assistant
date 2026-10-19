"""Independent, cancellation-free check of the T28b profile bound (refuter t28b-fix6-oref).

Beta-binomial ll at mean p, ICC rho, theta = rho/(1-rho), integer counts (binomial coeffs dropped):
  sum_i [ sum_{j<f_i} log(p + j theta) + sum_{j<n_i-f_i} log(1-p + j theta) - sum_{j<n_i} log1p(j theta) ]
              - (terms with theta factored out cancel exactly)
Exact identity: Gamma(x+k)/Gamma(x) = prod_{j<k}(x+j) with x = p/theta; dividing each product by
theta^k cancels between numerator and denominator (f + (n-f) = n). No gammaln, no cancellation,
continuous in rho down to 0 (rho=0 gives the binomial exactly).
Profile over rho in [0, 0.5]: dense log grid + bounded Brent; p: dense log scan + Brent; bound: brentq.
Nothing from eval/pdqi9/t28b is used for the maths.  Vendored test oracle. Run: python3 eval/pdqi9/t28b/tests/stable_oracle.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))))
import numpy as np
from scipy.optimize import brentq, minimize_scalar
from scipy.stats import chi2

THRESH = chi2.ppf(0.95, 1) / 2.0
_RG = np.concatenate(([0.0], np.geomspace(1e-9, 0.5, 300)))


def ll(p, rho, n, f):
    th = rho / (1.0 - rho)
    tot = 0.0
    for ni, fi in zip(n.astype(int), f.astype(int)):
        jf = np.arange(fi)
        jg = np.arange(ni - fi)
        jn = np.arange(ni)
        tot += np.log(p + jf * th).sum() + np.log1p(-p + jg * th).sum() - np.log1p(jn * th).sum()
    return float(tot)


def profile(p, n, f):
    vals = np.array([ll(p, r, n, f) for r in _RG])
    i = int(np.argmax(vals))
    best, br = float(vals[i]), float(_RG[i])
    lo, hi = float(_RG[max(i - 1, 0)]), float(_RG[min(i + 1, len(_RG) - 1)])
    r = minimize_scalar(lambda x: -ll(p, x, n, f), bounds=(lo, hi), method="bounded",
                        options={"xatol": 1e-13})
    if -r.fun > best:
        best, br = -float(r.fun), float(r.x)
    return best, br


def stable_upper(n, f):
    n = np.asarray(n, float); f = np.asarray(f, float)
    F, N = f.sum(), n.sum()
    if F == 0:
        p_hat, llm = 0.0, 0.0
    else:
        p0 = F / N
        g = np.geomspace(p0 / 30, min(p0 * 30, 0.99), 120)
        v = np.array([profile(x, n, f)[0] for x in g])
        i = int(np.argmax(v))
        r = minimize_scalar(lambda t: -profile(np.exp(t), n, f)[0],
                            bounds=(np.log(g[max(i - 1, 0)]), np.log(g[min(i + 1, len(g) - 1)])),
                            method="bounded", options={"xatol": 1e-10})
        p_hat, llm = float(np.exp(r.x)), -float(r.fun)
        if v[i] > llm:
            p_hat, llm = float(g[i]), float(v[i])
    thr = llm - THRESH
    hi = max(p_hat * 1.5, 1e-7)
    while profile(hi, n, f)[0] >= thr:
        hi *= 2
    lo = p_hat if F else 1e-14
    return float(brentq(lambda p: profile(p, n, f)[0] - thr, lo, hi, xtol=1e-15, rtol=1e-13)), p_hat, llm


CASES = [
    ("D1 zero events K15 x 2000", np.full(15, 2000.0), np.zeros(15)),
    ("D2 3 events in 3 of 20 x 137", np.full(20, 137.0),
     np.array([0] * 14 + [1] * 3 + [0] * 3, dtype=float)),
    ("D3 9 events, heterogeneous n", np.array([50., 64, 80, 100, 120, 150, 200, 300, 500, 750, 1000, 2000]),
     np.array([0., 1, 0, 2, 0, 0, 1, 0, 3, 0, 0, 2])),
    ("D4 zero events K30 x 150", np.full(30, 150.0), np.zeros(30)),
    ("D5 40 events K30 x 1000", np.full(30, 1000.0),
     np.array([0, 1, 0, 0, 3, 0, 2, 0, 0, 1, 0, 0, 0, 4, 0, 2, 0, 1, 0, 0, 3, 0, 0, 2, 0, 1, 0, 0, 5, 0],
              dtype=float)),
    ("D6 single event K20 x 137", np.full(20, 137.0), np.array([1.0] + [0.0] * 19)),
    ("D7 zero events K15 x 50 (floor scale)", np.full(15, 50.0), np.zeros(15)),
    ("D8 33 events all in one of 30 x 1000", np.full(30, 1000.0), np.array([33.0] + [0.0] * 29)),
    ("D9 3 events in one of 15 x 50", np.full(15, 50.0), np.array([3.0] + [0.0] * 14)),
]


def cases():
    return CASES


if __name__ == "__main__":
    from eval.pdqi9.t28b import stats as h
    worst = 0.0
    for name, n, f in cases():
        got = h.betabinom_profile_upper(n, f)
        exp, ph, llm = stable_upper(n, f)
        rel = abs(got["upper"] - exp) / exp
        worst = max(worst, rel)
        # the harness's own ll_max vs the stable likelihood at the harness's (p_hat, rho_hat)
        rh = got["rho_hat"]
        ll_true_at_h = ll(got["p_hat"], rh, n, f) if got["p_hat"] > 0 else 0.0
        print(f"{name}: harness {got['upper']:.10f} stable {exp:.10f} rel {rel:.3e} | "
              f"p_hat h {got['p_hat']:.6g} s {ph:.6g} | rho_hat h {rh:.3g} | "
              f"ll_max h {got['ll_max']:.6f} s {llm:.6f} stable-ll@h {ll_true_at_h:.6f}")
    print(f"WORST rel vs stable oracle: {worst:.3e} (ruling <= 1e-4) ->",
          "OK" if worst <= 1e-4 else "OUT OF TOLERANCE")
