"""Tests for refused_logic.py: INVENTED data only, no audio. Run from this directory:  python3 -B -m unittest test_refused_logic"""
import json, os, tempfile, unittest
import refused_logic as R


def rec(start="2026-09-19T14:00:00+00:00", segs=(), chunks=None):
    chunks = chunks or [("2026-09-19T13:56:15.333Z", 300000), ("2026-09-19T14:01:15.333Z", 300000), ("2026-09-19T14:06:15.333Z", 300000), ("2026-09-19T14:11:15.333Z", 300000)]
    cu = [dict(r2_key=f"bench/room-x/2026-09-19/bs_test/chunk_{i:05d}.webm", started_at=a, duration_ms=d) for i, (a, d) in enumerate(chunks)]
    return dict(window_id="w1", room_id="room_a", start=start, segments=list(segs), cut=dict(chunks_used=cu), provenance=dict(source_chunks=cu))


def seg(a, b, refused=True, text=""):
    return dict(start_s=a, end_s=b, refused=refused, text=text)


class AllocationTests(unittest.TestCase):
    def test_sums_to_total_and_is_proportional(self):
        a = R.allocate({"a": 300, "b": 200, "c": 100, "d": 5})
        self.assertEqual(sum(a.values()), 30)
        self.assertEqual(a["d"], 0)                                   # below the 15-window threshold
        self.assertEqual((a["a"], a["b"], a["c"]), (15, 10, 5))

    def test_small_but_eligible_room_gets_at_least_one_taken_from_the_largest(self):
        a = R.allocate({"a": 1000, "b": 15})
        self.assertEqual(sum(a.values()), 30)
        self.assertGreaterEqual(a["b"], 1)
        self.assertEqual(a["a"] + a["b"], 30)

    def test_largest_remainder_tie_break_is_the_smaller_key(self):
        self.assertEqual(R.largest_remainder({"b": 1, "a": 1, "c": 1}, 2), {"a": 1, "b": 1, "c": 0})

    def test_every_room_is_present_in_the_result(self):
        a = R.allocate({"a": 50, "b": 3})
        self.assertEqual(set(a), {"a", "b"})


class PickTests(unittest.TestCase):
    def test_deterministic_sorted_unique(self):
        pool = [f"w{i:03d}" for i in range(60)]
        a = R.pick(pool, 10, 27)
        self.assertEqual(a, R.pick(pool, 10, 27))
        self.assertEqual(a, sorted(a))
        self.assertEqual(len(set(a)), 10)
        self.assertNotEqual(a, R.pick(pool, 10, 28))

    def test_pinned_draw_derived_by_hand(self):
        """random.Random(27).random() x3 into a partial Fisher-Yates over a 10-item pool, computed independently here."""
        import random
        rng = random.Random(27)
        pool = [f"w{i}" for i in range(10)]
        for j in range(3):
            k = j + int(rng.random() * (10 - j))
            pool[j], pool[k] = pool[k], pool[j]
        self.assertEqual(R.pick([f"w{i}" for i in range(10)], 3, 27), sorted(pool[:3]))

    def test_short_pool_returns_all(self):
        self.assertEqual(R.pick(["a", "b"], 5, 1), ["a", "b"])


class IntervalTests(unittest.TestCase):
    def test_union_merges_overlap_and_touching(self):
        self.assertEqual(R.union([(0, 30), (29, 60), (60, 70), (100, 110)]), [(0, 70), (100, 110)])

    def test_union_drops_empty_and_reversed(self):
        self.assertEqual(R.union([(5, 5), (9, 3)]), [])

    def test_intersect(self):
        self.assertEqual(R.intersect([(0, 10), (20, 30)], [(5, 25)]), [(5, 10), (20, 25)])
        self.assertEqual(R.intersect([(0, 5)], [(5, 9)]), [])

    def test_total(self):
        self.assertEqual(R.total([(0, 2.5), (10, 11)]), 3.5)


class ChunkTimelineTests(unittest.TestCase):
    def test_chunk_times_are_seconds_from_the_window_start(self):
        plan = R.chunk_plan(rec())
        self.assertEqual(plan[0][0], "bench__room-x__2026-09-19__bs_test__chunk_00000.webm")     # key with / -> __ (the local cache name)
        self.assertAlmostEqual(plan[0][1], -224.667, places=3)                                    # the first chunk began before the window
        self.assertAlmostEqual(plan[1][1], 75.333, places=3)
        self.assertEqual([round(p[2]) for p in plan], [300, 300, 300, 300])

    def test_coverage_is_clipped_to_the_window(self):
        cov = R.coverage(R.chunk_plan(rec()))
        self.assertEqual(len(cov), 1)
        self.assertAlmostEqual(cov[0][0], 0.0)
        self.assertAlmostEqual(cov[0][1], 900.0)

    def test_a_gap_between_chunks_is_not_covered(self):
        r = rec(chunks=[("2026-09-19T13:56:15.333Z", 300000), ("2026-09-19T14:06:15.333Z", 300000)])   # 5 min missing in the middle
        cov = R.coverage(R.chunk_plan(r))
        self.assertEqual(len(cov), 2)
        self.assertAlmostEqual(cov[0][1], 75.333, places=2)
        self.assertAlmostEqual(cov[1][0], 375.333, places=2)


class SpanTests(unittest.TestCase):
    def test_refused_span_is_the_union_counted_once(self):
        r = rec(segs=[seg(238, 268), seg(267, 297), seg(296, 326)])
        self.assertEqual(R.measured_span(r, "refused"), [(238, 326)])

    def test_accepted_span_ignores_refused_and_textless_segments(self):
        r = rec(segs=[seg(0, 30, refused=False, text="x"), seg(40, 70, refused=True), seg(80, 110, refused=False, text="")])
        self.assertEqual(R.measured_span(r, "accepted"), [(0, 30)])
        self.assertEqual(R.measured_span(r, "refused"), [(40, 70)])

    def test_whole_window_span(self):
        self.assertEqual(R.total(R.measured_span(rec(), "whole")), 900.0)

    def test_span_is_clipped_to_the_window_and_to_coverage(self):
        r = rec(segs=[seg(880, 930)], chunks=[("2026-09-19T13:56:15.333Z", 300000), ("2026-09-19T14:01:15.333Z", 300000), ("2026-09-19T14:06:15.333Z", 300000)])
        self.assertEqual(R.measured_span(r, "refused"), [])                        # the chunks stop at 14:11:15 = 675 s: nothing covered at 880+
        r2 = rec(segs=[seg(880, 930)])
        self.assertEqual(R.measured_span(r2, "refused"), [(880, 900.0)])


class DecisionTests(unittest.TestCase):
    def test_needs_both_seconds_and_fraction(self):
        self.assertTrue(R.present(5.0, 30.0))
        self.assertFalse(R.present(4.9, 30.0))                                     # under 5 s
        self.assertFalse(R.present(5.0, 60.0))                                     # 8.3 % < 10 %
        self.assertTrue(R.present(6.0, 60.0))                                      # exactly 10 %
        self.assertFalse(R.present(0.0, 0.0))                                      # nothing measurable is never 'present'


class PopulationTests(unittest.TestCase):
    def make_home(self):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "hist", "runs", "r1"))
        os.makedirs(os.path.join(d, "hist", "out"))
        os.makedirs(os.path.join(d, "lab-vault", "staged", "runs"))
        os.makedirs(os.path.join(d, "lab-vault", "staged", "index"))

        def w(rel, obj):
            with open(os.path.join(d, rel), "w") as f:
                json.dump(obj, f)
        w("hist/runs/r1/a.json", dict(window_id="wA", room_id="rmA", segments=[dict(refused=True), dict(refused=True)]))
        w("hist/runs/r1/b.json", dict(window_id="wB", room_id="rmA", segments=[dict(refused=True), dict(refused=False, text="x")]))       # partly accepted: not in
        w("hist/runs/r1/c.json", dict(window_id="wC", room_id="rmB", segments=[]))                                                         # no segments: not in
        w("hist/runs/r1/d.json", dict(window_id="wD", room_id="rmB", segments=[dict(refused=True)]))
        w("hist/runs/r1/e.json", dict(window_id="wD", room_id="rmB", segments=[dict(refused=True)]))                                      # second file for wD
        w("hist/runs/r1/z.json", dict(window_id="wZ", room_id="rmB", segments=[dict(refused=True)]))                                      # in the exact-zero list
        w("hist/exact_zero_windows_tierA.json", dict(windows=["wZ"]))
        w("hist/exact_zero_windows_tierB.json", dict(windows=[]))
        with open(os.path.join(d, "lab-vault", "staged", "index", "v.jsonl"), "w") as f:
            f.write(json.dumps(dict(window_id="wY", status="no_signal")) + "\n")
        return d, os.path.join(d, "lab-vault", "staged", "index", "v.jsonl")

    def test_only_all_refused_windows_and_no_signal_excluded(self):
        home, vi = self.make_home()
        p = R.population(home, vi)
        self.assertEqual(sorted(p["windows"]), ["wA", "wD"])
        self.assertEqual(p["counts"], dict(all_refused_windows=3, excluded_no_signal=1, in_population=2, windows_with_several_files=1))
        self.assertTrue(p["windows"]["wD"]["path"].endswith("e.json"))              # the lexicographically LAST file
        self.assertEqual(p["windows"]["wD"]["n_files"], 2)

    def test_controls_pools(self):
        home, vi = self.make_home()
        rows = [dict(window_id=f"t{i}", status="text", n_words=150 if i % 2 == 0 else 50) for i in range(40)] + [dict(window_id=f"n{i}", status="no_signal", n_words=0) for i in range(12)]
        with open(vi, "w") as f:
            f.write("\n".join(json.dumps(r) for r in rows) + "\n")
        c = R.draw_controls(11, vi)
        self.assertEqual((len(c["accepted"]), len(c["silent"]), c["pool_accepted"], c["pool_silent"]), (10, 5, 20, 12))
        self.assertTrue(all(int(w[1:]) % 2 == 0 for w in c["accepted"]))            # only n_words >= 100
        self.assertTrue(all(w.startswith("n") for w in c["silent"]))


class DrawTests(unittest.TestCase):
    def test_draw_main_matches_allocation_and_is_deterministic(self):
        pop = dict(windows={f"r{r}-{i:03d}": dict(room=f"room_{r}") for r in "abc" for i in range({"a": 300, "b": 200, "c": 100}[r])}, counts={})
        a, b = R.draw_main(pop, 5), R.draw_main(pop, 5)
        self.assertEqual(a, b)
        self.assertEqual({k: len(v) for k, v in a["chosen"].items()}, {"room_a": 15, "room_b": 10, "room_c": 5})
        self.assertNotEqual(a, R.draw_main(pop, 6))


if __name__ == "__main__":
    unittest.main()
