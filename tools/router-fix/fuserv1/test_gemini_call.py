#!/usr/bin/env python3
"""Tests for gemini_call.py's ZDR-assertion and shape-checking logic. NEVER makes a real API call --
`send` is always a stub. This mirrors what eta-refuter-2 already PASSed for linker's lang_judge.py
(#4182): a returned model/provider mismatch means the ZDR guarantee didn't hold, full stop, regardless
of how good the content looks.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gemini_call as gc  # noqa: E402

GOOD_CONTENT = {"copies": [], "norms": [], "gens": [{"pos": 0, "w": "hi", "reason": "greeting"}],
               "conflicts": [], "en_clauses": [], "entities": []}


def _reply(model=gc.MODEL, provider="google-ai-studio", content=None):
    return 200, {"model": model, "provider": provider,
                "choices": [{"message": {"content": json.dumps(content if content is not None else GOOD_CONTENT)}}]}


class GeminiCall(unittest.TestCase):
    def setUp(self):
        self._real_sleep = gc._sleep
        gc._sleep = lambda s: None  # every test below is offline; never actually wait through WAITS

    def tearDown(self):
        gc._sleep = self._real_sleep

    def test_good_reply_is_accepted(self):
        r = gc.call_slice({"slice": "x"}, lambda body: _reply())
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["data"], GOOD_CONTENT)

    def test_usage_block_is_passed_through_on_success(self):
        def send(body):
            status, data = _reply()
            data["usage"] = {"prompt_tokens": 1000, "completion_tokens": 200, "cost": 0.0007}
            return status, data
        r = gc.call_slice({"slice": "x"}, send)
        self.assertEqual(r["usage"], {"prompt_tokens": 1000, "completion_tokens": 200, "cost": 0.0007})

    def test_request_body_asks_openrouter_to_include_usage_cost(self):
        body = gc.request_body({"x": 1})
        self.assertEqual(body["usage"], {"include": True})

    def test_wrong_model_is_route_mismatch_even_with_good_content(self):
        r = gc.call_slice({"slice": "x"}, lambda body: _reply(model="some-other-model"))
        self.assertEqual(r["status"], "route_mismatch")
        self.assertIsNone(r["data"])

    def test_missing_provider_is_route_mismatch(self):
        status, data = _reply()
        data["provider"] = ""
        r = gc.call_slice({"slice": "x"}, lambda body: (status, data))
        self.assertEqual(r["status"], "route_mismatch")

    def test_malformed_json_content_is_bad_reply_after_retries(self):
        def send(body):
            return 200, {"model": gc.MODEL, "provider": "p", "choices": [{"message": {"content": "not json"}}]}
        r = gc.call_slice({"slice": "x"}, send)
        self.assertEqual(r["status"], "bad_reply")

    def test_wrong_shape_content_is_bad_shape_after_retries(self):
        r = gc.call_slice({"slice": "x"}, lambda body: _reply(content={"nope": True}))
        self.assertEqual(r["status"], "bad_shape")

    def test_usage_is_recorded_even_on_bad_reply_not_just_ok(self):
        # eta-refuter-2 #5179: a malformed-JSON reply is still a PAID call (real completion tokens were
        # generated even though they didn't parse) -- 8 of 222 real B4 windows lost this cost data
        # entirely before this fix, making the run's total a floor, not the true spend, with no way to
        # recover the missing amounts after the fact.
        def send(body):
            return 200, {"model": gc.MODEL, "provider": "p", "usage": {"cost": 0.004, "prompt_tokens": 900},
                        "choices": [{"message": {"content": "not json"}}]}
        r = gc.call_slice({"slice": "x"}, send)
        self.assertEqual(r["status"], "bad_reply")
        self.assertEqual(r["usage"], {"cost": 0.004, "prompt_tokens": 900})

    def test_usage_is_recorded_even_on_bad_shape(self):
        def send(body):
            status, data = _reply(content={"nope": True})
            data["usage"] = {"cost": 0.002}
            return status, data
        r = gc.call_slice({"slice": "x"}, send)
        self.assertEqual(r["status"], "bad_shape")
        self.assertEqual(r["usage"], {"cost": 0.002})

    def test_usage_is_recorded_even_on_route_mismatch(self):
        def send(body):
            status, data = _reply(model="some-other-model")
            data["usage"] = {"cost": 0.001}
            return status, data
        r = gc.call_slice({"slice": "x"}, send)
        self.assertEqual(r["status"], "route_mismatch")
        self.assertEqual(r["usage"], {"cost": 0.001})

    def test_usage_is_none_when_no_response_body_ever_existed(self):
        r = gc.call_slice({"slice": "x"}, lambda body: (503, None))
        self.assertIsNone(r["usage"])

    def test_finish_reason_captured_on_ok_reply(self):
        def send(body):
            status, data = _reply()
            data["choices"][0]["finish_reason"] = "stop"
            return status, data
        r = gc.call_slice({"slice": "x"}, send)
        self.assertEqual(r["finish_reason"], "stop")

    def test_finish_reason_captured_on_bad_reply_diagnoses_truncation(self):
        # eta-refuter-2 #5215: a bad_reply's malformed JSON might be a TRUNCATED completion
        # (finish_reason="length") rather than a genuine formatting error -- this is exactly the
        # diagnostic RUN 2 needs to report for the unexplained 5/6 latency-tail bad_reply calls.
        def send(body):
            return 200, {"model": gc.MODEL, "provider": "p",
                        "choices": [{"message": {"content": '{"native_items": [{"kind": "cop'},
                                    "finish_reason": "length"}]}
        r = gc.call_slice({"slice": "x"}, send)
        self.assertEqual(r["status"], "bad_reply")
        self.assertEqual(r["finish_reason"], "length")

    def test_finish_reason_none_when_choices_entry_malformed(self):
        def send(body):
            return 200, {"model": gc.MODEL, "provider": "p", "choices": "not-a-list"}
        r = gc.call_slice({"slice": "x"}, send)
        self.assertIsNone(r["finish_reason"])

    def test_rate_limit_retries_then_succeeds(self):
        calls = []

        def send(body):
            calls.append(1)
            if len(calls) < 3:
                return 429, None
            return _reply()
        r = gc.call_slice({"slice": "x"}, send)
        self.assertEqual(r["status"], "ok")
        self.assertEqual(len(calls), 3)

    def test_persistent_5xx_gives_up_with_http_status(self):
        r = gc.call_slice({"slice": "x"}, lambda body: (503, None))
        self.assertTrue(r["status"].startswith("http_"))

    def test_request_body_uses_zdr_provider_and_temperature_zero(self):
        body = gc.request_body({"x": 1})
        self.assertEqual(body["provider"], gc.PROVIDER)
        self.assertEqual(body["temperature"], 0)
        self.assertEqual(body["model"], gc.MODEL)

    def test_get_key_prefers_env_var(self):
        self.assertEqual(gc.get_key({"OPENROUTER_API_KEY": " secret "}), "secret")

    def test_get_key_raises_without_any_source(self):
        # matches linker's lang_judge.py behaviour exactly (reused pattern): a missing key file raises
        # FileNotFoundError, not caught into SystemExit -- only a genuinely EMPTY value raises SystemExit.
        with self.assertRaises(FileNotFoundError):
            gc.get_key({"OPENROUTER_KEY_FILE": "/nonexistent/path/xyz"})


if __name__ == "__main__":
    unittest.main()
