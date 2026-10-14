"""CLI-shape tests for deid.py --fields/--to-field on INVENTED records (no real text, no model: --no-model runs the regex layers only).
Run: python3 -m unittest test_deid_cli -v"""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DEID = os.path.join(HERE, "deid.py")
# linker's mt/translated.json layout: {item, room, i, lang, en, q, dropped}
RECS = [{"item": "c001", "room": "R1", "i": 0, "lang": "hi", "en": "Please call me on 9845012345 tomorrow.", "q": "ok", "dropped": False},
        {"item": "c001", "room": "R1", "i": 1, "lang": "hi", "en": "", "q": "untranslatable", "dropped": False},
        {"item": "c002", "room": "R2", "i": 0, "lang": "kn", "en": "We will do the scan next week.", "q": "ok", "dropped": False},
        {"item": "c002", "room": "R2", "i": 1, "lang": "kn", "q": "garbled", "dropped": False}]  # no `en` key at all


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="deid_cli_test_")
        self.inp = os.path.join(self.tmp, "in.json")
        with open(self.inp, "w") as fh:
            json.dump(RECS, fh)

    def run_cli(self, *args, out="out.json"):
        p = subprocess.run([sys.executable, DEID, "--no-model", self.inp, os.path.join(self.tmp, out), *args], capture_output=True, text=True)
        return p

    def load(self, out="out.json"):
        with open(os.path.join(self.tmp, out)) as fh:
            return json.load(fh)

    def test_to_field_leaves_the_source_raw_and_fills_every_record(self):
        p = self.run_cli("--fields", "en", "--to-field", "en_deid")
        self.assertEqual(p.returncode, 0, p.stderr)
        out = self.load()
        self.assertEqual([r["en"] for r in out if "en" in r], [r["en"] for r in RECS if "en" in r])  # raw en untouched
        self.assertTrue(all("en_deid" in r for r in out))                                            # uniform key
        self.assertIn("[PHONE]", out[0]["en_deid"]); self.assertNotIn("9845012345", out[0]["en_deid"])
        self.assertEqual((out[1]["en_deid"], out[3]["en_deid"]), ("", ""))                          # empty / missing source -> ""
        self.assertEqual(out[2]["en_deid"], RECS[2]["en"])
        for r, o in zip(RECS, out):                                                                  # every other key untouched
            self.assertEqual({k: v for k, v in o.items() if k != "en_deid"}, r)

    def test_default_behaviour_is_unchanged(self):
        self.assertEqual(self.run_cli().returncode, 0)
        out = self.load()
        self.assertIn("[PHONE]", out[0]["en"]); self.assertTrue(all("en_deid" not in r for r in out))

    def test_bad_option_combinations_are_refused(self):
        for args in (("--to-field", "en_deid"), ("--fields", "en,orig", "--to-field", "x"), ("--fields", "en", "--to-field", "en"),
                     ("--fields", "en", "--to-field", "orig")):
            p = self.run_cli(*args, out="bad.json")
            self.assertNotEqual(p.returncode, 0, args)
            self.assertFalse(os.path.exists(os.path.join(self.tmp, "bad.json")), args)

    def test_report_is_counts_only(self):
        p = self.run_cli("--fields", "en", "--to-field", "en_deid")
        for word in ("9845012345", "scan", "call me"):
            self.assertNotIn(word, p.stdout + p.stderr)


if __name__ == "__main__":
    unittest.main()
