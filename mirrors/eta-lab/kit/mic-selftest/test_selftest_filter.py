"""Offline tests for selftest_filter.py (ruling 369 items 4-5): the filter drops the self-test span and nothing else."""
import json, os, shutil, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import selftest_filter as F

T0 = 1_800_000_000.0
IV = [dict(room="opd4", session="sess-OPD4", start=T0 + 100, end=T0 + 130)]


def seg(room, start, end, text="thank you doctor, I will take the tablets", **kw):
    return dict(room=room, start=T0 + start, end=T0 + end, text=text, **kw)


class Filter(unittest.TestCase):
    def test_drops_the_overlapping_segments_and_nothing_else(self):
        segs = [
            seg("opd4", 60, 90),                        # before
            seg("opd4", 90, 101),                       # ends inside the interval
            seg("opd4", 105, 120),                      # inside
            seg("opd4", 129, 140),                      # starts inside
            seg("opd4", 95, 140),                       # spans it
            seg("opd4", 130, 160),                      # starts exactly at the end: not overlapping
            seg("opd4", 200, 230),                      # after
            seg("opd3", 105, 120),                      # another room, same time
        ]
        kept, dropped = F.filter_segments(segs, IV)
        self.assertEqual([(k["room"], k["start"] - T0) for k in kept], [("opd4", 60), ("opd4", 130), ("opd4", 200), ("opd3", 105)])
        self.assertEqual(len(dropped), 4)
        self.assertTrue(all(d["label"] == "mic self-test" and d["reason"] == "overlaps a self-test interval" for d in dropped))

    def test_a_dropped_item_carries_no_text(self):
        _, dropped = F.filter_segments([seg("opd4", 105, 120, text="a private sentence")], IV)
        self.assertNotIn("text", dropped[0])
        self.assertNotIn("private", json.dumps(dropped))

    def test_canary_text_is_dropped_wherever_it_is(self):
        segs = [seg("opd4", 500, 510, text="super cali fragilistic expialidocious"), seg("opd7", 10, 20, text="supercalifragilisticexpialidocious testing"),
                seg("opd4", 520, 530, text="please sit down and tell me your complaint")]
        kept, dropped = F.filter_segments(segs, [])
        self.assertEqual(len(kept), 1)
        self.assertEqual({d["reason"] for d in dropped}, {"matches the canary word"})

    def test_a_segment_without_times_is_judged_on_its_text_only(self):
        kept, dropped = F.filter_segments([dict(room="opd4", text="hello there"), dict(room="opd4", text="super cali fragilistic expialidocious")], IV)
        self.assertEqual((len(kept), len(dropped)), (1, 1))

    def test_session_id_or_room_alias_matches_the_room(self):
        by_session = dict(room="ux92qpws", session="sess-OPD4", start=T0 + 110, end=T0 + 120, text="hello")
        by_alias = seg("ux92qpws", 110, 120)
        self.assertEqual(len(F.filter_segments([by_session], IV)[1]), 1)
        self.assertEqual(len(F.filter_segments([by_alias], IV)[1]), 0)               # a different name and no session: not matched...
        self.assertEqual(len(F.filter_segments([by_alias], IV, aliases={"opd4": ("ux92qpws",)})[1]), 1)   # ...until the alias is given

    def test_load_intervals_reads_only_played_live_runs(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "log.jsonl")
        rows = [dict(mode="plan", played=False, room="opd4"), dict(mode="check", played=False, room="opd4"),
                dict(mode="live", played=False, room="opd4", refused="x"),
                dict(mode="live", played=True, room="opd4", session="s", selftest_epoch=[T0 + 1, T0 + 9])]
        with open(p, "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        self.assertEqual(F.load_intervals(p), [dict(room="opd4", session="s", start=T0 + 1, end=T0 + 9)])
        self.assertEqual(F.load_intervals(os.path.join(d, "none.jsonl")), [])

    def test_a_played_run_without_an_interval_is_an_error_not_a_pass(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "log.jsonl")
        with open(p, "w") as f:
            f.write(json.dumps(dict(mode="live", played=True, room="opd4")) + "\n")
        with self.assertRaises(ValueError):
            F.load_intervals(p)


if __name__ == "__main__":
    unittest.main()
