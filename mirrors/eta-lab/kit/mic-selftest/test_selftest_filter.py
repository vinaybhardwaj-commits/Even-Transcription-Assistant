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
            seg("opd4", 60, 94),                        # before, 6 s clear of the interval (margin 5 s)
            seg("opd4", 90, 101),                       # ends inside the interval
            seg("opd4", 105, 120),                      # inside
            seg("opd4", 129, 140),                      # starts inside
            seg("opd4", 95, 140),                       # spans it
            seg("opd4", 130, 160),                      # starts exactly at the end: inside the 5 s margin, dropped
            seg("opd4", 136, 160),                      # starts 6 s after the end: kept
            seg("opd4", 200, 230),                      # after
            seg("opd3", 105, 120),                      # another room, same time
        ]
        kept, dropped = F.filter_segments(segs, IV)
        self.assertEqual([(k["room"], round(k["start"] - T0)) for k in kept], [("opd4", 60), ("opd4", 136), ("opd4", 200), ("opd3", 105)])
        self.assertEqual(len(dropped), 5)
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

    def test_a_segment_without_times_is_dropped_when_it_could_be_that_room(self):
        """Fail closed: no times means no proof of no overlap."""
        kept, dropped = F.filter_segments([dict(room="opd4", text="hello there"), dict(room="opd3", text="hello there")], IV)
        self.assertEqual([k["room"] for k in kept], ["opd3"])
        self.assertEqual(dropped[0]["reason"], "cannot verify overlap (no times)")
        kept2, dropped2 = F.filter_segments([dict(room="opd4", text="hello there")], [])          # no self-test happened at all: nothing to fear
        self.assertEqual((len(kept2), len(dropped2)), (1, 0))

    def test_a_segment_that_names_no_room_counts_as_every_room(self):
        inside = dict(start=T0 + 110, end=T0 + 120, text="hello")
        far = dict(start=T0 + 900, end=T0 + 910, text="hello")
        kept, dropped = F.filter_segments([inside, far], IV)
        self.assertEqual((len(kept), len(dropped)), (1, 1))                                       # the overlapping one goes, the far one stays (proved by its times)

    def test_the_named_margin_widens_the_interval_on_both_sides(self):
        self.assertEqual(F.FILTER_MARGIN_S, 5.0)
        before = seg("opd4", 90, 96)                                                              # ends 4 s before the interval starts: inside the margin
        just_out = seg("opd4", 80, 94.9)                                                          # ends 5.1 s before: outside
        after = seg("opd4", 134, 140)                                                             # starts 4 s after the end
        just_after = seg("opd4", 135.1, 140)
        kept, dropped = F.filter_segments([before, just_out, after, just_after], IV)
        self.assertEqual([(round(k["start"] - T0, 3), round(k["end"] - T0, 3)) for k in kept], [(80, 94.9), (135.1, 140)])
        self.assertEqual(len(dropped), 2)
        kept0, dropped0 = F.filter_segments([before, after], IV, margin_s=0)                     # the constant is the only source of the margin
        self.assertEqual((len(kept0), len(dropped0)), (2, 0))

    def test_room_id_from_the_vault_matches_the_room(self):
        iv = [dict(room="opd4", room_id="room_ux92qpws", session=None, start=T0 + 100, end=T0 + 130)]
        self.assertEqual(len(F.filter_segments([dict(room_id="room_ux92qpws", start=T0 + 110, end=T0 + 120, text="x")], iv)[1]), 1)
        self.assertEqual(len(F.filter_segments([dict(room_id="room_other", start=T0 + 110, end=T0 + 120, text="x")], iv)[1]), 0)

    def test_annotation_items_and_the_source_sha_for_the_vault_kind(self):
        import hashlib
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "log.jsonl")
        full = dict(mode="live", played=True, room="opd4", room_id="room_ux92qpws", session="s", run_id="0123abcd", canary_id="canary-6101c999", date_ist="2026-09-25",
                    tape_start_iso="2026-09-25T10:00:00+05:30", tape_end_iso="2026-09-25T10:00:12+05:30", selftest_epoch=[T0 + 1, T0 + 9])
        with open(p, "w") as f:
            f.write(json.dumps(full) + "\n")
        items, sha = F.selftest_annotation_items(p)
        self.assertEqual(items, [dict(run_id="0123abcd", t0="2026-09-25T10:00:00+05:30", t1="2026-09-25T10:00:12+05:30")])
        with open(p, "rb") as f:
            self.assertEqual(sha, hashlib.sha256(f.read()).hexdigest())
        self.assertEqual(F.selftest_annotation_items(os.path.join(d, "none.jsonl")), ([], None))

    def test_an_unreadable_log_raises_it_never_passes(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "log.jsonl")
        with open(p, "w") as f:
            f.write("{not json\n")
        with self.assertRaises(ValueError):
            F.load_intervals(p)

    def test_export_records_carry_ids_dates_and_the_interval_and_no_text(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "log.jsonl")
        full = dict(mode="live", played=True, room="opd4", room_id="room_ux92qpws", session="s", run_id="0123abcd", canary_id="canary-6101c999", date_ist="2026-09-25",
                    tape_start_iso="2026-09-25T10:00:00+05:30", tape_end_iso="2026-09-25T10:00:12+05:30", selftest_epoch=[T0 + 1, T0 + 9])
        with open(p, "w") as f:
            f.write(json.dumps(dict(full)) + "\n")
            f.write(json.dumps(dict(mode="plan", played=False, room="opd3")) + "\n")
        recs = F.export_records(p)
        self.assertEqual(recs, [dict(run_id="0123abcd", room="opd4", room_id="room_ux92qpws", session="s", date_ist="2026-09-25", t0="2026-09-25T10:00:00+05:30",
                                     t1="2026-09-25T10:00:12+05:30", canary_id="canary-6101c999")])
        bad = dict(full)
        del bad["tape_end_iso"]
        with open(p, "w") as f:
            f.write(json.dumps(bad) + "\n")
        with self.assertRaises(ValueError):
            F.export_records(p)                                                                   # a played run that cannot be exported is an error

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
        self.assertEqual(F.load_intervals(p), [dict(room="opd4", room_id=None, session="s", start=T0 + 1, end=T0 + 9, run_id=None)])
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
