"""Tests for the v7.17 translated-stratum tables in link3_tables.py. INVENTED data only: 19 synthetic items, a synthetic class key, no real ids, no patient text. Run: cd tests && python3 -m unittest test_tables"""
import json, os, sys, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import link3_tables as L

B1 = ["c004", "c006", "c011", "c013", "c014", "c016", "c023", "c026"]
B2 = ["c001", "c012", "c021", "c025", "c028", "c030", "c033", "c034", "c035", "c036", "c037"]
B3 = ["c001", "c012", "c028", "c036"]                       # the four that failed in batch 2
ALL19 = B1 + B2


def rec(verdict, **kw):
    d = dict(verdict=verdict, stratum="translated", best_room="R1", translated_rooms=["R2", "R3"], calls=5); d.update(kw); return d


def fixture(b1_v=None, b2_v=None, b3_v=None):
    """b1 all below floor (c026 incomplete); b2: c021 accepted from a native room, four failed; b3: the four re-attempted."""
    r1 = {it: rec("REJECT_BELOW_FLOOR") for it in B1}; r1["c026"] = rec("INCOMPLETE"); r1.update(b1_v or {})
    r2 = {it: rec("REJECT_BELOW_FLOOR") for it in B2}
    for it in B3: r2[it] = rec("MT_FAILED(malformed reply twice)")
    r2["c021"] = rec("ACCEPTED", best_room="R1"); r2["c025"] = rec("INCOMPLETE"); r2["c034"] = rec("INCOMPLETE"); r2.update(b2_v or {})
    r3 = {it: rec("REJECT_BELOW_FLOOR") for it in B3}; r3.update(b3_v or {})
    return r1, r2, r3


def keyf(role_of=None):
    role_of = role_of or {}
    return {it: dict(role=role_of.get(it, ("POS" if int(it[1:]) % 3 == 0 else "N2")), stratum="A+ full", rx="rxsecret", tier="A", route="KEY") for it in ALL19}


def prov():
    ok = lambda n: dict(status="MT_OK", turns_in=n, isolated_failed_lines=0, retries=0, repeats=0)
    p1 = {it: ok(10) for it in B1}
    p2 = {it: ok(10) for it in B2 if it not in B3}; p2.update({it: dict(status="MT_FAILED(malformed reply twice)", turns_in=10, isolated_failed_lines=0, retries=0, repeats=2) for it in B3})
    p3 = {it: dict(ok(10), isolated_failed_lines=(1 if it == "c012" else 0), repeats=(1 if it == "c012" else 0)) for it in B3}
    return {"b1": p1, "b2": p2, "b3": p3}


def screens():
    s = lambda its, u=0: {it: dict(turns_in=10, kept=6, dropped=dict(garbled=3, untranslatable=1, unflagged=u), status="OK") for it in its}
    return {"b1": s(B1), "b2": s([i for i in B2 if i not in B3]), "b3": s(B3, 2)}          # b3 has isolated-failed lines, which C counts under "unflagged"


def logs():
    return {"b1": {}, "b2": {"not_logged": 9}, "b3": {"t_empty": 3, "not_json": 1}}


def eo_map(**over):
    m = {it: "REJECT_BELOW_FLOOR" for it in ALL19}; m["c001"] = "ACCEPTED"; m["c021"] = "ACCEPTED"; m.update(over); return m


def tables(**kw):
    r1, r2, r3 = fixture(**{k: v for k, v in kw.items() if k in ("b1_v", "b2_v", "b3_v")})
    final = L.merge_translated(r1, r2, r3)
    return L.build_translated_tables(final, kw.get("eo") or eo_map(), prov(), screens(), logs(), keyf(kw.get("roles")))


class Merge(unittest.TestCase):
    def test_batch_three_supersedes_only_the_failed_items_and_keeps_attempt_one(self):
        f = L.merge_translated(*fixture())
        self.assertEqual(set(f), set(ALL19)); self.assertEqual(len(f), 19)
        for it in B3: self.assertEqual((f[it]["batch"], f[it]["attempts"], f[it]["verdict"], f[it]["attempt1"]), ("b3", 2, "REJECT_BELOW_FLOOR", "MT_FAILED(malformed reply twice)"))
        for it in B1: self.assertEqual((f[it]["batch"], f[it]["attempts"], f[it]["attempt1"]), ("b1", 1, None))
        for it in set(B2) - set(B3): self.assertEqual(f[it]["batch"], "b2")

    def test_a_batch_three_item_must_have_failed_in_batch_two(self):
        r1, r2, r3 = fixture(b2_v={"c012": rec("REJECT_BELOW_FLOOR")})
        with self.assertRaises(SystemExit): L.merge_translated(r1, r2, r3)
        r1, r2, r3 = fixture(); r3["c999"] = rec("ACCEPTED")
        with self.assertRaises(SystemExit): L.merge_translated(r1, r2, r3)

    def test_an_item_in_two_first_attempt_batches_is_refused(self):
        r1, r2, r3 = fixture(); r1["c012"] = rec("REJECT_BELOW_FLOOR")
        with self.assertRaises(SystemExit): L.merge_translated(r1, r2, r3)

    def test_a_failed_item_without_a_reattempt_stays_failed(self):
        r1, r2, r3 = fixture(); del r3["c036"]
        f = L.merge_translated(r1, r2, r3); self.assertEqual(f["c036"]["verdict"], "MT_FAILED(malformed reply twice)"); self.assertEqual(f["c036"]["batch"], "b2")


class Tables(unittest.TestCase):
    def test_the_exclusion_list_is_exactly_the_pre_registered_one(self):
        self.assertEqual(L.EXCLUDED_TRANSLATED, frozenset({"c004", "c006", "c011", "c013", "c001", "c021"}))
        self.assertEqual(L.TRANSLATED_ITEMS, 19)

    def test_excluded_items_are_shown_never_counted_and_the_yield_is_zero(self):
        T = tables(); self.assertEqual((T["n_items"], T["n_counted"], T["n_excluded"]), (19, 13, 6))
        y = T["T8b_yield_non_excluded_only"]["ALL"]
        self.assertEqual(y["accepted"], 0); self.assertEqual(y["scored"] + y["not_scored"], 13)
        acc_counted = sum(v.get("ACCEPTED", 0) for v in T["T8a_verdicts_by_class"]["counted"].values()); acc_excl = sum(v.get("ACCEPTED", 0) for v in T["T8a_verdicts_by_class"]["excluded_not_counted"].values())
        self.assertEqual((acc_counted, acc_excl), (0, 1))                                   # c021's accept is only in the excluded row
        self.assertEqual(sum(sum(v.values()) for v in T["T8a_verdicts_by_class"]["excluded_not_counted"].values()), 6)

    def test_an_accepted_non_excluded_item_is_counted_in_the_yield_of_its_class(self):
        T = tables(b3_v={"c028": rec("ACCEPTED", best_room="R2")}, roles={"c028": "POS"})
        y = T["T8b_yield_non_excluded_only"]; self.assertEqual((y["ALL"]["accepted"], y["POS A+ full"]["accepted"]), (1, 1))
        self.assertEqual(T["T8d_translation_changed"]["accepted_best_room"], dict(translated_room=1, native_english_room=1))       # c028 from a translated room; c021 from a native room

    def test_no_rate_when_nothing_was_scored_and_a_rate_when_something_was(self):
        r1, r2, r3 = fixture()
        for it in B1: r1[it] = rec("INCOMPLETE")
        for it in B2:
            if it not in B3: r2[it] = rec("INCOMPLETE")                                      # the four failed items keep their batch-2 failure (attempt 1)
        for it in B3: r3[it] = rec("MT_FAILED(x)")
        final = L.merge_translated(r1, r2, r3); T = L.build_translated_tables(final, eo_map(), prov(), screens(), logs(), keyf())
        self.assertIsNone(T["T8b_yield_non_excluded_only"]["ALL"]["rate"]); self.assertEqual(T["T8b_yield_non_excluded_only"]["ALL"]["scored"], 0)
        self.assertEqual(tables()["T8b_yield_non_excluded_only"]["ALL"]["rate"], "0/%d" % tables()["T8b_yield_non_excluded_only"]["ALL"]["scored"])

    def test_incomplete_and_failed_are_counted_as_not_scored_never_dropped(self):
        r1, r2, r3 = fixture(b3_v={"c036": rec("MT_FAILED(malformed reply twice)")}); final = L.merge_translated(r1, r2, r3)
        T = L.build_translated_tables(final, eo_map(), prov(), screens(), logs(), keyf()); y = T["T8b_yield_non_excluded_only"]["ALL"]
        self.assertEqual(y["scored"] + y["not_scored"], 13); self.assertGreaterEqual(y["not_scored"], 3)     # c025 c034 (b2) c026 (b1) incomplete, c036 failed: more precisely 4
        self.assertEqual(T["T8c_translation"]["final"]["items_mt_failed"], 1)

    def test_translation_change_cross_table_and_the_native_room_source(self):
        T = tables(); d = T["T8d_translation_changed"]
        self.assertEqual(d["english_only_by_translated_excluded_not_counted"]["ACCEPTED"], {"ACCEPTED": 1, "REJECT_BELOW_FLOOR": 1})     # c021 stayed accepted, c001 became below floor: both excluded
        self.assertEqual(sum(sum(v.values()) for v in d["english_only_by_translated_counted"].values()), 13)
        self.assertEqual(d["accepted_best_room"], dict(translated_room=0, native_english_room=1))          # c021's accept is from a native English room

    def test_translation_statistics_per_batch(self):
        c = tables()["T8c_translation"]
        self.assertEqual((c["b1"]["items_mt_ok"], c["b2"]["items_mt_ok"], c["b2"]["items_mt_failed"], c["b3"]["items_mt_ok"]), (8, 7, 4, 4))
        self.assertEqual((c["b3"]["isolated_failed_lines"], c["b3"]["repeats"], c["b2"]["repeats"]), (1, 1, 8))
        self.assertEqual((c["b1"]["kept"], c["b1"]["dropped_by_reason"]["garbled"]), (8 * 6, 8 * 3))
        self.assertEqual(set(c["b3"]["dropped_by_reason"]), {"garbled", "untranslatable", "unflagged"})                 # C's reasons, all three, in every row
        self.assertEqual((c["b3"]["dropped_by_reason"]["unflagged"], c["b1"]["dropped_by_reason"]["unflagged"]), (4 * 2, 0))     # isolated-failed lines fall under unflagged (v7.16a F3)
        self.assertEqual((c["b1"]["malformed_reasons"], c["b2"]["malformed_reasons"], c["b3"]["malformed_reasons"]), ({}, {"not_logged": 9}, {"not_json": 1, "t_empty": 3}))
        self.assertEqual(c["final"], dict(items_mt_ok=19, items_mt_failed=0, reattempted=4))

    def test_the_output_has_no_item_ids_no_secret_key_fields_and_is_never_pooled_into_t1_to_t7(self):
        T = tables(); blob = json.dumps(T)
        for bad in ("c0", "rxsecret", "doctor", "docA"): self.assertNotIn(bad, blob)
        self.assertIn("never pooled", T["note"]); self.assertFalse(any(k.startswith(("T1", "T2", "T3", "T4", "T5", "T6", "T7")) for k in T))

    def test_refuses_an_incomplete_stratum_or_a_foreign_excluded_item(self):
        r1, r2, r3 = fixture(); f = L.merge_translated(r1, r2, r3); del f["c037"]
        with self.assertRaises(SystemExit): L.build_translated_tables(f, eo_map(), prov(), screens(), logs(), keyf())
        f = L.merge_translated(r1, r2, r3)
        with self.assertRaises(SystemExit): L.build_translated_tables(f, eo_map(), prov(), screens(), logs(), keyf(), excluded=frozenset({"c999"}))

    def test_build_tables_returns_exactly_the_pre_registered_keys_and_nothing_translated(self):        # T1 to T7 and T2b are unchanged by v7.17
        key = {f"c{i:03d}": dict(role=("POS" if i <= 4 else "N2"), stratum="A+ full", rx=f"rx{i}", route="KEY", tier="A") for i in range(1, 9)}
        blind = {k: dict(doctor_uid="docA", day="2026-09-11") for k in key}
        res = {k: dict(verdict="ACCEPTED", pilot_item=False, english_share_best_room=0.8, local_drop=0.1, neighbours_in_padding=0, redactions_transcript={}, after_gate_change=False) for k in key}
        T = L.build_tables(res, key, blind, {f"rx{i}": "S_ONLY" for i in range(1, 9)}, {f"rx{i}": ["hernia"] for i in range(1, 9)}, b_only=0)
        self.assertEqual(sorted(T), sorted(["n_items", "n_primary", "n_pilot", "T1_verdicts_by_class_primary", "T1_pilot_items_apart", "T2_language_limited", "T2b_flagged_language_limited_stratum",
                                            "T3_english_share_bands", "T4_same_week_positives_vs_N2", "T5_selection", "T6_diagnostics", "T7_procedure_mix_positives", "B_stratum_technique_changed_units"]))
        self.assertFalse(any("T8" in k or "translated" in k.lower() for k in T if k != "T2b_flagged_language_limited_stratum"))

    def test_the_old_tables_are_unchanged_by_the_new_ones(self):
        self.assertIn("selftest ok", L.selftest())


class RefuterFindings(unittest.TestCase):
    """refuter-2 #1608: one test per surviving mutant, the fail-closed accepted check, and the log reasons."""
    def test_not_scored_counts_only_non_excluded_items(self):                                                       # M14
        base = tables()["T8b_yield_non_excluded_only"]["ALL"]
        r1, r2, r3 = fixture(b1_v={"c004": rec("INCOMPLETE"), "c006": rec("MT_FAILED(x)"), "c011": rec("INCOMPLETE")})        # excluded interim items become not scored
        T = L.build_translated_tables(L.merge_translated(r1, r2, r3), eo_map(), prov(), screens(), logs(), keyf())["T8b_yield_non_excluded_only"]["ALL"]
        self.assertEqual((T["not_scored"], T["scored"]), (base["not_scored"], base["scored"]))
        self.assertEqual(T["scored"] + T["not_scored"], 13)

    def test_an_accepted_record_without_its_rooms_is_a_refusal_never_a_native_room(self):                            # fail closed
        for drop in ("best_room", "translated_rooms"):
            r1, r2, r3 = fixture(b3_v={"c028": rec("ACCEPTED")}); del r3["c028"][drop]
            with self.assertRaises(SystemExit, msg=drop) as cm: L.build_translated_tables(L.merge_translated(r1, r2, r3), eo_map(), prov(), screens(), logs(), keyf())
            self.assertIn("lacks best_room or translated_rooms", str(cm.exception))
        r1, r2, r3 = fixture(b3_v={"c028": rec("ACCEPTED", translated_rooms=None)})
        with self.assertRaises(SystemExit): L.build_translated_tables(L.merge_translated(r1, r2, r3), eo_map(), prov(), screens(), logs(), keyf())
        r1, r2, r3 = fixture(b3_v={"c028": rec("ACCEPTED", best_room="R2")}); del r2["c021"]["best_room"]                      # c021 is also ACCEPTED (excluded row): checked too
        with self.assertRaises(SystemExit): L.build_translated_tables(L.merge_translated(r1, r2, r3), eo_map(), prov(), screens(), logs(), keyf())
        r1, r2, r3 = fixture(b3_v={"c028": rec("REJECT_BELOW_FLOOR")}); del r3["c028"]["best_room"]                               # a non-accepted record needs no rooms
        L.build_translated_tables(L.merge_translated(r1, r2, r3), eo_map(), prov(), screens(), logs(), keyf())

    def test_load_translated_labels_t8d_with_the_flagged_would_be_verdicts_not_the_language_limited_verdict(self):        # M8
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            B = d + "/"; r1, r2, r3 = fixture()
            for sub, r, pv, lg in (("mt", r1, prov()["b1"], []), ("mt-b2", r2, prov()["b2"], []), ("mt-b3", r3, prov()["b3"], [])):
                os.makedirs(B + sub); json.dump(r, open(B + sub + "/translated_results.json", "w")); json.dump({"items": pv}, open(B + sub + "/provenance.json", "w"))
                json.dump({"items": screens()["b1"]}, open(B + sub + "/screen_report.json", "w")); open(B + sub + "/mt_log.jsonl", "w").close()
            wbv = {it: "REJECT_BELOW_FLOOR" for it in ALL19}; wbv["c001"] = "ACCEPTED"; wbv["c021"] = "ACCEPTED"; wbv["c014"] = "INCOMPLETE"
            results = {it: dict(verdict="LANGUAGE_LIMITED", flagged=dict(would_be_verdict=wbv[it])) for it in ALL19}
            final, eo, pr, sc, lg = L.load_translated(B, results)
            self.assertEqual(eo, wbv); self.assertNotIn("LANGUAGE_LIMITED", set(eo.values()))
            T = L.build_translated_tables(final, eo, pr, sc, lg, keyf())["T8d_translation_changed"]
            self.assertEqual(set(T["english_only_by_translated_counted"]), {"REJECT_BELOW_FLOOR", "INCOMPLETE"}); self.assertEqual(set(T["english_only_by_translated_excluded_not_counted"]), {"ACCEPTED", "REJECT_BELOW_FLOOR"})

    def test_log_reasons_counts_reasons_only_skips_the_preflight_and_never_reads_text(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = d + "/mt_log.jsonl"
            lines = [dict(preflight=True, malformed=True, reason="not_json"), dict(malformed=True, reason="t_empty", index=16, lines=25), dict(malformed=True, reason="t_empty", index=17), dict(malformed=True, reason="not_json"),
                     dict(malformed=True), dict(ok=True, status=200, secret_text="MUST_NOT_BE_READ"), dict(retry=True, status=429)]
            with open(p, "w") as f: f.write("\n".join(json.dumps(l) for l in lines) + "\n")
            self.assertEqual(L.log_reasons(p), {"t_empty": 2, "not_json": 1, "not_logged": 1})
            self.assertNotIn("MUST_NOT_BE_READ", json.dumps(L.log_reasons(p)))

    def test_the_prereg_promise_of_malformed_reasons_is_kept_in_every_batch_row(self):
        c = tables()["T8c_translation"]
        for b in ("b1", "b2", "b3"): self.assertIn("malformed_reasons", c[b])
        self.assertNotIn("malformed_reasons", c["final"])


class Loader(unittest.TestCase):
    def test_load_translated_refuses_when_the_stratum_is_not_the_language_limited_set(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            B = d + "/"; r1, r2, r3 = fixture()
            for sub, r, pv in (("mt", r1, prov()["b1"]), ("mt-b2", r2, prov()["b2"]), ("mt-b3", r3, prov()["b3"])):
                os.makedirs(B + sub); json.dump(r, open(B + sub + "/translated_results.json", "w")); json.dump({"items": pv}, open(B + sub + "/provenance.json", "w"))
                json.dump({"items": screens()["b1"]}, open(B + sub + "/screen_report.json", "w")); open(B + sub + "/mt_log.jsonl", "w").close()
            results = {it: dict(verdict="LANGUAGE_LIMITED", flagged=dict(would_be_verdict="REJECT_BELOW_FLOOR")) for it in ALL19}
            final, eo, pr, sc, lg = L.load_translated(B, results); self.assertEqual(len(final), 19); self.assertEqual(set(pr), {"b1", "b2", "b3"}); self.assertEqual(set(lg), {"b1", "b2", "b3"})
            results["c002"] = dict(verdict="LANGUAGE_LIMITED", flagged=dict(would_be_verdict="ACCEPTED"))
            with self.assertRaises(SystemExit): L.load_translated(B, results)


if __name__ == "__main__":
    unittest.main()
