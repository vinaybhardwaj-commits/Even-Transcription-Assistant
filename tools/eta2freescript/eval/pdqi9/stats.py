"""Paired statistics: Wilcoxon signed-rank (two-sided, zero differences dropped), Holm, rank-biserial, median difference.

scipy is used when importable; otherwise the exact (n <= 25, no ties) or tie-corrected normal approximation below.
"""
from __future__ import annotations

import math
import statistics

try:
    from scipy import stats as _sp
except Exception:  # pragma: no cover - exercised by tests through use_scipy=False
    _sp = None


def paired_diffs(x: list[float], y: list[float]) -> list[float]:
    if len(x) != len(y):
        raise ValueError("paired samples differ in length")
    return [a - b for a, b in zip(x, y)]


def _ranks(vals: list[float]) -> tuple[list[float], list[int]]:
    order = sorted(range(len(vals)), key=lambda i: vals[i])
    ranks, ties, i = [0.0] * len(vals), [], 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        ties.append(j - i + 1)
        i = j + 1
    return ranks, ties


def _wilcoxon_py(d: list[float]) -> tuple[float, float]:
    n = len(d)
    ranks, ties = _ranks([abs(v) for v in d])
    w_plus = sum(r for r, v in zip(ranks, d) if v > 0)
    w_minus = n * (n + 1) / 2 - w_plus
    stat = min(w_plus, w_minus)
    if n <= 25 and max(ties) == 1:
        # exact: count sign assignments with W+ <= stat (ranks are 1..n)
        counts = [0] * (n * (n + 1) // 2 + 1)
        counts[0] = 1
        for r in range(1, n + 1):
            for s in range(len(counts) - 1, r - 1, -1):
                counts[s] += counts[s - r]
        p = 2 * sum(counts[: int(stat) + 1]) / 2 ** n
        return stat, min(1.0, p)
    mean = n * (n + 1) / 4
    var = n * (n + 1) * (2 * n + 1) / 24 - sum(t ** 3 - t for t in ties) / 48
    if var <= 0:
        return stat, 1.0
    z = (abs(stat - mean) - 0.5 * 0) / math.sqrt(var)  # no continuity correction, as scipy's default
    return stat, min(1.0, math.erfc(z / math.sqrt(2)))


def wilcoxon(x: list[float], y: list[float], use_scipy: bool = True) -> dict:
    """Two-sided paired test of x against y. Returns n (non-zero pairs), statistic, p (None when n == 0)."""
    d = [v for v in paired_diffs(x, y) if v != 0]
    if not d:
        return {"n": 0, "statistic": None, "p": None}
    if use_scipy and _sp is not None:
        r = _sp.wilcoxon(d, zero_method="wilcox", alternative="two-sided", method="auto")
        return {"n": len(d), "statistic": float(r.statistic), "p": float(r.pvalue)}
    stat, p = _wilcoxon_py(d)
    return {"n": len(d), "statistic": stat, "p": p}


def holm(pvals: list[float | None]) -> list[float | None]:
    """Holm step-down adjusted p-values, input order kept. None entries are not tested and do not count in the family."""
    idx = [i for i, p in enumerate(pvals) if p is not None]
    order = sorted(idx, key=lambda i: pvals[i])
    m, out, run = len(order), [None] * len(pvals), 0.0
    for rank, i in enumerate(order):
        run = max(run, min(1.0, (m - rank) * pvals[i]))
        out[i] = run
    return out


def rank_biserial(x: list[float], y: list[float]) -> float | None:
    """Matched-pairs rank-biserial r = (W+ - W-) / (W+ + W-) over non-zero differences; positive means x > y."""
    d = [v for v in paired_diffs(x, y) if v != 0]
    if not d:
        return None
    ranks, _ = _ranks([abs(v) for v in d])
    wp = sum(r for r, v in zip(ranks, d) if v > 0)
    wm = sum(r for r, v in zip(ranks, d) if v < 0)
    return (wp - wm) / (wp + wm)


def median_diff(x: list[float], y: list[float]) -> float | None:
    d = paired_diffs(x, y)
    return statistics.median(d) if d else None


def mean_diff(x: list[float], y: list[float]) -> float | None:
    d = paired_diffs(x, y)
    return statistics.fmean(d) if d else None


def compare(x: list[float], y: list[float]) -> dict:
    w = wilcoxon(x, y)
    return {**w, "median_diff": median_diff(x, y), "mean_diff": mean_diff(x, y), "rank_biserial": rank_biserial(x, y)}
