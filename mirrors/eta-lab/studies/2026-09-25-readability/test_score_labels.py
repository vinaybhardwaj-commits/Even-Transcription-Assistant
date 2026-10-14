"""Tests for score_labels.py on INVENTED labels. Run: python3 -B -W error::ResourceWarning -m unittest test_score_labels"""
import json, os, tempfile, unittest
import score_labels as S


def dump(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f)


def rows(cell, nf, nu):
    return [dict(id=f"{cell}-f{i}", cell=cell, flagged=True) for i in range(nf)] + [dict(id=f"{cell}-u{i}", cell=cell, flagged=False) for i in range(nu)]


class ScoreTests(unittest.TestCase):
    def test_precision_counts_garbled_and_wrong_language_only(self):
        r = rows("c", 10, 0)
        labels = {f"c-f{i}": l for i, l in enumerate(["garbled"] * 5 + ["wrong_language"] * 2 + ["readable", "romanised_readable", "unsure"])}
        t = S.score(r, labels, {"c|flagged": 100, "c|unflagged": 0})["cells"]["c"]
        self.assertEqual((t["flagged_labelled"], t["tp"], t["flagged_unsure"]), (9, 7, 1))
        self.assertAlmostEqual(t["precision"], 7 / 9, places=3)
        self.assertAlmostEqual(t["romanised_readable_share"], 1 / 9, places=3)
        self.assertEqual((t["precision_if_unsure_all_tp"], t["precision_if_unsure_all_fp"]), (0.8, 0.7))
        self.assertFalse(t["passes_collapse_floor"])                                    # 0.778 < 0.80

    def test_floor_needs_ten_rows_precision_and_low_romanised(self):
        ok = {f"c-f{i}": "garbled" for i in range(10)}
        self.assertTrue(S.score(rows("c", 10, 0), ok, {"c|flagged": 10, "c|unflagged": 0})["cells"]["c"]["passes_collapse_floor"])
        nine = {f"c-f{i}": "garbled" for i in range(9)}
        self.assertFalse(S.score(rows("c", 9, 0), nine, {"c|flagged": 9, "c|unflagged": 0})["cells"]["c"]["passes_collapse_floor"])       # n < 10
        rom = {f"c-f{i}": ("garbled" if i < 7 else "romanised_readable") for i in range(10)}
        self.assertFalse(S.score(rows("c", 10, 0), rom, {"c|flagged": 10, "c|unflagged": 0})["cells"]["c"]["passes_collapse_floor"])
        eight = {f"c-f{i}": ("garbled" if i < 8 else "readable") for i in range(10)}
        self.assertTrue(S.score(rows("c", 10, 0), eight, {"c|flagged": 10, "c|unflagged": 0})["cells"]["c"]["passes_collapse_floor"])      # exactly 0.80

    def test_miss_rate_and_overall_estimator(self):
        r = rows("a", 4, 4) + rows("b", 4, 4)
        labels = {}
        for i in range(4):
            labels[f"a-f{i}"] = "garbled"                               # a: precision 1.0
            labels[f"a-u{i}"] = "garbled" if i == 0 else "readable"     # a: miss 0.25
            labels[f"b-f{i}"] = "garbled" if i < 2 else "readable"      # b: precision 0.5
            labels[f"b-u{i}"] = "readable"                              # b: miss 0
        s = S.score(r, labels, {"a|flagged": 100, "a|unflagged": 300, "b|flagged": 100, "b|unflagged": 1000})
        self.assertEqual(s["cells"]["a"]["miss_rate_unflagged"], 0.25)
        self.assertEqual(s["overall"]["precision"], 0.75)                # (100*1 + 100*0.5) / 200
        self.assertAlmostEqual(s["overall"]["recall"], 150 / (150 + 300 * 0.25), places=3)

    def test_romanised_boundary_is_inclusive(self):
        lab = {f"c-f{i}": ("garbled" if i < 8 else "romanised_readable") for i in range(10)}        # precision 0.80, romanised exactly 0.20
        self.assertTrue(S.score(rows("c", 10, 0), lab, {"c|flagged": 10, "c|unflagged": 0})["cells"]["c"]["passes_collapse_floor"])
        lab["c-f7"] = "romanised_readable"                                                          # 3 romanised: 0.30
        self.assertFalse(S.score(rows("c", 10, 0), lab, {"c|flagged": 10, "c|unflagged": 0})["cells"]["c"]["passes_collapse_floor"])

    def test_unflagged_unsure_rows_stay_out_of_the_miss_denominator(self):
        r = rows("c", 0, 4)
        lab = {"c-u0": "garbled", "c-u1": "readable", "c-u2": "unsure", "c-u3": "unsure"}
        t = S.score(r, lab, {"c|flagged": 0, "c|unflagged": 100})["cells"]["c"]
        self.assertEqual((t["unflagged_labelled"], t["miss_rate_unflagged"], t["unflagged_unsure"]), (2, 0.5, 2))

    def test_overall_carries_intervals_and_covered_shares_and_unknown_labels(self):
        r = rows("a", 10, 10) + rows("b", 10, 10)
        lab = {f"a-f{i}": "garbled" for i in range(10)}
        lab.update({f"a-u{i}": "readable" for i in range(10)})                                       # zero misses in cell a
        lab["b-f0"] = "garbeled"                                                                    # a typo: ignored and counted
        o = S.score(r, lab, {"a|flagged": 100, "a|unflagged": 900, "b|flagged": 300, "b|unflagged": 2700})["overall"]
        self.assertEqual((o["precision"], o["recall"]), (1.0, 1.0))                                   # the point estimates alone would say 'perfect'
        self.assertLess(o["propagated_cp_bounds"]["recall"][0], 0.70)                                 # the propagated Clopper-Pearson bound does not
        lo, hi = o["posterior95"]["recall"]
        self.assertLess(lo, 0.95)                                                                     # and the Jeffreys posterior has real width at zero misses (a plain bootstrap gives [1, 1])
        self.assertGreater(hi, lo)
        self.assertEqual(o["posterior95"]["draws"], 2000)
        self.assertEqual(o["unknown_labels"], 1)
        self.assertEqual((o["covered_share_of_flagged"], o["covered_share_of_unflagged"]), (0.25, 0.25))   # only cell a has labelled rows: 100/400 and 900/3600

    def test_the_posterior_interval_is_wider_with_one_miss_than_with_none(self):
        r = rows("a", 10, 30)
        base = {f"a-f{i}": "garbled" for i in range(10)}
        z = dict(base); z.update({f"a-u{i}": "readable" for i in range(30)})
        m = dict(z); m["a-u0"] = "garbled"
        sz = {"a|flagged": 100, "a|unflagged": 900}
        lo0 = S.score(r, z, sz)["overall"]["posterior95"]["recall"][0]
        lo1 = S.score(r, m, sz)["overall"]["posterior95"]["recall"][0]
        self.assertLess(lo1, lo0)

    def test_posterior_is_deterministic(self):
        r = rows("a", 6, 6)
        lab = {f"a-f{i}": ("garbled" if i % 2 else "readable") for i in range(6)}
        lab.update({f"a-u{i}": ("garbled" if i == 0 else "readable") for i in range(6)})
        s = {"a|flagged": 50, "a|unflagged": 500}
        self.assertEqual(S.score(r, lab, s)["overall"]["posterior95"], S.score(r, lab, s)["overall"]["posterior95"])

    def test_unlabelled_rows_are_ignored(self):
        t = S.score(rows("c", 3, 0), {"c-f0": "garbled"}, {"c|flagged": 3, "c|unflagged": 0})["cells"]["c"]
        self.assertEqual(t["flagged_labelled"], 1)


class RaterTests(unittest.TestCase):
    def test_one_rater_is_primary(self):
        self.assertEqual(S.combine([{"x": "garbled"}]), ({"x": "garbled"}, 0, 0))

    def test_two_raters_agree_or_become_unsure(self):
        p, dis, one = S.combine([{"x": "garbled", "y": "readable"}, {"x": "garbled", "y": "garbled"}])
        self.assertEqual((p, dis, one), ({"x": "garbled", "y": "unsure"}, 1, 0))

    def test_a_row_labelled_by_only_one_of_two_raters_is_unsure_and_counted(self):
        p, dis, one = S.combine([{"x": "garbled", "y": "readable"}, {"x": "garbled"}])
        self.assertEqual((p["y"], dis, one), ("unsure", 0, 1))
        p2, _, one2 = S.combine([{"x": "garbled"}, {"x": "garbled", "z": "readable"}])              # the other rater alone: same rule
        self.assertEqual((p2["z"], one2), ("unsure", 1))

    def test_kappa(self):
        a = {"1": "readable", "2": "garbled", "3": "readable", "4": "garbled"}
        self.assertEqual(S.kappa(a, dict(a)), 1.0)
        b = {"1": "garbled", "2": "readable", "3": "garbled", "4": "readable"}
        self.assertEqual(S.kappa(a, b), -1.0)
        self.assertIsNone(S.kappa({}, {}))


class RunTests(unittest.TestCase):
    """End to end on invented files: key vs sample check, the one-rater rule and the join."""
    def make(self, tmp, key_flag=True):
        sample_rows = [dict(id=f"s{i}", cell="c", flagged=i < 4) for i in range(8)]
        sample = dict(rows=sample_rows, stratum_sizes={"c|flagged": 40, "c|unflagged": 400})
        key = {str(i + 1): dict(id=f"s{i}", cell="c", flagged=(i < 4) == key_flag, engine="e") for i in range(8)}
        surg = {f"L{i + 1:03d}": f"s{i}" for i in range(8)}
        for name, obj in (("sample.json", sample), ("key.json", dict(key=key)), ("surg.json", surg)):
            dump(obj, os.path.join(tmp, name))
        return [os.path.join(tmp, n) for n in ("sample.json", "key.json", "surg.json")]

    def test_run_scores_and_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b, c = self.make(tmp)
            r1 = {f"L{i + 1:03d}": ("garbled" if i < 3 else "readable") for i in range(8)}
            r2 = dict(r1); del r2["L008"]; r2["L001"] = "readable"                                    # one disagreement, one row labelled by rater 1 only
            for n, r in (("r1.json", r1), ("r2.json", r2)):
                dump(r, os.path.join(tmp, n))
            res = S.run(a, b, c, [os.path.join(tmp, "r1.json"), os.path.join(tmp, "r2.json")])
        self.assertEqual((res["raters"], res["disagreements_made_unsure"], res["labelled_by_one_rater_only"]), (2, 1, 1))
        self.assertEqual(res["unknown_labels_by_rater"], [0, 0])

    def test_a_typo_in_one_raters_file_is_counted_before_it_becomes_a_disagreement(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b, c = self.make(tmp)
            r1 = {f"L{i + 1:03d}": "garbled" for i in range(8)}
            r2 = dict(r1); r2["L002"] = "garbeled"
            for n, r in (("r1.json", r1), ("r2.json", r2)):
                dump(r, os.path.join(tmp, n))
            res = S.run(a, b, c, [os.path.join(tmp, "r1.json"), os.path.join(tmp, "r2.json")])
        self.assertEqual(res["unknown_labels_by_rater"], [0, 1])
        self.assertEqual(res["disagreements_made_unsure"], 1)
        self.assertIsNotNone(res["agreement"])

    def test_a_key_that_differs_from_the_frozen_sample_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b, c = self.make(tmp, key_flag=False)                                                   # every flag flipped
            dump({"L001": "garbled"}, os.path.join(tmp, "r1.json"))
            with self.assertRaises(SystemExit):
                S.run(a, b, c, [os.path.join(tmp, "r1.json")])


if __name__ == "__main__":
    unittest.main()
