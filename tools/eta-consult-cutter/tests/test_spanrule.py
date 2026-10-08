import unittest
from cutter import spanrule as S, config as C

def W(i, t_open, t_close=None, reason="url_clear", doc="D1", room="r1"):
    return dict(id=i, consult_uid=f"c{i}", room_id=room, t_open=t_open, t_close=t_close, close_reason=reason, doctor_uid=doc)

class Span(unittest.TestCase):
    def test_explicit_close_plus_15(self):
        w = W(1, 1000, 1300); p = S.plan_span(w, [w], None, None, True)
        self.assertEqual((p["start"], p["end"], p["mode"], p["rule"]), (940, 1315, "fixed", "explicit_close+15s"))
    def test_endConsult_is_explicit(self):
        w = W(1, 1000, 1300, "endConsult"); self.assertEqual(S.plan_span(w, [w], None, None, False)["end"], 1315)
    def test_lead_in_60s(self): w = W(1, 1000, 1300); self.assertEqual(S.plan_span(w, [w], None, None, True)["start"], 940)
    def test_start_not_before_tape_start(self):
        w = W(1, 1000, 1300); p = S.plan_span(w, [w], 990, None, True); self.assertEqual(p["start"], 990); self.assertIn("start_at_tape_start", p["flags"])
    def test_back_to_back_start_at_previous_close_and_end_capped_at_next_open(self):
        a, b, c = W(1, 1000, 1200), W(2, 1220, 1500), W(3, 1505, 1800)
        pb = S.plan_span(b, [a, b, c], None, None, True)
        self.assertEqual(pb["start"], 1200); self.assertIn("start_at_previous_window_close", pb["flags"])      # previous t_close 1200 > t_open-60 = 1160
        self.assertEqual(pb["end"], 1505); self.assertIn("end_capped_next_window", pb["flags"])                  # t_close+15 = 1515 > next open 1505
    def test_previous_close_before_the_lead_in_does_not_move_start(self):
        a, b = W(1, 100, 200), W(2, 1000, 1300); self.assertEqual(S.plan_span(b, [a, b], None, None, True)["start"], 940)
    def test_previous_unclosed_uses_its_open(self):
        a, b = W(1, 970, None, "idle_timeout"), W(2, 1000, 1300); self.assertEqual(S.plan_span(b, [a, b], None, None, True)["start"], 970)
    def test_idle_timeout_with_print_is_a_search_up_to_30min(self):
        w = W(1, 1000, 1135, "idle_timeout"); p = S.plan_span(w, [w], None, None, True)
        self.assertEqual((p["mode"], p["search_end"], p["end"]), ("search", 1000 + 1800, None))             # t_close + 30 < t_open + 30 min: the 30-min horizon applies
    def test_idle_search_capped_by_next_window(self):
        a, b = W(1, 1000, 1135, "idle_timeout"), W(2, 1900, 2000); p = S.plan_span(a, [a, b], None, None, True)
        self.assertEqual(p["search_end"], 1900); self.assertIn("search_capped_next_window", p["flags"])
    def test_no_print_end_estimated(self):
        w = W(1, 1000, 1135, "idle_timeout"); p = S.plan_span(w, [w], None, None, False)
        self.assertEqual((p["mode"], p["end"]), ("fixed", 1135 + 600)); self.assertIn("end_estimated", p["flags"])
    def test_no_print_estimate_capped_at_next_open(self):
        a, b = W(1, 1000, 1135, "idle_timeout"), W(2, 1400, 1500); p = S.plan_span(a, [a, b], None, None, False)
        self.assertEqual(p["end"], 1400)
    def test_unclosed_and_cap90_are_not_explicit(self):
        for r in ("unclosed", "open", "cap_90m", "idle_timeout", None):
            w = W(1, 1000, 1135, r); self.assertEqual(S.plan_span(w, [w], None, None, True)["mode"], "search", r)
    def test_tape_end_truncates_a_fixed_end(self):
        w = W(1, 1000, 1300); p = S.plan_span(w, [w], None, 1200, True); self.assertEqual(p["end"], 1200); self.assertIn("tape_truncated", p["flags"])
    def test_other_rooms_do_not_matter(self):
        a, b = W(1, 1000, 1300, room="r1"), W(2, 1100, 1200, room="r2"); self.assertEqual(S.plan_span(a, [a], None, None, True)["end"], 1315)

class LongWindows(unittest.TestCase):          # R3
    def test_cap_90m_window_is_searched_to_its_own_end(self):
        w = W(1, 1000, 1000 + 5400, "cap_90m"); p = S.plan_span(w, [w], None, None, True)
        self.assertEqual(p["search_end"], 1000 + 5400 + 30)
        e, f = S.finalize_search_end(p, w["t_close"], 1000 + 600.0); self.assertEqual(e, w["t_close"]); self.assertIn("end_floor_t_close", f)    # doctor silent: still never before t_close
    def test_45_min_idle_timeout_window_never_cut_before_t_close(self):
        w = W(1, 1000, 1000 + 2700, "idle_timeout"); p = S.plan_span(w, [w], None, None, True); self.assertGreaterEqual(p["search_end"], w["t_close"])
        e, _ = S.finalize_search_end(p, w["t_close"], 1000 + 100.0); self.assertGreaterEqual(e, w["t_close"])
    def test_next_window_still_caps(self):
        a, b = W(1, 1000, 1000 + 5400, "cap_90m"), W(2, 3000, 3100); p = S.plan_span(a, [a, b], None, None, True); self.assertEqual(p["search_end"], 3000); self.assertIn("search_capped_next_window", p["flags"])
    def test_no_print_cap90_end_covers_the_window(self):
        w = W(1, 1000, 1000 + 5400, "cap_90m"); p = S.plan_span(w, [w], None, None, False); self.assertGreaterEqual(p["end"], w["t_close"])
    def test_previous_close_equal_to_t_open_is_not_an_overlap(self):
        a, b = W(1, 900, 1000), W(2, 1000, 1500); p = S.plan_span(b, [a, b], None, None, True); self.assertEqual(p["start"], 1000); self.assertIn("start_at_previous_window_close", p["flags"]); self.assertNotIn("overlaps_previous_window", p["flags"])
    def test_overlapping_previous_window_does_not_push_start_past_t_open(self):          # R10
        a, b = W(1, 900, 1100), W(2, 1000, 1500); p = S.plan_span(b, [a, b], None, None, True); self.assertEqual(p["start"], 1000); self.assertIn("overlaps_previous_window", p["flags"])

class Finalize(unittest.TestCase):
    def setUp(self): self.p = dict(start=940, search_end=2800)
    def test_last_doctor_turn_plus_30(self): self.assertEqual(S.finalize_search_end(self.p, 1135, 1500.0), (1530.0, []))
    def test_floor_at_t_close(self): self.assertEqual(S.finalize_search_end(self.p, 1135, 1000.0), (1135, ["end_floor_t_close"]))
    def test_capped_at_search_end(self): e, f = S.finalize_search_end(self.p, 1135, 2790.0); self.assertEqual((e, f), (2800, ["end_capped_search"]))
    def test_no_doctor_turn(self): e, f = S.finalize_search_end(self.p, 1135, None); self.assertEqual((e, f), (1150, ["no_doctor_turn"]))

class Eligibility(unittest.TestCase):
    def test_closed_at_least_15_min_ago(self):
        w = W(1, 1000, 2000); self.assertFalse(S.eligible(w, 2000 + 899)); self.assertTrue(S.eligible(w, 2000 + 900))
    def test_unclosed_never_eligible(self): self.assertFalse(S.eligible(W(1, 1000, None), 10 ** 9))
    def test_recomputed_window_changes_the_signature(self):
        a = W(1, 1000, 1135, "idle_timeout"); b = dict(a, t_close=1900.0, close_reason="url_clear")
        sa = S.plan_signature(a, S.plan_span(a, [a], None, None, True), True, 1.0, "d"); sb = S.plan_signature(b, S.plan_span(b, [b], None, None, True), True, 1.0, "d")
        self.assertNotEqual(sa, sb); self.assertTrue(S.sig_changed(sa, dict(span_end_epoch=1500.0, flags=[]), sb))
        self.assertTrue(S.sig_changed(sa, {}, S.plan_signature(dict(a, doctor_uid="D2"), S.plan_span(dict(a, doctor_uid="D2"), [a], None, None, True), True, 1.0, "d")))
        self.assertTrue(S.sig_changed([1, 2, 3], {}, sa))                                                          # an old-format signature is cut once more
if __name__ == "__main__": unittest.main()
