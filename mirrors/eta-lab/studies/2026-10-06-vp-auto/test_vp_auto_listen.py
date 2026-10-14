"""Tests for the F1 (file times) and F2 (same-sex decoys, amendment A1) fixes of vp_auto_listen.py. No audio, no embeddings.
Run with the eta-diarize venv (the module imports the ECAPA helpers):  ~/services/eta-diarize/venv/bin/python3 -m unittest test_vp_auto_listen -v"""
import os, tempfile, time, unittest
import vp_auto_listen as vl

class F1(unittest.TestCase):
    def test_cut_in_k_order_and_one_common_mtime(self):
        calls = []
        def cut(c, path): calls.append(os.path.basename(path)); open(path, "wb").write(b"x"); time.sleep(0.02)
        d = tempfile.mkdtemp(); os.makedirs(f"{d}/clips")
        kinds = ["mint"] * 5 + ["decoy"] * 2; ks = [4, 1, 7, 3, 6, 2, 5]                    # plan order is mint-first, k order is shuffled
        plan = [(k, f"doc_{k}.wav", dict(kind=kind)) for kind, k in zip(kinds, ks)]
        vl.write_clips(d, plan, cut, mtime=1790000000.0)
        self.assertEqual(calls, [f"doc_{k}.wav" for k in range(1, 8)])                       # written 1..7, whatever the kind
        m = {k: os.stat(f"{d}/clips/doc_{k}.wav") for k in ks}
        self.assertEqual({round(x.st_mtime) for x in m.values()}, {1790000000})              # one common mtime: mtime order cannot separate mint from decoy
        self.assertEqual({int(x.st_atime) for x in m.values()}, {1790000000})
        ct = [m[k].st_ctime_ns for k in sorted(ks)]
        self.assertEqual(ct, sorted(ct))                                                     # ctime never decreases along k order (ties allowed): it cannot follow the mint-then-decoy order
        for kind, k in zip(kinds, ks): pass
        self.assertTrue(all(oct(x.st_mode & 0o777) == "0o600" for x in m.values()))

SEX = {"D": ("M", False), "SM": ("M", False), "SF": ("F", False), "SU": ("M", True), "SM2": ("M", False)}
class F2(unittest.TestCase):
    clip = staticmethod(lambda tag: (lambda: [tag + "1", tag + "2"]))
    def run_(self, dsex="M", known=True, rooms=("r1",), sources=None, nonmint=None):
        return vl.pick_decoys("D", dsex, known, list(rooms), sources or {}, nonmint or [], SEX)
    def test_same_sex_same_room_first(self):
        out = self.run_(sources={"SF": ({"r1"}, self.clip("f")), "SM": ({"r1"}, self.clip("m")), "SM2": ({"r2"}, self.clip("m2"))})
        self.assertEqual([(l, c, mm) for l, c, mm in out], [("other_doctor_print:SM", "m1", False), ("other_doctor_print:SM", "m2", False)])
    def test_then_same_sex_non_mint_voice(self):
        out = self.run_(sources={"SF": ({"r1"}, self.clip("f"))}, nonmint=[("F", self.clip("nf"), "g_f"), ("M", self.clip("nm"), "g_m")])
        self.assertEqual([(l, c, mm) for l, c, mm in out], [("g_m", "nm1", False), ("g_m", "nm2", False)])
    def test_then_same_sex_other_room(self):
        out = self.run_(sources={"SF": ({"r1"}, self.clip("f")), "SM2": ({"r2"}, self.clip("m2"))}, nonmint=[("F", self.clip("nf"), "g_f")])
        self.assertEqual([(l, mm) for l, _, mm in out], [("other_doctor_print:SM2", False)] * 2)
    def test_tier_mix_fills_two(self):
        out = self.run_(sources={"SM": ({"r1"}, lambda: ["m1"]), "SM2": ({"r2"}, lambda: ["m21"])})
        self.assertEqual([(l, c, mm) for l, c, mm in out], [("other_doctor_print:SM", "m1", False), ("other_doctor_print:SM2", "m21", False)])
    def test_opposite_sex_only_if_nothing_else_and_recorded(self):
        out = self.run_(sources={"SF": ({"r1"}, self.clip("f"))}, nonmint=[("F", self.clip("nf"), "g_f")])
        self.assertEqual([(l, c, mm) for l, c, mm in out], [("other_doctor_print:SF", "f1", True), ("other_doctor_print:SF", "f2", True)])
    def test_uncertain_sex_never_counts_as_same_sex(self):
        out = self.run_(sources={"SU": ({"r1"}, self.clip("u"))}); self.assertTrue(all(mm for _, _, mm in out) and len(out) == 2)
    def test_unknown_doctor_sex_means_no_same_sex_tiers(self):
        out = self.run_(dsex=None, known=False, sources={"SM": ({"r1"}, self.clip("m"))}, nonmint=[("M", self.clip("nm"), "g")]); self.assertTrue(all(mm for _, _, mm in out))
    def test_never_the_doctor_himself(self):
        out = self.run_(sources={"D": ({"r1"}, self.clip("d"))}); self.assertEqual(out, [])
    def test_dead_zone_or_unmeasurable_voice_not_offered_here(self):
        out = self.run_(nonmint=[("DEAD", self.clip("x"), "g_dead"), ("NONE", self.clip("y"), "g_none")]); self.assertEqual(out, [])               # the caller only passes F/M voices; classes outside F/M never match
class A2(unittest.TestCase):
    def test_boundaries(self):
        self.assertTrue(vl.a2_ok(0.449, [0.30, 0.449], 0.449)); self.assertFalse(vl.a2_ok(0.45, [0.30], 0.30))               # centroid exactly 0.45 is out
        self.assertFalse(vl.a2_ok(0.30, [0.30, 0.45], 0.30)); self.assertFalse(vl.a2_ok(0.30, [0.30], 0.45))                  # one member / the clip at 0.45 is out
        self.assertTrue(vl.a2_ok(0.378, [0.281, 0.412], 0.356))                                                              # the vp-auto-03 case (decoy k=3): passes A2 as written
        self.assertTrue(vl.a2_ok(0.30, [0.30]))                                                                              # clip cos not yet known: group checks only
    def test_skipped_tier_falls_through(self):
        # a non-mint voice whose clip fails A2 returns no clip, so the tier is skipped and tier 3 (same-sex doctor mint, another room) is used
        sources = {"SM2": ({"r2"}, lambda: ["m21", "m22"])}
        out = vl.pick_decoys("D", "M", True, ["r1"], sources, [("M", lambda: [], "g_failed_a2")], SEX)
        self.assertEqual([(l, c, mm) for l, c, mm in out], [("other_doctor_print:SM2", "m21", False), ("other_doctor_print:SM2", "m22", False)])
class A3(unittest.TestCase):
    def test_manifest_has_no_duration_and_no_flag(self):
        e = vl.manifest_entry("Dr X", "dr-x", 3); self.assertEqual(set(e), {"doctor_name", "slug", "k", "file"}); self.assertEqual(e["file"], "clips/dr-x_3.wav")
    def test_own_window_tier_is_unreachable(self):
        # the builder passes nonmint=[]: only other doctors' prints can be decoys, same sex, same room first then any room
        out = vl.pick_decoys("D", "M", True, ["r1"], {"SM2": ({"r2"}, lambda: ["m21", "m22"]), "SM": ({"r1"}, lambda: ["m1"])}, [], SEX)
        self.assertEqual([(l, c, mm) for l, c, mm in out], [("other_doctor_print:SM", "m1", False), ("other_doctor_print:SM2", "m21", False)])
    def test_answered_clips_excluded_by_time_overlap(self):
        d = tempfile.mkdtemp(); csvp = f"{d}/V-ANSWERS-x.csv"; kd = f"{d}/set"; os.makedirs(kd)
        import json
        json.dump({"key": {"dr-x": {"1": dict(window="w1", start=100.0, end=110.0), "2": dict(window="w2", start=5.0, end=17.0)}}}, open(f"{kd}/KEY-DO-NOT-SHIP.json", "w"))
        open(csvp, "w").write("clip,answer,comment\ndr-x_1,yes,\ndr-x_2,no,\n")
        self.assertEqual(vl.load_answered([f"{csvp}={kd}"]), 2)
        self.assertTrue(vl.overlaps_answered("w1", 105.0, 115.0)); self.assertTrue(vl.overlaps_answered("w1", 90.0, 100.1)); self.assertTrue(vl.overlaps_answered("w1", 101.0, 102.0))
        self.assertFalse(vl.overlaps_answered("w1", 110.0, 120.0)); self.assertFalse(vl.overlaps_answered("w1", 90.0, 100.0))          # touching is not overlapping
        self.assertFalse(vl.overlaps_answered("w3", 100.0, 110.0)); self.assertTrue(vl.overlaps_answered("w2", 0.0, 6.0))
        self.assertEqual(vl.load_answered([]), 0); self.assertFalse(vl.overlaps_answered("w1", 105.0, 115.0))
if __name__ == "__main__": unittest.main()
