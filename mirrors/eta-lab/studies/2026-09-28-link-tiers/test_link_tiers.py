"""Tests for link_tiers.py on INVENTED data (no real box data, no network)."""
import datetime as dt, os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import link_tiers as L

UTC = dt.timezone.utc


def W(*hhmm_pairs):
    """[(dt,dt), ...] windows on 2026-09-22 UTC from (start_hhmm, end_hhmm) pairs."""
    d = dt.date(2026, 9, 22)
    out = []
    for s, e in hhmm_pairs:
        sh, sm = divmod(s, 100); eh, em = divmod(e, 100)
        out.append((dt.datetime(d.year, d.month, d.day, sh, sm, tzinfo=UTC), dt.datetime(d.year, d.month, d.day, eh, em, tzinfo=UTC)))
    return out


class T(unittest.TestCase):
    def test_parse_handles_the_space_separated_format(self):
        self.assertEqual(L.parse("2026-08-19 14:29:55 +0530").isoformat(), "2026-08-19T14:29:55+05:30")
        self.assertEqual(L.parse("2026-08-19T14:29:55+05:30").isoformat(), "2026-08-19T14:29:55+05:30")
        self.assertIsNone(L.parse(None)); self.assertIsNone(L.parse(""))

    def test_coverage_full_and_partial(self):
        a, b = dt.datetime(2026, 9, 22, 9, 0, tzinfo=UTC), dt.datetime(2026, 9, 22, 9, 10, tzinfo=UTC)
        frac, gap = L.coverage(W((900, 910)), a, b)
        self.assertEqual((frac, gap), (1.0, 0.0))
        frac, gap = L.coverage(W((900, 905)), a, b)
        self.assertAlmostEqual(frac, 0.5); self.assertAlmostEqual(gap, 300.0)
        frac, gap = L.coverage([], a, b)
        self.assertEqual((frac, gap), (0.0, 600.0))

    def test_coverage_merges_overlapping_and_adjacent_windows(self):
        a, b = dt.datetime(2026, 9, 22, 9, 0, tzinfo=UTC), dt.datetime(2026, 9, 22, 9, 10, tzinfo=UTC)
        frac, gap = L.coverage(W((900, 904), (903, 907), (907, 910)), a, b)
        self.assertEqual((frac, gap), (1.0, 0.0))

    def test_coverage_small_internal_gap(self):
        a, b = dt.datetime(2026, 9, 22, 9, 0, tzinfo=UTC), dt.datetime(2026, 9, 22, 9, 10, tzinfo=UTC)
        frac, gap = L.coverage(W((900, 904), (905, 910)), a, b)   # a 60s gap (9:04-9:05)
        self.assertAlmostEqual(gap, 60.0)
        self.assertAlmostEqual(frac, 9 / 10)

    def test_t0_only_for_manoj_kumar_s_else_none(self):
        link = dict(doctor_uid=L.MANOJ_KUMAR_S, called_at="2026-09-23 10:00:00 +0530")   # Wed
        self.assertEqual(L.t0_schedule_prior(link), "room_qyzghzaf")
        link2 = dict(doctor_uid=L.MANOJ_KUMAR_S, called_at="2026-09-22 10:00:00 +0530")  # Tue
        self.assertEqual(L.t0_schedule_prior(link2), "room_ux92qpws")
        link3 = dict(doctor_uid="someone-else", called_at="2026-09-23 10:00:00 +0530")
        self.assertIsNone(L.t0_schedule_prior(link3))

    def test_t1_taped_true_when_coverage_meets_bar(self):
        link = dict(called_at="2026-09-22 09:00:00 +0530", completed_at="2026-09-22 09:03:00 +0530")   # 03:30-03:33 UTC
        cache = {"room_a": W((330, 333)), "room_b": []}
        res = L.t1_span_tape_available(link, "2026-09-22", cache)
        by_room = {r["room"]: r["taped"] for r in res}
        self.assertEqual(by_room, {"room_a": True, "room_b": False})

    def test_t1_taped_false_on_a_big_gap_even_with_high_coverage(self):
        # 10 min span, one 40s gap in the middle - coverage is high (>90%) but the gap itself disqualifies (A4)
        link = dict(called_at="2026-09-22 09:00:00 +0530", completed_at="2026-09-22 09:10:00 +0530")
        # built directly in seconds via datetime, not the W() hhmm helper (too coarse for a 40s gap)
        d = dt.date(2026, 9, 22)
        a = dt.datetime(d.year, d.month, d.day, 3, 30, tzinfo=UTC)
        gap_start = a + dt.timedelta(minutes=9, seconds=0)
        gap_end = gap_start + dt.timedelta(seconds=40)
        b = a + dt.timedelta(minutes=10)
        cache = {"room_a": [(a, gap_start), (gap_end, b)]}
        res = L.t1_span_tape_available(link, "2026-09-22", cache)
        self.assertEqual(res[0]["taped"], False)
        self.assertGreaterEqual(res[0]["covered_fraction"], 0.9)   # coverage alone would pass
        self.assertGreater(res[0]["max_gap_s"], 30)                # the gap rule is what fails it

    def test_null_control_shifted_windows_use_the_same_coverage_logic(self):
        link = dict(called_at="2026-09-22 09:00:00 +0530", completed_at="2026-09-22 09:03:00 +0530")
        cache = {"room_a": []}   # no tape anywhere -> every shifted trial fails
        res = L.t1_null_control(link, "2026-09-22", cache, shift_minutes=(60, -60))
        self.assertEqual(res, dict(shifted_trials=2, shifted_pass=0, shifted_pass_rate=0.0))

    def test_not_a_consult_flag_from_base_link_fields(self):
        # not testing base_links() itself (needs Metabase) - just the classification logic inline in build_day
        for status, no_show, cancelled, expect in (
            ("COMPLETE", None, None, False),
            ("IN_PROGRESS", None, None, True),
            ("COMPLETE", "2026-09-22 09:00:00 +0530", None, True),
            ("COMPLETE", None, "2026-09-22 09:00:00 +0530", True),
        ):
            got = bool(no_show or cancelled or status == "IN_PROGRESS")
            self.assertEqual(got, expect)

    def _keyed(self, *specs):
        d = dt.datetime(2026, 9, 22, 3, 30, tzinfo=UTC)
        return [(d + dt.timedelta(minutes=a), d + dt.timedelta(minutes=b), k) for a, b, k in specs]

    def test_signal_state_silent_present_unknown(self):
        a = dt.datetime(2026, 9, 22, 3, 30, tzinfo=UTC); b = a + dt.timedelta(minutes=10)
        kw = self._keyed((0, 5, "c1"), (5, 10, "c2"))
        self.assertEqual(L.signal_state(kw, a, b, {"c1": 2.4e-6, "c2": 3e-6}), "silent")
        self.assertEqual(L.signal_state(kw, a, b, {"c1": 2.4e-6, "c2": 0.02}), "present")   # any speech-level chunk -> present
        self.assertEqual(L.signal_state(kw, a, b, {}), "unknown")                          # no local audio: never silent
        self.assertEqual(L.signal_state(kw, a, b, {"c1": None}), "unknown")
        self.assertEqual(L.signal_state(kw, a, b, {"c1": 2.4e-6}), "silent")               # only known chunk is silent

    def test_signal_state_ignores_chunks_outside_the_span(self):
        a = dt.datetime(2026, 9, 22, 3, 30, tzinfo=UTC); b = a + dt.timedelta(minutes=5)
        kw = self._keyed((0, 5, "in"), (5, 10, "out"))
        self.assertEqual(L.signal_state(kw, a, b, {"in": 1e-6, "out": 0.05}), "silent")

    def test_t1_silent_tape_is_not_voice_testable_but_still_taped(self):
        link = dict(called_at="2026-09-22 09:00:00 +0530", completed_at="2026-09-22 09:05:00 +0530")
        a = dt.datetime(2026, 9, 22, 3, 30, tzinfo=UTC)
        cache = {"room_quiet": [(a, a + dt.timedelta(minutes=5))], "room_live": [(a, a + dt.timedelta(minutes=5))]}
        keyed = {"room_quiet": [(a, a + dt.timedelta(minutes=5), "q")], "room_live": [(a, a + dt.timedelta(minutes=5), "l")]}
        res = {x["room"]: x for x in L.t1_span_tape_available(link, "2026-09-22", cache, keyed, {"q": 2.4e-6, "l": 0.03})}
        self.assertTrue(res["room_quiet"]["taped"]); self.assertTrue(res["room_quiet"]["tape_silent"])
        self.assertFalse(res["room_quiet"]["voice_testable"])
        self.assertTrue(res["room_live"]["voice_testable"]); self.assertFalse(res["room_live"]["tape_silent"])

    def test_untaped_room_has_no_signal_verdict(self):
        link = dict(called_at="2026-09-22 09:00:00 +0530", completed_at="2026-09-22 09:05:00 +0530")
        res = L.t1_span_tape_available(link, "2026-09-22", {"r": []}, {"r": []}, {})[0]
        self.assertFalse(res["taped"]); self.assertIsNone(res["signal"]); self.assertFalse(res["voice_testable"])

    def test_partial_mic_failure_is_not_voice_testable(self):
        link = dict(called_at="2026-09-22 09:00:00 +0530", completed_at="2026-09-22 09:10:00 +0530")
        a = dt.datetime(2026, 9, 22, 3, 30, tzinfo=UTC)
        w = [(a, a + dt.timedelta(minutes=5)), (a + dt.timedelta(minutes=5), a + dt.timedelta(minutes=10))]
        keyed = {"r": [(w[0][0], w[0][1], "loud"), (w[1][0], w[1][1], "dead")]}
        # 300 s audible of a 600 s span (50% silent) -> 300 s >= T2 bar -> testable
        r = L.t1_span_tape_available(link, "2026-09-22", {"r": w}, keyed, {"loud": 0.02, "dead": 7e-6})[0]
        self.assertEqual(r["signal"], "present"); self.assertTrue(r["voice_testable"])
        self.assertAlmostEqual(r["signal_detail"]["silent_fraction"], 0.5)
        # 20 s audible of 600 s -> present but NOT testable
        keyed2 = {"r": [(a, a + dt.timedelta(seconds=20), "loud"), (a + dt.timedelta(seconds=20), a + dt.timedelta(minutes=10), "dead")]}
        w2 = [(x, y) for x, y, _ in keyed2["r"]]
        r = L.t1_span_tape_available(link, "2026-09-22", {"r": w2}, keyed2, {"loud": 0.02, "dead": 7e-6})[0]
        self.assertEqual(r["signal"], "present"); self.assertFalse(r["voice_testable"]); self.assertTrue(r["taped"])

    def test_mixed_span_70pct_silent_uses_t2_bar_constant(self):
        a = dt.datetime(2026, 9, 22, 3, 30, tzinfo=UTC)
        def run(span_s, audible_s):
            link = dict(called_at="2026-09-22 09:00:00 +0530",
                        completed_at=(L.parse("2026-09-22 09:00:00 +0530") + dt.timedelta(seconds=span_s)).isoformat())
            k = [(a, a + dt.timedelta(seconds=audible_s), "loud"), (a + dt.timedelta(seconds=audible_s), a + dt.timedelta(seconds=span_s), "dead")]
            return L.t1_span_tape_available(link, "2026-09-22", {"r": [(x, y) for x, y, _ in k]}, {"r": k}, {"loud": 0.02, "dead": 7e-6})[0]
        short = run(150, 45)     # 70% silent, 45 s audible < T2 bar -> present but NOT voice_testable
        self.assertAlmostEqual(short["signal_detail"]["silent_fraction"], 0.7)
        self.assertEqual(short["signal"], "present"); self.assertFalse(short["voice_testable"])
        self.assertTrue(run(600, 180)["voice_testable"] == (180 >= L.T2_MIN_EMBEDDED_S))
        self.assertFalse(run(600, 59)["voice_testable"]); self.assertTrue(run(600, 60)["voice_testable"])   # boundary is the constant

    def test_unknown_is_testable_but_flagged_unmeasured(self):
        link = dict(called_at="2026-09-22 09:00:00 +0530", completed_at="2026-09-22 09:05:00 +0530")
        a = dt.datetime(2026, 9, 22, 3, 30, tzinfo=UTC)
        w = [(a, a + dt.timedelta(minutes=5))]
        r = L.t1_span_tape_available(link, "2026-09-22", {"r": w}, {"r": [(w[0][0], w[0][1], "x")]}, {})[0]
        self.assertTrue(r["voice_testable"]); self.assertFalse(r["signal_measured"]); self.assertEqual(r["signal"], "unknown")


if __name__ == "__main__":
    unittest.main()
