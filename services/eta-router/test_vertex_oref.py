# Opus refuter scratch tests for the vertex: engine. No network: requests.post and the token
# endpoint are faked. The RSA key is generated here, fake, never a real credential.
import io, json, os, shutil, sys, tempfile, time, unittest, contextlib
from unittest import mock

WT = os.environ.get("ETA_ROUTER_DIR", os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, WT)
import router_server as rs  # noqa: E402
import rsa  # noqa: E402

HINDI = "मुझे बुखार है"
_pub, _priv = rsa.newkeys(1024)
PEM = _priv.save_pkcs1().decode()


class Resp:
    def __init__(self, status=200, body=None): self.status_code = status; self._b = body or {}
    def json(self): return self._b


def vx_ok(t="I have a fever"):
    return Resp(200, {"modelVersion": "m", "candidates": [{"content": {"parts": [{"text": t}]}}]})


class FakeTokResp:
    def __init__(self, n): self.status = 200; self.headers = {}; self.data = json.dumps({"access_token": f"tok-fake-{n}", "expires_in": 3600}).encode()


class Mints:
    n = 0


class FakeRequest:
    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kw):
        Mints.n += 1
        assert "oauth2" in url or "token" in url, url
        return FakeTokResp(Mints.n)


class T(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="spine-vertex-oref-")
        self.sa = os.path.join(self.d, "sa.json")
        self.write("proj-a")
        Mints.n = 0
        rs._VERTEX_TOKEN_CACHE.clear()
        self.p = [mock.patch.object(rs, "VERTEX_SA_FILE", self.sa), mock.patch.object(rs, "VERTEX_PROJECT", ""),
                  mock.patch.object(rs, "VERTEX_LOCATION", "global"),
                  mock.patch.object(rs, "TRANSLATE_ENGINE", "vertex:gemini-2.5-flash-lite"),
                  mock.patch.object(rs, "TRANSLATE_FALLBACK", ["vertex:gemini-2.5-flash"]),
                  mock.patch("google.auth.transport.requests.Request", FakeRequest)]
        for x in self.p: x.start()
        self.calls = []

    def tearDown(self):
        for x in self.p: x.stop()
        shutil.rmtree(self.d, ignore_errors=True)

    def write(self, proj, key=None):
        with open(self.sa, "w") as fh:
            json.dump({"type": "service_account", "client_email": "sa-test-fake", "private_key": key or PEM,
                       "private_key_id": "k1", "project_id": proj, "token_uri": "https://oauth2.googleapis.com/token"}, fh)

    def post(self, *rs_):
        seq = list(rs_)
        def fake(url, **kw):
            self.calls.append((url, kw)); return seq.pop(0)
        return mock.patch.object(rs.requests, "post", side_effect=fake)

    def test_P1_rotation_with_new_mtime_remints_without_manual_cache_clear(self):
        with self.post(vx_ok(), vx_ok()):
            rs.translate(HINDI, "hi")
            self.write("proj-b"); st = os.stat(self.sa); os.utime(self.sa, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
            rs.translate(HINDI, "hi")
        self.assertEqual(Mints.n, 2)
        self.assertIn("/projects/proj-b/", self.calls[1][0])
        self.assertEqual(self.calls[1][1]["headers"]["Authorization"], "Bearer tok-fake-2")

    def test_P2_same_file_reuses_token_and_expiry_is_utc_correct(self):
        with self.post(vx_ok(), vx_ok()):
            rs.translate(HINDI, "hi"); rs.translate(HINDI, "hi")
        self.assertEqual(Mints.n, 1)
        (_, exp), = rs._VERTEX_TOKEN_CACHE.values()
        self.assertLess(abs(exp - (time.time() + 3600)), 120)  # naive-UTC expiry handled right in any TZ

    def test_P3_token_near_expiry_is_reminted(self):
        with self.post(vx_ok(), vx_ok()):
            rs.translate(HINDI, "hi")
            k = next(iter(rs._VERTEX_TOKEN_CACHE)); tok, _ = rs._VERTEX_TOKEN_CACHE[k]
            rs._VERTEX_TOKEN_CACHE[k] = (tok, time.time() + 100)  # inside the 300 s margin
            rs.translate(HINDI, "hi")
        self.assertEqual(Mints.n, 2)

    def test_P4_unreadable_file_is_closed_code_nothing_sent(self):
        os.chmod(self.sa, 0)
        try:
            if os.access(self.sa, os.R_OK): self.skipTest("running as root")
            with self.post():
                with self.assertRaises(rs.TranslateError) as cm: rs.vertex_translate(HINDI, "hi", "m")
            self.assertEqual(str(cm.exception), "vertex_sa_unreadable"); self.assertEqual(self.calls, [])
        finally:
            os.chmod(self.sa, 0o600)

    def test_P5_bad_private_key_with_real_google_auth_is_class_only(self):
        self.write("proj-a", key="-----BEGIN PRIVATE KEY-----\nFAKE-NOT-A-KEY\n-----END PRIVATE KEY-----\n")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), self.post():
            r = rs.translate(HINDI, "hi")
        self.assertIsNone(r["english"])
        self.assertRegex(r["translate_error"], r"vertex_auth_failed:[A-Za-z]+")
        blob = out.getvalue() + err.getvalue() + json.dumps(r)
        self.assertNotIn("FAKE-NOT-A-KEY", blob); self.assertNotIn("sa-test-fake", blob)
        self.assertEqual(self.calls, [])

    def test_P6_thought_parts_are_not_the_translation(self):
        body = {"candidates": [{"content": {"parts": [{"text": "reasoning...", "thought": True}, {"text": "I have a fever"}]}}]}
        with self.post(Resp(200, body)):
            r = rs.translate(HINDI, "hi")
        self.assertEqual(r["english"], "I have a fever")

    def test_P7_hanging_mint_is_bounded_by_the_engine_deadline(self):
        class Slow(FakeRequest):
            def __call__(self, *a, **k): time.sleep(1.5); return super().__call__(*a, **k)
        with mock.patch("google.auth.transport.requests.Request", Slow), mock.patch.object(rs, "VERTEX_TIMEOUT", 0.3), self.post():
            t0 = time.time(); r = rs.translate(HINDI, "hi")
        self.assertLess(time.time() - t0, 1.4)
        self.assertIn("vertex_deadline", r["translate_error"])

    def test_P8_openrouter_engine_still_works_when_named(self):
        kf = os.path.join(self.d, "k"); open(kf, "w").write("sk-or-v1-FAKE\n")
        with mock.patch.object(rs, "OPENROUTER_KEY_FILE", kf), mock.patch.object(rs, "TRANSLATE_ENGINE", "openrouter:google/gemini-2.5-flash-lite"), \
             self.post(Resp(200, {"model": "x", "choices": [{"message": {"content": "I have a fever"}}]})):
            r = rs.translate(HINDI, "hi")
        self.assertEqual(r["translate_engine"], "openrouter:google/gemini-2.5-flash-lite")
        self.assertEqual(self.calls[0][1]["json"]["provider"], {"zdr": True, "data_collection": "deny"} | self.calls[0][1]["json"]["provider"])



if __name__ == "__main__":
    unittest.main()
