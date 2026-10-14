"""Offline tests for null_real_tape.py: numbers only, seeded, and a chirp-free tape never reaches the threshold."""
import json, os, random, shutil, subprocess, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mic_selftest as M
import null_real_tape as N

SR = M.SR


def fake_decode_factory(seconds=30, sigma=0.01):
    def decode(path):
        r = random.Random(hash(os.path.basename(path)) % 1000)
        return b"".join(int(max(-1, min(1, r.gauss(0, sigma))) * 32767).to_bytes(2, "little", signed=True) for _ in range(seconds * SR))
    return decode


class NullReal(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.d, True)
        os.makedirs(os.path.join(self.d, "room_x"))
        with open(os.path.join(self.d, "room_x", "c0.webm"), "wb") as f:
            f.write(b"x")
        with open(os.path.join(self.d, "manifest.jsonl"), "w") as f:
            f.write(json.dumps(dict(room_id="room_x", started_at="2026-09-25T03:00:00Z", idx=0, path="room_x/c0.webm")) + "\n")

    def test_rows_are_numbers_and_ids_only_and_seeded(self):
        rows = N.run(self.d, 2, 12, 7, decode=fake_decode_factory())
        again = N.run(self.d, 2, 12, 7, decode=fake_decode_factory())
        self.assertEqual(rows, again)                                                 # same seed, same windows
        self.assertEqual(len(rows), 2)
        for r in rows:
            self.assertEqual(set(r), {"room_id", "started_at", "offset_s", "rms", "ncc_peak"})
            self.assertNotIn("path", json.dumps(r))
            self.assertLess(r["ncc_peak"], M.NCC_THRESHOLD)                          # noise only: no false positive

    def test_summary_counts_at_or_above_the_threshold(self):
        rows = [dict(ncc_peak=0.01), dict(ncc_peak=0.02), dict(ncc_peak=0.2)]
        s = N.summarise(rows)
        self.assertEqual((s["n"], s["max"], s["at_or_above_threshold"]), (3, 0.2, 1))
        self.assertLess(s["margin_to_threshold"], 0)

    def test_a_reference_in_the_window_is_found_so_the_measure_can_see_it(self):
        ref = M.make_reference()
        r = random.Random(3)
        x = [r.gauss(0, 0.01) for _ in range(12 * SR)]
        for i, v in enumerate(ref):
            x[2 * SR + i] += v * 0.05
        pcm = b"".join(int(max(-1, min(1, v)) * 32767).to_bytes(2, "little", signed=True) for v in x)
        peak, rms = N.window_peak(pcm)
        self.assertGreater(peak, M.NCC_THRESHOLD)

    def test_an_all_zero_window_is_zero_not_an_error(self):
        self.assertEqual(N.window_peak(bytes(2 * 12 * SR)), (0.0, 0.0))

    def test_chunks_shorter_than_the_window_are_skipped(self):
        rows = N.run(self.d, 3, 40, 1, decode=fake_decode_factory(seconds=30))
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
