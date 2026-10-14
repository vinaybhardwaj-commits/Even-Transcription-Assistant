"""Offline tests for calibrate.py (ruling 369 item 1; eta-refuter #2118 item 1 and #2227): the thresholds come from labelled stretches of TAPE, are reported per stretch (level gate,
chunk-rate gate, and the combined gate that actually permits a sound), and stay 'proposed' until they can be checked against an occupied ground-truth stretch."""
import contextlib, functools, io, json, os, random, shutil, statistics, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import calibrate as C
import mic_selftest as M

SR = M.SR
T0 = 1_790_000_000                                                                   # a fixed epoch second for synthetic chunks


@functools.lru_cache(maxsize=None)
def pcm(seconds, sigma, seed):
    r = random.Random(seed)
    return b"".join(int(max(-1, min(1, r.gauss(0, sigma))) * 32767).to_bytes(2, "little", signed=True) for _ in range(seconds * SR))


def iso(epoch):
    import datetime
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Pcm(unittest.TestCase):
    """The level rule on raw tape.pcm stretches (no manifest: a 'proposed' file with a warning at most)."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.d, True)

    def tape(self, name, seconds, sigma, seed=1):
        p = os.path.join(self.d, name)
        with open(p, "wb") as f:
            f.write(pcm(seconds, sigma, seed))
        return p

    def spec(self, empty_sigma=0.002, used_sigma=0.03, extra=()):
        st = [dict(file=self.tape("e.pcm", 300, empty_sigma), label="empty", room="opd4"), dict(file=self.tape("u.pcm", 300, used_sigma, 2), label="used", room="opd3")]
        return dict(source="synthetic", stretches=st + list(extra))

    def test_dead_threshold_is_1_10_x_the_median_empty_window_level(self):
        cal = C.calibrate(self.spec())
        lv = C.window_levels(C.frame_rms(pcm(300, 0.002, 1)))
        self.assertAlmostEqual(cal["dead_rms_max"], 1.10 * statistics.median(lv), places=5)
        self.assertLess(cal["dead_rms_max"], 1.10 * max(lv) + 1e-12)
        self.assertEqual((cal["dead_window_s"], cal["dead_quantile"]), (120, 0.90))
        empty_frames = C.frame_rms(pcm(300, 0.002, 1))
        self.assertAlmostEqual(cal["speech_rms"], 1.10 * max(empty_frames), places=5)
        self.assertGreater(cal["speech_rms"], cal["dead_rms_max"])
        self.assertIsNone(cal["chunk_rate_max_bps"])
        self.assertTrue(any("manifest" in w for w in cal["warnings"]))

    def test_the_level_rule_fires_in_the_empty_room_only_part_of_the_time_and_never_in_occupied_rooms(self):
        cal = C.calibrate(self.spec(extra=[dict(file=self.tape("q.pcm", 300, 0.006, 3), label="quiet", room="opd5")]))
        rows = {r["label"]: r for r in cal["stretches"]}
        self.assertGreater(rows["empty"]["dead_trigger_rate"], 0.2)                    # the median anchor: the empty room reads dead in a good share of windows
        self.assertLessEqual(rows["empty"]["dead_trigger_rate"], 1.0)
        self.assertEqual(rows["used"]["dead_trigger_rate"], 0.0)
        self.assertEqual(rows["quiet"]["dead_trigger_rate"], 0.0)

    def test_an_occupied_quiet_room_as_quiet_as_the_empty_one_refuses(self):
        clash = self.spec(extra=[dict(file=self.tape("q3.pcm", 300, 0.0021, 4), label="quiet")])
        with self.assertRaises(ValueError) as cm:
            C.calibrate(clash)
        self.assertIn("no separation", str(cm.exception))

    def test_unlabelled_stretches_are_reported_but_never_change_the_threshold(self):
        base = C.calibrate(self.spec())
        more = C.calibrate(self.spec(extra=[dict(file=self.tape("x.pcm", 300, 0.0021, 5), label="unlabelled", room="opd7")]))
        self.assertEqual(base["dead_rms_max"], more["dead_rms_max"])
        self.assertEqual(more["stretches"][-1]["label"], "unlabelled")
        self.assertGreater(more["stretches"][-1]["dead_trigger_rate"], 0.2)           # reported: this room would fire

    def test_without_an_occupied_stretch_only_a_proposal_with_a_warning_can_be_written(self):
        only_empty = dict(source="synthetic", stretches=[dict(file=self.tape("e.pcm", 300, 0.002), label="empty")])
        cal = C.calibrate(only_empty)
        self.assertEqual(cal["status"], "proposed")
        self.assertTrue(cal["warnings"])
        with self.assertRaises(ValueError):
            C.calibrate(only_empty, status="preregistered")
        path = os.path.join(self.d, "p.json")
        with open(path, "w") as f:
            json.dump(cal, f)
        with self.assertRaises(M.Refuse):                                              # and load_calibration refuses a proposal
            M.load_calibration(path)

    def test_needs_an_empty_stretch_and_valid_labels_and_enough_tape(self):
        with self.assertRaises(ValueError):
            C.calibrate(dict(stretches=[dict(file=self.tape("u.pcm", 300, 0.03), label="used")]))
        bad = self.spec()
        bad["stretches"][0]["label"] = "silent"
        with self.assertRaises(ValueError):
            C.calibrate(bad)
        short = dict(stretches=[dict(file=self.tape("s.pcm", 60, 0.002), label="empty"), dict(file=self.tape("u.pcm", 300, 0.03), label="used")])
        with self.assertRaises(ValueError):
            C.calibrate(short)                                                          # an empty stretch shorter than the 120 s window

    def test_from_to_select_the_stretch(self):
        p = os.path.join(self.d, "mix.pcm")
        with open(p, "wb") as f:
            f.write(pcm(30, 0.002, 1) + pcm(30, 0.05, 2))
        rms = C.frame_rms(C.read_stretch(dict(file=p, from_s=0, to_s=30)))
        self.assertEqual(len(rms), 30)
        self.assertLess(max(rms), 0.01)
        self.assertGreater(min(C.frame_rms(C.read_stretch(dict(file=p, from_s=30)))), 0.03)

    def test_trigger_rate_counts_sliding_windows_at_the_quantile(self):
        rms = [0.001] * 130 + [0.5] + [0.001] * 130
        self.assertEqual(C.trigger_rate(rms, 0.005, window_s=120, quantile=1.0, step=1), round(22 / 142, 4))       # the every-frame rule: 22 of 142 windows avoid the loud second
        self.assertEqual(C.trigger_rate(rms, 0.005, window_s=120, quantile=0.9, step=1), 1.0)                      # the 90% level ignores one loud second in 120
        self.assertEqual(C.trigger_rate([0.5] * 200, 0.005, window_s=120), 0.0)
        self.assertEqual(C.trigger_rate([0.001] * 50, 0.005, window_s=120), None)


class StatsAndManifest(unittest.TestCase):
    """The full three-gate calibration from tape_stats output and a chunk manifest (numbers only), synthetic rooms."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.d, True)
        self.stats = os.path.join(self.d, "stats.jsonl")
        self.manifest = os.path.join(self.d, "manifest.jsonl")
        open(self.stats, "w").close()
        open(self.manifest, "w").close()

    def add_room(self, room, level, bps, chunks=4, start=T0, jitter=0.15, seed=1):
        r = random.Random(seed)
        with open(self.stats, "a") as fs, open(self.manifest, "a") as fm:
            for k in range(chunks):
                t = start + 300 * k
                rms = [round(level * (1 + jitter * r.uniform(-1, 1)), 6) for _ in range(300)]
                fs.write(json.dumps(dict(room_id=room, started_at=iso(t), idx=k, seconds=300, rms=rms, peak=[0.1] * 300, exact_zero_seconds=0)) + "\n")
                fm.write(json.dumps(dict(room_id=room, session_id="s_" + room, idx=k, started_at=iso(t), duration_ms=300000,
                                         size_bytes=int(bps * 300 * (1 + jitter * r.uniform(-1, 1))))) + "\n")

    def st(self, room, label, chunks=4, start=T0, note=""):
        return dict(stats_jsonl=self.stats, room_id=room, from_iso=iso(start), to_iso=iso(start + 300 * chunks), label=label, room=room, note=note)

    def spec(self, extra=(), manifest=True):
        d = dict(source="synthetic", stretches=[self.st("room_empty", "empty")] + list(extra))
        if manifest:
            d["manifest_jsonl"] = self.manifest
        return d

    def base(self):
        self.add_room("room_empty", 0.0005, 1000, seed=1)
        self.add_room("room_busy", 0.03, 3800, seed=2)
        self.add_room("room_hush", 0.0004, 1000, seed=3)          # as dead as the empty room: unlabelled

    def test_chunk_limit_is_1_10_x_the_highest_empty_chunk_rate_and_gates_are_reported(self):
        self.base()
        cal = C.calibrate(self.spec(extra=[self.st("room_busy", "used"), self.st("room_hush", "unlabelled")]))
        chunks = C.load_chunks(self.manifest, "room_empty")
        self.assertAlmostEqual(cal["chunk_rate_max_bps"], round(1.10 * max(c["rate"] for c in chunks), 1), places=1)
        rows = {r["room"]: r for r in cal["stretches"]}
        self.assertEqual(rows["room_busy"]["chunk_gate_rate"], 0.0)
        self.assertEqual(rows["room_busy"]["combined_rate"], 0.0)
        self.assertGreater(rows["room_empty"]["combined_rate"], 0.2)                    # the empty room passes all three together part of the time
        self.assertGreater(rows["room_hush"]["combined_rate"], 0.2)                     # an unlabelled room that looks dead is REPORTED as firing
        self.assertLessEqual(rows["room_empty"]["combined_rate"], min(rows["room_empty"]["chunk_gate_rate"], rows["room_empty"]["dead_trigger_rate"]))

    def test_the_combined_gate_needs_all_three(self):
        pts = [(T0 + i, 0.0005) for i in range(600)]
        chunks = [dict(start=T0 - 600 + 300 * k, end=T0 - 300 + 300 * k, ended_at=T0 - 300 + 300 * k, size_bytes=300000, duration_ms=300000, rate=1000.0, idx=k, session_id="s")
                  for k in range(6)]
        ok = C.combined_rates(pts, chunks, dead=0.001, speech=0.01, limit=1500)
        self.assertEqual((ok["level_gate_rate"], ok["chunk_gate_rate"], ok["combined_rate"]), (1.0, 1.0, 1.0))
        noisy = C.combined_rates([(t, 0.05) for t, _ in pts], chunks, dead=0.001, speech=0.01, limit=1500)
        self.assertEqual((noisy["level_gate_rate"], noisy["combined_rate"]), (0.0, 0.0))
        heavy = [dict(c, size_bytes=1_200_000, rate=4000.0) for c in chunks]
        self.assertEqual(C.combined_rates(pts, heavy, dead=0.001, speech=0.01, limit=1500)["combined_rate"], 0.0)          # chunk gate alone blocks it
        burst = [(t, 0.0005 if i != 300 else 0.02) for i, (t, _) in enumerate(pts)]
        r = C.combined_rates(burst, chunks, dead=0.001, speech=0.01, limit=1500)                                           # a speech-level second inside the 5-min look-back
        self.assertLess(r["combined_rate"], r["level_gate_rate"] + 1e-9)
        self.assertLess(r["combined_rate"], 1.0)
        self.assertIsNone(C.combined_rates(pts[:50], chunks, dead=0.001, speech=0.01, limit=1500))

    def test_the_chunk_gate_only_uses_chunks_that_had_ended_by_that_moment(self):
        pts = [(T0 + i, 0.0005) for i in range(600)]
        past = [dict(start=T0 - 600 + 300 * k, end=T0 - 300 + 300 * k, ended_at=T0 - 300 + 300 * k, size_bytes=300000, duration_ms=300000, rate=1000.0, idx=k, session_id="s")
                for k in range(2)]
        future = dict(start=T0 + 5000, end=T0 + 5300, ended_at=T0 + 5300, size_bytes=1_500_000, duration_ms=300000, rate=5000.0, idx=2, session_id="s")   # ends long after every step
        r = C.combined_rates(pts, past + [future], dead=0.001, speech=0.01, limit=1500)
        self.assertEqual(r["chunk_gate_rate"], 1.0)                                                                        # the heavy future chunk is not looked at
        self.assertTrue(C.chunk_gate_at(past + [future], T0 + 100, 1500))
        self.assertFalse(C.chunk_gate_at(past + [future], T0 + 5400, 1500))                                                # once it has ended (and is fresh) it counts

    def test_an_occupied_room_that_passes_the_chunk_gate_refuses(self):
        self.base()
        self.add_room("room_odd", 0.03, 1000, seed=4)                                   # loud room, but its chunks compress like a dead one
        with self.assertRaises(ValueError) as cm:
            C.calibrate(self.spec(extra=[self.st("room_odd", "used")]))
        self.assertIn("chunk-rate limit", str(cm.exception))

    def test_a_dead_looking_occupied_room_refuses_on_the_level_gate(self):
        self.base()
        with self.assertRaises(ValueError) as cm:
            C.calibrate(self.spec(extra=[self.st("room_hush", "quiet")]))
        self.assertIn("no separation", str(cm.exception))

    def test_preregister_needs_the_manifest_and_an_occupied_stretch_and_writes_all_fields(self):
        self.base()
        with self.assertRaises(ValueError):
            C.calibrate(self.spec(extra=[self.st("room_busy", "used")], manifest=False), status="preregistered")
        with self.assertRaises(ValueError):
            C.calibrate(self.spec(), status="preregistered")
        cal = C.calibrate(self.spec(extra=[self.st("room_busy", "used")]), status="preregistered")
        path = os.path.join(self.d, "cal.json")
        with open(path, "w") as f:
            json.dump(cal, f)
        loaded, sha = M.load_calibration(path)
        self.assertEqual((loaded["status"], loaded["chunk_gate_n"], len(sha)), ("preregistered", 2, 64))
        self.assertGreater(loaded["chunk_rate_max_bps"], 900)

    def test_no_empty_chunk_means_no_chunk_limit(self):
        self.base()
        spec = self.spec()
        spec["stretches"][0]["from_iso"] = iso(T0 + 10)                                 # starts after the first chunk, but still holds chunks 1-3
        spec["stretches"][0]["to_iso"] = iso(T0 + 290)                                  # ends before the second starts: no chunk STARTS inside
        with self.assertRaises(ValueError):
            C.calibrate(spec)

    def test_a_stats_jsonl_stretch_reads_only_its_room_and_time_range(self):
        p = os.path.join(self.d, "s2.jsonl")
        with open(p, "w") as f:
            f.write(json.dumps(dict(room_id="room_a", started_at="2026-09-25T03:00:00.500Z", idx=0, seconds=4, rms=[0.1, 0.2, 0.3, 0.4], peak=[1, 1, 1, 1], exact_zero_seconds=0)) + "\n")
            f.write(json.dumps(dict(room_id="room_b", started_at="2026-09-25T03:00:00.500Z", idx=0, seconds=4, rms=[9, 9, 9, 9], peak=[1, 1, 1, 1], exact_zero_seconds=0)) + "\n")
            f.write(json.dumps(dict(room_id="room_a", started_at="2026-09-25T03:00:04.500Z", idx=1, seconds=4, rms=[0.5, 0.6, 0.7, 0.8], peak=[1, 1, 1, 1], exact_zero_seconds=0)) + "\n")
            f.write(json.dumps(dict(room_id="room_a", started_at="2026-09-25T04:00:00Z", error="decode failed")) + "\n")
        sel = dict(stats_jsonl=p, room_id="room_a", from_iso="2026-09-25T03:00:01Z", to_iso="2026-09-25T03:00:06Z")
        self.assertEqual(C.read_stats_series(sel), [0.2, 0.3, 0.4, 0.5, 0.6])
        self.assertEqual([v for _, v in C.read_stats_points(sel)], [0.2, 0.3, 0.4, 0.5, 0.6])

    def test_load_chunks_keeps_only_full_chunks_of_the_room_in_time_order(self):
        with open(self.manifest, "w") as f:
            f.write(json.dumps(dict(room_id="a", started_at="2026-09-25T03:05:00Z", duration_ms=300000, size_bytes=600000)) + "\n")
            f.write(json.dumps(dict(room_id="a", started_at="2026-09-25T03:00:00Z", duration_ms=300000, size_bytes=300000)) + "\n")
            f.write(json.dumps(dict(room_id="a", started_at="2026-09-25T03:10:00Z", duration_ms=11000, size_bytes=99999)) + "\n")     # a partial chunk
            f.write(json.dumps(dict(room_id="b", started_at="2026-09-25T03:00:00Z", duration_ms=300000, size_bytes=5)) + "\n")
        got = C.load_chunks(self.manifest, "a")
        self.assertEqual([round(c["rate"]) for c in got], [1000, 2000])
        self.assertLess(got[0]["start"], got[1]["start"])

    def test_cli_writes_proposed_by_default_and_preregistered_only_when_asked(self):
        self.base()
        sp = os.path.join(self.d, "spec.json")
        with open(sp, "w") as f:
            json.dump(self.spec(extra=[self.st("room_busy", "used")]), f)
        out = os.path.join(self.d, "calibration.json")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(C.main([sp, "--out", out]), 0)
        with open(out) as f:
            self.assertEqual(json.load(f)["status"], "proposed")
        with self.assertRaises(M.Refuse):
            M.load_calibration(out)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(C.main([sp, "--out", out, "--preregister"]), 0)
        cal, sha = M.load_calibration(out)
        self.assertEqual((cal["status"], len(sha)), ("preregistered", 64))
        os.remove(out)
        with open(sp, "w") as f:
            json.dump(self.spec(extra=[self.st("room_hush", "quiet")]), f)
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(C.main([sp, "--out", out, "--preregister"]), 1)
        self.assertFalse(os.path.exists(out))


if __name__ == "__main__":
    unittest.main()
