"""Tests for labgate.py on invented data (they exist in both versions of the calibration diff)."""
import datetime as dt
import os
import tempfile
import unittest

import labgate as L

M = "c0ffee00" * 8


class T(unittest.TestCase):
    def test_filter_keeps_named_fields(self):
        row = {"id": "r1", "name": "Room A", "recording": True, "label": "x"}
        self.assertEqual(L.filter_fields(row), {"id": "r1", "name": "Room A", "recording": True})

    def test_manifest_full_equal_and_mismatch(self):
        self.assertTrue(L.manifest_matches(M, M))
        self.assertFalse(L.manifest_matches(M, "deadbeef" * 8))

    def test_stamp_layout_only_raises(self):
        p = {"complete": False, "missing": ["router: no readable .py file"], "reason": "layout"}
        out = L.stamp(p, True)
        self.assertTrue(out["complete"])
        self.assertEqual(out["harness_missing"], ["router: no readable .py file"])

    def test_stamp_failed_box_check_lowers(self):
        self.assertFalse(L.stamp({"complete": True}, False)["complete"])

    def test_in_clinic_midday(self):
        self.assertTrue(L.in_clinic(dt.datetime(2026, 9, 21, 9, 0, tzinfo=dt.timezone.utc)))   # Mon 14:30 IST

    def test_count_jobs_one_local(self):
        lines = ["python3 histwork/node_route.py --router http://127.0.0.1:8083 --win w1", "bash"]
        self.assertEqual(L.count_jobs(8083, lines), 1)

    def test_push_codes(self):
        self.assertEqual(L.push_record(lambda k, b: 201, "k", b"x"), "ok")
        self.assertEqual(L.push_record(lambda k, b: 500, "k", b"x"), "rejected 500")

    def test_key_for(self):
        self.assertEqual(L.key_for("room_a", "2026-09-25", "run1"), "annotations/room_a/2026-09-25/run1.json")
        with self.assertRaises(ValueError):
            L.key_for("../x", "2026-09-25", "run1")

    def test_notifier_new_then_resolved(self):
        sent = []
        n = L.Notifier(sent.append)
        n.cycle([{"room": "A", "code": "NOT_RECORDING"}], 1)
        n.cycle([], 2)
        self.assertEqual(sent, ["NEW A NOT_RECORDING", "RESOLVED A NOT_RECORDING"])

    def test_exact_zero_needs_full_chunk(self):
        self.assertFalse(L.is_exact_zero(212379, 120000))
        self.assertFalse(L.is_exact_zero(9_000_000, 300000))

    def test_digest_order_independent(self):
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "a"), os.path.join(d, "b")
        open(a, "wb").write(b"1"); open(b, "wb").write(b"2")
        self.assertEqual(L.digest([a, b]), L.digest([b, a]))


if __name__ == "__main__":
    unittest.main()
