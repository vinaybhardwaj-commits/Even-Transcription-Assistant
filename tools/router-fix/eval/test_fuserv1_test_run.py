#!/usr/bin/env python3
"""Offline tests for fuserv1_test_run.py gates (synthetic REB tree, no API)."""
import hashlib, json, os, sys, tempfile, time, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/tmp/wt-reb-a447dc36/kit")
import fuserv1_test_run as R  # noqa: E402
from reb.writer import write_track, config_hash  # noqa: E402
import eligibility  # noqa: E402

PIN = {"m": "chunked"}; OLD = {"m": "single"}
DATE, ROOM = "2026-09-25", "room_t"
FCFG = {"fuser_code_sha": eligibility.V0_LIB_PIN, "fuser_code_dirty": False,
        "reb_sha": eligibility.REB_LIB_PIN}


def _trk(wid, layer, engine, segs, cfg):
    return {"schema": "reb.track.v1", "window_id": wid, "layer": layer, "engine": engine, "model": "m",
            "version": "1", "config": cfg, "config_hash": config_hash(cfg), "machine": "t", "status": "ok",
            "reason": None, "segments": segs}


def _mk(root, wid, kind="dev_clip", sra=PIN, text="x"):
    stub = {"window_id": wid, "room_id": ROOM, "room_slug": "t", "ist_date": DATE, "t0_ms": 0, "t1_ms": 9000,
            "source_kind": kind, "audio": {"r2_key": "x", "sha256": "ab" * 32, "sample_rate": 16000,
                                           "duration_ms": 9000}}
    write_track(root, DATE, ROOM, wid, _trk(wid, "stt", "sravaani", [{"t0_ms": 0, "t1_ms": 3000, "text": text}], sra),
                manifest_stub=stub)
    rows = {}
    for arm, flag in (("etr_on", True), ("etr_off", False)):
        cfg = {**FCFG, "etr_enabled": flag}
        t = _trk(wid, "fused", "fuser-v0-m6-etr",
                 [{"t0_ms": 0, "t1_ms": 3000, "text": "A"}, {"t0_ms": 3000, "t1_ms": 6000, "text": "B"}], cfg)
        p = write_track(root, DATE, ROOM, wid, t)
        rows[arm] = {"window_id": wid, "arm": arm, "path": p, "config_hash": t["config_hash"], "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest()}
    return rows


class Gate(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(); self.rows = []
        self.ids = ["cw-a", "cw-b"]
        for i in self.ids:
            self.rows += list(_mk(self.root, i).values())
        time.sleep(0.05); self.now = time.time()

    def g(self, ids=None, rows=None, n=2, pin=config_hash(PIN), sha="s", head="s", dirty=False, now=None):
        return R.gate(ids or self.ids, {"tracks": rows if rows is not None else self.rows}, pin, sha, n,
                      self.root, now or self.now, code_head=head, fuserv1_dirty=dirty)

    def test_ok(self):
        self.assertEqual(set(self.g()), set(self.ids))

    def test_wrong_pin(self):
        with self.assertRaises(R.Refuse): self.g(pin=config_hash(OLD))

    def test_empty_sravaani(self):
        _mk(self.root, "cw-c", text="")
        with self.assertRaises(R.Refuse): self.g(ids=self.ids + ["cw-c"], n=3, rows=self.rows + [])

    def test_freeze_sha_and_dirty(self):
        with self.assertRaises(R.Refuse): self.g(head="other")
        with self.assertRaises(R.Refuse): self.g(dirty=True)

    def test_missing_v0_arm(self):
        with self.assertRaises(R.Refuse): self.g(rows=[r for r in self.rows if r["arm"] == "etr_on"])

    def test_sha_mismatch_and_late_mtime(self):
        bad = [dict(r) for r in self.rows]; bad[0]["sha256"] = "0" * 64
        with self.assertRaises(R.Refuse): self.g(rows=bad)
        with self.assertRaises(R.Refuse): self.g(now=os.path.getmtime(self.rows[0]["path"]) - 1)

    def test_excluded_non_cw_non_devclip_count(self):
        for i in ("cw-vafxdW8k1Nt4tpyOzHQb", "L041"):
            with self.assertRaises(R.Refuse): self.g(ids=[i], n=1)
        self.rows += list(_mk(self.root, "cw-r", kind="real").values())
        with self.assertRaises(R.Refuse): self.g(ids=["cw-r"], n=1)
        with self.assertRaises(R.Refuse): self.g(n=23)

    def test_misidentified_row(self):
        bad = [dict(r) for r in self.rows]; bad[0]["config_hash"] = "deadbeef"
        with self.assertRaises(R.Refuse): self.g(rows=bad)
        other = [dict(r) for r in self.rows]
        a = next(r for r in other if r["window_id"] == "cw-a" and r["arm"] == "etr_on")
        b = next(r for r in other if r["window_id"] == "cw-b" and r["arm"] == "etr_on")
        a["path"], a["sha256"], a["config_hash"] = b["path"], b["sha256"], b["config_hash"]
        with self.assertRaises(R.Refuse): self.g(rows=other)

    def test_fallback_text(self):
        tr = json.load(open(self.rows[0]["path"])); tr["config_hash"] = "h"
        res = {"slices": [{"slice": {"t0_ms": 0, "t1_ms": 2000}, "validated": {"outcome": "fallback"}},
                          {"slice": {"t0_ms": 0, "t1_ms": 2000}, "validated": {"outcome": "pass"}},
                          {"slice": {"t0_ms": 2500, "t1_ms": 5000}, "validated": {"outcome": "fallback"}}]}
        fb = R.attach_fallback(res, tr)
        self.assertEqual(set(fb), {"0", "2"}); self.assertEqual(fb["0"]["text"], "A"); self.assertEqual(fb["2"]["text"], "A B")


if __name__ == "__main__":
    unittest.main()
