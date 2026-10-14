"""reb_timeline_seed.py: aggregates REB engine tracks across a whole room-day into the seven named lanes (Fable's
28 Sep overnight order), using kit.reb's REAL load_window()/tracks(latest_ok=True) selection - not a reimplementation.
Synthetic REB_ROOT only. Run: python3 kit/lab-viewer/test/test_reb_timeline_seed.py"""
import importlib.util, json, os, shutil, sys, tempfile, unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"


def load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def write_window(root, date, room, wid, t0_ms, t1_ms, tracks, source_kind="room_tape"):
    """tracks: [(layer, engine, config_hash, status, segments)] - segments: [(t0_ms, t1_ms, text)]."""
    d = Path(root) / date / room / wid; (d / "tracks").mkdir(parents=True, exist_ok=True)
    entries = []
    for layer, engine, cfg, status, segs in tracks:
        fname = f"{layer}.{engine}__v1__{cfg}.json"
        body = {"schema": "reb.track.v1", "window_id": wid, "layer": layer, "engine": engine, "model": "m", "version": "v1",
                "config": {}, "config_hash": cfg, "machine": "box", "status": status,
                "segments": [{"t0_ms": s0, "t1_ms": s1, "text": txt} for s0, s1, txt in segs]}
        (d / "tracks" / fname).write_text(json.dumps(body))
        entries.append({"layer": layer, "engine": engine, "model": "m", "version": "v1", "config_hash": cfg,
                         "machine": "box", "status": status, "reason": None, "started_at": "t", "finished_at": "t2",
                         "path": f"{date}/{room}/{wid}/tracks/{fname}"})
    manifest = {"window_id": wid, "room_id": room, "room_slug": room, "ist_date": date, "t0_ms": t0_ms, "t1_ms": t1_ms,
                "source_kind": source_kind, "audio": {"r2_key": "x", "sha256": "x" * 64, "sample_rate": 16000, "duration_ms": t1_ms - t0_ms},
                "tracks": entries}
    (d / "manifest.json").write_text(json.dumps(manifest))


class RebTimelineSeed(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_lane_grouping_and_absolute_clock(self):
        m = load("reb_timeline_seed")
        # window 1: real room_tape window, clip-local segments (eta-refuter-2 #5692: 54/54 real tracks) - offset by t0
        write_window(self.root, "2026-09-26", "room_x", "w1", 1790500000000, 1790500030000, [
            ("stt", "whisper-auto", "aaa11111", "ok", [(0, 4000, "hello")]),
            ("stt", "whisper-forced-en", "bbb22222", "ok", [(4000, 8000, "world")]),
            ("stt", "indic-ctc-kn", "ccc33333", "ok", [(0, 4000, "kn line")]),
            ("stt", "indic-ctc-hi", "ddd44444", "empty", []),   # empty status: contributes nothing (about what was SAID)
            ("terms", "medasr", "eee55555", "ok", [(0, 30000, "metformin 500mg")]),
            ("diar", "pyannote", "fff66666", "ok", [(0, 30000, "speaker turn")]),
            ("acoustics", "vad_segments", "ggg77777", "ok", [(0, 5000, "")]),
            ("emotion", "wavlm", "hhh88888", "ok", [(0, 30000, "")]),
            ("fused", "fuser", "iii99999", "ok", [(0, 4000, "should not appear - not one of the 7 named lanes")]),
        ])
        # window 2: a dev_clip window (clip-local segments, real writer inconsistency per eta-refuter-2 #5266 F2) - offset by t0_ms
        write_window(self.root, "2026-09-26", "room_x", "w2", 1790500100000, 1790500110000, [
            ("stt", "sravaani", "jjj00000", "ok", [(0, 2000, "clip local text")]),
        ], source_kind="dev_clip")

        lanes, n_windows, n_tracks = m.build_reb_lanes(str(self.root), "2026-09-26", "room_x")
        self.assertEqual(n_windows, 2)
        self.assertEqual(len(lanes["whisper"]), 2)   # whisper-auto + whisper-forced-en merged into one lane
        self.assertEqual({s["engine"] for s in lanes["whisper"]}, {"whisper-auto", "whisper-forced-en"})
        self.assertEqual(len(lanes["indic"]), 1); self.assertEqual(lanes["indic"][0]["text"], "kn line")   # the empty hi track contributed nothing
        self.assertEqual(len(lanes["medasr"]), 1); self.assertEqual(len(lanes["diar"]), 1)
        self.assertEqual(len(lanes["acoustic"]), 1); self.assertEqual(len(lanes["tone"]), 1)
        self.assertNotIn("fused", lanes)   # only the 7 named lanes exist at all
        self.assertEqual(sum(len(v) for v in lanes.values()), 8)   # 2(whisper)+1(indic)+1(medasr)+1(diar)+1(acoustic)+1(tone)+1(sravaani, window 2); fused's segment never counted anywhere
        # the dev_clip window's clip-local segment was offset into the absolute frame (F2 fix carried into Python)
        self.assertEqual(lanes["sravaani"][0]["t0_ms"], 1790500100000)
        self.assertEqual(lanes["sravaani"][0]["t1_ms"], 1790500102000)
        # window 1's clip-local room_tape segments land at t0
        self.assertEqual(lanes["whisper"][0]["t0_ms"], 1790500000000)

    def test_room_tape_outlier_is_dropped_or_clamped_not_window_flipping(self):
        m = load("reb_timeline_seed")
        t0 = 1790500000000
        write_window(self.root, "2026-09-26", "room_x", "w1", t0, t0 + 30000, [
            ("stt", "whisper-auto", "aaa11111", "ok", [(1000, 2000, "fine"), (28000, 31500, "padded to chunk end"),
                                                       (t0 + 500, t0 + 900, "absolute epoch outlier"), (90000, 95000, "way past end"), (30500, 32000, "starts after end")]),
        ])
        lanes, _, _ = m.build_reb_lanes(str(self.root), "2026-09-26", "room_x")
        got = [(s["t0_ms"], s["t1_ms"], s["text"]) for s in lanes["whisper"]]
        self.assertEqual(got, [(t0 + 1000, t0 + 2000, "fine"), (t0 + 28000, t0 + 30000, "padded to chunk end")])

    def test_a_malformed_window_is_skipped_not_fatal(self):
        m = load("reb_timeline_seed")
        write_window(self.root, "2026-09-26", "room_x", "w1", 1790500000000, 1790500030000,
                     [("stt", "whisper-auto", "aaa11111", "ok", [(0, 4000, "ok window")])])
        bad = self.root / "2026-09-26" / "room_x" / "w2"; (bad / "tracks").mkdir(parents=True)
        (bad / "manifest.json").write_text("{not json")
        lanes, n_windows, n_tracks = m.build_reb_lanes(str(self.root), "2026-09-26", "room_x")
        self.assertEqual(n_windows, 1)   # the broken window is skipped, not fatal to the good one
        self.assertEqual(len(lanes["whisper"]), 1)

    def test_no_windows_for_this_room_day_is_empty_not_an_error(self):
        m = load("reb_timeline_seed")
        lanes, n_windows, n_tracks = m.build_reb_lanes(str(self.root), "2026-09-26", "room_x")
        self.assertEqual(n_windows, 0)
        self.assertTrue(all(v == [] for v in lanes.values()))

    def test_cmd_build_writes_private_file_with_reb_key_only(self):
        m = load("reb_timeline_seed")
        write_window(self.root, "2026-09-26", "room_x", "w1", 1790500000000, 1790500030000,
                     [("stt", "whisper-auto", "aaa11111", "ok", [(0, 4000, "hi")])])
        out = self.root / "out"
        a = type("A", (), {"room": "room_x", "date": "2026-09-26", "reb_root": str(self.root), "out": str(out)})()
        m.cmd_build(a)
        p = out / "timeline" / "room_x" / "2026-09-26.reb.json"
        doc = json.loads(p.read_text())
        self.assertEqual(set(doc.keys()), {"reb"})   # never touches pqm_truth/cap_links/etc - those aren't this script's job
        self.assertEqual(len(doc["reb"]["whisper"]), 1)
        import stat
        self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(p.parent.stat().st_mode), 0o700)


if __name__ == "__main__":
    unittest.main()
