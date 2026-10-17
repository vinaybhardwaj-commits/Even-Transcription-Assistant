"""P-SYN generator tests. Run: python -m unittest discover -s eval/pdqi9/psyn/tests -t ."""

import json
import shutil
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from eval.pdqi9.psyn import build, schema, validate
from eval.pdqi9.psyn.enrolment import partner
from eval.pdqi9.psyn.names import DENYLIST

SEED = build.load_config()["seed"]


def tree_bytes(d):
    d = Path(d)
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


class PsynBuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="psyn-test-"))
        cls.a = cls.tmp / "a"
        cls.b = cls.tmp / "b"
        cls.man = build.write(cls.a, SEED)
        build.write(cls.b, SEED)
        cls.manifest, cls.enrol, cls.bundles = validate.load_dir(cls.a)
        cls.scripts = [x["script"] for x in cls.bundles]
        cls.truths = [x["truth"] for x in cls.bundles]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def of(self, stratum):
        return [x for x in self.bundles if x["script"]["stratum"] == stratum]

    # ---- determinism ----
    def test_same_seed_byte_identical(self):
        ta, tb = tree_bytes(self.a), tree_bytes(self.b)
        self.assertEqual(sorted(ta), sorted(tb))
        self.assertTrue(all(ta[k] == tb[k] for k in ta))

    def test_other_seed_differs_but_split_is_fixed(self):
        c = self.tmp / "c"
        build.write(c, SEED + 1)
        mc = json.loads((c / "manifest.json").read_text())
        self.assertNotEqual({f["sha256"] for f in mc["files"]}, {f["sha256"] for f in self.manifest["files"]})
        # split depends only on config split_seed: same script ids in test
        self.assertEqual({s["script_id"] for s in mc["scripts"] if s["split"] == "test"},
                         {s["script_id"] for s in self.manifest["scripts"] if s["split"] == "test"})
        shutil.rmtree(c)

    def test_refuses_non_empty_out(self):
        with self.assertRaises(SystemExit):
            build.write(self.a, SEED)

    # ---- counts ----
    def test_stratum_and_split_counts(self):
        self.assertEqual(validate.check_counts(self.bundles), [])
        c = Counter(s["stratum"] for s in self.scripts)
        self.assertEqual(c, Counter({"S-E": 54, "S-N": 54, "S-C": 12, "S-R": 30, "S-D": 20, "S-A": 10,
                                     "S-V": 54, "S-M": 18}))
        self.assertEqual(sum(c.values()), 252)
        sp = Counter((s["stratum"], s["split"]) for s in self.scripts)
        self.assertEqual(sum(v for (st, x), v in sp.items() if x == "dev"), 84)
        self.assertEqual(sum(v for (st, x), v in sp.items() if x == "test"), 168)
        self.assertEqual((sp[("S-V", "dev")], sp[("S-V", "test")]), (18, 36))
        self.assertEqual((sp[("S-M", "dev")], sp[("S-M", "test")]), (6, 12))

    def test_se_sn_grid(self):
        for st in ("S-E", "S-N"):
            cells = Counter((s["pdqi9_plan"]["target_item"], s["pdqi9_plan"]["planted_level"], s["language_mode"])
                            for s in (x["script"] for x in self.of(st)))
            self.assertEqual(len(cells), 54)
            self.assertEqual(set(cells.values()), {1})
            dev = [x["script"] for x in self.of(st) if x["script"]["split"] == "dev"]
            self.assertEqual(len({(s["pdqi9_plan"]["target_item"], s["language_mode"]) for s in dev}), 18)
        for x in self.of("S-N"):
            self.assertIsNotNone(x["twin_defect"])
            lvl = x["script"]["pdqi9_plan"]["planted_level"]
            self.assertEqual(x["twin_defect"]["defect"]["code"] is None, lvl == 5)
            if lvl != 5:
                self.assertNotEqual(x["twin_defect"]["sections"], x["twin"]["sections"])

    def test_pairs_stay_together_and_match(self):
        for st in ("S-D", "S-A"):
            groups = {}
            for x in self.of(st):
                groups.setdefault(x["script"]["split_group"], []).append(x["script"])
            self.assertTrue(all(len(g) == 2 and g[0]["split"] == g[1]["split"] for g in groups.values()))
            for a, b in groups.values():
                da = [t["text"] for t in a["turns"] if t["speaker_id"] == a["treating_speaker_id"]]
                db = [t["text"] for t in b["turns"] if t["speaker_id"] == b["treating_speaker_id"]]
                if st == "S-A":
                    self.assertEqual(da, db)  # identical doctor words, affect differs
                    self.assertNotEqual({t["affect"] for t in a["turns"]}, {t["affect"] for t in b["turns"]})
                else:
                    self.assertEqual(len(da), len(db))
                    diff = sum(1 for p, q in zip(da, db) if p != q)
                    self.assertEqual(diff, 2)  # only the two flipped-strength instructions differ

    def test_sd_category_strength_coverage(self):
        seen = set()
        for x in self.of("S-D"):
            cats = {i["category"] for i in x["truth"]["instructions"]}
            self.assertTrue({"advice", "counselling", "warning", "lifestyle", "follow_up", "contingency"} <= cats)
            seen |= {(i["category"], i["strength"]) for i in x["truth"]["items"] if i["kind"] != "medicine"
                     and i["said_by_roles"] == ["treating_doctor"]}
            rev = [i for i in x["truth"]["items"] if i["trap"] == "reversal"][0]
            self.assertGreaterEqual(len(rev["reversal_chain"]), 2)
            self.assertEqual(sorted(i["priority_rank"] for i in x["truth"]["items"] if i["priority_rank"]), [1, 2, 3])
        for c in ("advice", "counselling", "warning", "lifestyle", "follow_up", "contingency"):
            self.assertIn((c, "firm"), seen)
            self.assertIn((c, "hedged"), seen)

    # ---- traps ----
    def test_sv_trap_mix(self):
        self.assertEqual(validate.check_traps(self.bundles), [])
        c = Counter(x["script"]["split_cell"] for x in self.of("S-V"))
        self.assertEqual(c["covering"], 12)
        self.assertEqual(c["translator_faithful"] + c["translator_changed_dose"] + c["translator_added"], 12)
        self.assertEqual((c["translator_changed_dose"], c["translator_added"]), (4, 4))
        self.assertEqual((c["staff"], c["attenders"], c["voice_alike"]), (8, 8, 14))
        pairs = set()
        for x in self.of("S-V"):
            s, t = x["script"], x["truth"]
            roles = Counter(sp["role"] for sp in s["speakers"])
            doc_turns = sum(1 for tt in s["turns"] if tt["speaker_id"] == s["treating_speaker_id"])
            self.assertGreaterEqual(doc_turns, 26)
            cell = s["split_cell"]
            if cell == "attenders":
                self.assertGreaterEqual(roles["attender"], 3)
                self.assertTrue(any(tt["overlap_with"] for tt in s["turns"]))
            if cell == "voice_alike":
                pd = s["speakers"][0]["pseudo_doctor_id"]
                pairs.add(frozenset((pd, partner(pd))))
                self.assertEqual(t["variants"][1]["logged_in_pseudo_doctor_id"], partner(pd))
            trap_items = [i for i in t["items"] if i["trap"] in ("junior_order", "staff_instruction",
                                                                  "translator_added", "attender_instruction")]
            for i in trap_items:
                self.assertFalse(i["expected_in_note"])
                for a in i["attributes"]:
                    self.assertIn("supported", a["forbidden_labels"])
                    if i["trap"] == "translator_added":
                        self.assertEqual(a["allowed_labels"], ["unaligned"])  # not h_unattrib (A4.1c)
        self.assertEqual(len(pairs), 14)
        distressed = [x for x in self.of("S-V") if any(a["intended_state"] == "distressed"
                                                       for a in x["script"]["affect_scenes"])]
        self.assertEqual(len(distressed), 2)

    def test_sm_merged_items(self):
        sub = Counter(x["script"]["split_cell"] for x in self.of("S-M"))
        self.assertEqual(sub, Counter({"patient": 6, "attender_fdr": 2, "attender_plain": 2, "junior": 4,
                                       "translator": 4}))
        fdr_scripts = 0
        for x in self.of("S-M"):
            s, t = x["script"], x["truth"]
            self.assertEqual(validate.check_sm(s, t), [])
            other = [i for i in t["items"] if i["trap"] == "merged_other_voice"]
            names = {a["name"] for i in other for a in i["attributes"]}
            if {"frequency", "duration", "route"} <= names:
                fdr_scripts += 1
                for i in other:
                    for a in i["attributes"]:
                        self.assertIn(a["ideal_label"], ("h_unattrib", "unaligned"))
                        self.assertNotIn("supported", a["allowed_labels"])
            self.assertTrue(set(t["t28e_items"]) >= {i["item_id"] for i in other})
            self.assertLessEqual(s["notes"]["est_other_voice_share_of_label"], 0.2)
        self.assertGreaterEqual(fdr_scripts, 6 + 2)

    def test_sr_traps(self):
        c = Counter(x["script"]["split_cell"] for x in self.of("S-R"))
        self.assertEqual(set(c.values()), {5})
        self.assertEqual(len(c), 6)
        expect = {"retracted": "precedence_error", "clip_bleed": "clip_leak", "never_said": "unaligned",
                  "non_doctor_only": "unaligned"}
        for x in self.of("S-R"):
            trap = x["script"]["split_cell"]
            items = [i for i in x["truth"]["items"] if i["trap"] == trap]
            self.assertTrue(items, trap)
            for i in items:
                if trap in expect:
                    self.assertFalse(i["expected_in_note"])
                    self.assertTrue(all(a["ideal_label"] == expect[trap] for a in i["attributes"]))
                if trap == "dose_corrected":
                    st = [a for a in i["attributes"] if a["name"] == "strength"][0]
                    self.assertEqual(st["forbidden_values"][0]["label"], "precedence_error")
                if trap == "placeholder_prone":
                    self.assertTrue(any(a["placeholder_forbidden"] for a in i["attributes"]))

    def test_every_doctor_medicine_has_all_attributes(self):
        for t in self.truths:
            for i in t["items"]:
                if i["kind"] == "medicine" and i["said_by_roles"] == ["treating_doctor"] and i["expected_in_note"]:
                    self.assertEqual([a["name"] for a in i["attributes"]],
                                     ["drug", "strength", "dose", "route", "frequency", "duration", "instruction"])

    # ---- variants, decoys, enrolment, names ----
    def test_variants_present_and_not_double_counted(self):
        self.assertEqual(validate.check_variants(self.bundles), [])
        for t in self.truths:
            self.assertEqual([v["variant_id"] for v in t["variants"]], ["v1", "v2", "v3", "v4", "v5"])
            self.assertEqual([v["scored_in_primary"] for v in t["variants"]], [True, False, False, False, False])
            self.assertEqual(sum("T1-T22" in v["used_for"] for v in t["variants"]), 1)

    def test_decoys_are_25_percent(self):
        self.assertEqual(validate.check_decoys(self.bundles), [])
        c = Counter(cl["kind"] for s in self.scripts for cl in s["claims"])
        self.assertEqual(c["decoy"] / (c["decoy"] + c["present"]), 0.25)
        for s in self.scripts:
            k = Counter(cl["kind"] for cl in s["claims"])
            self.assertEqual(k["decoy"] * 3, k["present"])

    def test_enrolment_never_in_consult(self):
        self.assertEqual(validate.check_enrolment(self.bundles, self.enrol), [])
        self.assertEqual(len(self.enrol["pseudo_doctors"]), 32)
        for s in self.scripts:
            for sp in s["speakers"]:
                if sp["pseudo_doctor_id"]:
                    self.assertTrue(sp["enrolment"])

    def test_enrolment_check_catches_overlap(self):
        bad = json.loads(json.dumps(self.enrol))
        bad["pseudo_doctors"][0]["enrolment"][0]["text"] = self.scripts[0]["turns"][0]["text"]
        self.assertTrue(validate.check_enrolment(self.bundles, bad))

    def test_no_real_name_hits(self):
        self.assertEqual(validate.check_names(self.bundles, self.enrol), [])
        names = [sp["display_name"] for s in self.scripts for sp in s["speakers"]]
        self.assertTrue(all(not (set(n.lower().split()) & set(DENYLIST)) for n in names))
        self.assertGreaterEqual(len(DENYLIST), 100)

    def test_name_check_catches_real_name(self):
        bad = json.loads(json.dumps(self.bundles[:1]))
        bad[0]["script"]["speakers"][0]["display_name"] = "Dr " + DENYLIST[0].title()
        self.assertTrue(validate.check_names(bad, self.enrol))

    # ---- schema and manifest ----
    def test_json_schema_every_file(self):
        self.assertEqual(validate.check_schemas(self.bundles, self.enrol), [])
        self.assertEqual(validate.check_manifest(self.a, self.manifest), [])

    def test_schema_rejects_bad_script(self):
        bad = json.loads(json.dumps(self.scripts[0]))
        bad["turns"][0]["speaker_id"] = "doctor"
        bad["synthetic"] = False
        self.assertGreaterEqual(len(list(schema.validator("script").iter_errors(bad))), 2)

    def test_checked_in_schemas_match(self):
        for name, sch in schema.ALL.items():
            on_disk = (schema.SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8")
            self.assertEqual(on_disk, schema.dumps(sch), name)

    def test_test_split_guard(self):
        self.assertTrue((self.a / "test" / "README.md").exists())
        self.assertIn("DO NOT TOUCH", (self.a / "test" / "README.md").read_text())
        for x in self.bundles:
            self.assertTrue(x["dir"].startswith(x["script"]["split"] + "/"))

    def test_validate_detects_tamper(self):
        c = self.tmp / "tamper"
        shutil.copytree(self.a, c)
        f = next((c / "test").glob("PSYN-*/script.json"))
        f.write_text(f.read_text().replace('"synthetic": true', '"synthetic": true '), encoding="utf-8")
        self.assertTrue(any("hash mismatch" in e for e in validate.validate(c)))
        shutil.rmtree(c)

    def test_full_validate_clean(self):
        self.assertEqual(validate.validate(self.a), [])


if __name__ == "__main__":
    unittest.main()
