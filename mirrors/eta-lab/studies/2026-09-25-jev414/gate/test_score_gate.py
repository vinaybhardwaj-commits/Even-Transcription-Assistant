"""Tests for score_gate.py on INVENTED ids/labels only (no patient data). Expected values are hand-computed."""
import io, contextlib, unittest
import score_gate as G

L = [f"L{i:03d}" for i in range(1, 21)]; B = [f"P{i:03d}" for i in range(1, 11)]; ITEMS = L + B
def jev(lab_l="readable", lab_b="A_better"):
    return ({i: {"label": lab_l, "conf": .9, "version": "lv1.2"} for i in L},
            {i: {"label": lab_b, "conf": .9, "version": "bv1.2"} for i in B})
def v_all(al="readable", ab="A_better"):
    return {**{i: {"a": al, "mode": "audio", "g": False} for i in L}, **{i: {"a": ab, "mode": "audio"} for i in B}}
def run(*a, **k):
    with contextlib.redirect_stdout(io.StringIO()): return G.score(*a, **k)
def refused(*a):
    with self_assert_raises() as cm: run(*a)
class self_assert_raises:
    def __enter__(self): return self
    def __exit__(self, t, v, tb):
        assert t is SystemExit and v.code == 2, f"expected a refusal, got {t}"; return True

class Gate(unittest.TestCase):
    def test_all_agree_passes_both_ways(self):
        jl, jb = jev(); o = run(ITEMS, jl, jb, v_all())
        self.assertEqual((o["judged"], o["agree"], o["GATE"], o["raw_prop"]["meets_26_of_30"]), (30, 30, "PASS", True))
    def test_romanised_equals_readable_and_wrong_language_equals_garbled(self):
        jl, jb = jev("romanised_readable"); o = run(ITEMS, jl, jb, v_all("readable"))
        self.assertEqual(o["by_kind"]["L"]["agree"], 20)
        jl, jb = jev("wrong_language"); o = run(ITEMS, jl, jb, v_all("garbled"))
        self.assertEqual(o["by_kind"]["L"]["agree"], 20)
    def test_usable_vs_not_disagrees(self):
        jl, jb = jev("readable"); o = run(ITEMS, jl, jb, v_all("garbled"))
        self.assertEqual(o["by_kind"]["L"]["agree"], 0)
    def test_26_of_30_passes_25_fails(self):
        jl, jb = jev(); v = v_all()
        for i in L[:4]: v[i]["a"] = "garbled"                 # 4 disagreements -> 26/30
        o = run(ITEMS, jl, jb, v); self.assertEqual((o["agree"], o["raw_prop"]["meets_26_of_30"]), (26, True))
        # weighted: L stratum 'readable' = 16/20 = 0.8 (single stratum, share 1.0); B = 1.0; overall = (20*0.8 + 10*1)/30 = 0.8667 >= 26/30
        self.assertAlmostEqual(o["population_weighted"]["overall"], 26 / 30, places=3); self.assertEqual(o["GATE"], "PASS")
        v[L[4]]["a"] = "garbled"                                # 25/30
        o = run(ITEMS, jl, jb, v); self.assertEqual((o["agree"], o["raw_prop"]["meets_26_of_30"], o["GATE"]), (25, False, "FAIL"))
    def test_skips_excluded_and_the_ABS_vs_PROP_fork(self):
        jl, jb = jev(); v = v_all()
        for i in L[:5]: v[i]["a"] = "cant_judge"                # 25 judged, all agree
        o = run(ITEMS, jl, jb, v)
        self.assertEqual((o["judged"], o["skipped"], o["agree"]), (25, 5, 25))
        self.assertEqual((o["raw_prop"]["meets_26_of_30"], o["GATE"]), (True, "PASS"))   # proportion (416c): 25/25 passes
    def test_fewer_than_25_judged_is_insufficient(self):
        jl, jb = jev(); v = v_all()
        for i in L[:6]: v[i]["a"] = "unsure"
        o = run(ITEMS, jl, jb, v); self.assertEqual(o["judged"], 24); self.assertTrue(str(o.get("GATE", "")).startswith("INSUFFICIENT"))
    def test_jev_cannot_tell_counts_as_not_agreeing(self):
        jl, jb = jev(); jl[L[0]]["label"] = "cannot_tell"; jb[B[0]]["label"] = "cannot_tell"
        o = run(ITEMS, jl, jb, v_all()); self.assertEqual((o["agree"], o["jev_cannot_tell_on_judged"]), (28, 2))
    def test_jev_cannot_tell_is_not_collapsed_into_not_usable(self):
        jl, jb = jev(); jl[L[0]]["label"] = "cannot_tell"; v = v_all(); v[L[0]]["a"] = "garbled"
        o = run(ITEMS, jl, jb, v); self.assertEqual(o["agree"], 29)          # V says not-usable, Jev cannot_tell: still NOT agreeing
    def test_unsure_is_a_skip_not_a_refusal(self):
        jl, jb = jev(); v = v_all(); v[L[0]]["a"] = "unsure"
        o = run(ITEMS, jl, jb, v); self.assertEqual((o.get("judged"), o.get("skipped")), (29, 1))
    def test_ba106_exact_choice(self):
        jl, jb = jev(lab_b="same"); o = run(ITEMS, jl, jb, v_all(ab="A_better")); self.assertEqual(o["by_kind"]["B"]["agree"], 0)
    def test_refusals(self):
        jl, jb = jev()
        with self_assert_raises(): run(ITEMS, jl, jb, {**v_all(), "L999": {"a": "readable", "mode": "audio"}})   # unknown id
        v = v_all(); v[L[0]]["a"] = "A_better"
        with self_assert_raises(): run(ITEMS, jl, jb, v)                                                          # B value on an L item
        jl2 = {k: {**x, "version": "lv1.1"} for k, x in jl.items()}
        with self_assert_raises(): run(ITEMS, jl2, jb, v_all())                                                   # old wording version
        with self_assert_raises(): run(ITEMS[:29], jl, jb, v_all())                                               # item-count drift
    def test_cp_anchor(self):
        lo, hi = G.cp(26, 30); self.assertAlmostEqual(lo, 0.693, places=3); self.assertAlmostEqual(hi, 0.962, places=3)
    def test_flag_split(self):
        jl, jb = jev(); o = run(ITEMS, jl, jb, v_all(), flags={B[0], B[1], B[2], B[3]})
        self.assertEqual((o["ba106_by_flag"]["flag_full"]["n"], o["ba106_by_flag"]["unflagged"]["n"]), (4, 6))
class OptionA(unittest.TestCase):
    def test_weighting_undoes_the_cannot_tell_oversample(self):
        # hand-computed: L draw = 3 cannot_tell (all miss) + 17 readable (all agree); B all agree.
        jl, jb = jev(); v = v_all()
        for i in L[:3]: jl[i]["label"] = "cannot_tell"
        o = run(ITEMS, jl, jb, v)
        self.assertEqual(o["agree"], 27)                         # raw 27/30
        # weighted L = (0 * 4 + 1 * 96) / (4 + 96) = 0.96 ; B = 1.0 ; overall = (20*0.96 + 10*1.0)/30 = 0.9733
        self.assertAlmostEqual(o["population_weighted"]["label200"], 0.96, places=3)
        self.assertAlmostEqual(o["population_weighted"]["overall"], 0.973, places=3)
        self.assertEqual(o["GATE"], "PASS")                      # raw 27/30 = 0.9 also passes; weighting removes the cannot_tell over-sample
    def test_weighted_gate_can_fail_when_raw_passes(self):
        # hand-computed: 5 garbled items all miss, 15 readable all agree, B all agree -> raw 25/30 = 0.833 (fails raw);
        # weighted L = (0*75 + 1*96)/171 = 0.5614 ; overall = (20*0.5614 + 10)/30 = 0.7076 -> FAIL
        jl, jb = jev(); v = v_all()
        for i in L[:5]: jl[i]["label"] = "garbled"
        o = run(ITEMS, jl, jb, v)
        self.assertAlmostEqual(o["population_weighted"]["label200"], 96 / 171, places=3); self.assertEqual(o["GATE"], "FAIL")
if __name__ == "__main__": unittest.main()
