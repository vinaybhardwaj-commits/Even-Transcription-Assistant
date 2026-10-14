"""timeline_seed.py: merges lx/acoustics/pqm/cap/fleet's own directories into one timeline/<room>/<date>.json per room-day,
writes 0700/0600 whatever the umask, and IST date derivation / epoch conversion from acoustics' wall-clock ISO. Synthetic inputs only.
Run: python3 kit/lab-viewer/test/test_timeline_seed.py"""
import importlib.util, json, os, shutil, stat, sys, tempfile, unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"


def load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def modes(root):
    bad = []
    for p in [Path(root), *Path(root).rglob("*")]:
        mode = stat.S_IMODE(p.stat().st_mode)
        if mode & 0o077:
            bad.append((str(p), oct(mode)))
    return bad


class TimelineSeed(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp()); self.old = os.umask(0o002)

    def tearDown(self):
        os.umask(self.old); shutil.rmtree(self.t, ignore_errors=True)

    def write(self, rel, obj):
        p = self.t / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(obj)); return p

    def test_merge_and_perms(self):
        m = load("timeline_seed")
        self.write("jev/room_x/2026-09-26.json", {"detected": {"jev_loop": [{"id": "e1", "start_ms": 1000, "end_ms": 2000, "conf": 0.7}]}})
        self.write("pqm/room_x/2026-09-26.json", {"pqm_truth": [{"start_ms": 500, "end_ms": 900, "token": "T-1", "status": "confirmed"}]})
        self.write("cap/room_x/2026-09-26.json", {"cap_links": [{"start_ms": 1, "end_ms": 2, "items": 5, "captured": 3}]})
        self.write("fleet/room_x/2026-09-26.json", {"fleet": [{"kind": "mic_missing", "at_ms": 1, "message": "gone"}]})
        acoustics = {"windows": [{"room": "OPD1", "started_at": "2026-09-26T03:30:00Z", "reference_speech_spans": [{"start_at": "2026-09-26T03:30:00Z", "end_at": "2026-09-26T03:35:00Z"}],
                                  "missed_speech_spans": [{"start_at": "2026-09-26T03:31:00Z", "end_at": "2026-09-26T03:31:30Z"}]}]}
        af = self.write("acoustics.json", acoustics)

        class A: pass
        a = A(); a.jevloop_dir = str(self.t / "jev"); a.pqm_dir = str(self.t / "pqm"); a.cap_dir = str(self.t / "cap"); a.fleet_dir = str(self.t / "fleet")
        a.acoustics_file = str(af); a.acoustics_room = ["OPD1=room_x"]; a.out = str(self.t / "out")
        m.build(a)
        doc = json.loads((self.t / "out" / "timeline" / "room_x" / "2026-09-26.json").read_text())
        self.assertEqual(doc["schema"], 1); self.assertEqual(doc["room_id"], "room_x"); self.assertEqual(doc["date"], "2026-09-26")
        self.assertEqual(doc["detected"]["jev_loop"][0]["id"], "e1")
        self.assertEqual(doc["pqm_truth"][0]["token"], "T-1")
        self.assertEqual(doc["cap_links"][0]["captured"], 3)
        self.assertEqual(doc["fleet"][0]["kind"], "mic_missing")
        self.assertAlmostEqual(doc["acoustics"]["missed_speech_pct"], 10.0)
        self.assertEqual(len(doc["acoustics"]["missed"]), 1)
        self.assertEqual(modes(self.t / "out"), [])

    def test_acoustics_room_not_mapped_is_skipped_not_guessed(self):
        m = load("timeline_seed")
        acoustics = {"windows": [{"room": "Unknown Room", "started_at": "2026-09-26T03:30:00Z", "reference_speech_spans": [{"start_at": "2026-09-26T03:30:00Z", "end_at": "2026-09-26T03:35:00Z"}], "missed_speech_spans": []}]}
        af = self.write("acoustics.json", acoustics)
        result = m.merge_acoustics(str(af), {"OPD1": "room_x"})
        self.assertEqual(result, {})   # a label with no room_map entry contributes nothing, never a guess

    def test_acoustics_own_room_id_used_directly_no_map_needed(self):
        m = load("timeline_seed")
        acoustics = {"windows": [{"room_id": "room_yh3etjpf", "started_at": "2026-09-26T04:48:00.377000Z", "reference_speech_spans": [{"start_at": "2026-09-26T04:48:00.377000Z", "end_at": "2026-09-26T04:53:00.377000Z"}],
                                  "missed_speech_spans": [{"start_at": "2026-09-26T04:49:00Z", "end_at": "2026-09-26T04:49:30Z"}]}]}
        af = self.write("acoustics2.json", acoustics)
        result = m.merge_acoustics(str(af), {})   # no --acoustics-room mapping given at all
        self.assertIn(("room_yh3etjpf", "2026-09-26"), result)
        self.assertAlmostEqual(result[("room_yh3etjpf", "2026-09-26")]["missed_speech_pct"], 10.0)

    def test_acoustics_uses_the_chunks_own_precomputed_totals_and_a_silent_chunk_with_no_reference_speech_still_has_a_date(self):
        m = load("timeline_seed")
        # the real shape from acoustics #4703/#4714: explicit missed_speech_s/reference_speech_s per chunk (not re-summed from
        # spans), and a chunk with EMPTY reference_speech_spans (no speech detected at all) still carries its own date via started_at
        acoustics = {"windows": [
            {"room_id": "room_yh3etjpf", "started_at": "2026-09-25T15:19:47.491Z", "reference_speech_spans": [], "missed_speech_spans": [], "missed_speech_s": 0, "reference_speech_s": 0},
            {"room_id": "room_yh3etjpf", "started_at": "2026-09-25T06:44:47.491Z", "reference_speech_spans": [{"start_at": "2026-09-25T06:44:47Z", "end_at": "2026-09-25T06:44:57Z"}],
             "missed_speech_spans": [{"start_at": "2026-09-25T06:44:50Z", "end_at": "2026-09-25T06:44:51Z"}], "missed_speech_s": 1.0, "reference_speech_s": 10.0},
        ]}
        af = self.write("acoustics3.json", acoustics)
        result = m.merge_acoustics(str(af), {})
        self.assertIn(("room_yh3etjpf", "2026-09-25"), result)               # the zero-speech chunk contributed a date, not nothing
        r = result[("room_yh3etjpf", "2026-09-25")]
        self.assertAlmostEqual(r["missed_speech_pct"], 10.0)                  # 1.0 / 10.0, using the chunks' own totals, not spans re-summed
        self.assertEqual(len(r["missed"]), 1)

    def test_naive_timestamp_without_offset_is_rejected(self):
        m = load("timeline_seed")
        self.assertIsNone(m.iso_ms("2026-09-26T03:30:00"))          # no offset: ambiguous, refused
        self.assertIsNotNone(m.iso_ms("2026-09-26T03:30:00Z"))
        self.assertIsNotNone(m.iso_ms("2026-09-26T09:00:00+05:30"))

    def test_load_refuses_to_replace_and_resume_skips(self):
        m = load("timeline_seed")
        self.write("out/timeline/room_x/2026-09-26.json", {"schema": 1, "room_id": "room_x", "date": "2026-09-26"})
        calls = []
        exists_state = {"v": False}
        m.exists = lambda key: (calls.append(("exists", key)), exists_state["v"])[1]
        m.put = lambda key, path: calls.append(("put", key))

        class A: pass
        a = A(); a.dir = str(self.t / "out"); a.resume = False; a.replace = False
        m.load(a)
        self.assertTrue(any(c[0] == "put" for c in calls))
        exists_state["v"] = True
        calls.clear()
        with self.assertRaises(SystemExit):
            m.load(a)
        a.resume = True
        calls.clear()
        m.load(a)   # --resume skips the existing object instead of refusing
        self.assertFalse(any(c[0] == "put" for c in calls))

    def test_load_replace_archives_the_old_object_before_overwriting(self):
        m = load("timeline_seed")
        self.write("out/timeline/room_x/2026-09-26.json", {"schema": 1, "room_id": "room_x", "date": "2026-09-26", "pqm_truth": [{"start_ms": 1, "end_ms": 2, "token": "1", "status": "confirmed"}]})
        calls = []
        m.exists = lambda key: True   # the object already exists
        m.put = lambda key, path: calls.append(key)
        import subprocess as sp
        old = sp.run

        class Old:
            returncode = 0; stdout = b'{"schema":1,"room_id":"room_x","date":"2026-09-26","pqm_truth":[]}'
        sp.run = lambda *a, **k: Old()
        try:
            class A: pass
            a = A(); a.dir = str(self.t / "out"); a.resume = False; a.replace = True
            m.load(a)
        finally:
            sp.run = old
        self.assertEqual(len(calls), 2)                                          # the archived copy, then the new one
        self.assertTrue(calls[0].startswith("timeline-history/room_x/2026-09-26/"))
        self.assertEqual(calls[1], "timeline/room_x/2026-09-26.json")
        # without --replace, an existing object is still refused (the default stays safe)
        a.replace = False
        calls.clear()
        with self.assertRaises(SystemExit):
            m.load(a)

    def test_exists_treats_only_the_wrangler_not_found_message_as_absent(self):
        m = load("timeline_seed")

        class Ok:
            returncode = 0; stderr = ""
        class NotFound:
            returncode = 1; stderr = "[ERROR] The specified key does not exist.\n"
        class OtherError:
            returncode = 1; stderr = "[ERROR] Authentication error [code: 10000]\n"
        import subprocess as sp
        old = sp.run
        try:
            sp.run = lambda *a, **k: Ok()
            self.assertTrue(m.exists("k"))
            sp.run = lambda *a, **k: NotFound()
            self.assertFalse(m.exists("k"))
            sp.run = lambda *a, **k: OtherError()
            with self.assertRaises(SystemExit):   # refuter-2 #4599 L5: a transient/auth error is never treated as "absent"
                m.exists("k")
        finally:
            sp.run = old


if __name__ == "__main__":
    unittest.main()
