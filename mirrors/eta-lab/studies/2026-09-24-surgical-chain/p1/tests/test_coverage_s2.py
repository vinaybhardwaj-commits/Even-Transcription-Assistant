"""Tests for link3_coverage_s2.py: the v7.14 S2 reading. Invented fixtures and a stub judge only; no network, no patient text. Run: cd tests && python3 -m unittest test_coverage_s2"""
import json, os, sys, tempfile, unittest
from datetime import timedelta
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..")); sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "2026-09-24-surgery-review-v2"))
import link3_coverage_s2 as S


def wj(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f)


def row(score, doc="d1", minutes=0):
    return dict(score=score, doc=doc, source="hist", t0=S.iso("2026-09-01T10:00:00+05:30") + timedelta(minutes=minutes), offset_min=float(minutes))


class Rule(unittest.TestCase):
    def test_found_requires_all_three_conditions(self):
        self.assertEqual(S.s2_verdict([row(0.9), row(0.1, minutes=30)], 0.2)["verdict"], "FOUND_ELSEWHERE")
        self.assertEqual(S.s2_verdict([row(0.49), row(0.1, minutes=30)], 0.1)["verdict"], "NOT_FOUND_IN_TEXT")          # below the floor
        self.assertEqual(S.s2_verdict([row(0.54), row(0.50, minutes=5)], 0.1)["verdict"], "NOT_FOUND_IN_TEXT")          # another sub-window within 0.15
        self.assertEqual(S.s2_verdict([row(0.9), row(0.1, minutes=30)], 0.8)["verdict"], "NOT_FOUND_IN_TEXT")           # a decoy within 0.15

    def test_boundaries_are_inclusive_at_exactly_the_margin(self):
        self.assertEqual(S.s2_verdict([row(0.65), row(0.50, minutes=30)], 0.50)["verdict"], "FOUND_ELSEWHERE")
        self.assertEqual(S.s2_verdict([row(0.50), row(0.10, minutes=30)], 0.10)["verdict"], "FOUND_ELSEWHERE")
        self.assertEqual(S.s2_verdict([row(0.649), row(0.50, minutes=30)], 0.10)["verdict"], "NOT_FOUND_IN_TEXT")

    def test_the_rule_counts_overlapping_neighbours_as_other_sub_windows(self):
        rows = [row(0.6, minutes=0), row(0.58, minutes=5)]                    # literal S2: an overlapping neighbour is another sub-window
        self.assertEqual(S.s2_verdict(rows, 0.1)["verdict"], "NOT_FOUND_IN_TEXT")
        self.assertIsNone(S.diagnostic_runner_up(rows))                       # the diagnostic excludes it, and says so as a diagnostic only

    def test_diagnostic_runner_up_includes_far_or_other_room_windows(self):
        rows = [row(0.6, minutes=0), row(0.58, minutes=5), row(0.3, minutes=20), row(0.4, doc="d2", minutes=0)]
        self.assertEqual(S.diagnostic_runner_up(rows), 0.4)

    def test_no_decoys_or_no_other_window_do_not_block(self):
        self.assertEqual(S.s2_verdict([row(0.7)], None)["verdict"], "FOUND_ELSEWHERE")

    def test_enumeration_constants_equal_the_first_pass(self):
        import link3_coverage as C
        self.assertEqual((S.SUB, S.STEP, S.MIN_TURNS, S.MIN_CHARS), (C.SUB, C.STEP, C.MIN_TURNS, C.MIN_CHARS))
        self.assertEqual((S.FLOOR, S.MARGIN), (0.50, 0.15))


class Run(unittest.TestCase):
    """A synthetic cov/run tree: one item, one room of English turns, two decoy prescriptions. A stub judge keys on marker words."""
    def setUp(self): self._paths = (S.COV, S.RUN)
    def tearDown(self): S.COV, S.RUN = self._paths

    @staticmethod
    def ask(state, q):
        return {"answers": {"same_visit": {"noul": 0.9 if ("OWNRX" in state and "SIGNAL" in state) else (0.4 if "DECOY" in state and "SIGNAL" in state else 0.1)}}}

    def tree(self, d, signal_minutes=(20, 21, 22, 23)):
        cov, run = os.path.join(d, "cov/"), os.path.join(d, "run/")
        turns = [{"i": i, "at": f"2026-09-01T10:{m:02d}:00+05:30", "en": ("SIGNAL " if m in signal_minutes else "filler ") + "words words words words"} for i, m in enumerate(range(0, 50))]
        wj(cov + "deid/c1_hist_r1.json", {"turns": turns}); wj(cov + "deid/c1_rxown.json", {"turns": [{"en": "OWNRX fever"}]})
        wj(run + "deid/c1_rxd00.json", {"turns": [{"en": "DECOY knee"}]}); wj(run + "deid/c1_rxd01.json", {"turns": [{"en": "another"}]})
        man = {"c1": dict(start="2026-09-01T10:15:00+05:30", end="2026-09-01T10:35:00+05:30", rx_ts="2026-09-01T10:40:00+05:30", lo="2026-09-01T10:00:00+05:30", hi="2026-09-01T10:50:00+05:30",
                          docs={"c1_hist_r1": dict(source="hist", turns=len(turns))})}
        return man, cov, run

    def test_not_found_when_overlapping_windows_are_close(self):
        with tempfile.TemporaryDirectory() as d:
            man, cov, run = self.tree(d)
            r = S.run_item("c1", man, self.ask, cov, run)
            # 5-minute step over a 4-minute signal: several windows contain it, so literal S2 reads NOT_FOUND_IN_TEXT and the diagnostic still reports the far runner-up
            self.assertEqual(r["verdict"], "NOT_FOUND_IN_TEXT"); self.assertGreater(r["sub_windows_at_or_above_floor"], 1); self.assertEqual(r["n_decoys"], 2)
            self.assertEqual(r["top"]["score"], 0.9); self.assertNotIn("text", r["top"])

    def test_found_when_the_signal_sits_in_one_sub_window(self):
        with tempfile.TemporaryDirectory() as d:
            man, cov, run = self.tree(d, signal_minutes=(3,))
            man["c1"]["docs"]["c1_hist_r1"]["turns"] = 50
            r = S.run_item("c1", man, self.ask, cov, run)
            self.assertEqual(r["verdict"], "FOUND_ELSEWHERE"); self.assertEqual(r["top"]["score"], 0.9)
            self.assertEqual(r["over_best_decoy"], 0.5)                                         # decoys scored on the top sub-window only: 0.9 - 0.4

    def test_decoys_are_scored_only_when_a_sub_window_reaches_the_floor(self):
        with tempfile.TemporaryDirectory() as d:
            man, cov, run = self.tree(d, signal_minutes=())
            r = S.run_item("c1", man, self.ask, cov, run)
            self.assertEqual(r["n_decoys"], 0); self.assertEqual(r["verdict"], "NOT_FOUND_IN_TEXT")

    def test_result_file_is_never_overwritten_and_private(self):
        with tempfile.TemporaryDirectory() as d:
            man, cov, run = self.tree(d); S.COV = cov
            wj(cov + "manifest.json", man); wj(cov + "coverage_results.json", {"c1": {"best": {"score": 0.9}}})
            S.RUN = run
            S.main([], self.ask); p = cov + "coverage_s2.json"
            self.assertEqual(oct(os.stat(p).st_mode & 0o777), "0o600")
            with self.assertRaises(FileExistsError): S.main([], self.ask)

    def test_stdout_carries_no_transcript_text(self):
        import io, contextlib
        with tempfile.TemporaryDirectory() as d:
            man, cov, run = self.tree(d); S.COV = cov; S.RUN = run
            wj(cov + "manifest.json", man); wj(cov + "coverage_results.json", {"c1": {"best": {"score": 0.9}}})
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf): S.main([], self.ask)
            self.assertNotIn("words", buf.getvalue()); self.assertNotIn("SIGNAL", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
