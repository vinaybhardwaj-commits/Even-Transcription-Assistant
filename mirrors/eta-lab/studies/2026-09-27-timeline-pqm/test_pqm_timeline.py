"""Tests for pqm_timeline.py on INVENTED data (no real box data, no network)."""
import json, os, sys, tempfile, unittest
from datetime import datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pqm_timeline as P


def links_file(path, rows):
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


class T(unittest.TestCase):
    def test_unpad_removes_pad_s_each_side(self):
        s_ms, e_ms = P.unpad("2026-09-26T10:44:42+05:30", "2026-09-26T10:50:27+05:30")
        self.assertEqual(e_ms - s_ms, (5 * 60 + 45 - 60) * 1000)          # 5:45 span minus 2*30s pad = 4:45

    def test_confirmed_and_probable_kept_none_and_no_room_dropped(self):
        d = tempfile.mkdtemp()
        links_file(d + "/links.jsonl", [
            dict(consult_id="a", status="confirmed", room="room_x", span=["2026-09-25T09:00:00+05:30", "2026-09-25T09:05:00+05:30"]),
            dict(consult_id="b", status="probable", room="room_y", span=["2026-09-25T10:00:00+05:30", "2026-09-25T10:05:00+05:30"]),
            dict(consult_id="c", status="none", room=None, span=["2026-09-25T11:00:00+05:30", "2026-09-25T11:05:00+05:30"]),
            dict(consult_id="d", status="confirmed", room=None, span=["2026-09-25T12:00:00+05:30", "2026-09-25T12:05:00+05:30"]),   # confirmed but no room: dropped
        ])
        json.dump(dict(a="1", b="2"), open(d + "/tokens.json", "w"))       # c, d never looked up: no display_id needed
        out = d + "/out"
        import subprocess, sys as _s
        r = subprocess.run([_s.executable, os.path.join(os.path.dirname(__file__), "pqm_timeline.py"),
                             "--day", "2026-09-25", "--links", d + "/links.jsonl", "--tokens", d + "/tokens.json", "--out", out],
                            capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        got = json.loads(r.stdout)
        self.assertEqual(got["rooms_written"], 2)
        self.assertEqual(sorted(got["by_room"]), ["room_x", "room_y"])
        fx = json.load(open(out + "/room_x/2026-09-25.json"))
        self.assertEqual(fx["pqm_truth"], [dict(start_ms=fx["pqm_truth"][0]["start_ms"], end_ms=fx["pqm_truth"][0]["end_ms"], token="1", status="confirmed", suspect=False)])
        self.assertEqual(oct(os.stat(out + "/room_x").st_mode & 0o777), "0o700")
        self.assertEqual(oct(os.stat(out + "/room_x/2026-09-25.json").st_mode & 0o777), "0o600")

    def test_suspect_flags_an_exact_3600s_duration_only(self):
        """Fable 15:18 / surg-link: an EXACT 3600s called->completed span is a PQM auto-timeout artifact, not a real consult.
        span in links.jsonl is ALREADY padded by cap_link's +/-30s (P.PAD_S), so a raw called->completed gap of N seconds
        is a span of N+60 seconds - build spans from the RAW gap via timedelta, not by eyeballing clock strings."""
        d = tempfile.mkdtemp()
        base = datetime.fromisoformat("2026-09-25T09:00:00+05:30")

        def span_for_raw_gap(start_offset_s, raw_gap_s):
            called = base + timedelta(seconds=start_offset_s)
            completed = called + timedelta(seconds=raw_gap_s)
            return [(called - timedelta(seconds=P.PAD_S)).isoformat(), (completed + timedelta(seconds=P.PAD_S)).isoformat()]

        links_file(d + "/links.jsonl", [
            dict(consult_id="timeout", status="confirmed", room="room_x", span=span_for_raw_gap(0, 3600)),        # exactly 3600s -> suspect
            dict(consult_id="near", status="confirmed", room="room_x", span=span_for_raw_gap(10000, 3599)),       # 3599s -> not suspect
            dict(consult_id="over", status="confirmed", room="room_x", span=span_for_raw_gap(20000, 3601)),       # 3601s -> not suspect
        ])
        json.dump(dict(timeout="1", near="2", over="3"), open(d + "/tokens.json", "w"))
        import subprocess, sys as _s
        r = subprocess.run([_s.executable, os.path.join(os.path.dirname(__file__), "pqm_timeline.py"),
                             "--day", "2026-09-25", "--links", d + "/links.jsonl", "--tokens", d + "/tokens.json", "--out", d + "/out"],
                            capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        got = json.loads(r.stdout)
        self.assertEqual(got["suspect_3600s_timeouts"], 1)
        rows = {row["token"]: row["suspect"] for row in json.load(open(d + "/out/room_x/2026-09-25.json"))["pqm_truth"]}
        self.assertEqual(rows, {"1": True, "2": False, "3": False})

    def test_missing_display_id_is_skipped_not_crashed(self):
        d = tempfile.mkdtemp()
        links_file(d + "/links.jsonl", [dict(consult_id="unknown", status="confirmed", room="room_z", span=["2026-09-25T09:00:00+05:30", "2026-09-25T09:05:00+05:30"])])
        json.dump({}, open(d + "/tokens.json", "w"))
        import subprocess, sys as _s
        r = subprocess.run([_s.executable, os.path.join(os.path.dirname(__file__), "pqm_timeline.py"),
                             "--day", "2026-09-25", "--links", d + "/links.jsonl", "--tokens", d + "/tokens.json", "--out", d + "/out"],
                            capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        got = json.loads(r.stdout)
        self.assertEqual(got["rooms_written"], 0)
        self.assertEqual(got["skipped_no_display_id"], 1)


if __name__ == "__main__":
    unittest.main()
