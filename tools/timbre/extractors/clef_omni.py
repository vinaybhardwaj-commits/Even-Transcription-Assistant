"""Clef-omni valence for Timbre (Workers AI ``@cf/cloudflare/clef-omni``).

One patient window per request. A Clef call returns one answer set for the
whole state, so several windows in one call would be scored as a single clip.
The API allows at most 4 clips; this client refuses a longer list. Parallel
calls are capped (default 4).

Question set ``timbre-clef-v1`` (bump the constant when the text changes; the
on-disk cache key is the wav sha256 plus that version):

* ``valence`` — score 1–5, criteria very negative … very positive. The stored
  value is the expected value of that distribution, not the API's 0-based
  ``score`` field.
* ``arousal`` — score 1–5, diagnostic only. Stored as ``arousal_ev``. This is
  not the Timbre arousal model.
* ``anxious``, ``engaged``, ``one_patient`` — noul probabilities. ``one_patient``
  asks "Is this clip mainly one patient speaking?".

Workers AI REST shape (https://developers.cloudflare.com/workers-ai/models/clef-omni/):
the decision body is under ``result``. A score answer carries ``probabilities``
(index-keyed ``"0"``..``"4"`` over the criteria, or the criterion strings). A
noul answer carries ``noul`` (probability of yes). ``usage.input_tokens`` is
billed at US$0.15 per million. Output tokens are not billed.

Environment (never logged):

* ``TIMBRE_CLEF=1`` — required. Anything else refuses before a request.
* ``TIMBRE_CLEF_MOCK=1`` — deterministic offline mock. Still needs ``TIMBRE_CLEF=1``.
* ``CF_WORKERS_AI_TOKEN`` — Bearer token. Required unless the mock is on.
* ``CF_ACCOUNT_ID`` — or the account subdomain of ``R2_ENDPOINT``
  (``https://<account>.r2.cloudflarestorage.com``).
* ``TIMBRE_CLEF_CACHE`` — optional cache directory.
* ``TIMBRE_CLEF_COST_LOG`` — optional JSONL cost log.

Operator::

    TIMBRE_CLEF=1 CF_WORKERS_AI_TOKEN=... CF_ACCOUNT_ID=... \\
        python -m tools.timbre.clef_omni \\
        --windows windows.csv --audio-dir DIR --out results/clef/

    TIMBRE_CLEF=1 TIMBRE_CLEF_MOCK=1 \\
        python -m tools.timbre.clef_omni \\
        --windows windows.csv --audio-dir DIR --out results/clef/

``run.py --models clef_omni_valence.v1`` scores sequentially through the same
client (cache, retries, cost log) and does not read purity columns. This CLI
marks a window ``unscorable`` / ``purity`` when the CSV already carries
``purity`` and ``pure_patient_s`` and the window fails ``PurityRule``. Missing
purity columns are "not looked", not a failure.

Audio is 16 kHz mono WAV, base64 data URI. Clips over 8 MiB or 300 s are
refused. Logs and the cost file contain no audio, no token, and no account id.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import logging
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from tools.timbre.audio import TARGET_SR, read_audio
from tools.timbre.extractors.base import Extractor
from tools.timbre.purity import PurityRule
from tools.timbre.windows import Window, load_windows

log = logging.getLogger("tools.timbre.clef_omni")

QUESTION_SET_VERSION = "timbre-clef-v1"
MODEL_NAME = "clef-omni"
MODEL_ID = "@cf/cloudflare/clef-omni"
USD_PER_MILLION_INPUT_TOKENS = 0.15
MAX_CLIPS = 4
MAX_CLIP_S = 300.0
MAX_WAV_BYTES = 8 * 1024 * 1024
DEFAULT_CONCURRENCY = 4
MAX_ATTEMPTS = 5

STATE_TEXT = (
    "Outpatient clinic consultation. The audio is one short clip of the patient. "
    "Judge the patient's affect from the audio only."
)

VALENCE_CRITERIA = (
    "very negative",
    "negative",
    "neutral",
    "positive",
    "very positive",
)
AROUSAL_CRITERIA = (
    "very calm",
    "calm",
    "neutral",
    "activated",
    "very activated",
)

FEATURE_NAMES = (
    "valence",
    "valence_p1",
    "valence_p2",
    "valence_p3",
    "valence_p4",
    "valence_p5",
    "arousal_ev",
    "anxious",
    "engaged",
    "one_patient",
    "input_tokens",
    "output_tokens",
    "cost_usd",
)

_DONE = {"ok", "nan", "unscorable"}
_R2_ACCOUNT = re.compile(
    r"^https://(?P<acct>[A-Za-z0-9]+)\.r2\.cloudflarestorage\.com(?:/.*)?$",
    re.IGNORECASE,
)
_BEARER = re.compile(r"Bearer\s+\S+", re.IGNORECASE)
_DATA_URI = re.compile(r"data:audio/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+", re.IGNORECASE)
_LONG_B64 = re.compile(r"[A-Za-z0-9+/]{80,}={0,2}")


class ClefError(RuntimeError):
    """Base error. Messages never include audio, tokens, or account secrets."""


class ClefDisabled(ClefError):
    pass


class ClefConfigError(ClefError):
    pass


class ClefLimitError(ClefError):
    pass


class ClefParseError(ClefError):
    pass


class ClefHTTPError(ClefError):
    def __init__(self, status: int, detail: str = "", attempts: int = 1):
        self.status = int(status)
        self.attempts = int(attempts)
        self.retryable = self.status == 429 or 500 <= self.status <= 599 or self.status == 0
        msg = f"clef http {self.status}"
        if detail:
            msg = f"{msg}: {detail}"
        super().__init__(msg)


@dataclass(repr=False)
class Prepared:
    url: str
    headers: dict[str, str]
    body: dict

    def __repr__(self) -> str:
        n = len(self.body.get("audio") or [])
        return f"Prepared(audio_clips={n})"


@dataclass
class HttpResult:
    status: int
    headers: dict
    body: bytes


def require_enabled() -> None:
    if os.environ.get("TIMBRE_CLEF") != "1":
        raise ClefDisabled(
            "Clef is off. Set TIMBRE_CLEF=1 to score patient windows "
            "(TIMBRE_CLEF_MOCK=1 for the offline mock)."
        )


def mock_enabled() -> bool:
    return os.environ.get("TIMBRE_CLEF_MOCK") == "1"


def resolve_account_id() -> str:
    explicit = str(os.environ.get("CF_ACCOUNT_ID") or "").strip()
    if explicit:
        if "/" in explicit or any(ch.isspace() for ch in explicit):
            raise ClefConfigError("CF_ACCOUNT_ID is not a usable account id")
        return explicit
    endpoint = str(os.environ.get("R2_ENDPOINT") or "").strip()
    match = _R2_ACCOUNT.match(endpoint)
    if not match:
        raise ClefConfigError("CF_ACCOUNT_ID is unset and R2_ENDPOINT has no account subdomain")
    return match.group("acct")


def resolve_token() -> str:
    token = str(os.environ.get("CF_WORKERS_AI_TOKEN") or "").strip()
    if not token:
        raise ClefConfigError("CF_WORKERS_AI_TOKEN is unset")
    return token


def run_url(account_id: str) -> str:
    return f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{MODEL_ID}"


def input_cost_usd(input_tokens: int) -> float:
    return (int(input_tokens) * USD_PER_MILLION_INPUT_TOKENS) / 1_000_000.0


def scrub(text: str, secret: str | None = None) -> str:
    out = str(text).replace("\r", " ").replace("\n", " ")
    if secret:
        out = out.replace(secret, "[redacted]")
        if secret.lower().startswith("bearer "):
            out = out.replace(secret[7:], "[redacted]")
    out = _BEARER.sub("Bearer [redacted]", out)
    out = _DATA_URI.sub("[audio]", out)
    out = _LONG_B64.sub("[redacted]", out)
    return out[:180]


def questions_payload() -> dict:
    return {
        "valence": {
            "type": "score",
            "instructions": "How positive is the patient's affect in this clip?",
            "criteria": list(VALENCE_CRITERIA),
        },
        "arousal": {
            "type": "score",
            "instructions": (
                "How activated is the patient's voice in this clip? "
                "Diagnostic only; not the Timbre arousal score."
            ),
            "criteria": list(AROUSAL_CRITERIA),
        },
        "anxious": {"type": "noul", "instructions": "Does the patient sound anxious?"},
        "engaged": {"type": "noul", "instructions": "Does the patient sound engaged?"},
        "one_patient": {
            "type": "noul",
            "instructions": "Is this clip mainly one patient speaking?",
        },
    }


def check_clip_bounds(n_samples: int, sr: int, wav_nbytes: int) -> None:
    """Refuse clips outside the Clef caps. ``wav_nbytes`` is the decoded WAV size."""
    if int(sr) != TARGET_SR:
        raise ClefLimitError("clef audio must be 16000 Hz mono wav")
    if n_samples <= 0:
        raise ClefLimitError("clef audio is empty")
    if n_samples / float(sr) > MAX_CLIP_S:
        raise ClefLimitError("clef clip exceeds 300s")
    if wav_nbytes > MAX_WAV_BYTES:
        raise ClefLimitError("clef clip exceeds 8 MiB")


def encode_wav(audio: np.ndarray, sr: int) -> bytes:
    arr = np.asarray(audio)
    if arr.ndim != 1:
        raise ClefLimitError("clef audio must be mono")
    x = np.asarray(arr, dtype=np.float32).reshape(-1)
    if int(sr) != TARGET_SR:
        raise ClefLimitError("clef audio must be 16000 Hz mono wav")
    if x.size == 0:
        raise ClefLimitError("clef audio is empty")
    if not np.isfinite(x).all():
        raise ClefLimitError("clef audio has non-finite samples")
    check_clip_bounds(int(x.size), int(sr), 0)
    pcm = np.clip(np.rint(x.astype(np.float64) * 32767.0), -32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sr))
        handle.writeframes(pcm.tobytes())
    wav = buf.getvalue()
    check_clip_bounds(int(x.size), int(sr), len(wav))
    return wav


def wav_data_uri(wav: bytes) -> str:
    return "data:audio/wav;base64," + base64.b64encode(wav).decode("ascii")


def build_body(wavs: list[bytes]) -> dict:
    if not 1 <= len(wavs) <= MAX_CLIPS:
        raise ClefLimitError(f"clef accepts 1 to {MAX_CLIPS} audio clips per call")
    return {
        "model": MODEL_NAME,
        "state": STATE_TEXT,
        "audio": [wav_data_uri(wav) for wav in wavs],
        "questions": questions_payload(),
    }


def audio_sha256(wav: bytes) -> str:
    return hashlib.sha256(wav).hexdigest()


def expected_level(probs: list[float]) -> float:
    """Expected rater level. Criterion index ``i`` is level ``i + 1``."""
    return float(sum((i + 1) * p for i, p in enumerate(probs)))


def _distribution(values: list[float]) -> list[float]:
    if any((not math.isfinite(p)) or p < 0.0 for p in values):
        raise ClefParseError("score probabilities must be finite and non-negative")
    total = float(sum(values))
    if total <= 0.0 or abs(total - 1.0) > 0.05:
        raise ClefParseError("score probabilities are not a distribution")
    return [p / total for p in values]


def ordered_score_probs(answer, criteria: tuple[str, ...]) -> list[float]:
    """Probability per criterion, in the order we asked.

    Workers AI documents an index-keyed distribution (``"0"`` is the first
    criterion). A 1–5 key set or the criterion strings are accepted in that
    same order. The API ``score`` field is 0-based and is not used.
    """
    if not isinstance(answer, dict):
        raise ClefParseError("score answer is not an object")
    raw = answer.get("probabilities")
    if not isinstance(raw, dict) or not raw:
        raise ClefParseError("score answer has no probabilities")
    keyed: dict[str, float] = {}
    for key, value in raw.items():
        try:
            keyed[str(key)] = float(value)
        except (TypeError, ValueError):
            raise ClefParseError("score probability is not a number") from None
    n = len(criteria)
    if all(str(i) in keyed for i in range(n)):
        values = [keyed[str(i)] for i in range(n)]
    elif all(str(i) in keyed for i in range(1, n + 1)):
        values = [keyed[str(i)] for i in range(1, n + 1)]
    elif all(item in keyed for item in criteria):
        values = [keyed[item] for item in criteria]
    else:
        raise ClefParseError("score probabilities do not cover the 1-5 levels")
    return _distribution(values)


def noul_probability(answer) -> float:
    if not isinstance(answer, dict) or "noul" not in answer:
        raise ClefParseError("noul answer has no probability")
    try:
        p = float(answer["noul"])
    except (TypeError, ValueError):
        raise ClefParseError("noul probability is not a number") from None
    if not math.isfinite(p) or p < 0.0 or p > 1.0:
        raise ClefParseError("noul probability is outside 0..1")
    return p


def _usage_if_present(payload) -> tuple[int, int]:
    if not isinstance(payload, dict):
        return 0, 0
    try:
        return usage_tokens(unwrap_result(payload))
    except ClefParseError:
        return 0, 0


def usage_tokens(inner: dict) -> tuple[int, int]:
    usage = inner.get("usage")
    if usage is None:
        return 0, 0
    if not isinstance(usage, dict):
        raise ClefParseError("clef usage is not an object")

    def one(name: str) -> int:
        if name not in usage or usage[name] is None:
            return 0
        try:
            n = int(usage[name])
        except (TypeError, ValueError):
            raise ClefParseError("clef token count is not an integer") from None
        if n < 0:
            raise ClefParseError("clef token count is negative")
        return n

    return one("input_tokens"), one("output_tokens")


def unwrap_result(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ClefParseError("clef response is not an object")
    if payload.get("success") is False:
        raise ClefParseError("clef response success is false")
    inner = payload.get("result")
    if isinstance(inner, dict) and "answers" in inner:
        return inner
    if "answers" in payload:
        return payload
    raise ClefParseError("clef response has no answers")


def parse_features(payload: dict) -> dict[str, float]:
    inner = unwrap_result(payload)
    answers = inner.get("answers")
    if not isinstance(answers, dict):
        raise ClefParseError("clef response has no answers")
    input_tokens, output_tokens = usage_tokens(inner)
    valence_p = ordered_score_probs(answers.get("valence"), VALENCE_CRITERIA)
    arousal_p = ordered_score_probs(answers.get("arousal"), AROUSAL_CRITERIA)
    features: dict[str, float] = {
        "valence": expected_level(valence_p),
        "arousal_ev": expected_level(arousal_p),
        "anxious": noul_probability(answers.get("anxious")),
        "engaged": noul_probability(answers.get("engaged")),
        "one_patient": noul_probability(answers.get("one_patient")),
        "input_tokens": float(input_tokens),
        "output_tokens": float(output_tokens),
        "cost_usd": input_cost_usd(input_tokens),
    }
    for i, prob in enumerate(valence_p, start=1):
        features[f"valence_p{i}"] = prob
    missing = [name for name in FEATURE_NAMES if name not in features]
    if missing:
        raise ClefParseError("clef features are incomplete")
    return features


def mock_payload(wav: bytes) -> dict:
    """Deterministic REST-shaped body. Same wav bytes always yield the same answers."""
    digest = hashlib.sha256(wav).digest()

    def dist(offset: int) -> dict[str, float]:
        logits = np.array([digest[offset + i] for i in range(5)], dtype=np.float64)
        logits -= float(logits.max())
        exp = np.exp(logits)
        probs = exp / float(exp.sum())
        return {str(i): float(probs[i]) for i in range(5)}

    def ev0(probs: dict[str, float]) -> float:
        return float(sum(i * probs[str(i)] for i in range(5)))

    valence = dist(0)
    arousal = dist(5)
    return {
        "success": True,
        "result": {
            "model": MODEL_NAME,
            "answers": {
                "valence": {
                    "type": "score",
                    "score": ev0(valence),
                    "confidence": 0.5,
                    "legend": {str(i): text for i, text in enumerate(VALENCE_CRITERIA)},
                    "probabilities": valence,
                },
                "arousal": {
                    "type": "score",
                    "score": ev0(arousal),
                    "confidence": 0.5,
                    "legend": {str(i): text for i, text in enumerate(AROUSAL_CRITERIA)},
                    "probabilities": arousal,
                },
                "anxious": {"type": "noul", "noul": digest[10] / 255.0},
                "engaged": {"type": "noul", "noul": digest[11] / 255.0},
                "one_patient": {"type": "noul", "noul": digest[12] / 255.0},
            },
            "usage": {"input_tokens": 800 + int(digest[13]), "output_tokens": 0},
        },
    }


def backoff_seconds(attempt: int, retry_after: float | None) -> float:
    if retry_after is not None and math.isfinite(retry_after) and retry_after >= 0:
        return min(30.0, float(retry_after))
    return min(16.0, 0.5 * (2 ** attempt))


def retry_after_seconds(headers: dict | None) -> float | None:
    if not headers:
        return None
    raw = None
    for key, value in headers.items():
        if str(key).lower() == "retry-after":
            raw = value
            break
    if raw is None or str(raw).strip() == "":
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _error_detail(body: bytes, secret: str) -> str:
    text = body.decode("utf-8", errors="replace")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return scrub(text, secret)
    errors = payload.get("errors") if isinstance(payload, dict) else None
    if isinstance(errors, list) and errors:
        item = errors[0]
        msg = item.get("message", "") if isinstance(item, dict) else str(item)
        return scrub(str(msg), secret)
    return scrub(text, secret)


def urllib_transport(prepared: Prepared, timeout: float = 60.0) -> HttpResult:
    data = json.dumps(prepared.body).encode("utf-8")
    req = urllib.request.Request(prepared.url, data=data, method="POST")
    for key, value in prepared.headers.items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return HttpResult(int(resp.status), dict(resp.headers.items()), resp.read())
    except urllib.error.HTTPError as exc:
        raw = exc.read() if exc.fp is not None else b""
        headers = dict(exc.headers.items()) if exc.headers is not None else {}
        return HttpResult(int(exc.code), headers, raw)


def default_cache_dir() -> Path:
    env = os.environ.get("TIMBRE_CLEF_CACHE", "").strip()
    if env:
        return Path(env)
    return Path.home() / ".cache" / "timbre" / "clef-omni"


def default_cost_log(cache_dir: Path) -> Path:
    env = os.environ.get("TIMBRE_CLEF_COST_LOG", "").strip()
    if env:
        return Path(env)
    return cache_dir / "cost.jsonl"


def cache_path(cache_dir: Path, sha256: str, version: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ClefError("bad audio hash")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", version):
        raise ClefError("bad question set version")
    return Path(cache_dir) / f"{sha256}.{version}.json"


class ClefClient:
    """HTTP client with retries, a sha256 cache, and a cost log.

    ``concurrency`` bounds how many clips are in flight, including when callers
    use their own thread pool. Each ``score_clip`` sends exactly one window.
    """

    def __init__(
        self,
        *,
        transport=None,
        sleep=None,
        cache_dir: Path | str | None = None,
        cost_log: Path | str | None = None,
        concurrency: int = DEFAULT_CONCURRENCY,
        question_set: str = QUESTION_SET_VERSION,
    ):
        if int(concurrency) < 1:
            raise ValueError("concurrency must be >= 1")
        self.transport = transport or urllib_transport
        self.sleep = sleep or time.sleep
        self.cache_dir = Path(cache_dir) if cache_dir is not None else default_cache_dir()
        self.cost_path = Path(cost_log) if cost_log is not None else default_cost_log(self.cache_dir)
        self.concurrency = int(concurrency)
        self.question_set = question_set
        self._slots = threading.BoundedSemaphore(self.concurrency)
        self._lock = threading.Lock()
        self.n_calls = 0
        self.n_cached = 0
        self.billed_tokens = 0
        self.billed_usd = 0.0

    def prepare(self, wavs: list[bytes]) -> Prepared:
        if not 1 <= len(wavs) <= MAX_CLIPS:
            raise ClefLimitError(f"clef accepts 1 to {MAX_CLIPS} audio clips per call")
        account = resolve_account_id()
        token = resolve_token()
        return Prepared(
            url=run_url(account),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            body=build_body(wavs),
        )

    def score_clip(self, audio: np.ndarray, sr: int) -> dict[str, float]:
        require_enabled()
        wav = encode_wav(audio, sr)
        with self._slots:
            return self._score_wav(wav)

    def score_many(self, clips: list[tuple[np.ndarray, int]]) -> list[dict[str, float]]:
        if not clips:
            return []
        workers = min(self.concurrency, len(clips))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(self.score_clip, audio, sr) for audio, sr in clips]
            return [future.result() for future in futures]

    def _score_wav(self, wav: bytes) -> dict[str, float]:
        sha = audio_sha256(wav)
        cached = self._cache_get(sha)
        if cached is not None:
            self._record(
                sha,
                input_tokens=int(cached["input_tokens"]),
                output_tokens=int(cached["output_tokens"]),
                cost_usd=0.0,
                billed=False,
                cached=True,
                mock=False,
                parsed=True,
                http_status=None,
                latency_s=0.0,
                attempts=0,
            )
            return cached
        t0 = time.perf_counter()
        try:
            if mock_enabled():
                payload = mock_payload(wav)
                status = 200
                attempts = 1
                used_mock = True
            else:
                payload, status, attempts = self._post(wav)
                used_mock = False
            features = parse_features(payload)
        except (ClefHTTPError, ClefParseError, ClefConfigError) as exc:
            status = exc.status if isinstance(exc, ClefHTTPError) else None
            attempts = exc.attempts if isinstance(exc, ClefHTTPError) else 1
            in_tok, out_tok = 0, 0
            if isinstance(exc, ClefParseError):
                in_tok, out_tok = _usage_if_present(getattr(exc, "payload", None))
            self._record(
                sha,
                input_tokens=in_tok,
                output_tokens=out_tok,
                cost_usd=input_cost_usd(in_tok) if in_tok and not mock_enabled() else 0.0,
                billed=bool(in_tok) and not mock_enabled(),
                cached=False,
                mock=mock_enabled(),
                parsed=False,
                http_status=status,
                latency_s=time.perf_counter() - t0,
                attempts=attempts,
            )
            raise
        self._cache_put(sha, features)
        billed = not used_mock
        self._record(
            sha,
            input_tokens=int(features["input_tokens"]),
            output_tokens=int(features["output_tokens"]),
            cost_usd=float(features["cost_usd"]) if billed else 0.0,
            billed=billed,
            cached=False,
            mock=used_mock,
            parsed=True,
            http_status=status,
            latency_s=time.perf_counter() - t0,
            attempts=attempts,
        )
        return features

    def _post(self, wav: bytes) -> tuple[dict, int, int]:
        prepared = self.prepare([wav])
        header = prepared.headers.get("Authorization", "")
        secret = header[7:] if header.startswith("Bearer ") else header
        for attempt in range(MAX_ATTEMPTS):
            try:
                result = self.transport(prepared)
            except urllib.error.HTTPError as exc:
                raw = exc.read() if getattr(exc, "fp", None) is not None else b""
                headers = dict(exc.headers.items()) if exc.headers is not None else {}
                result = HttpResult(int(exc.code), headers, raw)
            except (TimeoutError, ConnectionError, urllib.error.URLError) as exc:
                if attempt + 1 == MAX_ATTEMPTS:
                    raise ClefHTTPError(
                        0, scrub(str(getattr(exc, "reason", exc)), secret), attempts=attempt + 1
                    ) from None
                delay = backoff_seconds(attempt, None)
                log.info("clef retry http_status=0 attempt=%s sleep_s=%.3f", attempt + 1, delay)
                self.sleep(delay)
                continue
            if int(result.status) == 200:
                try:
                    payload = json.loads(result.body.decode("utf-8"))
                except (UnicodeError, json.JSONDecodeError):
                    raise ClefParseError("clef response was not json") from None
                if isinstance(payload, dict) and payload.get("success") is False:
                    detail = _error_detail(result.body, secret) or "clef response success is false"
                    raise ClefParseError(detail)
                return payload, 200, attempt + 1
            detail = _error_detail(result.body, secret)
            err = ClefHTTPError(int(result.status), detail, attempts=attempt + 1)
            if not err.retryable or attempt + 1 == MAX_ATTEMPTS:
                raise err
            delay = backoff_seconds(attempt, retry_after_seconds(result.headers))
            log.info(
                "clef retry http_status=%s attempt=%s sleep_s=%.3f",
                int(result.status),
                attempt + 1,
                delay,
            )
            self.sleep(delay)
        raise ClefHTTPError(0, "clef retries exhausted")

    def _cache_get(self, sha: str) -> dict[str, float] | None:
        path = cache_path(self.cache_dir, sha, self.question_set)
        with self._lock:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
        if not isinstance(payload, dict) or payload.get("question_set") != self.question_set:
            return None
        features = payload.get("features")
        if not isinstance(features, dict):
            return None
        if payload.get("audio_sha256") != sha:
            return None
        out: dict[str, float] = {}
        for name in FEATURE_NAMES:
            try:
                out[name] = float(features[name])
            except (KeyError, TypeError, ValueError):
                return None
            if not math.isfinite(out[name]):
                return None
        return out

    def _cache_put(self, sha: str, features: dict[str, float]) -> None:
        path = cache_path(self.cache_dir, sha, self.question_set)
        body = {
            "question_set": self.question_set,
            "audio_sha256": sha,
            "features": {name: float(features[name]) for name in FEATURE_NAMES},
        }
        text = json.dumps(body, sort_keys=True)
        if "data:audio" in text or "Bearer" in text:
            raise ClefError("cache record refused")
        tmp = path.with_suffix(path.suffix + ".tmp")
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, path)

    def _record(
        self,
        sha: str,
        *,
        input_tokens: int,
        output_tokens: int,
        cost_usd: float,
        billed: bool,
        cached: bool,
        mock: bool,
        parsed: bool,
        http_status: int | None,
        latency_s: float,
        attempts: int,
    ) -> None:
        record = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "question_set": self.question_set,
            "audio_sha256": sha,
            "n_clips": 1,
            "input_tokens": int(input_tokens),
            "output_tokens": int(output_tokens),
            "cost_usd": float(cost_usd),
            "billed": bool(billed),
            "cached": bool(cached),
            "mock": bool(mock),
            "parsed": bool(parsed),
            "http_status": http_status,
            "latency_s": round(float(latency_s), 6),
            "attempts": int(attempts),
        }
        line = json.dumps(record, sort_keys=True)
        log.info(
            "clef question_set=%s sha=%s cached=%s mock=%s billed=%s http_status=%s "
            "input_tokens=%s cost_usd=%.8f latency_s=%.3f attempts=%s",
            self.question_set,
            sha[:12],
            int(cached),
            int(mock),
            int(billed),
            http_status if http_status is not None else "-",
            int(input_tokens),
            float(cost_usd),
            float(latency_s),
            int(attempts),
        )
        with self._lock:
            if cached:
                self.n_cached += 1
            elif parsed:
                self.n_calls += 1
            if billed:
                self.billed_tokens += int(input_tokens)
                self.billed_usd += float(cost_usd)
            self.cost_path.parent.mkdir(parents=True, exist_ok=True)
            with self.cost_path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")


def _blank(spec, status: str, reason: str, audio_s: float) -> dict:
    return {
        "model_name": spec.name,
        "model_id": spec.model_id,
        "model_version": spec.model_id,
        "extractor_version": spec.extractor_version,
        "revision": QUESTION_SET_VERSION,
        "kind": spec.kind,
        "status": status,
        "reason": reason,
        "audio_s": float(audio_s),
        "infer_s": 0.0,
        "vad": None,
        "features": {name: float("nan") for name in FEATURE_NAMES},
        "embedding": None,
    }


def purity_reason(meta: dict | None) -> str | None:
    """``purity`` when the CSV carried a purity filter and the window failed it.

    Absent ``purity`` and ``pure_patient_s`` means the filter was not run.
    That is not stored as a failure.
    """
    if not meta:
        return None
    has_purity = str(meta.get("purity", "")).strip() != ""
    has_seconds = str(meta.get("pure_patient_s", "")).strip() != ""
    if not has_purity and not has_seconds:
        return None
    score: dict = {}
    try:
        if has_purity:
            score["purity"] = float(meta["purity"])
        if has_seconds:
            score["pure_patient_s"] = float(meta["pure_patient_s"])
        cos = str(meta.get("cos_patient_mean", "")).strip()
        if cos:
            score["cos_patient_mean"] = float(cos)
    except (TypeError, ValueError):
        return "purity"
    if PurityRule().passes(score):
        return None
    return "purity"


class ClefOmniExtractor(Extractor):
    """Catalog extractor. ``revision`` is the question-set version, not a git sha."""

    scalar_names = FEATURE_NAMES

    def __init__(self, spec, device: str = "cpu", client: ClefClient | None = None):
        super().__init__(spec, device)
        self.client = client

    def _client(self) -> ClefClient:
        if self.client is None:
            self.client = ClefClient()
        return self.client

    def _extract(self, audio: np.ndarray, sr: int):
        features = self._client().score_clip(audio, sr)
        return features, None, QUESTION_SET_VERSION


def _finished(path: Path) -> dict[str, dict]:
    if not path.is_file():
        return {}
    import pandas as pd

    try:
        frame = pd.read_parquet(path)
    except Exception:
        bad = path.with_suffix(path.suffix + ".corrupt")
        os.replace(path, bad)
        return {}
    out = {}
    for row in frame.to_dict(orient="records"):
        if str(row.get("status")) in _DONE:
            out[str(row["window_id"])] = row
    return out


def run_clef(
    windows_csv: Path | str,
    audio_dir: Path | str,
    out_dir: Path | str,
    *,
    concurrency: int = DEFAULT_CONCURRENCY,
    cache_dir: Path | str | None = None,
    cost_log: Path | str | None = None,
    client: ClefClient | None = None,
) -> dict:
    """Score a windows CSV. Writes ``clef_omni_valence.v1.parquet`` and a summary."""
    require_enabled()
    from tools.timbre.catalog import SPEC_BY_NAME
    from tools.timbre.run import _flatten, _meta, _write_json, _write_parquet

    windows = load_windows(windows_csv, audio_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    spec = SPEC_BY_NAME["clef_omni_valence.v1"]
    if client is None:
        client = ClefClient(
            cache_dir=cache_dir or (out / "clef-cache"),
            cost_log=cost_log or (out / "clef-cost.jsonl"),
            concurrency=concurrency,
        )
    extractor = ClefOmniExtractor(spec, "cpu", client=client)
    parquet = out / "clef_omni_valence.v1.parquet"
    done = _finished(parquet)

    def one(window: Window) -> dict:
        reason = purity_reason(window.meta)
        if reason:
            return {**_meta(window), **_flatten(_blank(spec, "unscorable", reason, window.duration_s))}
        if window.audio_path is None:
            return {**_meta(window), **_flatten(_blank(spec, "error", "audio_missing", 0.0))}
        try:
            audio, sr = read_audio(window.audio_path)
        except Exception as exc:
            detail = scrub(f"{type(exc).__name__}: {exc}")
            return {**_meta(window), **_flatten(_blank(spec, "error", detail, 0.0))}
        return {**_meta(window), **_flatten(extractor.extract(audio, sr))}

    rows: dict[str, dict] = dict(done)
    pending = [w for w in windows if w.window_id not in rows]
    if pending:
        workers = max(1, min(int(concurrency), len(pending)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(one, window): window.window_id for window in pending}
            for fut in as_completed(futures):
                wid = futures[fut]
                try:
                    rows[wid] = fut.result()
                except Exception as exc:
                    window = next(w for w in pending if w.window_id == wid)
                    detail = scrub(f"{type(exc).__name__}: {exc}")
                    rows[wid] = {**_meta(window), **_flatten(_blank(spec, "error", detail, 0.0))}
    ordered = [rows[w.window_id] for w in windows]
    import pandas as pd

    _write_parquet(pd.DataFrame(ordered), parquet)
    statuses = [str(row.get("status")) for row in ordered]
    summary = {
        "question_set": QUESTION_SET_VERSION,
        "model_id": MODEL_ID,
        "n_windows": len(ordered),
        "n_ok": sum(s == "ok" for s in statuses),
        "n_nan": sum(s == "nan" for s in statuses),
        "n_unscorable": sum(s == "unscorable" for s in statuses),
        "n_error": sum(s == "error" for s in statuses),
        "n_calls": int(client.n_calls),
        "n_cached": int(client.n_cached),
        "input_tokens": int(client.billed_tokens),
        "cost_usd": float(client.billed_usd),
        "concurrency": int(concurrency),
    }
    _write_json(out / "clef_summary.json", summary)
    return summary


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m tools.timbre.clef_omni")
    parser.add_argument("--windows", required=True)
    parser.add_argument("--audio-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    parser.add_argument("--cache-dir", default=None)
    parser.add_argument("--cost-log", default=None)
    args = parser.parse_args(argv)
    try:
        summary = run_clef(
            args.windows,
            args.audio_dir,
            args.out,
            concurrency=args.concurrency,
            cache_dir=args.cache_dir,
            cost_log=args.cost_log,
        )
    except ClefDisabled as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from None
    print(
        f"wrote {args.out} windows={summary['n_windows']} ok={summary['n_ok']} "
        f"unscorable={summary['n_unscorable']} calls={summary['n_calls']} "
        f"cached={summary['n_cached']} cost_usd={summary['cost_usd']:.6f}"
    )


if __name__ == "__main__":
    main()
