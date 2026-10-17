"""CLI driver. `prereg` registers the trial set and hashes every input; `score` verifies and measures.

Stdout and stderr carry counts only, never uids. Exit 2 on any input problem.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

from . import core, stats

SIM_RHOS = [0.01, 0.05, 0.10]
SIM_P = core.GATE_UPPER_MAX
INPUT_FLAGS = ("manifest", "centroids", "truth", "exclude")


def _pct(x: float) -> str:
    return f"{100 * x:.3f}%"


def _paths(args) -> dict:
    return {k: getattr(args, k) for k in INPUT_FLAGS}


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
    if os.path.exists(os.path.join(args.out_dir, "prereg.json")):
        raise core.InputError("prereg.json already exists in the output dir")
    cents, manifest, exclude, truth, loader = _load(args)
    universe, nd, counts = core.build_universe(
        manifest, exclude, truth, loader, cents, one_label_pass=args.one_label_pass,
        exclude_unmatched_ok=args.exclude_unmatched_ok)
    print(f"manifest consults {counts['manifest']}; exclusion entries {counts['exclude_entries']} "
          f"(unmatched {counts['exclude_unmatched']}); dropped as excluded {counts['dropped_excluded']}", file=out)
    print(f"no truth {counts['no_truth']}; no vectors {counts['no_vectors']}; truth label not in vectors "
          f"{counts['truth_label_not_in_vectors']}; one-label consults {counts['one_label_consults']} "
          f"({'scored' if args.one_label_pass else 'abstained'}); scored consults {counts['consults_scored']}; "
          f"truth by source {counts['truth_by_source']}", file=out)
    print(f"centroids {len(cents)}; T28b universe {counts['universe_trials']}; T28b-nd trials {counts['nd_trials']}",
          file=out)
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
        "exclude_unmatched_ok": bool(args.exclude_unmatched_ok),
        "exclude_unmatched_count": counts["exclude_unmatched"],
        "code": core.code_identity(), "counts": counts,
    }
    core.write_private(os.path.join(d, "prereg.json"), json.dumps(meta, indent=2, sort_keys=True) + "\n")
    core.write_private(os.path.join(d, "prereg.sha256"),
                       f"{core.sha256_file(os.path.join(d, 'prereg.json'))}  prereg.json\n")
    print(f"prereg written before scoring: seed {args.seed}, trial list sha256 {meta['trial_list_sha256']}; "
          f"code {meta['code']['code_sha256'][:12]}, commit {(meta['code']['git_commit'] or 'none')[:12]}", file=out)
    return meta


def _verify(args, meta_path_dir: str) -> dict:
    """Refuse on any mismatch between the prereg and what is on disk now."""
    d = meta_path_dir
    pj = os.path.join(d, "prereg.json")
    if not os.path.exists(pj):
        raise core.InputError("no prereg.json in the output dir; run prereg first")
    want = open(os.path.join(d, "prereg.sha256")).read().split()[0]
    if core.sha256_file(pj) != want:
        raise core.InputError("MISMATCH prereg.json")
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
    if core.sha256_file(os.path.join(d, "prereg_trials.jsonl")) != meta["trial_list_sha256"]:
        bad.append("trial_list")
    if core.sha256_file(os.path.join(d, "prereg_nd_trials.jsonl")) != meta["nd_trial_list_sha256"]:
        bad.append("nd_trial_list")
    if bad:
        raise core.InputError("MISMATCH " + ", ".join(bad))
    return meta


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


def readout(summary: dict, fire_rate, per_month) -> list[str]:
    std, loo, nd = summary["T28b"], summary["T28b-LOO"], summary["T28b-nd"]

    def point(name, b):
        if b["n"] == 0:
            return f"S2c {name} point: NO TRIALS (no PASS)"
        ok = "PASS" if b["point"] <= core.GATE_POINT_MAX else "FAIL"
        return f"S2c {name} point {_pct(b['point'])} <= 0.2%: {ok}"

    lines = [point("T28b", std), point("T28b-LOO", loo), point("T28b-nd", nd)]
    worse = None
    if loo["underpowered"] or nd["underpowered"]:
        info = ", ".join(f"{n} exact CP upper {_pct(b['exact_info_975'])} (info only)" if b["n"] else f"{n} no trials"
                         for n, b in (("T28b-LOO", loo), ("T28b-nd", nd)))
        lines.append(f"S2c headline cluster-robust 97.5% upper <= 0.5%: UNDERPOWERED, no bootstrap bound, no PASS; {info}")
    else:
        worse = max(loo["larger_upper_975"], nd["larger_upper_975"])
        ok = "PASS" if worse <= core.GATE_UPPER_MAX else "FAIL"
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

    # R5: choose the doctor floor from the coverage simulation.
    elig = [_eligible(ids) for rows in (scored, scored_nd) for ids in _clusterings(rows).values() if rows]
    k_data = max(elig) if elig else 0  # best-case K bounds the candidate floors; each clustering is judged alone
    n_per = max(stats.MIN_TRIALS_PER_CLUSTER, round(len(scored) / max(k_data, 1)))
    if args.sim_reps > 0:
        fl = stats.choose_floor(k_data=k_data, configured=args.doctor_floor, n_per=n_per, p=SIM_P,
                                rhos=SIM_RHOS, sims=args.sim_reps, reps=args.sim_boot_reps, seed=args.seed)
    else:
        fl = {"configured_floor": args.doctor_floor, "chosen_floor": args.doctor_floor,
              "status": "unverified (coverage sim disabled)", "k_data": k_data, "table": []}
    floor = fl["chosen_floor"]

    summary = {
        "seed": args.seed, "trial_list_sha256": meta["trial_list_sha256"], "counts": meta["counts"],
        "exclude_unmatched_count": meta["exclude_unmatched_count"], "floor": fl,
        "T28b": _test_block(scored, "fa_std", args.boot_reps, args.seed, floor),
        "T28b-LOO": _test_block(scored, "fa_loo", args.boot_reps, args.seed + 1, floor),
        "T28b-nd": _test_block(scored_nd, "fa", args.boot_reps, args.seed + 2, floor),
    }
    c = meta["counts"]
    print(f"prereg verified (inputs, thresholds, code, trial lists); truth by source {c['truth_by_source']}; "
          f"no truth {c['no_truth']}; one-label consults {c['one_label_consults']}", file=out)
    for name in ("T28b", "T28b-LOO", "T28b-nd"):
        b = summary[name]
        print(f"{name}: {b['k']}/{b['n']} point {_pct(b['point']) if b['n'] else 'n/a'}; "
              f"CP95 {_pct(b['cp95_lo'])}-{_pct(b['cp95_hi'])}; exact one-sided 97.5% upper "
              f"{_pct(b['exact_upper_975_one_sided'])}", file=out)
        for cname, cl in b["clusterings"].items():
            if cl["underpowered"]:
                print(f"  cluster[{cname}]: UNDERPOWERED ({cl['clusters_ge_min_trials']} clusters >=50 trials, "
                      f"floor {cl['floor']}); no bootstrap bound; exact CP upper {_pct(cl['exact_info_975'])} "
                      f"(info only)", file=out)
            else:
                print(f"  cluster[{cname}]: clusters {cl['clusters']} (>=50 trials: {cl['clusters_ge_min_trials']}); "
                      f"{cl['method']} 97.5% upper {_pct(cl['upper_975'])}; flags {cl['flags'] or 'none'}", file=out)
    print(f"doctor floor: configured {fl['configured_floor']}, chosen {fl['chosen_floor'] or 'unattainable'} "
          f"({fl['status']}); data K {fl['k_data']}", file=out)
    for r in fl["table"]:
        print(f"  coverage sim K {r['K']} rho {r['rho']}: {r['coverage']:.3f}", file=out)
    for line in readout(summary, args.armc_fire_rate, args.consults_per_month):
        print(line, file=out)
    core.write_private(os.path.join(args.out_dir, "summary.json"),
                       json.dumps(summary, indent=2, sort_keys=True) + "\n")
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

    a = sub.add_parser("prereg", help="register the trial set and hash all inputs (run first)")
    common(a)
    a.add_argument("--seed", type=int, required=True)
    a.add_argument("--target-trials", type=int, default=100000)
    a.add_argument("--min-trials", type=int, default=core.MIN_TRIALS_DEFAULT)
    a.add_argument("--one-label-pass", action="store_true",
                   help="one-label consults pass the next-label margin; default is abstain")
    a.add_argument("--exclude-unmatched-ok", action="store_true",
                   help="accept exclusion uids that match no manifest consult (count is recorded)")

    b = sub.add_parser("score", help="verify every prereg hash, then score")
    common(b)
    b.add_argument("--seed", type=int, required=True, help="bootstrap and simulation seed")
    b.add_argument("--boot-reps", type=int, default=10000)
    b.add_argument("--doctor-floor", type=int, default=stats.K_MIN_CLUSTERS)
    b.add_argument("--sim-reps", type=int, default=200, help="coverage replicates per cell; 0 disables")
    b.add_argument("--sim-boot-reps", type=int, default=500)
    b.add_argument("--armc-fire-rate", type=float)
    b.add_argument("--consults-per-month", type=float)
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        (prereg if args.cmd == "prereg" else score)(args)
    except (core.InputError, core.InsufficientTrials, core.DisjointnessError) as e:
        print(f"ABORT {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # never echo exception text: it may carry a uid
        print(f"ABORT {type(e).__name__}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
