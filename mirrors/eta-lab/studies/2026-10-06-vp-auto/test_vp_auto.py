"""Unit tests for vp_auto.py (rev9): every gate boundary (just inside / just outside) and every route, on synthetic embeddings. No data, no audio.
Run: ~/eta-data/nemotron/venv-nemo-main/bin/python3 -m unittest test_vp_auto -v   (from this directory)"""
import unittest
import numpy as np
import vp_auto as va

def unit(v): return v / np.linalg.norm(v)
def vec_with_cos(base, c, rng):
    """unit vector with cosine c to the unit vector `base`."""
    w = rng.normal(size=base.shape); w -= base * float(np.dot(w, base)); w = unit(w)
    return unit(c * base + np.sqrt(max(0.0, 1 - c * c)) * w)
def cluster(emb, sec, spk="S0"): return dict(spk=spk, sec=sec, emb=unit(emb), raw=unit(emb))
def window(i, day, clusters, uid="D", q="clean"): return dict(cid=f"w{i}", uid=uid, room="r", quality=q, day=day, clusters=clusters, turns=[])

class Gates(unittest.TestCase):
    def test_thin(self):
        self.assertTrue(va.gate_thin(5, 2, 60.0)); self.assertFalse(va.gate_thin(4, 2, 60.0)); self.assertFalse(va.gate_thin(5, 1, 60.0)); self.assertFalse(va.gate_thin(5, 2, 59.99))
        self.assertTrue(va.gate_thin(50, 9, 6000.0))
    def test_f0_class_boundaries(self):
        self.assertEqual(va.f0_class(144.99, 10), "M"); self.assertEqual(va.f0_class(145.0, 10), "DEAD"); self.assertEqual(va.f0_class(165.0, 10), "DEAD")
        self.assertEqual(va.f0_class(185.0, 10), "DEAD"); self.assertEqual(va.f0_class(185.01, 10), "F")
        self.assertEqual(va.f0_class(120.0, 1.99), "NONE"); self.assertEqual(va.f0_class(120.0, 2.0), "M"); self.assertEqual(va.f0_class(None, 10), "NONE")
    def test_sex(self):
        g = va.gate_sex
        self.assertEqual(g(120, 10, "M", False)["status"], "PASS"); self.assertEqual(g(200, 10, "F", False)["status"], "PASS")
        self.assertEqual(g(186, 10, "M", False)["status"], "CONTRADICT"); self.assertEqual(g(144, 10, "F", False)["status"], "CONTRADICT")
        self.assertEqual(g(185.0, 10, "M", False)["status"], "INCONCLUSIVE"); self.assertEqual(g(145.0, 10, "F", False)["status"], "INCONCLUSIVE")
        self.assertTrue(g(160, 10, "M", False)["dead_zone"]); self.assertFalse(g(120, 10, "M", False)["dead_zone"])
        self.assertEqual(g(120, 1.5, "F", False)["status"], "INCONCLUSIVE")                      # < 2 s voiced
        self.assertEqual(g(200, 10, "M", True)["status"], "INCONCLUSIVE")                       # an uncertain name sex can never contradict
        self.assertEqual(g(200, 10, None, False)["status"], "INCONCLUSIVE")
    def test_loo(self):
        mk = lambda n_top, n, margin: [(True, margin)] * n_top + [(False, margin)] * (n - n_top)
        self.assertTrue(va.gate_loo(mk(9, 10, 0.30))); self.assertFalse(va.gate_loo(mk(8, 10, 0.30)))              # 90% in, 80% out
        self.assertFalse(va.gate_loo(mk(9, 10, 0.299))); self.assertTrue(va.gate_loo(mk(10, 10, 0.31)))           # median margin 0.30
        self.assertFalse(va.gate_loo(mk(89, 100, 0.5))); self.assertTrue(va.gate_loo(mk(90, 100, 0.5))); self.assertFalse(va.gate_loo([]))
    def test_distinct(self): self.assertTrue(va.gate_distinct(0.599)); self.assertFalse(va.gate_distinct(0.60)); self.assertFalse(va.gate_distinct(0.61)); self.assertTrue(va.gate_distinct(-1.0))
    def test_presence(self):
        self.assertTrue(va.gate_presence(4, 5)); self.assertFalse(va.gate_presence(3, 4)); self.assertTrue(va.gate_presence(80, 100)); self.assertFalse(va.gate_presence(79, 100)); self.assertFalse(va.gate_presence(0, 0))

class Routes(unittest.TestCase):
    OK = dict(status="PASS", f0_class="M", dead_zone=False, name_known=True)
    def r(self, thin=True, sex=None, loo=True, distinct=True, presence=True, unc=False): return va.route(thin, sex or self.OK, loo, distinct, presence, unc)[0]
    def test_auto(self): self.assertEqual(self.r(), "AUTO")
    def test_auto_with_dead_zone_and_certain_name(self): self.assertEqual(self.r(sex=dict(status="INCONCLUSIVE", f0_class="DEAD", dead_zone=True, name_known=True)), "AUTO")
    def test_auto_with_uncertain_name_and_clear_f0(self): self.assertEqual(self.r(sex=dict(status="INCONCLUSIVE", f0_class="M", dead_zone=False, name_known=False), unc=True), "AUTO")
    def test_wait(self): self.assertEqual(self.r(thin=False), "WAIT"); self.assertEqual(self.r(thin=False, loo=False, distinct=False, presence=False), "WAIT")
    def test_reject(self):
        bad = dict(status="CONTRADICT", f0_class="F", dead_zone=False, name_known=True)
        self.assertEqual(self.r(sex=bad), "REJECT"); self.assertEqual(self.r(sex=bad, thin=False), "REJECT"); self.assertEqual(self.r(sex=bad, loo=False), "REJECT")
    def test_ear_each_gate(self):
        self.assertEqual(self.r(loo=False), "EAR"); self.assertEqual(self.r(distinct=False), "EAR"); self.assertEqual(self.r(presence=False), "EAR")
    def test_ear_dead_zone_and_uncertain_name(self):
        self.assertEqual(self.r(sex=dict(status="INCONCLUSIVE", f0_class="DEAD", dead_zone=True, name_known=False), unc=True), "EAR")
    def test_ear_needs_thin_and_sex_pass(self):
        self.assertEqual(self.r(thin=False, loo=False), "WAIT")

class EndToEnd(unittest.TestCase):
    """analyze_doctor on synthetic windows; the F0 function is a stub."""
    def setUp(self):
        self.rng = np.random.default_rng(7); self.d = unit(self.rng.normal(size=192)); self.o = [unit(self.rng.normal(size=192)) for _ in range(5)]
        self.others = {f"o{i}": v for i, v in enumerate(self.o)}
    def wins(self, n_with=8, n=8, days=2, sec=40.0, extra=True):
        ws = []
        for i in range(n):
            cl = [cluster(vec_with_cos(self.d, 0.9, self.rng), sec, "S0")] if i < n_with else []
            if extra: cl.append(cluster(vec_with_cos(self.o[0], 0.2, self.rng), 25.0, "S1"))
            ws.append(window(i, f"2026-10-0{1 + i % days}", cl))
        return ws
    def run_(self, ws, f0=(120.0, 50.0), name_sex="M", unc=False):
        pr = va.seed_and_print(ws); return va.analyze_doctor(ws, pr, self.others, name_sex, unc, lambda items: f0)
    def test_auto(self): r = self.run_(self.wins()); self.assertEqual(r["route"], "AUTO", r)
    def test_wait_thin_windows(self): self.assertEqual(self.run_(self.wins(n_with=4, n=4))["route"], "WAIT")
    def test_wait_one_day(self): self.assertEqual(self.run_(self.wins(days=1))["route"], "WAIT")
    def test_wait_seconds(self): self.assertEqual(self.run_(self.wins(sec=5.0, n=5, n_with=5))["gates"]["G_thin"]["ok"], False)      # 5 x 5 s = 25 s < 60 s
    def test_thin_just_inside(self): self.assertTrue(self.run_(self.wins(sec=12.0, n=5, n_with=5))["gates"]["G_thin"]["ok"])                   # 5 x 12 s = 60 s
    def test_reject_sex(self): self.assertEqual(self.run_(self.wins(), f0=(220.0, 50.0))["route"], "REJECT")
    def test_dead_zone_certain_is_auto(self): self.assertEqual(self.run_(self.wins(), f0=(160.0, 50.0))["route"], "AUTO")
    def test_dead_zone_uncertain_is_ear(self): self.assertEqual(self.run_(self.wins(), f0=(160.0, 50.0), unc=True)["route"], "EAR")
    def test_presence_boundary(self):
        r = self.run_(self.wins(n_with=8, n=10)); g = r["gates"]["G_presence"]; self.assertEqual((g["present"], g["windows_with_speech"]), (8, 10)); self.assertTrue(g["ok"])        # 80% inside
        r = self.run_(self.wins(n_with=7, n=10)); self.assertFalse(r["gates"]["G_presence"]["ok"]); self.assertEqual(r["route"], "EAR")                                              # 70% outside
    def test_distinct_close_print_is_ear(self):
        self.others["close"] = vec_with_cos(self.d, 0.75, self.rng); r = self.run_(self.wins()); self.assertFalse(r["gates"]["G_distinct"]["ok"]); self.assertEqual(r["route"], "EAR")
    def test_distinct_far_print_is_auto(self):
        self.others["near"] = vec_with_cos(self.d, 0.30, self.rng); self.assertEqual(self.run_(self.wins())["route"], "AUTO")
    def test_loo_fail_is_ear(self):
        ws = self.wins(); ws2 = self.wins(); self.others["twin"] = unit(self.d + 0.08 * self.rng.normal(size=192))                   # a print almost equal to the doctor's: top-1 fails
        r = self.run_(ws); self.assertFalse(r["gates"]["G_loo"]["ok"]); self.assertIn(r["route"], ("EAR",))
    def test_absorption_is_reported_only(self):
        ws = self.wins(); [w["clusters"].append(cluster(vec_with_cos(self.d, 0.85, self.rng), 30.0, "S2")) for w in ws[:3]]
        r = self.run_(ws); self.assertGreater(r["reported_only"]["P4b_absorption_share"], 0.2); self.assertEqual(r["route"], "AUTO")      # P4b never blocks
    def test_pairs_of_run_doctors(self):
        a, b = self.d, vec_with_cos(self.d, 0.65, self.rng); res = {"a": dict(route="AUTO", why="all gates pass", gates={"G_distinct": dict(ok=True)}), "b": dict(route="AUTO", why="all gates pass", gates={"G_distinct": dict(ok=True)})}
        va.apply_distinct_pairs(res, {"a": a, "b": b}, ["a", "b"]); self.assertEqual((res["a"]["route"], res["b"]["route"]), ("EAR", "EAR"))
        res = {"a": dict(route="WAIT", why="x", gates={"G_distinct": dict(ok=True)}), "b": dict(route="AUTO", why="all gates pass", gates={"G_distinct": dict(ok=True)})}
        va.apply_distinct_pairs(res, {"a": a, "b": b}, ["a", "b"]); self.assertEqual((res["a"]["route"], res["b"]["route"]), ("WAIT", "EAR"))
        res = {"a": dict(route="AUTO", why="all gates pass", gates={"G_distinct": dict(ok=True)}), "b": dict(route="AUTO", why="all gates pass", gates={"G_distinct": dict(ok=True)})}
        va.apply_distinct_pairs(res, {"a": a, "b": vec_with_cos(self.d, 0.59, self.rng)}, ["a", "b"]); self.assertEqual((res["a"]["route"], res["b"]["route"]), ("AUTO", "AUTO"))      # 0.59 is below the line
if __name__ == "__main__": unittest.main()
