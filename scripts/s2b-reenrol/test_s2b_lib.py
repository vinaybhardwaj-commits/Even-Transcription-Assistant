"""Unit tests for s2b_lib. Pure: no Mini, no database. Run: python3 -m unittest scripts/s2b-reenrol/test_s2b_lib.py"""
import base64, json, math, os, struct, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import s2b_lib as L


def vec(seed: int):
    return [math.sin(seed * 0.37 + i * 0.11) * 3.0 for i in range(L.DIM)]


class Wire(unittest.TestCase):
    def test_bytes_are_le_float32_768(self):
        b = base64.b64decode(L.encode_emb(vec(1)))
        self.assertEqual(len(b), 768)
        self.assertEqual(b, struct.pack("<192f", *vec(1)))   # numpy '<f4'.tobytes() layout

    def test_known_first_value_bytes(self):
        v = [1.0] + [0.0] * 191
        self.assertEqual(base64.b64decode(L.encode_emb(v))[:4], bytes([0x00, 0x00, 0x80, 0x3F]))

    def test_roundtrip_is_float32_exact(self):
        b64 = L.encode_emb(vec(2))
        self.assertEqual(L.encode_emb(L.decode_emb(b64)), b64)

    def test_wrong_dimension_rejected(self):
        with self.assertRaises(ValueError): L.encode_emb([0.0] * 191)
        with self.assertRaises(ValueError): L.decode_emb(base64.b64encode(b"\0" * 767).decode())

    def test_not_normalised(self):
        v = [10.0] * L.DIM
        self.assertEqual(L.decode_emb(L.encode_emb(v))[0], 10.0)


class Centroid(unittest.TestCase):
    def test_single_sample_is_itself(self):
        a = L.encode_emb(vec(3))
        self.assertEqual(L.mean_raw([a]), a)

    def test_is_arithmetic_mean_raw(self):
        a, b = vec(4), vec(5)
        got = L.decode_emb(L.mean_raw([L.encode_emb(a), L.encode_emb(b)]))
        for g, x, y in zip(got, a, b):
            self.assertAlmostEqual(g, (x + y) / 2, places=5)

    def test_float32_accumulation_matches_reference(self):
        # Reference: the exact float32 step sequence lib/enroll.ts performs.
        samples = [L.encode_emb(vec(s)) for s in (6, 7, 8)]
        acc = [0.0] * L.DIM
        for s in samples:
            v = L.decode_emb(s)
            acc = [struct.unpack("<f", struct.pack("<f", acc[i] + v[i]))[0] for i in range(L.DIM)]
        ref = L.encode_emb([struct.unpack("<f", struct.pack("<f", a / 3))[0] for a in acc])
        self.assertEqual(L.mean_raw(samples), ref)

    def test_empty_raises(self):
        with self.assertRaises(ValueError): L.mean_raw([])


class Scores(unittest.TestCase):
    def test_cosine_identical_and_orthogonal(self):
        a = L.encode_emb([1.0] + [0.0] * 191)
        b = L.encode_emb([0.0, 1.0] + [0.0] * 190)
        self.assertAlmostEqual(L.cosine(a, a), 1.0)
        self.assertAlmostEqual(L.cosine(a, b), 0.0)

    def test_cosine_zero_vector_is_none(self):
        self.assertIsNone(L.cosine(L.encode_emb([0.0] * 192), L.encode_emb(vec(1))))

    def test_distribution(self):
        d = L.distribution([0.5, 0.6, 0.65, 0.9])
        self.assertEqual((d["n"], d["worst"], d["n_clearing"]), (4, 0.5, 2))   # 0.65 clears: >=
        self.assertEqual(d["median"], 0.625)

    def test_distribution_empty(self):
        self.assertEqual(L.distribution([])["n"], 0)

    def test_threshold_is_vs_number(self):
        self.assertEqual(L.ROOM_THRESHOLD, 0.65)


class Select(unittest.TestCase):
    SEGS = [
        {"start_ms": 0, "end_ms": 10_000, "speaker_idx": 0, "overlap": False},
        {"start_ms": 20_000, "end_ms": 26_000, "speaker_idx": 0, "overlap": False},
        {"start_ms": 30_000, "end_ms": 45_000, "speaker_idx": 0, "overlap": True},   # overlap: out
        {"start_ms": 50_000, "end_ms": 50_900, "speaker_idx": 0, "overlap": False},  # too short
        {"start_ms": 60_000, "end_ms": 75_000, "speaker_idx": 1, "overlap": False},  # other speaker
        {"start_ms": 80_000, "end_ms": 90_000, "speaker_idx": 0, "overlap": False},
    ]

    def test_excludes_overlap_short_and_other_speakers(self):
        clips = L.select_segments(self.SEGS, 0)
        flat = [s for c in clips for s in c]
        self.assertEqual(sorted(s["start_ms"] for s in flat), [0, 20_000, 80_000])

    def test_chronological_within_clips_and_clip_cap(self):
        clips = L.select_segments(self.SEGS, 0, clip_ms=12_000)
        for c in clips:
            self.assertEqual(c, sorted(c, key=lambda s: s["start_ms"]))
            self.assertLessEqual(sum(s["end_ms"] - s["start_ms"] for s in c), 12_000 + 10_000)  # a segment is never split
        self.assertGreaterEqual(len(clips), 2)

    def test_budget_takes_longest_first(self):
        clips = L.select_segments(self.SEGS, 0, budget_ms=16_000)
        flat = [s for c in clips for s in c]
        self.assertEqual(sorted(s["start_ms"] for s in flat), [0, 20_000])   # 10s + 6s; the other 10s would bust it

    def test_deterministic(self):
        self.assertEqual(L.select_segments(self.SEGS, 0), L.select_segments(list(reversed(self.SEGS)), 0))

    def test_none_when_no_speech(self):
        self.assertEqual(L.select_segments(self.SEGS, 9), [])


class Gate(unittest.TestCase):
    def line(self, **kw):
        base = {"verdict": "ok", "diarize_ms": 4, "free_pct": 31}
        base.update(kw)
        return json.dumps(base)

    def test_go(self): self.assertTrue(L.gate(self.line())[0])
    def test_warn_is_go(self): self.assertTrue(L.gate(self.line(verdict="WARN_tightening"))[0])
    def test_stop_prefix_blocks(self): self.assertFalse(L.gate(self.line(verdict="STOP_heavy_swap_now"))[0])
    def test_diarize_ms_400_blocks(self): self.assertFalse(L.gate(self.line(diarize_ms=400))[0])
    def test_diarize_ms_399_goes(self): self.assertTrue(L.gate(self.line(diarize_ms=399))[0])
    def test_free_pct_ignored(self): self.assertTrue(L.gate(self.line(free_pct=1))[0])
    def test_unreadable_is_no_go(self):
        self.assertFalse(L.gate("")[0]); self.assertFalse(L.gate("{not json")[0])
    def test_missing_diarize_ms_is_no_go(self):
        self.assertFalse(L.gate(json.dumps({"verdict": "ok"}))[0])


class Sql(unittest.TestCase):
    def test_insert_only_shape(self):
        s = L.generation_insert_sql("doc_x", 2, [L.encode_emb(vec(1)), L.encode_emb(vec(2))], {"method": "m"})
        self.assertTrue(s.startswith("INSERT INTO voice_print_generation"))
        self.assertTrue(s.rstrip().endswith("ON CONFLICT DO NOTHING;"))
        for bad in ("UPDATE", "DELETE", "DROP", "TRUNCATE", "voice_print ", " voice_print("):
            self.assertNotIn(bad, s)
        self.assertIn("'vpg_doc_x_g2'", s)
        self.assertIn("'room_audio'", s)

    def test_generation_one_refused(self):
        with self.assertRaises(ValueError): L.generation_insert_sql("doc_x", 1, [L.encode_emb(vec(1))], {})

    def test_centroid_in_sql_is_the_mean(self):
        a, b = L.encode_emb(vec(1)), L.encode_emb(vec(2))
        self.assertIn(L.mean_raw([a, b]), L.generation_insert_sql("doc_x", 2, [a, b], {}))

    def test_quote_escaping(self):
        self.assertEqual(L._q("a'b"), "'a''b'")


if __name__ == "__main__":
    unittest.main()
