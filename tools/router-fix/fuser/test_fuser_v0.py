#!/usr/bin/env python3
"""Offline tests for fuser_v0.py against reb's real library (REB_LIB_PATH, pinned+enforced).
Run from the repo root: python3 -m unittest fuser.test_fuser_v0 -v
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fuser_v0 as fv  # noqa: E402
from reb.writer import write_track, config_hash  # noqa: E402


def _track(window_id, engine, segs, layer="stt"):
    return {"schema": "reb.track.v1", "window_id": window_id, "layer": layer, "engine": engine,
            "model": "m", "version": "1", "config": {}, "config_hash": config_hash({}),
            "machine": "test", "status": "ok", "reason": None, "segments": segs}


class FuserV0(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="reb-fuser-test-")
        self.date, self.room, self.win = "2026-09-27", "room_test", "w_fuser_test"
        stub = {"window_id": self.win, "room_id": self.room, "room_slug": "test", "ist_date": self.date,
                "t0_ms": 0, "t1_ms": 300000,
                "audio": {"r2_key": "x", "sha256": "ab" * 32, "sample_rate": 16000, "duration_ms": 300000}}
        write_track(self.root, self.date, self.room, self.win,
                    _track(self.win, "sravaani",
                           [{"t0_ms": 0, "t1_ms": 3000,
                             "text": "मेट फ़ॉर्म इन फाइव हंड्रेड मिलीग्राम आफ़्टर फ़ूड"}]),
                    manifest_stub=stub)
        write_track(self.root, self.date, self.room, self.win,
                    _track(self.win, "whisper-forced-en",
                           [{"t0_ms": 0, "t1_ms": 3000, "text": "Metformin 500 mg after food"}]))

    def _fuse(self, etr_enabled):
        return fv.fuse_window(self.win, ist_date=self.date, room_id=self.room, root=self.root,
                              etr_enabled=etr_enabled)

    def test_etr_on_recovers_the_dose(self):
        track = self._fuse(True)
        self.assertEqual(track["config"]["etr_enabled"], True)
        self.assertIn("500 mg", track["segments"][0]["text"])
        self.assertEqual(track["segments"][0]["extras"]["etr_recovered"][0]["value"], 500)

    def test_etr_off_flag_in_config_and_no_insertion(self):
        track = self._fuse(False)
        self.assertEqual(track["config"]["etr_enabled"], False)
        self.assertNotIn(fv.rs.ETR_DELIM[0], track["segments"][0]["text"])
        self.assertEqual(track["segments"][0]["extras"]["etr_recovered"], [])

    def test_on_and_off_have_different_config_hash(self):
        self.assertNotEqual(self._fuse(True)["config_hash"], self._fuse(False)["config_hash"])

    def test_etr_off_never_calls_recover_english_numerals(self):
        # eta-refuter-2 #4656/#4661 X2/P2: flag off must be byte-identical to a build without ETR, not
        # just "ETR found nothing this time" -- stub the function to prove nothing calls it.
        called = []
        real = fv.rs.recover_english_numerals
        fv.rs.recover_english_numerals = lambda *a, **k: (called.append(1), real(*a, **k))[1]
        try:
            off = self._fuse(False)
        finally:
            fv.rs.recover_english_numerals = real
        self.assertEqual(called, [])
        self.assertEqual(off["segments"][0]["text"], "मेट फ़ॉर्म इन फाइव हंड्रेड मिलीग्राम आफ़्टर फ़ूड")

    def test_pin_is_enforced_and_recorded(self):
        self.assertEqual(fv.REB_SHA, fv.REB_LIB_PATH_PIN)
        self.assertEqual(self._fuse(True)["config"]["reb_sha"], fv.REB_LIB_PATH_PIN)




class PinEnforcement(unittest.TestCase):
    """Separate process each time: fuser_v0's pin check runs at IMPORT time, so a fresh interpreter is
    needed to observe it under a modified REB_LIB_PATH/REB_LIB_PATH_PIN."""

    def _run(self, env_extra):
        import subprocess
        env = dict(os.environ)
        env["ETA_FUSER_ALLOW_DIRTY_CODE"] = "1"  # isolate: only testing the reb pin here, not this repo's own state
        env.update(env_extra)
        env["REB_LIB_PATH"] = fv.REB_LIB_PATH
        r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0,'.'); import fuser_v0"],
                           cwd=os.path.dirname(os.path.abspath(__file__)), env=env,
                           capture_output=True, text=True)
        return r

    def test_dirty_worktree_refuses_even_with_matching_head(self):
        marker = os.path.join(fv.REB_LIB_PATH, "kit", "reb", "__dirty_test_marker__.tmp")
        open(marker, "w").close()
        try:
            r = self._run({})
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("uncommitted changes", r.stderr)
        finally:
            os.remove(marker)

    def test_pin_override_is_logged_even_when_it_still_fails(self):
        # A genuinely different override (deliberately wrong here) must both be logged as an override
        # AND still enforce correctly against whatever HEAD actually is.
        r = self._run({"REB_LIB_PATH_PIN": "0" * 40})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("REB_LIB_PATH_PIN overridden", r.stderr)
        self.assertIn("not the pinned", r.stderr)


class FuserCodeSha(unittest.TestCase):
    """FUSER_CODE_SHA is computed at IMPORT time (like the reb pin), so a dirty router-fix checkout
    must be tested in a fresh subprocess, same as PinEnforcement above."""

    def _run(self, env_extra):
        import subprocess
        env = dict(os.environ)
        env["ETA_FUSER_ALLOW_DIRTY_CODE"] = "0"  # never inherit the outer shell's override by accident
        env.update(env_extra)
        env["REB_LIB_PATH"] = fv.REB_LIB_PATH
        r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0,'.'); import fuser_v0"],
                           cwd=os.path.dirname(os.path.abspath(__file__)), env=env,
                           capture_output=True, text=True)
        return r

    def test_dirty_router_fix_checkout_refuses(self):
        repo_marker = os.path.join(os.path.dirname(os.path.abspath(fv.__file__)), "__dirty_test_marker__.tmp")
        open(repo_marker, "w").close()
        try:
            r = self._run({})
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("uncommitted changes", r.stderr)
        finally:
            os.remove(repo_marker)

    def test_dirty_router_fix_checkout_override_is_logged(self):
        repo_marker = os.path.join(os.path.dirname(os.path.abspath(fv.__file__)), "__dirty_test_marker__.tmp")
        open(repo_marker, "w").close()
        try:
            r = self._run({"ETA_FUSER_ALLOW_DIRTY_CODE": "1"})
            self.assertEqual(r.returncode, 0)
            self.assertIn("ETA_FUSER_ALLOW_DIRTY_CODE overrides", r.stderr)
        finally:
            os.remove(repo_marker)


if __name__ == "__main__":
    unittest.main()
