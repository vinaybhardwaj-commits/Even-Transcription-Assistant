#!/usr/bin/env python3
"""Offline tests for fuserv1_test_v0_tracks.py on a throwaway REB tree with synthetic tracks only.
Run: python3 -m unittest eval.test_fuserv1_test_v0_tracks -v   (FUSER_DIR must be a clean worktree at c403e9b)"""
import json, os, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fuserv1_test_v0_tracks as T  # noqa: E402
from reb.writer import write_track, config_hash  # noqa: E402

PIN = {"m": "chunked"}
OLD = {"m": "single"}
DATE, ROOM = "2026-09-25", "room_test"


def _trk(wid, engine, segs, cfg, status="ok"):
    return {"schema": "reb.track.v1", "window_id": wid, "layer": "stt", "engine": engine, "model": "m",
            "version": "1", "config": cfg, "config_hash": config_hash(cfg), "machine": "t", "status": status,
            "reason": None if status == "ok" else "x", "segments": segs}


def _mk(root, wid, kind="dev_clip", sra=PIN, sra_extra=None, whisper=True):
    stub = {"window_id": wid, "room_id": ROOM, "room_slug": "t", "ist_date": DATE, "t0_ms": 0, "t1_ms": 300000,
            "source_kind": kind, "audio": {"r2_key": "x", "sha256": "ab" * 32, "sample_rate": 16000,
                                           "duration_ms": 300000}}
    segs = [{"t0_ms": 0, "t1_ms": 3000, "text": "मेट फ़ॉर्म इन फाइव हंड्रेड मिलीग्राम आफ़्टर फ़ूड"}]
    for cfg, st in (sra_extra or []):
        write_track(root, DATE, ROOM, wid, _trk(wid, "sravaani", segs, cfg, st), manifest_stub=stub)
        stub = None
    write_track(root, DATE, ROOM, wid, _trk(wid, "sravaani", segs, sra, "ok"), manifest_stub=stub)
    if whisper:
        write_track(root, DATE, ROOM, wid, _trk(wid, "whisper-forced-en",
                    [{"t0_ms": 0, "t1_ms": 3000, "text": "Metformin 500 mg after food"}], {}))


class V0Tracks(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="reb-t-v0-")
        self.ids = ["cw-aaa", "cw-bbb"]
        for i in self.ids:
            _mk(self.root, i)
        self.kw = dict(expect_sha=T.fv.FUSER_CODE_SHA, run_log="/nonexistent/run.log")

    def _run(self, ids=None, write=True, pin=config_hash(PIN), n=2, **over):
        kw = {**self.kw, **over}
        return T.run(ids or self.ids, self.root, pin, n, write, out_path=None, **kw)

    def test_dry_run_writes_nothing(self):
        self._run(write=False)
        for i in self.ids:
            w = T.reb_pkg.load_window(i, ist_date=DATE, room_id=ROOM, root=self.root)
            self.assertEqual(w.tracks(layer="fused", latest_ok=False), [])

    def test_write_makes_two_arm_tracks_per_window_and_determinism_holds(self):
        rows = self._run()
        self.assertEqual(len(rows), 4)
        self.assertEqual({r["arm"] for r in rows}, {"etr_on", "etr_off"})
        self.assertTrue(all(r["determinism_ok"] for r in rows))
        self.assertEqual(len({r["config_hash"] for r in rows}), 2)
        w = T.reb_pkg.load_window("cw-aaa", ist_date=DATE, room_id=ROOM, root=self.root)
        self.assertEqual(len(w.tracks(layer="fused", latest_ok=False)), 2)

    def test_rerun_refuses_and_leaves_first_write(self):
        self._run()
        with self.assertRaises(T.Refuse) as c:
            self._run()
        self.assertIn("already exists", str(c.exception))

    def test_wrong_sravaani_pin_refuses_all_writes_nothing(self):
        with self.assertRaises(T.Refuse) as c:
            self._run(pin=config_hash(OLD))
        self.assertIn("!= pinned", str(c.exception))
        w = T.reb_pkg.load_window("cw-aaa", ist_date=DATE, room_id=ROOM, root=self.root)
        self.assertEqual(w.tracks(layer="fused", latest_ok=False), [])

    def test_older_config_only_is_refused(self):
        _mk(self.root, "cw-ccc", sra=OLD)
        with self.assertRaises(T.Refuse):
            self._run(ids=self.ids + ["cw-ccc"], n=3)

    def test_failed_pinned_track_falls_back_to_old_and_is_refused(self):
        root = tempfile.mkdtemp(prefix="reb-t-v0-")
        self.root = root
        _mk(root, "cw-ddd", sra=OLD, sra_extra=[])  # only OLD ok
        with self.assertRaises(T.Refuse):
            self._run(ids=["cw-ddd"], n=1)

    def test_excluded_consult_refused(self):
        _mk(self.root, "cw-vafxdW8k1Nt4tpyOzHQb")
        with self.assertRaises(T.Refuse) as c:
            self._run(ids=self.ids + ["cw-vafxdW8k1Nt4tpyOzHQb"], n=3)
        self.assertIn("excluded", str(c.exception))

    def test_non_dev_clip_and_non_cw_refused(self):
        _mk(self.root, "cw-eee", kind="real")
        _mk(self.root, "L041")
        with self.assertRaises(T.Refuse) as c:
            self._run(ids=self.ids + ["cw-eee", "L041"], n=4)
        self.assertIn("dev_clip", str(c.exception))
        self.assertIn("not a cw-*", str(c.exception))

    def test_wrong_count_refused(self):
        with self.assertRaises(T.Refuse):
            self._run(n=23)

    def test_v1_run_log_present_refuses(self):
        p = os.path.join(self.root, "run.log")
        open(p, "w").write("started\n")
        with self.assertRaises(T.Refuse) as c:
            self._run(run_log=p)
        self.assertIn("before v1 starts", str(c.exception))

    def test_wrong_fuser_sha_refuses(self):
        with self.assertRaises(T.Refuse) as c:
            self._run(expect_sha="0" * 40)
        self.assertIn("code sha", str(c.exception))

    def test_production_default_sha_is_the_witnessed_one(self):
        self.assertEqual(T.EXPECT_FUSER_SHA, "c403e9b6a8f1f2b35c9197fe11f8bd369020d89c")
        self.assertEqual(T.EXCLUDED, {"cw-vafxdW8k1Nt4tpyOzHQb"})


if __name__ == "__main__":
    unittest.main()
