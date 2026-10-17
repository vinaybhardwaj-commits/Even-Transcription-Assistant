import json
import logging

import pytest
import requests

from llm_pool import timeutil
from llm_pool.config import load_config
from llm_pool.ledger import Ledger, LedgerRow
from llm_pool.server import create_app
from llm_pool.upstream import BedrockUpstream, VertexUpstream

from fakes import (
    FakeBedrockAuth,
    FakeBedrockTransport,
    FakeClientError,
    FakeVertexAuth,
    FakeVertexTransport,
    GatewayServer,
    bedrock_text_events,
    bedrock_text_response,
    bedrock_tool_events,
    bedrock_tool_response,
    gemini_text_response,
    parse_sse,
    stream_text,
)

TOKEN = "test-token"


@pytest.fixture
def config():
    return load_config("/nonexistent/llm-pool-config.json")


@pytest.fixture
def ledger(tmp_path):
    instance = Ledger(tmp_path / "spend.sqlite3")
    yield instance
    instance.close()


class Kit:
    def __init__(self, server, transport, vtransport, auth, vauth, ledger):
        self.server = server
        self.transport = transport
        self.vtransport = vtransport
        self.auth = auth
        self.vauth = vauth
        self.ledger = ledger

    def post(self, payload, token=TOKEN, headers=None):
        return self.server.post("/v1/chat/completions", payload, token=token, extra_headers=headers)

    def post_json(self, payload, token=TOKEN, headers=None):
        return self.server.post_json("/v1/chat/completions", payload, token=token, extra_headers=headers)


@pytest.fixture
def serve(config, ledger):
    kits = []

    def _serve(response=None, events=None, error=None, stream_error=None, vresponse=None,
               verror=None, client_token=TOKEN, config_override=None, fail_first=False):
        transport = FakeBedrockTransport(
            response=response if response is not None else bedrock_text_response(),
            events=events,
            error=error,
            stream_error=stream_error,
            fail_first=fail_first,
        )
        vtransport = FakeVertexTransport(response=vresponse or gemini_text_response(), error=verror)
        auth = FakeBedrockAuth()
        vauth = FakeVertexAuth()
        cfg = dict(config)
        if config_override:
            cfg.update(config_override)
        app = create_app(
            cfg,
            ledger=ledger,
            bedrock=BedrockUpstream(auth, transport=transport),
            vertex=VertexUpstream(vauth, transport=vtransport),
            client_token=client_token,
        )
        kit = Kit(GatewayServer(app), transport, vtransport, auth, vauth, ledger)
        kits.append(kit)
        return kit

    yield _serve
    for kit in kits:
        kit.server.stop()


def chat_body(model="haiku", content="Say hi", **extra):
    body = {"model": model, "messages": [{"role": "user", "content": content}]}
    body.update(extra)
    return body


def seed_usd(ledger, usd, principal="main", provider="bedrock"):
    ledger.add(
        LedgerRow(
            caller="seed",
            principal=principal,
            model="haiku",
            model_id="global.anthropic.claude-haiku-5-5",
            provider=provider,
            price_family="haiku",
            in_tokens=1,
            out_tokens=1,
            cache_tokens=0,
            est_usd=usd,
        )
    )


def test_health_needs_no_token(serve):
    kit = serve()
    response = requests.get(kit.server.url + "/health", timeout=10)
    assert response.status_code == 200
    assert response.json() == {"ok": True}


@pytest.mark.parametrize("token", [None, "wrong-token"])
def test_requires_valid_token(serve, token):
    kit = serve()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    response = requests.post(kit.server.url + "/v1/chat/completions", headers=headers, json=chat_body(), timeout=10)
    assert response.status_code == 401
    body = response.json()
    assert body["error"]["code"] == "unauthorized"
    assert response.headers.get("WWW-Authenticate") == "Bearer"
    assert kit.ledger.row_count() == 0


def test_non_stream_alias_routes_to_bedrock(serve):
    kit = serve(response=bedrock_text_response("hello from bedrock", 11, 5))
    status, body = kit.post_json(chat_body(model="haiku", content="Say hi"))
    assert status == 200
    kind, model_id, kwargs = kit.transport.calls[0]
    assert kind == "converse"
    assert model_id == "global.anthropic.claude-haiku-5-5"
    assert kwargs["messages"][0]["content"][0]["text"] == "Say hi"
    assert kwargs["inferenceConfig"]["maxTokens"] == 4096
    message = body["choices"][0]["message"]
    assert message["role"] == "assistant"
    assert message["content"] == "hello from bedrock"
    assert body["choices"][0]["finish_reason"] == "stop"
    assert body["id"].startswith("chatcmpl-")
    assert body["usage"]["prompt_tokens"] == 11
    assert kit.ledger.row_count() == 1


def test_full_bedrock_id_resolves(serve):
    kit = serve(response=bedrock_text_response("ok"))
    status, _ = kit.post_json(chat_body(model="global.anthropic.claude-opus-4-7"))
    assert status == 200
    assert kit.transport.calls[0][1] == "global.anthropic.claude-opus-4-7"
    totals = kit.ledger.totals_for_day(_today(kit))
    assert totals[0]["model_id"] == "global.anthropic.claude-opus-4-7"


def _today(kit=None):
    return timeutil.ist_day()


def test_gemini_alias_routes_to_vertex(serve):
    kit = serve(vresponse=gemini_text_response("hello from gemini", 9, 4))
    status, body = kit.post_json(chat_body(model="gemini"))
    assert status == 200
    kind, model_id, payload = kit.vtransport.calls[0]
    assert kind == "generate"
    assert model_id == "gemini-2.5-pro"
    assert payload["contents"][0]["parts"][0]["text"] == "Say hi"
    assert body["choices"][0]["message"]["content"] == "hello from gemini"
    assert body["usage"]["prompt_tokens"] == 9


def test_stream_text(serve):
    kit = serve(events=bedrock_text_events(("Hel", "lo")))
    response = kit.post(chat_body(model="haiku", stream=True), )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(response.text)
    assert events[-1] == "[DONE]"
    assert stream_text(events[:-1]) == "Hello"
    finish = [e for e in events[:-1] if e.get("choices") and e["choices"][0]["finish_reason"]]
    assert finish[-1]["choices"][0]["finish_reason"] == "stop"
    totals = kit.ledger.totals_for_day(_today(kit))
    assert totals[0]["in_tokens"] == 7
    assert totals[0]["out_tokens"] == 2
    assert totals[0]["est_usd"] == pytest.approx((7 * 1.0 + 2 * 5.0) / 1_000_000)


def test_stream_include_usage(serve):
    kit = serve(events=bedrock_text_events())
    response = kit.post(chat_body(model="haiku", stream=True, stream_options={"include_usage": True}))
    events = parse_sse(response.text)
    usage_chunks = [e for e in events if isinstance(e, dict) and e.get("choices") == []]
    assert usage_chunks
    assert usage_chunks[-1]["usage"]["prompt_tokens"] == 7
    assert usage_chunks[-1]["usage"]["completion_tokens"] == 2


def test_tool_call_non_stream(serve):
    kit = serve(response=bedrock_tool_response())
    status, body = kit.post_json(chat_body(content="Weather in Pune?"))
    assert status == 200
    choice = body["choices"][0]
    assert choice["finish_reason"] == "tool_calls"
    tool_call = choice["message"]["tool_calls"][0]
    assert tool_call["function"]["name"] == "get_weather"
    assert json.loads(tool_call["function"]["arguments"]) == {"city": "Pune"}
    assert choice["message"]["content"] is None


def test_tool_round_trip_request_mapping(serve):
    kit = serve(response=bedrock_text_response("It is 31 C."))
    messages = [
        {"role": "user", "content": "Weather in Pune?"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city": "Pune"}'}}]},
        {"role": "tool", "tool_call_id": "call_1", "content": '{"temp_c": 31}'},
    ]
    tools = [{"type": "function", "function": {
        "name": "get_weather", "description": "lookup",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]
    status, body = kit.post_json({"model": "haiku", "messages": messages, "tools": tools})
    assert status == 200
    kwargs = kit.transport.calls[0][2]
    roles = [m["role"] for m in kwargs["messages"]]
    assert roles == ["user", "assistant", "user"]
    assert kwargs["messages"][1]["content"][0]["toolUse"]["toolUseId"] == "call_1"
    assert kwargs["messages"][2]["content"][0]["toolResult"]["toolUseId"] == "call_1"
    assert body["choices"][0]["message"]["content"] == "It is 31 C."
    assert kwargs["toolConfig"]["tools"][0]["toolSpec"]["name"] == "get_weather"


def test_stream_tool_call(serve):
    kit = serve(events=bedrock_tool_events())
    response = kit.post(chat_body(model="haiku", stream=True))
    events = parse_sse(response.text)
    tool_chunks = [e for e in events if isinstance(e, dict) and e.get("choices")
                   and e["choices"][0]["delta"].get("tool_calls")]
    assert tool_chunks
    assert tool_chunks[0]["choices"][0]["delta"]["tool_calls"][0]["function"]["name"] == "get_weather"
    arguments = "".join(c["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"] for c in tool_chunks)
    assert json.loads(arguments) == {"city": "Pune"}
    finish = [e for e in events if isinstance(e, dict) and e.get("choices") and e["choices"][0]["finish_reason"]]
    assert finish[-1]["choices"][0]["finish_reason"] == "tool_calls"


def test_unknown_model_404(serve):
    kit = serve()
    status, body = kit.post_json(chat_body(model="gpt-9"))
    assert status == 404
    assert body["error"]["code"] == "model_not_found"
    assert kit.transport.calls == []


def test_n2_rejected(serve):
    kit = serve()
    status, body = kit.post_json(chat_body(n=2))
    assert status == 400
    assert "n=1" in body["error"]["message"]


def test_invalid_json_body(serve):
    kit = serve()
    response = requests.post(
        kit.server.url + "/v1/chat/completions",
        headers={"Authorization": f"Bearer {TOKEN}"},
        data="{not json",
        timeout=10,
    )
    assert response.status_code == 400


def test_cap_refusal_at_boundary(serve, ledger, caplog):
    caplog.set_level(logging.WARNING, logger="llm_pool")
    seed_usd(ledger, 500.0)
    kit = serve()
    status, body = kit.post_json(chat_body(model="haiku"))
    assert status == 429
    assert body["error"]["code"] == "aws_daily_cap_exceeded"
    assert kit.transport.calls == []
    assert kit.ledger.row_count() == 1
    assert "refusing bedrock call for caller main" in caplog.text


def test_vertex_not_blocked_by_aws_cap(serve, ledger):
    seed_usd(ledger, 500.0)
    kit = serve()
    status, _ = kit.post_json(chat_body(model="gemini"))
    assert status == 200


def test_warn_at_80_percent(serve, ledger, caplog):
    caplog.set_level(logging.WARNING, logger="llm_pool")
    seed_usd(ledger, 400.0)
    kit = serve()
    status, _ = kit.post_json(chat_body(model="haiku"))
    assert status == 200
    assert "cap refuses at 100%" in caplog.text


def test_validation_exception_maps_to_400(serve):
    kit = serve(error=FakeClientError("ValidationException", "bad tool spec"))
    status, body = kit.post_json(chat_body())
    assert status == 400
    assert body["error"]["code"] == "invalid_request_error"
    assert "bad tool spec" in body["error"]["message"]
    assert kit.ledger.row_count() == 1


def test_auth_error_is_sanitized(serve):
    from llm_pool.auth import AuthError

    kit = serve(error=AuthError("bedrock credential refresh failed (OSError: File name too long)"))
    status, body = kit.post_json(chat_body())
    assert status == 502
    assert body["error"]["code"] == "credential_refresh_failed"
    assert "credential refresh failed" in body["error"]["message"]


def test_unexpected_exception_never_echoes_message(serve):
    secret = "SECRET-LOOKALIKE-blob-that-must-not-leak"
    kit = serve(error=RuntimeError(secret))
    status, body = kit.post_json(chat_body())
    assert status == 502
    assert body["error"]["message"] == "RuntimeError"
    assert secret not in json.dumps(body)


def test_stream_unexpected_exception_is_sanitized(serve):
    secret = "STREAM-SECRET-lookalike"
    kit = serve(stream_error=RuntimeError(secret))
    response = kit.post(chat_body(model="haiku", stream=True))
    events = parse_sse(response.text)
    error_events = [e for e in events if isinstance(e, dict) and e.get("error")]
    assert error_events
    assert secret not in response.text
    assert error_events[0]["error"]["message"] == "RuntimeError"


def test_model_not_found_maps_to_404(serve):
    kit = serve(error=FakeClientError("ResourceNotFoundException", "model gone"))
    status, body = kit.post_json(chat_body())
    assert status == 404
    assert body["error"]["code"] == "model_not_found"


def test_throttling_maps_to_429(serve):
    kit = serve(error=FakeClientError("ThrottlingException", "slow down"))
    status, body = kit.post_json(chat_body())
    assert status == 429
    assert body["error"]["code"] == "upstream_throttled"
    assert "aws_daily_cap" not in body["error"]["code"]


def test_auth_expired_retries_once(serve):
    kit = serve(error=FakeClientError("ExpiredTokenException", "token expired"), fail_first=True)
    status, body = kit.post_json(chat_body())
    assert status == 200
    assert kit.auth.invalidated == 1
    assert len(kit.transport.calls) == 2


def test_stream_error_event_and_ledger_row(serve):
    kit = serve(stream_error=FakeClientError("ThrottlingException", "slow down"))
    response = kit.post(chat_body(model="haiku", stream=True))
    events = parse_sse(response.text)
    assert events[-1] == "[DONE]"
    error_events = [e for e in events if isinstance(e, dict) and e.get("error")]
    assert error_events
    assert error_events[0]["error"]["code"] == "upstream_throttled"
    totals = kit.ledger.totals_for_day(_today(kit))
    assert totals[0]["calls"] == 1
    assert totals[0]["in_tokens"] == 0


def test_spend_endpoint_numbers(serve, ledger):
    kit = serve(response=bedrock_text_response("ok", 1000, 500))
    kit.post_json(chat_body(model="haiku"))
    kit.post_json(chat_body(model="sonnet"))
    status, spend = kit.server.get("/spend")
    assert status == 200
    assert spend["tz"] == "Asia/Kolkata"
    by_model = {row["model_id"]: row for row in spend["by_model"]}
    assert by_model["global.anthropic.claude-haiku-5-5"]["calls"] == 1
    assert by_model["global.anthropic.claude-haiku-5-5"]["in_tokens"] == 1000
    assert by_model["global.anthropic.claude-sonnet-5-5"]["calls"] == 1
    assert spend["aws_daily_cap_usd_per_caller"] == 500.0
    main = [c for c in spend["callers"] if c["caller"] == "main"][0]
    assert main["remaining_usd"] == pytest.approx(500.0 - spend["aws_daily_total_usd"])
    assert spend["aws_daily_total_usd"] == pytest.approx(
        (1000 * 1.0 + 500 * 5.0 + 1000 * 3.0 + 500 * 15.0) / 1_000_000
    )


def test_caller_header_attribution(serve, ledger):
    kit = serve()
    kit.post_json(chat_body(), headers={"X-LLM-Pool-Caller": "opencode-pane1"})
    kit.post_json(chat_body())
    callers = [row[0] for row in ledger._conn.execute("SELECT caller FROM spend ORDER BY id")]
    assert callers == ["opencode-pane1", "main"]


def test_per_caller_token(serve, ledger, config):
    kit = serve(config_override={"callers": {"alice": "alice-token"}})
    status, _ = kit.post_json(chat_body(), token="alice-token")
    assert status == 200
    status, spend = kit.server.get("/spend", token="alice-token")
    assert status == 200
    status, _ = kit.post_json(chat_body(), token="bob-token")
    assert status == 401


def test_v1_models_list(serve):
    kit = serve()
    status, body = kit.server.get("/v1/models")
    assert status == 200
    ids = {entry["id"] for entry in body["data"]}
    assert {"opus", "sonnet", "haiku", "gemini"} <= ids
