#!/usr/bin/env python3
"""
Translate backend tests.

RUN (from ~/eta-router):
    ./.venv/bin/python -m unittest test_translate -v

No network, no engines: `requests.post` is replaced per test — except D2WallClockDeadline, which runs a
real HTTP server on 127.0.0.1, because the defect it pins lives in `requests`' socket reads and a mock
cannot reproduce it. Nothing leaves the loopback interface. A fake key with a distinctive shape is
written to a temp file so the "key never leaks" tests have something unmistakable to grep for.
Test text is synthetic — never patient content.
"""
import contextlib
import http.server
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import router_server as rs  # noqa: E402
import requests  # noqa: E402

# The module's REAL defaults, captured before any test patches them. (A test that reads
# rs.TRANSLATE_ENGINE inside Base would be inspecting its own fixture, and could never catch a
# default that quietly reverted to ollama.)
DEFAULT_ENGINE = rs.TRANSLATE_ENGINE
DEFAULT_FALLBACK = list(rs.TRANSLATE_FALLBACK)

FAKE_KEY = "sk-or-v1-FAKEKEY-must-never-appear-anywhere-0123456789abcdef"
HINDI = "मुझे बुखार है"  # synthetic Devanagari


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body if body is not None else {}
    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def or_ok(text="I have a fever", model="google/gemini-2.5-flash-lite-001"):
    return Resp(200, {"model": model, "choices": [{"message": {"content": text}}]})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile("w", delete=False)
        self.tmp.write(FAKE_KEY + "\n"); self.tmp.close()
        self.patches = [
            mock.patch.object(rs, "OPENROUTER_KEY_FILE", self.tmp.name),
            mock.patch.object(rs, "TRANSLATE_ENGINE", "openrouter:google/gemini-2.5-flash-lite"),
            mock.patch.object(rs, "TRANSLATE_FALLBACK", ["openrouter:openai/gpt-5-nano", "indictrans2"]),
            mock.patch.object(rs, "INDICTRANS2_URL", "http://yoga.test:8086"),
        ]
        for p in self.patches: p.start()
        self.calls = []

    def tearDown(self):
        for p in self.patches: p.stop()
        os.unlink(self.tmp.name)

    def post(self, *responses):
        """Replace requests.post with a script of responses, recording every call."""
        seq = list(responses)
        def fake(url, **kw):
            self.calls.append({"url": url, **kw})
            r = seq.pop(0)
            if isinstance(r, Exception):
                raise r
            return r
        return mock.patch.object(rs.requests, "post", side_effect=fake)


def vx_ok(text="I have a fever", model="gemini-2.5-flash-lite"):
    return Resp(200, {"modelVersion": model, "candidates": [{"content": {"parts": [{"text": text}]}}]})


class VertexEngine(Base):
    """The vertex: engine. The network and the service-account file are mocked: no real key is read."""
    SA = '{"client_email":"sa@proj.iam.test","private_key":"FAKE-NOT-A-KEY","project_id":"proj-test"}'

    def setUp(self):
        super().setUp()
        self.sa = tempfile.NamedTemporaryFile("w", delete=False)
        self.sa.write(self.SA); self.sa.close()
        self.vp = [
            mock.patch.object(rs, "VERTEX_SA_FILE", self.sa.name),
            mock.patch.object(rs, "VERTEX_PROJECT", ""),
            mock.patch.object(rs, "VERTEX_LOCATION", "global"),
            mock.patch.object(rs, "TRANSLATE_ENGINE", "vertex:gemini-2.5-flash-lite"),
            mock.patch.object(rs, "TRANSLATE_FALLBACK", ["vertex:gemini-2.5-flash", "indictrans2"]),
        ]
        rs._VERTEX_TOKEN_CACHE.clear()
        # the token mint (google-auth) is faked at its seam: a fake credentials module
        fake_sa = mock.MagicMock()
        def from_info(info, scopes):
            c = mock.MagicMock(); c.token = "tok-not-a-secret"; c.expiry = None; c.refresh = lambda req: None
            return c
        fake_sa.Credentials.from_service_account_info.side_effect = from_info
        self.mods = mock.patch.dict(sys.modules, {
            "google": mock.MagicMock(), "google.oauth2": mock.MagicMock(service_account=fake_sa),
            "google.oauth2.service_account": fake_sa,
            "google.auth": mock.MagicMock(), "google.auth.transport": mock.MagicMock(),
            "google.auth.transport.requests": mock.MagicMock(Request=mock.MagicMock()),
        })
        for p in self.vp: p.start()
        self.mods.start()

    def tearDown(self):
        self.mods.stop()
        for p in self.vp: p.stop()
        os.unlink(self.sa.name)
        super().tearDown()

    def test_default_engine_calls_vertex_global_with_system_instruction_and_temperature_0(self):
        with self.post(vx_ok()):
            r = rs.translate(HINDI, "hi")
        self.assertEqual(r["english"], "I have a fever")
        self.assertEqual(r["translate_engine"], "vertex:gemini-2.5-flash-lite")
        c = self.calls[0]
        self.assertEqual(c["url"], "https://aiplatform.googleapis.com/v1/projects/proj-test/locations/global/publishers/google/models/gemini-2.5-flash-lite:generateContent")
        self.assertEqual(c["headers"]["Authorization"], "Bearer tok-not-a-secret")
        self.assertEqual(c["json"]["generationConfig"], {"temperature": 0})
        self.assertEqual(c["json"]["systemInstruction"]["parts"][0]["text"], rs.TRANSLATE_SYSTEM_PROMPT)
        self.assertEqual(c["json"]["contents"][0]["parts"][0]["text"], HINDI)
        self.assertNotIn("provider", c["json"])
        self.assertFalse(any("openrouter" in x["url"] for x in self.calls))

    def test_regional_location_uses_the_regional_host(self):
        with mock.patch.object(rs, "VERTEX_LOCATION", "asia-south1"), self.post(vx_ok()):
            rs.translate(HINDI, "hi")
        self.assertTrue(self.calls[0]["url"].startswith("https://asia-south1-aiplatform.googleapis.com/v1/projects/proj-test/locations/asia-south1/"))

    def test_label_is_what_the_response_reported_and_fallback_is_a_second_vertex_model(self):
        with self.post(Resp(503), vx_ok("I have a fever", "gemini-2.5-flash-002")):
            r = rs.translate(HINDI, "hi")
        self.assertEqual(r["translate_engine"], "vertex:gemini-2.5-flash")
        self.assertEqual(r["translate_model"], "gemini-2.5-flash-002")
        self.assertIn("models/gemini-2.5-flash:generateContent", self.calls[1]["url"])

    def test_pool_key_is_the_engine_string(self):
        self.assertIsNot(rs._pool_for("vertex:gemini-2.5-flash-lite"), rs._pool_for("vertex:gemini-2.5-flash"))

    def test_failure_taxonomy_closed_codes(self):
        cases = [
            (requests.Timeout("x"), "vertex_timeout"),
            (requests.ConnectionError("secret-ish detail"), "vertex_unreachable:ConnectionError"),
            (Resp(429), "vertex_http_429"),
            (Resp(200, ValueError("bad json")), "vertex_bad_response"),
            (Resp(200, {"candidates": []}), "vertex_bad_response"),
            (Resp(200, {"candidates": [{"content": {"parts": [{"text": "  "}]}}]}), "vertex_empty"),
            (Resp(200, {"candidates": [{"content": {"parts": [{"text": ["list"]}]}}]}), "vertex_bad_response"),
        ]
        for resp, code in cases:
            with self.post(resp):
                with self.assertRaises(rs.TranslateError) as cm:
                    rs.vertex_translate(HINDI, "hi", "gemini-2.5-flash-lite")
            self.assertEqual(str(cm.exception), code)
            self.assertNotIn("secret-ish", str(cm.exception))

    def test_total_failure_never_returns_source_text_as_english(self):
        with self.post(Resp(500), Resp(502), Resp(503)):
            with mock.patch.object(rs, "INDICTRANS2_URL", "http://yoga.test:8086"):
                r = rs.translate(HINDI, "hi")
        self.assertIsNone(r["english"])
        self.assertIn("vertex_http_500", r["translate_error"])

    def test_sa_file_problems_are_closed_codes_and_nothing_is_sent(self):
        for setup, code in [
            (lambda: mock.patch.object(rs, "VERTEX_SA_FILE", ""), "vertex_sa_file_unset"),
            (lambda: mock.patch.object(rs, "VERTEX_SA_FILE", "/nonexistent/sa.json"), "vertex_sa_unreadable"),
        ]:
            with setup(), self.post():
                with self.assertRaises(rs.TranslateError) as cm:
                    rs.vertex_translate(HINDI, "hi", "m")
            self.assertEqual(str(cm.exception), code)
            self.assertEqual(self.calls, [])
        with open(self.sa.name, "w") as fh: fh.write("not json")
        with self.assertRaises(rs.TranslateError) as cm: rs.vertex_translate(HINDI, "hi", "m")
        self.assertEqual(str(cm.exception), "vertex_sa_invalid")
        with open(self.sa.name, "w") as fh: fh.write('{"client_email":"a"}')
        with self.assertRaises(rs.TranslateError) as cm: rs.vertex_translate(HINDI, "hi", "m")
        self.assertEqual(str(cm.exception), "vertex_sa_invalid")

    def test_sa_file_is_read_at_call_time_so_project_follows_the_file(self):
        with self.post(vx_ok()):
            rs.translate(HINDI, "hi")
        with open(self.sa.name, "w") as fh:
            fh.write(self.SA.replace("proj-test", "proj-rotated"))
        rs._VERTEX_TOKEN_CACHE.clear()
        with self.post(vx_ok()):
            rs.translate(HINDI, "hi")
        self.assertIn("/projects/proj-rotated/", self.calls[1]["url"])

    def test_token_is_cached_per_file_version(self):
        with self.post(vx_ok(), vx_ok()):
            rs.translate(HINDI, "hi"); rs.translate(HINDI, "hi")
        import sys as _s
        mints = _s.modules["google.oauth2.service_account"].Credentials.from_service_account_info.call_count
        self.assertEqual(mints, 1)

    def test_missing_google_auth_is_a_coded_failure_not_a_crash(self):
        with mock.patch.dict(sys.modules, {"google.oauth2": None, "google.oauth2.service_account": None}), self.post():
            with self.assertRaises(rs.TranslateError) as cm:
                rs.vertex_translate(HINDI, "hi", "m")
        self.assertEqual(str(cm.exception), "vertex_auth_lib_missing")

    def test_key_material_and_token_never_reach_logs_or_results(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), self.post(Resp(500), Resp(500)):
            r = rs.translate(HINDI, "hi")
        blob = out.getvalue() + err.getvalue() + json.dumps(r, ensure_ascii=False)
        for secret in ("FAKE-NOT-A-KEY", "tok-not-a-secret", "sa@proj.iam.test"):
            self.assertNotIn(secret, blob)

    def test_override_allowlist_admits_the_configured_vertex_engines_only(self):
        with self.post():
            r = rs.translate(HINDI, "hi", "vertex:some-other-model")
        self.assertIn("engine_not_allowed:vertex:some-other-model", r["translate_error"])
        self.assertEqual(self.calls, [])

    def test_deadline_for_vertex(self):
        with mock.patch.object(rs, "VERTEX_TIMEOUT", 7.0):
            self.assertEqual(rs._deadline_for("vertex:x"), 7.0)


class Dispatch(Base):
    def test_openrouter_engine_calls_openrouter_with_its_model(self):
        with self.post(or_ok()):
            r = rs.translate(HINDI, "hi", "openrouter:google/gemini-2.5-flash-lite")
        self.assertEqual(r["english"], "I have a fever")
        self.assertEqual(self.calls[0]["url"], rs.OPENROUTER_URL)
        self.assertEqual(self.calls[0]["json"]["model"], "google/gemini-2.5-flash-lite")

    def test_indictrans2_engine_speaks_the_yoga_contract(self):
        with self.post(Resp(200, {"translation": "I have a fever", "model": "indictrans2-indic-en-1B", "ms": 80})):
            r = rs.translate(HINDI, "hi", "indictrans2")
        self.assertEqual(self.calls[0]["url"], "http://yoga.test:8086/translate")
        self.assertEqual(self.calls[0]["json"], {"text": HINDI, "src_lang": "hin_Deva", "tgt_lang": "eng_Latn"})
        self.assertEqual(r["translate_engine"], "indictrans2")

    def test_none_translates_nothing_and_calls_nothing(self):
        with self.post():
            r = rs.translate(HINDI, "hi", "none")
        self.assertIsNone(r["english"])
        self.assertEqual(r["translate_engine"], "none")
        self.assertEqual(self.calls, [])

    def test_unknown_engine_fails_by_name(self):
        # An unlisted engine is now refused by the override allow-list, before any dispatch.
        with self.post():
            r = rs.translate(HINDI, "hi", "carrierpigeon")
        self.assertIsNone(r["english"])
        self.assertIn("engine_not_allowed:carrierpigeon", r["translate_error"])
        self.assertEqual(self.calls, [])

    def test_no_default_or_fallback_is_ollama(self):
        self.assertEqual(DEFAULT_ENGINE, "vertex:gemini-2.5-flash-lite")
        self.assertEqual(DEFAULT_FALLBACK, ["vertex:gemini-2.5-flash", "indictrans2"])
        self.assertFalse(any(e.startswith("openrouter") for e in [DEFAULT_ENGINE] + DEFAULT_FALLBACK))
        self.assertFalse(any(e.startswith("ollama") for e in [DEFAULT_ENGINE] + DEFAULT_FALLBACK))

    def test_ollama_override_is_refused(self):
        # WAS "reachable only by naming it". The router has no auth, so naming it is exactly what an
        # unwanted caller would do: the override now refuses any engine the router is not configured
        # to use (Fable, 22 Sep).
        with mock.patch.object(rs, "ollama_translate", return_value="I have a fever") as ot:
            r = rs.translate(HINDI, "hi", "ollama:qwen2.5:14b")
        ot.assert_not_called()
        self.assertIsNone(r["english"])
        self.assertIn("engine_not_allowed:ollama:qwen2.5:14b", r["translate_error"])

    def test_default_flow_never_calls_ollama(self):
        with mock.patch.object(rs, "ollama_translate") as ot, self.post(or_ok()):
            rs.translate(HINDI, "hi")
        ot.assert_not_called()


class EnglishSkip(Base):
    """22 Sep ruling: skip ONLY verified English (>=90% ASCII letters AND >=20% function words).
    The language label no longer causes a skip in either direction. Test text is synthetic."""

    def assertSkipped(self, text, lang):
        with self.post():
            r = rs.translate(text, lang)
        self.assertEqual(r["translate_engine"], "skip:english", text)
        self.assertEqual(r["english"], text)
        self.assertEqual(self.calls, [])

    def assertTranslated(self, text, lang):
        with self.post(or_ok()):
            r = rs.translate(text, lang)
        self.assertNotEqual(r["translate_engine"], "skip:english", text)
        self.assertEqual(len(self.calls), 1, "it must reach the translator")
        self.assertEqual(self.calls[0]["json"]["messages"][1]["content"], text)

    def test_english_passes_the_skip(self):
        self.assertSkipped("How many days have you had the fever", "en")
        self.assertSkipped("Take one tablet twice a day after food", "en")

    def test_romanised_hindi_is_translated(self):
        # pure ASCII, pure Hindi: fails the function-word test, which is the point
        self.assertTranslated("aapko kitne din se bukhar hai", "hi")

    def test_romanised_hindi_labelled_en_is_translated(self):
        # the exact failure seen live: Whisper wrote Hindi in Latin letters AND tagged it `en`
        self.assertTranslated("mujhe kal se bukhar hai aur sir me dard hai", "en")

    def test_romanised_kannada_is_translated(self):
        self.assertTranslated("nimage eshtu dinadinda jwara ide", "kn")

    def test_malayalam_script_is_translated(self):
        self.assertTranslated("\u0d0e\u0d24\u0d4d\u0d30 \u0d26\u0d3f\u0d35\u0d38\u0d2e\u0d3e\u0d2f\u0d3f", "ml")

    def test_bengali_script_is_translated(self):
        self.assertTranslated("\u0986\u09aa\u09a8\u09be\u09b0 \u099c\u09cd\u09ac\u09b0 \u0995\u09a4 \u09a6\u09bf\u09a8", "bn")

    def test_en_label_on_non_english_script_is_still_translated(self):
        self.assertTranslated(HINDI, "en")

    def test_label_does_not_block_a_skip_the_other_way(self):
        # lx: sessions tagged kn-IN/hi-IN held English. English is skipped whatever the label says.
        self.assertSkipped("What is your name and how old are you", "kn")
        self.assertSkipped("What is your name and how old are you", "ml")

    def test_empty_segment_is_handled(self):
        with self.post():
            r = rs.translate("", "hi")
        self.assertEqual(r["english"], "")           # nothing to translate, and no error
        self.assertIsNone(r["translate_error"])
        self.assertEqual(self.calls, [])

    def test_no_letters_is_not_verified_english(self):
        # digits and punctuation only: nothing to verify, so it is not skipped as English
        self.assertFalse(rs.verified_english("... 123 ... 4.5 ..."))

    def test_ascii_threshold_is_at_least_ninety_percent(self):
        eng = "the is and to of you have what this that "   # all function words
        at_90 = eng + "\u0939" * (len([c for c in eng if c.isalpha()]) // 9)
        letters = [c for c in at_90 if c.isalpha()]
        self.assertGreaterEqual(sum(c.isascii() for c in letters) / len(letters), 0.9)
        self.assertTrue(rs.verified_english(at_90))
        below = eng + "\u0939" * (len([c for c in eng if c.isalpha()]) // 8 + 1)
        letters = [c for c in below if c.isalpha()]
        self.assertLess(sum(c.isascii() for c in letters) / len(letters), 0.9)
        self.assertFalse(rs.verified_english(below))

    def test_function_word_threshold_is_at_least_twenty_percent(self):
        self.assertTrue(rs.verified_english("the zzz zzz zzz zzz"))        # 1 of 5 = 20%
        self.assertFalse(rs.verified_english("the zzz zzz zzz zzz zzz"))   # 1 of 6 < 20%

    def test_the_label_is_not_even_read(self):
        for lang in ("en", "hi", "ml", "bn", None, ""):
            self.assertTrue(rs.verified_english("Take one tablet twice a day"), lang)
            self.assertFalse(rs.verified_english("aapko kitne din se bukhar hai"), lang)


class Fallback(Base):
    def test_5xx_falls_to_the_next_engine_in_order(self):
        with self.post(Resp(503), or_ok(model="openai/gpt-5-nano")):
            r = rs.translate(HINDI, "hi")
        self.assertEqual([c["json"].get("model") for c in self.calls],
                         ["google/gemini-2.5-flash-lite", "openai/gpt-5-nano"])
        self.assertEqual(r["translate_engine"], "openrouter:openai/gpt-5-nano")

    def test_timeout_falls_through_to_indictrans2_last(self):
        with self.post(requests.Timeout(), requests.Timeout(),
                       Resp(200, {"translation": "I have a fever", "model": "it2"})):
            r = rs.translate(HINDI, "hi")
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(self.calls[2]["url"], "http://yoga.test:8086/translate")
        self.assertEqual(r["translate_engine"], "indictrans2")

    def test_empty_answer_is_a_failure_not_a_translation(self):
        with self.post(or_ok(text="   "), or_ok(model="openai/gpt-5-nano")):
            r = rs.translate(HINDI, "hi")
        self.assertEqual(r["translate_engine"], "openrouter:openai/gpt-5-nano")

    def test_total_failure_is_None_with_an_error_NEVER_the_source_text(self):
        with self.post(Resp(500), Resp(502), Resp(503)):
            r = rs.translate(HINDI, "hi")
        self.assertIsNone(r["english"])
        self.assertNotEqual(r["english"], HINDI)
        self.assertIn("all_engines_failed", r["translate_error"])
        for code in ("openrouter_http_500", "openrouter_http_502", "indictrans2_http_503"):
            self.assertIn(code, r["translate_error"])

    def test_override_means_that_engine_only_no_fallback(self):
        with self.post(Resp(503)):
            r = rs.translate(HINDI, "hi", "openrouter:openai/gpt-5-nano")
        self.assertEqual(len(self.calls), 1)
        self.assertIsNone(r["english"])


class LabelFromResponse(Base):
    def test_model_label_is_what_the_RESPONSE_reported(self):
        with self.post(or_ok(model="google/gemini-2.5-flash-lite-preview-09-2025")):
            r = rs.translate(HINDI, "hi")
        self.assertEqual(r["translate_model"], "google/gemini-2.5-flash-lite-preview-09-2025")
        self.assertNotEqual(r["translate_model"], "google/gemini-2.5-flash-lite")

    def test_engine_label_is_the_one_that_answered_not_the_default(self):
        with self.post(Resp(500), or_ok(model="openai/gpt-5-nano-2025")):
            r = rs.translate(HINDI, "hi")
        self.assertEqual(r["translate_engine"], "openrouter:openai/gpt-5-nano")
        self.assertEqual(r["translate_model"], "openai/gpt-5-nano-2025")

    def test_ms_is_recorded(self):
        with self.post(or_ok()):
            r = rs.translate(HINDI, "hi")
        self.assertIsInstance(r["translate_ms"], int)

    def test_window_summary_is_derived_from_segments(self):
        s = rs.summarise_translation([
            {"translate_engine": "openrouter:a", "translate_model": "a-1", "translate_ms": 10, "translate_error": None},
            {"translate_engine": "indictrans2", "translate_model": "it2", "translate_ms": 5, "translate_error": None},
        ])
        self.assertEqual(s["translate_engine"], "indictrans2,openrouter:a")
        self.assertEqual(s["translate_ms"], 15)
        self.assertIsNone(s["translate_error"])


class ZDR(Base):
    def test_every_openrouter_body_carries_zdr_and_deny(self):
        with self.post(Resp(503), or_ok()):
            rs.translate(HINDI, "hi")
        self.assertEqual(len(self.calls), 2)
        for c in self.calls:
            self.assertEqual(c["json"]["provider"], {"zdr": True, "data_collection": "deny"})
            self.assertEqual(c["json"]["temperature"], 0)

    def test_the_prompt_forbids_summarising_and_protects_english(self):
        with self.post(or_ok()):
            rs.translate(HINDI, "hi")
        system = self.calls[0]["json"]["messages"][0]["content"].lower()
        for must in ("never summarise", "unchanged", "drug names", "units", "only the translation"):
            self.assertIn(must, system)


class KeyNeverLeaks(Base):
    def _capture(self, fn):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            res = fn()
        return res, out.getvalue() + err.getvalue()

    def test_key_is_sent_only_in_the_authorization_header(self):
        with self.post(or_ok()):
            rs.translate(HINDI, "hi")
        c = self.calls[0]
        self.assertEqual(c["headers"]["Authorization"], f"Bearer {FAKE_KEY}")
        self.assertNotIn(FAKE_KEY, json.dumps(c["json"]))
        self.assertNotIn(FAKE_KEY, c["url"])

    def test_key_never_in_logs_or_errors_on_any_failure(self):
        for failure in (Resp(401), Resp(500), requests.Timeout(),
                        requests.ConnectionError(f"boom {FAKE_KEY}"), Resp(200, ValueError("bad json"))):
            with self.subTest(failure=type(failure).__name__):
                with self.post(failure, failure, Resp(503)):
                    res, log = self._capture(lambda: rs.translate(HINDI, "hi"))
                self.assertNotIn(FAKE_KEY, log)
                self.assertNotIn(FAKE_KEY, json.dumps(res))

    def test_key_never_reaches_argv(self):
        seen = []
        real_run, real_popen = subprocess.run, subprocess.Popen
        def spy(argv, *a, **k):
            seen.append(argv)
            return real_run(["true"])
        with mock.patch.object(subprocess, "run", side_effect=spy), \
             mock.patch.object(subprocess, "Popen", side_effect=lambda *a, **k: seen.append(a) or real_popen(["true"])), \
             self.post(or_ok()):
            rs.translate(HINDI, "hi")
        self.assertNotIn(FAKE_KEY, json.dumps([str(x) for x in seen]))
        self.assertNotIn(FAKE_KEY, " ".join(sys.argv))

    def test_key_is_read_at_call_time_not_cached(self):
        with self.post(or_ok()):
            rs.translate(HINDI, "hi")
        with open(self.tmp.name, "w") as fh:
            fh.write("sk-or-v1-ROTATED\n")
        with self.post(or_ok()):
            rs.translate(HINDI, "hi")
        self.assertEqual(self.calls[1]["headers"]["Authorization"], "Bearer sk-or-v1-ROTATED")

    def test_missing_key_file_is_an_engine_failure_not_a_crash(self):
        with mock.patch.object(rs, "OPENROUTER_KEY_FILE", "/nonexistent/key"), \
             self.post(Resp(200, {"translation": "I have a fever", "model": "it2"})):
            r = rs.translate(HINDI, "hi")
        self.assertEqual(r["translate_engine"], "indictrans2")


if __name__ == "__main__":
    unittest.main(verbosity=2)


# --------------------------------------------------------------------------- #
# THE FLOW. `translate()` passing in isolation says nothing about what reaches transcript_english.
# These drive the REAL transcribe_norm_wav and run_job with only segment production and HTTP faked.
# --------------------------------------------------------------------------- #
class FlowBase(Base):
    SEGS = [
        {"start_s": 0.0, "end_s": 3.0, "lang": "hi", "engine": "sravaani", "text": HINDI},
        {"start_s": 3.0, "end_s": 6.0, "lang": "en", "engine": "whisper", "text": "Take one tablet"},
    ]

    def window(self, segs=None):
        segs = segs if segs is not None else [dict(s) for s in self.SEGS]
        spans = [(s["start_s"], s["end_s"]) for s in segs]
        by_start = {s["start_s"]: s for s in segs}
        return [
            mock.patch.object(rs, "wav_duration_s", return_value=6.0),
            mock.patch.object(rs, "vad_segments", return_value=(spans, "silero-vad")),
            mock.patch.object(rs, "slice_wav", return_value=None),
            mock.patch.object(rs, "is_near_silent_wav", return_value=(False, 0.1, 0.5)),
            mock.patch.object(rs, "process_segment",
                              side_effect=lambda sw, s, e, c: dict(by_start[s])),
        ]

    def run_window(self, *responses, engine=None, segs=None):
        with contextlib.ExitStack() as st:
            for p in self.window(segs):
                st.enter_context(p)
            st.enter_context(self.post(*responses))
            return rs.transcribe_norm_wav("/dev/null", ["whisper"], True, engine)


class WindowFlow(FlowBase):
    def test_translated_window_joins_english_and_carries_labels(self):
        r = self.run_window(or_ok(text="I have a fever", model="gemini-flash-lite-001"))
        self.assertEqual(r["transcript_english"], "I have a fever\nTake one tablet")
        self.assertEqual(r["translate_engine"], "openrouter:google/gemini-2.5-flash-lite,skip:english")
        self.assertEqual(r["translate_model"], "gemini-flash-lite-001")
        self.assertIsNone(r["translate_error"])
        self.assertEqual(r["segments"][0]["translate_engine"], "openrouter:google/gemini-2.5-flash-lite")
        self.assertEqual(r["segments"][1]["translate_engine"], "skip:english")

    def test_a_failed_segment_makes_the_window_english_None_NOT_the_source(self):
        # the Hindi segment fails every engine; the English one would have been fine
        r = self.run_window(Resp(500), Resp(500), Resp(500))
        self.assertIsNone(r["transcript_english"])
        self.assertIn("1 of 2 segments failed", r["translate_error"])
        self.assertNotIn(HINDI, json.dumps(r["transcript_english"]))
        # and the partial English is NOT returned with a silent hole in it
        self.assertNotEqual(r["transcript_english"], "Take one tablet")

    def test_translate_off_writes_None_and_calls_nothing(self):
        with contextlib.ExitStack() as st:
            for p in self.window():
                st.enter_context(p)
            st.enter_context(self.post())
            r = rs.transcribe_norm_wav("/dev/null", ["whisper"], False)
        self.assertIsNone(r["transcript_english"])
        self.assertEqual(self.calls, [])

    def test_the_override_reaches_every_segment(self):
        r = self.run_window(Resp(200, {"translation": "I have a fever", "model": "it2"}), engine="indictrans2")
        self.assertEqual(self.calls[0]["url"], "http://yoga.test:8086/translate")
        self.assertEqual(r["segments"][0]["translate_engine"], "indictrans2")

    def test_no_speech_result_still_carries_the_label_fields(self):
        with mock.patch.object(rs, "wav_duration_s", return_value=6.0), \
             mock.patch.object(rs, "vad_segments", return_value=([], "fixed-window")):
            r = rs.transcribe_norm_wav("/dev/null", ["whisper"], True)
        for k in ("translate_engine", "translate_model", "translate_ms", "translate_error"):
            self.assertIn(k, r)


class JobFlow(Base):
    """run_job accumulates sub-windows. It used to skip one whose English was empty — which, once
    English can be None on failure, would drop that stretch from the job without a word."""

    def run_job_with(self, windows):
        written = []
        it = iter(windows)
        with mock.patch.object(rs, "_download"), \
             mock.patch.object(rs, "normalize_to_wav"), \
             mock.patch.object(rs.subprocess, "run"), \
             mock.patch.object(rs.glob, "glob", return_value=[f"/w{i}.wav" for i in range(len(windows))]), \
             mock.patch.object(rs, "transcribe_norm_wav", side_effect=lambda *a, **k: next(it)), \
             mock.patch.object(rs, "_write_job", side_effect=lambda jid, j: written.append(json.loads(json.dumps(j)))):
            rs.run_job("j1", "http://audio", ["whisper"], True, 900.0)
        return written[-1]

    @staticmethod
    def win(english, error=None, engine="openrouter:x", model="x-1"):
        return {"segments": [], "language_timeline": [], "transcript_native": "native",
                "transcript_english": english, "translate_engine": engine, "translate_model": model,
                "translate_ms": 7, "translate_error": error, "status": "ok",
                "segmentation": {"n_engine_segments": 1, "n_segments": 1, "method": "silero-vad"}}

    def test_one_failed_sub_window_fails_the_jobs_english_it_is_not_skipped(self):
        job = self.run_job_with([self.win("first part"), self.win(None, error="1 of 1 segments failed: x")])
        self.assertEqual(job["state"], "done")
        self.assertIsNone(job["transcript_english"])
        self.assertIn("1 of 2 windows failed", job["translate_error"])
        self.assertNotEqual(job["transcript_english"], "first part")   # no silent hole

    def test_all_good_joins_and_labels_across_windows(self):
        job = self.run_job_with([self.win("one", engine="openrouter:a", model="a-1"),
                                 self.win("two", engine="indictrans2", model="it2")])
        self.assertEqual(job["transcript_english"], "one\ntwo")
        self.assertIsNone(job["translate_error"])
        self.assertEqual(job["translate_engine"], "indictrans2,openrouter:a")
        self.assertEqual(job["translate_model"], "a-1,it2")
        self.assertEqual(job["translate_ms"], 14)


# --------------------------------------------------------------------------- #
# translate-hardening (Fable, 22 Sep): D1, D2, D4 and the override allow-list.
# ETA-Refuter's verdict: docs/handoff/ETA-TRANSLATE-BACKENDS-REFUTER-22-SEP-2026.md (EvenScribe repo).
# --------------------------------------------------------------------------- #
def or_content(content, model="google/gemini-2.5-flash-lite-001"):
    return Resp(200, {"model": model, "choices": [{"message": {"content": content}}]})


class D1NonStringContent(Base):
    """A non-string `content` is a bad response that falls through — never an escape."""

    def test_list_content_falls_through_to_the_next_engine(self):
        with self.post(or_content([{"type": "text", "text": "I have a fever"}]),
                       or_ok(model="openai/gpt-5-nano")):
            r = rs.translate(HINDI, "hi")
        self.assertEqual(r["translate_engine"], "openrouter:openai/gpt-5-nano")
        self.assertEqual(r["english"], "I have a fever")

    def test_non_string_content_is_named_a_bad_response(self):
        # Distinguishes the LOCAL guard (openrouter_bad_response) from the shared catch-all.
        with self.post(or_content([1, 2]), or_content(42), Resp(503)):
            r = rs.translate(HINDI, "hi")
        self.assertIsNone(r["english"])
        self.assertEqual(r["translate_error"].count("openrouter_bad_response"), 2)

    def test_null_content_is_still_empty(self):
        with self.post(or_content(None), or_ok(model="openai/gpt-5-nano")):
            r = rs.translate(HINDI, "hi", "openrouter:google/gemini-2.5-flash-lite")
        self.assertIn("openrouter_empty", r["translate_error"])

    def test_an_unexpected_exception_never_escapes_and_falls_through(self):
        with self.post(RuntimeError("boom"), or_ok(model="openai/gpt-5-nano")):
            r = rs.translate(HINDI, "hi")   # must not raise
        self.assertEqual(r["translate_engine"], "openrouter:openai/gpt-5-nano")
        self.assertIsNone(r["translate_error"])

    def test_an_unexpected_exception_reports_its_class_only(self):
        with self.post(RuntimeError("SECRET-TEXT-9f3"), RuntimeError("SECRET-TEXT-9f3"), Resp(503)):
            r = rs.translate(HINDI, "hi")
        self.assertIn("unexpected:RuntimeError", r["translate_error"])
        self.assertNotIn("SECRET-TEXT-9f3", r["translate_error"])


class _Trickle(http.server.BaseHTTPRequestHandler):
    """Sends headers, most of a valid body at once, then the LAST 16 bytes one every DELAY s —
    ETA-Refuter's D2 fake: without a wall-clock bound it succeeds at ~8 s against a 1 s timeout."""
    DELAY = 0.5
    STOP = None  # a threading.Event, set per server so a finished test stops the trickle

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(n)
        body = json.dumps({"model": "trickle-model",
                           "choices": [{"message": {"content": "I have a fever"}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        head, tail = body[:-16], body[-16:]
        self.wfile.write(head); self.wfile.flush()
        for b in tail:
            if type(self).STOP.is_set():
                return
            if self.DELAY:
                type(self).STOP.wait(self.DELAY)
            try:
                self.wfile.write(bytes([b])); self.wfile.flush()
            except OSError:
                return

    def log_message(self, *a):
        pass


class D2WallClockDeadline(Base):
    """A REAL local HTTP server, not a mock: `requests`' per-read timeout is what D2 is about."""

    def serve(self, delay):
        stop = threading.Event()
        handler = type("H", (_Trickle,), {"DELAY": delay, "STOP": stop})
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        def done():
            stop.set(); srv.shutdown(); srv.server_close()
        self.addCleanup(done)
        for p in (mock.patch.object(rs, "OPENROUTER_URL", f"http://127.0.0.1:{srv.server_address[1]}/v1"),
                  mock.patch.object(rs, "OPENROUTER_TIMEOUT", 1.0)):
            p.start(); self.addCleanup(p.stop)

    def test_a_trickle_fails_at_the_deadline_not_at_eight_seconds(self):
        self.serve(0.5)
        t0 = time.monotonic()
        r = rs.translate(HINDI, "hi", "openrouter:google/gemini-2.5-flash-lite")
        took = time.monotonic() - t0
        self.assertIsNone(r["english"])
        self.assertIn("openrouter_deadline", r["translate_error"])
        self.assertGreaterEqual(took, 0.9)
        self.assertLess(took, 2.0, f"took {took:.2f}s against a 1 s deadline")

    def test_a_prompt_server_still_succeeds_through_the_real_network_path(self):
        self.serve(0)
        r = rs.translate(HINDI, "hi", "openrouter:google/gemini-2.5-flash-lite")
        self.assertEqual(r["english"], "I have a fever")
        self.assertEqual(r["translate_model"], "trickle-model")


class D4RomanisedIndicVeto(Base):
    """ETA-Refuter's ten synthetic non-English cases must ALL translate; true English must skip."""
    # Borrowed, not inherited: subclassing EnglishSkip would run its whole suite a second time.
    assertSkipped = EnglishSkip.assertSkipped
    assertTranslated = EnglishSkip.assertTranslated
    KANNADA = "ನಿಮಗೆ ಜ್ವರ ಇದೆ"
    MALAYALAM = "എത്ര ദിവസമായി"
    TEN = [
        ("aapko kitne din se bukhar hai", "hi"),
        ("main to ghar ja raha hoon", "hi"),
        (KANNADA, "en"),
        (MALAYALAM, "ml"),
        ("is ka matlab kya hai", "hi"),
        ("vo kal hospital me the", "hi"),
        ("hum wahan the", "hi"),
        ("mujhe two days se fever hai", "hi"),
        ("subah morning me take karta hoon", "hi"),
        ("haan ok ok theek hai", "hi"),
    ]

    def test_all_ten_refuter_cases_translate(self):
        for text, lang in self.TEN:
            self.calls = []
            self.assertTranslated(text, lang)

    def test_refuter_true_english_still_skips(self):
        self.assertSkipped("take paracetamol 500 mg twice a day after food", "en")
        self.calls = []
        self.assertSkipped("how many days have you had this fever", "en")

    def test_one_veto_token_is_enough(self):
        # Without the veto this skips (5 of 7 are function words); `hai` alone must stop it.
        self.assertTrue(rs.verified_english("take the tablet twice a day"))
        self.assertFalse(rs.verified_english("take the tablet twice a day hai"))

    def test_english_overlap_words_do_not_veto(self):
        self.assertSkipped("Give it to me, is that the right dose", "en")

    def test_the_veto_list_holds_no_common_english_word(self):
        for w in ("to", "is", "the", "me", "main", "sir", "a", "i", "it", "in", "on", "be", "no"):
            self.assertNotIn(w, rs.ROMANISED_INDIC_VETO, w)


class OverrideAllowList(Base):
    """The per-request override may name only the configured default, the fallback chain, or
    indictrans2. The router has no auth on its own routes."""

    def test_an_arbitrary_openrouter_model_is_refused_and_calls_nothing(self):
        with self.post():
            r = rs.translate(HINDI, "hi", "openrouter:some/other-model")
        self.assertIsNone(r["english"])
        self.assertIn("engine_not_allowed:openrouter:some/other-model", r["translate_error"])
        self.assertEqual(self.calls, [])

    def test_the_default_and_the_fallback_are_allowed(self):
        for eng in ("openrouter:google/gemini-2.5-flash-lite", "openrouter:openai/gpt-5-nano"):
            self.calls = []
            with self.post(or_ok()):
                r = rs.translate(HINDI, "hi", eng)
            self.assertEqual(r["translate_engine"], eng)

    def test_indictrans2_is_allowed_even_when_not_configured(self):
        with mock.patch.object(rs, "TRANSLATE_FALLBACK", ["openrouter:openai/gpt-5-nano"]), \
             self.post(Resp(200, {"translation": "I have a fever", "model": "it2"})):
            r = rs.translate(HINDI, "hi", "indictrans2")
        self.assertEqual(r["translate_engine"], "indictrans2")

    def test_ollama_is_allowed_when_it_IS_the_configured_default(self):
        with mock.patch.object(rs, "TRANSLATE_ENGINE", "ollama:qwen2.5:14b"), \
             mock.patch.object(rs, "ollama_translate", return_value="I have a fever") as ot:
            r = rs.translate(HINDI, "hi", "ollama:qwen2.5:14b")
        ot.assert_called_once()
        self.assertEqual(r["translate_engine"], "ollama:qwen2.5:14b")

    def test_a_refused_override_is_refused_even_for_english_text(self):
        with self.post():
            r = rs.translate("Take one tablet twice a day", "en", "ollama:qwen2.5:14b")
        self.assertIsNone(r["english"])
        self.assertIn("engine_not_allowed", r["translate_error"])

    def test_the_refusal_bounds_what_it_echoes(self):
        with self.post():
            r = rs.translate(HINDI, "hi", "openrouter:" + "x" * 500)
        self.assertLessEqual(len(r["translate_error"]), len("engine_not_allowed:") + 80)


# --------------------------------------------------------------------------- #
# translate-pools (Fable, 22 Sep, round 4): a per-engine pool for every backend, so a primary
# engine that only drips bytes (never tripping `requests`' own per-read timeout) can never starve
# a healthy fallback's workers. ETA-Refuter's finding: docs/handoff/
# ETA-TRANSLATE-HARDENING-REFUTER-22-SEP-2026.md, section D2 ("requests calls can't be cancelled,
# so ... the HEALTHY fallback engine gets queued and cancelled at its own deadline").
# --------------------------------------------------------------------------- #
class H9CancelPinned(Base):
    """ETA-Refuter's surviving mutation H9: dropping `fut.cancel()` in `_call_backend`'s
    FuturesTimeout handler. Removing it does not fail the call that just timed out — `fut.result`
    has already raised by the time `cancel()` runs — so a plain pass/fail on `translate()`'s
    outcome would not catch H9's removal (that is WHY it survived). Pinned directly: assert the
    cancel call actually happens."""

    def test_a_timed_out_call_is_cancelled(self):
        import concurrent.futures as cf
        seen = []
        real_cancel = cf.Future.cancel
        def spy_cancel(fut_self):
            seen.append(fut_self)
            return real_cancel(fut_self)
        with mock.patch.object(rs, "OPENROUTER_TIMEOUT", 0.05), \
             mock.patch.object(rs, "_dispatch", side_effect=lambda *a, **k: time.sleep(0.5)), \
             mock.patch.object(cf.Future, "cancel", spy_cancel):
            with self.assertRaises(rs.TranslateError):
                rs._call_backend("openrouter:google/gemini-2.5-flash-lite", "text", "hi")
        self.assertEqual(len(seen), 1,
                         "fut.cancel() must be called when a backend call times out (H9)")


class _DualBehaviorOpenRouter(http.server.BaseHTTPRequestHandler):
    """A single fake OpenRouter endpoint, distinguishing requests by the `model` field in the body:
    the SICK model drips one byte every DELAY s and NEVER completes (an abandoned worker, not a
    slow-but-finishing one — the real shape of ETA-Refuter's round-4 failure); every other model
    answers immediately. Real sockets, on purpose: the pool-isolation defect lives in how many
    genuinely blocked `requests` calls one pool can absorb before it starves a healthy engine, and
    a mock never blocks a worker thread."""
    SICK_MODEL = None
    DELAY = 0.5
    STOP = None  # a threading.Event, set per server so a finished test stops the drip

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        try:
            model = json.loads(raw).get("model")
        except (ValueError, AttributeError):
            model = None
        if model == type(self).SICK_MODEL:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            while not type(self).STOP.is_set():
                try:
                    self.wfile.write(b"x")
                    self.wfile.flush()
                except OSError:
                    return
                type(self).STOP.wait(self.DELAY)
            return
        body = json.dumps({"model": model,
                           "choices": [{"message": {"content": "I have a fever"}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class D2PoolIsolation(Base):
    """ETA-Refuter's round-4 reproduction: a real local server whose PRIMARY model drips forever;
    its FALLBACK model is healthy. 5 rounds of 3 CONCURRENT segments each (the exact shape
    `transcribe_norm_wav` uses: `ThreadPoolExecutor(max_workers=MAX_INFLIGHT).map(translate, ...)`
    per window), 1 s deadline. Under the OLD single shared pool (12 workers, `max(8, 4 *
    MAX_INFLIGHT * MAX_WINDOWS_INFLIGHT)`), by round 4 the 12 slots are all held by abandoned
    primary calls (4 rounds x 3) and the fallback's own calls queue behind them, cancelled at
    their own deadline — every window's English comes back null, exactly as ETA-Refuter found.
    With one pool PER ENGINE, the fallback's pool is never touched by the primary's failure: every
    round must translate via the fallback, 0 nulls, across all 5 rounds."""

    def test_five_rounds_of_three_segments_all_reach_the_healthy_fallback(self):
        stop = threading.Event()
        sick_model = "google/gemini-2.5-flash-lite"  # DEFAULT_ENGINE's model, set in Base.setUp
        handler = type("H", (_DualBehaviorOpenRouter,), {"SICK_MODEL": sick_model, "STOP": stop})
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        def done():
            stop.set(); srv.shutdown(); srv.server_close()
        self.addCleanup(done)
        for p in (mock.patch.object(rs, "OPENROUTER_URL", f"http://127.0.0.1:{srv.server_address[1]}/v1"),
                  mock.patch.object(rs, "OPENROUTER_TIMEOUT", 1.0),
                  mock.patch.object(rs, "INDICTRANS2_TIMEOUT", 1.0)):
            p.start(); self.addCleanup(p.stop)

        nulls = 0
        engines_used = []
        for rnd in range(5):
            with rs.ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(lambda _: rs.translate(HINDI, "hi"), range(3)))
            for r in results:
                if r["english"] is None:
                    nulls += 1
                else:
                    engines_used.append(r["translate_engine"])
        self.assertEqual(nulls, 0,
                         "every segment in every one of the 5 rounds must translate via the "
                         "healthy fallback, not come back null")
        self.assertEqual(len(engines_used), 15)
        self.assertTrue(all(e == "openrouter:openai/gpt-5-nano" for e in engines_used),
                        f"expected every success via the fallback, got {set(engines_used)}")
