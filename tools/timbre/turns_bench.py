"""Benchmarks B1-B4 on per-turn timbre scores (how-to section 5). Plain Python, no numpy.

Input: the per-turn JSONL written by ``turns.py score`` (kind=meta then kind=turn rows).
Output: a results dict. Numbers only; no text, no ids beyond bench ids.

B1  split-half: each person's odd turns against even turns; Spearman across persons,
    per feature and role. Feature passes at >= 0.4 (turns.SPLIT_HALF_MIN).
B2  Odyssey against audEERING per turn (arousal, valence, dominance), per role.
B3  gold batch 1: turn scores aggregated onto labelled windows, Spearman against the rating.
    Needs a window map (bench_id, t0_s, t1_s, arousal, valence) built on the analysis box.
B4  role separation: per-role distributions of person medians, with a Kruskal-style rank
    statistic (sanity check, not a target).
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

from tools.timbre import turns as T

SEED = 20261014
NBOOT = 1000
ROLE_GROUPS = ("doctor", "patient", "other", "all")


def load_scores(path):
    meta, rows = None, []
    for line in Path(path).read_text().splitlines():
        if not line.strip():
            continue
        d = json.loads(line)
        if d.get("kind") == "meta":
            meta = d
        elif d.get("kind") == "turn":
            rows.append(d)
    return meta, rows


def features_in(rows):
    return sorted({k for r in rows for k in (r.get("scores") or {})})


def persons(rows):
    out = {}
    for r in rows:
        out.setdefault((r["bench_id"], r["speaker"]), []).append(r)
    return out


def _role_of(turn_rows):
    return turn_rows[0].get("role", "unknown")


def _in_group(role, group):
    return True if group == "all" else role == group


def boot_ci(pairs, stat, n=NBOOT, seed=SEED):
    """95% percentile CI, resampling the items in ``pairs`` (persons, clips, ...)."""
    if len(pairs) < 5:
        return None
    rng = random.Random(seed)
    vals = []
    for _ in range(n):
        s = stat([pairs[rng.randrange(len(pairs))] for _ in pairs])
        if s is not None and math.isfinite(s):
            vals.append(s)
    if len(vals) < n * 0.5:
        return None
    return [T.quantile(vals, 0.025), T.quantile(vals, 0.975)]


def spearman_brown(r):
    return None if r is None else (2 * r / (1 + r) if r > -1 else None)


def b1_split_half(rows, features=None, overlap_frac=T.OVERLAP_EXCLUDE_FRAC):
    """overlap_frac=1.0 keeps every turn (no overlap cut): is_overlapped needs a fraction above it."""
    feats = features or features_in(rows)
    ppl = persons(rows)
    res = {}
    for feat in feats:
        for group in ROLE_GROUPS:
            pairs = []
            for (b, sp), tr in ppl.items():
                if not _in_group(_role_of(tr), group):
                    continue
                sh = T.split_half_person(tr, feat, overlap_frac)
                if sh is not None:
                    pairs.append(sh)
            rho = T.spearman([p[0] for p in pairs], [p[1] for p in pairs])
            ci = boot_ci(pairs, lambda s: T.spearman([p[0] for p in s], [p[1] for p in s]))
            res[f"{feat}|{group}"] = {
                "n_persons": len(pairs),
                "spearman": rho,
                "ci95": ci,
                "spearman_brown": spearman_brown(rho),
                "pass": (rho is not None and rho >= T.SPLIT_HALF_MIN),
            }
    return res


def b2_cross_model(rows):
    res = {}
    for dim in ("arousal", "valence", "dominance"):
        for group in ROLE_GROUPS:
            pairs = []  # (odyssey, audeering, bench_id)
            for r in rows:
                if T.is_overlapped(r) or not _in_group(r.get("role", "unknown"), group):
                    continue
                a, b = r["scores"].get(f"odyssey.{dim}"), r["scores"].get(f"audeering.{dim}")
                if a is not None and b is not None:
                    pairs.append((a, b, r["bench_id"]))
            rho = T.spearman([p[0] for p in pairs], [p[1] for p in pairs])
            # within-clip centred version removes between-clip level differences
            by = {}
            for a, b, c in pairs:
                by.setdefault(c, []).append((a, b))
            ca, cb = [], []
            for lst in by.values():
                ma = sum(x for x, _ in lst) / len(lst)
                mb = sum(y for _, y in lst) / len(lst)
                ca += [x - ma for x, _ in lst]
                cb += [y - mb for _, y in lst]
            clips = sorted(by)

            def stat(sample, by=by):
                a_, b_ = [], []
                for c in sample:
                    for x, y in by[c]:
                        a_.append(x)
                        b_.append(y)
                return T.spearman(a_, b_)

            res[f"{dim}|{group}"] = {
                "n_turns": len(pairs),
                "n_clips": len(by),
                "spearman": rho,
                "ci95_by_clip": boot_ci(clips, stat),
                "spearman_within_clip": T.spearman(ca, cb),
            }
    return res


def b3_gold(rows, window_map, min_cover=0.5, role="patient"):
    """window_map: list of {bench_id, t0_s, t1_s, arousal, valence}. Patient turns that overlap
    a window by at least min_cover of the turn are aggregated (duration-weighted mean of the turn
    scores). Returns None when no window overlaps any clip."""
    if not window_map:
        return None
    by = {}
    for r in rows:
        if r.get("role") == role and not T.is_overlapped(r):
            by.setdefault(r["bench_id"], []).append(r)
    out = {}
    for score_key, gold_key in (("odyssey.arousal", "arousal"), ("audeering.arousal", "arousal"), ("odyssey.valence", "valence"), ("e2v.happy", "valence")):
        xs, ys = [], []
        for w in window_map:
            tr = by.get(w["bench_id"], [])
            acc = wsum = 0.0
            for r in tr:
                ov = min(r["t1_s"], w["t1_s"]) - max(r["t0_s"], w["t0_s"])
                if ov > 0 and ov / r["dur_s"] >= min_cover:
                    v = r["scores"].get(score_key)
                    if v is not None:
                        acc += v * r["dur_s"]
                        wsum += r["dur_s"]
            if wsum > 0 and w.get(gold_key) is not None:
                xs.append(acc / wsum)
                ys.append(w[gold_key])
        out[f"{score_key}~gold_{gold_key}"] = {"n_windows": len(xs), "spearman": T.spearman(xs, ys)}
    return out


def b4_role_separation(rows, features=None):
    feats = features or features_in(rows)
    ppl = persons(rows)
    res = {}
    for feat in feats:
        groups = {}
        for (b, sp), tr in ppl.items():
            agg = T.aggregate_person(tr, feat)
            if agg is not None:
                groups.setdefault(_role_of(tr), []).append(agg["value"])
        summ = {
            role: {"n_persons": len(v), "median": T.median(v), "q25": T.quantile(v, 0.25), "q75": T.quantile(v, 0.75)}
            for role, v in groups.items()
        }
        # doctor vs patient: probability a random doctor person scores above a random patient (AUC)
        d, p = groups.get("doctor", []), groups.get("patient", [])
        auc = None
        if d and p:
            gt = sum((x > y) + 0.5 * (x == y) for x in d for y in p)
            auc = gt / (len(d) * len(p))
        res[feat] = {"by_role": summ, "doctor_gt_patient_auc": auc}
    return res


def overlap_summary(rows):
    """Seconds and turns removed by the overlap cut, per role."""
    out = {}
    for r in rows:
        o = out.setdefault(r.get("role", "unknown"), {"turns": 0, "seconds": 0.0, "overlap_excluded_turns": 0, "overlap_excluded_s": 0.0})
        o["turns"] += 1
        o["seconds"] += float(r["dur_s"])
        if T.is_overlapped(r):
            o["overlap_excluded_turns"] += 1
            o["overlap_excluded_s"] += float(r["dur_s"])
    return out


def run_all(scores_path, window_map=None):
    meta, rows = load_scores(scores_path)
    status = {}
    for r in rows:
        for m, s in (r.get("status") or {}).items():
            status.setdefault(m, {}).setdefault(s, 0)
            status[m][s] += 1
    return {
        "meta": meta,
        "n_turns": len(rows),
        "n_clips": len({r["bench_id"] for r in rows}),
        "n_persons": len(persons(rows)),
        "status_counts": status,
        "b1_split_half": b1_split_half(rows),
        "b1_split_half_no_overlap_cut": b1_split_half(rows, overlap_frac=1.0),
        "overlap_excluded_by_role": overlap_summary(rows),
        "b2_cross_model": b2_cross_model(rows),
        "b3_gold": b3_gold(rows, window_map) if window_map else None,
        "b4_role_separation": b4_role_separation(rows),
    }


def reliability_table(b1):
    """{"feature|role": split-half rho} for the rows. Missing or unmeasured pairs stay absent
    (and therefore null in the output rows)."""
    return {k: v["spearman"] for k, v in b1.items() if v["spearman"] is not None}


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(prog="python -m tools.timbre.turns_bench")
    ap.add_argument("--scores", required=True)
    ap.add_argument("--window-map", default=None, help="JSON list for B3")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    wm = json.loads(Path(a.window_map).read_text()) if a.window_map else None
    res = run_all(a.scores, wm)
    Path(a.out).write_text(json.dumps(res, indent=1))
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
