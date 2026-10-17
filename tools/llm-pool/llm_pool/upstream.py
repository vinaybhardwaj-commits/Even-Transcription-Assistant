"""Upstream transports (Bedrock Converse, Vertex Gemini) and OpenAI-facing adapters."""
from __future__ import annotations

import json
import logging
from typing import Iterator

from . import convert
from .auth import AuthError
from .config import ModelSpec
from .errors import UpstreamError
from .pricing import Usage

log = logging.getLogger("llm_pool.upstream")

_AUTH_EXPIRED_CODES = {"ExpiredTokenException", "ExpiredToken", "UnrecognizedClientException", "InvalidIdentityToken"}
_MAX_MESSAGE = 300


class BotoTransport:
    def __init__(self, auth):
        self.auth = auth
        self._client = None
        self._session = None

    def _runtime(self):
        session = self.auth.session()
        stale = (
            self._client is None
            or self._session is None
            or self._session.session_token != session.session_token
            or self._session.expires_at != session.expires_at
        )
        if stale:
            import boto3

            self._client = boto3.client("bedrock-runtime", **session.boto_kwargs())
            self._session = session
        return self._client

    def converse(self, model_id: str, kwargs: dict) -> dict:
        return self._runtime().converse(modelId=model_id, **kwargs)

    def converse_stream(self, model_id: str, kwargs: dict) -> Iterator[dict]:
        response = self._runtime().converse_stream(modelId=model_id, **kwargs)
        for event in response.get("stream", []):
            yield event


def bedrock_error_to_upstream(exc: Exception) -> UpstreamError:
    if isinstance(exc, AuthError):
        return UpstreamError(502, str(exc)[:_MAX_MESSAGE], "credential_refresh_failed")
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return UpstreamError(502, type(exc).__name__, "upstream_error")
    error = response.get("Error") or {}
    code = str(error.get("Code") or "")
    message = str(error.get("Message") or type(exc).__name__)[:_MAX_MESSAGE]
    if code in _AUTH_EXPIRED_CODES or "ExpiredToken" in code:
        return UpstreamError(502, "upstream credentials expired", "upstream_auth_expired", auth_expired=True)
    if code == "ValidationException":
        return UpstreamError(400, message, "invalid_request_error", err_type="invalid_request_error")
    if code == "ResourceNotFoundException":
        return UpstreamError(404, message, "model_not_found", err_type="invalid_request_error")
    if code in ("ThrottlingException", "ModelNotReadyException"):
        return UpstreamError(429, message, "upstream_throttled")
    if code in ("ServiceUnavailableException", "ModelTimeoutException"):
        return UpstreamError(503, message, "upstream_unavailable")
    if code == "AccessDeniedException":
        return UpstreamError(502, "upstream access denied", "upstream_access_denied")
    return UpstreamError(502, message, "upstream_error")


class BedrockUpstream:
    def __init__(self, auth, transport=None, *, default_max_tokens=4096, logger=log):
        self.auth = auth
        self.default_max_tokens = int(default_max_tokens)
        self.transport = transport if transport is not None else BotoTransport(auth)
        self.log = logger

    def _call(self, method: str, model_id: str, kwargs: dict):
        try:
            return getattr(self.transport, method)(model_id, kwargs)
        except Exception as exc:
            mapped = exc if isinstance(exc, UpstreamError) else bedrock_error_to_upstream(exc)
            if not mapped.auth_expired:
                raise mapped from None
            self.auth.invalidate()
        try:
            return getattr(self.transport, method)(model_id, kwargs)
        except Exception as exc:
            mapped = exc if isinstance(exc, UpstreamError) else bedrock_error_to_upstream(exc)
            raise mapped from None

    def complete(self, body: dict, spec: ModelSpec, request_id: str | None = None) -> tuple[dict, Usage]:
        kwargs = convert.to_bedrock(body, spec.model_id, default_max_tokens=self.default_max_tokens)
        raw = self._call("converse", spec.model_id, kwargs)
        requested = body.get("model") or spec.model_id
        response = convert.bedrock_result_to_openai(raw, requested_model=requested, request_id=request_id)
        return response, convert.bedrock_usage(raw)

    def stream(self, body: dict, spec: ModelSpec, usage: Usage, request_id: str | None = None):
        kwargs = convert.to_bedrock(body, spec.model_id, default_max_tokens=self.default_max_tokens)
        requested = body.get("model") or spec.model_id
        translator = convert.BedrockStreamTranslator(
            requested_model=requested,
            request_id=request_id,
            include_usage=convert.include_usage(body),
            usage=usage,
        )
        events = iter(self._call("converse_stream", spec.model_id, kwargs))
        while True:
            try:
                event = next(events)
            except StopIteration:
                break
            except Exception as exc:
                raise exc if isinstance(exc, UpstreamError) else bedrock_error_to_upstream(exc) from None
            yield from translator.feed(event)
        yield from translator.final()


def _vertex_http_error(response) -> UpstreamError:
    try:
        body = response.json()
        message = json.dumps(body.get("error") or body)[:_MAX_MESSAGE]
    except Exception:
        message = (response.text or "")[:_MAX_MESSAGE]
    status = response.status_code
    if status == 400:
        return UpstreamError(400, message, "invalid_request_error", err_type="invalid_request_error")
    if status in (401, 403):
        return UpstreamError(502, "vertex credentials rejected", "upstream_auth_expired", auth_expired=True)
    if status == 404:
        return UpstreamError(404, message, "model_not_found", err_type="invalid_request_error")
    if status == 429:
        return UpstreamError(429, message, "upstream_throttled")
    return UpstreamError(502, message, "upstream_error")


def iter_sse_json(response) -> Iterator[dict]:
    for raw_line in response.iter_lines(decode_unicode=True):
        if raw_line is None:
            continue
        if isinstance(raw_line, bytes):
            line = raw_line.decode("utf-8", "replace").strip()
        else:
            line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if not data or data == "[DONE]":
            continue
        try:
            yield json.loads(data)
        except json.JSONDecodeError:
            continue


class VertexTransport:
    def __init__(self, auth, *, timeout_s=120.0):
        self.auth = auth
        self.timeout_s = float(timeout_s)

    def _url(self, model_id: str, method: str) -> str:
        location = self.auth.location
        host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
        return f"https://{host}/v1/projects/{self.auth.project}/locations/{location}/publishers/google/models/{model_id}:{method}"

    def _headers(self) -> dict:
        return {"Authorization": "Bearer " + self.auth.token(), "Content-Type": "application/json"}

    def generate(self, model_id: str, payload: dict) -> dict:
        import requests

        response = requests.post(
            self._url(model_id, "generateContent"),
            headers=self._headers(),
            json=payload,
            timeout=self.timeout_s,
        )
        if response.status_code >= 400:
            raise _vertex_http_error(response)
        return response.json()

    def stream_generate(self, model_id: str, payload: dict) -> Iterator[dict]:
        import requests

        response = requests.post(
            self._url(model_id, "streamGenerateContent") + "?alt=sse",
            headers=self._headers(),
            json=payload,
            stream=True,
            timeout=self.timeout_s,
        )
        if response.status_code >= 400:
            raise _vertex_http_error(response)
        yield from iter_sse_json(response)


def vertex_error_to_upstream(exc: Exception) -> UpstreamError:
    if isinstance(exc, UpstreamError):
        return exc
    if isinstance(exc, AuthError):
        return UpstreamError(502, str(exc)[:_MAX_MESSAGE], "credential_refresh_failed")
    return UpstreamError(502, type(exc).__name__, "upstream_error")


class VertexUpstream:
    def __init__(self, auth, transport=None, *, default_max_tokens=4096, logger=log):
        self.auth = auth
        self.default_max_tokens = int(default_max_tokens)
        self.transport = transport if transport is not None else VertexTransport(auth)
        self.log = logger

    def _call(self, method: str, model_id: str, payload: dict):
        try:
            return getattr(self.transport, method)(model_id, payload)
        except Exception as exc:
            mapped = vertex_error_to_upstream(exc)
            if not mapped.auth_expired:
                raise mapped from None
            self.auth.invalidate()
        try:
            return getattr(self.transport, method)(model_id, payload)
        except Exception as exc:
            raise vertex_error_to_upstream(exc) from None

    def complete(self, body: dict, spec: ModelSpec, request_id: str | None = None) -> tuple[dict, Usage]:
        payload = convert.to_vertex(body, spec.model_id, default_max_tokens=self.default_max_tokens)
        raw = self._call("generate", spec.model_id, payload)
        requested = body.get("model") or spec.model_id
        response = convert.vertex_result_to_openai(raw, requested_model=requested, request_id=request_id)
        return response, convert.vertex_usage(raw)

    def stream(self, body: dict, spec: ModelSpec, usage: Usage, request_id: str | None = None):
        payload = convert.to_vertex(body, spec.model_id, default_max_tokens=self.default_max_tokens)
        requested = body.get("model") or spec.model_id
        translator = convert.VertexStreamTranslator(
            requested_model=requested,
            request_id=request_id,
            include_usage=convert.include_usage(body),
            usage=usage,
        )
        events = iter(self._call("stream_generate", spec.model_id, payload))
        while True:
            try:
                event = next(events)
            except StopIteration:
                break
            except Exception as exc:
                raise vertex_error_to_upstream(exc) from None
            yield from translator.feed(event)
        yield from translator.final()
