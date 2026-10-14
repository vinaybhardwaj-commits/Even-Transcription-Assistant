import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from rate_seed import label200_export  # noqa: E402

KEYS = {"readable", "romanised_readable", "garbled", "wrong_language", "unsure"}


class TestLabel200Export(unittest.TestCase):
    def test_rules(self):
        t = {
            "L001": {"a": "readable", "mode": "audio", "g": True, "ts": "x"},
            "L002": {"a": "cant_judge", "mode": "audio", "ts": "x"},
            "L003": {"a": "garbled", "note": "old row", "ts": "x"},
            "L004": {"a": "unsure", "mode": "text", "tags": ["code_mixed", "bogus_tag"]},
        }
        flat, side = label200_export(t)
        self.assertEqual(set(flat), {"L001", "L003", "L004"})                       # skip ABSENT, typo not exported
        self.assertTrue(all(v in KEYS for v in flat.values()))
        self.assertNotIn("cant_judge", json.dumps(flat))
        # (any other value now RAISES SystemExit - see test_unknown_value_refused_loudly)                             # split-speaker's pin
        self.assertTrue(side["L002"]["skipped"] and side["L002"]["mode"] == "audio")
        self.assertEqual(side["L003"]["mode"], "text")                               # V's 11 old rows: no mode -> text (413d)
        self.assertFalse(side["L001"]["skipped"])
        self.assertTrue(side["L001"]["gloss_open"])
        self.assertEqual(side["L004"]["tags"], ["code_mixed"])                       # unknown tags dropped
        self.assertEqual(set(side["L004"]), {"mode", "gloss_open", "skipped", "tags"})

    def test_unknown_value_refused_loudly(self):   # eta-refuter #3247: no silent drops
        with self.assertRaises(SystemExit) as cm:
            label200_export({"L009": {"a": "totally_bogus", "mode": "audio"}})
        self.assertIn("L009", str(cm.exception))

    def test_partition_and_strays(self):   # split-speaker #3248(2): exact partition asserted inside the fn
        good = {"L001": {"a": "readable"}, "L002": {"a": "cant_judge"}}
        f, sd = label200_export(good)
        self.assertEqual(set(f) | {i for i, r in sd.items() if r["skipped"]}, set(good))
        self.assertTrue(set(f).isdisjoint({i for i, r in sd.items() if r["skipped"]}))

    def test_empty_and_legacy(self):
        flat, side = label200_export({})
        self.assertEqual((flat, side), ({}, {}))
        flat, side = label200_export({"L001": "readable"})                           # pre-dict shape tolerated
        self.assertEqual(flat, {"L001": "readable"})
        self.assertEqual(side, {})

    def test_bytes_stable(self):
        t = {"L002": {"a": "unsure"}, "L001": {"a": "readable", "mode": "audio"}}
        f1, s1 = label200_export(t)
        f2, s2 = label200_export(dict(reversed(list(t.items()))))
        self.assertEqual(json.dumps(f1, sort_keys=True), json.dumps(f2, sort_keys=True))
        self.assertEqual(json.dumps(s1, sort_keys=True), json.dumps(s2, sort_keys=True))


if __name__ == "__main__":
    unittest.main()
