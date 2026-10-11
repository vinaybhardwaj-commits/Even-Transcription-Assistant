"""Jev text scoring with a fake transport. No network and no real transcript."""

from __future__ import annotations

import json

import pytest

from tools.timbre.jev_text import (
    DOUBT_REASONS,
    ENDPOINT,
    JevCallError,
    PROMPT_VERSION,
    TextLaneDisabled,
    TextLaneFlagError,
    TransportResponse,
    _mock_answers,
    cost_usd,
    questions,
    score_window,
)
from tools.timbre.text_lane import load_operator_text, main, score_rows, summarise

ENV = {
    "TIMBRE_TEXT_LANE": "1",
    "TYPESAFE_API_KEY": "test-key-not-real",
    "ETA_JEV_MODEL": "jev-1.13.0",
}
SENTENCE = "The cough is worse at night and sleep is poor."


def _ok_body(answers=None, *, tokens=100):
    payload = {
        "model": "jev-1.13.0",
        "answers": answers or _mock_answers(),
        "usage": {"input_tokens": tokens, "output_tokens": 6},
    }
    return TransportResponse(200, json.dumps(payload).encode("utf-8"))


class Script:
    def __init__(self, statuses, answers=None, body=b""):
        self.statuses = list(statuses)
        self.answers = answers
        self.fail_body = body
        self.n = 0
        self.requests = []
        self.slept = []

    def __call__(self, url, body, headers, timeout):
        self.n += 1
        self.requests.append((url, body, headers, timeout))
        status = self.statuses[min(self.n, len(self.statuses)) - 1]
        if status != 200:
            return TransportResponse(status, self.fail_body)
        return _ok_body(self.answers)

    def sleep(self, seconds):
        self.slept.append(seconds)


def test_questions_are_the_systemone_types_and_reasons_are_closed():
    qs = questions()
    assert set(qs) == {
        "timbre_valence",
        "timbre_arousal",
        "timbre_engaged",
        "timbre_resistant",
        "timbre_unresolved_doubt",
        "timbre_doubt_reason",
    }
    assert qs["timbre_valence"]["type"] == "score"
    assert len(qs["timbre_valence"]["criteria"]) == 5
    assert len(qs["timbre_arousal"]["criteria"]) == 5
    assert qs["timbre_engaged"]["type"] == "noul"
    assert qs["timbre_doubt_reason"]["type"] == "choice"
    assert set(qs["timbre_doubt_reason"]["criteria"]) == set(DOUBT_REASONS)
    assert PROMPT_VERSION == "timbre-text-v1"
    for code in DOUBT_REASONS:
        assert " " not in code


def test_gate_refuses_before_any_call():
    script = Script([200])
    with pytest.raises(TextLaneDisabled):
        score_window(SENTENCE, window_id="synth_w", env={}, transport=script)
    assert script.n == 0
    with pytest.raises(TextLaneFlagError) as exc:
        score_window(SENTENCE, window_id="synth_w", env={"TIMBRE_TEXT_LANE": "maybe"}, transport=script)
    assert "maybe" not in str(exc.value)
    assert script.n == 0


def test_request_is_text_only_and_phones_are_masked_first():
    script = Script([200])
    raw = "Ring 9876543210 about the cough."
    row = score_window(
        raw,
        window_id="synth_w",
        env=ENV,
        transport=script,
        sleep=script.sleep,
        rng=_rng(),
    )
    assert script.n == 1
    url, body, headers, _timeout = script.requests[0]
    assert url == ENDPOINT
    assert set(body) == {"model", "state", "questions"}
    assert set(body["state"]) == {"window_text"}
    assert "9876543210" not in json.dumps(body)
    assert "[PHONE]" in body["state"]["window_text"]
    assert "audio" not in body["state"]
    assert headers["Authorization"].startswith("Bearer ")
    assert row["status"] == "ok"
    assert row["valence"] == 3
    assert row["arousal"] == 2
    assert row["distress"] == 2
    assert row["engaged"] is True
    assert row["resistant"] is False
    assert row["unresolved_doubt"] == {"value": False, "reason": "none"}
    assert row["confidence"] == pytest.approx(0.7)
    assert row["cost_usd"] == pytest.approx(cost_usd(100))
    assert row["model"] == "jev-1.13.0"
    assert "9876543210" not in json.dumps(row)


def test_retries_429_and_not_401_and_drops_provider_body():
    retry = Script([429, 529, 200])
    row = score_window(SENTENCE, window_id="synth_w", env=ENV, transport=retry, sleep=retry.sleep, rng=_rng())
    assert row["status"] == "ok"
    assert retry.n == 3
    assert retry.slept  # backoff happened

    leaked = b'{"code":"bad","echo":"The cough is worse at night"}'
    deny = Script([401], body=leaked)
    with pytest.raises(JevCallError) as exc:
        score_window(SENTENCE, window_id="synth_w", env=ENV, transport=deny, sleep=deny.sleep, rng=_rng())
    assert deny.n == 1
    assert str(exc.value) == "jev http 401"
    assert "cough" not in str(exc.value)


def test_timeouts_retry_without_the_exception_text():
    class Boom:
        def __init__(self):
            self.n = 0

        def __call__(self, url, body, headers, timeout):
            self.n += 1
            if self.n < 3:
                raise RuntimeError("dial failed: The cough is worse at night")
            return _ok_body()

        def sleep(self, _s):
            return None

    boom = Boom()
    row = score_window(SENTENCE, window_id="synth_w", env=ENV, transport=boom, sleep=boom.sleep, rng=_rng())
    assert boom.n == 3
    assert row["status"] == "ok"

    class Always:
        def __call__(self, url, body, headers, timeout):
            raise RuntimeError("dial failed: The cough is worse at night")

        def sleep(self, _s):
            return None

    with pytest.raises(JevCallError) as exc:
        score_window(SENTENCE, window_id="synth_w", env=ENV, transport=Always(), sleep=lambda _s: None, rng=_rng())
    assert str(exc.value) == "jev_timeout"
    assert "cough" not in str(exc.value)


def test_cache_skips_the_second_call_and_cost_log_has_no_text(tmp_path):
    script = Script([200])
    cache = tmp_path / "text-cache"
    cost = tmp_path / "run.cost.jsonl"
    first = score_rows(
        [("synth_a", SENTENCE), ("synth_b", SENTENCE)],
        env=ENV,
        cache_dir=cache,
        cost_log=cost,
        transport=script,
        sleep=script.sleep,
        rng=_rng(),
    )
    # Same masked text shares one cache entry, so the second window is a hit.
    assert script.n == 1
    assert first[0]["cache_hit"] is False
    assert first[1]["cache_hit"] is True
    assert first[1]["input_tokens"] == 0
    again = score_window(SENTENCE, window_id="synth_c", env=ENV, cache_dir=cache, transport=script, sleep=script.sleep, rng=_rng())
    assert script.n == 1
    assert again["cache_hit"] is True
    blob = cost.read_text(encoding="utf-8")
    assert "cough" not in blob
    assert "sleep is poor" not in blob
    assert "window_text" not in blob
    summary = summarise(first)
    assert "cough" not in json.dumps(summary)
    assert summary["cache_hits"] == 1
    assert summary["input_tokens"] == 100


def test_mock_does_not_call_transport_and_is_not_a_real_model():
    def transport(*_a, **_k):
        raise AssertionError("mock opened a socket")

    env = {"TIMBRE_TEXT_LANE": "1", "TIMBRE_JEV_MOCK": "1"}
    row = score_window(SENTENCE, window_id="synth_w", env=env, transport=transport)
    assert row["status"] == "ok"
    assert row["model"] == "jev-mock"
    assert row["valence"] == 3


def test_residual_and_empty_and_quote_choice_never_leave_the_row(monkeypatch):
    calls = []

    def transport(*_a, **_k):
        calls.append(1)
        return _ok_body()

    monkeypatch.setattr(
        "tools.timbre.jev_text.mask_phi",
        lambda _text: __import__("tools.timbre.phi_mask", fromlist=["MaskResult"]).MaskResult(
            text="still has a phone", counts={}, residual=("phone",)
        ),
    )
    blocked = score_window("ignored", window_id="synth_w", env=ENV, transport=transport)
    assert blocked["status"] == "residual_phi"
    assert calls == []
    assert "phone" not in json.dumps({k: v for k, v in blocked.items() if k != "status"})

    monkeypatch.undo()
    empty = score_window("   ", window_id="synth_w", env=ENV, transport=transport)
    assert empty["status"] == "empty"
    assert calls == []

    leaked = "the patient said the pain is unbearable"
    answers = _mock_answers()
    answers["timbre_unresolved_doubt"] = {"type": "noul", "noul": 0.95}
    answers["timbre_doubt_reason"] = {"type": "choice", "choice": leaked, "confidence": 0.2, "probabilities": {}}
    script = Script([200], answers=answers)
    row = score_window(SENTENCE, window_id="synth_w", env=ENV, transport=script, sleep=script.sleep, rng=_rng())
    assert row["reason_rejected"] is True
    assert row["unresolved_doubt"]["reason"] == "cannot_tell"
    assert leaked not in json.dumps(row)
    assert row["unresolved_doubt"]["value"] is True


def test_missing_answer_is_incomplete_not_invented():
    answers = _mock_answers()
    del answers["timbre_valence"]
    script = Script([200], answers=answers)
    row = score_window(SENTENCE, window_id="synth_w", env=ENV, transport=script, sleep=script.sleep, rng=_rng())
    assert row["status"] == "incomplete"
    assert row["valence"] is None
    assert row["arousal"] is None


def test_operator_csv_and_score_cli_gate(tmp_path, monkeypatch, capsys):
    src = tmp_path / "windows.csv"
    src.write_text("window_id,text\nsynth_w,The cough is mild.\n", encoding="utf-8")
    rows = load_operator_text(src)
    assert rows == [("synth_w", "The cough is mild.")]
    monkeypatch.delenv("TIMBRE_TEXT_LANE", raising=False)
    with pytest.raises(SystemExit) as exc:
        main(["score", "--in", str(src), "--out", str(tmp_path / "scores.jsonl")])
    assert exc.value.code == 2
    assert not (tmp_path / "scores.jsonl").exists()
    err = capsys.readouterr().err
    assert "cough" not in err

    monkeypatch.setenv("TIMBRE_TEXT_LANE", "1")
    monkeypatch.setenv("TIMBRE_JEV_MOCK", "1")
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    out = tmp_path / "scores.jsonl"
    cost = tmp_path / "run.cost.jsonl"
    main(["score", "--in", str(src), "--out", str(out), "--cache", str(tmp_path / "cache"), "--cost-log", str(cost)])
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["status"] == "ok"
    assert saved["model"] == "jev-mock"
    blob = out.read_text(encoding="utf-8") + cost.read_text(encoding="utf-8") + capsys.readouterr().out
    assert "cough" not in blob


def _rng():
    import random

    return random.Random(0)
