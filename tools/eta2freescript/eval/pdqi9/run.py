"""python -m tools.eta2freescript.eval.pdqi9.run --round R --arms A.jsonl,B0.jsonl,Bn.jsonl --artifacts DIR (--consults DATA | --bundles DIR)
       --frozen $FREESCRIPT_FROZEN_DIR --out OUT --scoreboard PATH [--lockbox --candidate ID]

Arm files: one JSON object per line, {"uid": ..., "prescription": {...}[, "drops": n | [...]]}. A B4a replay() dict fits as is.
Artifacts: DIR/<uid>.json (eta.freescript artifact); DIR/b0/<uid>.json, if present, is used for arm B0.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ... import ingest
from ...models import BedrockClient, ModelClient, UsageLedger
from . import floors, jev_lines, judge, render, scoreboard, splits, stats

ARMS = ("A", "B0", "Bn")
PKG = Path(__file__).resolve().parent


def read_arm(path: Path) -> dict[str, dict]:
    out = {}
    for ln in Path(path).read_text(encoding="utf-8").splitlines():
        if not ln.strip():
            continue
        row = json.loads(ln)
        uid = row.get("uid")
        if not isinstance(uid, str) or not uid:
            raise SystemExit(f"{path.name}: a row has no uid")
        rx = row.get("prescription") if isinstance(row.get("prescription"), dict) else {k: v for k, v in row.items() if k not in ("uid", "drops", "dropped")}
        drops = row.get("drops", row.get("dropped"))
        out[uid] = {"rx": render.validate_prescription(rx), "drops": len(drops) if isinstance(drops, (list, dict)) else int(drops or 0)}
    return out


def code_sha() -> str:
    h = hashlib.sha256()
    for p in sorted(PKG.glob("*.py")) + [PKG.parents[1] / "validate.py"]:
        h.update(p.read_bytes())
    return h.hexdigest()


def _load_art(d: Path, uid: str) -> dict | None:
    p = Path(d) / f"{uid}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _agg(vals: list[float]) -> dict:
    return {"median": statistics.median(vals), "mean": statistics.fmean(vals), "n": len(vals)} if vals else {"median": None, "mean": None, "n": 0}


SUCCINCT = judge.ITEM_KEYS.index("succinct")
THOROUGH = judge.ITEM_KEYS.index("thorough")


def _paired(scores: dict, uids: list[str], combo: str, a: str, b: str, item: int | None = None) -> tuple[list[float], list[float]]:
    """Paired values of arm a and arm b on the PDQI-9 total (item None) or on one item (0-based index into ITEM_KEYS)."""
    pairs = [(scores[(u, a, combo)], scores[(u, b, combo)]) for u in uids if scores.get((u, a, combo)) and scores.get((u, b, combo))]
    pick = (lambda x: x["total"]) if item is None else (lambda x: x["items"][item])
    return [pick(x) for x, _ in pairs], [pick(y) for _, y in pairs]


def compare_family(scores, uids, combos, a, b, item: int | None = None) -> dict:
    res = {c: stats.compare(*_paired(scores, uids, c, a, b, item)) for c in combos}
    adj = stats.holm([res[c]["p"] for c in combos])
    for c, p in zip(combos, adj):
        res[c]["p_holm"] = p
    return res


PRIMARY = "opus/transcript"


def total_family(scores, uids, combo: str) -> dict:
    """The three total comparisons under one judge/reference (Bn vs A, Bn vs B0, B0 vs A), Holm-adjusted together."""
    res = {k: stats.compare(*_paired(scores, uids, combo, x, y)) for k, (x, y) in
           {"bn_vs_a": ("Bn", "A"), "bn_vs_b0": ("Bn", "B0"), "b0_vs_a": ("B0", "A")}.items()}
    for k, p in zip(res, stats.holm([r["p"] for r in res.values()])):
        res[k]["p_holm"] = p
    return res


def target_check(items_gt: dict, family: dict, thorough: dict, total_a: dict) -> dict:
    """Spec 12.7 as data (lead ruling 13 Oct). Primary = opus/transcript alone: all 9 item means Bn > A; Bn-A total Holm p < 0.05
    (family = `family`, the three totals) with median diff >= 2; thorough-item mean diff Bn-B0 >= -0.1. Direction under Sonnet =
    Bn-A total median diff > 0 on both Sonnet references. Opus/none is reported elsewhere and is not part of `met`."""
    ba = family["bn_vs_a"]
    all9 = items_gt[PRIMARY] == judge.N_ITEMS
    tot = ba["p_holm"] is not None and ba["p_holm"] < 0.05 and (ba["median_diff"] or 0) >= 2
    thor = thorough[PRIMARY]["mean_diff"] is not None and thorough[PRIMARY]["mean_diff"] >= -0.1
    sonnet = [c for c in total_a if c.startswith("sonnet/")]
    sdir = bool(sonnet) and all((total_a[c]["median_diff"] or 0) > 0 for c in sonnet)
    return {"items_all_gt": all9, "total_holm_lt_0_05_median_ge_2": tot, "thorough_mean_ge_minus_0_1": thor, "direction_holds_sonnet": sdir,
            "met": all9 and tot and thor and sdir, "basis": PRIMARY}


def _clip_date(consults: str | None, bundles: str | None, uid: str):
    """IST date (ISO string) of the clip start the run will load for the uid, or None when missing or invalid. Reads only the clip start field."""
    try:
        if bundles:
            t0 = ingest.bundle_window(json.loads((Path(bundles) / f"{uid}.json").read_text(encoding="utf-8")))[0]
        else:
            t0 = ((json.loads((Path(consults) / uid / "transcript.json").read_text(encoding="utf-8")).get("clip")) or {}).get("t0_ms")
        if not isinstance(t0, int) or isinstance(t0, bool):
            return None
        return (datetime.fromtimestamp(0, timezone.utc) + timedelta(milliseconds=t0)).astimezone(ingest.IST).date().isoformat()
    except (OSError, ValueError, TypeError, AttributeError, OverflowError, RecursionError):
        return None


def lockbox_guard(uids: list[str], artifacts: Path, is_lockbox: bool, consults: str | None = None, bundles: str | None = None) -> int:
    """Fail closed, before any model call, output file or scoreboard row. The rule file is required for every run; the checks apply to tuning runs only."""
    try:
        rule = splits.LockboxRule.load()
    except splits.LockboxRuleError as e:
        print(f"lockbox_guard: abort {e.code} n_hash=0 n_date=0 n_nodate=0")
        return 1
    if is_lockbox:
        return 0
    dates = {}
    for u in uids:
        got = []
        try:
            for d in (artifacts, artifacts / "b0"):
                if d is artifacts or (d / f"{u}.json").exists():
                    got.append(((_load_art(d, u) or {}).get("encounter") or {}).get("visit_date_ist"))
        except (OSError, ValueError, AttributeError, RecursionError):
            got.append(None)
        got.append(_clip_date(consults, bundles, u))
        dates[u] = got
    n_hash, n_date, n_nodate = splits.tuning_guard(rule, dates)
    if n_hash or n_date or n_nodate:
        print(f"lockbox_guard: abort n_hash={n_hash} n_date={n_date} n_nodate={n_nodate}")
        return 1
    return 0


def resolve_judges(client: ModelClient) -> dict[str, str] | None:
    """Resolve every judge alias through the client's own resolve(). None (after a counts-only abort line naming variables, never values)
    when any ETA2FS_BEDROCK_* override is set or resolve() fails."""
    over = sorted(k for k in os.environ if k.startswith("ETA2FS_BEDROCK_"))
    if over:
        print(f"resolved_ids: abort override_set vars={','.join(over)}")
        return None
    try:
        return {j: client.resolve(j)[0] for j in judge.JUDGES}
    except Exception as e:
        print(f"resolved_ids: abort resolve_failed error={type(e).__name__}")
        return None


def main(argv: list[str] | None = None, client: ModelClient | None = None, jev_client=None) -> int:
    ap = argparse.ArgumentParser(prog="pdqi9.run")
    ap.add_argument("--round", required=True)
    ap.add_argument("--arms", required=True, help="A.jsonl,B0.jsonl,Bn.jsonl")
    ap.add_argument("--artifacts", required=True)
    ap.add_argument("--consults", help="folder mode: DATA/<uid>/transcript.json ...")
    ap.add_argument("--bundles", help="bundle mode: DIR/<uid>.json, read with ingest.load_bundle")
    ap.add_argument("--frozen", default=os.environ.get("FREESCRIPT_FROZEN_DIR"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--scoreboard", required=True)
    ap.add_argument("--lockbox", action="store_true")
    ap.add_argument("--candidate")
    a = ap.parse_args(argv)
    if not a.frozen:
        raise SystemExit("--frozen or FREESCRIPT_FROZEN_DIR is required")
    if bool(a.consults) == bool(a.bundles):
        raise SystemExit("give exactly one of --consults and --bundles")
    if a.bundles and not hasattr(ingest, "load_bundle"):
        raise SystemExit("--bundles needs ingest.load_bundle, which this tree does not have yet (B2 lands it); use --consults")
    paths = a.arms.split(",")
    if len(paths) != 3:
        raise SystemExit("--arms takes exactly three files: A, B0, Bn (in that order)")
    arms = {n: read_arm(Path(p)) for n, p in zip(ARMS, paths)}
    uids = sorted(set(arms["A"]) & set(arms["B0"]) & set(arms["Bn"]))
    dropped_uids = len(set().union(*[set(v) for v in arms.values()]) - set(uids))
    if not uids:
        raise SystemExit("no uid is present in all three arm files")
    if lockbox_guard(uids, Path(a.artifacts), a.lockbox, a.consults, a.bundles) != 0:
        return 1
    out = Path(a.out)
    os.umask(0o077)
    out.mkdir(parents=True, exist_ok=True)

    frozen = judge.load_frozen(a.frozen)
    spl = splits.Splits.load(frozen.split_path)
    split_name = splits.gate(spl, uids, a.lockbox, a.candidate)

    ledger = UsageLedger(out / "usage.jsonl")
    client = client or BedrockClient(ledger)
    cache = out / "cache"
    resolved = resolve_judges(client)
    if resolved is None:
        return 1
    ledger.path.parent.mkdir(parents=True, exist_ok=True)
    with open(ledger.path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"kind": "run_header", "round": a.round, "resolved_model_ids": resolved, "n": len(uids)}) + "\n")

    consult, transcript, art_bn, art_b0 = {}, {}, {}, {}
    for u in uids:
        art_bn[u] = _load_art(Path(a.artifacts), u)
        art_b0[u] = _load_art(Path(a.artifacts) / "b0", u) or art_bn[u]
        quarantined = set(((art_bn[u] or {}).get("clip_boundary") or {}).get("quarantined_turns") or [])
        consult[u] = ingest.load_bundle(json.loads((Path(a.bundles) / f"{u}.json").read_text(encoding="utf-8"))) if a.bundles else ingest.load_consult(Path(a.consults), u)
        transcript[u] = ingest.format_transcript(consult[u], quarantined)

    texts = {(u, arm): render.render(arms[arm][u]["rx"]) for u in uids for arm in ARMS}
    combos = [f"{j}/{r}" for j in judge.JUDGES for r in judge.REFS]
    scores: dict = {}
    for u, arm, j, r in judge.plan_calls(uids, list(ARMS)):
        res = judge.score_note(client, frozen, uid=u, arm=arm, judge=j, ref=r, note=texts[(u, arm)], transcript=transcript[u],
                               cache_dir=cache / "pdqi9", render_version=render.RENDER_VERSION)
        scores[(u, arm, f"{j}/{r}")] = None if res["parse_failure"] else {"total": sum(res["scores"]), "items": res["scores"]}
    parse_failures = sum(1 for v in scores.values() if v is None)

    stamp = {"frozen_hashes": frozen.hashes, "render_version": render.RENDER_VERSION, "split_sha": frozen.hashes["split-v1.json"]}
    fl = {"Bn": [], "B0": []}
    for u in uids:
        for kind, art in (("Bn", art_bn[u]), ("B0", art_b0[u])):
            fl[kind].append(stamp | floors.consult_floors(client, frozen, uid=u, arm_kind=kind, rx=arms[kind][u]["rx"], signed_rx=arms["A"][u]["rx"],
                                                  art=art, consult=consult[u], transcript=transcript[u], cache_dir=cache / "floors"))
    table = floors.aggregate(fl["Bn"], fl["B0"])

    jev_res = {u: jev_lines.check_lines((art_bn[u] or {}).get("note_text") or "", transcript[u], jev_client) for u in uids}
    ok = [v for v in jev_res.values() if v["status"] == "ok"]
    n_err = sum(1 for v in jev_res.values() if v["status"] == "error")
    n_not = len(jev_res) - len(ok) - n_err
    reasons = sorted({v.get("reason", "?") for v in jev_res.values() if v["status"] != "ok"})
    jev = {"status": "ok" if len(ok) == len(jev_res) else "failed" if n_err == len(jev_res) else "not run" if n_not == len(jev_res) else "partial",
           "consults": len(ok), "consults_ok": len(ok), "consults_error": n_err, "consults_not_run": n_not, "lines": sum(v["lines"] for v in ok),
           "low": sum(len(v["low"]) for v in ok), "errors": sum(v["errors"] for v in ok), "reasons": reasons}
    jev["models"] = sorted({v["model"] for v in ok if v.get("model")})
    counts = f"ok {len(ok)}, error {n_err}, not_run {n_not}"
    detail = f"{jev['low']}/{jev['lines']} lines P(yes)<0.5 ({jev['errors']} errors; model {','.join(jev['models']) or '?'})"
    jev["summary"] = (f"jev: failed ({n_err} consults; {', '.join(reasons)})" if jev["status"] == "failed" else
                      f"jev: not run ({', '.join(reasons)})" if jev["status"] == "not run" else
                      f"{detail}" if jev["status"] == "ok" else f"{detail}; consults {counts} ({', '.join(reasons)})")

    totals, item_means, gt = {}, {}, {}
    for c in combos:
        totals[c] = {arm: _agg([scores[(u, arm, c)]["total"] for u in uids if scores[(u, arm, c)]]) for arm in ARMS}
        item_means[c] = {arm: [statistics.fmean(scores[(u, arm, c)]["items"][i] for u in uids if scores[(u, arm, c)]) if any(scores[(u, arm, c)] for u in uids) else None
                               for i in range(judge.N_ITEMS)] for arm in ARMS}
        gt[c] = sum(1 for x, y in zip(item_means[c]["Bn"], item_means[c]["A"]) if x is not None and y is not None and x > y)

    total_a = compare_family(scores, uids, combos, "Bn", "A")
    thorough = compare_family(scores, uids, combos, "Bn", "B0", THOROUGH)
    fam = total_family(scores, uids, PRIMARY)
    cost = round(sum(json.loads(x).get("usd", 0) for x in ledger.path.read_text().splitlines() if x.strip()), 5) if ledger.path.exists() else 0.0
    row = {
        "round": a.round, "code_sha": code_sha(), "prompt_sha": frozen.prompt_sha(*[n for n in judge.FROZEN_FILES if n.startswith("pdqi9")]),
        "judge_sha": hashlib.sha256((frozen.prompt_sha("floor-items-v1.system.txt", "floor-missing-v1.system.txt")
                                     + "".join(client.resolve(j)[0] for j in judge.JUDGES)).encode()).hexdigest(),
        "render": render.RENDER_VERSION, "resolved_model_ids": resolved, "split_sha": frozen.hashes["split-v1.json"], "split": split_name, "candidate": a.candidate,
        "frozen_hashes": frozen.hashes, "n": len(uids), "uids_dropped_not_in_all_arms": dropped_uids, "parse_failures": parse_failures,
        "totals": totals, "item_means": item_means, "items_bn_gt_a": gt,
        "succinct_bn_minus_a": compare_family(scores, uids, combos, "Bn", "A", SUCCINCT),
        "thorough_bn_minus_b0": thorough,
        "total_bn_minus_a": total_a, "total_bn_minus_b0": compare_family(scores, uids, combos, "Bn", "B0"),
        "total_family_primary": fam, "target_12_7": target_check(gt, fam, thorough, total_a),
        "floors": table, "jev": jev, "replay_drops": sum(arms["Bn"][u]["drops"] for u in uids),
        "rendered_chars_mean": {arm: statistics.fmean(len(texts[(u, arm)]) for u in uids) for arm in ARMS},
        "cost_usd": cost, "verdict": "PENDING (freescript-lead)",
    }
    (out / "floors.json").write_text(json.dumps(fl, indent=1, default=str), encoding="utf-8")
    (out / "jev.json").write_text(json.dumps(jev_res, indent=1), encoding="utf-8")
    (out / "scores.json").write_text(json.dumps([{"uid": u, "arm": ar, "combo": c, "note_id": judge.note_id(u, ar), **stamp, **(v or {"parse_failure": True})}
                                                 for (u, ar, c), v in sorted(scores.items())], indent=1), encoding="utf-8")
    jp = scoreboard.write(row, Path(a.scoreboard))
    print(f"scored {len(uids)} consults, split {split_name}, floors {'PASS' if table['all_pass'] else 'FAIL'}, row -> {jp.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
