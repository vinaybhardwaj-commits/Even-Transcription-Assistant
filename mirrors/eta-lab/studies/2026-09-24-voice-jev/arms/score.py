"""Scorer (ruling 165). Reads raw arm outputs + human truth, applies the hashed combine rule and the pass bar, writes results.json and SUMMARY.md (<= 15 lines).
Deterministic: vj-refuter re-runs it from the stored raw outputs and must get identical numbers. Only the scorer and the refuter read truth / human counts / key.json.
All three hashes (freeze b961291ae64c + addendum 9c335c59c5be + addendum 166 87b8cdac4330) and the combine-rule sha are stamped into results.json and the summary.

Usage: score.py --arm1 out/arm1.jsonl --truth ~/vj/truth/turn_labels.jsonl [--arm2 .. --arm3 .. --arm4 ..] --rule COMBINE_RULE.md --rule-sha <sha>
                [--requery2/3/4 FILE] [--windows windows.jsonl] [--human-counts ~/vj/truth/human-counts.json] [--key-json key.json] [--prices prices.json] --outdir DIR
truth (166 B): rows {turn_id, rater, label} or {turn_id, labels: {rater: label}}, optional `source` (v_existing = V's pilot/listening labels, first priority; e3_recovered = the 70 recovered E-3 Cardiology turns (ruling 185); vpilot_voice_verified = the +22 not-doctor turns from voice-verified single-doctor room-days, applied by vj-refuter (ruling 214); who_is_speaking = top-up page; anything else ranks last);
  label in doctor|patient|companion|staff|cannot tell (a legacy single {label} / {is_doctor} row also works). A turn labelled by several sources uses only its highest-priority source that has a usable answer (a source whose answers are all 'cannot tell' is skipped; disagreement inside the chosen source still excludes the turn).
"""
import argparse, json, math, os, sys
import common as C
import combine as K

SOURCE_PRIORITY = ["v_existing", "e3_recovered", "vpilot_voice_verified", "who_is_speaking"]
WITHOUT_TAG = "vpilot_voice_verified"     # ruling 214: every result is reported with and without this source
MIN_DOUBTFUL_TRUTH, MIN_GAIN, MAX_P, MIN_AGREE, MIN_COUNT_WINDOWS, MIN_CONFIDENT_TRUTH = 60, 0.05, 0.05, 0.90, 20, 30


def sign_test_p(b, c):
    """Exact McNemar on the discordant pairs (two-sided exact binomial, p = 0.5)."""
    n = b + c
    if n == 0: return 1.0
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n)


def norm_label(x):
    x = str(x).strip().lower().replace(" ", "_")
    return "cannot_tell" if x.startswith("cannot") else ("doctor" if x.startswith("doctor") else "other")


def load_truth(p, exclude_sources=()):
    """B: binary doctor vs not from >= 1 usable human answer. 'cannot tell' answers are ignored; a turn with no usable answer, or whose usable
    answers disagree on doctor vs not, is excluded and reported. Returns ({turn_id: is_doctor}, exclusion report)."""
    per = {}
    for r in C.read_jsonl(p):
        if r.get("source") in exclude_sources: continue
        if "labels" in r: ls = list(r["labels"].values())
        elif "is_doctor" in r: ls = ["doctor" if r["is_doctor"] else "patient"]
        else: ls = [r["label"]]
        per.setdefault(r["turn_id"], {}).setdefault(r.get("source", "unspecified"), []).extend(ls)
    rank = lambda src: SOURCE_PRIORITY.index(src) if src in SOURCE_PRIORITY else len(SOURCE_PRIORITY)
    votes, src_of = {}, {}
    usable = lambda ls: any(norm_label(x) != "cannot_tell" for x in ls)
    for t, by in per.items():
        src = min([k for k in by if usable(by[k])] or list(by), key=rank); votes[t] = by[src]; src_of[t] = src   # highest-priority source that has a usable answer
    truth, no_usable, disagree = {}, [], []
    for t, ls in sorted(votes.items()):
        u = {norm_label(x) == "doctor" for x in ls if norm_label(x) != "cannot_tell"}
        if not u: no_usable.append(t)
        elif len(u) > 1: disagree.append(t)
        else: truth[t] = u.pop()
    by_source = {}
    for t in truth: by_source[src_of[t]] = by_source.get(src_of[t], 0) + 1
    return truth, {"n_labeled_turns": len(votes), "n_usable": len(truth), "usable_by_source": by_source, "excluded_no_usable_answer": len(no_usable), "excluded_raters_disagree": len(disagree),
                   "disagree_turn_ids": disagree}


def norm_human(raw):
    """{wid: n | [n..] | {rater: n}} -> {wid: [n..]}."""
    out = {}
    for w, v in raw.items():
        vs = list(v.values()) if isinstance(v, dict) else (v if isinstance(v, list) else [v])
        vs = [int(x) for x in vs if x is not None]
        if vs: out[w] = vs
    return out


def acc(items):
    n = len(items); c = sum(items)
    return {"n": n, "correct": c, "accuracy": round(c / n, 4) if n else None}


def score_turns(arm, a1, truth, outs, rule):
    rows = []
    for tid, t in truth.items():
        if tid not in a1: continue
        r = a1[tid]
        fin = ("doctor" if r["is_doctor"] else "not_doctor") if arm == 1 else K.combine(arm, r, outs.get(tid), rule)
        direct = K.raw_final(arm, outs.get(tid), rule) if (arm != 1 and outs.get(tid)) else None
        rows.append({"turn_id": tid, "doubtful": r["doubtful"], "stratum": role_group(r), "final": fin, "truth": t, "correct": fin != K.UNSURE and (fin == K.DOCTOR) == t,
                     "arm1_correct": r["is_doctor"] == t, "arm1_is_doctor": r["is_doctor"], "direct": direct, "missing": arm != 1 and r["doubtful"] and not outs.get(tid)})
    return rows


def role_group(r): return r.get("role") or "empty"


def role_weights(a1_rows):
    """215: weights = production role shares among ALL doubtful turns in the arm 1 file (labelled or not). Role null / "" = "empty"."""
    n = {}
    for r in a1_rows:
        if r["doubtful"]: g = role_group(r); n[g] = n.get(g, 0) + 1
    tot = sum(n.values())
    return {g: c / tot for g, c in sorted(n.items())} if tot else {}


def weighted_acc(rows, key, weights):
    """Population-weighted accuracy: per-role accuracy on the labelled turns, combined with the role shares (renormalised over roles that have labelled turns)."""
    by = {}
    for r in rows: by.setdefault(r["stratum"], []).append(r[key])
    present = {g: w for g, w in weights.items() if g in by}
    if not present: return None, sorted(weights)
    tot = sum(present.values())
    return sum(w / tot * sum(by[g]) / len(by[g]) for g, w in present.items()), sorted(g for g in weights if g not in by)


def paired(rows, weights=None):
    d = [r for r in rows if r["doubtful"]]
    b = sum(r["correct"] and not r["arm1_correct"] for r in d); c = sum((not r["correct"]) and r["arm1_correct"] for r in d)
    a, a1 = acc([r["correct"] for r in d]), acc([r["arm1_correct"] for r in d])
    out = {"arm_right_arm1_wrong": b, "arm_wrong_arm1_right": c, "mcnemar_exact_p": round(sign_test_p(b, c), 4),
           "gain_pp": None if a["accuracy"] is None else round(100 * (a["accuracy"] - a1["accuracy"]), 2)}
    wa, miss = weighted_acc(d, "correct", weights or {}); wa1, _ = weighted_acc(d, "arm1_correct", weights or {})
    out.update({"gain_pp_weighted": None if wa is None else round(100 * (wa - wa1), 2), "weighted_acc_arm": None if wa is None else round(wa, 4),
                "weighted_acc_arm1": None if wa1 is None else round(wa1, 4), "role_weights": {g: round(w, 4) for g, w in (weights or {}).items()}, "roles_without_labelled_turns": miss})
    return out


def win_criteria(p):
    """215: F2 = population-weighted gain >= 5 pp AND the unweighted difference has the same sign (positive); F3 = exact McNemar on the paired, unweighted sample."""
    return {"F2": p["gain_pp_weighted"] is not None and p["gain_pp_weighted"] >= 100 * MIN_GAIN and p["gain_pp"] is not None and p["gain_pp"] > 0,
            "F3": p["mcnemar_exact_p"] < MAX_P and p["arm_right_arm1_wrong"] > p["arm_wrong_arm1_right"]}


def confident_sample(rows):
    """E: the arm's direct answer on the confident sample (turns it was run on, with usable truth). unsure/failed counts as wrong."""
    s = [r for r in rows if not r["doubtful"] and r["direct"] is not None]
    dr = lambda r: {"doctor": True, "not_doctor": False}.get(r["direct"])
    return {"n": len(s), "flipped_right_to_wrong": sum(r["arm1_correct"] and (r["direct"] == K.UNSURE or dr(r) != r["truth"]) for r in s),
            "flipped_of_which_unsure": sum(r["arm1_correct"] and r["direct"] == K.UNSURE for r in s),
            "would_have_changed": sum(r["direct"] != K.UNSURE and dr(r) != r["arm1_is_doctor"] for r in s), "unsure": sum(r["direct"] == K.UNSURE for r in s),
            "direct_accuracy": acc([r["direct"] != K.UNSURE and dr(r) == r["truth"] for r in s])["accuracy"],
            "arm1_accuracy": acc([r["arm1_correct"] for r in s])["accuracy"]}


def stability(arm, a1, truth, outs, rq, rule, weights):
    """G: agreement of the raw answers on the re-queried doubtful turns >= 0.90, and the win (F2, F3) still holds with the re-query answers substituted."""
    if rq is None: return {"status": "not_run"}
    d = {t for t in truth if t in a1 and a1[t]["doubtful"]}; ids = [t for t in rq if t in d]
    n_d = len(d); need = n_d // 5
    agree = sum(K.raw_final(arm, outs.get(t), rule) == K.raw_final(arm, rq[t], rule) for t in ids)
    sub = score_turns(arm, a1, truth, {**outs, **{t: rq[t] for t in ids}}, rule); pr = paired(sub, weights)
    win = all(win_criteria(pr).values())
    return {"status": "run", "n_requeried": len(ids), "n_doubtful_scored": n_d, "share": round(len(ids) / n_d, 4) if n_d else None, "share_ok": len(ids) >= need and len(ids) > 0,
            "agreement": round(agree / len(ids), 4) if ids else None, "agreement_ok": bool(ids) and agree / len(ids) >= MIN_AGREE, "win_holds_with_requery": bool(win), "paired_with_requery": pr,
            "holds": bool(ids) and len(ids) >= need and agree / len(ids) >= MIN_AGREE and win}


def pass_bar(s, stab):
    """F1-F5, F4 per ruling 169: judged on the confident human-labelled turns the arm was run on; needs >= 30, else INSUFFICIENT (the arm cannot be adopted
    for production, only continued). A computed flag; the verdict is Fable's and the refuter's."""
    p, cs = s["vs_arm1_doubtful"], s["confident_sample"]
    f4 = "INSUFFICIENT" if cs["n"] < MIN_CONFIDENT_TRUTH else ("PASS" if cs["flipped_right_to_wrong"] == 0 else "FAIL")
    c = {"F1_n_doubtful_with_truth>=60": s["doubtful"]["n"] >= MIN_DOUBTFUL_TRUTH,
         "F2_weighted_gain>=5pp_and_unweighted_same_sign": win_criteria(p)["F2"],
         "F3_mcnemar_p<0.05_unweighted": win_criteria(p)["F3"],
         "F4_zero_confident_flips_n>=30": f4 == "PASS",
         "F5_stability": stab.get("holds", False)}
    others = all(v for k, v in c.items() if not k.startswith("F4"))
    return {"criteria": c, "F4_status": f4, "meets_pass_bar": all(c.values()),
            "status": "ADOPTABLE" if all(c.values()) else ("CONTINUE_ONLY (F4 insufficient)" if f4 == "INSUFFICIENT" and others else "NOT_ADOPTED")}


def summarize(arm, rows, hours, outs, prices, stab=None, weights=None):
    d = [r for r in rows if r["doubtful"]]; c = [r for r in rows if not r["doubtful"]]
    s = {"n_turns": len(rows), "doubtful": acc([r["correct"] for r in d]), "confident": acc([r["correct"] for r in c]),
         "unsure_n": sum(r["final"] == K.UNSURE for r in rows), "unsure_doubtful_n": sum(r["final"] == K.UNSURE for r in d)}
    if arm != 1: s["missing_n"] = sum(r["missing"] for r in d)      # doubtful turns never run: scored UNSURE (wrong) but counted here, apart from errors_n
    if arm == 1:
        nd = [r for r in rows if not r["arm1_is_doctor"]]; s["arm1_not_doctor_n"] = len(nd)
    else:
        s["vs_arm1_doubtful"] = paired(rows, weights); s["confident_sample"] = confident_sample(rows)
        s["escalated_share"] = round(len(d) / len(rows), 4) if rows else None
        s["cost"] = cost(arm, outs.values(), hours, prices); s["errors_n"] = sum("error" in o for o in outs.values())
        s["stability"] = stab or {"status": "not_run"}; s["pass_bar"] = pass_bar(s, s["stability"])
    return s


def cost(arm, outs, hours, prices):
    tin = tout = 0; lat = 0.0
    for o in outs:
        u = o.get("usage") or {}
        tin += u.get("input_tokens", u.get("promptTokenCount", 0)) or 0
        tout += (u.get("output_tokens", u.get("candidatesTokenCount", 0)) or 0) + (u.get("thoughtsTokenCount", 0) or 0)
        lat += o.get("latency_s", 0) or 0
    p = (prices or {}).get("jev" if arm in (2, 3) else "gemini", {})
    usd = None if p.get("input_per_m") is None or p.get("output_per_m") is None else round((tin * p["input_per_m"] + tout * p["output_per_m"]) / 1e6, 4)
    per = (lambda x: round(x / hours, 3)) if hours else (lambda x: None)
    return {"tokens_in": tin, "tokens_out": tout, "usd_total": usd, "usd_per_audio_hour": per(usd) if usd is not None else None, "prices_status": p.get("status"),
            "call_seconds_total": round(lat, 2), "call_seconds_per_audio_hour": per(lat), "audio_hours": round(hours, 4) if hours else None}


def score_counts(arm3_rows, arm4_rows, a1_rows, human, key):
    """H. Only once >= 20 excerpts have a human count. Arm 1 = both diarizers, arm 4 = L2 (exact_any / exact_consensus with n); arm 3's Q3 is a secondary metric:
    a window is 'third person detected' if any turn's q3 p >= 0.5, against the human count >= 3 (consensus windows only)."""
    if not human: return None
    out = {"n_windows_with_human_count": len(human), "n_consensus_windows": sum(len(set(v)) == 1 for v in human.values())}
    if len(human) < MIN_COUNT_WINDOWS:
        return {**out, "scored": False, "reason": f"needs >= {MIN_COUNT_WINDOWS} excerpts with a human count (ruling 161)"}
    a1 = {}
    for r in a1_rows:
        if r.get("window_id") and r.get("nemotron_n") is not None: a1.setdefault(r["window_id"], (r["nemotron_n"], r.get("pyannote_n")))
    for wid, v in (key or {}).items(): a1.setdefault(wid, (v.get("nemotron_count"), v.get("pyannote_count")))
    l2 = {r["window_id"]: r["speakers"] for r in arm4_rows if r.get("kind") == "l2" and "error" not in r}
    src = {"arm1_nemotron": {w: v[0] for w, v in a1.items() if v[0] is not None}, "arm1_pyannote": {w: v[1] for w, v in a1.items() if v[1] is not None}, "arm4_l2": l2}
    out["scored"] = True
    for name, m in src.items():
        w_any = [w for w in human if w in m]; w_con = [w for w in w_any if len(set(human[w])) == 1]
        out[name] = {"n_any": len(w_any), "exact_any": sum(m[w] in human[w] for w in w_any), "n_consensus": len(w_con), "exact_consensus": sum(m[w] == human[w][0] for w in w_con)}
    q3 = {}
    for r in arm3_rows:
        if "error" not in r and r.get("window_id"): q3[r["window_id"]] = max(q3.get(r["window_id"], 0), r["q3_p"])
    tp = fp = fn = tn = 0
    for w, p in q3.items():
        h = human.get(w)
        if not h or not (all(x >= 3 for x in h) or all(x < 3 for x in h)): continue
        truth3 = h[0] >= 3
        tp += p >= .5 and truth3; fp += p >= .5 and not truth3; fn += p < .5 and truth3; tn += p < .5 and not truth3
    known = set().union(*[set(m) for m in src.values()], {r["window_id"] for r in arm3_rows if r.get("window_id")})
    out["human_ids_matching_no_source"] = sorted(w for w in human if w not in known)      # a mismatched id namespace shows up here instead of vanishing
    out["arm3_q3_third_person"] = {"n": tp + fp + fn + tn, "tp": tp, "fp": fp, "fn": fn, "tn": tn}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm1", required=True); ap.add_argument("--truth", required=True)
    for n in (2, 3, 4): ap.add_argument(f"--arm{n}"); ap.add_argument(f"--requery{n}")
    ap.add_argument("--rule", required=True); ap.add_argument("--rule-sha", required=True)
    ap.add_argument("--windows"); ap.add_argument("--human-counts"); ap.add_argument("--key-json"); ap.add_argument("--prices"); ap.add_argument("--outdir", required=True)
    a = ap.parse_args()
    stamp = C.stamp(); rule = K.load_rule(a.rule, a.rule_sha)
    a1_rows = C.read_jsonl(a.arm1); a1 = {r["turn_id"]: r for r in a1_rows}; weights = role_weights(a1_rows)
    wins = {r["window_id"]: r["duration_s"] for r in C.read_jsonl(a.windows)} if a.windows else {}
    prices = json.load(open(a.prices)) if a.prices else {}
    arm_raw = {}
    for n in (2, 3, 4):
        p = getattr(a, f"arm{n}")
        if not p: continue
        rows = C.read_jsonl(p); key = (lambda r: r.get("kind") == "l1") if n == 4 else (lambda r: True)
        rqp = getattr(a, f"requery{n}")
        arm_raw[n] = {"rows": rows, "outs": {r["turn_id"]: r for r in rows if key(r)}, "rq": {r["turn_id"]: r for r in C.read_jsonl(rqp) if key(r)} if rqp else None}

    def variant(exclude):
        truth, texcl = load_truth(a.truth, exclude); scored = {t for t in truth if t in a1}; truth = {t: truth[t] for t in scored}
        hours = sum(wins[w] for w in {a1[t]["window_id"] for t in scored} if w in wins) / 3600 if wins else None
        v = {"truth": {**texcl, "n_scored_with_arm1": len(scored), "excluded_sources": list(exclude)}, "arms": {},
             "arm1_empty_role": {"not_doctor_turns": sum(not r["is_doctor"] for r in a1_rows), "not_doctor_with_empty_role": sum(not r["is_doctor"] and r.get("role_empty") for r in a1_rows)}}
        v["arms"]["arm1"] = summarize(1, score_turns(1, a1, truth, {}, rule), hours, {}, prices)
        for n, d in arm_raw.items():
            tr = score_turns(n, a1, truth, d["outs"], rule)
            allouts = {**d["outs"], **({r["window_id"]: r for r in d["rows"] if r.get("kind") == "l2"} if n == 4 else {})}
            v["arms"][f"arm{n}"] = summarize(n, tr, hours, allouts, prices, stability(n, a1, truth, d["outs"], d["rq"], rule, weights), weights)
        return v

    res = {**stamp, "freeze_sha256": C.freeze_text()[1], "addendum_sha256": C.addendum_sha(), "addendum166_sha256": C.addendum166_sha(), "combine_rule_sha256": rule["sha256"], "conf_threshold": rule["conf_threshold"],
           **variant(())}                                                    # top level = all truth sources (with vpilot_voice_verified)
    res["without_vpilot_voice_verified"] = variant((WITHOUT_TAG,))            # ruling 214: every result reported with and without the +22 turns
    arm3_rows = arm_raw.get(3, {}).get("rows", []); arm4_rows = arm_raw.get(4, {}).get("rows", [])
    human = norm_human(json.load(open(a.human_counts))) if a.human_counts else None
    res["speaker_count"] = score_counts(arm3_rows, arm4_rows, a1_rows, human, json.load(open(a.key_json)) if a.key_json else None)
    os.makedirs(a.outdir, exist_ok=True)
    json.dump(res, open(os.path.join(a.outdir, "results.json"), "w"), indent=1, sort_keys=True)
    open(os.path.join(a.outdir, "SUMMARY.md"), "w").write(summary(res, "WITH all truth sources"))
    wo = {**res, **res["without_vpilot_voice_verified"]}
    open(os.path.join(a.outdir, "SUMMARY_without_vpilot.md"), "w").write(summary(wo, "WITHOUT vpilot_voice_verified"))
    print(open(os.path.join(a.outdir, "SUMMARY.md")).read()); print(open(os.path.join(a.outdir, "SUMMARY_without_vpilot.md")).read())


def summary(res, tag=""):
    t = res["truth"]; e = res["arm1_empty_role"]
    L = [f"VJ scoring [{tag}] | freeze {res['freeze_sha12']} + add165 {res['addendum_sha12']} + add166 {res['addendum166_sha12']} | rule {res['combine_rule_sha256'][:12]} (conf>={res['conf_threshold']}) | truth: {t['n_scored_with_arm1']} usable turns {t['usable_by_source']} "
         f"({t['excluded_no_usable_answer']} no usable answer, {t['excluded_raters_disagree']} raters disagree excluded) | arm1 not-doctor {e['not_doctor_turns']}, empty role {e['not_doctor_with_empty_role']}"]
    for name, s in res["arms"].items():
        d, c = s["doubtful"], s["confident"]
        line = f"{name}: doubtful {d['correct']}/{d['n']}={d['accuracy']} confident {c['correct']}/{c['n']}={c['accuracy']} unsure {s['unsure_n']}"
        if "vs_arm1_doubtful" in s:
            v, cs, k, sb = s["vs_arm1_doubtful"], s["confident_sample"], s["cost"], s["pass_bar"]
            line += (f" | vs arm1 +{v['arm_right_arm1_wrong']}/-{v['arm_wrong_arm1_right']} gain w {v['gain_pp_weighted']} / unw {v['gain_pp']}pp p={v['mcnemar_exact_p']} | conf sample n={cs['n']} flips {cs['flipped_right_to_wrong']} changed {cs['would_have_changed']}"
                     f" | stability {s['stability'].get('agreement', s['stability']['status'])} | usd/h {k['usd_per_audio_hour']} ({k['prices_status']}) sec/h {k['call_seconds_per_audio_hour']} | errors {s['errors_n']} missing {s['missing_n']} | {sb['status']}")
        L.append(line)
    sc = res.get("speaker_count")
    if sc:
        L.append(f"counts: {sc['n_windows_with_human_count']} windows with a human count ({sc['n_consensus_windows']} consensus)" + ("" if sc["scored"] else f" - NOT SCORED: {sc['reason']}"))
        for k in ("arm1_nemotron", "arm1_pyannote", "arm4_l2"):
            if sc.get("scored"): v = sc[k]; L.append(f"  {k}: exact_any {v['exact_any']}/{v['n_any']} exact_consensus {v['exact_consensus']}/{v['n_consensus']}")
        if sc.get("scored"): L.append(f"  human ids matching nothing: {len(sc['human_ids_matching_no_source'])}"); L.append(f"  arm3 Q3 third person vs human>=3: {sc['arm3_q3_third_person']}")
    L.append("meets_pass_bar is a computed flag; the verdict is Fable's and the refuter's.")
    return "\n".join(L[:15]) + "\n"


if __name__ == "__main__":
    sys.exit(main())
