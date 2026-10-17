"""Exact and cluster-robust statistics for the T28b harness. Pure computation, no I/O."""
from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np

_N = NormalDist()

K_MIN_CLUSTERS = 15
MIN_TRIALS_PER_CLUSTER = 50


def _betacf(a: float, b: float, x: float) -> float:
    tiny = 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    d = tiny if abs(d) < tiny else d
    d = 1.0 / d
    h = d
    for m in range(1, 10000):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        d = tiny if abs(d) < tiny else d
        c = 1.0 + aa / c
        c = tiny if abs(c) < tiny else c
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        d = tiny if abs(d) < tiny else d
        c = 1.0 + aa / c
        c = tiny if abs(c) < tiny else c
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-15:
            break
    return h


def betainc(a: float, b: float, x: float) -> float:
    """Regularised incomplete beta I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    ln_front = (
        math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
        + a * math.log(x) + b * math.log1p(-x)
    )
    front = math.exp(ln_front)
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1.0 - x) / b


def beta_ppf(q: float, a: float, b: float) -> float:
    lo, hi = 0.0, 1.0
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if betainc(a, b, mid) < q:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-16:
            break
    return (lo + hi) / 2.0


def clopper_pearson(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Exact two-sided (1 - alpha) interval."""
    if n <= 0:
        return (0.0, 1.0)
    lo = 0.0 if k == 0 else beta_ppf(alpha / 2.0, k, n - k + 1)
    hi = 1.0 if k == n else beta_ppf(1.0 - alpha / 2.0, k + 1, n - k)
    return (lo, hi)


def exact_upper_one_sided(k: int, n: int, alpha: float = 0.025) -> float:
    """Exact one-sided upper bound at confidence 1 - alpha (default 97.5%)."""
    if n <= 0 or k >= n:
        return 1.0
    return beta_ppf(1.0 - alpha, k + 1, n - k)


def summarise(k: int, n: int) -> dict:
    lo, hi = clopper_pearson(k, n)
    return {
        "k": k,
        "n": n,
        "point": (k / n) if n else float("nan"),
        "cp95_lo": lo,
        "cp95_hi": hi,
        "exact_upper_975_one_sided": exact_upper_one_sided(k, n),
    }


def bca_upper(
    n_i: np.ndarray, f_i: np.ndarray, *, reps: int, seed: int, conf: float = 0.975
) -> dict:
    """Cluster BCa one-sided upper bound for the pooled rate sum(f)/sum(n)."""
    n_i = np.asarray(n_i, dtype=float)
    f_i = np.asarray(f_i, dtype=float)
    K = len(n_i)
    N, F = n_i.sum(), f_i.sum()
    theta = F / N
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, K, size=(reps, K))
    boot = f_i[idx].sum(axis=1) / n_i[idx].sum(axis=1)
    less = float((boot < theta).sum()) + 0.5 * float((boot == theta).sum())
    prop = min(max(less / reps, 0.5 / reps), 1.0 - 0.5 / reps)
    z0 = _N.inv_cdf(prop)
    jack = np.array([(F - f_i[i]) / (N - n_i[i]) if N - n_i[i] > 0 else theta for i in range(K)])
    d = jack.mean() - jack
    denom = 6.0 * (float((d ** 2).sum()) ** 1.5)
    a = float((d ** 3).sum()) / denom if denom > 0 else 0.0
    zc = _N.inv_cdf(conf)
    w = z0 + zc
    adj = _N.cdf(z0 + w / (1.0 - a * w)) if (1.0 - a * w) > 0 else conf
    return {
        "upper": float(np.quantile(boot, min(max(adj, 0.0), 1.0))),
        "point": float(theta),
        "z0": float(z0),
        "accel": a,
        "clusters": K,
    }


# ---------------------------------------------------------------- beta-binomial profile likelihood

METHOD = "betabinom_profile_v1"
CHI2_95_HALF = 1.9207294103470620  # chi2.ppf(0.95, 1) / 2: the 0.95 two-sided profile, upper end = one-sided 97.5%
RHO_MAX = 0.5
_RHO_GRID = np.concatenate(([0.0], np.geomspace(1e-6, RHO_MAX, 60)))
_HALF_LN_2PI = 0.5 * math.log(2.0 * math.pi)
RHO_POLISH_XATOL = 1e-10  # polish tolerance, in log rho

try:
    from scipy.optimize import minimize_scalar as _MINIMIZE_SCALAR
except ImportError:  # pragma: no cover - golden section below covers this
    _MINIMIZE_SCALAR = None


def gammaln(x):
    """Vectorised log-gamma for x > 0: lnG(x) = lnG(x + 8) - ln(x (x+1) ... (x+7)), Stirling at x + 8."""
    y = np.asarray(x, dtype=float)
    prod = y.copy()
    for j in range(1, 8):
        prod = prod * (y + j)
    w = y + 8.0
    inv = 1.0 / w
    inv2 = inv * inv
    series = inv * (1.0 / 12.0 - inv2 * (1.0 / 360.0 - inv2 * (1.0 / 1260.0)))
    return (w - 0.5) * np.log(w) - w + _HALF_LN_2PI + series - np.log(prod)


def _ll_over_rho(p: float, n: np.ndarray, f: np.ndarray, rho: np.ndarray) -> np.ndarray:
    """Beta-binomial log-likelihood (binomial coefficients dropped) at mean p for each rho. rho=0 is binomial."""
    out = np.empty(len(rho))
    pos = rho > 0
    if pos.any():
        r = rho[pos][:, None]
        s = (1.0 - r) / r
        a, b = p * s, (1.0 - p) * s
        per_cluster = gammaln(f + a) + gammaln(n - f + b) - gammaln(n + s)
        out[pos] = per_cluster.sum(axis=1) - len(n) * (gammaln(a) + gammaln(b) - gammaln(s))[:, 0]
    if not pos.all():
        out[~pos] = float((f * math.log(p) + (n - f) * math.log1p(-p)).sum())
    return out


def _ll_scalar(p: float, n, f, rho: float) -> float:
    return float(_ll_over_rho(p, n, f, np.array([rho]))[0])


def _max_rho_log(p: float, n, f, t_lo: float, t_hi: float) -> tuple[float, float]:
    """(max of ll(p, exp t) for t in [t_lo, t_hi], the t attaining it). Bounded 1-D maximiser with
    xatol RHO_POLISH_XATOL in log rho: scipy bounded Brent when available, else golden section."""
    def neg_ll(t: float) -> float:
        return -_ll_scalar(p, n, f, math.exp(t))
    if _MINIMIZE_SCALAR is not None:
        res = _MINIMIZE_SCALAR(neg_ll, bounds=(t_lo, t_hi), method="bounded",
                               options={"xatol": RHO_POLISH_XATOL})
        return -float(res.fun), float(res.x)
    gr = (math.sqrt(5.0) - 1.0) / 2.0
    c, d = t_hi - gr * (t_hi - t_lo), t_lo + gr * (t_hi - t_lo)
    fc, fd = neg_ll(c), neg_ll(d)
    for _ in range(300):
        if t_hi - t_lo <= RHO_POLISH_XATOL:
            break
        if fc < fd:
            t_hi, d, fd = d, c, fc
            c = t_hi - gr * (t_hi - t_lo)
            fc = neg_ll(c)
        else:
            t_lo, c, fc = c, d, fd
            d = t_lo + gr * (t_hi - t_lo)
            fd = neg_ll(d)
    t = (t_lo + t_hi) / 2.0
    return -neg_ll(t), t


def _profile(p: float, n, f) -> tuple[float, float]:
    """(max over rho in [0, 0.5] of the log-likelihood at p, the rho that attains it).

    Grid argmax on _RHO_GRID, then a bounded 1-D polish (xatol 1e-10 in log rho) on the
    bracketing neighbours. The bracket endpoints (and rho = 0 when the grid argmax is 0)
    stay candidates: the bounded maximiser certifies interior points only, and a boundary
    maximum (e.g. the zero-event edge at rho = 0.5) must be returned exactly.
    """
    pc = min(max(p, 1e-300), 1.0 - 1e-12)
    g = _RHO_GRID
    ll = _ll_over_rho(pc, n, f, g)
    i = int(np.argmax(ll))
    if i <= 1:  # rho = 0 (or its first neighbour) is the grid argmax: keep 0 as a candidate
        lo_b, hi_b = g[1], g[2]
        cands = [(0.0, float(ll[0]))]
    elif i == len(g) - 1:
        lo_b, hi_b = g[i - 1], g[i]
        cands = []
    else:
        lo_b, hi_b = g[i - 1], g[i + 1]
        cands = []
    v, t = _max_rho_log(pc, n, f, math.log(lo_b), math.log(hi_b))
    cands.append((math.exp(t), v))
    cands.append((float(lo_b), _ll_scalar(pc, n, f, lo_b)))
    cands.append((float(hi_b), _ll_scalar(pc, n, f, hi_b)))
    best_r, best_ll = max(cands, key=lambda cr: cr[1])
    return best_ll, best_r


def betabinom_profile_upper(n_i, f_i) -> dict:
    """One-sided 97.5% upper bound for the pooled mean p: the largest p whose profile log-likelihood
    is within chi2(1, 0.95)/2 of the maximum. Zero events are handled by the same profile (p_hat = 0)."""
    n = np.asarray(n_i, dtype=float)
    f = np.asarray(f_i, dtype=float)
    F, N = float(f.sum()), float(n.sum())
    if F == 0.0:
        p_hat, ll_max, rho_hat = 0.0, 0.0, float("nan")
    else:
        p0 = min(max(F / N, 1e-9), 0.99)
        grid = np.geomspace(p0 / 20.0, min(p0 * 20.0, 0.9999), 20)
        vals = [_profile(g, n, f)[0] for g in grid]
        i = int(np.argmax(vals))
        lo, hi = grid[max(i - 1, 0)], grid[min(i + 1, len(grid) - 1)]
        gr = (math.sqrt(5.0) - 1.0) / 2.0
        c, d = hi - gr * (hi - lo), lo + gr * (hi - lo)
        fc, fd = _profile(c, n, f)[0], _profile(d, n, f)[0]
        for _ in range(40):
            if fc > fd:
                hi, d, fd = d, c, fc
                c = hi - gr * (hi - lo)
                fc = _profile(c, n, f)[0]
            else:
                lo, c, fc = c, d, fd
                d = lo + gr * (hi - lo)
                fd = _profile(d, n, f)[0]
        p_hat = (lo + hi) / 2.0
        ll_max, rho_hat = _profile(p_hat, n, f)
    thr = ll_max - CHI2_95_HALF
    lo, hi = p_hat, max(p_hat * 1.5, 1e-6)
    cap = 1.0 - 1e-9
    while _profile(hi, n, f)[0] >= thr:
        lo = hi
        if hi >= cap:
            return {"upper": 1.0, "p_hat": p_hat, "rho_hat": rho_hat, "rho_at_upper": None, "ll_max": ll_max}
        hi = min(hi * 2.0, cap)
    for _ in range(40):
        mid = (lo + hi) / 2.0
        if _profile(mid, n, f)[0] >= thr:
            lo = mid
        else:
            hi = mid
    return {"upper": lo, "p_hat": p_hat, "rho_hat": rho_hat, "rho_at_upper": _profile(lo, n, f)[1],
            "ll_max": ll_max}


def boot_t_upper(n_i, f_i, *, reps: int, seed: int, conf: float = 0.975) -> float | None:
    """Cluster bootstrap-t one-sided upper bound (reported only). None when the SE is zero (no events)."""
    n_i = np.asarray(n_i, dtype=float)
    f_i = np.asarray(f_i, dtype=float)
    K = len(n_i)
    if K < 2:
        return None
    N, F = n_i.sum(), f_i.sum()
    theta = F / N
    se_hat = math.sqrt(K / (K - 1.0) * float(((f_i - theta * n_i) ** 2).sum())) / N
    if se_hat == 0.0:
        return None
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, K, size=(reps, K))
    fb, nb = f_i[idx], n_i[idx]
    th = fb.sum(axis=1) / nb.sum(axis=1)
    se = np.sqrt(K / (K - 1.0) * ((fb - th[:, None] * nb) ** 2).sum(axis=1)) / nb.sum(axis=1)
    ok = se > 0
    if not ok.any():
        return None
    t = (th[ok] - theta) / se[ok]
    return float(theta - np.quantile(t, 1.0 - conf) * se_hat)


def cluster_bound(cluster_ids: list, fa: list[int], *, reps: int, seed: int, floor: int | None) -> dict:
    """Gating cluster-robust 97.5% upper bound for one clustering (beta-binomial profile likelihood).

    ALL trials enter the rate. A clustering with fewer than `floor` clusters of at least
    MIN_TRIALS_PER_CLUSTER trials (floor None) is UNDERPOWERED: no gating bound, and the exact
    Clopper-Pearson bound is returned for information only. BCa and bootstrap-t are reported-only columns.
    """
    counts: dict = {}
    for c, f in zip(cluster_ids, fa):
        n_f = counts.setdefault(c, [0, 0])
        n_f[0] += 1
        n_f[1] += int(f)
    keys = sorted(counts, key=str)
    n_i = np.array([counts[k][0] for k in keys])
    f_i = np.array([counts[k][1] for k in keys])
    total_n, total_f = int(n_i.sum()), int(f_i.sum())
    eligible = int((n_i >= MIN_TRIALS_PER_CLUSTER).sum())
    out = {"clusters": len(keys), "clusters_ge_min_trials": eligible, "k": total_f, "n": total_n,
           "floor": floor, "exact_info_975": exact_upper_one_sided(total_f, total_n)}
    if floor is None or eligible < max(floor, 2):
        out.update({"underpowered": True, "upper_975": None, "method": "none",
                    "flags": ["cluster_underpowered"]})
        return out
    prof = betabinom_profile_upper(n_i, f_i)
    out.update({"underpowered": False, "upper_975": prof["upper"], "method": METHOD,
                "p_hat": prof["p_hat"], "rho_hat": prof["rho_hat"], "rho_at_upper": prof["rho_at_upper"],
                "bca_975": bca_upper(n_i, f_i, reps=reps, seed=seed)["upper"] if total_f else None,
                "boot_t_975": boot_t_upper(n_i, f_i, reps=reps, seed=seed),
                "flags": ["cluster_degenerate"] if total_f == 0 else []})
    return out


def coverage_sim(*, p: float, K: int, n_per: int, rhos: list[float], sims: int, seed: int,
                 reps: int = 500, method: str = "profile") -> list[dict]:
    """Coverage of the one-sided 97.5% bound under beta-binomial overdispersion (ICC rho), K doctors of
    n_per trials each. method "profile" is the gating bound; "bca" is the reported-only one."""
    rng = np.random.default_rng(seed)
    results = []
    n_i = np.full(K, n_per)
    for rho in rhos:
        covered = 0
        for _ in range(sims):
            if rho <= 0:
                p_i = np.full(K, p)
            else:
                a = p * (1 - rho) / rho
                b = (1 - p) * (1 - rho) / rho
                p_i = rng.beta(a, b, size=K)
            f_i = rng.binomial(n_per, p_i)
            if method == "profile":
                up = betabinom_profile_upper(n_i, f_i)["upper"]
            elif f_i.sum() == 0:
                up = exact_upper_one_sided(0, int(n_i.sum()))
            else:
                up = bca_upper(n_i, f_i, reps=reps, seed=int(rng.integers(0, 2**31 - 1)))["upper"]
            covered += up >= p
        results.append({"rho": rho, "coverage": covered / sims, "sims": sims})
    return results
