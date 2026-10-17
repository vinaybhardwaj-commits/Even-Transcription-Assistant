"""CLI driver. `prereg` registers the trial set and hashes every input; `score` verifies and measures.

Stdout and stderr carry counts only, never uids. Exit 2 on any input problem.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter

from . import core, stats

SIM_RHOS = [0.01, 0.05, 0.10]
SIM_P = core.GATE_UPPER_MAX  # the coverage sim runs at the gate threshold
INPUT_FLAGS = ("manifest", "centroids", "truth", "exclude")


def _pct(x: float) -> str:
    return f"{100 * x:.3f}%"


def _strict_json(x) -> str:
    """Strict-JSON serialisation: non-finite floats become null, so allow_nan=False must succeed."""
    def clean(v):
        if isinstance(v, dict):
            return {k: clean(q) for k, q in v.items()}
        if isinstance(v, (list, tuple)):
            return [clean(q) for q in v]
        if isinstance(v, float) and not math.isfinite(v):
            return None
        return v
    return json.dumps(clean(x), indent=2, sort_keys=True, allow_nan=False)


def _config(args) -> dict:
    """Run parameters that prereg freezes and score must repeat unchanged (H2)."""
    return {"doctor_floor": args.doctor_floor, "sim_reps": args.sim_reps, "sim_p": SIM_P,
            "target_coverage": args.target_coverage, "rho_grid": SIM_RHOS}


def _paths(args) -> dict:
    return {k: getattr(args, k) for k in INPUT_FLAGS}


def _check_exclude(exclude: set, expected: int) -> None:
    if len(exclude) != expected:
        raise core.InputError(f"exclusion file holds {len(exclude)} unique normalised uids, expected {expected}")


def _load(args):
    cents, bad = core.load_centroids(args.centroids)
    manifest = core.load_manifest(args.manifest)
    exclude = core.load_exclude(args.exclude)
    truth = core.load_truth(args.truth)
    loader = core.VecsLoader(args.vecs)
    core.validate_vectors(manifest, loader, cents, bad)
    return cents, manifest, exclude, truth, loader


# ---------------------------------------------------------------- prereg

def prereg(args, out=sys.stdout) -> dict:
    core.prepare_out_dir(args.out_dir)
    core.check_anchor_path(args.anchor, args.out_dir, must_exist=False)
    if os.path.exists(os.path.join(args.out_dir, "prereg.json")):
        raise core.InputError("prereg.json already exists in the output dir")
    cents, manifest, exclude, truth, loader = _load(args)
    _check_exclude(exclude, args.expect_exclude)
    universe, nd, counts = core.build_universe(
        manifest, exclude, truth, loader, cents, one_label_pass=args.one_label_pass)
    print(f"manifest consults {counts['manifest']}; exclusion entries {counts['exclude_entries']} "
          f"(unmatched {counts['exclude_unmatched']}); dropped as excluded {counts['dropped_excluded']}", file=out)
    print(f"no truth {counts['no_truth']}; no vectors {counts['no_vectors']}; truth label not in vectors "
          f"{counts['truth_label_not_in_vectors']}; one-label consults {counts['one_label_consults']} "
          f"({'scored' if args.one_label_pass else 'abstained'}); scored consults {counts['consults_scored']}; "
          f"truth by source {counts['truth_by_source']}", file=out)
    print(f"centroids {len(cents)}; T28b universe {counts['universe_trials']}; T28b-nd trials {counts['nd_trials']}; "
          f"covering-clinician consults (speaker != logged-in) {counts['covering_consults']}", file=out)
    if counts["universe_trials"] < args.min_trials:
        raise core.InsufficientTrials(f"universe {counts['universe_trials']} < min trials {args.min_trials}")
    trials = core.sample_trials(universe, args.target_trials, args.seed)
    if len(trials) < args.min_trials:
        raise core.InsufficientTrials(f"achieved {len(trials)} < min trials {args.min_trials}")
    core.assert_disjoint([t["consult_uid"] for t in trials + nd], exclude)
    print(f"achieved T28b trials {len(trials)} (target {args.target_trials}, min {args.min_trials})", file=out)

    d = args.out_dir
    tp, np_ = os.path.join(d, "prereg_trials.jsonl"), os.path.join(d, "prereg_nd_trials.jsonl")
    core.write_private(tp, "".join(json.dumps(t, sort_keys=True) + "\n" for t in trials))
    core.write_private(np_, "".join(json.dumps(t, sort_keys=True) + "\n" for t in nd))
    meta = {
        "seed": args.seed, "target_trials": args.target_trials, "min_trials": args.min_trials,
        "achieved_trials": len(trials), "nd_trials": len(nd),
        "trial_list_sha256": core.sha256_file(tp), "nd_trial_list_sha256": core.sha256_file(np_),
        "inputs_sha256": core.input_hashes(_paths(args), manifest, core.VecsLoader(args.vecs)),
        "thresholds": core.thresholds(args.one_label_pass),
        "method": stats.METHOD, "expect_exclude": args.expect_exclude, "exclude_unmatched_count": counts["exclude_unmatched"],
        "config": _config(args), "code": core.code_identity(), "tree": core.git_dirty(), "counts": counts,
    }
    core.write_private(os.path.join(d, "prereg.json"), json.dumps(meta, indent=2, sort_keys=True) + "\n")
    pre_sha = core.sha256_file(os.path.join(d, "prereg.json"))
    core.write_private(os.path.join(d, "prereg.sha256"), f"{pre_sha}  prereg.json\n")
    core.write_private(args.anchor, f"{pre_sha}  prereg.json\n")
    print(f"prereg written before scoring: seed {args.seed}, trial list sha256 {meta['trial_list_sha256']}; "
          f"code {meta['code']['code_sha256'][:12]}, commit {(meta['code']['git_commit'] or 'none')[:12]}; "
          f"tree {'DIRTY (' + meta['tree']['reason'] + ')' if meta['tree']['dirty'] else 'clean'}; "
          f"anchor written outside the out dir", file=out)
    print(pre_sha, file=out)
    return meta


def _verify(args, meta_path_dir: str) -> dict:
    """Refuse on any mismatch between the prereg and what is on disk now."""
    d = meta_path_dir
    pj = os.path.join(d, "prereg.json")
    if not os.path.exists(pj):
        raise core.InputError("no prereg.json in the output dir; run prereg first")
    core.check_anchor_path(args.anchor, d, must_exist=True)
    want = open(args.anchor).read().split()[0]
    if core.sha256_file(pj) != want:
        raise core.InputError("MISMATCH prereg.json vs anchor")
    meta = json.load(open(pj))
    manifest = core.load_manifest(args.manifest)
    now = core.input_hashes(_paths(args), manifest, core.VecsLoader(args.vecs))
    bad = [k for k in INPUT_FLAGS if now[k] != meta["inputs_sha256"][k]]
    if now["vectors"] != meta["inputs_sha256"]["vectors"]:
        bad.append("vectors")
    if core.thresholds(meta["thresholds"]["one_label_pass"]) != meta["thresholds"]:
        bad.append("thresholds")
    if core.code_identity() != meta["code"]:
        bad.append("code")
    if _config(args) != meta["config"]:
        bad.append("config")
    if args.seed != meta["seed"]:
        bad.append("seed")
    if meta.get("method") != stats.METHOD:
        bad.append("method")
    if core.sha256_file(os.path.join(d, "prereg_trials.jsonl")) != meta["trial_list_sha256"]:
        bad.append("trial_list")
    if core.sha256_file(os.path.join(d, "prereg_nd_trials.jsonl")) != meta["nd_trial_list_sha256"]:
        bad.append("nd_trial_list")
    if bad:
        raise core.InputError("MISMATCH " + ", ".join(bad))
    return meta


# ---------------------------------------------------------------- census

def _spread(xs: list[int]) -> str:
    xs = sorted(xs)
    return f"min {xs[0]} / median {xs[len(xs) // 2]} / max {xs[-1]}" if xs else "none"


def census(args, out=sys.stdout) -> dict:
    """Counts of true-speaker doctors who can form a cluster. Run before prereg; counts only."""
    cents, manifest, exclude, truth, loader = _load(args)
    _check_exclude(exclude, args.expect_exclude)
    universe, nd, counts = core.build_universe(manifest, exclude, truth, loader, cents,
                                               one_label_pass=args.one_label_pass)
    consults, trials = Counter(), Counter()
    for u in universe:
        consults[u["doctor_uid"]] += 1
        trials[u["doctor_uid"]] += len(u["impostors"])
    qual = [d for d, c in consults.items() if c >= stats.MIN_TRIALS_PER_CLUSTER]
    res = {"scored_consults": counts["consults_scored"], "doctors": len(consults), "qualifying_doctors": len(qual),
           "floor": args.doctor_floor, "below_floor": len(qual) < args.doctor_floor}
    print(f"census: manifest consults {counts['manifest']}; dropped as excluded {counts['dropped_excluded']}; "
          f"no truth {counts['no_truth']}; no vectors {counts['no_vectors']}; scored consults "
          f"{counts['consults_scored']}; truth by source {counts['truth_by_source']}", file=out)
    print(f"distinct true-speaker doctors {len(consults)}; with >= {stats.MIN_TRIALS_PER_CLUSTER} truth-labelled "
          f"consults {len(qual)} (floor {args.doctor_floor})", file=out)
    print(f"qualifying doctors: consults {_spread([consults[d] for d in qual])}; potential T28b trials "
          f"{_spread([trials[d] for d in qual])}, total {sum(trials[d] for d in qual)}; T28b-nd trials {len(nd)}", file=out)
    if res["below_floor"]:
        print(f"K below floor ({len(qual)} < {args.doctor_floor})", file=out)
    return res


# ---------------------------------------------------------------- score

def _clusterings(trials: list[dict]) -> dict:
    return {"true_doctor": [t["doctor_uid"] for t in trials],
            "centroid_doctor": [t["centroid_uid"] for t in trials]}


def _eligible(ids: list) -> int:
    return sum(1 for n in Counter(ids).values() if n >= stats.MIN_TRIALS_PER_CLUSTER)


def _test_block(trials: list[dict], key: str, reps: int, seed: int, floor) -> dict:
    fa = [int(t[key]) for t in trials]
    block = stats.summarise(sum(fa), len(fa))
    block["clusterings"] = {name: stats.cluster_bound(ids, fa, reps=reps, seed=seed, floor=floor)
                            for name, ids in _clusterings(trials).items()}
    ups = [c["upper_975"] for c in block["clusterings"].values()]
    block["underpowered"] = any(c["underpowered"] for c in block["clusterings"].values()) or not trials
    block["larger_upper_975"] = None if block["underpowered"] else max(ups)
    block["exact_info_975"] = block["exact_upper_975_one_sided"]
    block["flags"] = sorted({f for c in block["clusterings"].values() for f in c["flags"]})
    return block


def readout(summary: dict, fire_rate, per_month, dirty: bool = False, coverage: dict | None = None) -> list[str]:
    std, loo, nd = summary["T28b"], summary["T28b-LOO"], summary["T28b-nd"]
    blockers = (["DIRTY"] if dirty else []) + (
        [f"COVERAGE {coverage['status']}"] if coverage and coverage["status"] != "ok" else [])
    PASS = ", ".join(blockers) + ", no PASS" if blockers else "PASS"

    def point(name, b):
        if b["n"] == 0:
            return f"S2c {name} point: NO TRIALS (no PASS)"
        ok = PASS if b["point"] <= core.GATE_POINT_MAX else "FAIL"
        return f"S2c {name} point {_pct(b['point'])} <= 0.2%: {ok}"

    lines = [point("T28b", std), point("T28b-LOO", loo), point("T28b-nd", nd)]
    if coverage and coverage["status"] != "ok":
        lines.insert(0, f"COVERAGE {coverage['status']}: profile-likelihood coverage sim (target "
                        f"{coverage['target']}) did not clear, no PASS can be issued")
    if dirty:
        lines.insert(0, "DIRTY: eval/pdqi9/t28b had uncommitted changes at prereg; no PASS can be issued")
    worse = None
    if loo["underpowered"] or nd["underpowered"]:
        info = ", ".join(f"{n} exact CP upper {_pct(b['exact_info_975'])} (info only)" if b["n"] else f"{n} no trials"
                         for n, b in (("T28b-LOO", loo), ("T28b-nd", nd)))
        lines.append(f"S2c headline cluster-robust 97.5% upper <= 0.5%: UNDERPOWERED, no gating bound, no PASS; {info}")
    else:
        worse = max(loo["larger_upper_975"], nd["larger_upper_975"])
        ok = PASS if worse <= core.GATE_UPPER_MAX else "FAIL"
        lines.append(f"S2c headline worse of T28b-LOO {_pct(loo['larger_upper_975'])} and T28b-nd "
                     f"{_pct(nd['larger_upper_975'])} = {_pct(worse)} <= 0.5%: {ok}")
    flags = [f"{t}/{c}: {f}" for t in ("T28b", "T28b-LOO", "T28b-nd") for c, b in summary[t]["clusterings"].items()
             for f in b["flags"]]
    lines.append("flags: " + (", ".join(flags) if flags else "none"))
    if worse is None:
        lines.append("C8: not computed (UNDERPOWERED)")
    elif fire_rate is None or per_month is None:
        lines.append("C8: not computed (--armc-fire-rate and --consults-per-month not given)")
    else:
        lines.append(f"C8: expected wrong-doctor attributions per month = {worse * fire_rate * per_month:.4f} "
                     f"(worse upper {_pct(worse)} x fire rate {fire_rate} x {per_month} consults/month)")
    return lines


def _coverage(scored, scored_nd, args) -> dict:
    """Coverage of the gating bound at the data's K and trials per doctor (smallest gating clustering)."""
    pools = [[n for n in Counter(ids).values() if n >= stats.MIN_TRIALS_PER_CLUSTER]
             for rows in (scored, scored_nd) if rows for ids in _clusterings(rows).values()]
    sizes = min(pools, key=len) if pools else []
    K = len(sizes)
    n_per = round(sum(sizes) / K) if K else 0
    cov = {"method": stats.METHOD, "K": K, "n_per_cluster": n_per, "p": SIM_P, "target": args.target_coverage,
           "sims": args.sim_reps, "table": []}
    if args.sim_reps > 0 and K >= 2:
        cov["table"] = stats.coverage_sim(p=SIM_P, K=K, n_per=n_per, rhos=SIM_RHOS, sims=args.sim_reps,
                                          seed=args.seed)
    cov["min_coverage"] = min((r["coverage"] for r in cov["table"]), default=None)
    cov["status"] = ("not run" if not cov["table"]
                     else "ok" if cov["min_coverage"] >= args.target_coverage else "below target")
    return cov


def score(args, out=sys.stdout) -> dict:
    core.prepare_out_dir(args.out_dir, must_exist=True)
    meta = _verify(args, args.out_dir)
    one_label_pass = meta["thresholds"]["one_label_pass"]
    cents, manifest, _exclude, _truth, loader = _load(args)
    trials = core.load_json_lines(os.path.join(args.out_dir, "prereg_trials.jsonl"))
    nd_trials = core.load_json_lines(os.path.join(args.out_dir, "prereg_nd_trials.jsonl"))
    scored, scored_nd = core.score_trials(trials, nd_trials, loader, manifest, cents, one_label_pass)
    for name, rows in (("trials_scored.jsonl", scored), ("trials_nd_scored.jsonl", scored_nd)):
        core.write_private(os.path.join(args.out_dir, name),
                           "".join(json.dumps(t, sort_keys=True) + "\n" for t in rows))

    floor = args.doctor_floor
    cov = _coverage(scored, scored_nd, args)

    summary = {
        "seed": args.seed, "trial_list_sha256": meta["trial_list_sha256"], "counts": meta["counts"],
        "exclude_unmatched_count": meta["exclude_unmatched_count"], "tree": meta["tree"], "config": meta["config"],
        "method": meta["method"], "coverage": cov,
        "T28b": _test_block(scored, "fa_std", args.boot_reps, args.seed, floor),
        "T28b-LOO": _test_block(scored, "fa_loo", args.boot_reps, args.seed + 1, floor),
        "T28b-nd": _test_block(scored_nd, "fa", args.boot_reps, args.seed + 2, floor),
    }
    c = meta["counts"]
    print(f"prereg verified (inputs, thresholds, code, trial lists); truth by source {c['truth_by_source']}; "
          f"no truth {c['no_truth']}; one-label consults {c['one_label_consults']}; "
          f"covering-clinician consults {c['covering_consults']}; "
          f"tree {'DIRTY' if meta['tree']['dirty'] else 'clean'}", file=out)
    for name in ("T28b", "T28b-LOO", "T28b-nd"):
        b = summary[name]
        print(f"{name}: {b['k']}/{b['n']} point {_pct(b['point']) if b['n'] else 'n/a'}; "
              f"CP95 {_pct(b['cp95_lo'])}-{_pct(b['cp95_hi'])}; exact one-sided 97.5% upper "
              f"{_pct(b['exact_upper_975_one_sided'])}", file=out)
        for cname, cl in b["clusterings"].items():
            if cl["underpowered"]:
                print(f"  cluster[{cname}]: UNDERPOWERED ({cl['clusters_ge_min_trials']} clusters >=50 trials, "
                      f"floor {cl['floor']}); no gating bound; exact CP upper {_pct(cl['exact_info_975'])} "
                      f"(info only)", file=out)
            else:
                rep_ = ", ".join(f"{n} {_pct(cl[k]) if cl[k] is not None else 'n/a'}"
                                 for n, k in (("BCa", "bca_975"), ("boot-t", "boot_t_975")))
                print(f"  cluster[{cname}]: clusters {cl['clusters']} (>=50 trials: {cl['clusters_ge_min_trials']}); "
                      f"{cl['method']} 97.5% upper {_pct(cl['upper_975'])} (gating); p_hat {_pct(cl['p_hat'])}; "
                      f"rho_at_upper {cl['rho_at_upper']}; reported only: {rep_}, exact CP "
                      f"{_pct(cl['exact_info_975'])}; flags {cl['flags'] or 'none'}", file=out)
    print(f"doctor floor {floor}; coverage sim ({stats.METHOD}, p {SIM_P}) at data K {cov['K']}, "
          f"{cov['n_per_cluster']} trials per doctor, target {cov['target']}: {cov['status']}", file=out)
    for r in cov["table"]:
        print(f"  coverage rho {r['rho']}: {r['coverage']:.3f} ({r['sims']} sims)", file=out)
    for line in readout(summary, args.armc_fire_rate, args.consults_per_month, meta['tree']['dirty'], cov):
        print(line, file=out)
    core.write_private(os.path.join(args.out_dir, "summary.json"), _strict_json(summary) + "\n")
    return summary


# ---------------------------------------------------------------- cli

def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m eval.pdqi9.t28b", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(s):
        s.add_argument("--manifest", required=True, help="jsonl: consult_uid, doctor_uid, logged_in_doctor_uid, [vectors_path]")
        s.add_argument("--vecs", help="default vecs.json when a manifest row has no vectors_path")
        s.add_argument("--centroids", required=True, help="json list of {pulse_doctor_uid, b64 float32, ...}")
        s.add_argument("--truth", required=True,
                       help="jsonl {consult_uid, label, source in role_votes_3of3|manual}")
        s.add_argument("--exclude", required=True, help="tuning-consult exclude list (uid per line or jsonl)")
        s.add_argument("--out-dir", required=True, help="0700; prereg and score share it")
        s.add_argument("--anchor", required=True,
                       help="file OUTSIDE the out dir holding the prereg.json sha256; prereg writes it, score verifies it")
        s.add_argument("--doctor-floor", type=int, default=stats.K_MIN_CLUSTERS)
        s.add_argument("--sim-reps", type=int, default=200, help="coverage sim replicates per rho; 0 = not run, which blocks PASS")
        s.add_argument("--target-coverage", type=float, default=0.90)

    c = sub.add_parser("census", help="count doctors able to form a cluster (run before prereg; exit 3 if K < floor)")
    c.add_argument("--manifest", required=True)
    c.add_argument("--vecs")
    c.add_argument("--centroids", required=True)
    c.add_argument("--truth", required=True)
    c.add_argument("--exclude", required=True)
    c.add_argument("--expect-exclude", type=int, required=True)
    c.add_argument("--one-label-pass", action="store_true")
    c.add_argument("--doctor-floor", type=int, default=stats.K_MIN_CLUSTERS)

    a = sub.add_parser("prereg", help="register the trial set and hash all inputs (run first)")
    common(a)
    a.add_argument("--seed", type=int, required=True)
    a.add_argument("--target-trials", type=int, default=100000)
    a.add_argument("--min-trials", type=int, default=core.MIN_TRIALS_DEFAULT)
    a.add_argument("--one-label-pass", action="store_true",
                   help="one-label consults pass the next-label margin; default is abstain")
    a.add_argument("--expect-exclude", type=int, required=True,
                   help="exact number of unique normalised uids the exclude file must hold, all matching the manifest")

    b = sub.add_parser("score", help="verify every prereg hash, then score")
    common(b)
    b.add_argument("--seed", type=int, required=True, help="must equal the prereg seed")
    b.add_argument("--boot-reps", type=int, default=10000)
    b.add_argument("--armc-fire-rate", type=float)
    b.add_argument("--consults-per-month", type=float)
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        res = {"census": census, "prereg": prereg, "score": score}[args.cmd](args, out=sys.stdout)
        if args.cmd == "census" and res["below_floor"]:
            return 3
    except (core.InputError, core.InsufficientTrials, core.DisjointnessError) as e:
        print(f"ABORT {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # never echo exception text: it may carry a uid
        print(f"ABORT {type(e).__name__}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
