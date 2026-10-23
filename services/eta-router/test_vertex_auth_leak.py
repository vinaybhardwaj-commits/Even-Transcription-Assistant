# google-auth exception text never reaches translate()'s result or any log (adopted from the R2 refuter).
import io, os, sys, json, tempfile, shutil, logging, unittest, contextlib
from unittest import mock
sys.path.insert(0, os.environ.get("ETA_ROUTER_DIR", os.path.dirname(os.path.abspath(__file__))))
import router_server as rs  # noqa: E402

LEAK = "LEAKY-GA-TEXT-private_key_id-0xFEED"
HINDI = "मुझे बुखार है"

class T(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="spine-vertex-r2-oref-t-")
        self.sa = os.path.join(self.d, "sa.json")
        with open(self.sa, "w") as fh:
            json.dump({"type": "service_account", "client_email": "sa-test-fake", "private_key": "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n", "project_id": "proj-a"}, fh)
        rs._VERTEX_TOKEN_CACHE.clear()
        self.p = [mock.patch.object(rs, "VERTEX_SA_FILE", self.sa), mock.patch.object(rs, "VERTEX_PROJECT", ""),
                  mock.patch.object(rs, "TRANSLATE_ENGINE", "vertex:gemini-2.5-flash-lite"),
                  mock.patch.object(rs, "TRANSLATE_FALLBACK", ["vertex:gemini-2.5-flash"])]
        for x in self.p: x.start()
    def tearDown(self):
        for x in self.p: x.stop()
        shutil.rmtree(self.d, ignore_errors=True)
    def _run(self, exc):
        import google.oauth2.service_account as sa
        out, err = io.StringIO(), io.StringIO()
        logbuf = io.StringIO(); h = logging.StreamHandler(logbuf); logging.getLogger().addHandler(h); logging.getLogger().setLevel(logging.DEBUG)
        try:
            with mock.patch.object(sa.Credentials, "from_service_account_info", side_effect=exc), \
                 contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                 mock.patch.object(rs.requests, "post", side_effect=AssertionError("must not send")):
                r = rs.translate(HINDI, "hi")
        finally:
            logging.getLogger().removeHandler(h)
        return r, out.getvalue() + err.getvalue() + logbuf.getvalue()
    def test_R1_google_auth_exception_message_is_redacted_everywhere(self):
        for exc in (ValueError(LEAK), Exception(LEAK), RuntimeError("refresh: " + LEAK)):
            r, logs = self._run(exc)
            blob = json.dumps(r, ensure_ascii=False) + logs
            self.assertNotIn(LEAK, blob)
            self.assertIn("vertex_auth_failed:" + type(exc).__name__, r["translate_error"])
            self.assertIsNone(r["english"] if "english" in r else None)
    def test_R2_refresh_error_from_google_auth_is_class_only(self):
        from google.auth import exceptions as gae
        r, logs = self._run(gae.RefreshError(LEAK, {"error_description": LEAK}))
        self.assertNotIn(LEAK, json.dumps(r) + logs)
        self.assertIn("vertex_auth_failed:RefreshError", r["translate_error"])
