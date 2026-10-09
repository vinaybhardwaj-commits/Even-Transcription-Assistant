"""m3-08: consult_zero_ratio / voice_isolated / gating_source tags and the retro-tag tool."""
import datetime as dt, json, os, subprocess, tempfile, unittest
import numpy as np
from cutter import config as C, gating as G, store as SO, run as R
IST = G.IST
ep = lambda *a: dt.datetime(*a, tzinfo=IST).timestamp()

def flac(path, zeros_frac, seconds=10):
    n = 16000 * seconds; x = (np.random.default_rng(1).normal(size=n) * 3000).astype("<i2"); x[: int(n * zeros_frac)] = 0
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "-", "-c:a", "flac", path], input=x.tobytes(), check=True)

class Tags(unittest.TestCase):
    def test_rooms(self):
        for s in ("opd-4-suffix-aaaa", "opd-5-suffix-bbbb", "opd-4", "opd-5"): self.assertTrue(G.is_macos26_room(s), s)
        for s in ("opd-1-suffix-cccc", "opd-3-suffix-dddd", "opd-6-suffix-eeee", "opd-7-suffix-ffff", "other-opd-gggg", "opd-40-x", None, ""): self.assertFalse(G.is_macos26_room(s), s)
    def test_rule_by_date_and_vi_share(self):
        a = G.tag("opd-5-x", ep(2026, 10, 3, 12, 0), 0.01, 0.0); self.assertEqual((a["voice_isolated"], a["gating_source"], a["consult_zero_ratio"], a["vi_frame_share"]), (True, "macos26_voice_isolation", 0.01, 0.0))
        self.assertTrue(G.tag("opd-4-x", ep(2026, 10, 1, 0, 0), None)["voice_isolated"]); self.assertTrue(G.tag("opd-4-x", ep(2026, 10, 7, 21, 30), 0.0)["voice_isolated"])         # both bounds inclusive, no measurement needed
        self.assertFalse(G.tag("opd-4-x", ep(2026, 9, 30, 23, 59), 0.1, 0.05)["voice_isolated"]); self.assertFalse(G.tag("opd-4-x", ep(2026, 10, 7, 21, 31), 0.1, 0.05)["voice_isolated"])
        r = G.tag("opd-5-x", ep(2026, 10, 9, 10, 0), 0.0, 0.10); self.assertEqual((r["voice_isolated"], r["gating_source"]), (True, "macos26_voice_isolation"))                  # the fix did not hold: vi share >= 0.10 (the lowest measured isolated clip was 0.137, every other-room clip 0.000)
        self.assertFalse(G.tag("opd-5-x", ep(2026, 10, 9, 10, 0), 0.9, 0.099)["voice_isolated"]); self.assertFalse(G.tag("opd-5-x", ep(2026, 10, 9, 10, 0), 0.9, None)["voice_isolated"])     # the zero ratio alone no longer decides
        o = G.tag("opd-1-x", ep(2026, 10, 3, 12, 0), 0.9, 0.9); self.assertEqual((o["voice_isolated"], o["gating_source"]), (False, None))                                      # other rooms are never tagged
    def test_vi_frame_share_matches_the_audio13_definition(self):
        d = tempfile.mkdtemp(); rng = np.random.default_rng(5); sp = (rng.normal(size=48000 * 3) * 3000).astype("<i2"); gate = rng.integers(-1, 2, size=48000 * 7).astype("<i2")        # 3 s speech, 7 s gated (|s| <= 1)
        x = np.concatenate([sp, gate]); open(f"{d}/a.raw", "wb").write(x.tobytes())
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", f"{d}/a.raw", "-c:a", "pcm_s16le", f"{d}/a.wav"], check=True)
        vi, sp_share, n = G.vi_frame_share(f"{d}/a.wav"); self.assertAlmostEqual(vi, 0.7, delta=0.01); self.assertAlmostEqual(sp_share, 0.3, delta=0.01); self.assertEqual(n, 500)
        vi2, _, n2 = G.vi_frame_share(f"{d}/a.wav", coverage=0.5); self.assertAlmostEqual(vi2, 0.4, delta=0.01); self.assertEqual(n2, 250)                                   # the zero-filled half is taken out of both counts
        self.assertEqual(G.vi_frame_share(f"{d}/missing.wav"), (None, None, 0)); quiet = (rng.normal(size=48000 * 2) * 100).astype("<i2"); open(f"{d}/q.raw", "wb").write(quiet.tobytes())
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", f"{d}/q.raw", "-c:a", "pcm_s16le", f"{d}/q.wav"], check=True); self.assertEqual(G.vi_frame_share(f"{d}/q.wav")[0], 0.0)      # quiet room noise (peak > 65) is not gated
    def test_zero_ratio_of_a_real_flac(self):
        d = tempfile.mkdtemp(); flac(f"{d}/a.flac", 0.6); flac(f"{d}/b.flac", 0.0)
        self.assertAlmostEqual(G.zero_ratio(f"{d}/a.flac"), 0.6, delta=0.01); self.assertLess(G.zero_ratio(f"{d}/b.flac"), 0.001); self.assertIsNone(G.zero_ratio(f"{d}/missing.flac"))

class Retro(unittest.TestCase):
    def setUp(self):
        from unittest import mock
        self.root = tempfile.mkdtemp(); C.CLIPS = f"{self.root}/clips"; C.INDEX = f"{C.CLIPS}/index.jsonl"
        p = mock.patch.object(C, "RUN_LOCK", f"{self.root}/cutter.lock"); p.start(); self.addCleanup(p.stop)              # never the live lock
        from tools import retro_tag as RT
        self.RT = RT
        for a in ((RT, "vi_for_row", lambda row, by, wd: (0.9, 0.1, 100)), (RT.T, "load_manifest", lambda *a, **k: {})):
            q = mock.patch.object(*a); q.start(); self.addCleanup(q.stop)
    def clip(self, uid, room="opd-5-x", **extra):
        rel = f"2026-10-03/{room}/{uid}"; d = f"{C.CLIPS}/{rel}"; os.makedirs(d, mode=0o700); flac(f"{d}/consult.flac", 0.7); json.dump(dict(consult_uid=uid), open(f"{d}/timeline.json", "w"))
        SO.append_index(dict(consult_uid=uid, status="cut", room_slug=room, path=rel, span_start="2026-10-03T12:00:00+05:30", ist_date="2026-10-03", **extra)); return d
    def test_apply_refuses_while_the_run_lock_is_held_and_changes_nothing(self):
        d = self.clip("u1"); before = open(C.INDEX).read(); held = R.acquire_run_lock(); self.assertIsNotNone(held)                                      # the hourly run / a backfill
        try: rc = self.RT.main(["--apply"])
        finally: held.close()
        self.assertEqual(rc, 2); self.assertEqual(open(C.INDEX).read(), before); self.assertNotIn("voice_isolated", json.load(open(f"{d}/timeline.json")))
        self.assertEqual(self.RT.main(["--apply"]), 0); self.assertEqual(len(open(C.INDEX).read().splitlines()), 2)                                      # lock free: applies
        self.assertIsNotNone(R.acquire_run_lock())                                                                                                     # and the lock is released when main returns
    def test_dry_run_does_not_need_the_lock(self):
        self.clip("u1"); held = R.acquire_run_lock()
        try: self.assertEqual(self.RT.main([]), 0)
        finally: held.close()
    def test_a_rerun_appends_nothing_and_rows_with_tags_are_skipped(self):
        self.clip("u1"); self.clip("u2", voice_isolated=False, gating_source=None); self.clip("u3", room="opd-4-y", gating_source="macos26_voice_isolation")
        self.RT.main(["--apply"]); after1 = open(C.INDEX).read().splitlines(); self.assertEqual(len(after1), 3 + 1)                                        # only u1 got a new row
        self.RT.main(["--apply"]); self.RT.main(["--apply"]); self.assertEqual(open(C.INDEX).read().splitlines(), after1)                                 # re-runs append nothing
        idx = SO.read_index(); self.assertTrue(idx["u1"]["voice_isolated"]); self.assertFalse(idx["u2"]["voice_isolated"]); self.assertNotIn("voice_isolated", idx["u3"])        # untouched rows keep their own state
    def test_timeline_that_already_has_tags_is_not_rewritten(self):
        d = self.clip("u1"); json.dump(dict(consult_uid="u1", voice_isolated=False, marker="fresh cut"), open(f"{d}/timeline.json", "w"))
        self.RT.main(["--apply"]); self.assertEqual(json.load(open(f"{d}/timeline.json")), dict(consult_uid="u1", voice_isolated=False, marker="fresh cut")); self.assertEqual(len(open(C.INDEX).read().splitlines()), 1)
    def test_naive_ist_strings_are_read_as_ist(self):
        self.assertEqual(G.parse_ist("2026-10-03 12:00:00.500"), G.parse_ist("2026-10-03T12:00:00.500+05:30")); self.assertEqual(G.parse_ist("2026-10-03T06:30:00+00:00"), G.parse_ist("2026-10-03T12:00:00+05:30"))
    def test_dry_run_writes_nothing_and_apply_appends_rows_and_updates_timeline(self):
        root = tempfile.mkdtemp(); C.CLIPS = f"{root}/clips"; C.INDEX = f"{C.CLIPS}/index.jsonl"; rel = "2026-10-03/opd-5-x/u1"; d = f"{C.CLIPS}/{rel}"; os.makedirs(d, mode=0o700)
        flac(f"{d}/consult.flac", 0.7); json.dump(dict(consult_uid="u1", note="kept"), open(f"{d}/timeline.json", "w"))
        SO.append_index(dict(consult_uid="u1", status="cut", room_slug="opd-5-x", path=rel, span_start="2026-10-03T12:00:00+05:30", ist_date="2026-10-03"))
        SO.append_index(dict(consult_uid="u2", status="cut", room_slug="opd-1-x", path="x", span_start="2026-10-03T12:00:00+05:30", ist_date="2026-10-03"))
        from tools import retro_tag as RT
        from unittest import mock
        [(lambda p: (p.start(), self.addCleanup(p.stop)))(mock.patch.object(*a)) for a in ((RT, "vi_for_row", lambda row, by, wd: (0.9, 0.1, 100)), (RT.T, "load_manifest", lambda *a, **k: {}))]      # no tape in this test
        before = open(C.INDEX).read(); RT.main([]); self.assertEqual(open(C.INDEX).read(), before); self.assertNotIn("voice_isolated", json.load(open(f"{d}/timeline.json")))
        RT.main(["--apply"]); lines = open(C.INDEX).read().splitlines(); self.assertEqual(len(lines), 3); self.assertTrue(open(C.INDEX).read().startswith(before))      # append-only
        row = SO.read_index()["u1"]; self.assertEqual((row["voice_isolated"], row["gating_source"]), (True, "macos26_voice_isolation")); self.assertAlmostEqual(row["consult_zero_ratio"], 0.7, delta=0.01); self.assertEqual(row["vi_frame_share"], 0.9)
        tl = json.load(open(f"{d}/timeline.json")); self.assertEqual((tl["note"], tl["voice_isolated"]), ("kept", True)); self.assertEqual(oct(os.stat(f"{d}/timeline.json").st_mode & 0o777), "0o600"); self.assertNotIn("voice_isolated", SO.read_index()["u2"])
