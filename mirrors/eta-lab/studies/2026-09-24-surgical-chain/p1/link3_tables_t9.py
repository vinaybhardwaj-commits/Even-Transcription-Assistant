"""link3_tables_t9.py: v7.18 R6 T9a to T9d, the 337b-English stratum (branch linker-oc/t9, review first then run).
Imports the PINNED link3_tables (never edited) and adds the T9 tables beside it; the class key is opened only when this runs
with eta-refuter-2 present (ruling 406 item 4: the second opening). The ACCEPTED correct/wrong split is ruling 406 item 4's
"ACCEPTED correct and wrong" per stratum, read exactly as the native T1 reading reports it: an ACCEPTED verdict is CORRECT on a
POS-class item (the recording links to the visit the positive item seeks) and WRONG on an N1/N2 item (an accept on a non-positive
item, BUILDER-REPORT s25's wording). No new verdict definition; counts only; no item id, doctor or text in the output; the T9
stratum is never pooled with T1-T7 (native) or T8 (first translated stratum).

  python3 link3_tables_t9.py selftest     synthetic data only
  python3 link3_tables_t9.py run          real data (box files) with eta-refuter-2 present; writes ~/eta-data/surgical-chain/p1/run/link3_tables_t9.json
"""
import collections, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import link3_tables as L8

ITEMS_T9 = ("c001", "c004", "c006", "c011", "c012", "c013", "c014", "c016", "c021", "c023", "c025", "c026", "c028", "c030", "c033", "c034", "c035", "c036", "c037")
EXCLUDED_T9 = ("c001",)
T9_VERDICTS = ("ACCEPTED", "AMBIGUOUS_TIE", "REJECT_BELOW_FLOOR", "SINGLE", "INCOMPLETE", "UNCOVERED")
MIN_FOR_RATE = 10


def build_t9_tables(final, key, assemble, screen_items, deid_prov, t8_final, items=ITEMS_T9, excluded=EXCLUDED_T9):
    """final: mt-337b/translated_results.json (item -> record; UNCOVERED items carry verdict=UNCOVERED, decided before Jev);
    key: the sealed class key (only each item's class is read); assemble: mt-337b/assemble_report.json ({items, total});
    screen_items: mt-337b/screen_report.json 'items'; deid_prov: mt-337b/deid_provenance.json (hashes only);
    t8_final: link3_tables.merge_translated output (the first translated stratum, for T9d).
    items / excluded are injectable for tests with invented ids; the run uses the real 19 (classes never in git, review F3)."""
    if len(final) != len(items) or set(final) != set(items):
        raise SystemExit(f"refused: the T9 stratum must hold exactly the {len(items)} language-limited items")
    if not set(excluded) <= set(final):
        raise SystemExit("refused: an excluded item is not in the T9 stratum")
    C = collections.Counter
    rows = [dict(item=it, cls=L8.cls(key[it]), verdict=L8.vclass(r["verdict"]), excl=it in excluded) for it, r in final.items()]
    for x in rows:
        if x["verdict"] not in T9_VERDICTS:
            raise SystemExit("refused: a T9 verdict is outside the pre-registered verdict set")
    counted = [x for x in rows if not x["excl"]]; excl = [x for x in rows if x["excl"]]
    T = {"note": "T9 (337b English) is reported apart and is never pooled with T1-T7 or T8; excluded items are shown, never counted",
         "n_items": len(rows), "n_counted": len(counted), "n_excluded": len(excl)}
    classes = sorted({x["cls"] for x in rows})

    def acc_split(rs):
        acc = [x for x in rs if x["verdict"] == "ACCEPTED"]
        return dict(correct=sum(1 for x in acc if x["cls"].startswith("POS")), wrong=sum(1 for x in acc if not x["cls"].startswith("POS")))

    def by_class(rs):
        out = {}
        for c in classes:
            d = dict(C(x["verdict"] for x in rs if x["cls"] == c))
            if any(x["verdict"] == "ACCEPTED" for x in rs if x["cls"] == c):
                d["ACCEPTED_correct_wrong"] = acc_split([x for x in rs if x["cls"] == c])
            out[c] = dict(sorted(d.items()))
        return out

    T["T9a_verdicts_by_class"] = dict(counted=by_class(counted), excluded_not_counted=by_class(excl))
    sc = [x for x in counted if x["verdict"] in L8.SCORED]
    acc_cw = acc_split(counted)
    T["T9b_accuracy_non_excluded_only"] = dict(scored=len(sc), accepted_correct_wrong=acc_cw,
                                               uncovered=sum(1 for x in counted if x["verdict"] == "UNCOVERED"),
                                               incomplete=sum(1 for x in counted if x["verdict"] == "INCOMPLETE"),
                                               accept_rate=(f"{sum(1 for x in sc if x['verdict'] == 'ACCEPTED')}/{len(sc)}" if len(sc) >= MIN_FOR_RATE else "too small for a rate"),
                                               correct_per_scored=f"{acc_cw['correct']}/{len(sc)}", wrong_per_scored=f"{acc_cw['wrong']}/{len(sc)}")
    total = assemble.get("total") or {}
    items = assemble.get("items") or {}
    dr = total.get("dropped") or {}
    T["T9c_input_accounting"] = dict(
        turns_in=total.get("turns_in"), kept=total.get("kept"), dropped_by_reason=dict(sorted(dr.items())),
        uncovered_windows=sum(int(v.get("uncov_rooms") or 0) for v in items.values()), uncovered_items=total.get("uncovered_items"),
        unresolved_rooms=total.get("unresolved_rooms"), zero_turn_rooms=total.get("zero_turn_rooms"),
        snapshot_manifest_sha256=deid_prov.get("snapshot_manifest_sha256"), deid_export_sha256=deid_prov.get("export_deid_py_sha256"),
        deid_driver_sha256=deid_prov.get("driver_sha256"), deid_json_sha256=deid_prov.get("deid_json_sha256"), translated_json_sha256=deid_prov.get("translated_json_sha256"))

    def cross(rs):
        out = collections.defaultdict(dict)
        for x in rs:
            t8 = L8.vclass((t8_final.get(x["item"]) or {}).get("verdict") or "n/a")
            out[t8][x["verdict"]] = out[t8].get(x["verdict"], 0) + 1
        return {k: dict(sorted(v.items())) for k, v in sorted(out.items())}

    T["T9d_versus_T8"] = dict(t8_final_verdict_by_t9_verdict_counted=cross(counted), t8_final_verdict_by_t9_verdict_excluded_not_counted=cross(excl))
    blob = json.dumps(T)
    hits = [it for it in items if it in blob]
    if hits:
        raise SystemExit(f"refused: an item id leaked into the T9 tables ({len(hits)} ids)")
    return T


def selftest():
    # INVENTED ids only (review F3: no item-level class of a real item may appear in git, even synthetic):
    # POS x01 x02 x03 x04 x05 x06; N1 x07 x08 x09; N2 x10..x19
    pos = {"x01", "x02", "x03", "x04", "x05", "x06"}
    n1 = {"x07", "x08", "x09"}
    ids19 = tuple(f"x{i:02d}" for i in range(1, 20))
    key = {it: dict(role=("POS" if it in pos else "N1" if it in n1 else "N2"), stratum="A+ full", rx="rx-" + it, route="KEY", tier="A") for it in ids19}
    verd = dict(x01="ACCEPTED", x02="ACCEPTED", x03="REJECT_BELOW_FLOOR", x04="AMBIGUOUS_TIE(room)", x05="SINGLE", x06="REJECT_BELOW_FLOOR",
                x07="ACCEPTED", x08="UNCOVERED", x09="REJECT_BELOW_FLOOR", x10="SINGLE", x11="INCOMPLETE", x12="AMBIGUOUS_TIE(rx)",
                x13="REJECT_BELOW_FLOOR", x14="UNCOVERED", x15="ACCEPTED", x16="REJECT_BELOW_FLOOR", x17="AMBIGUOUS_TIE(room)",
                x18="REJECT_BELOW_FLOOR", x19="SINGLE")
    final = {it: dict(verdict=verd[it]) for it in ids19}
    t8_final = {it: dict(verdict=("MT_FAILED" if it == "x18" else ("INCOMPLETE" if it in ("x14", "x13") else "REJECT_BELOW_FLOOR"))) for it in ids19}
    total = dict(turns_in=463, kept=277, dropped={"garbled": 107, "out_of_scope_lang": 78, "untranslatable": 1, "empty_en": 0}, uncovered_items=1, unresolved_rooms=0, zero_turn_rooms=0)
    assemble = dict(items={it: dict(uncov_rooms=(1 if it == "x08" else 0)) for it in ids19}, total=total)
    screens = {it: dict(status=("UNCOVERED" if verd[it] == "UNCOVERED" else "OK")) for it in ids19}
    prov = dict(export_deid_py_sha256="d" * 64, driver_sha256="e" * 64, deid_json_sha256="f" * 64, translated_json_sha256="a" * 64, snapshot_manifest_sha256="b" * 64)
    T = build_t9_tables(final, key, assemble, screens, prov, t8_final, items=ids19, excluded=("x01",))
    assert T["n_counted"] == 18 and T["n_excluded"] == 1, "x01 excluded"
    c = T["T9a_verdicts_by_class"]["counted"]
    assert c["POS A+ full"]["ACCEPTED_correct_wrong"] == dict(correct=1, wrong=0), "a POS accept is correct"
    assert c["N1"]["ACCEPTED_correct_wrong"] == dict(correct=0, wrong=1), "an N1 accept is wrong"
    assert c["N2"]["ACCEPTED_correct_wrong"] == dict(correct=0, wrong=1), "an N2 accept is wrong"
    assert sum(v.get("UNCOVERED", 0) for v in c.values()) == 2 and sum(v.get("INCOMPLETE", 0) for v in c.values()) == 1
    b = T["T9b_accuracy_non_excluded_only"]
    assert b["scored"] == 15 and b["accepted_correct_wrong"] == dict(correct=1, wrong=2), "scored = accepted+ambiguous+reject+single"
    assert b["accept_rate"] == "3/15" and b["correct_per_scored"] == "1/15" and b["wrong_per_scored"] == "2/15", "the accept rate is named, correct and wrong beside it"
    x = T["T9d_versus_T8"]["t8_final_verdict_by_t9_verdict_counted"]
    assert sum(sum(v.values()) for v in x.values()) == 18, "the cross table covers all counted items"
    assert x["MT_FAILED"] == dict(REJECT_BELOW_FLOOR=1) and x["INCOMPLETE"] == dict(REJECT_BELOW_FLOOR=1, UNCOVERED=1), "T8 MT_FAILED/INCOMPLETE rows appear"
    assert T["T9c_input_accounting"]["uncovered_windows"] == 1 and T["T9c_input_accounting"]["kept"] == 277
    blob = json.dumps(T)
    assert not any(it in blob for it in ids19), "no item id in the output"
    return "link3_tables_t9 selftest ok (invented ids only)"


def _mini(ids, verd, roles, excluded):
    """Small fixture for the rate floor (review F1): the same guards over a caller-sized id list."""
    ids = tuple(ids)
    key = {it: dict(role=roles[i], stratum="A+ full", rx="rx-" + it, route="KEY", tier="A") for i, it in enumerate(ids)}
    final = {it: dict(verdict=verd[it]) for it in ids}
    total = dict(turns_in=len(ids), kept=len(ids), dropped={}, uncovered_items=0, unresolved_rooms=0, zero_turn_rooms=0)
    assemble = dict(items={it: dict(uncov_rooms=0) for it in ids}, total=total)
    screens = {it: dict(status="OK") for it in ids}
    prov = dict(export_deid_py_sha256="d" * 64, driver_sha256="e" * 64, deid_json_sha256="f" * 64, translated_json_sha256="a" * 64, snapshot_manifest_sha256="b" * 64)
    t8_final = {it: dict(verdict="REJECT_BELOW_FLOOR") for it in ids}
    return build_t9_tables(final, key, assemble, screens, prov, t8_final, items=ids, excluded=excluded)


def rate_floor_checks():
    """(review F1) below 10 scored -> 'too small for a rate'; exactly 10 -> an accept_rate is shown. Returns counts for the unittest file."""
    small = _mini([f"y{i:02d}" for i in range(1, 7)], {f"y{i:02d}": "ACCEPTED" for i in range(1, 7)}, ["POS"] * 6, ())
    assert small["T9b_accuracy_non_excluded_only"]["scored"] == 6 and small["T9b_accuracy_non_excluded_only"]["accept_rate"] == "too small for a rate"
    ten = _mini([f"z{i:02d}" for i in range(1, 11)], {f"z{i:02d}": ("ACCEPTED" if i <= 3 else "REJECT_BELOW_FLOOR") for i in range(1, 11)}, ["POS"] * 10, ())
    tb = ten["T9b_accuracy_non_excluded_only"]
    assert tb["scored"] == 10 and tb["accept_rate"] == "3/10" and tb["correct_per_scored"] == "3/10" and tb["wrong_per_scored"] == "0/10", "the boundary at exactly 10 shows the rate"
    return dict(small_scored=6, ten_scored=10, rate=tb["accept_rate"])


def leak_guard_check():
    """(review F2/F3) an item id that reaches the output blob must be refused. Entirely INVENTED ids (no real id anywhere,
    F3): every role is the same invented-label POS so the class channel (cls = "POS " + stratum for POS roles) carries the
    id; the injected stratum "y01 full" puts the invented id y01 into the blob, and the guard must refuse."""
    ids = tuple(f"y{i:02d}" for i in range(1, 7))
    bad_key = {it: dict(role="POS", stratum=("y01 full" if it == "y01" else "A+ full"), rx="rx-" + it, route="KEY", tier="A") for it in ids}
    verd = {it: "REJECT_BELOW_FLOOR" for it in ids}
    total = dict(turns_in=len(ids), kept=len(ids), dropped={}, uncovered_items=0, unresolved_rooms=0, zero_turn_rooms=0)
    assemble = dict(items={it: dict(uncov_rooms=0) for it in ids}, total=total)
    screens = {it: dict(status="OK") for it in ids}
    prov = dict(export_deid_py_sha256="d" * 64, driver_sha256="e" * 64, deid_json_sha256="f" * 64, translated_json_sha256="a" * 64, snapshot_manifest_sha256="b" * 64)
    t8_final = {it: dict(verdict="REJECT_BELOW_FLOOR") for it in ids}
    try:
        build_t9_tables({it: dict(verdict=verd[it]) for it in ids}, bad_key, assemble, screens, prov, t8_final, items=ids, excluded=())
    except SystemExit as e:
        return str(e).split(":")[0]
    raise SystemExit("refused: the leak guard did not fire")


def run():
    B = os.path.expanduser("~/eta-data/surgical-chain/p1/")
    rd = lambda p: json.load(open(B + p))
    final = rd("mt-337b/translated_results.json")
    key = rd("link3_key.json")                                   # the ONLY key read; run with eta-refuter-2 present (ruling 406 item 4)
    assemble = rd("mt-337b/assemble_report.json")
    screens = rd("mt-337b/screen_report.json")["items"]
    prov = dict(rd("mt-337b/deid_provenance.json"))
    prov["snapshot_manifest_sha256"] = rd("mt-337b/provenance.json")["snapshot_sha256"]
    t8_final = L8.merge_translated(rd("mt/translated_results.json"), rd("mt-b2/translated_results.json"), rd("mt-b3/translated_results.json"))
    T = build_t9_tables(final, key, assemble, screens, prov, t8_final)
    out = B + "run/link3_tables_t9.json"
    os.makedirs(os.path.dirname(out), mode=0o700, exist_ok=True)
    with open(out, "w") as f:
        json.dump(T, f, indent=1, sort_keys=True)
    os.chmod(out, 0o600)
    b = T["T9b_accuracy_non_excluded_only"]
    print(json.dumps(dict(wrote="link3_tables_t9.json", n_counted=T["n_counted"], n_excluded=T["n_excluded"], scored=b["scored"], accept_rate=b["accept_rate"], correct_per_scored=b["correct_per_scored"])))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "selftest":
        print(selftest()); print(rate_floor_checks()); print(leak_guard_check())
    elif cmd == "run":
        run()
    else:
        raise SystemExit(__doc__)
