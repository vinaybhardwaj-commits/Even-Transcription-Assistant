"""Offline Jev scoring for Timbre text. Text only. Never audio.

Mirrors the production client without importing it, so a batch run cannot persist
`jev_decision` rows or flip `ETA_JEV_ENABLED`:

- POST ``https://api.typesafe.ai/v1/systemone`` (`lib/jev/client.ts`)
- Bearer ``TYPESAFE_API_KEY``; model ``ETA_JEV_MODEL`` or ``jev-1.13.0``
- Questions are the three wire types (score / noul / choice), one fan-out per window,
  the same shape `askJev` sends (`lib/jev/ask.ts`)
- 429 and 529 retry up to 3 times; 401 and 422 do not (`lib/jev/client.ts`)
- Input-token cost is ``42e-9`` USD (`lib/jev/counters.ts`). Output tokens are counted
  and not billed.
- State cap 100_000 characters

Zero data retention is a property of Vinay's TypeSafe account, not a body field.
The production client does not send one, and neither does this.

The lane's own switch is ``TIMBRE_TEXT_LANE=1``. Unset, or any falsy flag value,
refuses before a socket is opened. An unrecognised value refuses loudly (it is not
read as off). ``TIMBRE_JEV_MOCK=1`` answers locally with model ``jev-mock`` and
does not open a socket.

Timeouts and connection errors are retried the same three times. Production's
client does not retry a timeout; a batch window should survive one blip.

Nothing written to the cost log or the cache contains transcript text. The cache
key is a hash of the masked text, the prompt version, the model, and the question
set. The stored file holds scores, token counts, and hashes.
"""

from __future__ import annotations

import hashlib
import json
import random
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from tools.timbre.phi_mask import mask_phi

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
DEFAULT_MODEL = "jev-1.13.0"
STATE_CHAR_GUARD = 100_000
MAX_ATTEMPTS = 3
INPUT_TOKEN_COST_USD = 42e-9
TIMEOUT_MS_DEFAULT = 15_000
PROMPT_VERSION = "timbre-text-v1"

FLAG_TRUTHY = ("1", "true", "yes", "on")
FLAG_FALSY = ("", "0", "false", "no", "off")

NOUL_TRUE_AT = 0.5

VALENCE_LEVELS = (
    "Strongly unpleasant or negative affect in the patient's words.",
    "Mildly unpleasant.",
    "Neutral, flat, or mixed with no clear direction.",
    "Mildly pleasant or relieved.",
    "Strongly pleasant or relieved.",
)
AROUSAL_LEVELS = (
    "Calm. Little distress or activation in the wording.",
    "Mild distress or activation.",
    "Moderate distress or activation.",
    "High distress or activation.",
    "Very high distress or activation.",
)
DOUBT_REASONS = (
    "none",
    "symptom_unexplained",
    "plan_unclear",
    "contradiction_in_account",
    "question_left_open",
    "cannot_tell",
)

_PREFACE = (
    "You are scoring one patient's own words from a clinic window. "
    "The state key window_text is already masked. You have no audio. "
    "Judge the words only. Do not quote the transcript."
)

_COST_KEYS = (
    "window_id",
    "text_sha256",
    "char_count",
    "prompt_version",
    "model",
    "cache_hit",
    "input_tokens",
    "output_tokens",
    "cost_usd",
    "latency_ms",
    "status",
    "http_status",
)
_FORBIDDEN_KEYS = frozenset(
    {
        "text",
        "window_text",
        "transcript",
        "transcript_english",
        "transcript_original",
        "quote",
        "state",
        "masked_text",
        "patient_text",
        "reason_text",
        "body",
    }
)


class TextLaneError(RuntimeError):
    pass


class TextLaneDisabled(TextLaneError):
    def __init__(self) -> None:
        super().__init__("TIMBRE_TEXT_LANE is not set — refusing to call Jev")


class TextLaneFlagError(TextLaneError):
    def __init__(self, name: str, length: int) -> None:
        super().__init__(
            f"{name} has an unrecognised value (length {length}) — "
            "use 1|true|yes|on to enable. Refusing to guess."
        )


class JevCallError(TextLaneError):
    def __init__(self, message: str, status: int | None = None) -> None:
        self.status = status
        super().__init__(message)


@dataclass
class TransportResponse:
    status: int
    body: bytes


Transport = Callable[[str, dict, dict, float], TransportResponse]
SleepFn = Callable[[float], None]


def flag_value(name: str, env: dict[str, str] | None) -> bool:
    """Same truthy/falsy sets as `lib/flags.ts` `parseFlag`. Unrecognised values raise."""
    src = env if env is not None else _environ()
    raw = src.get(name)
    if raw is None:
        return False
    val = raw.strip().lower()
    if val in FLAG_TRUTHY:
        return True
    if val in FLAG_FALSY:
        return False
    raise TextLaneFlagError(name, len(raw))


def require_text_lane(env: dict[str, str] | None = None) -> None:
    if not flag_value("TIMBRE_TEXT_LANE", env):
        raise TextLaneDisabled()


def questions() -> dict:
    """Version `timbre-text-v1`. One systemOne fan-out. No free-text reason."""
    return {
        "timbre_valence": {
            "type": "score",
            "instructions": f"{_PREFACE} How pleasant or unpleasant is the patient's affect, from the words alone?",
            "criteria": list(VALENCE_LEVELS),
        },
        "timbre_arousal": {
            "type": "score",
            "instructions": (
                f"{_PREFACE} How much distress or arousal is in the patient's words? "
                "This is one scale, not two."
            ),
            "criteria": list(AROUSAL_LEVELS),
        },
        "timbre_engaged": {
            "type": "noul",
            "instructions": (
                f"{_PREFACE} The patient is engaged: answering, elaborating, or taking part, "
                "rather than withdrawn or monosyllabic."
            ),
            "criteria": {
                "true": "The patient is taking part in the exchange.",
                "false": "The patient is withdrawn, silent, or answering in fragments.",
            },
        },
        "timbre_resistant": {
            "type": "noul",
            "instructions": (
                f"{_PREFACE} The patient resists: refuses, argues, dismisses, or pushes away "
                "the line of questions or advice."
            ),
            "criteria": {
                "true": "The patient is resisting the exchange.",
                "false": "The patient is not resisting.",
            },
        },
        "timbre_unresolved_doubt": {
            "type": "noul",
            "instructions": (
                f"{_PREFACE} Something medically important is left unresolved: a question, "
                "a contradiction, or a plan the patient has not accepted or understood."
            ),
            "criteria": {
                "true": "An important point is still unresolved in this window.",
                "false": "Nothing important is left unresolved in this window.",
            },
        },
        "timbre_doubt_reason": {
            "type": "choice",
            "instructions": (
                f"{_PREFACE} If something is unresolved, pick the one closed code that names it. "
                "If nothing is unresolved, pick none. Do not quote."
            ),
            "criteria": {
                "none": "Nothing important is unresolved.",
                "symptom_unexplained": "A symptom or finding was raised and not explained.",
                "plan_unclear": "The plan, medicine, or next step was not understood or not accepted.",
                "contradiction_in_account": "The account contradicts itself on a clinical point.",
                "question_left_open": "A question was asked and not answered.",
                "cannot_tell": "Something feels unresolved but the words do not say which of the above.",
            },
        },
    }


def question_sha256() -> str:
    payload = json.dumps(questions(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def text_sha256(masked: str) -> str:
    return hashlib.sha256(masked.encode("utf-8")).hexdigest()


def cache_key(masked: str, model: str) -> str:
    blob = "\0".join((PROMPT_VERSION, model, question_sha256(), masked))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def cost_usd(input_tokens: int) -> float:
    """Same rounding as `lib/jev/worker/budget.ts` `costUsd`."""
    return round(int(input_tokens) * INPUT_TOKEN_COST_USD * 1e8) / 1e8


def noul_confidence(noul: float) -> float:
    """`lib/jev/confidence.ts` `noulConfidence`: decisiveness, not the raw probability."""
    if noul != noul:  # NaN
        return 0.0
    return max(float(noul), 1.0 - float(noul))


def score_window(
    text: str,
    *,
    window_id: str,
    env: dict[str, str] | None = None,
    cache_dir: Path | str | None = None,
    transport: Transport | None = None,
    sleep: SleepFn | None = None,
    rng: random.Random | None = None,
) -> dict:
    """Mask, refuse residual identifiers, then score. The return value has no transcript."""
    require_text_lane(env)
    if not isinstance(text, str):
        raise TextLaneError("refusing non-text state")
    masked = mask_phi(text)
    sha = text_sha256(masked.text)
    base = {
        "window_id": window_id,
        "text_sha256": sha,
        "char_count": len(masked.text),
        "prompt_version": PROMPT_VERSION,
        "cache_hit": False,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.0,
        "latency_ms": 0,
        "http_status": None,
        "model": None,
    }
    if masked.residual:
        return _public(base, status="residual_phi")
    if not masked.text.strip():
        return _public(base, status="empty")
    if len(masked.text) > STATE_CHAR_GUARD:
        return _public(base, status="too_large")

    src = env if env is not None else _environ()
    mocking = flag_value("TIMBRE_JEV_MOCK", env)
    configured = (src.get("ETA_JEV_MODEL") or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    # The mock must not share a cache entry with a real model, and a real call must
    # not accept a jev-mock file.
    model = "jev-mock" if mocking else configured
    key = cache_key(masked.text, model)
    if cache_dir is not None:
        cached = _cache_read(Path(cache_dir), key, model)
        if cached is not None:
            cached.update(
                {
                    "window_id": window_id,
                    "text_sha256": sha,
                    "char_count": len(masked.text),
                    "cache_hit": True,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cost_usd": 0.0,
                    "latency_ms": 0,
                    "http_status": None,
                    "status": "ok",
                }
            )
            return _public(cached, status="ok")

    if mocking:
        parsed = _parse_answers(_mock_answers(), model="jev-mock")
        parsed.update(base)
        parsed["model"] = "jev-mock"
        parsed["cache_hit"] = False
        _cache_write(cache_dir, key, parsed, requested_model=model)
        return _public(parsed, status=parsed["status"])

    api_key = src.get("TYPESAFE_API_KEY") or ""
    if not api_key:
        raise JevCallError("config_missing_key")
    timeout_s = _timeout_s(src)
    body = _request_body(masked.text, configured)
    status, payload, latency_ms = _call(
        body,
        api_key,
        timeout_s,
        transport=transport,
        sleep=sleep,
        rng=rng or random.Random(),
    )
    parsed = _parse_answers(payload.get("answers") or {}, model=str(payload.get("model") or configured))
    usage = payload.get("usage") or {}
    in_tok = int(usage.get("input_tokens") or 0)
    out_tok = int(usage.get("output_tokens") or 0)
    parsed.update(base)
    parsed["model"] = str(payload.get("model") or model)
    parsed["input_tokens"] = in_tok
    parsed["output_tokens"] = out_tok
    parsed["cost_usd"] = cost_usd(in_tok)
    parsed["latency_ms"] = latency_ms
    parsed["http_status"] = status
    if parsed["status"] == "ok":
        _cache_write(cache_dir, key, parsed, requested_model=model)
    return _public(parsed, status=parsed["status"])


def append_cost(path: Path | str, row: dict) -> None:
    """One JSON line. Refuses a row that carries text or an over-long string."""
    record = cost_record(row)
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")


def cost_record(row: dict) -> dict:
    extra = set(row) & _FORBIDDEN_KEYS
    if extra:
        raise TextLaneError("cost record refused")
    out = {}
    for key in _COST_KEYS:
        if key not in row:
            continue
        val = row[key]
        if isinstance(val, str) and len(val) > 80:
            raise TextLaneError("cost record refused")
        if isinstance(val, (bool, int, float)) or val is None or isinstance(val, str):
            out[key] = val
        else:
            raise TextLaneError("cost record refused")
    return out


def write_scores(rows: list[dict], path: Path | str) -> Path:
    """Atomic JSONL of public scores. Nested `unresolved_doubt` is value + closed reason."""
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    lines = []
    for row in rows:
        public = public_score(row)
        if set(public) & _FORBIDDEN_KEYS:
            raise TextLaneError("score row refused")
        lines.append(json.dumps(public, sort_keys=True))
    tmp.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    tmp.replace(dest)
    return dest


def public_score(row: dict) -> dict:
    """The operator-facing score. No transcript, no provider body."""
    doubt_val = row.get("unresolved_doubt")
    reason = row.get("doubt_reason") if row.get("doubt_reason") in DOUBT_REASONS else None
    if isinstance(doubt_val, dict):
        doubt_obj = {
            "value": bool(doubt_val.get("value")),
            "reason": doubt_val.get("reason") if doubt_val.get("reason") in DOUBT_REASONS else "cannot_tell",
        }
    elif doubt_val is None:
        doubt_obj = None
    else:
        doubt_obj = {"value": bool(doubt_val), "reason": reason or "cannot_tell"}
    arousal = _num(row.get("arousal"))
    return {
        "window_id": row.get("window_id"),
        "valence": _num(row.get("valence")),
        "arousal": arousal,
        "distress": arousal,
        "engaged": row.get("engaged"),
        "resistant": row.get("resistant"),
        "unresolved_doubt": doubt_obj,
        "confidence": _num(row.get("confidence")),
        "text_sha256": row.get("text_sha256"),
        "char_count": row.get("char_count"),
        "model": row.get("model"),
        "prompt_version": row.get("prompt_version") or PROMPT_VERSION,
        "cache_hit": bool(row.get("cache_hit")),
        "input_tokens": int(row.get("input_tokens") or 0),
        "output_tokens": int(row.get("output_tokens") or 0),
        "cost_usd": row.get("cost_usd"),
        "latency_ms": row.get("latency_ms"),
        "status": row.get("status"),
        "reason_rejected": bool(row.get("reason_rejected")),
    }


def _public(row: dict, *, status: str) -> dict:
    row = dict(row)
    row["status"] = status
    return public_score(row)


def _request_body(masked: str, model: str) -> dict:
    if not isinstance(masked, str):
        raise TextLaneError("refusing non-text state")
    state = {"window_text": masked}
    if set(state) - {"window_text"}:
        raise TextLaneError("refusing non-text state")
    return {"model": model, "state": state, "questions": questions()}


def _call(
    body: dict,
    api_key: str,
    timeout_s: float,
    *,
    transport: Transport | None,
    sleep: SleepFn | None,
    rng: random.Random,
) -> tuple[int, dict, int]:
    post = transport or _http_transport
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    pause = sleep or time.sleep
    last_status: int | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        t0 = time.monotonic()
        try:
            res = post(ENDPOINT, body, headers, timeout_s)
        except JevCallError:
            raise
        except Exception:
            if attempt >= MAX_ATTEMPTS:
                raise JevCallError("jev_timeout") from None
            pause(_backoff_s(attempt, rng))
            continue
        latency_ms = int((time.monotonic() - t0) * 1000)
        last_status = res.status
        if res.status in (429, 529):
            if attempt >= MAX_ATTEMPTS:
                raise JevCallError(f"jev http {res.status}", status=res.status)
            pause(_backoff_s(attempt, rng))
            continue
        if res.status != 200:
            raise JevCallError(f"jev http {res.status}", status=res.status)
        try:
            payload = json.loads(res.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise JevCallError("jev: response body was not valid JSON") from None
        if not isinstance(payload, dict):
            raise JevCallError("jev: response body was not valid JSON")
        return res.status, payload, latency_ms
    raise JevCallError(
        "jev_timeout" if last_status is None else f"jev http {last_status}",
        status=last_status,
    )


def _backoff_s(attempt: int, rng: random.Random) -> float:
    base = 250 * 2 ** (attempt - 1)
    return (base + rng.randrange(100)) / 1000.0


def _http_transport(url: str, body: dict, headers: dict, timeout: float) -> TransportResponse:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return TransportResponse(status=int(res.status), body=res.read())
    except urllib.error.HTTPError as exc:
        # Read and drop the provider body. The message must not carry it.
        try:
            exc.read()
        except Exception:
            pass
        return TransportResponse(status=int(exc.code), body=b"")
    except (urllib.error.URLError, TimeoutError, OSError):
        raise TimeoutError("jev_timeout") from None


def _parse_answers(answers: dict, *, model: str) -> dict:
    if not isinstance(answers, dict):
        answers = {}
    valence = _score_answer(answers.get("timbre_valence"))
    arousal = _score_answer(answers.get("timbre_arousal"))
    engaged = _noul_answer(answers.get("timbre_engaged"))
    resistant = _noul_answer(answers.get("timbre_resistant"))
    doubt = _noul_answer(answers.get("timbre_unresolved_doubt"))
    reason, reason_rejected = _reason_answer(answers.get("timbre_doubt_reason"))
    parts = [valence, arousal, engaged, resistant, doubt]
    if any(p is None for p in parts):
        return {
            "model": model,
            "status": "incomplete",
            "valence": None,
            "arousal": None,
            "engaged": None,
            "resistant": None,
            "unresolved_doubt": None,
            "doubt_reason": None,
            "confidence": None,
            "reason_rejected": reason_rejected,
        }
    assert valence and arousal and engaged and resistant and doubt
    if not doubt["value"]:
        reason = "none"
        reason_rejected = False
    elif reason is None or reason == "none":
        reason = "cannot_tell"
    confidences = [
        valence["confidence"],
        arousal["confidence"],
        engaged["confidence"],
        resistant["confidence"],
        doubt["confidence"],
    ]
    return {
        "model": model,
        "status": "ok",
        "valence": valence["value"],
        "arousal": arousal["value"],
        "engaged": engaged["value"],
        "resistant": resistant["value"],
        "unresolved_doubt": doubt["value"],
        "doubt_reason": reason,
        "confidence": min(confidences),
        "reason_rejected": reason_rejected,
    }


def _score_answer(answer: object) -> dict | None:
    if not isinstance(answer, dict) or answer.get("type") != "score":
        return None
    try:
        score = int(answer.get("score"))
    except (TypeError, ValueError):
        return None
    if score < 1 or score > 5:
        return None
    try:
        conf = float(answer.get("confidence"))
    except (TypeError, ValueError):
        return None
    if conf != conf:
        return None
    return {"value": score, "confidence": conf}


def _noul_answer(answer: object) -> dict | None:
    if not isinstance(answer, dict) or answer.get("type") != "noul":
        return None
    try:
        noul = float(answer.get("noul"))
    except (TypeError, ValueError):
        return None
    if noul != noul or noul < 0.0 or noul > 1.0:
        return None
    return {"value": bool(noul >= NOUL_TRUE_AT), "confidence": noul_confidence(noul)}


def _reason_answer(answer: object) -> tuple[str | None, bool]:
    if not isinstance(answer, dict) or answer.get("type") != "choice":
        return None, False
    choice = answer.get("choice")
    if choice in DOUBT_REASONS:
        return str(choice), False
    # Not stored. A free-text choice could be a quote.
    return None, True


def _mock_answers() -> dict:
    """Fixed answers. Model name is jev-mock so a stand-in cannot pass as jev-1.13.0."""
    return {
        "timbre_valence": {"type": "score", "score": 3, "confidence": 0.8, "probabilities": {}, "legend": {}},
        "timbre_arousal": {"type": "score", "score": 2, "confidence": 0.7, "probabilities": {}, "legend": {}},
        "timbre_engaged": {"type": "noul", "noul": 0.9},
        "timbre_resistant": {"type": "noul", "noul": 0.1},
        "timbre_unresolved_doubt": {"type": "noul", "noul": 0.2},
        "timbre_doubt_reason": {
            "type": "choice",
            "choice": "none",
            "probabilities": {"none": 1},
            "confidence": 0.6,
        },
    }


def _cache_read(cache_dir: Path, key: str, model: str) -> dict | None:
    path = _cache_path(cache_dir, key)
    if not path.is_file():
        return None
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(obj, dict):
        return None
    if set(obj) & _FORBIDDEN_KEYS:
        return None
    if obj.get("prompt_version") != PROMPT_VERSION or obj.get("requested_model") != model:
        return None
    if obj.get("question_sha256") != question_sha256():
        return None
    if obj.get("status") != "ok":
        return None
    try:
        return public_score(obj)
    except TextLaneError:
        return None


def _cache_write(cache_dir: Path | str | None, key: str, row: dict, *, requested_model: str) -> None:
    if cache_dir is None or row.get("status") != "ok":
        return
    path = _cache_path(Path(cache_dir), key)
    path.parent.mkdir(parents=True, exist_ok=True)
    stored = public_score(row)
    stored["question_sha256"] = question_sha256()
    stored["requested_model"] = requested_model
    stored["status"] = "ok"
    if set(stored) & _FORBIDDEN_KEYS:
        raise TextLaneError("cache refused")
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(stored, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _cache_path(cache_dir: Path, key: str) -> Path:
    return cache_dir / key[:2] / f"{key}.json"


def _timeout_s(env: dict[str, str]) -> float:
    raw = env.get("ETA_JEV_TIMEOUT_MS")
    if not raw:
        return TIMEOUT_MS_DEFAULT / 1000.0
    try:
        ms = float(raw)
    except ValueError:
        return TIMEOUT_MS_DEFAULT / 1000.0
    if ms != ms or ms <= 0:
        return TIMEOUT_MS_DEFAULT / 1000.0
    return ms / 1000.0


def _num(val: object) -> float | int | None:
    if val is None:
        return None
    if isinstance(val, bool):
        return int(val)
    if isinstance(val, (int, float)):
        return val
    return None


def _environ() -> dict[str, str]:
    import os

    return dict(os.environ)
