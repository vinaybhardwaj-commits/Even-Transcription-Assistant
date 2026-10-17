#!/usr/bin/env python3
"""Tests for payload.py's prepass-output -> API-payload shaping. No REB dependency -- exercises the
shaping logic directly against a hand-built prepass_output dict (prepass.py's own real-window tests
already cover that its output has these fields; this only covers what payload.py does with them)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import payload as pl  # noqa: E402


def _prepass_output(**overrides):
    base = {
        "t0_ms": 0, "t1_ms": 10000, "core_t0_ms": 0, "core_t1_ms": 10000,
        "tracks": {"whisper-auto": {"status": "ok", "n_tokens": 2, "n_citable": 1}},
        "tokens": {"whisper-auto": [
            {"id": "0:0:0", "text": "tab", "t0_ms": 0, "t1_ms": 280, "citable": True},
            {"id": "0:0:1", "text": "later", "t0_ms": 9500, "t1_ms": 9800, "citable": False},
        ]},
        "p_en": 0.3, "top_languages": [{"lang": "hi", "p": 0.6}], "m6_language": "hi",
        "agreement": {"sravaani": {"indic-ctc-hi": 0.9}, "indic-ctc-hi": {"sravaani": 0.9}},
        "numbers": {"sravaani": []},
        "drug_candidates": {"sravaani": [
            {"whisper_span": {"text": "Pantoprazole", "tokens": [{"id": "0:0:1"}]},
            "indic_window": "पैंटोप्राजोल", "match": {"name": "pantoprazole", "sim_whisper": 0.95, "sim_indic": 0.9}},
        ]},
        "speaker": "doctor", "snr": 18.5,
    }
    base.update(overrides)
    return base


class Payload(unittest.TestCase):
    def test_only_citable_tokens_survive_and_are_trimmed_to_id_text(self):
        out = pl.build_payload(_prepass_output())
        self.assertEqual(out["tokens"]["whisper-auto"], [{"id": "0:0:0", "text": "tab"}])

    def test_engine_dropped_entirely_when_it_has_no_citable_tokens(self):
        po = _prepass_output(tokens={"whisper-auto": [
            {"id": "0:0:0", "text": "later", "t0_ms": 9500, "t1_ms": 9800, "citable": False}]})
        out = pl.build_payload(po)
        self.assertNotIn("whisper-auto", out["tokens"])

    def test_drug_candidate_flattened_to_prompt_fields_only(self):
        out = pl.build_payload(_prepass_output())
        cand = out["drug_candidates"]["sravaani"][0]
        self.assertEqual(set(cand), {"whisper_text", "indic_window", "match"})
        self.assertEqual(cand["whisper_text"], "Pantoprazole")
        self.assertEqual(cand["match"]["name"], "pantoprazole")

    def test_scalar_fields_passed_through_unchanged(self):
        out = pl.build_payload(_prepass_output())
        self.assertEqual(out["p_en"], 0.3)
        self.assertEqual(out["m6_language"], "hi")
        self.assertEqual(out["speaker"], "doctor")
        self.assertEqual(out["snr"], 18.5)
        self.assertEqual(out["slice"], {"t0_ms": 0, "t1_ms": 10000, "core_t0_ms": 0, "core_t1_ms": 10000})

    def test_no_tokens_key_at_all_is_tolerated_not_a_crash(self):
        po = _prepass_output()
        del po["tokens"]
        out = pl.build_payload(po)
        self.assertEqual(out["tokens"], {})

    def test_result_is_json_serialisable(self):
        import json
        json.dumps(pl.build_payload(_prepass_output()), ensure_ascii=False)


class PayloadLang(unittest.TestCase):
    def test_whisper_auto_tokens_carry_lang_others_do_not(self):
        out = pl.build_payload(_prepass_output(tokens={
            "whisper-auto": [{"id": "0:0:0", "text": "ye", "citable": True, "lid_detected": "hi"}],
            "whisper-forced-en": [{"id": "1:0:0", "text": "ten", "citable": True, "lid_detected": "hi"}]}))
        self.assertEqual(out["tokens"]["whisper-auto"], [{"id": "0:0:0", "text": "ye", "lang": "hi"}])
        self.assertEqual(out["tokens"]["whisper-forced-en"], [{"id": "1:0:0", "text": "ten"}])


if __name__ == "__main__":
    unittest.main()
