"""Regression tests for the refuter findings L1-L5 + the title start-time change (08 Oct 2026)."""
import contextlib, datetime as dt, http.client, io, json, os, socket, sys, tempfile, threading, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.dont_write_bytecode = True
import gen_index as G, serve as S, build_patients as B
from test_gen_index import Base, row

DATA = bytes(range(256)) * 40


class TestServeFixes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        t = cls.tmp.name
        cls.clips = os.path.join(t, "clipsdata")
        for d in ("uid1", "uid2.tmp"):
            os.makedirs(os.path.join(cls.clips, "2026-10-07", "room", d))
            open(os.path.join(cls.clips, "2026-10-07", "room", d, "consult.flac"), "wb").write(DATA)
        cls.www = os.path.join(t, "www")
        os.makedirs(cls.www)
        open(os.path.join(cls.www, "index.html"), "w").write("<html>ok</html>")
        os.symlink(cls.clips, os.path.join(cls.www, "clips"))
        cls.srv = S.make_server("127.0.0.1", 0, cls.www)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close(); cls.tmp.cleanup()

    FLAC = "/clips/2026-10-07/room/uid1/consult.flac"

    def get(self, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path, headers=headers or {})
        r = c.getresponse(); b = r.read(); c.close()
        return r, b

    def raw(self, data):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        s.sendall(data)
        out = b""
        try:
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                out += chunk
        except socket.timeout:
            pass
        s.close()
        return out

    # L1
    def test_range_huge_digit_strings_do_not_crash(self):
        huge = "9" * 5000  # > Python 4300-digit int() limit
        self.assertEqual(S.parse_range("bytes=%s-" % huge, 10), "bad")
        self.assertEqual(S.parse_range("bytes=0-%s" % huge, 10), (0, 9))
        self.assertEqual(S.parse_range("bytes=-%s" % huge, 10), (0, 9))
        r, b = self.get(self.FLAC, {"Range": "bytes=%s-" % huge})
        self.assertEqual(r.status, 416)
        r, b = self.get(self.FLAC, {"Range": "bytes=0-%s" % huge})
        self.assertEqual((r.status, len(b)), (206, len(DATA)))
        r, b = self.get(self.FLAC, {"Range": "bytes=-%s" % huge})
        self.assertEqual((r.status, len(b)), (206, len(DATA)))
        self.assertEqual(self.get(self.FLAC)[0].status, 200)  # server still fine

    # L2
    def test_early_reject_414_has_response_and_no_traceback(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            out = self.raw(b"GET /" + b"a" * 70000 + b" HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertTrue(out.startswith(b"HTTP/1.1 414"), out[:40])
        self.assertNotIn("Traceback", err.getvalue())
        self.assertEqual(self.get("/")[0].status, 200)

    def test_path_only_without_path_attribute(self):
        h = S.Handler.__new__(S.Handler)
        self.assertEqual(h._path_only(), "")

    # L4 (405 body smuggling)
    def test_405_closes_connection_and_does_not_parse_body_as_request(self):
        smuggled = b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"
        req = b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(smuggled) + smuggled
        out = self.raw(req)
        self.assertEqual(out.count(b"HTTP/1.1 "), 1, out)
        self.assertTrue(out.startswith(b"HTTP/1.1 405"))
        self.assertIn(b"Connection: close", out)

    # L5
    def test_tmp_segments_refused(self):
        r, b = self.get("/clips/2026-10-07/room/uid2.tmp/consult.flac")
        self.assertEqual(r.status, 404)
        self.assertNotEqual(b, DATA)
        self.assertEqual(self.get(self.FLAC)[0].status, 200)
        self.assertIsNone(S.resolve(self.www, "/clips/2026-10-07/room/uid2.tmp/consult.flac"))

    def test_unit_has_no_tailscaled_dependency(self):
        u = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "units", "consult-index.service")).read()
        self.assertNotIn("tailscaled", u)


class TestGenFixes(Base):
    def test_missing_index_exits_zero_with_log_line_and_keeps_old_page(self):
        www = os.path.join(self.tmp.name, "www"); os.makedirs(www)
        old = os.path.join(www, "index.html"); open(old, "w").write("OLD")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = G.main(["--index", os.path.join(self.tmp.name, "nope.jsonl"), "--clips", self.clips, "--patients", "x", "--www", www])
        self.assertEqual(rc, 0)
        self.assertIn("missing", err.getvalue())
        self.assertEqual(open(old).read(), "OLD")

    # late Rx chip
    def _late(self, rx_ts, name="Jane Roe"):
        r = row("u1"); self.make_files(r)  # span_end 10:03:36.726 IST
        return self.render([r], {"u1": {"patient_name": name, "prescription_ts": rx_ts}})

    def test_late_rx_chip_shown_over_30_min_and_name_kept(self):
        html = self._late("2026-10-07 10:48:36+05:30")  # +45 min
        self.assertIn("late Rx: patient name from a prescription saved 45 min after the consult", html)
        self.assertIn("Jane Roe", html)

    def test_no_late_rx_chip_within_30_min(self):
        self.assertNotIn("late Rx", self._late("2026-10-07 10:33:36+05:30"))  # +30 min exactly
        self.assertNotIn("late Rx", self._late("2026-10-07 09:50:00+05:30"))  # during the consult

    def test_no_late_rx_chip_without_timestamp_or_for_unknown_patient(self):
        r = row("u1"); self.make_files(r)
        self.assertNotIn("late Rx", self.render([r], {"u1": {"patient_name": "Jane Roe"}}))
        self.assertNotIn("late Rx", self._late("2026-10-07 12:00:00+05:30", name=None))

    # title start time
    def test_title_start_prefers_neon_t_open_then_row_t_open_then_span_start(self):
        r = row("u1", t_open="2026-10-07 09:43:22.522")
        self.assertEqual(G.build_title("Dr A", r, "P", {"window_t_open_ist": "2026-10-07 09:40:01"}).split(" · ")[1], "09:40")
        self.assertEqual(G.build_title("Dr A", r, "P", {}).split(" · ")[1], "09:43")
        self.assertEqual(G.build_title("Dr A", row("u1"), "P", None).split(" · ")[1], "09:42")
        t = G.build_title("Dr A", r, "P", {"window_t_open_ist": "garbage"})
        self.assertEqual(t.split(" · ")[1], "09:43")
        self.assertTrue(t.endswith("09:42–10:03 (21 min)"))  # span range unchanged

    def test_rendered_title_uses_window_start(self):
        r = row("u1"); self.make_files(r)
        html = self.render([r], {"u1": {"patient_name": "Jane Roe", "window_t_open_ist": "2026-10-07 09:43:22"}})
        self.assertIn("Dr A · 09:43 · Jane Roe · 09:42–10:03 (21 min)", html)


class TestBuildPatientsOpen(unittest.TestCase):
    def test_ist_open_conversion(self):
        self.assertEqual(B.ist_open("2026-10-07 06:18:44.735000+00:00"), "2026-10-07 11:48:44")
        self.assertEqual(B.ist_open(dt.datetime(2026, 10, 7, 6, 18, 44, tzinfo=dt.timezone.utc)), "2026-10-07 11:48:44")
        self.assertIsNone(B.ist_open(None))

    def test_merge_stores_window_open_for_matched_and_unmatched(self):
        w = {"u1": [{"warehouse_prescription_uid": "P1", "prescription_ref": "P1", "t_open": "2026-10-07 06:18:44+00:00"}],
             "u2": [{"warehouse_prescription_uid": None, "prescription_ref": "P2", "t_open": "2026-10-07 07:00:00+00:00"}]}
        res = B.merge(["u1", "u2"], w, {"P1": {"name": "Jane Roe", "ts": "2026-10-07 11:48:45+05:30"}})
        self.assertEqual(res["u1"]["window_t_open_ist"], "2026-10-07 11:48:44")
        self.assertEqual(res["u2"]["window_t_open_ist"], "2026-10-07 12:30:00")
        self.assertIsNone(res["u2"]["patient_name"])


if __name__ == "__main__":
    unittest.main()
