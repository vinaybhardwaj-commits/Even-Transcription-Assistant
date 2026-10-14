import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

from kit.reb import sarvam_lane as sl
from kit.reb import sarvam_sync_smoke as ss


class FakeGw:
    def __init__(self, fail_on=(), throttle_on=None, raise_exc=None, transcript="hello"):
        self.throttled, self.sent, self.fail_on, self.throttle_on, self.raise_exc, self.transcript = 0, [], set(fail_on), throttle_on, raise_exc, transcript

    def call_form(self, path, fields, file_field, filename, data, content_type, **k):
        self.sent.append((path, dict(fields), file_field, len(data), content_type))
        n = len(self.sent)
        if self.throttle_on == n:
            self.throttled += 1
        if self.raise_exc is not None:
            raise self.raise_exc
        if n in self.fail_on:
            raise sl.GatewayError("http 400", 400)
        return {"request_id": f"rq{n}", "transcript": self.transcript}, 100 + n


class T(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.tmp = self._td.name
        self.index = os.path.join(self.tmp, "index.jsonl")
        self.row = {"consult_uid": "U1", "status": "cut", "room_id": "room_a", "ist_date": "2026-10-10"}
        with open(self.index, "w") as f:
            f.write(json.dumps(self.row) + "\n")
        self.sink = sl.UsageSink(local_dir=os.path.join(self.tmp, "ledger"))
        self.held = lambda day, room: False
        self.decoded = []
        p = mock.patch.object(sl, "open_clip", lambda row, root=None: {"path": "/x/consult.flac", "span_start_ms": 1760000000000, "span_end_ms": 1760000100000})
        p.start()
        self.addCleanup(p.stop)
        self.tick = iter(x * 0.5 for x in range(10000))

    def go(self, total=100.0, write=False, gw=None, held=None, **kw):
        def decode(path, a, n):
            self.decoded.append((a, n))
            return b"w" * int(n * 100)
        return ss.run("U1", write=write, gw=gw, sink=self.sink if write else None, is_held=held or self.held, index_path=self.index,
                      probe=lambda p: total, decode=decode, clock=lambda: next(self.tick), **kw)

    def ledger(self):
        d = os.path.join(self.tmp, "ledger", "palimpsest")
        return [json.loads(l) for f in sorted(os.listdir(d)) if f.endswith(".jsonl") for l in open(os.path.join(d, f)) if l.strip()] if os.path.isdir(d) else []

    def test_plan_chunks_and_tail(self):
        self.assertEqual(ss.plan(60, 25), [(0.0, 25), (25.0, 25), (50.0, 10)])
        self.assertEqual(ss.plan(50.2, 25), [(0.0, 25), (25.0, 25)])   # 0.2 s tail dropped
        self.assertEqual(ss.plan(100, 25, 2), [(0.0, 25), (25.0, 25)])

    def test_percentiles_nearest_rank(self):
        self.assertEqual(ss.pct([1, 2, 3, 4], 50), 2)
        self.assertEqual(ss.pct(list(range(1, 21)), 95), 19)
        self.assertIsNone(ss.pct([], 50))

    def test_dry_run_with_a_gateway_given_calls_nothing(self):
        gw = FakeGw()
        r = self.go(write=False, gw=gw)
        self.assertEqual(gw.sent, [])
        self.assertEqual(self.decoded, [])
        self.assertEqual(r["mode"], "dry-run")
        self.assertEqual((r["planned_chunks"], r["calls"], r["chunks"]), (4, 0, []))
        self.assertEqual(self.ledger(), [])

    def test_write_sends_each_chunk_sequentially_and_measures(self):
        gw = FakeGw()
        r = self.go(total=60, write=True, gw=gw)
        self.assertEqual([(s[0], s[1], s[2], s[4]) for s in gw.sent], [("/speech-to-text", {"model": "saaras:v3", "mode": "transcribe"}, "file", "audio/wav")] * 3)
        self.assertEqual((r["calls"], r["call_failures"]), (3, 0))
        self.assertEqual([c["audio_s"] for c in r["chunks"]], [25, 25, 10])
        self.assertTrue(all(c["wall_s"] == 0.5 for c in r["chunks"]))   # fake clock steps 0.5 s per read
        self.assertEqual(r["wall_s"], {"p50": 0.5, "p95": 0.5, "max": 0.5})
        self.assertEqual(r["wall_per_audio_s"]["max"], 0.05)
        self.assertEqual(r["chunks"][0]["bytes_resp"], 101)

    def test_max_chunks(self):
        gw = FakeGw()
        r = self.go(write=True, gw=gw, max_chunks=2)
        self.assertEqual((len(gw.sent), r["planned_chunks"], r["chunks_total"]), (2, 2, 4))

    def test_ledger_lines_and_no_text_anywhere(self):
        gw = FakeGw(transcript="SECRET-WORDS")
        r = self.go(total=30, write=True, gw=gw)
        L = self.ledger()
        self.assertEqual(len(L), 2)
        for l in L:
            self.assertEqual((l["task"], l["mode"], l["model"], l["use"], l["scope"], l["ref"], l["chars"], l["status"]), ("stt_sync", "sync", "saaras:v3", "research", "consult_clip", "U1", 0, "ok"))
        self.assertEqual(L[0]["audio_s"], 25)
        self.assertNotIn("SECRET-WORDS", json.dumps(r) + json.dumps(L))

    def test_transcript_never_reaches_stderr_or_stdout(self):
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out), mock.patch.object(ss, "load_heldout", lambda: self.held), \
                mock.patch.object(ss, "duration_s", lambda p: 30.0), mock.patch.object(ss, "decode_chunk", lambda p, a, n: b"w" * 100), \
                mock.patch.object(sl, "UsageSink", lambda **k: self.sink), mock.patch.object(sl, "Gateway", lambda: FakeGw(transcript="SECRET-WORDS")):
            self.assertEqual(ss.main(["--uid", "U1", "--index", self.index, "--write"]), 0)
        self.assertEqual(json.loads(out.getvalue())["calls"], 2)
        self.assertNotIn("SECRET-WORDS", err.getvalue() + out.getvalue())
        err2 = io.StringIO()
        with contextlib.redirect_stderr(err2):
            self.go(total=30, write=True, gw=FakeGw(transcript="SECRET-WORDS"))
        self.assertNotIn("SECRET-WORDS", err2.getvalue())

    def test_gateway_error_reason_is_in_the_row_but_other_exceptions_keep_none(self):
        class G400(FakeGw):
            def call_form(self, *a, **k):
                raise sl.GatewayError("http 400 /speech-to-text: field file missing", 400)
        r = self.go(total=25, write=True, gw=G400())
        self.assertEqual(r["chunks"][0]["reason"], "http 400 /speech-to-text: field file missing")
        r = self.go(total=25, write=True, gw=FakeGw(raise_exc=TimeoutError("boom")))
        self.assertNotIn("reason", r["chunks"][0])
        self.assertNotIn("reason", self.go(total=25, write=True, gw=FakeGw())["chunks"][0])

    def test_empty_transcript_is_ok_but_counted(self):
        r = self.go(total=30, write=True, gw=FakeGw(transcript=" "))
        self.assertEqual((r["calls"], r["call_failures"], r["empty_responses"]), (2, 0, 2))

    def test_exception_is_ledgered_failed_and_stops_after_two_failures(self):
        gw = FakeGw(raise_exc=TimeoutError("boom"))
        r = self.go(total=250, write=True, gw=gw)
        self.assertEqual((r["calls"], r["call_failures"], r["stopped_failed"]), (3, 3, 1))
        self.assertEqual(r["call_errors_TimeoutError"], 3)
        self.assertEqual([l["status"] for l in self.ledger()], ["failed"] * 3)
        self.assertEqual(r["wall_s"]["p50"], None)
        self.assertNotIn("boom", json.dumps(r))

    def test_two_failures_do_not_stop(self):
        gw = FakeGw(fail_on={1, 2})
        r = self.go(total=100, write=True, gw=gw)
        self.assertEqual((r["calls"], r["call_failures"], r["stopped_failed"]), (4, 2, 0))
        self.assertEqual(r["wall_s"]["p50"], 0.5)   # failed chunks are not in the latency stats

    def test_stops_on_throttle(self):
        gw = FakeGw(throttle_on=2)
        r = self.go(total=100, write=True, gw=gw)
        self.assertEqual((r["calls"], r["stopped_throttled"], r["throttled_responses"]), (2, 1, 1))

    def test_heldout_and_non_cutter_refused_before_any_send(self):
        gw = FakeGw()
        r = self.go(write=True, gw=gw, held=lambda d, room: True)
        self.assertEqual((r["refused"], gw.sent, self.decoded), ("blind_refused", [], []))
        with open(self.index, "w") as f:
            f.write(json.dumps({**self.row, "consult_uid": "OTHER"}) + "\n")
        self.assertEqual(self.go(write=True, gw=gw)["refused"], "not_cutter")
        self.assertEqual(gw.sent, [])

    def test_no_guard_fails_closed(self):
        r = ss.run("U1", write=False, is_held=None, index_path=self.index, probe=lambda p: 10)
        self.assertEqual(r["refused"], "blind_refused")

    def test_chunk_s_limit(self):
        with self.assertRaises(ValueError):
            self.go(chunk_s=26)
        with self.assertRaises(ValueError):
            self.go(chunk_s=0)

    def test_cli_rejects_long_chunk(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(ss.main(["--uid", "U1", "--chunk-s", "30"]), 2)

    def test_cli_dry_run_report_file_0600_and_sink_closed_on_error(self):
        out = os.path.join(self.tmp, "rep.json")
        buf = io.StringIO()
        with mock.patch.object(ss, "load_heldout", lambda: self.held), mock.patch.object(ss, "duration_s", lambda p: 51.0), contextlib.redirect_stdout(buf):
            rc = ss.main(["--uid", "U1", "--index", self.index, "--write-report", out])
        self.assertEqual(rc, 0)
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        self.assertEqual(json.loads(open(out).read())["planned_chunks"], 3)
        self.assertEqual(json.loads(buf.getvalue())["calls"], 0)
        closed = []
        sink_cls = lambda **k: mock.Mock(put=None, close=lambda: closed.append(1))
        with mock.patch.object(ss, "load_heldout", lambda: self.held), mock.patch.object(sl, "UsageSink", sink_cls), mock.patch.object(sl, "Gateway", lambda: FakeGw()), \
                mock.patch.object(ss, "run", side_effect=RuntimeError("x")), self.assertRaises(RuntimeError), contextlib.redirect_stderr(io.StringIO()):
            ss.main(["--uid", "U1", "--index", self.index, "--write"])
        self.assertEqual(closed, [1])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
    def test_real_ffmpeg_decode_16k_mono(self):
        f = os.path.join(self.tmp, "t.flac")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=7", "-ac", "2", "-ar", "44100", f], check=True)
        self.assertAlmostEqual(ss.duration_s(f), 7.0, delta=0.1)
        w = ss.decode_chunk(f, 2, 3)
        self.assertEqual(w[:4], b"RIFF")
        self.assertAlmostEqual((len(w) - 44) / 2 / ss.SR, 3.0, delta=0.1)


class FormTest(unittest.TestCase):
    def test_call_form_signs_body_and_counts_429(self):
        seen = {}

        class Rq:
            def request(self, method, url, data=None, headers=None, timeout=None):
                seen.update(method=method, url=url, data=data, headers=headers)
                r = mock.Mock(status_code=200, content=b'{"transcript":"x"}')
                r.json.return_value = {"transcript": "x"}
                return r
        gw = sl.Gateway.__new__(sl.Gateway)
        import threading
        gw.rq, gw._lock, gw._tl, gw.throttled, gw.statuses, gw.log = Rq(), threading.Lock(), threading.local(), 0, {}, lambda **k: None
        gw._creds, gw._exp = {"key": "k", "secret": "s", "token": None}, 1e18
        out, n = gw.call_form("/speech-to-text", {"model": "saaras:v3", "mode": "transcribe"}, "file", "c.wav", b"RIFFdata", "audio/wav")
        self.assertEqual((out, n), ({"transcript": "x"}, 18))
        self.assertTrue(seen["headers"]["content-type"].startswith("multipart/form-data; boundary="))
        self.assertIn(b'name="mode"\r\n\r\ntranscribe', seen["data"])
        self.assertIn(b'filename="c.wav"', seen["data"])
        self.assertIn(b"RIFFdata", seen["data"])
        self.assertIn("Authorization", seen["headers"])
        gw.rq.request = lambda *a, **k: mock.Mock(status_code=429, content=b"", text="")
        with self.assertRaises(sl.GatewayError) as cm:
            gw.call_form("/speech-to-text", {}, "file", "c.wav", b"x", "audio/wav")
        self.assertEqual((cm.exception.status, gw.throttled), (429, 1))

    def test_non_2xx_keeps_status_and_first_200_chars_of_the_error_body(self):
        gw = sl.Gateway.__new__(sl.Gateway)
        import threading
        gw.rq, gw._lock, gw._tl, gw.throttled, gw.statuses, gw.log = mock.Mock(), threading.Lock(), threading.local(), 0, {}, lambda **k: None
        gw._creds, gw._exp = {"key": "k", "secret": "s", "token": None}, 1e18
        body = 'bad field "file" see https://x.example/doc?k=1 ' + "z" * 400
        gw.rq.request.return_value = mock.Mock(status_code=400, content=body.encode(), text=body)
        with self.assertRaises(sl.GatewayError) as cm:
            gw.call_form("/speech-to-text", {}, "file", "c.wav", b"x", "audio/wav")
        m = str(cm.exception)
        self.assertEqual(cm.exception.status, 400)
        self.assertTrue(m.startswith('http 400 /speech-to-text: bad field "file" see <url>'))
        self.assertNotIn("x.example", m)
        self.assertLessEqual(len(m.split(": ", 1)[1]), 200)
        self.assertNotIn("z" * 201, m)


if __name__ == "__main__":
    unittest.main()
