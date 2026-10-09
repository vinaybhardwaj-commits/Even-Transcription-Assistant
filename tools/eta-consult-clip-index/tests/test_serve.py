import http.client, os, sys, tempfile, threading, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.dont_write_bytecode = True
import serve as S

DATA = bytes(range(256)) * 40  # 10240 bytes


class TestServe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        t = cls.tmp.name
        cls.secret = os.path.join(t, "secret.flac")  # outside the clips tree
        open(cls.secret, "wb").write(b"SECRET")
        cls.clips = os.path.join(t, "clipsdata")
        os.makedirs(os.path.join(cls.clips, "2026-10-07", "room", "uid1"))
        open(os.path.join(cls.clips, "2026-10-07", "room", "uid1", "consult.flac"), "wb").write(DATA)
        open(os.path.join(cls.clips, "2026-10-07", "room", "uid1", "timeline.json"), "w").write("{}")
        open(os.path.join(cls.clips, "index.jsonl"), "w").write("{}\n")
        os.symlink(cls.secret, os.path.join(cls.clips, "2026-10-07", "room", "uid1", "evil.flac"))  # symlink escaping the tree
        cls.www = os.path.join(t, "www")
        os.makedirs(cls.www)
        open(os.path.join(cls.www, "index.html"), "w").write("<html>ok</html>")
        open(os.path.join(cls.www, "other.html"), "w").write("nope")
        os.symlink(cls.clips, os.path.join(cls.www, "clips"))
        cls.srv = S.make_server("127.0.0.1", 0, cls.www)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close(); cls.tmp.cleanup()

    def get(self, path, method="GET", headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, headers=headers or {})  # http.client sends the path verbatim (no ../ normalisation)
        r = c.getresponse(); body = r.read(); c.close()
        return r, body

    FLAC = "/clips/2026-10-07/room/uid1/consult.flac"

    def test_index_served(self):
        for p in ("/", "/index.html"):
            r, b = self.get(p)
            self.assertEqual((r.status, b), (200, b"<html>ok</html>"))
            self.assertTrue(r.getheader("Content-Type").startswith("text/html"))

    def test_flac_full_and_headers(self):
        r, b = self.get(self.FLAC)
        self.assertEqual((r.status, b), (200, DATA))
        self.assertEqual(r.getheader("Accept-Ranges"), "bytes")
        self.assertEqual(r.getheader("Content-Type"), "audio/flac")

    def test_range_206(self):
        r, b = self.get(self.FLAC, headers={"Range": "bytes=100-199"})
        self.assertEqual(r.status, 206)
        self.assertEqual(b, DATA[100:200])
        self.assertEqual(r.getheader("Content-Range"), "bytes 100-199/%d" % len(DATA))
        self.assertEqual(r.getheader("Content-Length"), "100")

    def test_range_open_ended_and_suffix(self):
        r, b = self.get(self.FLAC, headers={"Range": "bytes=10000-"})
        self.assertEqual((r.status, b), (206, DATA[10000:]))
        r, b = self.get(self.FLAC, headers={"Range": "bytes=-50"})
        self.assertEqual((r.status, b), (206, DATA[-50:]))
        r, b = self.get(self.FLAC, headers={"Range": "bytes=0-999999"})  # end past EOF is clamped
        self.assertEqual((r.status, len(b)), (206, len(DATA)))

    def test_range_unsatisfiable_416(self):
        r, b = self.get(self.FLAC, headers={"Range": "bytes=99999-"})
        self.assertEqual(r.status, 416)
        self.assertEqual(r.getheader("Content-Range"), "bytes */%d" % len(DATA))

    def test_head(self):
        r, b = self.get(self.FLAC, method="HEAD")
        self.assertEqual((r.status, b), (200, b""))
        self.assertEqual(r.getheader("Content-Length"), str(len(DATA)))

    def test_no_directory_listings(self):
        for p in ("/clips", "/clips/", "/clips/2026-10-07", "/clips/2026-10-07/", "/clips/2026-10-07/room/uid1/", "/clips/2026-10-07/room/uid1", "/clips/.flac", "/clips//.flac"):
            r, _ = self.get(p)
            self.assertIn(r.status, (403, 404), p)

    def test_non_flac_refused(self):
        for p in ("/clips/2026-10-07/room/uid1/timeline.json", "/clips/index.jsonl", "/other.html", "/clips/2026-10-07/room/uid1/consult.flac.json", "/serve.py"):
            r, _ = self.get(p)
            self.assertIn(r.status, (403, 404), p)

    def test_path_traversal_refused(self):
        evil = ["/clips/../index.html", "/clips/../../secret.flac", "/clips/%2e%2e/secret.flac", "/clips/2026-10-07/../../../secret.flac",
                "/clips/2026-10-07/room/uid1/../../../../secret.flac", "/clips/..%2fsecret.flac", "/clips/%2e%2e%2fsecret.flac", "/clips/..%5csecret.flac",
                "/../secret.flac", "//etc/passwd", "/clips/%00.flac", "/clips/2026-10-07/room/uid1/evil.flac", "/clips/%252e%252e/secret.flac"]
        for p in evil:
            r, b = self.get(p)
            self.assertIn(r.status, (403, 404), p)
            self.assertNotIn(b"SECRET", b, p)

    def test_methods(self):
        r, _ = self.get("/", method="POST")
        self.assertEqual(r.status, 405)

    def test_bind_guards(self):
        with self.assertRaises(SystemExit):
            S.make_server("0.0.0.0", 0, self.www)
        with self.assertRaises(SystemExit):
            S.main(["--bind", "127.0.0.1"])  # needs --test

    def test_unconfigured_bind_refuses_to_start(self):
        old = S.TAILSCALE_IP
        S.TAILSCALE_IP = None                      # CONSULT_INDEX_BIND unset
        try:
            with self.assertRaises(SystemExit) as cm:
                S.main([])
            self.assertIn("CONSULT_INDEX_BIND", str(cm.exception))
            with self.assertRaises(SystemExit):
                S.main(["--bind", "127.0.0.1"])      # still needs --test
        finally:
            S.TAILSCALE_IP = old

    def test_parse_range(self):
        self.assertEqual(S.parse_range("bytes=0-0", 10), (0, 0))
        self.assertEqual(S.parse_range("bytes=5-", 10), (5, 9))
        self.assertEqual(S.parse_range("bytes=-3", 10), (7, 9))
        self.assertEqual(S.parse_range("bytes=-30", 10), (0, 9))
        self.assertEqual(S.parse_range("bytes=10-", 10), "bad")
        self.assertEqual(S.parse_range("bytes=5-2", 10), "bad")
        self.assertIsNone(S.parse_range("bytes=0-1,4-5", 10))
        self.assertIsNone(S.parse_range(None, 10))


if __name__ == "__main__":
    unittest.main()
