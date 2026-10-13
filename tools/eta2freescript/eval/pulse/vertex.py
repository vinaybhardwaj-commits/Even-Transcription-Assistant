"""Gemini on Vertex AI, regional host only. Evaluation tooling: it is handed note_text and nothing else.

Env: VERTEX_PROJECT, VERTEX_LOCATION (a region, never "global"), VERTEX_SA_KEY_FILE (path to a 0600 JSON key),
PULSE_EXTRACT_MODEL (default gemini-3.1-pro-preview), PULSE_ADJ_MODEL (default gemini-3.5-flash).
No fallback model and no other route. Prompt and response text are never logged; only model names and token counts.
"""
from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from .assets import AssetsError, check_private_file

log = logging.getLogger("eta.pulse_replay.vertex")

DEFAULT_EXTRACT_MODEL = "gemini-3.1-pro-preview"
DEFAULT_ADJ_MODEL = "gemini-3.5-flash"
MAX_REQUEST_CHARS = 40_000
TRANSCRIPT_MARKERS = ("T0 [S", "NATIVE[", "english_segments", "native_segments")
_REGION = re.compile(r"^[a-z]+-[a-z]+[0-9]+$")
_MODEL = re.compile(r"^[A-Za-z0-9._-]+$")
_TIMEOUT_S = 180


class ReplayUnavailable(Exception):
    """The model route failed or is not configured. The message never carries prompt or response text."""


class TranscriptGuardError(ValueError):
    """A request looked like a transcript or was too long. Raised before anything leaves the machine."""


@dataclass
class GenResult:
    text: str
    served_model_id: str | None
    finish_reason: str | None
    usage: dict = field(default_factory=dict)


def guard_request(*texts: str) -> None:
    total = sum(len(t) for t in texts)
    if total > MAX_REQUEST_CHARS:
        raise TranscriptGuardError(f"request is {total} chars, over the {MAX_REQUEST_CHARS} limit")
    for t in texts:
        for m in TRANSCRIPT_MARKERS:
            if m in t:
                raise TranscriptGuardError(f"request contains the transcript marker {m!r}")


def check_key_file(path) -> Path:
    try:
        check_private_file(Path(path), "VERTEX_SA_KEY_FILE")
    except AssetsError as e:
        raise ReplayUnavailable(str(e)) from None
    return Path(path)


def _http_transport(url: str, headers: dict, body: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as r:  # noqa: S310 - https URL built from a validated region
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ReplayUnavailable(f"vertex http {e.code}") from None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        raise ReplayUnavailable(f"vertex transport failed ({type(e).__name__})") from None


def _google_token_provider(key_file: Path):
    """Lazy: google-auth lives in requirements-replay.txt, not in the test environment."""
    try:
        from google.auth.transport.requests import Request  # type: ignore
        from google.oauth2 import service_account  # type: ignore
    except ImportError:
        raise ReplayUnavailable("google-auth is not installed (pip install -r tools/eta2freescript/requirements-replay.txt)") from None
    try:
        creds = service_account.Credentials.from_service_account_file(
            str(key_file), scopes=["https://www.googleapis.com/auth/cloud-platform"])
    except Exception as e:  # noqa: BLE001 - never surface key-file content
        raise ReplayUnavailable(f"service account key unusable ({type(e).__name__})") from None

    def token() -> str:
        if not creds.valid:
            try:
                creds.refresh(Request())
            except Exception as e:  # noqa: BLE001
                raise ReplayUnavailable(f"token refresh failed ({type(e).__name__})") from None
        return creds.token
    return token


class VertexClient:
    def __init__(self, project: str, location: str, token_provider, *, transport=_http_transport,
                 extract_model: str = DEFAULT_EXTRACT_MODEL, adj_model: str = DEFAULT_ADJ_MODEL):
        if not project or not re.match(r"^[a-z][a-z0-9-]{4,}$", project):
            raise ReplayUnavailable("VERTEX_PROJECT missing or malformed")
        if location == "global" or not _REGION.match(location or ""):
            raise ReplayUnavailable("VERTEX_LOCATION must be a region such as asia-northeast1; global is refused")
        for m in (extract_model, adj_model):
            if not _MODEL.match(m or ""):
                raise ReplayUnavailable("model name malformed")
        self.project, self.location = project, location
        self.token_provider, self.transport = token_provider, transport
        self.extract_model, self.adj_model = extract_model, adj_model

    @classmethod
    def from_env(cls, env=None, *, transport=_http_transport, token_provider=None) -> "VertexClient":
        env = os.environ if env is None else env
        key = env.get("VERTEX_SA_KEY_FILE")
        if not key:
            raise ReplayUnavailable("VERTEX_SA_KEY_FILE is not set")
        key_path = check_key_file(key)
        tp = token_provider or _google_token_provider(key_path)
        return cls(env.get("VERTEX_PROJECT", ""), env.get("VERTEX_LOCATION", ""), tp, transport=transport,
                   extract_model=env.get("PULSE_EXTRACT_MODEL") or DEFAULT_EXTRACT_MODEL,
                   adj_model=env.get("PULSE_ADJ_MODEL") or DEFAULT_ADJ_MODEL)

    def model_for(self, stage: str, asset_model: str | None = None) -> str:
        """Env override wins, then the assets file's model, then the built-in default."""
        env_name = {"extract": "PULSE_EXTRACT_MODEL", "adjudicate": "PULSE_ADJ_MODEL"}[stage]
        if os.environ.get(env_name):
            return os.environ[env_name]
        if asset_model:
            return asset_model
        return self.extract_model if stage == "extract" else self.adj_model

    def generate(self, *, stage: str, model: str, system: str, user: str, schema: dict, temperature: float,
                 max_tokens: int, reasoning_effort: str | None = None) -> GenResult:
        if not _MODEL.match(model or ""):
            raise ReplayUnavailable("model name malformed")
        guard_request(system, user)
        gen_cfg: dict = {"temperature": temperature, "maxOutputTokens": max_tokens,
                         "responseMimeType": "application/json", "responseJsonSchema": schema}
        if reasoning_effort:
            gen_cfg["thinkingConfig"] = {"thinkingLevel": reasoning_effort.upper()}
        body = {"systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}], "generationConfig": gen_cfg}
        url = (f"https://{self.location}-aiplatform.googleapis.com/v1/projects/{self.project}/locations/"
               f"{self.location}/publishers/google/models/{model}:generateContent")
        headers = {"Authorization": f"Bearer {self.token_provider()}", "Content-Type": "application/json"}
        resp = self.transport(url, headers, body)
        if not isinstance(resp, dict):
            raise ReplayUnavailable("vertex returned a non-object response")
        cands = resp.get("candidates") or []
        cand = cands[0] if cands and isinstance(cands[0], dict) else {}
        parts = (cand.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
        u = resp.get("usageMetadata") or {}
        usage = {k: u.get(src) for k, src in (("input", "promptTokenCount"), ("output", "candidatesTokenCount"),
                                             ("thinking", "thoughtsTokenCount"), ("total", "totalTokenCount"))}
        served = resp.get("modelVersion")
        served = served if isinstance(served, str) and served else None
        res = GenResult(text=text, served_model_id=served, finish_reason=cand.get("finishReason"), usage=usage)
        log.info("vertex call stage=%s intended=%s served=%s tokens=%s", stage, model, served, usage)
        return res
