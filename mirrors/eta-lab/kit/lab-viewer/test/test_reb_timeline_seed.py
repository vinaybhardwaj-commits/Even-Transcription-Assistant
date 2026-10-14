"""reb_timeline_seed.py: aggregates REB engine tracks across a whole room-day into the named lanes (Fable's
28 Sep overnight order), using kit.reb's REAL load_window()/tracks(latest_ok=True) selection - not a reimplementation.
Synthetic REB_ROOT only. Run: python3 kit/lab-viewer/test/test_reb_timeline_seed.py"""
import importlib.util, json, os, shutil, sys, tempfile, unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"


NOT_HELD = lambda day, room: False


def load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def write_window(root, date, room, wid, t0_ms, t1_ms, tracks, source_kind="room_tape", configs=None):
    """tracks: [(layer, engine, config_hash, status, segments)] - segments: [(t0_ms, t1_ms, text)]."""
    d = Path(root) / date / room / wid; (d / "tracks").mkdir(parents=True, exist_ok=True)
    entries = []
    for layer, engine, cfg, status, segs in tracks:
        fname = f"{layer}.{engine}__v1__{cfg}.json"
        body = {"schema": "reb.track.v1", "window_id": wid, "layer": layer, "engine": engine, "model": "m", "version": "v1",
                "config": (configs or {}).get(cfg, {}), "config_hash": cfg, "machine": "box", "status": status,
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
            ("fused", "fuser", "iii99999", "ok", [(0, 4000, "should not appear - not one of the named lanes")]),
            ("stt", "koyal", "k1hi0000", "ok", [(0, 2000, "koyal hindi")]),
            ("stt", "koyal", "k2kn0000", "ok", [(0, 2000, "koyal kannada")]),
            ("stt", "koyal", "k3te0000", "empty", []),
            ("stt", "koyal", "k4xx0000", "ok", [(0, 2000, "koyal unknown prompt lang")]),
        ], configs={"k1hi0000": {"lang": "hi-IN"}, "k2kn0000": {"lang": "kn-IN"}, "k3te0000": {"lang": "te-IN"}, "k4xx0000": {"lang": "ta-IN"}})
        # window 2: a dev_clip window (clip-local segments, real writer inconsistency per eta-refuter-2 #5266 F2) - offset by t0_ms
        write_window(self.root, "2026-09-26", "room_x", "w2", 1790500100000, 1790500110000, [
            ("stt", "sravaani", "jjj00000", "ok", [(0, 2000, "clip local text")]),
        ], source_kind="dev_clip")

        lanes, n_windows, n_tracks, _ = m.build_reb_lanes(str(self.root), "2026-09-26", "room_x", NOT_HELD)
        self.assertEqual(n_windows, 2)
        self.assertEqual(len(lanes["whisper"]), 2)   # whisper-auto + whisper-forced-en merged into one lane
        self.assertEqual({s["engine"] for s in lanes["whisper"]}, {"whisper-auto", "whisper-forced-en"})
        self.assertEqual(len(lanes["indic"]), 1); self.assertEqual(lanes["indic"][0]["text"], "kn line")   # the empty hi track contributed nothing
        self.assertEqual(len(lanes["medmodel"]), 0); self.assertEqual(len(lanes["medasr"]), 1)   # terms.medasr is NOT aliased into the Medical model row
        self.assertEqual(m.lane_of({"layer": "stt", "engine": "medasr"}), "medmodel"); self.assertEqual(m.lane_of({"layer": "terms", "engine": "medasr"}), "medasr"); self.assertEqual(len(lanes["diar"]), 1)
        self.assertEqual(len(lanes["acoustic"]), 1); self.assertEqual(len(lanes["tone"]), 1)
        self.assertIn("translate", lanes); self.assertEqual(lanes["translate"], [])   # no translate track yet -> the lane exists and is empty (page says "Not yet produced")
        self.assertEqual(m.lane_of({"layer": "translate", "engine": "x"}), "translate")
        self.assertEqual(m.lane_of({"layer": "stt", "engine": "indic-conformer"}), "indic")   # the real box-lane engine name (26 Sep store)
        self.assertEqual([x["text"] for x in lanes["koyal_hi"]], ["koyal hindi"]); self.assertEqual([x["text"] for x in lanes["koyal_kn"]], ["koyal kannada"])
        self.assertEqual(lanes["koyal_ml"], []); self.assertEqual(lanes["koyal_te"], [])   # te was empty; ta-IN is not a Koyal language and is shown nowhere
        self.assertNotIn("fused", lanes)   # only the named lanes exist at all
        self.assertEqual(sum(len(v) for v in lanes.values()), 10)   # +2 koyal (hi, kn)
        _ = 0   # 2(whisper)+1(indic)+1(medasr)+1(diar)+1(acoustic)+1(tone)+1(sravaani, window 2); fused's segment never counted anywhere
        # the dev_clip window's clip-local segment was offset into the absolute frame (F2 fix carried into Python)
        self.assertEqual(lanes["sravaani"][0]["t0_ms"], 1790500100000)
        self.assertEqual(lanes["sravaani"][0]["t1_ms"], 1790500102000)
        # window 1's clip-local room_tape segments land at t0
        self.assertEqual(lanes["whisper"][0]["t0_ms"], 1790500000000)

    def test_capped_lane_records_total_and_until(self):
        m = load("reb_timeline_seed")
        m.LANE_CAP = 3; self.addCleanup(setattr, m, "LANE_CAP", 2000)
        segs = [(i * 1000, i * 1000 + 500, f"s{i}") for i in range(5)]
        write_window(self.root, "2026-09-26", "room_x", "w1", 1790500000000, 1790500030000, [("stt", "whisper-auto", "aaa11111", "ok", segs)])
        lanes, _, _, _ = m.build_reb_lanes(str(self.root), "2026-09-26", "room_x", NOT_HELD)
        self.assertEqual(len(lanes["whisper"]), 3)
        self.assertEqual(lanes.capped["whisper"]["n_total"], 5)
        self.assertEqual(lanes.capped["whisper"]["until_ms"], lanes["whisper"][-1]["t1_ms"])
        self.assertNotIn("indic", lanes.capped)
        self.assertTrue(lanes.capped["whisper"]["full"]); self.assertEqual(len(lanes.full["whisper"]), 5)   # the uncapped lane goes to its own object
        out = Path(tempfile.mkdtemp())
        m.write_lane_objects(out, "room_x", "2026-09-26", lanes)
        f = out / "timeline-lanes/room_x/2026-09-26/whisper.json"
        self.assertEqual(len(json.loads(f.read_text())), 5); self.assertEqual(oct(f.stat().st_mode & 0o777), "0o600")
        self.assertEqual([p.name for p in f.parent.iterdir()], ["whisper.json"])   # only capped lanes get an object

    def test_room_tape_outlier_is_dropped_or_clamped_not_window_flipping(self):
        m = load("reb_timeline_seed")
        t0 = 1790500000000
        write_window(self.root, "2026-09-26", "room_x", "w1", t0, t0 + 30000, [
            ("stt", "whisper-auto", "aaa11111", "ok", [(1000, 2000, "fine"), (28000, 31500, "padded to chunk end"),
                                                       (t0 + 500, t0 + 900, "absolute epoch outlier"), (90000, 95000, "way past end"), (30500, 32000, "starts after end")]),
        ])
        lanes, _, _, _ = m.build_reb_lanes(str(self.root), "2026-09-26", "room_x", NOT_HELD)
        got = [(s["t0_ms"], s["t1_ms"], s["text"]) for s in lanes["whisper"]]
        self.assertEqual(got, [(t0 + 1000, t0 + 2000, "fine"), (t0 + 28000, t0 + 30000, "padded to chunk end")])

    def test_a_malformed_window_is_skipped_not_fatal(self):
        m = load("reb_timeline_seed")
        write_window(self.root, "2026-09-26", "room_x", "w1", 1790500000000, 1790500030000,
                     [("stt", "whisper-auto", "aaa11111", "ok", [(0, 4000, "ok window")])])
        bad = self.root / "2026-09-26" / "room_x" / "w2"; (bad / "tracks").mkdir(parents=True)
        (bad / "manifest.json").write_text("{not json")
        lanes, n_windows, n_tracks, _ = m.build_reb_lanes(str(self.root), "2026-09-26", "room_x", NOT_HELD)
        self.assertEqual(n_windows, 1)   # the broken window is skipped, not fatal to the good one
        self.assertEqual(len(lanes["whisper"]), 1)

    def test_a_sealed_window_never_reaches_any_lane_even_when_its_files_are_live(self):
        """lid-debug's 4 clips stay sealed after the held-out lift (gating-lead #10998): a window with one of those ids is skipped BEFORE its manifest is opened."""
        m = load("reb_timeline_seed")
        for wid in ("L041", "L057", "L139", "L182"):
            write_window(self.root, "2026-09-26", "room_x", wid, 1790500000000, 1790500030000,
                         [("stt", "whisper-auto", "aaa11111", "ok", [(0, 4000, "SEALEDTEXT")]), ("acoustics", "vad", "bbb22222", "ok", [(0, 4000, "")])])
        write_window(self.root, "2026-09-26", "room_x", "w1", 1790500100000, 1790500130000,
                     [("stt", "whisper-auto", "aaa11111", "ok", [(0, 4000, "open window")])])
        lanes, n_windows, n_tracks, n_held = m.build_reb_lanes(str(self.root), "2026-09-26", "room_x", NOT_HELD)
        self.assertEqual(lanes.sealed, 4)
        self.assertEqual((n_windows, n_tracks, n_held), (1, 1, 0))          # only the open window is counted
        self.assertEqual([x["text"] for x in lanes["whisper"]], ["open window"])
        self.assertEqual(lanes["acoustic"], [])
        self.assertNotIn("SEALEDTEXT", json.dumps(dict(lanes)))

    def test_the_sealed_set_is_the_shared_one_and_holds_exactly_the_four_ids(self):
        m = load("reb_timeline_seed")
        self.assertEqual(sorted(m.SEALED_WINDOWS), ["L041", "L057", "L139", "L182"])
        sys.path.insert(0, str(TOOLS.parents[1]))
        from reb import from_hist
        self.assertIs(m.SEALED_WINDOWS, from_hist.SEALED_WINDOWS)

    def test_no_windows_for_this_room_day_is_empty_not_an_error(self):
        m = load("reb_timeline_seed")
        lanes, n_windows, n_tracks, _ = m.build_reb_lanes(str(self.root), "2026-09-26", "room_x", NOT_HELD)
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
        self.assertEqual(set(doc.keys()), {"reb", "reb_cap", "reb_excluded", "reb_eos"})   # never touches pqm_truth/cap_links/etc - those aren't this script's job
        self.assertEqual(len(doc["reb"]["whisper"]), 1)
        import stat
        self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(p.parent.stat().st_mode), 0o700)


    def test_r3w51_guard_skips_held_windows_before_any_text(self):
        import datetime
        m = load("reb_timeline_seed")
        ist = lambda y, mo, d, h, mi=0, sec=0: int(datetime.datetime(y, mo, d, h, mi, sec, tzinfo=m.IST).timestamp() * 1000)
        held = lambda day, room: (day, room) == ("2026-09-26", "room_x")
        seg = [("stt", "whisper-auto", "aaa11111", "ok", [(0, 4000, "SECRETWORDS")])]
        # blind day window: no segments, no text
        write_window(self.root, "2026-09-25", "room_x", "wb", ist(2026, 9, 26, 9), ist(2026, 9, 26, 9, 15), seg)
        # ends exactly at 00:00 of the blind day (end exclusive): the IST day of end-1s is 25 Sep -> clean, kept
        write_window(self.root, "2026-09-25", "room_x", "wc", ist(2026, 9, 25, 23, 45), ist(2026, 9, 26, 0, 0), [("stt", "whisper-auto", "aaa11111", "ok", [(0, 4000, "openwords")])])
        # starts on 25 Sep but ends 1 s into the blind day: held
        write_window(self.root, "2026-09-25", "room_x", "wd", ist(2026, 9, 25, 23, 45), ist(2026, 9, 26, 0, 0, 1), seg)
        lanes, n_windows, n_tracks, n_held = m.build_reb_lanes(str(self.root), "2026-09-25", "room_x", held)
        self.assertEqual((n_windows, n_held), (1, 2))
        self.assertNotIn("SECRET", json.dumps(lanes)); self.assertIn("openwords", json.dumps(lanes))
        # the whole room-day blind: nothing is read
        lanes2, nw2, nt2, nh2 = m.build_reb_lanes(str(self.root), "2026-09-25", "room_x", lambda d, r: True)
        self.assertEqual((nw2, nt2, nh2), (0, 0, 3)); self.assertTrue(all(v == [] for v in lanes2.values()))

    def test_r3w51_guard_fails_closed_and_unusable_times_are_held(self):
        m = load("reb_timeline_seed")
        with self.assertRaises(SystemExit):
            m.load_heldout(str(self.root / "missing_heldout.py"))
        self.assertTrue(m.window_held(lambda d, r: False, "room_x", None, 5))
        self.assertTrue(m.window_held(lambda d, r: False, "room_x", float("nan"), 5))

    def test_r3w51_real_predicate_holds_nothing_after_the_lift(self):
        """V ruling O8 (10 Oct 2026): the held-out list is empty. The shared heldout.py was swapped to sha16 880404e36fd6b650 (empty union) at 14:48; this used to assert that
        the real file held 2026-09-26 room_ux92qpws. It now asserts the lifted state: the real loader still loads (fail-closed on a bad file) and holds none of the former 14 pairs."""
        m = load("reb_timeline_seed")
        if not os.path.exists(m.HELDOUT_PY):
            self.skipTest("shared heldout.py not on this box")
        is_held = m.load_heldout()
        for day, room in [("2026-09-26", "room_ux92qpws"), ("2026-09-23", "room_4ggnkg5x"), ("2026-08-23", "room_qyzghzaf"), ("2026-09-16", "room_ux92qpws"), ("2026-09-26", "room_d74hhmc4")]:
            self.assertFalse(is_held(day, room), f"{day} {room}")


    def test_suspect_medasr_track_stays_out_of_the_lane_end_to_end(self):
        m = load("reb_timeline_seed")
        write_window(self.root, "2026-09-26", "room_x", "w1", 1790500000000, 1790500030000, [
            ("stt", "medasr", "e2b69f8a", "ok", [(0, 30000, "</s>")]),
            ("stt", "whisper-auto", "aaa11111", "ok", [(0, 4000, "hello")]),
        ])
        lanes = m.build_reb_lanes(self.root, "2026-09-26", "room_x", is_held=lambda d, r: False)[0]
        self.assertEqual(lanes["medmodel"], [])
        self.assertEqual(len(lanes["whisper"]), 1)
        self.assertEqual(lanes.excluded, {"medmodel": {"n_tracks": 1, "reason": "SUSPECT e2b69f8a (30 s chunking)"}})   # recorded, so the viewer can say why the row is empty

    def test_eos_only_chunks_are_dropped_before_the_cap_and_counted(self):
        m = load("reb_timeline_seed")
        m.LANE_CAP = 3
        try:
            segs = [(i * 1000, i * 1000 + 1000, "</s>") for i in range(20)] + [(21000, 22000, "chest pain </s>"), (22000, 23000, "real words")]
            write_window(self.root, "2026-09-26", "room_x", "w1", 1790500000000, 1790500030000, [("stt", "medasr", "12c9d3d0", "ok", segs)], source_kind="dev_clip")
            lanes = m.build_reb_lanes(self.root, "2026-09-26", "room_x", is_held=lambda d, r: False)[0]
            self.assertEqual(len(lanes["medmodel"]), 2)                                  # 22 chunks, 20 EOS-only: 2 kept, NOT capped at 3
            self.assertEqual(lanes.capped, {})
            self.assertEqual(lanes.eos, {"medmodel": {"eos": 20, "kept": 2}})
            self.assertEqual(lanes["medmodel"][0]["text"], "chest pain </s>")             # mixed text is kept as stored; the Worker strips the token
        finally:
            m.LANE_CAP = 2000

    def test_suspect_medasr_v1_is_not_seeded_but_other_versions_are(self):
        m = load("reb_timeline_seed")
        ent = {"layer": "stt", "engine": "medasr"}
        self.assertTrue(m.suspect_medmodel(ent, {"config_hash": "e2b69f8a"}))          # hf-l4-medasr-1, 30 s chunking
        self.assertTrue(m.suspect_medmodel({**ent, "config_hash": "e2b69f8a"}, None))
        self.assertFalse(m.suspect_medmodel(ent, {"config_hash": "abcd1234"}))         # a later config is not blocked by this rule
        self.assertFalse(m.suspect_medmodel({"layer": "terms", "engine": "medasr"}, {"config_hash": "e2b69f8a"}))   # W50 terms.medasr is another lane
        self.assertFalse(m.suspect_medmodel({"layer": "stt", "engine": "whisper-auto"}, {"config_hash": "e2b69f8a"}))
if __name__ == "__main__":
    unittest.main()
