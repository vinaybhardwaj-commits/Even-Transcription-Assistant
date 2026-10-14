"""Offline tests for tape_stats.py: numbers only, per-second RMS/peak of a synthetic chunk."""
import json, math, os, random, shutil, subprocess, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tape_stats as T

SR = T.SR


def pcm(seconds, sigma, seed=1, amp_at=None):
    r = random.Random(seed)
    vals = [int(max(-1, min(1, r.gauss(0, sigma))) * 32767) for _ in range(seconds * SR)]
    return b"".join(v.to_bytes(2, "little", signed=True) for v in vals)


class Stats(unittest.TestCase):
    def test_per_second_rms_and_peak(self):
        rms, peak, zero = T.per_second(pcm(5, 0.01))
        self.assertEqual(len(rms), 5)
        self.assertTrue(all(abs(r - 0.01) < 0.001 for r in rms))
        self.assertTrue(all(0.03 < p < 0.06 for p in peak))
        self.assertEqual(zero, 0)

    def test_exact_zero_seconds_are_counted(self):
        rms, peak, zero = T.per_second(bytes(2 * SR * 3) + pcm(2, 0.01))
        self.assertEqual((len(rms), zero), (5, 3))
        self.assertEqual(rms[:3], [0.0, 0.0, 0.0])

    def test_a_partial_last_second_is_ignored(self):
        self.assertEqual(len(T.per_second(pcm(2, 0.01) + bytes(2 * 8000))[0]), 2)

    def test_the_record_is_numbers_and_ids_only(self):
        rec = T.chunk_record(dict(room_id="room_x", started_at="2026-09-25T03:14:47Z", idx=3, path="secret/path.webm", sha256="abc"), pcm(3, 0.01))
        self.assertEqual(set(rec), {"room_id", "started_at", "idx", "seconds", "rms", "peak", "exact_zero_seconds"})
        self.assertNotIn("path", json.dumps(rec))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_decode_and_main_end_to_end_on_a_tiny_synthetic_chunk(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        raw = os.path.join(d, "x.raw")
        with open(raw, "wb") as f:
            f.write(pcm(3, 0.02))
        os.makedirs(os.path.join(d, "room_x", "2026-09-25"))
        webm = os.path.join(d, "room_x", "2026-09-25", "c0.webm")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", raw, "-c:a", "libopus", webm], check=True)
        with open(os.path.join(d, "manifest.jsonl"), "w") as f:
            f.write(json.dumps(dict(room_id="room_x", started_at="2026-09-25T03:14:47Z", idx=0, path="room_x/2026-09-25/c0.webm")) + "\n")
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(T.main([d]), 0)
        rec = json.loads(buf.getvalue().splitlines()[0])
        self.assertEqual(rec["room_id"], "room_x")
        self.assertGreaterEqual(rec["seconds"], 2)
        self.assertTrue(all(0.01 < r < 0.04 for r in rec["rms"][:2]))


if __name__ == "__main__":
    unittest.main()
