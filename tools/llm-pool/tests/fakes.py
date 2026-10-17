"""Shared fakes and a real-socket gateway harness for llm-pool tests (no vendor network)."""
from __future__ import annotations

import json
import socket
import threading
import time

import requests
import uvicorn


class FakeBedrockAuth:
    def __init__(self):
        self.invalidated = 0
        self.sessions = 0

    def session(self, force: bool = False):
        self.sessions += 1
        return object()

    def invalidate(self):
        self.invalidated += 1


class FakeVertexAuth:
    token_value = "fake-vertex-token"
    project = "demo-project"
    location = "asia-northeast1"

    def __init__(self):
        self.invalidated = 0

    def token(self, force: bool = False) -> str:
        return self.token_value

    def invalidate(self):
        self.invalidated += 1


class FakeBedrockTransport:
    """Mirrors boto: converse_stream is a LAZY generator, so errors surface on the first next(), not at call."""

    def __init__(self, response=None, events=None, error=None, stream_error=None, fail_first=False,
                 delay=0.0, gate=None, gate_after=1, break_after=None):
        self.response = response
        self.events = list(events or [])
        self.error = error
        self.stream_error = stream_error
        self.fail_first = bool(fail_first)
        self.delay = float(delay)
        self.gate = gate
        self.gate_after = int(gate_after)
        self.break_after = break_after
        self.calls = []

    def converse(self, model_id, kwargs):
        self.calls.append(("converse", model_id, kwargs))
        if self.delay:
            time.sleep(self.delay)
        if self.error is not None and not (self.fail_first and len(self.calls) > 1):
            raise self.error
        return self.response

    def converse_stream(self, model_id, kwargs):
        self.calls.append(("converse_stream", model_id, kwargs))
        attempt = len(self.calls)
        if self.stream_error is not None:
            raise self.stream_error
        return self._events(attempt)

    def _events(self, attempt):
        if self.error is not None and not (self.fail_first and attempt > 1):
            raise self.error
        for index, event in enumerate(self.events):
            if self.break_after is not None and index >= self.break_after:
                raise RuntimeError("stream broke")
            if self.gate is not None and index == self.gate_after:
                self.gate.wait(15)
            yield event


class FakeVertexTransport:
    def __init__(self, response=None, events=None, error=None, fail_first=False):
        self.response = response
        self.events = list(events or [])
        self.error = error
        self.fail_first = bool(fail_first)
        self.calls = []

    def generate(self, model_id, payload):
        self.calls.append(("generate", model_id, payload))
        if self.error is not None and not (self.fail_first and len(self.calls) > 1):
            raise self.error
        return self.response

    def stream_generate(self, model_id, payload):
        self.calls.append(("stream_generate", model_id, payload))
        attempt = len(self.calls)
        if self.error is not None and not (self.fail_first and attempt > 1):
            raise self.error
        return self._events()

    def _events(self):
        yield from self.events


class FakeClientError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"An error occurred ({code}) when calling the Converse operation: {message}")
        self.response = {"Error": {"Code": code, "Message": message}}


def usage_block(in_tokens=11, out_tokens=5, cache_tokens=0):
    usage = {
        "inputTokens": in_tokens,
        "outputTokens": out_tokens,
        "totalTokens": in_tokens + out_tokens,
    }
    if cache_tokens:
        usage["cacheReadInputTokens"] = cache_tokens
    return usage


def bedrock_text_response(text="hello from bedrock", in_tokens=11, out_tokens=5, cache_tokens=0, stop="end_turn"):
    return {
        "output": {"message": {"role": "assistant", "content": [{"text": text}]}},
        "stopReason": stop,
        "usage": usage_block(in_tokens, out_tokens, cache_tokens),
    }


def bedrock_tool_response(name="get_weather", tool_use_id="call_abc123", args=None, in_tokens=20, out_tokens=8):
    return {
        "output": {
            "message": {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": tool_use_id, "name": name, "input": args or {"city": "Pune"}}}],
            }
        },
        "stopReason": "tool_use",
        "usage": usage_block(in_tokens, out_tokens),
    }


def bedrock_text_events(text_chunks=("Hel", "lo"), in_tokens=7, out_tokens=2):
    events = [{"messageStart": {"role": "assistant"}}, {"contentBlockStart": {"contentBlockIndex": 0, "start": {"text": {}}}}]
    for chunk in text_chunks:
        events.append({"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": chunk}}})
    events.append({"contentBlockStop": {"contentBlockIndex": 0}})
    events.append({"messageStop": {"stopReason": "end_turn"}})
    events.append({"metadata": {"usage": usage_block(in_tokens, out_tokens)}})
    return events


def bedrock_tool_events(name="get_weather", tool_use_id="call_abc123", argument_chunks=('{"ci', 'ty":"Pune"}'),
                        in_tokens=20, out_tokens=8):
    events = [
        {"messageStart": {"role": "assistant"}},
        {
            "contentBlockStart": {
                "contentBlockIndex": 0,
                "start": {"toolUse": {"toolUseId": tool_use_id, "name": name}},
            }
        },
    ]
    for chunk in argument_chunks:
        events.append({"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": chunk}}}})
    events.append({"contentBlockStop": {"contentBlockIndex": 0}})
    events.append({"messageStop": {"stopReason": "tool_use"}})
    events.append({"metadata": {"usage": usage_block(in_tokens, out_tokens)}})
    return events


def gemini_text_response(text="hello from gemini", prompt_tokens=9, candidates_tokens=4, cached=0):
    usage = {"promptTokenCount": prompt_tokens, "candidatesTokenCount": candidates_tokens,
             "totalTokenCount": prompt_tokens + candidates_tokens}
    if cached:
        usage["cachedContentTokenCount"] = cached
    return {
        "candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}],
        "usageMetadata": usage,
    }


def gemini_tool_response(name="get_weather", args=None):
    return {
        "candidates": [
            {
                "content": {"role": "model", "parts": [{"functionCall": {"name": name, "args": args or {"city": "Pune"}}}]},
                "finishReason": "STOP",
            }
        ],
        "usageMetadata": {"promptTokenCount": 15, "candidatesTokenCount": 6, "totalTokenCount": 21},
    }


def parse_sse(text: str):
    events = []
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if data == "[DONE]":
            events.append("[DONE]")
        else:
            events.append(json.loads(data))
    return events


def stream_text(events) -> str:
    return "".join(event.get("choices", [{}])[0].get("delta", {}).get("content", "") or "" for event in events
                   if isinstance(event, dict) and event.get("choices"))


class GatewayServer:
    def __init__(self, app, host="127.0.0.1"):
        sock = socket.socket()
        sock.bind((host, 0))
        self.port = sock.getsockname()[1]
        sock.close()
        self.host = host
        config = uvicorn.Config(app, host=host, port=self.port, log_level="warning")
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        deadline = time.time() + 15
        while not self.server.started and time.time() < deadline:
            time.sleep(0.05)
        if not self.server.started:
            raise RuntimeError("gateway did not start in time")

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def stop(self):
        self.server.should_exit = True
        self.thread.join(timeout=15)

    def post(self, path, payload, token="test-token", extra_headers=None, stream=False):
        headers = {"Authorization": f"Bearer {token}"}
        if extra_headers:
            headers.update(extra_headers)
        return requests.post(self.url + path, headers=headers, json=payload, timeout=60, stream=stream)

    def post_json(self, path, payload, token="test-token", extra_headers=None):
        response = self.post(path, payload, token=token, extra_headers=extra_headers)
        return response.status_code, response.json()

    def get(self, path, token="test-token"):
        response = requests.get(self.url + path, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        return response.status_code, response.json()
