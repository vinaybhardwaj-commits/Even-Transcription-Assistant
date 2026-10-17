"""CLI driver: prereg first, then score, then S2c readout. Stdout carries counts only."""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import core, stats

T28B_POINT_MAX = 0.002
LOO_POINT_MAX = 0.002
LOO_UPPER_MAX = 0.005
SIM_RHOS = [0.0, 0.01, 0.05, 0.10]
SIM_P = LOO_UPPER_MAX


def _pct(x: float) -> str:
    return f"{100 * x:.3f}%"


def _test_block(trials: list[dict], key: str, reps: int, seed: int) -> dict:
    fa = [int(t[key]) for t in trials]
    block = stats.summarise(sum(fa), len(fa))
    block["clusterings"] = {}
    for name, field in (("true_doctor", "doctor_uid"), ("impostor_doctor", "impostor_uid")):
        block["clusterings"][name] = stats.cluster_bound(
            [t[field] for t in trials], fa, reps=reps, seed=seed)
    block["larger_upper_975"] = max(c["upper_975"] for c in block["clusterings"].values())
    block["flags"] = sorted({f for c in block["clusterings"].values() for f in c["flags"]})
    return block


def readout(summary: dict, fire_rate: float | None, per_month: float | None) -> list[str]:
    std, loo = summary["T28b"], summary["T28b-LOO"]
    ok = lambda b: "PASS" if b else "FAIL"
    lines = [
        f"S2c T28b point {_pct(std['point'])} <= 0.2%: {ok(std['point'] <= T28B_POINT_MAX)}",
        f"S2c T28b-LOO point {_pct(loo['point'])} <= 0.2%: {ok(loo['point'] <= LOO_POINT_MAX)}",
        f"S2c T28b-LOO larger cluster-robust 97.5% upper {_pct(loo['larger_upper_975'])} <= 0.5%: "
        f"{ok(loo['larger_upper_975'] <= LOO_UPPER_MAX)}",
    ]
    flags = [f"{t}/{c}: {f}" for t in ("T28b", "T28b-LOO") for c, b in summary[t]["clusterings"].items()
             for f in b["flags"]]
    lines.append("flags: " + (", ".join(flags) if flags else "none"))
    if fire_rate is None or per_month is None:
        lines.append("C8: not computed (--armc-fire-rate and --consults-per-month not given)")
    else:
        v = loo["larger_upper_975"] * fire_rate * per_month
        lines.append(f"C8: expected wrong-doctor attributions per month = {v:.4f} "
                     f"(upper {_pct(loo['larger_upper_975'])} x fire rate {fire_rate} x {per_month} consults/month)")
    return lines


def run(args: argparse.Namespace, out=sys.stdout) -> dict:
    os.makedirs(args.out_dir, mode=0o700, exist_ok=True)
    cents = core.load_centroids(args.centroids)
    manifest = core.load_json_lines(args.manifest)
    exclude = core.load_uid_list(args.exclude) if args.exclude else set()
    truth = None
    if args.truth:
        truth = {r["consult_uid"]: r["label"] for r in core.load_json_lines(args.truth)}
    loader = core.VecsLoader(args.vecs, truth)

    universe, counts = core.build_universe(manifest, exclude, loader, cents)
    print(f"manifest consults {counts['manifest']}; dropped as excluded {counts['dropped_excluded']}; "
          f"no vectors {counts['no_vectors']}; no truth label {counts['no_truth']}; "
          f"consults with truth {counts['consults_with_truth']}; centroids {len(cents)}", file=out)
    print(f"trial universe {counts['universe_trials']}", file=out)
    if counts["universe_trials"] < args.min_trials:
        raise core.InsufficientTrials(
            f"universe {counts['universe_trials']} < min trials {args.min_trials}")
    trials = core.sample_trials(universe, args.target_trials, args.seed)
    core.assert_disjoint([t["consult_uid"] for t in trials], exclude)
    print(f"achieved trials {len(trials)} (target {args.target_trials}, min {args.min_trials})", file=out)

    trials_path, sha = core.write_prereg(
        args.out_dir, trials, seed=args.seed, target=args.target_trials, counts=counts,
        exclude_path=args.exclude, manifest_path=args.manifest)
    print(f"prereg written before scoring: seed {args.seed}, sha256 {sha}", file=out)

    scored = core.score_trials(trials_path, sha, loader, manifest, cents)
    audit = os.path.join(args.out_dir, "trials_scored.jsonl")
    core.write_private(audit, "".join(json.dumps(t, sort_keys=True) + "\n" for t in scored))

    summary = {
        "seed": args.seed, "trial_list_sha256": sha, "counts": counts, "trials": len(scored),
        "T28b": _test_block(scored, "fa_std", args.boot_reps, args.seed),
        "T28b-LOO": _test_block(scored, "fa_loo", args.boot_reps, args.seed + 1),
    }
    for name in ("T28b", "T28b-LOO"):
        b = summary[name]
        print(f"{name}: {b['k']}/{b['n']} point {_pct(b['point'])}; CP95 {_pct(b['cp95_lo'])}-{_pct(b['cp95_hi'])}; "
              f"exact one-sided 97.5% upper {_pct(b['exact_upper_975_one_sided'])}", file=out)
        for cname, c in b["clusterings"].items():
            print(f"  cluster[{cname}]: clusters {c['clusters']} (>=50 trials: {c['clusters_ge_min_trials']}); "
                  f"{c['method']} 97.5% upper {_pct(c['upper_975'])}; flags {c['flags'] or 'none'}", file=out)
        print(f"  larger cluster-robust 97.5% upper {_pct(b['larger_upper_975'])}", file=out)

    if args.sim_reps > 0:
        k = summary["T28b-LOO"]["clusterings"]["true_doctor"]["clusters"]
        n_per = max(1, round(len(scored) / max(k, 1)))
        sim = stats.coverage_sim(p=SIM_P, K=k, n_per=n_per, rhos=SIM_RHOS, sims=args.sim_reps,
                                 reps=args.sim_boot_reps, seed=args.seed)
        summary["coverage_sim"] = {"p": SIM_P, "K": k, "n_per_cluster": n_per, "results": sim}
        print(f"coverage sim (report only): p {SIM_P}, K {k}, n/cluster {n_per}, beta-binomial ICC rho "
              + "; ".join(f"{r['rho']}: {r['coverage']:.3f}" for r in sim), file=out)

    for line in readout(summary, args.armc_fire_rate, args.consults_per_month):
        print(line, file=out)
    core.write_private(os.path.join(args.out_dir, "summary.json"),
                       json.dumps(summary, indent=2, sort_keys=True) + "\n")
    return summary


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m eval.pdqi9.t28b.run", description=__doc__)
    p.add_argument("--manifest", required=True, help="jsonl: consult_uid, doctor_uid, logged_in_doctor_uid, vectors_path")
    p.add_argument("--vecs", help="default vecs.json when a manifest row has no vectors_path")
    p.add_argument("--centroids", required=True, help="json list of {pulse_doctor_uid, b64 float32}")
    p.add_argument("--exclude", help="tuning-consult exclude list (uid per line or jsonl)")
    p.add_argument("--truth", help="optional jsonl {consult_uid, label}; replaces arm (c) derivation")
    p.add_argument("--out-dir", required=True)
    p.add_argument("--seed", type=int, required=True)
    p.add_argument("--target-trials", type=int, default=100000)
    p.add_argument("--min-trials", type=int, default=core.MIN_TRIALS_DEFAULT)
    p.add_argument("--boot-reps", type=int, default=10000)
    p.add_argument("--sim-reps", type=int, default=200, help="coverage simulation replicates; 0 disables")
    p.add_argument("--sim-boot-reps", type=int, default=500)
    p.add_argument("--armc-fire-rate", type=float)
    p.add_argument("--consults-per-month", type=float)
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        run(args)
    except (core.InsufficientTrials, core.DisjointnessError) as e:
        print(f"ABORT: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
