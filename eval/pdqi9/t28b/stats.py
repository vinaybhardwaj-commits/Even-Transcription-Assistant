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


def cluster_bound(cluster_ids: list, fa: list[int], *, reps: int, seed: int) -> dict:
    """Cluster-robust 97.5% upper bound for one clustering, with flags.

    ALL trials enter the rate and the bootstrap; K_min only drives the flag.
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
    flags = []
    if eligible < K_MIN_CLUSTERS:
        flags.append("cluster_underpowered")
    out = {
        "clusters": len(keys),
        "clusters_ge_min_trials": eligible,
        "k": total_f,
        "n": total_n,
    }
    if total_f == 0:
        flags.append("cluster_degenerate")
        out["upper_975"] = exact_upper_one_sided(0, total_n)
        out["method"] = "exact"
    else:
        r = bca_upper(n_i, f_i, reps=reps, seed=seed)
        out.update({"upper_975": r["upper"], "z0": r["z0"], "accel": r["accel"], "method": "bca"})
    out["flags"] = flags
    return out


def coverage_sim(
    *, p: float, K: int, n_per: int, rhos: list[float], sims: int, reps: int, seed: int
) -> list[dict]:
    """Coverage of the one-sided 97.5% cluster bound under beta-binomial overdispersion.

    rho is the intra-cluster correlation. Used only to report coverage.
    """
    rng = np.random.default_rng(seed)
    results = []
    for rho in rhos:
        covered = 0
        for s in range(sims):
            if rho <= 0:
                p_i = np.full(K, p)
            else:
                a = p * (1 - rho) / rho
                b = (1 - p) * (1 - rho) / rho
                p_i = rng.beta(a, b, size=K)
            f_i = rng.binomial(n_per, p_i)
            n_i = np.full(K, n_per)
            if f_i.sum() == 0:
                up = exact_upper_one_sided(0, int(n_i.sum()))
            else:
                up = bca_upper(n_i, f_i, reps=reps, seed=int(rng.integers(0, 2**31 - 1)))["upper"]
            covered += up >= p
        results.append({"rho": rho, "coverage": covered / sims, "sims": sims})
    return results
