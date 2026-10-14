"""link3_tables.py: the pre-registered link-3 table set (P1-PREREG-v7.11 O3). Counts only, doctors pseudonymised, no ids in the output.
THIS IS THE ONE STEP THAT JOINS RESULTS TO THE SEALED CLASS KEY: run it only when all 37 items are in and the 10 group-C windows are finished, with
eta-refuter-2 present. The 4 pilot items are reported apart and excluded from every accuracy or rate (v7.7 K2.4).

  python3 link3_tables.py selftest     synthetic data only
  python3 link3_tables.py run          real data (box files); writes ~/eta-data/surgical-chain/p1/run/link3_tables.json

v7.17 adds T8a to T8d, the TRANSLATED stratum (all 19 language-limited items, one final record each from mt/, mt-b2/, mt-b3/), reported apart and never pooled with T1 to T7. T1 to T7 and T2b are unchanged.
The run reads the sealed class key: it runs ONCE, on the complete set, with eta-refuter-2 present, from a committed script that has his PASS (review first, then run).
"""
import collections, json, os, sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
SCORED = ("ACCEPTED", "AMBIGUOUS_TIE", "REJECT_BELOW_FLOOR", "SINGLE")


def vclass(v):
    return v.split("(")[0]


def cls(key):
    return ("POS " + key["stratum"]) if key["role"] == "POS" else key["role"]


def band(x):
    return None if x is None else ("<70%" if x < 0.70 else ("70-90%" if x <= 0.90 else ">90%"))


def iso_week(d):
    y, w, _ = date.fromisoformat(d[:10]).isocalendar(); return f"{y}-W{w:02d}"


# v7.17 T2: excluded from every yield and accuracy claim of the translated stratum; reported, never counted
EXCLUDED_TRANSLATED = frozenset({"c004", "c006", "c011", "c013", "c001", "c021"})      # the interim four, the pilot item c001, and c021 (would-be accept seen before the extension)
TRANSLATED_ITEMS = 19                                                                       # every LANGUAGE_LIMITED item of the final main run
T8_VERDICTS = ("ACCEPTED", "AMBIGUOUS_TIE", "REJECT_BELOW_FLOOR", "SINGLE", "INCOMPLETE", "MT_FAILED")
T8_NOT_SCORED = ("INCOMPLETE", "MT_FAILED")
DROP_REASONS = ("garbled", "untranslatable", "unflagged")          # C's reasons; an isolated-failed line (v7.16a F3) is counted under "unflagged"
INTERIM_LL = {"c004", "c006", "c011", "c013"}      # the language-limited items seen at the 19:35 interim: excluded from any accuracy claim for the flagged stratum (v7.12)


def build_tables(results, key, blind, flag_class, ptype, b_only=0):
    docs = {d: f"d{i+1:02d}" for i, d in enumerate(sorted({b["doctor_uid"] for b in blind.values()}))}
    rows = []
    for it, r in results.items():
        k = key[it]; b = blind[it]
        rows.append(dict(item=it, cls=cls(k), verdict=vclass(r["verdict"]), pilot=bool(r.get("pilot_item")), doc=docs[b["doctor_uid"]], week=iso_week(b["day"]), route=k["route"], tier=k["tier"],
                         flag=flag_class.get(k["rx"], "n/a"), ptypes=ptype.get(k["rx"], ["(no name)"]), eshare=r.get("english_share_best_room"), r=r))
    prim = [x for x in rows if not x["pilot"]]
    T = {"n_items": len(rows), "n_primary": len(prim), "n_pilot": len(rows) - len(prim)}
    C = collections.Counter
    T["T1_verdicts_by_class_primary"] = {c: dict(C(x["verdict"] for x in prim if x["cls"] == c)) for c in sorted({x["cls"] for x in prim})}
    T["T1_pilot_items_apart"] = dict(C(x["verdict"] for x in rows if x["pilot"]))
    ll = [x for x in prim if x["verdict"] == "LANGUAGE_LIMITED"]
    T["T2_language_limited"] = dict(total=len(ll), by_class=dict(C(x["cls"] for x in ll)), by_doctor=dict(C(x["doc"] for x in ll)),
                                    share_of_class={c: f"{sum(1 for x in ll if x['cls'] == c)}/{sum(1 for x in prim if x['cls'] == c)}" for c in sorted({x["cls"] for x in prim})})
    # v7.12: the flagged stratum (English-only chain of language-limited items): descriptive, never pooled into a headline rate or a denominator
    fl_items = [x for x in prim if x["verdict"] == "LANGUAGE_LIMITED" and x["r"].get("flagged")]
    T["T2b_flagged_language_limited_stratum"] = dict(
        n=len(fl_items), interim_seen_excluded=sum(1 for x in fl_items if x["item"] in INTERIM_LL),
        would_be_verdict_by_class={c: dict(C(vclass(x["r"]["flagged"]["would_be_verdict"]) for x in fl_items if x["cls"] == c and x["item"] not in INTERIM_LL)) for c in sorted({x["cls"] for x in fl_items})},
        note="descriptive only; floor 0.50 and margin 0.15 unchanged; the interim items shaped this stratum and are excluded from any accuracy claim")
    sc = [x for x in prim if x["verdict"] in SCORED]
    T["T3_english_share_bands"] = {bd: dict(scored=sum(1 for x in sc if band(x["eshare"]) == bd), accepted=sum(1 for x in sc if band(x["eshare"]) == bd and x["verdict"] == "ACCEPTED"),
                                            below_floor=sum(1 for x in sc if band(x["eshare"]) == bd and x["verdict"] == "REJECT_BELOW_FLOOR")) for bd in ("<70%", "70-90%", ">90%")}
    pos = [x for x in sc if x["cls"].startswith("POS")]; n2 = [x for x in sc if x["cls"] == "N2"]; n1 = [x for x in sc if x["cls"] == "N1"]
    both = sorted({x["week"] for x in pos} & {x["week"] for x in n2})
    pw = [x for x in pos if x["week"] in both]; nw = [x for x in n2 if x["week"] in both]
    T["T4_same_week_positives_vs_N2"] = dict(weeks=both, positives=dict(scored=len(pw), accepted=sum(x["verdict"] == "ACCEPTED" for x in pw)),
                                             n2=dict(scored=len(nw), accepted=sum(x["verdict"] == "ACCEPTED" for x in nw)), n1_descriptive=dict(scored=len(n1), accepted=sum(x["verdict"] == "ACCEPTED" for x in n1)))
    def split(keyf):
        out = collections.defaultdict(lambda: dict(accepted=0, not_accepted=0))
        for x in sc:
            for kk in keyf(x): out[kk]["accepted" if x["verdict"] == "ACCEPTED" else "not_accepted"] += 1
        return dict(sorted(out.items(), key=lambda kv: str(kv[0])))
    T["T5_selection"] = dict(by_doctor=split(lambda x: [x["doc"]]), by_flag_class=split(lambda x: [x["flag"]]), by_route=split(lambda x: [x["route"]]),
                             by_tier=split(lambda x: [x["tier"]]), by_ptype=split(lambda x: x["ptypes"]))
    fl = [x for x in sc if x["verdict"] != "REJECT_BELOW_FLOOR" and x["r"].get("local_drop") is not None]
    def drops(rs): return dict(n=len(rs), local_drop_gt_0_15=sum(1 for x in rs if x["r"]["local_drop"] > 0.15))
    T["T6_diagnostics"] = dict(local_drop_by_route={rt: drops([x for x in sc if x["route"] == rt and x["r"].get("local_drop") is not None]) for rt in sorted({x["route"] for x in sc})},
                               neighbours_in_padding=dict(C(x["r"].get("neighbours_in_padding") for x in prim)),
                               redactions_below_floor=dict(sum((C({k: v for k, v in (x["r"].get("redactions_transcript") or {}).items()}) for x in prim if x["verdict"] == "REJECT_BELOW_FLOOR"), C())),
                               counts=dict(SINGLE=sum(x["verdict"] == "SINGLE" for x in prim), INCOMPLETE=sum(x["verdict"] == "INCOMPLETE" for x in prim),
                                           AMBIGUOUS_TIE=sum(x["verdict"] == "AMBIGUOUS_TIE" for x in prim), PROVENANCE_UNVERIFIED=sum(x["verdict"] == "PROVENANCE_UNVERIFIED" for x in prim)),
                               pipeline=dict(C(("after_gate_change" if x["r"].get("after_gate_change") else "before_gate_change") for x in prim)))
    pt = lambda rs: dict(C(t for x in rs for t in x["ptypes"]).most_common(12))
    T["T7_procedure_mix_positives"] = dict(scored=pt([x for x in pos]), all_positive_items=pt([x for x in prim if x["cls"].startswith("POS")]))
    T["B_stratum_technique_changed_units"] = b_only
    return T


def merge_translated(b1, b2, b3):
    """v7.17 T1: one FINAL translated record per item. b1, b2, b3 are the batches' translated_results (item -> record). An item in batch 3 supersedes its batch-2 record,
    which must have been MT_FAILED (it is kept as attempt 1); every other item keeps its own batch's record. Returns {item: record + batch, attempts, attempt1}."""
    final = {}
    for it, r in b1.items():
        final[it] = dict(r, batch="b1", attempts=1, attempt1=None)
    for it, r in b2.items():
        if it in b3:
            continue
        final[it] = dict(r, batch="b2", attempts=1, attempt1=None)
    for it, r in b3.items():
        if it not in b2 or vclass(b2[it]["verdict"]) != "MT_FAILED":
            raise SystemExit("refused: a batch-3 item must be an MT_FAILED item of batch 2 (only failed items are re-attempted)")
        if it in b1:
            raise SystemExit("refused: an item is in two first-attempt batches")
        final[it] = dict(r, batch="b3", attempts=2, attempt1=b2[it]["verdict"])
    return final


def build_translated_tables(final, english_only, prov, screens, logs, key, excluded=EXCLUDED_TRANSLATED):
    """v7.17 T8a to T8d. final: merge_translated output; english_only: item -> the native flagged would-be verdict; prov: {batch: provenance items}; screens: {batch: screen report items}; logs: {batch: {reason: count}} from each batch's mt_log (reasons only, never text; a malformed reply of an
    older run without a logged reason counts as "not_logged"); key: the class key (the ONLY use of it here is the class of each item). T8c's per-batch rows are ATTEMPT-level (batch 1 and
    batch 2 are first attempts, batch 3 is the second attempt at the four failed items); its "final" row is the final status of the 19 items. Counts only: no item id, no doctor, no text appears in the output. Never pooled with T1 to T7."""
    if len(final) != TRANSLATED_ITEMS:
        raise SystemExit(f"refused: the translated stratum must hold all {TRANSLATED_ITEMS} language-limited items, got {len(final)}")
    if not set(excluded) <= set(final):
        raise SystemExit("refused: an excluded item is not in the translated stratum")
    for it, r in final.items():                    # T8d's best-room source must be READ, never defaulted: an accepted record without its rooms is a refusal, not a "native room"
        if vclass(r["verdict"]) == "ACCEPTED" and ("best_room" not in r or not isinstance(r.get("translated_rooms"), list)):
            raise SystemExit("refused: an ACCEPTED translated record lacks best_room or translated_rooms")
    C = collections.Counter
    rows = [dict(item=it, cls=cls(key[it]), verdict=vclass(r["verdict"]), excl=it in excluded, r=r, eo=vclass(english_only.get(it) or "n/a")) for it, r in final.items()]
    counted = [x for x in rows if not x["excl"]]; excl = [x for x in rows if x["excl"]]
    T = {"note": "the translated stratum is reported apart and is never pooled with T1 to T7; excluded items are shown, never counted", "n_items": len(rows), "n_counted": len(counted), "n_excluded": len(excl)}
    classes = sorted({x["cls"] for x in rows})
    T["T8a_verdicts_by_class"] = dict(counted={c: {v: n for v, n in sorted(C(x["verdict"] for x in counted if x["cls"] == c).items())} for c in classes},
                                     excluded_not_counted={c: {v: n for v, n in sorted(C(x["verdict"] for x in excl if x["cls"] == c).items())} for c in classes if any(x["cls"] == c for x in excl)})
    yield_ = {}
    for c in classes + ["ALL"]:
        rs = [x for x in counted if c == "ALL" or x["cls"] == c]; sc = [x for x in rs if x["verdict"] in SCORED]; acc = sum(x["verdict"] == "ACCEPTED" for x in sc)
        yield_[c] = dict(scored=len(sc), accepted=acc, not_scored=sum(1 for x in rs if x["verdict"] in T8_NOT_SCORED), rate=(f"{acc}/{len(sc)}" if sc else None))
    T["T8b_yield_non_excluded_only"] = yield_
    def per_batch(b):
        pi = prov.get(b) or {}; sr = screens.get(b) or {}
        return dict(items_mt_ok=sum(1 for v in pi.values() if str(v.get("status")) == "MT_OK"), items_mt_failed=sum(1 for v in pi.values() if str(v.get("status")).startswith("MT_FAILED")),
                    turns_in=sum(v.get("turns_in", 0) for v in pi.values()), isolated_failed_lines=sum(v.get("isolated_failed_lines", 0) for v in pi.values()),
                    retries=sum(v.get("retries", 0) for v in pi.values()), repeats=sum(v.get("repeats", 0) for v in pi.values()),
                    kept=sum(v.get("kept", 0) for v in sr.values()), dropped_by_reason={k: sum((v.get("dropped") or {}).get(k, 0) for v in sr.values()) for k in DROP_REASONS},
                    malformed_reasons=dict(sorted((logs.get(b) or {}).items())))
    T["T8c_translation"] = {b: per_batch(b) for b in ("b1", "b2", "b3")}
    T["T8c_translation"]["final"] = dict(items_mt_ok=sum(1 for x in rows if x["verdict"] != "MT_FAILED"), items_mt_failed=sum(1 for x in rows if x["verdict"] == "MT_FAILED"),
                                         reattempted=sum(1 for x in rows if x["r"]["attempts"] == 2))
    def cross(rs):
        out = collections.defaultdict(dict)
        for x in rs: out[x["eo"]][x["verdict"]] = out[x["eo"]].get(x["verdict"], 0) + 1
        return {k: dict(sorted(v.items())) for k, v in sorted(out.items())}
    acc = [x for x in rows if x["verdict"] == "ACCEPTED"]
    T["T8d_translation_changed"] = dict(english_only_by_translated_counted=cross(counted), english_only_by_translated_excluded_not_counted=cross(excl),
                                        accepted_best_room=dict(translated_room=sum(1 for x in acc if x["r"].get("best_room") in (x["r"].get("translated_rooms") or [])),
                                                                native_english_room=sum(1 for x in acc if x["r"].get("best_room") not in (x["r"].get("translated_rooms") or []))))
    return T


def selftest():
    key = {f"c{i:03d}": dict(role=("POS" if i <= 4 else "N2"), stratum="A+ full", rx=f"rx{i}", route=("KEY" if i % 2 else "RXWIN"), tier="A") for i in range(1, 9)}
    blind = {k: dict(doctor_uid="docA" if int(k[1:]) % 2 else "docB", day="2026-09-1%d" % (int(k[1:]) % 5)) for k in key}
    verd = ["ACCEPTED", "LANGUAGE_LIMITED", "REJECT_BELOW_FLOOR", "AMBIGUOUS_TIE(rx)", "ACCEPTED", "LANGUAGE_LIMITED", "SINGLE", "INCOMPLETE"]
    res = {k: dict(verdict=v, pilot_item=(k == "c008"), flagged=({"would_be_verdict": "ACCEPTED"} if v == "LANGUAGE_LIMITED" else None), english_share_best_room=0.5 + 0.06 * i, local_drop=0.1 * (i % 3), neighbours_in_padding=i % 3,
                   redactions_transcript={"PATIENT_NAME": i}, after_gate_change=False) for i, (k, v) in enumerate(zip(key, verd), 1)}
    T = build_tables(res, key, blind, {f"rx{i}": "S_ONLY" for i in range(1, 9)}, {f"rx{i}": ["hernia"] for i in range(1, 9)}, b_only=1)
    assert T["n_primary"] == 7 and T["n_pilot"] == 1, "the pilot item is excluded from the primary tables"
    assert T["T2_language_limited"]["total"] == 2 and "docA" not in json.dumps(T) and "rx1" not in json.dumps(T), "doctors pseudonymised, no ids in output"
    assert T["T2b_flagged_language_limited_stratum"]["n"] == 2 and "T2b_flagged_language_limited_stratum" in T, "the flagged stratum is reported apart"
    assert sum(v["scored"] for v in T["T3_english_share_bands"].values()) == sum(1 for v in verd[:7] if v.split("(")[0] in SCORED)
    return "link3_tables selftest ok (synthetic data only)"


def load_translated(B, results):
    """The box files of the three batches (verdicts, statuses and counts only; no text) -> the arguments of build_translated_tables. Refuses an incomplete stratum."""
    rd = lambda p: json.load(open(B + p))
    b1, b2, b3 = rd("mt/translated_results.json"), rd("mt-b2/translated_results.json"), rd("mt-b3/translated_results.json")
    final = merge_translated(b1, b2, b3)
    ll = {i for i, v in results.items() if v["verdict"] == "LANGUAGE_LIMITED"}
    if set(final) != ll:
        raise SystemExit("refused: the translated stratum is not exactly the language-limited items of the main run")
    eo = {i: (results[i].get("flagged") or {}).get("would_be_verdict") for i in final}
    prov = {b: rd(d + "provenance.json")["items"] for b, d in (("b1", "mt/"), ("b2", "mt-b2/"), ("b3", "mt-b3/"))}
    screens = {b: rd(d + "screen_report.json").get("items", {}) for b, d in (("b1", "mt/"), ("b2", "mt-b2/"), ("b3", "mt-b3/"))}
    logs = {b: log_reasons(B + d + "mt_log.jsonl") for b, d in (("b1", "mt/"), ("b2", "mt-b2/"), ("b3", "mt-b3/"))}
    return final, eo, prov, screens, logs


def log_reasons(path):
    """{reason: count} of the malformed replies in an mt_log.jsonl (preflight lines skipped). A malformed reply without a logged reason (batches 1 and 2 predate v7.16a F2) counts as
    "not_logged". Reasons only: no field of the log that could hold text is read."""
    out = collections.Counter()
    with open(path) as f:
        for line in f:
            l = json.loads(line)
            if not l.get("preflight") and l.get("malformed"):
                out[l.get("reason") or "not_logged"] += 1
    return dict(out)


def main():
    from build_chains import ptype
    B = os.path.expanduser("~/eta-data/surgical-chain/p1/")
    results = json.load(open(B + "run/run_results.json")); key = json.load(open(B + "link3_key.json")); blind = {b["item"]: b for b in json.load(open(B + "link3_inputs_blind.json"))}
    names = json.load(open(B + "proc_match_names.json")); adv = {r["rx"]: r["flag_class"] for r in json.load(open(B + "advised_rx_typed.json"))}
    pt = {rx: sorted({ptype(n) for n in v["adv"]}) or ["(no name)"] for rx, v in names.items()}
    stage1 = json.load(open(B + "REPORT_L_relaxed.json")).get("30", {}); b_only = stage1.get("B_sensitivity_extra", 0)
    T = build_tables(results, key, blind, adv, pt, b_only)
    T["T8_translated_stratum"] = build_translated_tables(*load_translated(B, results), key=key)
    json.dump(T, open(B + "run/link3_tables.json", "w"), indent=1); os.chmod(B + "run/link3_tables.json", 0o600)
    print(json.dumps(T, indent=1))


if __name__ == "__main__":
    print(selftest()) if len(sys.argv) > 1 and sys.argv[1] == "selftest" else main() if len(sys.argv) > 1 and sys.argv[1] == "run" else sys.exit(__doc__)
