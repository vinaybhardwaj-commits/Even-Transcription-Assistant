#!/usr/bin/env python3
"""FUSER v2-D DEV gate report (PRINT-ONLY; pre-reg r3 section 5 and G1-G4). Reads the v2 run JSONL (fuserv2_dev_run.py),
P = s1-results/old, clinical1 truth. Uses the S1 scorer (clinical_score via score.py) and the unmodified cap scorer
(8c176820fd62); nothing here is imported by fuserv2/.
usage: fuserv2_dev_gates.py V2_RUN.jsonl
Definitions used (declared; refuter-2 to check against r3):
  attributed S1: a truth drug whose S1 first mention (position found by clinical_score._find) lies INSIDE the insert block
    gets dose credit only if its own insert (canonical name == lexicon.clean_ingredient(truth name)) carries that value;
    raw S1 is printed beside. Drug hit is unchanged (raw).
  G4 correct drug = insert canonical name == clean_ingredient(some truth drug name in that window); correct dose = value equal
    (numeric) and, when the insert has a unit, unit equal. STRICT variant (unit must be present and equal) printed too.
  false-drug rate = inserts with no truth-drug match / inserts. wrong dose rate = dose inserts (value != "") whose drug is false
    or whose value/unit is wrong / dose inserts. Wilson 95% (z=1.96) upper bounds; pooled over windows (not independent).
  G3m: per item (drug, dose, diagnosis, investigation, follow_up_days) P hit AND v2 miss, S1 (raw and attributed) and cap CAPTURED."""
import collections, json, math, os, sys
sys.dont_write_bytecode = True
CAP_DIR = "/home/eta/eta-data/cap3-work/src/studies/2026-09-26-clinical-capture"
sys.path[:0] = [os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fuserv1"),
                "/tmp/wt-rf-s1-m6/kit/diag-rig", CAP_DIR]
import score, wavio, lexicon, clinical_score as cs, cap_scorer as cap  # noqa: E402
SUITE = "/home/eta/eta-data/diag-rig/stimuli/clinical1"
P_DIR = "/home/eta/oc/router-fix/s1-results/old"
TYPES = ("drug", "dose", "diagnosis", "investigation", "follow_up_days")


def wilson_upper(k, n, z=1.96):
    if n == 0: return 1.0
    p = k / n; d = 1 + z * z / n
    return (p + z * z / (2 * n) + z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d


def lang_of(t):
    ls = sorted({e["lang"] for e in t["events"] if "lang" in e}); return ls[0] if len(ls) == 1 else "+".join(ls)


def cap_items(t):
    out = []
    for i, it in enumerate(t["clinical_items"]):
        if it["type"] == "drug":
            out.append({"item_id": i, "type": "drug", "term": it["name"], "strength": f'{it["dose_value"]} {it["dose_unit"]}', "dose": f'{it["dose_value"]} {it["dose_unit"]}'})
        elif it["type"] in ("diagnosis", "investigation"):
            out.append({"item_id": i, "type": it["type"], "term": str(it["value"])})
    return out


def same_num(a, b):
    try: return float(a) == float(b)
    except (TypeError, ValueError): return False


def item_hits(item, text, tl, ins, block_tokens):
    """-> {type: (raw_hit, attributed_hit)} for ONE truth item (drug -> drug+dose entries)."""
    r = cs.items_score([item], text, tl)
    out = {}
    for t in TYPES:
        if r[t][1]: out[t] = [bool(r[t][0]), bool(r[t][0])]
    if item["type"] == "drug" and out["drug"][0] and out["dose"][0]:
        toks = cs.tokens(text); pos = cs._find(item["name"].split()[0], toks, 0.72)
        if pos is not None and pos < block_tokens:
            canon = lexicon.clean_ingredient(item["name"])
            own = [i for i in ins if i["drug"] == canon]
            ok = any(same_num(i["value"], item["dose_value"]) for i in own)
            out["dose"][1] = ok
    return out


def main():
    rows = [json.loads(l) for l in open(sys.argv[1])]
    v2 = collections.defaultdict(dict)
    for r in rows:
        if not r.get("header"): v2[r["variant"]][r["window_id"]] = r
    wids = sorted(v2["D-any"])
    truths = {w: wavio.jload(f"{SUITE}/{w}.truth.json") for w in wids}
    ptext = {w: (json.load(open(f"{P_DIR}/{w}.result.json")).get("engines", {}).get("stt", {}).get("text") or "") for w in wids}
    print(f"windows {len(wids)}; cap blob 8c176820fd62; P = s1-results/old")
    res = {}
    for var in ("D-any", "D-two"):
        S = collections.defaultdict(collections.Counter)      # (sys, lang) -> counts
        g3 = collections.defaultdict(list)
        g4 = collections.Counter()
        for w in wids:
            t = truths[w]; tl = lang_of(t); r = v2[var][w]; ins = r["inserts"]
            block = r["text"][:-len(ptext[w])].rstrip("\n") if ins else ""
            bt = len(cs.tokens(block)) if ins else 0
            drugs = [lexicon.clean_ingredient(i["name"]) for i in t["clinical_items"] if i["type"] == "drug"]
            for i in ins:
                g4["ins"] += 1; okd = i["drug"] in drugs; g4["false_drug"] += not okd
                if i["value"]:
                    g4["dose_ins"] += 1; tr = next((x for x in t["clinical_items"] if x["type"] == "drug" and lexicon.clean_ingredient(x["name"]) == i["drug"]), None)
                    okv = bool(tr) and same_num(i["value"], tr["dose_value"]) and (not i["unit"] or i["unit"] == str(tr["dose_unit"]).lower())
                    strict = bool(tr) and same_num(i["value"], tr["dose_value"]) and i["unit"] == str(tr["dose_unit"]).lower()
                    g4["wrong_dose"] += not okv; g4["wrong_dose_strict"] += not strict
            for item in t["clinical_items"]:
                hp = item_hits(item, ptext[w], tl, [], 0); hv = item_hits(item, r["text"], tl, ins, bt)
                for ty in hp:
                    for k, idx in (("raw", 0), ("attr", 1)):
                        if hp[ty][idx] and not hv[ty][idx]: g3[f"S1 {k} {ty}"].append((w, item.get("name") or item.get("value")))
                    for grp in (tl, "ALL"):
                        S[("P", grp)][f"{ty}_n"] += 1; S[("P", grp)][f"{ty}_hit"] += hp[ty][0]
                        S[("v2", grp)][f"{ty}_n"] += 1; S[("v2", grp)][f"{ty}_hit"] += hv[ty][0]; S[("v2", grp)][f"{ty}_attr"] += hv[ty][1]
                        if ty == "drug" or (ty == "dose" and tl not in ("ta", "ml")):   # S1 ALL: ta/ml drug only (RUN 3 table rule)
                            for sn, h in (("P", hp[ty][0]), ("v2", hv[ty][0])):
                                S[(sn, grp)]["a_n"] += 1; S[(sn, grp)]["a_hit"] += h
                            S[("v2", grp)]["a_attr"] += hv[ty][1]
            for sysn, text in (("P", ptext[w]), ("v2", r["text"])):
                cr = cap.score_bundle({"links": [{"link_id": w, "consult_id": w, "transcript": text, "rx_items": cap_items(t), "speech_gaps": False}], "brand_generic": {}})
                for x in cr:
                    for grp in (tl, "ALL"):
                        c = S[(sysn, grp)]; c["cap_items"] += 1; c["cap_cap"] += x["class"] == "CAPTURED"
                        if x["item_type"] == "drug": c["cap_drugs"] += 1; c["cap_drug"] += x["class"] == "CAPTURED"
                    if sysn == "P": g3.setdefault("_pcap", {})[(w, x["item_id"])] = x["class"] == "CAPTURED"
                    elif g3["_pcap"].get((w, x["item_id"])) and x["class"] != "CAPTURED": g3["cap captured"].append((w, x["item_id"]))
        g3.pop("_pcap", None)
        res[var] = (S, g3, g4)
    pc = lambda a, b: 100.0 * a / b if b else 0.0
    def s1all(c, key): return pc(c[f"a_{key}"], c["a_n"])
    for var, (S, g3, g4) in res.items():
        Pa, Va = S[("P", "ALL")], S[("v2", "ALL")]
        langs = sorted({g for (s, g) in S if g != "ALL"})
        n_i, fd, di, wd, wds = g4["ins"], g4["false_drug"], g4["dose_ins"], g4["wrong_dose"], g4["wrong_dose_strict"]
        fdu, wdu = wilson_upper(fd, n_i), wilson_upper(wd, di)
        safe = n_i >= 50 and fd / max(n_i, 1) <= 0.02 and fdu <= 0.07
        dose_on = di >= 30 and wd / max(di, 1) <= 0.05 and wdu <= 0.12
        print(f"\n===== {var} =====\nG4: inserts {n_i} false-drug {fd} ({pc(fd, n_i):.2f}%, Wilson upper {100*fdu:.2f}%) -> safety {'PASS' if safe else 'FAIL/NOT EVALUABLE' if n_i < 50 else 'FAIL'}"
              f"\n    dose inserts {di} wrong {wd} ({pc(wd, di):.2f}%, upper {100*wdu:.2f}%; strict-unit wrong {wds}) -> dose inserts {'ON' if dose_on else 'OFF'}")
        print(f"G1 attributed S1 ALL (drug+dose): P {s1all(Pa,'hit'):.1f} v2 raw {s1all(Va,'hit'):.1f} v2 attributed "
              f"{s1all(Va, 'attr'):.1f}  (need >= P+2.0 attributed)")
        for l in langs:
            P, V = S[("P", l)], S[("v2", l)]
            a = s1all(V, "attr"); p = s1all(P, "hit")
            print(f"    {l:6s} P {p:5.1f} v2 attr {a:5.1f} delta {a-p:+5.1f}{'  BELOW P by >2.0' if a < p - 2.0 else ''}")
        print(f"G2 cap captured% P {pc(Pa['cap_cap'], Pa['cap_items']):.1f} v2 {pc(Va['cap_cap'], Va['cap_items']):.1f} (need >= P+3.3); "
              f"cap drug% P {pc(Pa['cap_drug'], Pa['cap_drugs']):.1f} v2 {pc(Va['cap_drug'], Va['cap_drugs']):.1f} (not lower by >1)")
        print("G3m (P hit and v2 miss; need all zero):", {k: len(v) for k, v in sorted(g3.items())} or "none")
        for k, v in sorted(g3.items()):
            if v: print("   ", k, v[:10])
    print("\nD6 selection is on G4 safety only: D-any if safe else D-two else FAIL. Disclosed: clinical1 truth drugs 17/19 in Pulse lexicon (optimistic DEV).")


if __name__ == "__main__":
    main()
