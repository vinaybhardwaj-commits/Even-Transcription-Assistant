#!/usr/bin/env python3
"""Tests for the 455.A waste guards. python3 test_waste_guards.py  (stdlib only)."""
import importlib, json, os, sys, tempfile, time, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import oc_usage
import loop_gate
import token_budget
import context_watchdog

class TestOcUsage(unittest.TestCase):
    def test_remote_script_uses_readonly_uri(self):
        # the remote script must open mode=ro and embed the query via %r (repr), never argv
        captured = {}
        class FakeP: returncode = 0; stdout = "[]"; stderr = ""
        def fake_run(cmd, input=None, capture_output=None, text=None, timeout=None):
            captured["input"] = input; return FakeP()
        with mock.patch.object(oc_usage.subprocess, "run", side_effect=fake_run):
            conn, _ = oc_usage.connect("box")
            conn.execute("SELECT 1", ())
            self.assertIn("mode=ro", captured["input"])
            self.assertIn("'SELECT 1'", captured["input"])

    def test_latest_tokens_skips_null_rollups(self):
        class FakeConn:
            def execute(self, q):
                return [("s1", "/d/x", "t1", None, "123"), ("s2", "/d/y", "t2", "456", "124")]
        r = oc_usage.latest_assistant_tokens(FakeConn())
        self.assertEqual(list(r.keys()), ["s2"])
        self.assertEqual(r["s2"]["tokens_total"], 456)

class TestLoopGate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = loop_gate.STATE_DIR
        loop_gate.STATE_DIR = self.tmp.name
    def tearDown(self):
        loop_gate.STATE_DIR = self.old
        self.tmp.cleanup()
    def test_first_sight_open(self):
        self.assertEqual(loop_gate.check("L1", "a" * 16, 30), 0)
    def test_same_hash_within_floor_skips(self):
        loop_gate.record("L1", "a" * 16)
        self.assertEqual(loop_gate.check("L1", "a" * 16, 30), 3)
    def test_changed_hash_opens(self):
        loop_gate.record("L1", "a" * 16)
        self.assertEqual(loop_gate.check("L1", "b" * 16, 30), 0)
    def test_floor_cannot_be_lowered(self):
        loop_gate.record("L1", "a" * 16)
        self.assertEqual(loop_gate.check("L1", "a" * 16, 5), 3)  # 5 < 30 floor -> still 30

class TestBudget(unittest.TestCase):
    def test_ist_day_start(self):
        ms = token_budget.ist_day_start_ms(1790400000000)  # some UTC instant
        # day start must be a UTC instant whose IST wall clock is 00:00
        ist_local = ms + token_budget.IST_OFFSET_MS
        self.assertEqual(ist_local % 86400000, 0)

    def test_render_marks_thresholds(self):
        tables = {"mini": {"a/b": {"tokens": 850000, "cost": 1.0, "sessions": ["s1"]},
                            "c/d": {"tokens": 700000, "cost": 0.1, "sessions": ["s2"]}}}
        t = token_budget.render_table(0, tables, 800000)
        self.assertIn("[100%]", t); self.assertIn("[80%]", t)
        self.assertIn("TOTAL", t)

class TestWatchdog(unittest.TestCase):
    def test_fable_server_detection(self):
        self.assertTrue(context_watchdog.is_fable_server({"dir": "/Users/x/dev/_private/fable/eta-snap"}))
        self.assertFalse(context_watchdog.is_fable_server({"dir": "/Users/x/dev/eta-lab"}))

if __name__ == "__main__":
    unittest.main(verbosity=1)
