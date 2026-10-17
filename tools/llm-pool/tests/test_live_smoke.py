"""Live smoke through a real gateway instance. Gated: LLM_POOL_LIVE=1, real creds present, <= USD 2."""
from __future__ import annotations

import json
import os
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest
import requests

from fakes import parse_sse

TOOL_DIR = Path(__file__).resolve().parents[1]
LIVE = os.environ.get("LLM_POOL_LIVE") == "1"
BEDROCK_ENV = Path(os.path.expanduser("~/.config/newcat/probe.env"))
VERTEX_ENV = Path(os.path.expanduser("~/.config/newcat/vertex.env"))
BUDGET_USD = 2.0

pytestmark = pytest.mark.skipif(
    not LIVE, reason="live smoke is gated: set LLM_POOL_LIVE=1 (spend <= USD 2)"
)


def _gateway_python() -> str:
    candidates = [TOOL_DIR / ".venv" / "bin" / "python", Path(sys.executable)]
    for candidate in candidates:
        if not candidate.exists():
            continue
        probe = subprocess.run(
            [str(candidate), "-c", "import boto3, google.oauth2, fastapi, uvicorn"],
            capture_output=True,
        )
        if probe.returncode == 0:
            return str(candidate)
    pytest.skip("no interpreter with boto3 + google-auth + fastapi found")


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@pytest.fixture
def gateway():
    if not (BEDROCK_ENV.exists() and VERTEX_ENV.exists()):
        pytest.skip("cred env files are missing on this machine")
    python = _gateway_python()
    tmp = Path(os.environ.get("TMPDIR", "/tmp")) / f"llm-pool-live-{os.getpid()}"
    tmp.mkdir(parents=True, exist_ok=True)
    token_file = tmp / "client.token"
    token_file.write_text("live-smoke-token-not-a-vendor-key\n")
    token_file.chmod(0o600)
    ledger_path = tmp / "spend.sqlite3"
    port = _free_port()
    proc = subprocess.Popen(
        [
            python, "-m", "llm_pool",
            "--host", "127.0.0.1",
            "--allow-loopback",
            "--port", str(port),
            "--ledger", str(ledger_path),
            "--client-token-file", str(token_file),
            "--no-refresher",
            "--log-level", "warning",
        ],
        cwd=str(TOOL_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base = f"http://127.0.0.1:{port}"
    token = token_file.read_text().strip()
    deadline = time.time() + 45
    ready = False
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            if requests.get(base + "/health", timeout=2).ok:
                ready = True
                break
        except requests.RequestException:
            time.sleep(0.3)
    if not ready:
        output = proc.stdout.read()[:2000] if proc.stdout else ""
        proc.send_signal(signal.SIGKILL)
        pytest.fail(f"gateway did not become ready; output:\n{output}")
    yield {"base": base, "token": token, "ledger": ledger_path, "tmp": tmp}
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_live_haiku_non_stream(gateway):
    response = requests.post(
        gateway["base"] + "/v1/chat/completions",
        headers=auth(gateway["token"]),
        json={"model": "haiku",
              "messages": [{"role": "user", "content": "Reply with the single word ok."}],
              "max_tokens": 16},
        timeout=120,
    )
    assert response.status_code == 200, response.text[:300]
    body = response.json()
    message = body["choices"][0]["message"]
    assert message["role"] == "assistant"
    assert (message["content"] or "").strip()
    assert body["usage"]["prompt_tokens"] > 0
    assert body["usage"]["completion_tokens"] > 0
    print(f"\nLIVE non-stream: prompt={body['usage']['prompt_tokens']} "
          f"completion={body['usage']['completion_tokens']} finish={body['choices'][0]['finish_reason']}")


def test_live_haiku_stream(gateway):
    response = requests.post(
        gateway["base"] + "/v1/chat/completions",
        headers=auth(gateway["token"]),
        json={"model": "haiku",
              "messages": [{"role": "user", "content": "Reply with the single word ok."}],
              "max_tokens": 16, "stream": True, "stream_options": {"include_usage": True}},
        timeout=120,
    )
    assert response.status_code == 200, response.text[:300]
    assert response.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(response.text)
    assert events[-1] == "[DONE]"
    text = "".join(
        event["choices"][0]["delta"].get("content", "")
        for event in events
        if isinstance(event, dict) and event.get("choices")
    )
    assert text.strip()
    finish = [
        event for event in events
        if isinstance(event, dict) and event.get("choices") and event["choices"][0]["finish_reason"]
    ]
    assert finish[-1]["choices"][0]["finish_reason"] == "stop"
    usage_chunks = [
        event for event in events
        if isinstance(event, dict) and event.get("choices") == []
    ]
    assert usage_chunks and usage_chunks[-1]["usage"]["prompt_tokens"] > 0
    print(f"\nLIVE stream: chars={len(text)} prompt={usage_chunks[-1]['usage']['prompt_tokens']} "
          f"completion={usage_chunks[-1]['usage']['completion_tokens']}")


def test_live_tool_call_round_trip(gateway):
    tools = [{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Look up the current weather for a city",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "City name"}},
                "required": ["city"],
            },
        },
    }]
    messages = [{"role": "user", "content": "What is the weather in Pune right now? Use the get_weather tool."}]
    response = requests.post(
        gateway["base"] + "/v1/chat/completions",
        headers=auth(gateway["token"]),
        json={"model": "haiku", "messages": messages, "tools": tools, "max_tokens": 256},
        timeout=120,
    )
    assert response.status_code == 200, response.text[:300]
    body = response.json()
    choice = body["choices"][0]
    assert choice["finish_reason"] == "tool_calls", response.text[:500]
    tool_call = choice["message"]["tool_calls"][0]
    assert tool_call["function"]["name"] == "get_weather"
    arguments = json.loads(tool_call["function"]["arguments"])
    assert arguments.get("city")

    follow_up = messages + [
        choice["message"],
        {"role": "tool", "tool_call_id": tool_call["id"], "content": json.dumps({"temp_c": 31, "sky": "clear"})},
    ]
    second = requests.post(
        gateway["base"] + "/v1/chat/completions",
        headers=auth(gateway["token"]),
        json={"model": "haiku", "messages": follow_up, "tools": tools, "max_tokens": 256},
        timeout=120,
    )
    assert second.status_code == 200, second.text[:300]
    assert second.json()["choices"][0]["message"]["content"]
    print(f"\nLIVE tool round trip: call={tool_call['function']['name']} args={arguments} "
          f"finish1={choice['finish_reason']} finish2={second.json()['choices'][0]['finish_reason']}")


def test_live_spend_and_budget(gateway):
    response = requests.get(
        gateway["base"] + "/spend",
        headers=auth(gateway["token"]),
        timeout=30,
    )
    assert response.status_code == 200
    spend = response.json()
    assert spend["aws_daily_cap_usd_per_caller"] == 500.0
    main = [c for c in spend["callers"] if c["caller"] == "main"][0]
    assert main["remaining_usd"] <= 500.0

    conn = sqlite3.connect(gateway["ledger"])
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT provider, model_id, in_tokens, out_tokens, cache_tokens, est_usd FROM spend").fetchall()
    conn.close()
    assert len(rows) >= 1
    total = sum(row["est_usd"] for row in rows)
    in_tokens = sum(row["in_tokens"] for row in rows)
    out_tokens = sum(row["out_tokens"] for row in rows)
    assert total < BUDGET_USD, f"live smoke spent USD {total:.4f}, budget is USD {BUDGET_USD}"
    providers = {row["provider"] for row in rows}
    assert providers == {"bedrock"}
    print(f"\nLIVE spend: calls={len(rows)} in={in_tokens} out={out_tokens} "
          f"est_usd={total:.6f} (budget {BUDGET_USD})")
