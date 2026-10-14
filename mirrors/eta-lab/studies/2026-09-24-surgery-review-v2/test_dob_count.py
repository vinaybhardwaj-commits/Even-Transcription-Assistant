"""Tests for dob_count.py on INVENTED files (no real text). Run: python3 -m unittest test_dob_count -v"""
import contextlib, io, json, os, shutil, tempfile, unittest

import dob_count

HIT = "Daily birthday. 6th July."
CLEAN = "We will do the scan next week."
NOCUE = "Come on 6th July for the surgery."


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dob_count_test_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, obj):
        p = os.path.join(self.tmp, name)
        with open(p, "w") as fh:
            json.dump(obj, fh)
        return p

    def run_cli(self, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dob_count.main(list(args))
        return [json.loads(l) for l in buf.getvalue().splitlines()], buf.getvalue()

    def test_counts_turns_and_shapes_in_a_consult(self):
        p = self.write("C1.json", {"id": "C1", "turns": [{"i": 0, "en": HIT}, {"i": 1, "en": CLEAN}, {"i": 2, "en": NOCUE},
                                                       {"i": 3, "en": "dob 12-3"}, {"i": 4, "en": "she was born in October"}]})
        rows, _ = self.run_cli("--field", "en", p)
        self.assertEqual((rows[0]["turns"], rows[0]["turns_hit"]), (5, 3))
        self.assertEqual(rows[0]["turns_in_scope"], 5)
        self.assertEqual((rows[0]["daymonth"], rows[0]["numeric"], rows[0]["monthonly"]), (1, 1, 1))
        self.assertEqual(rows[-1]["TOTAL"]["turns_hit"], 3)

    def test_record_list_and_other_field(self):
        p = self.write("R.json", [{"item": "c1", "room": "r1", "i": 0, "en": "x", "en_deid": HIT}, {"item": "c1", "room": "r1", "i": 1, "en": HIT, "en_deid": CLEAN}])
        self.assertEqual(self.run_cli("--field", "en_deid", p)[0][0]["turns_hit"], 1)
        self.assertEqual(self.run_cli("--field", "en", p)[0][0]["turns_hit"], 1)

    def test_keys_are_ids_only(self):
        p = self.write("R.json", [{"item": "c1", "room": "r1", "i": 7, "en": HIT}])
        rows, out = self.run_cli("--field", "en", "--keys", p)
        self.assertEqual(rows[0]["keys"], ["c1|r1|7"])  # a record list keeps the item|room|i key
        self.assertNotIn("birthday", out); self.assertNotIn("July", out)

    def test_stdout_never_carries_text(self):
        p = self.write("R.json", [{"item": "c1", "room": "r1", "i": 0, "en": HIT + " " + CLEAN}])
        _, out = self.run_cli("--field", "en", "--keys", p)
        for w in ("birthday", "July", "scan", "Daily"):
            self.assertNotIn(w, out)

    def test_missing_or_empty_field_counts_the_turn_but_never_hits(self):
        p = self.write("R.json", [{"item": "c1", "room": "r1", "i": 0}, {"item": "c1", "room": "r1", "i": 1, "en": ""}])
        row = self.run_cli("--field", "en", p)[0][0]
        self.assertEqual((row["turns"], row["turns_hit"]), (2, 0))

    def test_without_a_scope_every_turn_is_in_scope(self):
        p = self.write("C.json", {"id": "C", "turns": [{"i": 0, "en_deid": HIT}, {"i": 1, "en_deid": CLEAN}]})
        row = self.run_cli("--field", "en_deid", p)[0][0]
        self.assertEqual((row["turns"], row["turns_in_scope"], row["turns_hit"]), (2, 2, 1))

    def test_a_turn_outside_the_sent_set_is_not_counted_as_sent(self):  # a greyed-phase turn that holds a shape but never reached Jev
        p = self.write("N001.json", {"id": "N001", "turns": [{"i": 0, "en": HIT}, {"i": 1, "en": HIT, "phase": "before"}, {"i": 2, "en": CLEAN}]})
        keys = self.write("keys.json", {"final-v5fresh/deid_r1": {"items": 1, "sent_turn_keys": ["N001#0", "N001#2"]}})
        rows, _ = self.run_cli("--field", "en", "--sent-keys", keys, "--sent-entry", "final-v5fresh/deid_r1", "--keys", p)
        self.assertEqual((rows[0]["turns"], rows[0]["turns_in_scope"], rows[0]["turns_hit"]), (3, 2, 1))
        self.assertEqual(rows[0]["keys"], ["N001#0"])
        self.assertEqual(rows[0]["scope_keys_for_this_file"], 2)

    def test_keys_file_shapes_and_a_wrong_entry_name(self):
        p = self.write("N001.json", {"id": "N001", "turns": [{"i": 0, "en": HIT}, {"i": 1, "en": HIT}]})
        as_list = self.write("k1.json", ["N001#1"])
        as_dict = self.write("k2.json", {"sent_turn_keys": ["N001#1"]})
        for kf in (as_list, as_dict):
            self.assertEqual(self.run_cli("--field", "en", "--sent-keys", kf, p)[0][0]["turns_hit"], 1)
        many = self.write("k3.json", {"a/b": {"sent_turn_keys": ["N001#0"]}})
        with self.assertRaises(SystemExit):
            self.run_cli("--field", "en", "--sent-keys", many, "--sent-entry", "nope", p)

    def test_a_score_input_file_is_read(self):  # link-3: every turn in score_input.json was scored, so no keys are needed
        p = self.write("score_input.json", {"c028": {"l3-c028-r2": {"id": "x", "stratum": "translated", "turns": [{"i": 2, "en": HIT}, {"i": 3, "en": CLEAN}]},
                                                     "l3-c028-r1": {"id": "y", "stratum": "translated", "turns": [{"i": 0, "en": CLEAN}]}}})
        rows, _ = self.run_cli("--field", "en", "--keys", p)
        self.assertEqual((rows[0]["turns"], rows[0]["turns_in_scope"], rows[0]["turns_hit"]), (3, 3, 1))
        self.assertEqual(rows[0]["keys"], ["c028|l3-c028-r2|2"])

    def test_an_unsupported_file_shape_is_refused_without_echoing_content(self):
        p = self.write("bad.json", {"a": 1})
        with self.assertRaises(ValueError) as cm:
            self.run_cli("--field", "en", p)
        self.assertNotIn("birthday", str(cm.exception))

    def run_fail(self, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), self.assertRaises(SystemExit) as cm:
            dob_count.main(list(args))
        return cm.exception.code, [json.loads(l) for l in buf.getvalue().splitlines()], buf.getvalue()

    def test_a_file_whose_id_differs_from_its_stem_is_counted_by_the_stem(self):  # refuter-2 #1677: fleet's keys use the FILE STEM; the old code used doc["id"] and read a clean 0
        p = self.write("N001.json", {"id": "enc-77", "turns": [{"i": 0, "en": HIT}, {"i": 1, "en": CLEAN}]})
        keys = self.write("keys.json", ["N001#0", "N001#1"])
        rows, _ = self.run_cli("--field", "en", "--sent-keys", keys, p)
        self.assertEqual((rows[0]["turns"], rows[0]["turns_in_scope"], rows[0]["turns_hit"]), (2, 2, 1))
        self.assertEqual(rows[0]["key_basis"], "stem"); self.assertNotIn("FAILED", rows[0])

    def test_the_wrong_key_basis_fails_closed_instead_of_reading_clean(self):
        p = self.write("N001.json", {"id": "enc-77", "turns": [{"i": 0, "en": HIT}, {"i": 1, "en": CLEAN}]})
        keys = self.write("keys.json", ["N001#0", "N001#1"])
        code, rows, _ = self.run_fail("--field", "en", "--sent-keys", keys, "--key-by", "id", p)
        self.assertEqual(code, 2)
        self.assertEqual(rows[0]["turns_in_scope"], 0); self.assertIn("OTHER key basis", rows[0]["FAILED"]); self.assertEqual(rows[-1]["TOTAL"]["failed_files"], 1)

    def test_keys_listed_for_the_file_but_missing_from_it_fail_closed(self):
        p = self.write("N001.json", {"id": "N001", "turns": [{"i": 0, "en": HIT}, {"i": 1, "en": CLEAN}, {"i": 2, "en": CLEAN}]})
        keys = self.write("keys.json", ["N001#%d" % i for i in range(6)])
        code, rows, _ = self.run_fail("--field", "en", "--sent-keys", keys, p)
        self.assertEqual(code, 2); self.assertIn("not all found", rows[0]["FAILED"])

    def test_a_consult_with_no_listed_keys_is_a_legitimate_zero_not_an_error(self):  # an item with no Jev output has no keys; beside a file that DOES match, the run is fine
        p9 = self.write("N009.json", {"id": "N009", "turns": [{"i": 0, "en": HIT}]})
        p1 = self.write("N001.json", {"id": "N001", "turns": [{"i": 0, "en": HIT}, {"i": 1, "en": CLEAN}]})
        keys = self.write("keys.json", ["N001#0", "N001#1"])
        rows, _ = self.run_cli("--field", "en", "--sent-keys", keys, p9, p1)
        self.assertEqual((rows[0]["turns_in_scope"], rows[0]["turns_hit"], rows[0]["scope_keys_for_this_file"]), (0, 0, 0)); self.assertNotIn("FAILED", rows[0])
        self.assertEqual((rows[1]["turns_in_scope"], rows[1]["turns_hit"]), (2, 1))
        self.assertEqual(rows[-1]["TOTAL"]["turns_in_scope"], 2); self.assertNotIn("FAILED", rows[-1]["TOTAL"])

    def test_a_record_list_that_matches_no_scope_key_fails_closed(self):
        p = self.write("R.json", [{"item": "c1", "room": "r1", "i": 0, "en": HIT}])
        keys = self.write("keys.json", ["zzz|r|9"])
        code, rows, _ = self.run_fail("--field", "en", "--sent-keys", keys, p)
        self.assertEqual(code, 2); self.assertIn("no turn of this file is in the scope", rows[0]["FAILED"])

    def test_a_wrong_entry_makes_the_whole_run_fail_closed(self):  # refuter-2 #1686: every file reads as a legitimate zero, so the TOTAL looked clean
        p = self.write("N001.json", {"id": "N001", "turns": [{"i": 0, "en": HIT}]})
        keys = self.write("keys.json", {"delta": {"sent_turn_keys": ["N999#0", "N999#1"]}})
        code, rows, _ = self.run_fail("--field", "en", "--sent-keys", keys, "--sent-entry", "delta", p)
        self.assertEqual(code, 2)
        tot = rows[-1]["TOTAL"]
        self.assertEqual(tot["turns_in_scope"], 0); self.assertIn("turns_in_scope == 0", tot["FAILED"])
        self.assertEqual(tot["unmatched_stems"], ["N999"]); self.assertEqual(tot["unmatched_scope_keys"], 2)

    def test_unmatched_scope_keys_are_counted_when_only_some_files_are_run(self):
        p = self.write("N001.json", {"id": "N001", "turns": [{"i": 0, "en": HIT}, {"i": 1, "en": CLEAN}]})
        keys = self.write("keys.json", ["N001#0", "N001#1", "N002#0", "N002#1", "N002#2"])
        rows, _ = self.run_cli("--field", "en", "--sent-keys", keys, p)
        tot = rows[-1]["TOTAL"]
        self.assertEqual((tot["unmatched_scope_keys"], tot["unmatched_stems"], tot["turns_in_scope"], tot["turns_hit"]), (3, ["N002"], 2, 1))

    def test_nothing_is_unmatched_when_every_listed_file_is_run(self):
        p1 = self.write("N001.json", {"id": "N001", "turns": [{"i": 0, "en": HIT}]})
        p2 = self.write("N002.json", {"id": "N002", "turns": [{"i": 0, "en": CLEAN}]})
        keys = self.write("keys.json", ["N001#0", "N002#0"])
        tot = self.run_cli("--field", "en", "--sent-keys", keys, p1, p2)[0][-1]["TOTAL"]
        self.assertEqual((tot["unmatched_scope_keys"], tot["unmatched_stems"]), (0, []))

    def test_writes_no_file(self):
        p = self.write("R.json", [{"item": "c1", "room": "r1", "i": 0, "en": HIT}])
        before = sorted(os.listdir(self.tmp)); self.run_cli("--field", "en", p)
        self.assertEqual(before, sorted(os.listdir(self.tmp)))


if __name__ == "__main__":
    unittest.main()
