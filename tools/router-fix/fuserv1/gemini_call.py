#!/usr/bin/env python3
"""FUSER v1 B2: the Gemini Flash API call wrapper. ZDR route is ASSERTED IN CODE (not just documented):
every reply's own `model` and `provider` fields are checked before the reply is trusted at all, same
pattern as linker's lang_judge.py (eta-refuter-2 PASSed that ZDR route, #4182) -- reused deliberately
rather than re-invented, since it is already reviewed. temperature 0, no seed offered by this route
(design section 3 says "seed if the API offers one" -- OpenRouter's chat/completions does not for this
model as of this writing; noted, not assumed away).

Q2 (ADDENDUM-4, witnessed): Pro is not used here. MODEL is Flash, pinned; switching to Pro needs its own
dated, witnessed addendum with DEV evidence, per that ruling -- not a runtime option this module exposes.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prompt as fp  # noqa: E402
import schema as sc  # noqa: E402

MODEL = "google/gemini-3.8-flash"
MAX_TOKENS = 36000  # RUN 3 (Fable GO #5642): RUN 1/2 runaway generations hit the ~65k cap
URL = "https://openrouter.ai/api/v1/chat/completions"
PROVIDER = {"zdr": True, "data_collection": "deny", "allow_fallbacks": False}
PROMPT_SHA = fp.prompt_sha(MODEL)
WAITS = (0, 4, 12, 30)
_sleep = time.sleep


def get_key(env=None) -> str:
    """Never argv, never logged. Env OPENROUTER_API_KEY, else the file OPENROUTER_KEY_FILE names
    (default ~/.claude/secrets/openrouter_api_key) -- same convention as lang_judge.py."""
    env = os.environ if env is None else env
    k = env.get("OPENROUTER_API_KEY", "").strip()
    if not k:
        path = os.path.expanduser(env.get("OPENROUTER_KEY_FILE", "~/.claude/secrets/openrouter_api_key"))
        with open(path) as f:
            k = f.read().strip()
    if not k:
        raise SystemExit("no OpenRouter key supplied")
    return k


def request_body(slice_payload: dict) -> dict:
    """slice_payload is a JSON-serialisable dict shaped for the prompt -- normally payload.build_payload's
    return (which itself takes prepass.build_slice_prepass's output and trims it to citable tokens +
    flattened drug-candidate fields). Kept decoupled from prepass's exact shape here deliberately: this
    module only knows "a JSON-serialisable payload", never reaches into prepass's internals directly.
    temperature 0, ZDR provider block, strict JSON-schema output. usage.include=True asks OpenRouter to
    report real per-call cost in the reply's own usage block (design section 7 needs DEV cost measured,
    not estimated from a pricing table that could be stale by the time anyone reads it)."""
    return {
        "model": MODEL, "temperature": 0, "max_tokens": MAX_TOKENS, "provider": dict(PROVIDER),
        "response_format": sc.RESPONSE_FORMAT, "usage": {"include": True},
        "messages": [
            {"role": "system", "content": fp.SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(slice_payload, ensure_ascii=False)},
        ],
    }


def http_transport(key: str):
    def send(body: dict):
        req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, None  # the error body is never read or kept (may carry request content)
        except Exception:
            return 0, None
    return send


def call_slice(slice_payload: dict, send) -> dict:
    """dict(data, status, model, provider, tries) on a route-verified, shape-checked reply; dict(data=
    None, status in {"route_mismatch","bad_reply","http_<code>"}) otherwise. NEVER returns a reply
    whose model/provider don't match what was requested -- that would mean no ZDR guarantee held for
    this call, so the reply is discarded regardless of how well-formed its content looks.

    `usage` is included whenever a real HTTP 200 response with a body was received, on EVERY status
    (route_mismatch/bad_reply/bad_shape too, not just "ok") -- eta-refuter-2 #5179, B4's own DEV run: a
    reply whose content didn't parse or didn't match the schema is still a PAID call (OpenRouter bills
    for tokens generated regardless of whether the JSON came out well-formed), and the first version of
    this function silently dropped that cost data on every non-"ok" path, undercounting 8 of 222 DEV
    windows' real spend with no way to recover it after the fact. None only when no response body ever
    existed at all (a genuine http_<code> failure, or send() itself raising/timing out).

    `finish_reason` (eta-refuter-2 #5215) is included the same way -- OpenAI-compatible APIs set this on
    every choice ("stop", "length", "content_filter", ...), and it is exactly the field that would tell us
    whether a bad_reply's malformed JSON was actually a TRUNCATED reply (finish_reason="length", the
    completion hit a token cap mid-JSON) rather than a genuine model formatting error -- unrecoverable for
    B4 RUN 1's own bad_reply windows (that data was never captured), but present in RUN 2 onward."""
    body = request_body(slice_payload)
    bad = 0
    last_status = 0
    for w in WAITS:
        if w:
            _sleep(w)
        status, data = send(body)
        last_status = status
        if status in (429, 500, 502, 503, 504):
            continue
        if status != 200 or not isinstance(data, dict):
            bad += 1
            if bad >= 2:
                break
            continue
        finish_reason = _finish_reason(data)
        if data.get("model") != MODEL or not isinstance(data.get("provider"), str) or not data["provider"].strip():
            return dict(data=None, status="route_mismatch", model=data.get("model"), provider=data.get("provider"),
                       usage=data.get("usage"), finish_reason=finish_reason)
        try:
            content = json.loads(data["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError, ValueError):
            bad += 1
            if bad >= 2:
                return dict(data=None, status="bad_reply", model=data["model"], provider=data["provider"],
                           usage=data.get("usage"), finish_reason=finish_reason)
            continue
        ok, reason = sc.check_shape(content)
        if not ok:
            bad += 1
            if bad >= 2:
                return dict(data=None, status="bad_shape", model=data["model"], provider=data["provider"],
                           reason=reason, usage=data.get("usage"), finish_reason=finish_reason)
            continue
        return dict(data=content, status="ok", model=data["model"], provider=data["provider"],
                   usage=data.get("usage"), finish_reason=finish_reason)
    return dict(data=None, status=f"http_{last_status}", model=None, provider=None, usage=None, finish_reason=None)


def _finish_reason(data: dict):
    """data["choices"][0]["finish_reason"], defensively -- never raises even if choices/the entry itself
    is malformed in some OTHER way than the content-parsing path already handles. AttributeError included
    deliberately: "choices" as a bare string indexes to a single character (no IndexError), and calling
    .get() on THAT raises AttributeError, not KeyError/IndexError/TypeError -- caught here, not assumed."""
    try:
        return data["choices"][0].get("finish_reason")
    except (KeyError, IndexError, TypeError, AttributeError):
        return None
