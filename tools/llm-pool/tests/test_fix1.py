"""llm-pool-fix1: regression tests for the refute findings (A1 A2 A5 B1 B2 C1 D1 D2 D3) and the per-caller cap."""
import json
import os
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import requests

from llm_pool import convert
from llm_pool.auth import BedrockSession
from llm_pool.callers import CallerError, add_caller
from llm_pool.config import ConfigError, load_config, resolve_model
from llm_pool.errors import UpstreamError
from llm_pool.ledger import Ledger
from llm_pool.server import create_app
from llm_pool.upstream import BedrockUpstream, VertexTransport, VertexUpstream

from fakes import (
    FakeBedrockAuth,
    FakeBedrockTransport,
    FakeClientError,
    FakeVertexAuth,
    FakeVertexTransport,
    GatewayServer,
    bedrock_text_events,
    bedrock_text_response,
    gemini_text_response,
    gemini_tool_response,
    parse_sse,
)
from test_server import TOKEN, Kit, chat_body, seed_usd  # noqa: F401  (fixtures: config, ledger, serve)
from test_server import config, ledger, serve  # noqa: F401,E402


def wait_for(predicate, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    return predicate()


def rows(ledger):
    cur = ledger._conn.execute(
        "SELECT caller, principal, provider, in_tokens, out_tokens, est_usd, basis FROM spend ORDER BY id")
    return cur.fetchall()


# ---------------------------------------------------------------- A1 atomic cap

def test_a1_concurrent_calls_cannot_overshoot_cap(serve, ledger):
    seed_usd(ledger, 490.0)  # USD 10 headroom
    kit = serve(response=bedrock_text_response("ok", 10, 10))
    kit.transport.delay = 0.6  # keep all eight calls in flight together
    results = []
    lock = threading.Lock()

    def go():
        # opus, max_tokens 40000 -> worst case USD 3.00 per call, so at most 3 fit under USD 10
        status, _ = kit.post_json(chat_body(model="opus", max_tokens=40000))
        with lock:
            results.append(status)

    threads = [threading.Thread(target=go) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count(200) <= 3, results
    assert results.count(429) >= 5, results
    assert len(kit.transport.calls) == results.count(200)


def test_a1_settles_to_actual_and_frees_reservation(serve, ledger):
    seed_usd(ledger, 499.0)
    kit = serve(response=bedrock_text_response("ok", 10, 10))
    # worst case for haiku with 100k max_tokens is USD 0.50, which does not fit in USD 1.00 twice at once
    # but does fit sequentially once the first call settles to its tiny actual cost.
    for _ in range(4):
        status, _ = kit.post_json(chat_body(model="haiku", max_tokens=150000))
        assert status == 200
    assert kit.server.get("/spend")[1]["callers"][0]["reserved_usd"] == 0.0


# ---------------------------------------------------------------- A2 aborted streams never bill 0

def test_a2_client_abort_still_bills_from_metadata(serve, ledger):
    gate = threading.Event()
    events = bedrock_text_events(("a", "b", "c"), in_tokens=1234, out_tokens=56)
    kit = serve(events=events)
    kit.transport.gate = gate
    kit.transport.gate_after = 4
    response = kit.server.post("/v1/chat/completions", chat_body(model="haiku", stream=True), stream=True)
    iterator = response.iter_lines()
    for _ in range(3):
        next(iterator)
    response.close()  # client goes away before the metadata event
    time.sleep(0.2)
    gate.set()
    assert wait_for(lambda: rows(ledger)), "no ledger row after abort"
    row = rows(ledger)[-1]
    assert row[3] == 1234 and row[4] == 56
    assert row[5] > 0 and row[6] == "actual"


def test_a2_broken_stream_bills_reservation_not_zero(serve, ledger):
    kit = serve(events=bedrock_text_events(("a", "b"), in_tokens=7, out_tokens=2))
    kit.transport.break_after = 3  # dies before the metadata event, after Bedrock accepted the call
    response = kit.post(chat_body(model="haiku", stream=True, max_tokens=1000))
    assert "[DONE]" in response.text
    assert wait_for(lambda: rows(ledger))
    row = rows(ledger)[-1]
    assert row[6] == "reserved"
    assert row[5] > 0 and row[4] == 1000


def test_a2_rejected_call_is_not_billed(serve, ledger):
    kit = serve(stream_error=FakeClientError("ThrottlingException", "slow"))
    kit.post(chat_body(model="haiku", stream=True))
    assert wait_for(lambda: rows(ledger))
    row = rows(ledger)[-1]
    assert row[5] == 0.0 and row[6] == "none"


def test_a2_accepted_without_usage_bills_reservation(serve, ledger):
    response = bedrock_text_response("ok")
    del response["usage"]
    kit = serve(response=response)
    status, _ = kit.post_json(chat_body(model="haiku", max_tokens=2000))
    assert status == 200
    row = rows(ledger)[-1]
    assert row[6] == "reserved" and row[5] > 0


def test_billed_call_with_failed_conversion_still_writes_row(serve, ledger, monkeypatch):
    def boom(*a, **k):
        raise UpstreamError(502, "bad shape", "upstream_error")

    monkeypatch.setattr(convert, "bedrock_result_to_openai", boom)
    kit = serve(response=bedrock_text_response("ok", 321, 12))
    status, _ = kit.post_json(chat_body(model="haiku"))
    assert status == 502
    row = rows(ledger)[-1]
    assert row[3] == 321 and row[4] == 12 and row[5] > 0 and row[6] == "actual"


# ---------------------------------------------------------------- A5 Vertex model id

EVIL_IDS = [
    "gemini/../../../anthropic/models/claude-opus-4-7:rawPredict?x=",
    "gemini-2.5-pro/../../x",
    "gemini-2.5-pro:rawPredict",
    "gemini-2.5-pro?x=1",
    "gemini-2.5-pro#x",
    "gemini-x/y",
    "gemini-9-unknown",
    "gemini..",
]


@pytest.mark.parametrize("name", EVIL_IDS)
def test_a5_resolve_model_refuses_traversal_and_unknown(config, name):
    assert resolve_model(config, name) is None


def test_a5_known_gemini_still_resolves_and_is_priced(config):
    spec = resolve_model(config, "gemini-2.5-pro")
    assert spec.provider == "vertex" and spec.price_family == "gemini"


@pytest.mark.parametrize("name", EVIL_IDS)
def test_a5_gateway_never_calls_vertex_for_evil_id(serve, name):
    kit = serve()
    status, body = kit.post_json(chat_body(model=name))
    assert status == 404
    assert kit.vtransport.calls == []


@pytest.mark.parametrize("model_id", ["gemini/../../x", "gemini-2.5-pro:rawPredict", "gemini-a?b", "../gemini-1"])
def test_a5_vertex_transport_url_rejects_bad_id(model_id):
    transport = VertexTransport(FakeVertexAuth())
    with pytest.raises(UpstreamError):
        transport._url(model_id, "generateContent")
    assert "gemini-2.5-pro:generateContent" in transport._url("gemini-2.5-pro", "generateContent")


def test_a5_config_rejects_bad_model_ids(tmp_path):
    for provider, model_id in (("vertex", "gemini/../../x"), ("bedrock", "global.anthropic.claude-opus-5-5/../x")):
        path = tmp_path / "c.json"
        path.write_text(json.dumps({"models": {"x": {"provider": provider, "model_id": model_id, "price": "haiku"}}}))
        with pytest.raises(ConfigError):
            load_config(path)


# ---------------------------------------------------------------- C1 repr

def test_c1_session_repr_hides_secrets():
    session = BedrockSession(access_key_id="AKIAFAKEFAKEFAKE", secret_access_key="SECRET-VALUE-XYZ",
                             session_token="TOKEN-VALUE-XYZ", region="us-east-1", expires_at=1.0)
    text = repr(session) + str(session)
    assert "SECRET-VALUE-XYZ" not in text and "TOKEN-VALUE-XYZ" not in text


# ---------------------------------------------------------------- B2 non-ASCII bearer

def test_b2_non_ascii_bearer_is_401_not_500(serve):
    kit = serve(config_override={"callers": {"alice": "alice-token"}})
    for token in ("t\u00f6ken", "\u00e9", "alice-t\u00f6ken"):
        response = requests.get(
            kit.server.url + "/spend",
            headers={"Authorization": ("Bearer " + token).encode("latin-1")},
            timeout=10,
        )
        assert response.status_code == 401, token


# ---------------------------------------------------------------- D1 stream refresh+retry

def test_d1_stream_refreshes_and_retries_on_expired_token(serve):
    kit = serve(events=bedrock_text_events(("hi",), 5, 1),
                error=FakeClientError("ExpiredTokenException", "expired"), fail_first=True)
    response = kit.post(chat_body(model="haiku", stream=True))
    events = parse_sse(response.text)
    assert not [e for e in events if isinstance(e, dict) and e.get("error")]
    assert kit.auth.invalidated == 1
    assert len(kit.transport.calls) == 2


def test_d1_fake_stream_is_lazy():
    transport = FakeBedrockTransport(events=[], error=FakeClientError("ExpiredTokenException", "x"))
    stream = transport.converse_stream("m", {})  # must not raise before the first next()
    with pytest.raises(FakeClientError):
        next(stream)


def test_d1_stream_gives_up_after_one_retry(serve):
    kit = serve(error=FakeClientError("ExpiredTokenException", "expired"))
    response = kit.post(chat_body(model="haiku", stream=True))
    assert kit.auth.invalidated == 1
    assert len(kit.transport.calls) == 2
    assert "error" in response.text


# ---------------------------------------------------------------- D2 gemini tool_calls finish

def test_d2_gemini_non_stream_function_call_finish():
    out = convert.vertex_result_to_openai(gemini_tool_response(), requested_model="gemini")
    assert out["choices"][0]["finish_reason"] == "tool_calls"
    text = convert.vertex_result_to_openai(gemini_text_response(), requested_model="gemini")
    assert text["choices"][0]["finish_reason"] == "stop"


def test_d2_gemini_stream_function_call_finish():
    translator = convert.VertexStreamTranslator(requested_model="gemini")
    chunks = translator.feed({
        "candidates": [{"content": {"role": "model", "parts": [
            {"functionCall": {"name": "get_weather", "args": {"city": "Pune"}}}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 2},
    }) + translator.final()
    finishes = [c["choices"][0]["finish_reason"] for c in chunks if c.get("choices") and c["choices"][0].get("finish_reason")]
    assert finishes[-1] == "tool_calls"


def test_d2_gemini_stream_text_still_stop():
    translator = convert.VertexStreamTranslator(requested_model="gemini")
    chunks = translator.feed({
        "candidates": [{"content": {"role": "model", "parts": [{"text": "hi"}]}, "finishReason": "STOP"}],
    }) + translator.final()
    finishes = [c["choices"][0]["finish_reason"] for c in chunks if c.get("choices") and c["choices"][0].get("finish_reason")]
    assert finishes[-1] == "stop"


# ---------------------------------------------------------------- D3 toolConfig from history

HISTORY = [
    {"role": "user", "content": "weather?"},
    {"role": "assistant", "content": None, "tool_calls": [
        {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city":"Pune"}'}}]},
    {"role": "tool", "tool_call_id": "call_1", "content": "31C"},
    {"role": "user", "content": "thanks, summarise"},
]


def test_d3_history_tools_without_request_tools_sends_toolconfig():
    kwargs = convert.to_bedrock({"model": "m", "messages": HISTORY}, "m")
    names = [t["toolSpec"]["name"] for t in kwargs["toolConfig"]["tools"]]
    assert names == ["get_weather"]
    assert "toolChoice" not in kwargs["toolConfig"]


def test_d3_tool_choice_none_with_history_still_sends_toolconfig():
    kwargs = convert.to_bedrock({"model": "m", "messages": HISTORY, "tool_choice": "none"}, "m")
    assert [t["toolSpec"]["name"] for t in kwargs["toolConfig"]["tools"]] == ["get_weather"]
    assert "toolChoice" not in kwargs["toolConfig"]


def test_d3_request_tools_win_and_no_history_means_no_toolconfig():
    tools = [{"type": "function", "function": {"name": "other", "parameters": {"type": "object"}}}]
    kwargs = convert.to_bedrock({"model": "m", "messages": HISTORY, "tools": tools, "tool_choice": "none"}, "m")
    assert [t["toolSpec"]["name"] for t in kwargs["toolConfig"]["tools"]] == ["other"]
    plain = convert.to_bedrock({"model": "m", "messages": [{"role": "user", "content": "hi"}]}, "m")
    assert "toolConfig" not in plain


# ---------------------------------------------------------------- per-caller cap

def two_callers(serve):
    return serve(config_override={"callers": {"alice": "alice-token", "bob": "bob-token"}})


def test_cap_bucket_is_authenticated_caller_not_header(serve, ledger):
    seed_usd(ledger, 500.0, principal="alice")
    kit = two_callers(serve)
    for label in ("a", "b", "rotated-name"):
        status, body = kit.post_json(chat_body(), token="alice-token", headers={"X-LLM-Pool-Caller": label})
        assert status == 429, label
        assert body["error"]["code"] == "aws_daily_cap_exceeded"
    assert kit.transport.calls == []


def test_cap_is_independent_per_caller(serve, ledger):
    seed_usd(ledger, 500.0, principal="alice")
    kit = two_callers(serve)
    assert kit.post_json(chat_body(), token="alice-token")[0] == 429
    assert kit.post_json(chat_body(), token="bob-token")[0] == 200
    assert kit.post_json(chat_body(), token=TOKEN)[0] == 200  # main


def test_429_body_names_caller_and_spend(serve, ledger):
    seed_usd(ledger, 500.0, principal="alice")
    kit = two_callers(serve)
    status, body = kit.post_json(chat_body(), token="alice-token")
    error = body["error"]
    assert status == 429 and error["caller"] == "alice"
    assert error["spent_usd"] == 500.0 and error["cap_usd"] == 500.0
    assert "alice" in error["message"] and "500.00" in error["message"]


def test_spend_shows_per_caller_totals_and_remaining(serve, ledger):
    kit = two_callers(serve)
    kit.transport.response = bedrock_text_response("ok", 1_000_000, 0)  # haiku: USD 1.00
    kit.post_json(chat_body(), token="alice-token")
    status, spend = kit.server.get("/spend", token="alice-token")
    assert status == 200 and spend["you"] == "alice"
    by_name = {c["caller"]: c for c in spend["callers"]}
    assert set(by_name) >= {"main", "alice", "bob"}
    assert by_name["alice"]["bedrock_usd"] == pytest.approx(1.0)
    assert by_name["alice"]["remaining_usd"] == pytest.approx(499.0)
    assert by_name["bob"]["remaining_usd"] == 500.0


def test_warn_log_at_80_percent_is_per_caller(serve, ledger, caplog):
    import logging

    caplog.set_level(logging.WARNING, logger="llm_pool")
    seed_usd(ledger, 400.0, principal="alice")
    kit = two_callers(serve)
    kit.post_json(chat_body(), token="bob-token")
    assert "caller alice" not in caplog.text
    kit.post_json(chat_body(), token="alice-token")
    assert "caller alice" in caplog.text


def test_total_cap_optional_at_server(serve, ledger):
    seed_usd(ledger, 95.0, principal="bob")
    kit = serve(config_override={"callers": {"alice": "alice-token"}, "aws_daily_total_cap_usd": 100.0})
    status, body = kit.post_json(chat_body(model="opus", max_tokens=100000), token="alice-token")
    assert status == 429 and body["error"]["scope"] == "total"


def test_header_label_goes_to_ledger_caller_only(serve, ledger):
    kit = two_callers(serve)
    kit.post_json(chat_body(), token="alice-token", headers={"X-LLM-Pool-Caller": "pane7"})
    assert rows(ledger)[-1][:2] == ("pane7", "alice")


def test_vertex_spend_does_not_count_against_aws_cap(serve, ledger):
    seed_usd(ledger, 5000.0, principal="main", provider="vertex")
    kit = serve()
    assert kit.post_json(chat_body(model="haiku"))[0] == 200
    assert kit.post_json(chat_body(model="gemini"))[0] == 200


# ---------------------------------------------------------------- config 0600 and migration

def write_config(path, data, mode):
    path.write_text(json.dumps(data))
    path.chmod(mode)


def test_config_with_callers_is_tightened_to_0600(tmp_path):
    path = tmp_path / "config.json"
    write_config(path, {"callers": {"alice": "tok"}}, 0o644)
    cfg = load_config(path)
    assert cfg["callers"] == {"alice": "tok"}
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_config_without_callers_is_not_touched(tmp_path):
    path = tmp_path / "config.json"
    write_config(path, {"aws_daily_cap_usd_per_caller": 10}, 0o644)
    load_config(path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o644


def test_config_main_is_reserved_and_legacy_cap_migrates(tmp_path):
    path = tmp_path / "config.json"
    write_config(path, {"callers": {"main": "x"}}, 0o600)
    with pytest.raises(ConfigError):
        load_config(path)
    write_config(path, {"aws_daily_cap_usd": 123}, 0o600)
    assert load_config(path)["aws_daily_cap_usd_per_caller"] == 123


# ---------------------------------------------------------------- add-caller CLI

def test_add_caller_writes_0600_and_never_returns_token(tmp_path):
    config_path = tmp_path / "config.json"
    path = add_caller("alice", config_path, tmp_path / "callers")
    assert path == tmp_path / "callers" / "alice.token"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600
    token = path.read_text().strip()
    assert len(token) >= 32
    assert json.loads(config_path.read_text())["callers"]["alice"] == token
    assert load_config(config_path)["callers"]["alice"] == token
    add_caller("bob", config_path, tmp_path / "callers")
    assert set(json.loads(config_path.read_text())["callers"]) == {"alice", "bob"}
    with pytest.raises(CallerError):
        add_caller("alice", config_path, tmp_path / "callers")
    with pytest.raises(CallerError):
        add_caller("main", config_path, tmp_path / "callers")
    with pytest.raises(CallerError):
        add_caller("../evil", config_path, tmp_path / "callers")


def test_add_caller_cli_prints_only_path(tmp_path):
    script = Path(__file__).resolve().parents[1] / "add-caller.py"
    config_path = tmp_path / "config.json"
    proc = subprocess.run(
        [sys.executable, str(script), "carol", "--config", str(config_path), "--token-dir", str(tmp_path / "t")],
        capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    out = proc.stdout.strip()
    assert out == str(tmp_path / "t" / "carol.token")
    token = Path(out).read_text().strip()
    assert token not in proc.stdout and token not in proc.stderr


# ---------------------------------------------------------------- ledger migration

def test_ledger_migrates_old_schema(tmp_path):
    import sqlite3

    db = tmp_path / "old.sqlite3"
    conn = sqlite3.connect(db)
    conn.executescript("""
    CREATE TABLE spend (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ist_day TEXT NOT NULL,
      caller TEXT NOT NULL, model TEXT NOT NULL, model_id TEXT NOT NULL, provider TEXT NOT NULL,
      price_family TEXT NOT NULL, in_tokens INTEGER NOT NULL, out_tokens INTEGER NOT NULL,
      cache_tokens INTEGER NOT NULL, est_usd REAL NOT NULL, request_id TEXT NOT NULL DEFAULT '');
    INSERT INTO spend (ts, ist_day, caller, model, model_id, provider, price_family, in_tokens, out_tokens,
      cache_tokens, est_usd) VALUES ('2026-10-18T00:00:00Z','2026-10-18','legacy','haiku','m','bedrock','haiku',1,1,0,7.5);
    """)
    conn.commit()
    conn.close()
    ledger = Ledger(db)
    assert ledger.day_total_usd("2026-10-18", provider="bedrock", principal="legacy") == 7.5
    ledger.close()
