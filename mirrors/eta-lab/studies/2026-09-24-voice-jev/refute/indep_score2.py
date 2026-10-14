"""vj-refuter independent scorer v2, written from COMBINE_RULE v7 (d36c9472569d) text only; imports nothing from arms/.
Run AS vjscore inside /srv/vj-truth/score.  Usage: indep_score2.py IN_DIR REQUERY_DIR|- WEIGHTS_JSON
Reports per arm, WITH and WITHOUT source vpilot_voice_verified (S9): doubtful acc (unweighted + weighted by pinned role shares, S2),
b/c + exact McNemar (S2/F3), confident direct flips (S3/F4), stability (S5/F5), status (S4). Counts and rates only, no per-turn labels."""
import json, math, sys, os
IN, RQ, WF = sys.argv[1], sys.argv[2], sys.argv[3]
THR = 0.70
rj = lambda p: [json.loads(l) for l in open(p) if l.strip()]
W = json.load(open(WF))["all_pool_doubtful"]["shares"]


def load_truth(excl):
    per = {}
    for r in rj(f"{IN}/truth_turns.jsonl"):
        if r["source"] in excl: continue
        per.setdefault(r["turn_id"], set()).add(bool(r["is_doctor"]))
    return {t: next(iter(v)) for t, v in per.items() if len(v) == 1}


a1 = {r["turn_id"]: r for r in rj(f"{IN}/out/real/arm1.jsonl")}
cur = {r["turn_id"] for r in rj(f"{IN}/inputs/cards.jsonl")}


def arm_rows(path, arm):
    out = {}
    if not os.path.exists(path): return out
    for r in rj(path):
        if arm == 4 and r.get("kind") != "l1": continue
        if r["turn_id"] in cur: out[r["turn_id"]] = r      # last row per current turn wins
    return out


def raw(arm, r):
    """the arm's own answer: True doctor / False not / None unsure"""
    if r is None or "error" in r: return None
    if arm == 4: return {"marked_middle_speaker": True, "not_marked_middle_speaker": False}.get(r.get("answer"))
    q = r.get("q1") or {}
    if q.get("choice") in (None, "cannot_tell") or (q.get("confidence") is None) or q["confidence"] < THR: return None
    return q["choice"] == "doctor"


def mcnemar(b, c):
    n = b + c
    return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n)


def evaluate(arm, outs, truth):
    D = [t for t in truth if t in a1 and a1[t]["doubtful"]]; Cf = [t for t in truth if t in a1 and not a1[t]["doubtful"]]
    fin = lambda t: raw(arm, outs.get(t))
    ok = {t: (fin(t) is not None and fin(t) == truth[t]) for t in D}; ok1 = {t: (a1[t]["is_doctor"] == truth[t]) for t in D}
    acc = lambda m, ids: (sum(m[t] for t in ids) / len(ids)) if ids else None
    role = lambda t: "clinician" if a1[t].get("role") == "clinician" else "empty"
    strata = {g: [t for t in D if role(t) == g] for g in ("clinician", "empty")}
    present = {g: W[g] for g in W if strata.get(g)}; tot = sum(present.values())
    wacc = lambda m: sum(present[g] / tot * acc(m, strata[g]) for g in present) if present else None
    b = sum(ok[t] and not ok1[t] for t in D); c = sum((not ok[t]) and ok1[t] for t in D)
    flips = sum(ok1_c and ((raw(arm, outs.get(t)) is None) or raw(arm, outs.get(t)) != truth[t]) for t, ok1_c in ((t, a1[t]["is_doctor"] == truth[t]) for t in Cf))
    res = {"n_doubtful": len(D), "n_confident": len(Cf), "acc_doubtful": acc(ok, D), "acc_doubtful_arm1": acc(ok1, D),
           "acc_weighted": wacc(ok), "acc_weighted_arm1": wacc(ok1), "per_stratum": {g: (len(strata[g]), acc(ok, strata[g]), acc(ok1, strata[g])) for g in strata},
           "b": b, "c": c, "p": mcnemar(b, c), "unsure_doubtful": sum(fin(t) is None for t in D), "missing": sum(t not in outs for t in D + Cf), "confident_flips": flips}
    res["gain_pp"] = None if res["acc_doubtful"] is None else 100 * (res["acc_doubtful"] - res["acc_doubtful_arm1"])
    res["gain_pp_w"] = None if res["acc_weighted"] is None else 100 * (res["acc_weighted"] - res["acc_weighted_arm1"])
    F1 = len(D) >= 60; F2 = res["gain_pp_w"] is not None and res["gain_pp_w"] >= 5 and res["gain_pp"] > 0; F3 = res["p"] < 0.05 and b > c
    F4 = "INSUFFICIENT" if len(Cf) < 30 else (flips == 0)
    res.update({"F1": F1, "F2": F2, "F3": F3, "F4": F4})
    return res, ok


for excl, tag in (((), "WITH"), (("vpilot_voice_verified",), "WITHOUT_vpilot_voice_verified")):
    truth = load_truth(excl); print(f"=== {tag}: truth turns {len(truth)} (doctor {sum(truth.values())}, not {len(truth) - sum(truth.values())})")
    for arm in (2, 3, 4):
        outs = arm_rows(f"{IN}/out/real/arm{arm}.jsonl", arm); res, _ = evaluate(arm, outs, truth)
        stab = "not_run"
        if RQ != "-" and os.path.exists(f"{RQ}/arm{arm}.jsonl"):
            rq = arm_rows(f"{RQ}/arm{arm}.jsonl", arm); ids = [t for t in rq if t in truth and a1[t]["doubtful"]]
            agree = sum(raw(arm, rq[t]) == raw(arm, outs.get(t)) for t in ids)
            sub = dict(outs); sub.update({t: rq[t] for t in ids}); r2, _ = evaluate(arm, sub, truth)
            stab = {"n": len(ids), "agreement": round(agree / len(ids), 3) if ids else None, "F2_with_requery": r2["F2"], "F3_with_requery": r2["F3"],
                    "holds": bool(ids) and agree / len(ids) >= 0.90 and r2["F2"] and r2["F3"]}
        res["F5"] = stab if isinstance(stab, str) else stab["holds"]
        status = "NOT_ADOPTED" if not (res["F1"] and res["F2"] and res["F3"] and res["F5"] is True) else ("CONTINUE_ONLY" if res["F4"] == "INSUFFICIENT" else ("ADOPTABLE" if res["F4"] else "NOT_ADOPTED"))
        f = lambda x: None if x is None else round(x, 4)
        print(f"arm{arm}: doubtful {res['n_doubtful']} acc {f(res['acc_doubtful'])} vs arm1 {f(res['acc_doubtful_arm1'])} gain {f(res['gain_pp'])}pp | weighted {f(res['acc_weighted'])} vs {f(res['acc_weighted_arm1'])} gain_w {f(res['gain_pp_w'])}pp"
              f" | b {res['b']} c {res['c']} p {f(res['p'])} | unsure {res['unsure_doubtful']} missing {res['missing']} | confident n {res['n_confident']} flips {res['confident_flips']}"
              f" | strata {json.dumps({g: (n, f(a), f(a1_)) for g, (n, a, a1_) in res['per_stratum'].items()})} | F1 {res['F1']} F2 {res['F2']} F3 {res['F3']} F4 {res['F4']} F5 {stab} | STATUS {status}")
