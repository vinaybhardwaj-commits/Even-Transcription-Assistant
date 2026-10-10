"""Tests for the Nemotron worker's LAB lane and the per-frame probability files (migration 0143). Standard library only:

    python3 -m unittest discover -s tools/nemotron-worker/tests -v

Real code under test: lab.py (allow-list re-check, ffmpeg filter string, speaker limits, NLP1 files, presigned PUT), Worker.step / lab_cycle /
process_lab / process (probabilities), GpuGate. The server is the fake from test_worker.py (extended with lab/claim, lab/ingest and a PUT sink);
the engine is a stub (no NeMo here, so the NeMo calls in engine_nemo.py are UNVERIFIED by these tests). Fixtures are typed by hand.
"""
import fcntl
import gzip
import hashlib
import json
import os
import re
import struct
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import lab  # noqa: E402
import worker  # noqa: E402
import engine_nemo  # noqa: E402  (top-level imports are stdlib only; the NeMo stack loads inside NemotronEngine.__init__)
from test_worker import Base, StubEngine, stub_decode, CLIP_BYTES  # noqa: E402

REPO = os.path.join(os.path.dirname(__file__), "..", "..", "..")
FIX = os.path.join(REPO, "tests", "fixtures", "nlp1")
P = [[0.0, 1.0, 0.5, 0.25], [0.2, 0.8, 0.0, 1.0], [0.1, 0.9, 0.3, 0.7]]
E = [[0.5, -0.25, 1.5, 0.0], [2.0, -1.0, 0.125, 0.75]]
SPEC_HASH = "a" * 64


def spec(**o):
    base = {"preset": "offline_30.4s", "postprocessing": {}, "frontend": [], "max_speakers": None, "min_speech_ms": None,
            "return_probs": False, "return_embeddings": None}
    base.update(o)
    return base


class LabEngine(StubEngine):
    """The stub plus the lab/probability API of engine_nemo.NemotronEngine."""
    def __init__(self, probs=None, emb=None, lab_raise=None, **kw):
        super().__init__(**kw)
        self.probs, self.emb, self.lab_raise = probs, emb, lab_raise
        self.lab_specs, self.embed_calls, self.prob_calls = [], [], 0
        self.lock_path = None
        self.lock_was_held = []

    def _lock_held(self):
        if not self.lock_path:
            return None
        fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o664)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
            return False
        except BlockingIOError:
            return True
        finally:
            os.close(fd)

    def lab_config(self, sp):
        return {**self.config, "latency": sp["preset"]}

    def diarize(self, wav):
        self.lock_was_held.append(self._lock_held())
        return super().diarize(wav)

    def diarize_with_probs(self, wav):
        self.prob_calls += 1
        self.lock_was_held.append(self._lock_held())
        return super().diarize(wav), self.probs

    def diarize_lab(self, wav, sp):
        self.lab_specs.append(sp)
        self.lock_was_held.append(self._lock_held())
        if self.lab_raise:
            raise self.lab_raise
        return list(self.segments), (self.probs if sp["return_probs"] else None)

    def embed_speakers(self, wav, turns, kind):
        self.embed_calls.append((kind, [t[2] for t in turns]))
        self.lock_was_held.append(self._lock_held())
        return self.emb


def decode_spy(calls):
    def d(src, wav, af=None):
        calls.append(af)
        return stub_decode(src, wav)
    return d


class Pure(unittest.TestCase):
    def test_validate_spec_accepts_a_good_spec_and_refuses_everything_else(self):
        ok = lab.validate_spec(spec(preset="latency_10s", postprocessing={"onset": 0.5}, frontend=[{"op": "highpass", "hz": 80}], max_speakers=3, min_speech_ms=2000, return_probs=True, return_embeddings="titanet"))
        self.assertEqual((ok["preset"], ok["max_speakers"], ok["return_embeddings"]), ("latency_10s", 3, "titanet"))
        bad = [
            {"model": "x"}, {"preset": "../x"}, {"postprocessing": {"evil": 1}}, {"postprocessing": {"onset": 2}}, {"postprocessing": {"onset": "0.5"}},
            {"postprocessing": {"onset": float("nan")}}, {"postprocessing": [1]}, {"frontend": [{"op": "exec", "cmd": "id"}]}, {"frontend": [{"op": "highpass", "hz": "80;id"}]},
            {"frontend": [{"op": "highpass", "hz": 80, "x": 1}]}, {"frontend": [{"op": "loudnorm", "I": -16}]}, {"frontend": [{"op": "loudnorm"}] * 7},
            {"frontend": [{"op": "highpass", "hz": 5}]}, {"frontend": "x"}, {"frontend": [{"hz": 80}]}, {"max_speakers": 9}, {"max_speakers": 0}, {"max_speakers": True},
            {"min_speech_ms": -1}, {"return_embeddings": "whisper"},
        ]
        for b in bad:
            with self.assertRaises(lab.SpecError, msg=repr(b)):
                lab.validate_spec(spec(**b) if set(b) <= set(spec()) else {**spec(), **b})
        with self.assertRaises(lab.SpecError):
            lab.validate_spec("not a dict")

    def test_build_af_is_numbers_only_and_deterministic(self):
        fe = lab.validate_spec(spec(frontend=[{"op": "highpass", "hz": 80}, {"op": "lowpass", "hz": 7000}, {"op": "gain", "db": -3.5}, {"op": "loudnorm"}, {"op": "afftdn", "nr": 12}]))["frontend"]
        self.assertEqual(lab.build_af(fe), "highpass=f=80,lowpass=f=7000,volume=-3.5dB,loudnorm=I=-23:LRA=7:TP=-2,afftdn=nr=12")
        self.assertIsNone(lab.build_af([]))
        # a hostile op can never reach the filter string, even if validation were skipped
        with self.assertRaises(lab.SpecError):
            lab.build_af([{"op": "amovie", "file": "/etc/passwd"}])
        self.assertNotRegex(lab.build_af(fe), r"[;'\"\\$`]")

    def test_filter_speakers(self):
        segs = [(0, 10, "a"), (10, 15, "b"), (15, 16, "c"), (16, 20, "a")]  # a=14 s, b=5 s, c=1 s
        self.assertEqual({s[2] for s in lab.filter_speakers(segs, None, None)}, {"a", "b", "c"})
        self.assertEqual({s[2] for s in lab.filter_speakers(segs, None, 2000)}, {"a", "b"})
        self.assertEqual({s[2] for s in lab.filter_speakers(segs, 1, None)}, {"a"})
        self.assertEqual({s[2] for s in lab.filter_speakers(segs, 2, 500)}, {"a", "b"})
        self.assertEqual(lab.filter_speakers(segs, 5, 0), segs)
        tie = [(0, 5, "x"), (5, 10, "y")]
        self.assertEqual({s[2] for s in lab.filter_speakers(tie, 1, None)}, {"x"})  # ties break on the label

    def test_postprocessing_yaml_is_written_from_numbers(self):
        self.assertIsNone(lab.postprocessing_yaml({}))
        self.assertEqual(lab.postprocessing_yaml({"onset": 0.5, "offset": 0.6}), "parameters:\n  offset: 0.6\n  onset: 0.5\n")

    def test_nlp1_round_trip_u8_and_f16(self):
        h, rows = lab.unpack_nlp(lab.pack_nlp(P, "u8", {"frame_ms": 80}))
        self.assertEqual((h["dtype"], h["rows"], h["cols"], h["scale"], h["frame_ms"]), ("u8", 3, 4, 255, 80))
        for r, e in zip(rows, P):
            for a, b in zip(r, e):
                self.assertLessEqual(abs(a - b), 1 / 510 + 1e-9)
        h, rows = lab.unpack_nlp(lab.pack_nlp(E, "f16", {"embedder": "ecapa"}))
        self.assertEqual((h["dtype"], rows), ("f16", E))
        self.assertEqual(lab.pack_nlp(P, "u8"), lab.pack_nlp(P, "u8"))  # deterministic bytes

    def test_nlp1_reads_the_file_the_typescript_side_wrote(self):
        with open(os.path.join(FIX, "probs-ts.nlp"), "rb") as f:
            h, rows = lab.unpack_nlp(f.read())
        self.assertEqual((h["dtype"], h["rows"], h["cols"]), ("u8", 3, 4))
        for r, e in zip(rows, P):
            for a, b in zip(r, e):
                self.assertLessEqual(abs(a - b), 1 / 510 + 1e-9)
        with open(os.path.join(FIX, "emb-ts.nlp"), "rb") as f:
            self.assertEqual(lab.unpack_nlp(f.read())[1], E)

    def test_the_python_fixtures_the_typescript_test_reads_are_current(self):
        # tests/fixtures/nlp1/*-py.nlp are decoded by tests/unit/nemotron-lab.test.ts; if pack_nlp's FORMAT changes, they must be regenerated
        with open(os.path.join(FIX, "probs-py.nlp"), "rb") as f:
            h, rows = lab.unpack_nlp(f.read())
        self.assertEqual((h["dtype"], h["rows"], h["cols"], h["frame_ms"]), ("u8", 3, 4, 80))
        with open(os.path.join(FIX, "emb-py.nlp"), "rb") as f:
            h, rows = lab.unpack_nlp(f.read())
        self.assertEqual((h["dtype"], rows, h["embedder"]), ("f16", E, "ecapa"))

    def test_nlp1_refuses_malformed_files(self):
        with self.assertRaises(Exception):
            lab.unpack_nlp(b"not gzip")
        with self.assertRaises(ValueError):
            lab.unpack_nlp(gzip.compress(b"XXXX\0\0\0\0"))
        head = json.dumps({"dtype": "u8", "rows": 2, "cols": 2}).encode()
        with self.assertRaises(ValueError):
            lab.unpack_nlp(gzip.compress(b"NLP1" + struct.pack("<I", len(head)) + head + b"\0\0\0"))
        with self.assertRaises(ValueError):
            lab.pack_nlp([[0, 1], [0.5]], "u8")

    def test_the_preset_names_match_the_server_allow_list_and_the_engine(self):
        with open(os.path.join(REPO, "lib", "diarize-nemotron", "lab.ts")) as f:
            ts = f.read()
        names = re.search(r"LAB_PRESETS = \[(.*?)\] as const", ts).group(1)
        self.assertEqual(tuple(re.findall(r'"([^"]+)"', names)), lab.PRESETS)
        self.assertEqual(tuple(engine_nemo.PRESETS), lab.PRESETS)
        pp = re.search(r"LAB_PP_RANGES[^=]*= \{(.*?)\};", ts, re.S).group(1)
        self.assertEqual({k: (float(a), float(b)) for k, a, b in re.findall(r"(\w+): \[(\d+), (\d+)\]", pp)}, {k: (float(a), float(b)) for k, (a, b) in lab.PP_RANGES.items()})
        self.assertEqual(tuple(re.findall(r'"([^"]+)"', re.search(r"LAB_EMBEDDERS = \[(.*?)\] as const", ts).group(1))), lab.EMBEDDERS)

    def test_the_production_preset_is_the_production_setting(self):
        self.assertEqual(engine_nemo.PRESETS["offline_30.4s"], engine_nemo.OFFLINE_30_4)

    def test_put_object_is_https_only_by_default_and_never_raises(self):
        self.assertFalse(lab.put_object("http://example.invalid/x", b"1"))
        self.assertFalse(lab.put_object("file:///etc/passwd", b"1"))
        self.assertFalse(lab.put_object("https://127.0.0.1:1/x", b"1", timeout_s=1))


def lab_item(srv, idx=0, sp=None, **extra):
    base = {"run_id": "job_t1", "idx": idx, "clip_url": srv.base + "/clips/a?X-Amz-Signature=sekret-sig", "attempt": 1,
            "spec": sp or spec(), "spec_hash": SPEC_HASH}
    base.update(extra)
    return base


class LabLane(Base):
    def make_lab(self, engine=None, **cfg):
        calls = []
        w = self.make(engine or LabEngine(), put_schemes=("https", "http"), **cfg)
        w.decode = decode_spy(calls)
        w.decode_calls = calls
        return w

    def test_lab_is_never_asked_while_production_has_a_window(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv)]})]
        w = self.make_lab()
        self.assertTrue(w.step())
        self.assertEqual(len(self.srv.posts), 1)
        self.assertEqual(self.srv.lab_calls, [], "a production window was offered: the lab claim must not be called")
        self.assertEqual(self.srv.lab_posts, [])
        # the next cycle finds production empty and only THEN asks for lab work
        self.assertTrue(w.step())
        self.assertEqual(len(self.srv.lab_calls), 1)
        self.assertEqual(len(self.srv.lab_posts), 1)

    def test_lab_is_not_asked_when_pending_fails(self):
        for status, body in [(503, {"error": "db"}), (404, {"error": "disabled"}), (401, {"error": "unauthorized"}), (500, {})]:
            self.srv.pending = [(status, body)]
            self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv)]})]
            w = self.make_lab()
            w.step()
            self.assertEqual(self.srv.lab_calls, [], f"pending {status} must not fall through to lab")
        self.assertEqual(self.srv.lab_posts, [])

    def test_production_pending_from_the_server_means_no_items_and_the_worker_idles(self):
        self.srv.lab_claim = [(200, {"ok": True, "items": [], "reason": "production_pending"})]
        w = self.make_lab()
        self.assertTrue(w.step())
        self.assertEqual(len(self.srv.lab_calls), 1)
        self.assertEqual(self.srv.lab_posts, [])
        self.assertEqual(self.clock.sleeps[-1], 60)  # idle poll

    def test_lab_off_or_failing_is_quiet_idle_not_an_error(self):
        for st in (404, 503, 401):
            self.srv.lab_claim = [(st, {"error": "lab_disabled"})]
            w = self.make_lab()
            self.assertTrue(w.step())
            self.assertEqual(self.clock.sleeps[-1], 60)
        self.assertEqual(self.srv.lab_posts, [])

    def test_lab_can_be_switched_off_in_the_worker(self):
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv)]})]
        w = self.make_lab(lab=False)
        w.step()
        self.assertEqual(self.srv.lab_calls, [])

    def test_happy_path_front_end_gpu_lock_deletion_and_post(self):
        lockfile = os.path.join(self.tmp + "-lock")
        eng = LabEngine(probs=P, emb=E)
        eng.lock_path = lockfile
        sp = spec(frontend=[{"op": "highpass", "hz": 80}, {"op": "gain", "db": -3}], return_probs=True, return_embeddings="ecapa", max_speakers=2)
        it = lab_item(self.srv, sp=sp, probs_key="lab/nemotron/job_t1/0/probs.nlp", probs_put_url=self.srv.base + "/put/probs", embeddings_key="lab/nemotron/job_t1/0/emb.nlp",
                      embeddings_put_url=self.srv.base + "/put/emb")
        self.srv.lab_claim = [(200, {"ok": True, "items": [it]})]
        w = self.make_lab(eng, gpu_lock=lockfile)
        self.assertTrue(w.step())
        self.assertTmpEmpty()
        self.assertEqual(w.decode_calls, ["highpass=f=80,volume=-3dB"])
        self.assertEqual(eng.lock_was_held, [True, True], "the GPU lock must be held for the inference AND the embedding")
        self.assertFalse(eng._lock_held(), "and released after")
        self.assertEqual(eng.lab_specs[0]["max_speakers"], 2)
        self.assertEqual(eng.embed_calls, [("ecapa", ["spk0", "spk1"])])
        b = self.srv.lab_posts[0]
        self.assertEqual(sorted(b), sorted(["run_id", "idx", "worker_id", "status", "error_code", "model", "model_rev", "config", "spec_hash", "audio_ms",
                                            "clip_sha256", "turns", "probs_r2_key", "embeddings_r2_key", "embeddings_dims", "infer_s"]))
        self.assertEqual((b["run_id"], b["idx"], b["status"], b["spec_hash"], b["worker_id"]), ("job_t1", 0, "ok", SPEC_HASH, "box-test"))
        self.assertEqual((b["probs_r2_key"], b["embeddings_r2_key"], b["embeddings_dims"]), ("lab/nemotron/job_t1/0/probs.nlp", "lab/nemotron/job_t1/0/emb.nlp", 4))
        self.assertEqual(b["clip_sha256"], hashlib.sha256(CLIP_BYTES).hexdigest())
        self.assertEqual(b["config"]["latency"], "offline_30.4s")
        self.assertTrue(all(len(t) == 3 and t[2].startswith("spk") for t in b["turns"]))
        self.assertEqual({p[0] for p in self.srv.puts}, {"/put/probs", "/put/emb"})
        by = {p[0]: p for p in self.srv.puts}
        self.assertEqual(by["/put/probs"][2], "application/octet-stream")
        h, rows = lab.unpack_nlp(by["/put/probs"][1])  # the uploaded file is a valid NLP1 file with the engine's matrix: the round trip across the wire
        self.assertEqual((h["dtype"], h["rows"], h["cols"]), ("u8", 3, 4))
        self.assertEqual(lab.unpack_nlp(by["/put/emb"][1])[1], E)

    def test_the_model_is_shared_so_lab_runs_one_item_at_a_time_and_counts_toward_the_rate_cap(self):
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv, i)]}) for i in range(3)]
        w = self.make_lab(rate_per_hour=2)
        w.step()
        self.assertEqual(len(self.srv.lab_posts), 1, "one item per claim cycle (the server was asked for limit=1)")
        self.assertEqual(self.srv.lab_calls[0]["limit"], ["1"])
        self.assertEqual(len(w.started), 1)
        w.step()
        self.assertEqual(len(w.started), 2)
        n_calls = len(self.srv.lab_calls)
        w.step()  # cap reached: neither /pending nor /lab/claim is called, the worker sleeps until the hour turns
        self.assertEqual(len(self.srv.lab_calls), n_calls)
        self.assertEqual(len(self.srv.pending_calls), 2)
        self.assertEqual(w.state, "rate_capped")

    def test_production_and_lab_share_one_rate_cap(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv)]})]
        w = self.make_lab(rate_per_hour=2)
        w.step()  # production window
        w.step()  # lab item
        self.assertEqual((len(self.srv.posts), len(self.srv.lab_posts)), (1, 1))
        calls = (len(self.srv.pending_calls), len(self.srv.lab_calls))
        w.step()
        self.assertEqual((len(self.srv.pending_calls), len(self.srv.lab_calls)), calls)

    def test_a_spec_the_allow_list_refuses_never_reaches_fetch_or_the_engine(self):
        fetched = []
        eng = LabEngine()
        w = self.make_lab(eng, fetch=lambda *a, **k: fetched.append(a) or ("0" * 64, 1))
        for bad in ({"preset": "../../x"}, {"frontend": [{"op": "exec", "cmd": "id"}]}, {"postprocessing": {"evil": 1}}, {"model": "x"}):
            self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv, sp={**spec(), **bad})]})]
            w.step()
        self.assertEqual(fetched, [])
        self.assertEqual(eng.lab_specs, [])
        self.assertEqual([(p["status"], p["error_code"]) for p in self.srv.lab_posts], [("failed", "bad_spec")] * 4)
        self.assertTrue(all(p["turns"] == [] and p["probs_r2_key"] is None for p in self.srv.lab_posts))

    def test_failure_codes(self):
        cases = [
            (LabEngine(lab_raise=RuntimeError("CUDA out of memory")), spec(), "gpu_oom"),
            (LabEngine(lab_raise=ValueError("x")), spec(), "infer_failed"),
            (LabEngine(lab_raise=lab.EmbedderUnavailable()), spec(), "embedder_unavailable"),
            (LabEngine(segments=[(0, float("nan"), "a")]), spec(), "infer_failed"),
            (LabEngine(emb=None), spec(return_embeddings="titanet"), None),  # embed returns None: no files, still posts the turns
        ]
        for eng, sp, code in cases:
            self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv, sp=sp)]})]
            w = self.make_lab(eng)
            w.step()
            b = self.srv.lab_posts[-1]
            self.assertEqual(b["error_code"], code, repr(code))
            self.assertTmpEmpty()

    def test_a_front_end_decode_failure_is_frontend_failed_and_a_plain_one_decode_failed(self):
        self.srv.clips["/clips/bad"] = (200, b"BAD-bytes")
        sp = spec(frontend=[{"op": "loudnorm"}])
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv, sp=sp, clip_url=self.srv.base + "/clips/bad"), lab_item(self.srv, 1, clip_url=self.srv.base + "/clips/bad")]})]
        w = self.make_lab()
        w.step()
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv, 1, clip_url=self.srv.base + "/clips/bad")]})]
        w.step()
        self.assertEqual([p["error_code"] for p in self.srv.lab_posts], ["frontend_failed", "decode_failed"])
        self.assertEqual([p["audio_ms"] for p in self.srv.lab_posts], [0, 0])

    def test_an_upload_that_fails_fails_the_item_retryably_and_names_no_pointer(self):
        self.srv.put_status = 500
        sp = spec(return_probs=True)
        it = lab_item(self.srv, sp=sp, probs_key="lab/nemotron/job_t1/0/probs.nlp", probs_put_url=self.srv.base + "/put/probs")
        self.srv.lab_claim = [(200, {"ok": True, "items": [it]})]
        w = self.make_lab(LabEngine(probs=P))
        w.step()
        b = self.srv.lab_posts[0]
        self.assertEqual((b["status"], b["error_code"], b["probs_r2_key"], b["turns"]), ("failed", "upload_failed", None, []))

    def test_missing_put_url_when_probs_were_asked_is_upload_failed(self):
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv, sp=spec(return_probs=True))]})]
        w = self.make_lab(LabEngine(probs=P))
        w.step()
        self.assertEqual(self.srv.lab_posts[0]["error_code"], "upload_failed")

    def test_an_empty_result_posts_empty_and_uploads_nothing(self):
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv, sp=spec(return_probs=True, return_embeddings="ecapa"))]})]
        w = self.make_lab(LabEngine(segments=[], probs=None, emb=None))
        w.step()
        b = self.srv.lab_posts[0]
        self.assertEqual((b["status"], b["turns"], b["probs_r2_key"], b["embeddings_r2_key"]), ("empty", [], None, None))
        self.assertEqual(self.srv.puts, [])

    def test_speaker_limits_are_applied_before_the_turns_are_posted(self):
        segs = [(0.0, 10.0, "x"), (10.0, 12.0, "y"), (12.0, 12.3, "z")]
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv, sp=spec(min_speech_ms=1000))]})]
        w = self.make_lab(LabEngine(segments=segs))
        w.step()
        self.assertEqual({t[2] for t in self.srv.lab_posts[0]["turns"]}, {"spk0", "spk1"})
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv, sp=spec(max_speakers=1))]})]
        w.step()
        self.assertEqual({t[2] for t in self.srv.lab_posts[1]["turns"]}, {"spk0"})

    def test_lab_ingest_responses_end_the_item_for_this_worker(self):
        for st, body in [(409, {"error": "spec_mismatch"}), (422, {"error": "file_missing"}), (404, {"error": "unknown_item"}), (400, {"error": "bad_status"})]:
            self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv)]})]
            self.srv.lab_ingest = [(st, body)]
            w = self.make_lab()
            w.step()
        self.assertEqual(len(self.srv.lab_posts), 4, "each of these is final: not retried")

    def test_lab_ingest_is_retried_on_5xx_with_the_identical_body(self):
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv)]})]
        self.srv.lab_ingest = [(503, {"error": "db"}), (200, {"ok": True, "result": "stored", "state": "ok"})]
        w = self.make_lab()
        w.step()
        self.assertEqual(len(self.srv.lab_posts), 2)
        self.assertEqual(self.srv.lab_posts[0], self.srv.lab_posts[1])

    def test_a_stop_while_waiting_for_the_gpu_abandons_the_item_unposted(self):
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv)]})]
        w = self.make_lab()
        w.gpu.acquire = lambda: False
        w.step()
        self.assertEqual(self.srv.lab_posts, [])
        self.assertTmpEmpty()

    def test_nothing_sensitive_is_logged(self):
        self.srv.lab_claim = [(200, {"ok": True, "items": [lab_item(self.srv, sp=spec(return_probs=True), probs_key="k", probs_put_url=self.srv.base + "/put/probs?X-Amz-Signature=sekret-sig")]})]
        w = self.make_lab(LabEngine(probs=P))
        w.step()
        text = self.logbuf.getvalue()
        self.assertNotIn("sekret-sig", text)
        self.assertNotIn("tok-test", text)
        self.assertNotIn("X-Amz", text)
        self.assertNotIn("spk0", text)


class ProductionProbabilities(Base):
    def make_p(self, engine, **cfg):
        w = self.make(engine, put_schemes=("https", "http"), **cfg)
        return w

    def window(self, **extra):
        w = self.srv.window("bw_fake_1")
        w.update(extra)
        return w

    def test_probabilities_are_uploaded_and_the_pointer_is_posted(self):
        eng = LabEngine(probs=P)
        self.srv.pending = [(200, {"ok": True, "windows": [self.window(probs_key="lab/nemotron-probs/bw_fake_1.nlp", probs_put_url=self.srv.base + "/put/p")], "exhausted": 0})]
        self.make_p(eng).step()
        b = self.srv.posts[0]
        self.assertEqual(b["probs_r2_key"], "lab/nemotron-probs/bw_fake_1.nlp")
        self.assertEqual(eng.prob_calls, 1)
        h, rows = lab.unpack_nlp(self.srv.puts[0][1])
        self.assertEqual((h["rows"], h["cols"], h["window_id"]), (3, 4, "bw_fake_1"))
        self.assertTmpEmpty()

    def test_the_result_is_identical_with_or_without_probabilities(self):
        eng_a, eng_b = LabEngine(probs=P), LabEngine(probs=P)
        self.srv.pending = [(200, {"ok": True, "windows": [self.window(probs_key="k", probs_put_url=self.srv.base + "/put/p")], "exhausted": 0})]
        self.make_p(eng_a).step()
        self.srv.pending = [(200, {"ok": True, "windows": [self.window()], "exhausted": 0})]
        self.make_p(eng_b).step()
        a, b = self.srv.posts
        self.assertEqual(a["turns"], b["turns"])
        self.assertEqual({k: v for k, v in a.items() if k != "probs_r2_key"}, b)

    def test_an_old_server_that_sends_no_put_url_gets_the_old_body_exactly(self):
        eng = LabEngine(probs=P)
        self.srv.pending = [(200, {"ok": True, "windows": [self.window()], "exhausted": 0})]
        self.make_p(eng).step()
        self.assertNotIn("probs_r2_key", self.srv.posts[0])
        self.assertEqual(eng.prob_calls, 0)
        self.assertEqual(self.srv.puts, [])

    def test_a_failed_upload_posts_the_window_without_the_pointer(self):
        self.srv.put_status = 500
        eng = LabEngine(probs=P)
        self.srv.pending = [(200, {"ok": True, "windows": [self.window(probs_key="k", probs_put_url=self.srv.base + "/put/p")], "exhausted": 0})]
        self.make_p(eng).step()
        b = self.srv.posts[0]
        self.assertEqual((b["status"], "probs_r2_key" in b), ("ok", False))

    def test_an_engine_without_probabilities_still_works(self):
        eng = StubEngine()  # no diarize_with_probs
        self.srv.pending = [(200, {"ok": True, "windows": [self.window(probs_key="k", probs_put_url=self.srv.base + "/put/p")], "exhausted": 0})]
        self.make_p(eng).step()
        self.assertEqual((self.srv.posts[0]["status"], self.srv.puts), ("ok", []))

    def test_a_none_matrix_posts_without_a_pointer(self):
        eng = LabEngine(probs=None)
        self.srv.pending = [(200, {"ok": True, "windows": [self.window(probs_key="k", probs_put_url=self.srv.base + "/put/p")], "exhausted": 0})]
        self.make_p(eng).step()
        self.assertNotIn("probs_r2_key", self.srv.posts[0])
        self.assertEqual(self.srv.puts, [])

    def test_a_failed_window_never_carries_a_pointer(self):
        eng = LabEngine(probs=P, raise_exc=RuntimeError("boom"))
        self.srv.pending = [(200, {"ok": True, "windows": [self.window(probs_key="k", probs_put_url=self.srv.base + "/put/p")], "exhausted": 0})]
        self.make_p(eng).step()
        self.assertEqual((self.srv.posts[0]["status"], "probs_r2_key" in self.srv.posts[0], self.srv.puts), ("failed", False, []))


if __name__ == "__main__":
    unittest.main()
