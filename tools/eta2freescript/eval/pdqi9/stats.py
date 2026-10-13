"""Paired statistics: Wilcoxon signed-rank (two-sided, zero differences dropped), Holm, rank-biserial, median difference.

Wilcoxon uses ONE pure-Python implementation; scipy is never imported, so the result is the same with or without it.
Zero differences are dropped first (zero_method "wilcox"). The method is chosen by an explicit rule (WILCOXON_EXACT_MAX_N):
  n <= 50 after dropping zeros: EXACT. Null distribution of W+ over the integer ranks 1..n. With ties the statistic can be a
    half-integer; as scipy does, it is rounded conservatively (floor for the upper tail, ceil for the lower tail), then
    p = min(1, 2 * min(P(W >= floor(W+)), P(W <= ceil(W+)))). Matches scipy 1.18.1 method="exact".
  n > 50: APPROX. Normal approximation with the tie correction and no continuity correction. Matches scipy 1.18.1
    method="approx", correction=False.
The result carries the method used ("exact" or "approx"; None when n == 0).
"""
from __future__ import annotations

import math
import statistics

WILCOXON_EXACT_MAX_N = 50


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


def _signed_rank_counts(n: int) -> list[int]:
    """counts[s] = number of sign assignments over ranks 1..n with W+ == s (exact integers)."""
    counts = [0] * (n * (n + 1) // 2 + 1)
    counts[0] = 1
    for r in range(1, n + 1):
        for s in range(len(counts) - 1, r - 1, -1):
            counts[s] += counts[s - r]
    return counts


def _wilcoxon_exact(w_plus: float, n: int) -> float:
    counts = _signed_rank_counts(n)
    upper = sum(counts[math.floor(w_plus):])        # P(W >= floor(W+))
    lower = sum(counts[: math.ceil(w_plus) + 1])    # P(W <= ceil(W+))
    return min(1.0, 2 * min(upper, lower) / 2 ** n)


def _wilcoxon_approx(w_plus: float, n: int, ties: list[int]) -> float:
    var = (n * (n + 1) * (2 * n + 1) - sum(t ** 3 - t for t in ties) / 2) / 24
    if var <= 0:
        return 1.0
    z = (w_plus - n * (n + 1) / 4) / math.sqrt(var)  # no continuity correction
    return min(1.0, math.erfc(abs(z) / math.sqrt(2)))


def wilcoxon(x: list[float], y: list[float]) -> dict:
    """Two-sided paired test of x against y. Returns n (non-zero pairs), statistic (min(W+, W-)), p and method.

    n == 0 gives statistic, p and method all None.
    """
    d = [v for v in paired_diffs(x, y) if v != 0]
    n = len(d)
    if not n:
        return {"n": 0, "statistic": None, "p": None, "method": None}
    ranks, ties = _ranks([abs(v) for v in d])
    w_plus = sum(r for r, v in zip(ranks, d) if v > 0)
    stat = min(w_plus, n * (n + 1) / 2 - w_plus)
    if n <= WILCOXON_EXACT_MAX_N:
        return {"n": n, "statistic": stat, "p": _wilcoxon_exact(w_plus, n), "method": "exact"}
    return {"n": n, "statistic": stat, "p": _wilcoxon_approx(w_plus, n, ties), "method": "approx"}


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
