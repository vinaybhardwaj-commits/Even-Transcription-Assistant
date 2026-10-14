"""m3-05: digital silence is skipped before the GPU (silent_audio, final); loudnorm's -inf no longer crashes the store; the worker's per-segment ECAPA guard."""
import os, subprocess, tempfile, unittest
from cutter import config as C, store as SO, tape as T

def tone(path, seconds=6, silent=False):
    src = "anullsrc=r=16000:cl=mono" if silent else "sine=frequency=300:sample_rate=16000"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", src, "-t", str(seconds), "-ac", "1", path], check=True)

class Silence(unittest.TestCase):
    def test_is_silent(self):
        d = tempfile.mkdtemp(); tone(f"{d}/s.wav", silent=True); tone(f"{d}/t.wav")
        self.assertEqual(T.loudness(f"{d}/s.wav"), "-inf"); self.assertEqual(T.is_silent(f"{d}/s.wav"), (True, "-inf")); sil, v = T.is_silent(f"{d}/t.wav"); self.assertFalse(sil); self.assertTrue(-40 < v < -10)
    def test_normalize_does_not_crash_on_silence(self):
        d = tempfile.mkdtemp(); tone(f"{d}/s.wav", silent=True); tone(f"{d}/t.wav")
        self.assertFalse(SO.normalize(["-i", f"{d}/s.wav"], f"{d}/s.flac")); self.assertTrue(os.path.getsize(f"{d}/s.flac") > 0)         # kept as it is, no exception
        self.assertTrue(SO.normalize(["-i", f"{d}/t.wav"], f"{d}/t.flac")); self.assertLess(abs(T.loudness(f"{d}/t.flac") + 18), 1.5)
    def test_worker_segment_guard(self):
        from cutter import diar_worker as DW
        def tiny(*a): raise RuntimeError("Padding size should be less than the corresponding input dimension")
        self.assertIsNone(DW.safe(tiny, 1, 2)); self.assertEqual(DW.safe(lambda a, b: a + b, 1, 2), 3)
        with self.assertRaises(ValueError): DW.safe(lambda: (_ for _ in ()).throw(ValueError("other errors still surface")))
