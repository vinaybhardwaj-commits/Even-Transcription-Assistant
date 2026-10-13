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
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from .assets import AssetsError, check_private_file

log = logging.getLogger("eta.pulse_replay.vertex")

DEFAULT_EXTRACT_MODEL = "gemini-3.1-pro-preview"
DEFAULT_ADJ_MODEL = "gemini-3.5-flash"
MAX_REQUEST_CHARS = 40_000
# Shapes of what ingest.format_transcript writes, matched on folded text.
_TRANSCRIPT_SHAPES = (
    ("a transcript turn line (T<n> [S<label>] (mm:ss))",
     re.compile(r"t\d+\s*\[\s*s[^\]]{1,32}\]\s*\(\s*\d{1,3}\s*:\s*\d{2}\s*\)")),
    ("a NATIVE[<lang>]: ... | ENGLISH: pair", re.compile(r"native\s*\[[^\]]{1,16}\]\s*:[^|]{0,4000}\|\s*english\s*:")),
    ("an english/native segments key",
     re.compile(r"(english|native)\s*[-_.]\s*segments|[\"']\s*(english|native)\s+segments\s*[\"']")),
)
_REGION = re.compile(r"[a-z]+-[a-z]+[0-9]+")
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


DEFAULT_LOCATION = "asia-northeast1"


# Lowercase (post-casefold) Cyrillic/Greek look-alikes of Latin t s e n a i v g l h.
_CONFUSABLES = str.maketrans({
    "\u0442": "t", "\u03c4": "t",
    "\u0455": "s",
    "\u0435": "e", "\u03b5": "e",
    "\u03bd": "n", "\u043f": "n",
    "\u0430": "a", "\u03b1": "a",
    "\u0456": "i", "\u03b9": "i",
    "\u0475": "v", "\u03c5": "v",
    "\u050d": "g",
    "\u04cf": "l",
    "\u043d": "h", "\u03b7": "h",
    "\u0131": "i",
    "\ua731": "s",
    "\u1d1b": "t",
})


# Unicode Default_Ignorable_Code_Point ranges (DerivedCoreProperties.txt, Unicode 15.1). Not in unicodedata.
_DEFAULT_IGNORABLE = (
    (0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160), (0x17B4, 0x17B5),
    (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164),
    (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF),
)


def _invisible(c: str) -> bool:
    """Cf, Default_Ignorable, or U+2800 (braille blank): carries no visible mark."""
    o = ord(c)
    return (unicodedata.category(c) == "Cf" or o == 0x2800
            or any(lo <= o <= hi for lo, hi in _DEFAULT_IGNORABLE))


def _strip_cf(t: str) -> str:
    return "".join(c for c in t if not _invisible(c))


def _strip_marks(t: str) -> str:
    return "".join(c for c in t if unicodedata.category(c) not in ("Mn", "Me"))


def _fold(t: str) -> str:
    """Drop invisibles, NFKC, fold dotted I, casefold, map confusables and dashes, collapse whitespace."""
    # The guard only inspects the text, so combining marks (Mn, Me) can go. Decompose first (NFKD), or a
    # precomposed letter such as U+1E6A (T with dot) would survive as a letter that is not a "t".
    t = unicodedata.normalize("NFKC", _strip_marks(unicodedata.normalize("NFKD", _strip_cf(t))))
    t = _strip_marks(t).replace("\u0130", "I")
    t = _strip_cf(t).casefold().replace("i\u0307", "i").translate(_CONFUSABLES)
    t = "".join("-" if unicodedata.category(c) == "Pd" or c in "\u2212\u2043" else c for c in t)
    return " ".join(t.split())


def guard_request(*texts: str) -> None:
    total = sum(len(t) for t in texts)
    if total > MAX_REQUEST_CHARS:
        raise TranscriptGuardError(f"request is {total} chars, over the {MAX_REQUEST_CHARS} limit")
    for t in texts:
        folded = _fold(t)
        for what, rx in _TRANSCRIPT_SHAPES:
            if rx.search(folded):
                raise TranscriptGuardError(f"request contains {what}")


def _real_ruling(r: str | None) -> bool:
    """Allow-list: a letter, number, punctuation or symbol (or Mc) that is visible."""
    def ok(c: str) -> bool:
        k = unicodedata.category(c)
        return (k[0] in "LNPS" or k == "Mc") and not _invisible(c) and c != "\u3164"
    return any(ok(c) for c in (r or ""))


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
                 extract_model: str = DEFAULT_EXTRACT_MODEL, adj_model: str = DEFAULT_ADJ_MODEL,
                 location_ruling: str | None = None):
        if not project or not re.match(r"^[a-z][a-z0-9-]{4,}$", project):
            raise ReplayUnavailable("VERTEX_PROJECT missing or malformed")
        if location == "global" or not _REGION.fullmatch(location or ""):
            raise ReplayUnavailable("VERTEX_LOCATION must be a region such as asia-northeast1; global is refused")
        if location != DEFAULT_LOCATION and not _real_ruling(location_ruling):
            raise ReplayUnavailable(f"VERTEX_LOCATION other than {DEFAULT_LOCATION} needs VERTEX_LOCATION_OVERRIDE_RULING (a fable ruling id)")
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
                   adj_model=env.get("PULSE_ADJ_MODEL") or DEFAULT_ADJ_MODEL,
                   location_ruling=env.get("VERTEX_LOCATION_OVERRIDE_RULING"))

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
