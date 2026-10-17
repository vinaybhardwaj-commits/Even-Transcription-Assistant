#!/usr/bin/env python3
"""Tests for runner.py against reb's REAL writer/reader (same pattern as test_prepass.py/test_fuser_v0.py)
-- `send` is always a stub here, same posture as test_gemini_call.py: this suite never makes a real API
call, it only exercises the plumbing that WOULD carry a real one."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gemini_call as gc  # noqa: E402
import number_parse as npm  # noqa: E402
import prepass  # noqa: E402
import runner  # noqa: E402

REB_LIB_PATH = os.environ.get("REB_LIB_PATH", "/tmp/wt-reb-a447dc36")
sys.path.insert(0, REB_LIB_PATH + "/kit")
import reb as reb_pkg  # noqa: E402
from reb.writer import write_track, config_hash  # noqa: E402

RIDX = npm.build_reverse_index(200)
LEX = {"pantoprazole": 5}

# sravaani's own track index k is wherever prepass.STT_ENGINES puts it (currently 8, last in the list)
# -- never hardcode this; tokenize_tracks ids are "k:s:i" and k comes from that list's position.
SRA_K = prepass.STT_ENGINES.index("sravaani")
GOOD_CONTENT = {
    "copies": [{"pos": 0, "refs": [f"{SRA_K}:0:0"]}, {"pos": 1, "refs": [f"{SRA_K}:0:1"]}],
    "norms": [], "gens": [], "conflicts": [],
    "en_clauses": [{"text": "tab", "native_pos": [0, 1]}], "entities": [],
}


def _track(win, engine, cfg, segs, layer="stt", status="ok", reason=None):
    return {"schema": "reb.track.v1", "window_id": win, "layer": layer, "engine": engine, "model": "m",
            "version": "1", "config": cfg, "config_hash": config_hash(cfg), "machine": "box",
            "status": status, "reason": reason, "segments": segs}


def _ok_send(usage=None):
    def send(body):
        data = {"model": gc.MODEL, "provider": "p",
               "choices": [{"message": {"content": json.dumps(GOOD_CONTENT)}}]}
        if usage is not None:
            data["usage"] = usage
        return 200, data
    return send


@unittest.skipUnless(REB_LIB_PATH and os.path.exists(REB_LIB_PATH), "reb library worktree not available")
class Runner(unittest.TestCase):
    def setUp(self):
        self._real_sleep = gc._sleep
        gc._sleep = lambda s: None  # never actually wait through gemini_call's retry backoff in tests
        self.root = tempfile.mkdtemp(prefix="reb-runner-test-")
        self.date, self.room, self.win = "2026-09-27", "room_test", "w_runner_test"
        stub = {"window_id": self.win, "room_id": self.room, "room_slug": "test", "ist_date": self.date,
                "t0_ms": 0, "t1_ms": 5000, "source_kind": "suite_synthetic", "clock": "clip_local",
                "audio": {"r2_key": "x", "sha256": "ab" * 32, "sample_rate": 16000, "duration_ms": 5000}}
        w_segs = [{"t0_ms": 0, "t1_ms": 5000, "text": "tab Pantoprazole", "words": [
            {"w": "tab", "t0_ms": 0, "t1_ms": 280}, {"w": "Pantoprazole", "t0_ms": 280, "t1_ms": 1550}]}]
        write_track(self.root, self.date, self.room, self.win, _track(self.win, "whisper-auto", {}, w_segs),
                   manifest_stub=stub)
        sra_segs = [{"t0_ms": 0, "t1_ms": 5000, "text": "टैब पैंटोप्राजोल", "words": [
            {"w": "टैब", "t0_ms": 80, "t1_ms": 380}, {"w": "पैंटोप्राजोल", "t0_ms": 380, "t1_ms": 1680}]}]
        write_track(self.root, self.date, self.room, self.win, _track(self.win, "sravaani", {}, sra_segs))

    def tearDown(self):
        gc._sleep = self._real_sleep

    def _window(self):
        return reb_pkg.load_window(self.win, ist_date=self.date, root=self.root)

    def test_run_slice_end_to_end_pass_outcome(self):
        sl = {"t0_ms": 0, "t1_ms": 5000, "core_t0_ms": 0, "core_t1_ms": 5000, "cut_source": "window"}
        r = runner.run_slice(self._window(), sl, LEX, RIDX, _ok_send())
        self.assertEqual(r["reply_status"], "ok")
        self.assertEqual(r["validated"]["outcome"], "pass")
        self.assertEqual(r["n_native_items"], 2)

    def test_run_slice_carries_usage_through(self):
        sl = {"t0_ms": 0, "t1_ms": 5000, "core_t0_ms": 0, "core_t1_ms": 5000, "cut_source": "window"}
        usage = {"prompt_tokens": 500, "completion_tokens": 50, "cost": 0.0003}
        r = runner.run_slice(self._window(), sl, LEX, RIDX, _ok_send(usage))
        self.assertEqual(r["usage"], usage)

    def test_run_slice_carries_finish_reason_through(self):
        # eta-refuter-2 #5215: RUN 2 needs finish_reason surfaced per slice to diagnose bad_reply calls
        # (was truncation the cause of the unexplained latency-tail calls, or something else).
        def send(body):
            status, data = _ok_send()(body)
            data["choices"][0]["finish_reason"] = "stop"
            return status, data
        sl = {"t0_ms": 0, "t1_ms": 5000, "core_t0_ms": 0, "core_t1_ms": 5000, "cut_source": "window"}
        r = runner.run_slice(self._window(), sl, LEX, RIDX, send)
        self.assertEqual(r["finish_reason"], "stop")

    def test_run_slice_api_failure_falls_back(self):
        sl = {"t0_ms": 0, "t1_ms": 5000, "core_t0_ms": 0, "core_t1_ms": 5000, "cut_source": "window"}
        r = runner.run_slice(self._window(), sl, LEX, RIDX, lambda body: (503, None))
        self.assertEqual(r["validated"]["outcome"], "fallback")
        self.assertTrue(r["validated"]["reasons"][0].startswith("api_"))
        self.assertEqual(r["n_native_items"], 0)

    def test_run_slice_route_mismatch_falls_back_not_trusted(self):
        def send(body):
            return 200, {"model": "some-other-model", "provider": "p",
                        "choices": [{"message": {"content": json.dumps(GOOD_CONTENT)}}]}
        sl = {"t0_ms": 0, "t1_ms": 5000, "core_t0_ms": 0, "core_t1_ms": 5000, "cut_source": "window"}
        r = runner.run_slice(self._window(), sl, LEX, RIDX, send)
        self.assertEqual(r["validated"]["outcome"], "fallback")
        self.assertEqual(r["validated"]["reasons"], ["api_route_mismatch"])

    def test_run_window_aggregates_outcomes_and_usage(self):
        usage = {"prompt_tokens": 500, "completion_tokens": 50, "cost": 0.0003}
        out = runner.run_window(self._window(), LEX, RIDX, _ok_send(usage))
        self.assertEqual(out["n_slices"], 1)
        self.assertEqual(out["outcomes"], {"pass": 1})
        self.assertEqual(out["total_prompt_tokens"], 500)
        self.assertAlmostEqual(out["total_cost_usd"], 0.0003)
        self.assertIsNotNone(out["p95_latency_ms"])

    def test_run_window_with_no_usage_reported_leaves_totals_none(self):
        out = runner.run_window(self._window(), LEX, RIDX, _ok_send())
        self.assertIsNone(out["total_cost_usd"])
        self.assertIsNone(out["total_prompt_tokens"])

    def test_run_window_multiple_slices_from_a_long_window(self):
        # window longer than MAX_SLICE_MS with no diar/vad -> cut_slices splits it into >1 slice.
        # bounds now come ONLY from the window's own audio.duration_ms (clip_local_bounds), never a
        # caller override -- build a second window whose manifest actually says it's this long.
        win2 = "w_runner_long"
        stub2 = {"window_id": win2, "room_id": self.room, "room_slug": "test", "ist_date": self.date,
                "t0_ms": 0, "t1_ms": 100_000, "source_kind": "suite_synthetic", "clock": "clip_local",
                "audio": {"r2_key": "x", "sha256": "cd" * 32, "sample_rate": 16000, "duration_ms": 100_000}}
        write_track(self.root, self.date, self.room, win2,
                   _track(win2, "whisper-auto", {}, [{"t0_ms": 0, "t1_ms": 100_000, "text": "hello"}]),
                   manifest_stub=stub2)
        window2 = reb_pkg.load_window(win2, ist_date=self.date, root=self.root)
        out = runner.run_window(window2, LEX, RIDX, _ok_send())
        self.assertGreater(out["n_slices"], 1)
        self.assertEqual(sum(out["outcomes"].values()), out["n_slices"])

    def test_run_window_tape_utc_absolute_bounds_do_not_zero_the_slice(self):
        # THE REAL BUG B4's own smoke test caught: a "dev_clip" window's manifest t0_ms/t1_ms is an
        # ABSOLUTE tape-clock position (huge numbers), but every engine's own segments are clip-local
        # (0-based) regardless -- using the manifest's t0/t1 as slicing bounds silently zeroed every
        # extracted token for real DEV30 windows. Reproduced here directly with an absolute-clock window.
        win3 = "w_tape_utc"
        abs_t0, abs_t1 = 1_789_193_088_000, 1_789_193_117_000  # a real absolute tape position (~2026)
        stub3 = {"window_id": win3, "room_id": "room_real", "room_slug": "room_real", "ist_date": self.date,
                "t0_ms": abs_t0, "t1_ms": abs_t1,
                "audio": {"r2_key": "x", "sha256": "ef" * 32, "sample_rate": 48000, "duration_ms": 29000},
                "source_kind": "dev_clip", "clock": "tape_utc"}
        # high-confidence LID so V4's whisper-anchor gate doesn't engage -- this test is isolating the
        # CLOCK bug specifically, not re-testing V4's own separate semantics.
        w_seg = {"t0_ms": 0, "t1_ms": 5000, "text": "hello",
                 "extras": {"lid": {"detected": "en", "p": 0.95, "probs": {"en": 0.95}, "scored_ms": [0, 5000]}}}
        write_track(self.root, self.date, "room_real", win3,
                   _track(win3, "whisper-auto", {}, [w_seg]), manifest_stub=stub3)
        window3 = reb_pkg.load_window(win3, ist_date=self.date, room_id="room_real", root=self.root)
        self.assertEqual(runner.clip_local_bounds(window3), (0, 29000))
        # cite the ACTUAL whisper token ("0:0:0", from the segment written at clip-local [0,5000]) --
        # this only validates as a real, non-fabricated citation if the slice bounds correctly extracted
        # it despite the window's absolute manifest t0_ms/t1_ms. Before the fix, using those absolute
        # bounds directly meant NO token was ever extracted at all, so this citation would fail as a
        # fabricated ref (V1) regardless of anything the model said.
        content = {"copies": [{"pos": 0, "refs": ["0:0:0"]}], "norms": [], "gens": [], "conflicts": [],
                   "en_clauses": [], "entities": []}
        def send(body):
            return 200, {"model": gc.MODEL, "provider": "p",
                        "choices": [{"message": {"content": json.dumps(content)}}]}
        out = runner.run_window(window3, LEX, RIDX, send)
        self.assertEqual(out["slices"][0]["validated"]["outcome"], "pass")

    def test_room_tape_source_kind_fails_loud_not_silently_assumed(self):
        # eta-refuter-2 #5020: (0, duration) is verified only for suite_synthetic/dev_clip -- a real
        # room_tape window's own segment clock is UNCHECKED and must not be silently assumed. Explicit
        # source_kind="room_tape", AND no source_kind declared at all (same default per lid-debug's own
        # manifest spec), must both raise rather than guess.
        win4 = "w_room_tape"
        stub4 = {"window_id": win4, "room_id": self.room, "room_slug": "test", "ist_date": self.date,
                "t0_ms": 0, "t1_ms": 5000, "source_kind": "room_tape",
                "audio": {"r2_key": "x", "sha256": "12" * 32, "sample_rate": 16000, "duration_ms": 5000}}
        write_track(self.root, self.date, self.room, win4,
                   _track(win4, "whisper-auto", {}, [{"t0_ms": 0, "t1_ms": 5000, "text": "hello"}]),
                   manifest_stub=stub4)
        window4 = reb_pkg.load_window(win4, ist_date=self.date, root=self.root)
        with self.assertRaises(NotImplementedError):
            runner.clip_local_bounds(window4)

        win5 = "w_no_source_kind"
        stub5 = {"window_id": win5, "room_id": self.room, "room_slug": "test", "ist_date": self.date,
                "t0_ms": 0, "t1_ms": 5000,  # no source_kind at all -- defaults to room_tape
                "audio": {"r2_key": "x", "sha256": "34" * 32, "sample_rate": 16000, "duration_ms": 5000}}
        write_track(self.root, self.date, self.room, win5,
                   _track(win5, "whisper-auto", {}, [{"t0_ms": 0, "t1_ms": 5000, "text": "hello"}]),
                   manifest_stub=stub5)
        window5 = reb_pkg.load_window(win5, ist_date=self.date, root=self.root)
        with self.assertRaises(NotImplementedError):
            runner.clip_local_bounds(window5)


if __name__ == "__main__":
    unittest.main()
