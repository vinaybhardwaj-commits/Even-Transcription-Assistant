#!/usr/bin/env python3
"""
ETA per-segment language-routed transcription service.

Chunks encounter audio, detects language PER SEGMENT, routes each segment to the
best local engine (English -> whisper.cpp; Indic -> IndicConformer and/or SraVaani), stitches the
result, and (optionally) produces a unified English transcript via Ollama/qwen.

Runs on the Mac Mini. Calls the existing whisper / indic / ollama services over
localhost; it does NOT re-host any models.

  POST /route            multipart: file, [candidates], [translate]  (sync, short clips)
  POST /route/job        json: {audio_url, [candidates], [translate], [window_s], [overlap_s]}
                         -> {ok, job_id}  (ASYNC, for long recordings)
  GET  /route/job/{id}   -> job status/progress + (when done) same shape as /route
  GET  /healthz          -> {"ok": true}

Spec: ETA-MACMINI-PERSEGMENT-LANGUAGE-ROUTER-HANDOFF.md (14 Jun) +
      ETA-MACMINI-CHUNKED-TRANSCRIPTION-JOB-HANDOFF.md (16 Jun).
v2 (16 Jun): silero-VAD segmentation; concurrency=1; expanded candidates.
v3 (16 Jun): async chunked job for long recordings — downloads a presigned URL,
ffmpeg time-splits into ~window_s windows, runs the SAME per-window pipeline
serially, stitches with time-offset, persists a job JSON, exposes poll endpoint.
"""

from __future__ import annotations

import os
import re
import unicodedata
import sys
import glob
import json
import time
import uuid
import asyncio
import wave
import shutil
import tempfile
import threading
import subprocess
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

import requests
from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse

# --------------------------------------------------------------------------- #
# Config (all overridable via environment)
# --------------------------------------------------------------------------- #
WHISPER_URL = os.environ.get("ETA_WHISPER_URL", "http://localhost:8081")
INDIC_URL   = os.environ.get("ETA_INDIC_URL",   "http://localhost:8082")
SRAVAANI_URL = os.environ.get("ETA_SRAVAANI_URL", "http://localhost:8085")
OLLAMA_URL  = os.environ.get("ETA_OLLAMA_URL",  "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("ETA_OLLAMA_MODEL", "qwen2.5:14b")
USE_SRAVAANI = os.environ.get("ETA_USE_SRAVAANI", "1") not in ("0", "false", "False")

PORT = int(os.environ.get("ETA_ROUTER_PORT", "8083"))

DEFAULT_CANDIDATES = os.environ.get("ETA_DEFAULT_CANDIDATES", "en,kn,hi,ta,te")
SEG_SEC      = float(os.environ.get("ETA_SEG_SEC", "30"))
OVERLAP_SEC  = float(os.environ.get("ETA_OVERLAP_SEC", "1"))
USE_VAD      = os.environ.get("ETA_USE_VAD", "1") not in ("0", "false", "False")

# Skip empty / near-empty segments before Whisper / Indic / SraVaani.
# When Silero finds no speech, do NOT fall back to fixed windows of silence.
SEG_MIN_S = float(os.environ.get("ETA_SEG_MIN_S", "0.25"))
SEG_SILENCE_RMS = float(os.environ.get("ETA_SEG_SILENCE_RMS", "0.008"))
# Silero's speech probability floor. CONFIGURABLE, AND THE DEFAULT IS DELIBERATELY UNCHANGED.
# Swept on 19 Sep against the diarizer over six 900 s windows (five starved, one healthy): at the
# 0.50 default the starved windows yield 0-3% of the speech pyannote finds, and at the most
# permissive 0.05 they still yield only 6-44%, while the healthy window is already at 144% of
# pyannote at 0.50 and its spans MERGE (227 spans -> 39) by 0.15, which is worse segmentation, not
# better. No value on that curve recovers this audio, so the number stays where it was and the
# recovery is the fixed-window fallback below. The knob exists to be swept again, not to be tuned
# on a hunch.
VAD_THRESHOLD = float(os.environ.get("ETA_VAD_THRESHOLD", "0.5"))
# /vad limits. A gate pass is batch work: it may wait, but it must not read an unbounded body into
# memory, and it must not still be working for a client that gave up. The app aborts at 120 s.
VAD_MAX_BYTES = int(os.environ.get("ETA_VAD_MAX_BYTES", str(256 * 1024 * 1024)))
VAD_MAX_AUDIO_S = float(os.environ.get("ETA_VAD_MAX_AUDIO_S", "3600"))
VAD_MAX_INFLIGHT = int(os.environ.get("ETA_VAD_MAX_INFLIGHT", "1"))
SEG_SILENCE_MAX_ABS = float(os.environ.get("ETA_SEG_SILENCE_MAX_ABS", "0.02"))

# Async chunked-job config
JOBS_DIR        = os.path.expanduser(os.environ.get("ETA_JOBS_DIR", "~/eta-router/jobs"))
WINDOW_S_DEFAULT = float(os.environ.get("ETA_WINDOW_S", "180"))
JOB_TTL_SEC     = int(os.environ.get("ETA_JOB_TTL_SEC", "3600"))
DOWNLOAD_TIMEOUT = float(os.environ.get("ETA_DOWNLOAD_TIMEOUT", "600"))

# Global cap on concurrent engine calls so this batch job can't starve the live
# transcription path or the note LLM. Acquired around EVERY engine HTTP call.
MAX_INFLIGHT = int(os.environ.get("ETA_MAX_INFLIGHT", "3"))
# Global cap on in-flight chunked-job windows (so a long job can't starve live work).
MAX_WINDOWS_INFLIGHT = int(os.environ.get("ETA_MAX_WINDOWS_INFLIGHT", "1"))

# LID heuristics
ENGLISH_MIN_CHARS = int(os.environ.get("ETA_ENGLISH_MIN_CHARS", "15"))
ENGLISH_MIN_ASCII_RATIO = float(os.environ.get("ETA_ENGLISH_MIN_ASCII_RATIO", "0.5"))
INDIC_MIN_CHARS   = int(os.environ.get("ETA_INDIC_MIN_CHARS", "12"))
SHORT_CIRCUIT = os.environ.get("ETA_SHORT_CIRCUIT", "1") not in ("0", "false", "False")

# Per-call HTTP timeouts (seconds)
WHISPER_TIMEOUT = float(os.environ.get("ETA_WHISPER_TIMEOUT", "120"))
INDIC_TIMEOUT   = float(os.environ.get("ETA_INDIC_TIMEOUT", "120"))
SRAVAANI_TIMEOUT = float(os.environ.get("ETA_SRAVAANI_TIMEOUT", "180"))
OLLAMA_TIMEOUT  = float(os.environ.get("ETA_OLLAMA_TIMEOUT", "180"))
SRAVAANI_MIN_CHARS = int(os.environ.get("ETA_SRAVAANI_MIN_CHARS", "8"))

ENGINE_VERSIONS = {
    "whisper": "large-v3-turbo",
    "indicconformer": "600M",
    "sravaani": "SraVaani-1.0",
}

LANG_NAMES = {
    "kn": "Kannada", "hi": "Hindi", "ta": "Tamil", "te": "Telugu",
    "bn": "Bengali", "mr": "Marathi", "ml": "Malayalam", "gu": "Gujarati",
    "pa": "Punjabi", "or": "Odia", "as": "Assamese", "ur": "Urdu",
    "en": "English",
}

_ENGINE_SEM = threading.BoundedSemaphore(MAX_INFLIGHT)
_WINDOW_SEM = threading.BoundedSemaphore(MAX_WINDOWS_INFLIGHT)
# M1: /route work runs in a worker thread so the event loop can still answer /healthz.
# One /route at a time, as before. _ENGINE_SEM above is unchanged.
_ROUTE_SEM = asyncio.Semaphore(1)
# /vad gets its OWN limit, not /route's.
#
# Sharing _ROUTE_SEM meant a VAD call could queue behind a long transcription, outlast the client's
# 120 s abort, and then run in full for a caller that had already been told vad_unavailable — the
# Mini paying twice for an answer nobody reads. Its own semaphore bounds the concurrency without
# chaining it to transcription, and the disconnect check below drops work whose client is gone.
_VAD_SEM = asyncio.Semaphore(max(1, VAD_MAX_INFLIGHT))
_VAD_MODEL = None
os.makedirs(JOBS_DIR, exist_ok=True)

app = FastAPI(title="eta-router", version="3.1-sravaani")


# --------------------------------------------------------------------------- #
# Engine clients (all calls go through the global semaphore)
# --------------------------------------------------------------------------- #
def whisper_infer(wav_path: str, language: str | None = None, temperature: float = 0.0) -> dict:
    with _ENGINE_SEM:
        with open(wav_path, "rb") as fh:
            # max_context=0 turns off whisper.cpp's previous-text conditioning, the source of the
            # sticky loops. The shim also defaults it, but the router must not depend on the shim.
            data = {"response_format": "json", "temperature": str(temperature), "max_context": "0"}
            if language:
                data["language"] = language
            r = requests.post(f"{WHISPER_URL}/inference", files={"file": fh}, data=data,
                              timeout=WHISPER_TIMEOUT)
    r.raise_for_status()
    try:
        return r.json()
    except ValueError:
        return {"text": r.text}


def indic_infer(wav_path: str, language: str, decoding: str = "rnnt") -> dict:
    with _ENGINE_SEM:
        with open(wav_path, "rb") as fh:
            r = requests.post(f"{INDIC_URL}/inference", files={"file": fh},
                              data={"language": language, "decoding": decoding},
                              timeout=INDIC_TIMEOUT)
    r.raise_for_status()
    try:
        return r.json()
    except ValueError:
        return {"text": r.text}


def sravaani_infer(wav_path: str) -> dict:
    """SraVaani is language-agnostic Indic ASR (no language form field)."""
    with _ENGINE_SEM:
        with open(wav_path, "rb") as fh:
            r = requests.post(f"{SRAVAANI_URL}/inference", files={"file": fh},
                              timeout=SRAVAANI_TIMEOUT)
    # SraVaani returns 200 even on ok:false
    try:
        return r.json()
    except ValueError:
        r.raise_for_status()
        return {"ok": False, "text": r.text, "engine": "sravaani"}


def ollama_translate(text: str, lang_code: str, model: str | None = None) -> str:
    lang_name = LANG_NAMES.get(lang_code, lang_code)
    prompt = (
        f"You are a precise medical translator. Translate the following "
        f"{lang_name} clinical dictation into natural English.\n"
        "Rules:\n"
        "- Preserve every drug name, dose, unit, route, and frequency exactly.\n"
        "- Preserve negations (no/denies/not) precisely.\n"
        "- Do not add, omit, or interpret clinical content.\n"
        "- Output ONLY the English translation, with no preamble or notes.\n\n"
        f"{lang_name} text:\n{text}\n\nEnglish:"
    )
    with _ENGINE_SEM:
        r = requests.post(f"{OLLAMA_URL}/api/generate",
                          json={"model": model or OLLAMA_MODEL, "prompt": prompt, "stream": False,
                                "options": {"temperature": 0.0}},
                          timeout=OLLAMA_TIMEOUT)
    r.raise_for_status()
    return (r.json().get("response") or "").strip()


# --------------------------------------------------------------------------- #
# Translate backends
#
# WHY. `ollama_translate` ran qwen2.5:14b locally — 11.55 GB on a 24 GB Mini, the single largest
# memory hog on the box, and the reason the pressure watchdog went STOP_ on busy afternoons. V ruled
# on 22 Sep that qwen goes. Translation now dispatches on an ENGINE NAME:
#
#     openrouter:<model-id>   OpenRouter chat completions, ZDR + data_collection=deny
#     indictrans2             IndicTrans2 on the Yoga (ETA_INDICTRANS2_URL)
#     ollama:<model>          the old local path — reachable ONLY by naming it; no default uses it
#     none                    no translation
#
# THE LABEL IS DERIVED, NOT TYPED. Every result carries the engine that ACTUALLY answered and the
# `model` string the RESPONSE reported, so a fallback is visible in the data rather than assumed
# from configuration. On total failure the English is None with `translate_error` set.
#
# NEVER THE SOURCE TEXT AS ENGLISH. The code this replaces did exactly that: a failed translation
# fell through `except Exception: return seg["text"]`, and native-script text was stored in
# `transcript_english`. Nothing here returns source text on failure. The one place source text is
# returned is when the input is already English — and then the label says so (`skip:english`).
# --------------------------------------------------------------------------- #
TRANSLATE_ENGINE   = os.environ.get("ETA_TRANSLATE_ENGINE", "openrouter:google/gemini-2.5-flash-lite")
TRANSLATE_FALLBACK = [e.strip() for e in os.environ.get(
    "ETA_TRANSLATE_FALLBACK", "openrouter:openai/gpt-5-nano,indictrans2").split(",") if e.strip()]
OPENROUTER_URL      = os.environ.get("ETA_OPENROUTER_URL", "https://openrouter.ai/api/v1/chat/completions")
OPENROUTER_KEY_FILE = os.environ.get("ETA_OPENROUTER_KEY_FILE", "")
OPENROUTER_TIMEOUT  = float(os.environ.get("ETA_OPENROUTER_TIMEOUT", "60"))
INDICTRANS2_URL     = os.environ.get("ETA_INDICTRANS2_URL", "")
INDICTRANS2_TIMEOUT = float(os.environ.get("ETA_INDICTRANS2_TIMEOUT", "60"))

TRANSLATE_SYSTEM_PROMPT = (
    "You translate a clinic conversation transcript into English, faithfully.\n"
    "- Leave English words and English sentences exactly as they are.\n"
    "- Keep drug names, doses, numbers and units exact.\n"
    "- Never summarise, and never add or drop any content.\n"
    "- If the input is already English, return it unchanged.\n"
    "- Output only the translation: no preamble, no notes, no quotation marks."
)

# FLORES-200 codes, the contract the Yoga's IndicTrans2 speaks.
INDICTRANS2_LANG = {
    "hi": "hin_Deva", "kn": "kan_Knda", "ta": "tam_Taml", "te": "tel_Telu", "ml": "mal_Mlym",
    "bn": "ben_Beng", "mr": "mar_Deva", "gu": "guj_Gujr", "pa": "pan_Guru", "or": "ory_Orya",
    "as": "asm_Beng", "ur": "urd_Arab",
}


class TranslateError(Exception):
    """One engine could not translate. The message is a SHORT CODE, safe to store and log: it must
    never carry the key, a request header, or any of the text being translated."""


def _openrouter_key() -> str:
    """Read at CALL time from the file ETA_OPENROUTER_KEY_FILE names. Never cached in a module
    global, never logged, never placed in argv. A missing or empty file is an engine failure."""
    if not OPENROUTER_KEY_FILE:
        raise TranslateError("openrouter_key_file_unset")
    try:
        with open(OPENROUTER_KEY_FILE, "r", encoding="utf-8") as fh:
            key = fh.read().strip()
    except OSError:
        raise TranslateError("openrouter_key_unreadable")
    if not key:
        raise TranslateError("openrouter_key_empty")
    return key


def openrouter_translate(text: str, lang_code: str, model: str) -> tuple[str, str]:
    """-> (translation, model the RESPONSE reported). ZDR and no data collection, every call."""
    key = _openrouter_key()
    body = {
        "model": model,
        "temperature": 0,
        "provider": {"zdr": True, "data_collection": "deny"},
        "messages": [
            {"role": "system", "content": TRANSLATE_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
    }
    try:
        r = requests.post(OPENROUTER_URL, json=body, timeout=OPENROUTER_TIMEOUT,
                          headers={"Authorization": f"Bearer {key}",
                                   "Content-Type": "application/json"})
    except requests.Timeout:
        raise TranslateError("openrouter_timeout")
    except requests.RequestException as ex:
        # The exception CLASS only. Its message can include the request, and the request
        # carries the key in a header.
        raise TranslateError(f"openrouter_unreachable:{type(ex).__name__}")
    if r.status_code != 200:
        raise TranslateError(f"openrouter_http_{r.status_code}")
    try:
        j = r.json()
        content = j["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError, AttributeError):
        raise TranslateError("openrouter_bad_response")
    # D1. OpenAI-schema `content` may legally be an ARRAY of parts, or whatever a routed provider
    # sends. Only a string is a translation. Anything else is a bad response that falls through to
    # the next engine — `(content or "").strip()` used to raise AttributeError here, which is not a
    # TranslateError, so it skipped the whole fallback chain and failed the job.
    if content is None:
        content = ""
    if not isinstance(content, str):
        raise TranslateError("openrouter_bad_response")
    out = content.strip()
    if not out:
        raise TranslateError("openrouter_empty")
    return out, str(j.get("model") or model)


def indictrans2_translate(text: str, lang_code: str) -> tuple[str, str]:
    """-> (translation, model the RESPONSE reported). The Yoga's contract: POST /translate."""
    if not INDICTRANS2_URL:
        raise TranslateError("indictrans2_url_unset")
    src = INDICTRANS2_LANG.get(lang_code)
    if not src:
        raise TranslateError(f"indictrans2_no_lang:{lang_code}")
    try:
        r = requests.post(f"{INDICTRANS2_URL.rstrip('/')}/translate", timeout=INDICTRANS2_TIMEOUT,
                          json={"text": text, "src_lang": src, "tgt_lang": "eng_Latn"})
    except requests.Timeout:
        raise TranslateError("indictrans2_timeout")
    except requests.RequestException as ex:
        raise TranslateError(f"indictrans2_unreachable:{type(ex).__name__}")
    if r.status_code != 200:
        raise TranslateError(f"indictrans2_http_{r.status_code}")
    try:
        j = r.json()
        out = (j.get("translation") or "").strip()
    except (ValueError, AttributeError):
        raise TranslateError("indictrans2_bad_response")
    if not out:
        raise TranslateError("indictrans2_empty")
    return out, str(j.get("model") or "indictrans2")


# English function words: split-speaker's measured set (`EN_STOP` in
# scripts/split-speaker-pilot/je_bakeoff.py, EvenScribe repo), plus `when`, `where`, `why`, which the
# 22 Sep ruling names and EN_STOP lacks. Under this set 789 of 862 Latin-script sentences were true
# English and the 73 romanised-Indic outliers were caught. Deliberately NOT extended further: words
# like `me`, `hai` or `aap` would let romanised Hindi through, and the measurement is for this set.
EN_FUNCTION_WORDS = frozenset({
    "the", "is", "are", "and", "to", "of", "you", "your", "what", "have", "has", "it", "this", "that",
    "in", "for", "on", "with", "do", "does", "not", "be", "was", "can", "will", "i", "we", "he", "she",
    "they", "my", "a", "an", "please", "how", "any", "take", "no", "yes", "ok", "okay", "one", "two",
    "three", "day", "days", "times", "after", "before", "morning", "night", "once", "twice",
    "when", "where", "why",
})

# D4. Romanised Hindi / Kannada tokens that VETO the English skip. The function-word test alone let
# 6 of ETA-Refuter's 10 synthetic non-English cases skip, two ways: Hindi homographs (`the` = "were",
# `is` = "this", `to` is a particle) and code-mix that borrows clinical English (`two days`,
# `morning`, `take`). One hit here means the segment goes to the translator, whose prompt returns
# English unchanged — so a false veto costs one call, and a missed one stores Indic text as English.
#
# Fable's list (22 Sep), plus the tokens ETA-Refuter's failing cases need (`vo`, `kal`, `hum`,
# `wahan`, `subah`, `karta`, `hoon`, `matlab`). Words that are ALSO common English (`to`, `is`,
# `the`, `me`, `main`, `sir`) are deliberately absent: vetoing them would stop true English skipping.
ROMANISED_INDIC_VETO = frozenset({
    # Fable's list
    "hai", "hain", "nahi", "nahin", "kya", "kaise", "aap", "aapko", "mujhe", "mera", "meri", "kitne",
    "din", "se", "ko", "ka", "ki", "ke", "bhi", "toh", "tho", "haan", "accha", "theek", "dard",
    "bukhar", "dawai", "goli", "beta", "amma", "appa", "illa", "beku", "maadi", "yenu", "hogi",
    "hoga", "raha", "rahi", "wala",
    # from ETA-Refuter's six failing cases
    "vo", "kal", "hum", "wahan", "subah", "karta", "hoon", "matlab",
})


def verified_english(text: str) -> bool:
    """Skip translation ONLY for text that is verifiably English: at least 90% ASCII letters AND at
    least 20% English function words AND not one romanised-Indic veto token (D4).

    THE LANGUAGE LABEL IS NOT CONSULTED, in either direction. It is not reliable: Whisper labels
    romanised Hindi `en` (seen on a synthetic Hindi clip, 22 Sep), split-speaker found segments
    tagged Malayalam, Bengali and code-mixed skipped as English, and lx found 7 sessions tagged
    kn-IN/hi-IN holding English. Script alone is not reliable either — "aapko kitne din se bukhar
    hai" is pure ASCII and pure Hindi. Everything that fails this test goes to the translator,
    whose prompt already returns English unchanged; a false "not English" costs one cheap call,
    a false "English" puts untranslated Indic text in transcript_english.
    """
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return False
    if sum(1 for c in letters if c.isascii()) / len(letters) < 0.9:
        return False
    words = [w.lower() for w in re.findall(r"[A-Za-z']+", text)]
    if not words:
        return False
    # D4: any romanised-Indic token vetoes the skip, however English the rest looks.
    if any(w in ROMANISED_INDIC_VETO for w in words):
        return False
    return sum(1 for w in words if w in EN_FUNCTION_WORDS) / len(words) >= 0.20


def _dispatch(engine: str, text: str, lang_code: str) -> tuple[str, str]:
    """One engine, one attempt. Raises TranslateError on any failure."""
    if engine.startswith("openrouter:"):
        model = engine.split(":", 1)[1].strip()
        if not model:
            raise TranslateError("openrouter_no_model")
        return openrouter_translate(text, lang_code, model)
    if engine == "indictrans2":
        return indictrans2_translate(text, lang_code)
    if engine.startswith("ollama:"):
        model = engine.split(":", 1)[1].strip() or OLLAMA_MODEL
        try:
            out = ollama_translate(text, lang_code, model)
        except requests.Timeout:
            raise TranslateError("ollama_timeout")
        except Exception as ex:
            raise TranslateError(f"ollama_failed:{type(ex).__name__}")
        if not out:
            raise TranslateError("ollama_empty")
        return out, model
    raise TranslateError(f"unknown_engine:{engine}")


# THE SHARED GUARD (D1, D2, D2-pools): every backend call goes through `_call_backend`, so no
# backend can raise out of translate() and none can outlive its deadline.
#
# ONE POOL PER ENGINE (ETA-Refuter, round 4, 22 Sep). A single shared pool meant a primary engine
# that only DRIPS bytes (a server sending them slowly enough that `requests`' own per-read timeout
# never fires) never freed its worker — `requests` calls cannot be cancelled from outside. Every
# retry against that sick engine piled another abandoned worker into the SAME pool; once the pool
# was exhausted, the HEALTHY fallback engine's call queued behind them and was itself cancelled at
# ITS OWN deadline before a worker ever picked it up. From round 4, every window's English was null.
# Each engine now gets its OWN bounded pool, created lazily and cached for the process's life: a
# sick engine can only exhaust ITS OWN workers, never another engine's.
_BACKEND_POOL_WORKERS = max(1, int(os.environ.get("ETA_BACKEND_POOL_WORKERS", "4") or 4))
_BACKEND_POOLS: dict[str, ThreadPoolExecutor] = {}
_BACKEND_POOLS_LOCK = threading.Lock()


def _pool_for(engine: str) -> ThreadPoolExecutor:
    """The engine string IS the pool key — e.g. `openrouter:google/gemini-2.5-flash-lite` and
    `openrouter:openai/gpt-5-nano` are DIFFERENT keys even though both are `openrouter:`-typed,
    which is exactly the point: a stuck primary must never be able to starve its own fallback.
    Checked unlocked first (the common case: the pool already exists), locked only to create one."""
    pool = _BACKEND_POOLS.get(engine)
    if pool is not None:
        return pool
    with _BACKEND_POOLS_LOCK:
        pool = _BACKEND_POOLS.get(engine)
        if pool is None:
            safe = re.sub(r"[^A-Za-z0-9_.-]", "-", engine)[:32]
            pool = ThreadPoolExecutor(max_workers=_BACKEND_POOL_WORKERS,
                                       thread_name_prefix=f"translate-{safe}")
            _BACKEND_POOLS[engine] = pool
        return pool


def _deadline_for(engine: str) -> float:
    """The WALL-CLOCK bound for one call, read at call time. `requests`' own `timeout` is per socket
    read: a server trickling a byte every 0.5 s kept a 1 s call alive 8 s and it succeeded
    (ETA-Refuter, D2). This bound is the whole call — connect, headers and body."""
    if engine.startswith("openrouter:"):
        return OPENROUTER_TIMEOUT
    if engine == "indictrans2":
        return INDICTRANS2_TIMEOUT
    if engine.startswith("ollama:"):
        return OLLAMA_TIMEOUT
    return OPENROUTER_TIMEOUT


def _call_backend(engine: str, text: str, lang_code: str) -> tuple[str, str]:
    """One engine, one attempt, bounded. Raises ONLY TranslateError, with a short code."""
    fut = _pool_for(engine).submit(_dispatch, engine, text, lang_code)
    try:
        return fut.result(timeout=_deadline_for(engine))
    except FuturesTimeout:
        fut.cancel()  # a call still queued at its deadline never starts (ETA-Refuter H9)
        raise TranslateError(f"{engine.split(':', 1)[0]}_deadline")
    except TranslateError:
        raise
    except Exception as ex:
        # D1, generalised: whatever a backend raises becomes a failure that falls through to the
        # next engine. The exception CLASS only — a message can carry request text or a header.
        raise TranslateError(f"unexpected:{type(ex).__name__}")


def _allowed_overrides() -> set[str]:
    """A per-request `translate_engine` may name only what the router is configured to use, plus
    indictrans2. The router has no auth on its own routes, so an open override would let any caller
    pick `ollama:<model>` (11.5 GB back onto the Mini) or any OpenRouter model. Read at call time."""
    return {TRANSLATE_ENGINE, *TRANSLATE_FALLBACK, "indictrans2"}


def translate(text: str, lang_code: str | None, engine: str | None = None) -> dict:
    """Translate one piece of text. Returns a result dict — never raises, never lies.

        english           str | None   None means "no English was produced"
        translate_engine  str | None   the engine that ANSWERED (or `skip:english` / `none`)
        translate_model   str | None   the model string the RESPONSE reported
        translate_ms      int
        translate_error   str | None   set only when every engine tried failed

    `engine` given (the per-request `translate_engine`) means THAT ENGINE ONLY, no fallback: a
    bake-off that quietly fell back would score the wrong engine and not know it.
    """
    t0 = time.time()
    ms = lambda: int((time.time() - t0) * 1000)
    if not text:
        return {"english": "", "translate_engine": None, "translate_model": None,
                "translate_ms": 0, "translate_error": None}
    if engine == "none":
        return {"english": None, "translate_engine": "none", "translate_model": None,
                "translate_ms": 0, "translate_error": None}
    if engine and engine not in _allowed_overrides():
        # Refused before anything else, English skip included: a request naming an engine this
        # router does not use is a bad request, and it gets no translation from anyone.
        return {"english": None, "translate_engine": None, "translate_model": None,
                "translate_ms": ms(), "translate_error": f"engine_not_allowed:{engine[:80]}"}
    if verified_english(text):
        return {"english": text, "translate_engine": "skip:english", "translate_model": None,
                "translate_ms": ms(), "translate_error": None}

    chain = [engine] if engine else [TRANSLATE_ENGINE] + TRANSLATE_FALLBACK
    failures = []
    for e in chain:
        try:
            out, model = _call_backend(e, text, lang_code or "")
            return {"english": out, "translate_engine": e, "translate_model": model,
                    "translate_ms": ms(), "translate_error": None}
        except TranslateError as ex:
            failures.append(f"{e}={ex}")
    # Short codes only: no text, no key, no header. Safe to store on the row.
    return {"english": None, "translate_engine": None, "translate_model": None,
            "translate_ms": ms(), "translate_error": "all_engines_failed: " + "; ".join(failures)}


def summarise_translation(results: list[dict]) -> dict:
    """Window-level labels from per-segment results. DERIVED: the distinct engines and models that
    actually answered, never the configured default."""
    engines = sorted({r["translate_engine"] for r in results if r.get("translate_engine")})
    models  = sorted({r["translate_model"] for r in results if r.get("translate_model")})
    errors  = [r["translate_error"] for r in results if r.get("translate_error")]
    return {
        "translate_engine": ",".join(engines) or None,
        "translate_model":  ",".join(models) or None,
        "translate_ms":     sum(int(r.get("translate_ms") or 0) for r in results),
        "translate_error":  (f"{len(errors)} of {len(results)} segments failed: {errors[0]}"
                             if errors else None),
    }


# --------------------------------------------------------------------------- #
# Audio helpers
# --------------------------------------------------------------------------- #
def normalize_to_wav(src_path: str, dst_path: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-i", src_path, "-ac", "1", "-ar", "16000",
                    "-c:a", "pcm_s16le", "-f", "wav", dst_path], check=True, capture_output=True)


def wav_duration_s(wav_path: str) -> float:
    with wave.open(wav_path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def slice_wav(src_wav: str, start_s: float, end_s: float, dst_wav: str) -> None:
    with wave.open(src_wav, "rb") as w:
        sr, nframes = w.getframerate(), w.getnframes()
        ch, sw = w.getnchannels(), w.getsampwidth()
        start = max(0, int(start_s * sr))
        end = min(nframes, int(end_s * sr))
        w.setpos(start)
        frames = w.readframes(max(0, end - start))
    with wave.open(dst_wav, "wb") as o:
        o.setnchannels(ch); o.setsampwidth(sw); o.setframerate(sr); o.writeframes(frames)


def wav_rms_peak(wav_path: str) -> tuple[float, float]:
    """Stdlib RMS + peak on 16-bit WAV (normalized to [-1,1])."""
    with wave.open(wav_path, "rb") as w:
        nframes = w.getnframes()
        sw = w.getsampwidth()
        raw = w.readframes(nframes)
    if nframes <= 0 or not raw or sw != 2:
        return 0.0, 0.0
    import array, math
    samples = array.array("h")
    samples.frombytes(raw)
    if not samples:
        return 0.0, 0.0
    acc = 0.0
    peak = 0.0
    scale = 32768.0
    for s in samples:
        x = s / scale
        acc += x * x
        ax = abs(x)
        if ax > peak:
            peak = ax
    return math.sqrt(acc / len(samples)), peak


def is_near_silent_wav(wav_path: str) -> tuple[bool, float, float]:
    rms, peak = wav_rms_peak(wav_path)
    return (rms < SEG_SILENCE_RMS and peak < SEG_SILENCE_MAX_ABS), rms, peak


def plan_segments(total_s: float) -> list[tuple[float, float]]:
    hop = max(1.0, SEG_SEC - OVERLAP_SEC)
    spans, t = [], 0.0
    while t < total_s:
        spans.append((t, min(t + SEG_SEC, total_s)))
        t += hop
    return spans or [(0.0, total_s)]


def vad_segments(wav_path: str, total_s: float):
    if not USE_VAD:
        return plan_segments(total_s), "fixed-window"
    try:
        import torch
        import soundfile as sf
        from silero_vad import load_silero_vad, get_speech_timestamps
        global _VAD_MODEL
        if _VAD_MODEL is None:
            _VAD_MODEL = load_silero_vad()
        arr, _sr = sf.read(wav_path, dtype="float32")
        if getattr(arr, "ndim", 1) > 1:
            arr = arr.mean(axis=1)
        ts = get_speech_timestamps(torch.from_numpy(arr), _VAD_MODEL,
                                   sampling_rate=16000, return_seconds=True,
                                   threshold=VAD_THRESHOLD)
        chunks = []
        cs = ce = None
        for t in ts:
            s, e = float(t["start"]), float(t["end"])
            if e - s > SEG_SEC:
                if cs is not None:
                    chunks.append((cs, ce)); cs = ce = None
                while e - s > SEG_SEC:
                    chunks.append((s, s + SEG_SEC)); s += SEG_SEC
                cs, ce = s, e
                continue
            if cs is None:
                cs, ce = s, e
            elif e - cs <= SEG_SEC:
                ce = e
            else:
                chunks.append((cs, ce)); cs, ce = s, e
        if cs is not None:
            chunks.append((cs, ce))
        spans = [(round(a, 2), round(b, 2)) for (a, b) in chunks if (b - a) >= SEG_MIN_S]
        if spans:
            return spans, "silero-vad"
        # SILERO FOUND NOTHING, WHICH IS NOT THE SAME AS THERE BEING NOTHING.
        #
        # This used to return [] and the caller replied `silent_skipped` with an empty transcript.
        # Measured on 19 Sep: across 30 room windows the VAD keeps 50.4% of the speech the diarizer
        # finds, 11 of 30 keep under 5%, and 5 windows returned ZERO spans on audio holding 179-671
        # seconds of diarized speech. On low-SNR far-field room audio "no speech" is a VAD failure
        # far more often than it is a quiet room, and gain does not rescue it (normalising a starved
        # window to a healthy window's level still yields 3 s of 285).
        #
        # So we fall through to fixed windows and let the ENGINES decide, which is the one thing
        # that actually listens to the audio. The per-segment silence gate (is_near_silent_wav)
        # still drops near-silent fixed windows before any engine call, so a genuinely quiet window
        # costs a cheap RMS pass per segment rather than a transcription.
        #
        # The method name travels: `fixed-window-vad-empty` is how often this happens, countable
        # from the stored run.
        sys.stderr.write("[eta-router] silero-vad: no speech spans; falling back to fixed windows\n")
        return plan_segments(total_s), "fixed-window-vad-empty"
    except Exception as ex:
        sys.stderr.write(f"[eta-router] VAD unavailable, fixed windows: {ex!r}\n")
    return plan_segments(total_s), "fixed-window-fallback"


# --------------------------------------------------------------------------- #
# Per-segment language ID + transcription
# --------------------------------------------------------------------------- #
_WS = re.compile(r"\s+")


def looks_real_english(text: str) -> bool:
    """True only when Whisper English looks like real speech, not a loop/confabulation.
    Tightened 2026-09-04: catch n-gram / short-clause loops the old unique-word ratio missed."""
    from collections import Counter
    t = (text or "").strip()
    if len(t) < ENGLISH_MIN_CHARS:
        return False
    letters = sum(1 for c in t if c.isascii() and c.isalpha())
    if letters / max(1, len(t)) < ENGLISH_MIN_ASCII_RATIO:
        return False
    words = [re.sub(r"[^a-z0-9'-]", "", w) for w in _WS.split(t.lower()) if w]
    words = [w for w in words if w]
    if len(words) >= 4 and len(set(words)) / len(words) < 0.45:
        return False
    # Split on . ! ? and newlines (newline -> period first).
    clauses = [re.sub(r"\s+", " ", c).strip().lower()
               for c in re.split(r"[.!?]+", t.replace("\n", ".")) if c.strip()]
    if len(clauses) >= 2:
        counts = Counter(clauses)
        if any(v >= 2 and len(c.split()) >= 3 for c, v in counts.items()):
            return False
        if len(set(clauses)) / len(clauses) < 0.6:
            return False
    lines = [ln.strip().lower() for ln in t.splitlines() if ln.strip()]
    if len(lines) >= 2:
        for a, b in zip(lines, lines[1:]):
            if a == b and len(a.split()) >= 3:
                return False
        lc = Counter(lines)
        if any(v >= 3 and len(c.split()) >= 2 for c, v in lc.items()):
            return False
    if len(words) >= 8:
        for n in (3, 4, 5):
            grams = [" ".join(words[i:i + n]) for i in range(len(words) - n + 1)]
            if grams and Counter(grams).most_common(1)[0][1] >= 3:
                return False
    return True


def has_indic_script(text: str) -> bool:
    if not text:
        return False
    for ch in text:
        o = ord(ch)
        if (0x0900 <= o <= 0x097F or  # Devanagari
            0x0B80 <= o <= 0x0BFF or  # Tamil
            0x0C00 <= o <= 0x0C7F or  # Telugu
            0x0C80 <= o <= 0x0CFF or  # Kannada
            0x0D00 <= o <= 0x0D7F or  # Malayalam
            0x0980 <= o <= 0x09FF or  # Bengali
            0x0A80 <= o <= 0x0AFF or  # Gujarati
            0x0A00 <= o <= 0x0A7F):   # Gurmukhi
            return True
    return False


def guess_indic_lang(text: str) -> str:
    """Best-effort script → ISO code for reporting (SraVaani has no lang field)."""
    counts = {"hi": 0, "ta": 0, "te": 0, "kn": 0, "ml": 0, "bn": 0, "gu": 0, "pa": 0}
    for ch in text or "":
        o = ord(ch)
        if 0x0900 <= o <= 0x097F: counts["hi"] += 1
        elif 0x0B80 <= o <= 0x0BFF: counts["ta"] += 1
        elif 0x0C00 <= o <= 0x0C7F: counts["te"] += 1
        elif 0x0C80 <= o <= 0x0CFF: counts["kn"] += 1
        elif 0x0D00 <= o <= 0x0D7F: counts["ml"] += 1
        elif 0x0980 <= o <= 0x09FF: counts["bn"] += 1
        elif 0x0A80 <= o <= 0x0AFF: counts["gu"] += 1
        elif 0x0A00 <= o <= 0x0A7F: counts["pa"] += 1
    best = max(counts, key=counts.get)
    return best if counts[best] > 0 else "und"


def score_asr_text(text: str) -> float:
    """Higher is better. Prefer real Indic script, then substance."""
    t = (text or "").strip()
    if not t:
        return -1.0
    indic_chars = sum(1 for ch in t if has_indic_script(ch))
    # whole-string script bonus
    script_bonus = 1000.0 if has_indic_script(t) else 0.0
    # penalize tiny scraps
    if len(t) < 4:
        return script_bonus + len(t) * 0.1
    return script_bonus + len(t) + indic_chars * 0.5


# --------------------------------------------------------------------------- #
# A-ETA-2: post-decode collapse. Idempotent, and it never drops a distinct line.
#
# Two passes, the same rules as the whisper-shim's collapse_whisper_payload so the two agree:
#   · within one decoded text, a word (>=3 chars) or a phrase (>=8 chars) repeated 3+ times in a
#     row keeps one copy (collapse_phrase_loops). A NUMBER is never collapsed as a repeated word:
#     "one one one" can be a 1-1-1 regimen, and "two two two tablets" must not become "two tablets";
#   · across a window's segments, a segment IDENTICAL AFTER FOLDING (case, ASCII punctuation, danda,
#     whitespace) to the one before it, contiguous with it (gap <= 1.5 s) and not from a different
#     speaker, is dropped and its span folded into the kept one (collapse_segments). Nothing fuzzy:
#     a word-set rule merged "2 in the morning and 1 at night" with its dose swap (Refuter F1).
# Both run to a fixed point, so applying either twice changes nothing. A whisper answer that the
# shim has already collapsed (shim_collapse: true) is left as it is.
# --------------------------------------------------------------------------- #
_STICKY_WORD_RE = re.compile(r"\b(\w{3,})(?:\s+\1){2,}\b", re.IGNORECASE)
COLLAPSE_MIN_REPEATS = 3
_PUNCT_FOLD = re.compile(r"[!-/:-@\[-`{-~\u0964\u0965]")
# Two identical segments further apart than this are two utterances ("Yes." ... "Yes."), not a loop.
DEDUPE_MAX_GAP_S = 1.5

# Number words: never collapsed as a repeated word, and a repeated PHRASE holding one is never
# collapsed either. "one one one" can be a 1-1-1 regimen, "pachas milligram" x3 can be three doses
# read out, and a missing word could change a dose. Over-inclusion only leaves a loop in place.
#
# GENERATED, NOT HAND-LISTED (Refuter round 3, 22 Sep: the hand list missed Hindi 21-99, Kannada
# 13-19 and 40-90, and 9 of its 18 Hindi entries existed in one script only). Every cardinal 0-100
# comes from the tables below, and every row carries BOTH scripts, so the romanised and native halves
# cover the same numbers by construction (a test asserts it):
#   · Hindi 0-100 is irregular, so it is a full table, one row per number.
#   · Kannada 0-20 and the round tens are a table; 21-99 are built by the regular sandhi rule
#     (ಇಪ್ಪತ್ತು + ಒಂದು -> ಇಪ್ಪತ್ತೊಂದು, ippattu + ondu -> ippattondu; ಇಪ್ಪತ್ + ಮೂರು -> ಇಪ್ಪತ್ಮೂರು).
# Fractions, ordinals, magnitudes and English stay a short list (NUMBER_WORDS_EXTRA), each in both
# scripts where it has one. Any character with a Unicode numeric value (½, ¼, digits of any script)
# also makes a token a number (is_number_token).
HINDI_NUMBERS: tuple[tuple[int, tuple[str, ...], tuple[str, ...]], ...] = (
    (0, ('shunya', 'sunya'), ('शून्य',)),
    (1, ('ek',), ('एक',)),
    (2, ('do',), ('दो',)),
    (3, ('teen', 'tin'), ('तीन',)),
    (4, ('char', 'chaar'), ('चार',)),
    (5, ('paanch', 'panch'), ('पाँच', 'पांच')),
    (6, ('chhah', 'chhe', 'che', 'chhah'), ('छह', 'छः', 'छे')),
    (7, ('saat', 'sat'), ('सात',)),
    (8, ('aath', 'ath'), ('आठ',)),
    (9, ('nau',), ('नौ',)),
    (10, ('das',), ('दस',)),
    (11, ('gyarah', 'gyaarah'), ('ग्यारह',)),
    (12, ('barah', 'baarah'), ('बारह',)),
    (13, ('terah',), ('तेरह',)),
    (14, ('chaudah',), ('चौदह',)),
    (15, ('pandrah', 'pandra'), ('पंद्रह', 'पन्द्रह')),
    (16, ('solah',), ('सोलह',)),
    (17, ('satrah', 'satra'), ('सत्रह',)),
    (18, ('atharah', 'athara'), ('अठारह',)),
    (19, ('unnis', 'unnees'), ('उन्नीस',)),
    (20, ('bees', 'bis'), ('बीस',)),
    (21, ('ikkis', 'ikkees'), ('इक्कीस',)),
    (22, ('bais', 'baais', 'baees'), ('बाईस',)),
    (23, ('teis', 'teyis'), ('तेईस',)),
    (24, ('chaubis', 'chaubees'), ('चौबीस',)),
    (25, ('pachchis', 'pachchees', 'pachis', 'pachees'), ('पच्चीस',)),
    (26, ('chhabbis', 'chabbis', 'chhabbees'), ('छब्बीस',)),
    (27, ('sattais', 'sattaees'), ('सत्ताईस',)),
    (28, ('atthais', 'athais', 'atthaees'), ('अट्ठाईस', 'अठ्ठाईस', 'अठाईस')),
    (29, ('untis', 'untees'), ('उनतीस',)),
    (30, ('tees', 'tis'), ('तीस',)),
    (31, ('iktis', 'iktees'), ('इकतीस',)),
    (32, ('battis', 'battees'), ('बत्तीस',)),
    (33, ('taintis', 'taintees'), ('तैंतीस',)),
    (34, ('chauntis', 'chauntees'), ('चौंतीस',)),
    (35, ('paintis', 'paintees'), ('पैंतीस',)),
    (36, ('chhattis', 'chattis', 'chhattees'), ('छत्तीस',)),
    (37, ('saintis', 'saintees'), ('सैंतीस',)),
    (38, ('adtis', 'adtees', 'artis'), ('अड़तीस',)),
    (39, ('untalis', 'untalees'), ('उनतालीस',)),
    (40, ('chalis', 'chalees'), ('चालीस',)),
    (41, ('iktalis', 'iktalees'), ('इकतालीस',)),
    (42, ('bayalis', 'bayalees'), ('बयालीस',)),
    (43, ('taintalis', 'taintalees'), ('तैंतालीस',)),
    (44, ('chawalis', 'chavalis', 'chauvalis'), ('चवालीस', 'चौवालीस')),
    (45, ('paintalis', 'paintalees'), ('पैंतालीस',)),
    (46, ('chhiyalis', 'chhiyalees'), ('छियालीस',)),
    (47, ('saintalis', 'saintalees'), ('सैंतालीस',)),
    (48, ('adtalis', 'adtalees', 'artalis'), ('अड़तालीस',)),
    (49, ('unchas',), ('उनचास',)),
    (50, ('pachas', 'pachaas'), ('पचास',)),
    (51, ('ikyavan', 'ikyawan'), ('इक्यावन',)),
    (52, ('bavan', 'bawan'), ('बावन',)),
    (53, ('tirepan', 'tirpan'), ('तिरेपन', 'तिरपन')),
    (54, ('chauvan', 'chauwan'), ('चौवन',)),
    (55, ('pachpan',), ('पचपन',)),
    (56, ('chhappan', 'chappan'), ('छप्पन',)),
    (57, ('sattavan', 'sattawan'), ('सत्तावन',)),
    (58, ('atthavan', 'atthawan'), ('अट्ठावन',)),
    (59, ('unsath',), ('उनसठ',)),
    (60, ('saath', 'sath'), ('साठ',)),
    (61, ('iksath',), ('इकसठ',)),
    (62, ('basath', 'baasath'), ('बासठ',)),
    (63, ('tirsath', 'tresath'), ('तिरसठ',)),
    (64, ('chaunsath',), ('चौंसठ',)),
    (65, ('painsath',), ('पैंसठ',)),
    (66, ('chhiyasath',), ('छियासठ',)),
    (67, ('sadsath', 'sarsath'), ('सड़सठ',)),
    (68, ('adsath', 'arsath'), ('अड़सठ',)),
    (69, ('unhattar',), ('उनहत्तर',)),
    (70, ('sattar',), ('सत्तर',)),
    (71, ('ikhattar', 'ikahattar'), ('इकहत्तर',)),
    (72, ('bahattar',), ('बहत्तर',)),
    (73, ('tihattar',), ('तिहत्तर',)),
    (74, ('chauhattar',), ('चौहत्तर',)),
    (75, ('pachhattar', 'pachattar'), ('पचहत्तर',)),
    (76, ('chhihattar',), ('छिहत्तर',)),
    (77, ('sathattar', 'satattar'), ('सतहत्तर',)),
    (78, ('athhattar', 'athattar'), ('अठहत्तर',)),
    (79, ('unyasi', 'unasi'), ('उन्यासी', 'उनासी')),
    (80, ('assi',), ('अस्सी',)),
    (81, ('ikyasi',), ('इक्यासी',)),
    (82, ('bayasi',), ('बयासी',)),
    (83, ('tirasi',), ('तिरासी',)),
    (84, ('chaurasi',), ('चौरासी',)),
    (85, ('pachasi',), ('पचासी',)),
    (86, ('chhiyasi',), ('छियासी',)),
    (87, ('sattasi',), ('सत्तासी',)),
    (88, ('atthasi',), ('अट्ठासी',)),
    (89, ('navasi', 'nawasi'), ('नवासी',)),
    (90, ('nabbe',), ('नब्बे',)),
    (91, ('ikyanave', 'ikyanve'), ('इक्यानवे',)),
    (92, ('baanave', 'banve'), ('बानवे',)),
    (93, ('tiranave', 'tiranve'), ('तिरानवे',)),
    (94, ('chauranave', 'chauranve'), ('चौरानवे',)),
    (95, ('panchanave', 'panchanve'), ('पंचानवे',)),
    (96, ('chhiyanave', 'chhiyanve'), ('छियानवे',)),
    (97, ('sattanave', 'sattanve'), ('सत्तानवे',)),
    (98, ('atthanave', 'atthanve'), ('अट्ठानवे',)),
    (99, ('ninyanave', 'ninyanve'), ('निन्यानवे',)),
    (100, ('sau',), ('सौ',)),
)
KANNADA_BASE: tuple[tuple[int, tuple[str, ...], tuple[str, ...]], ...] = (
    (0, ('sonne',), ('ಸೊನ್ನೆ',)),
    (1, ('ondu',), ('ಒಂದು',)),
    (2, ('eradu',), ('ಎರಡು',)),
    (3, ('mooru', 'muru'), ('ಮೂರು',)),
    (4, ('nalku', 'naalku'), ('ನಾಲ್ಕು',)),
    (5, ('aidu', 'aydu'), ('ಐದು',)),
    (6, ('aaru', 'aru'), ('ಆರು',)),
    (7, ('elu', 'yelu', 'eelu'), ('ಏಳು',)),
    (8, ('entu',), ('ಎಂಟು',)),
    (9, ('ombattu',), ('ಒಂಬತ್ತು',)),
    (10, ('hattu',), ('ಹತ್ತು',)),
    (11, ('hannondu',), ('ಹನ್ನೊಂದು',)),
    (12, ('hanneradu',), ('ಹನ್ನೆರಡು',)),
    (13, ('hadimooru', 'hadimuru'), ('ಹದಿಮೂರು',)),
    (14, ('hadinalku', 'hadinaalku'), ('ಹದಿನಾಲ್ಕು',)),
    (15, ('hadinaidu',), ('ಹದಿನೈದು',)),
    (16, ('hadinaaru', 'hadinaru'), ('ಹದಿನಾರು',)),
    (17, ('hadinelu', 'hadineelu'), ('ಹದಿನೇಳು',)),
    (18, ('hadinentu',), ('ಹದಿನೆಂಟು',)),
    (19, ('hattombattu',), ('ಹತ್ತೊಂಬತ್ತು',)),
    (20, ('ippattu',), ('ಇಪ್ಪತ್ತು',)),
    (30, ('moovattu', 'muvattu'), ('ಮೂವತ್ತು',)),
    (40, ('nalavattu', 'nalvattu'), ('ನಲವತ್ತು',)),
    (50, ('aivattu', 'aivatthu'), ('ಐವತ್ತು',)),
    (60, ('aravattu',), ('ಅರವತ್ತು',)),
    (70, ('eppattu',), ('ಎಪ್ಪತ್ತು',)),
    (80, ('embattu',), ('ಎಂಬತ್ತು',)),
    (90, ('tombattu',), ('ತೊಂಬತ್ತು',)),
    (100, ('nooru', 'nuru'), ('ನೂರು',)),
)


_KN_VOWEL_SIGN = {"ಒ": "ೊ", "ಎ": "ೆ", "ಐ": "ೈ", "ಆ": "ಾ", "ಏ": "ೇ"}


def _kn_compound(tens: tuple[tuple[str, ...], tuple[str, ...]],
                 ones: tuple[tuple[str, ...], tuple[str, ...]]) -> tuple[set[str], set[str]]:
    """Kannada tens + ones by sandhi, both scripts. Every Kannada tens word ends in -ttu / ತ್ತು."""
    rom: set[str] = set()
    nat: set[str] = set()
    for t in tens[0]:
        for o in ones[0]:
            if o[0] in "aeiou":
                rom.add(t[:-1] + o)            # ippattu + ondu  -> ippattondu
            elif o[0] != "y":
                rom.add(t[:-2] + o)            # ippattu + mooru -> ippatmooru
                rom.add(t[:-1] + "a" + o)      # ippattamooru, also heard
    for t in tens[1]:
        for o in ones[1]:
            sign = _KN_VOWEL_SIGN.get(o[0])
            if sign:
                nat.add(t[:-1] + sign + o[1:])  # ಇಪ್ಪತ್ತ + ೊ + ಂದು -> ಇಪ್ಪತ್ತೊಂದು
            else:
                nat.add(t[:-2] + o)             # ಇಪ್ಪತ್ + ಮೂರು -> ಇಪ್ಪತ್ಮೂರು
                nat.add(t[:-1] + o)             # ಇಪ್ಪತ್ತಮೂರು, also written
    return rom, nat


def number_lexicon() -> dict[str, dict[int, tuple[set[str], set[str]]]]:
    """PURE — {language: {n: (romanised forms, native-script forms)}} for 0-100."""
    hi = {n: (set(r), set(d)) for n, r, d in HINDI_NUMBERS}
    base = {n: (r, d) for n, r, d in KANNADA_BASE}
    kn = {n: (set(r), set(d)) for n, (r, d) in base.items()}
    for tens in range(20, 100, 10):
        for one in range(1, 10):
            kn[tens + one] = _kn_compound(base[tens], base[one])
    return {"hi": hi, "kn": kn}


NUMBER_WORDS_EXTRA = frozenset({
    # English cardinals, ordinals, magnitudes, multiplicatives
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
    "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
    "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred",
    "thousand", "million", "billion", "lakh", "lakhs", "crore", "dozen", "first", "second", "third", "fourth", "fifth",
    "sixth", "seventh", "eighth", "ninth", "tenth", "half", "quarter", "once", "twice", "thrice",
    "single", "double", "triple",
    # Hindi fractions, ordinals, magnitudes — romanised, then Devanagari
    "aadha", "adha", "aadhi", "adhi", "dedh", "derh", "dhai", "dhaai", "sawa", "saade", "sade",
    "saadhe", "paune", "pauna", "paun", "pehla", "pehli", "pahla", "doosra", "dusra", "doosri",
    "dusri", "teesra", "teesri", "chautha", "chauthi", "hazaar", "hazar", "lakh", "karod",
    "आधा", "आधी", "डेढ़", "ढाई", "सवा", "साढ़े", "पौने", "पौना", "पहला", "पहली", "दूसरा", "दूसरी",
    "तीसरा", "तीसरी", "चौथा", "चौथी", "हज़ार", "हजार", "लाख", "करोड़",
    # Kannada fractions, ordinals, magnitudes — romanised, then Kannada script
    "ardha", "kaalu", "mukkalu", "onduvare", "eraduvare", "modalu", "modalane", "eradane",
    "mooraneya", "saavira",
    "ಅರ್ಧ", "ಕಾಲು", "ಮುಕ್ಕಾಲು", "ಒಂದೂವರೆ", "ಎರಡೂವರೆ", "ಮೊದಲ", "ಮೊದಲು", "ಎರಡನೇ", "ಮೂರನೇ", "ಸಾವಿರ",
})


def _build_number_words() -> frozenset[str]:
    words = set(NUMBER_WORDS_EXTRA)
    for table in number_lexicon().values():
        for rom, nat in table.values():
            words |= rom | nat
    return frozenset(w.lower() for w in words)


NUMBER_WORDS = _build_number_words()
_NUMBER_PART_SPLIT = re.compile(r"[-/]")


def _has_numeric_char(w: str) -> bool:
    """Any character with a Unicode numeric value: ASCII and Indic digits, ½, ¼, ¾, Roman numerals."""
    return any(unicodedata.numeric(c, None) is not None for c in w)


def is_number_token(word: str) -> bool:
    """True for a token holding any numeric character or a number word, ignoring case and surrounding
    punctuation. A hyphen- or slash-joined token ("ek-ek", "1-0-1", "one/two") is a number if any part is."""
    raw = (word or "").lower()
    for part in [raw, *_NUMBER_PART_SPLIT.split(raw)]:
        w = _PUNCT_FOLD.sub("", part).strip()
        if w and (_has_numeric_char(w) or w in NUMBER_WORDS):
            return True
    return False


def _sticky_sub(m: re.Match) -> str:
    return m.group(0) if is_number_token(m.group(1)) else m.group(1)


def _collapse_line(line: str) -> str:
    cur = line
    while True:
        prev = cur
        cur = _STICKY_WORD_RE.sub(_sticky_sub, cur)
        words = cur.split()
        n = len(words)
        for plen in range(min(n // COLLAPSE_MIN_REPEATS, 24), 0, -1):
            out, i, hit = [], 0, False
            while i < n:
                phrase = words[i:i + plen]
                if len(phrase) < plen:
                    out.extend(words[i:])
                    break
                count, j = 1, i + plen
                while j + plen <= n and words[j:j + plen] == phrase:
                    count += 1
                    j += plen
                if plen == 1:
                    long_enough = len(phrase[0]) >= 3 and not is_number_token(phrase[0])
                else:
                    long_enough = (len(" ".join(phrase)) >= 8
                                   and not any(is_number_token(w) for w in phrase))
                if count >= COLLAPSE_MIN_REPEATS and long_enough:
                    out.extend(phrase)
                    i, hit = j, True
                    continue
                out.append(words[i])
                i += 1
            if hit:
                cur = " ".join(out)
                break
        if cur == prev:
            return cur


def collapse_phrase_loops(text: str) -> str:
    """Collapse within-text loops, line by line, so line structure survives. Idempotent."""
    if not text:
        return text
    return "\n".join(_collapse_line(ln) if ln.strip() else ln for ln in text.split("\n"))


def fold_text(text: str) -> str:
    """Case, ASCII punctuation, danda and whitespace folded away; nothing else. A broader \\W fold
    would delete Indic vowel signs and merge distinct words."""
    return _WS.sub(" ", _PUNCT_FOLD.sub(" ", (text or "").lower())).strip()


def identical_after_fold(a: str, b: str) -> bool:
    """The ONLY duplicate test. Word order, repetition and every token count; empty is never a duplicate."""
    fa, fb = fold_text(a), fold_text(b)
    return bool(fa) and fa == fb


def _same_speaker(a: dict, b: dict) -> bool:
    """False only when both segments name a speaker and the names differ. The router's own segments
    carry none today; a caller that adds one gets the check for free."""
    sa, sb = a.get("speaker"), b.get("speaker")
    return sa is None or sb is None or sa == sb


def _gap_s(prev: dict, seg: dict) -> float | None:
    try:
        return float(seg["start_s"]) - float(prev["end_s"])
    except (KeyError, TypeError, ValueError):
        return None


def collapse_segments(segments: list[dict]) -> tuple[list[dict], int]:
    """Drop a segment only when it is identical after folding to the last KEPT segment, directly
    follows it (no segment between, gap <= DEDUPE_MAX_GAP_S) and is not from a different speaker.
    Its end_s is folded into the kept one. Segments with no text (refused / low-confidence rows) are
    kept and never compared. Returns (kept, n_dropped). The input is not mutated. Idempotent: after
    one pass no neighbouring pair meets the rule, and folding an end_s only lengthens the kept span."""
    kept: list[dict] = []
    dropped = 0
    for seg in segments:
        text = (seg.get("text") or "").strip()
        prev = kept[-1] if kept else None
        if (text and prev is not None
                and identical_after_fold(text, prev.get("text") or "")
                and _same_speaker(prev, seg)):
            gap = _gap_s(prev, seg)
            if gap is not None and gap <= DEDUPE_MAX_GAP_S:
                if seg.get("end_s") is not None and (prev.get("end_s") is None or seg["end_s"] > prev["end_s"]):
                    kept[-1] = {**prev, "end_s": seg["end_s"]}
                dropped += 1
                continue
        kept.append(dict(seg))
    return kept, dropped


def whisper_text(resp: dict) -> tuple[str, bool]:
    """Decoded text from one whisper answer, collapsed unless the shim already did it.
    Returns (text, collapsed_here)."""
    raw = (resp.get("text") or "").strip()
    if resp.get("shim_collapse") is True:
        return raw, False
    fixed = collapse_phrase_loops(raw)
    return fixed, fixed != raw


def process_segment(seg_wav: str, start_s: float, end_s: float, candidates: list[str]) -> dict | None:
    """3-engine segment pick: Whisper (en) vs IndicConformer vs SraVaani.

    Policy:
      1. Always try Whisper when 'en' is a candidate (hallucination guard unchanged).
      2. For Indic candidates, query IndicConformer per language.
      3. If ETA_USE_SRAVAANI=1 and any Indic candidate exists, also query SraVaani once
         (language-agnostic). Pick the best Indic-side hypothesis by score_asr_text.
      4. If English looks real and is at least as long as the best Indic hypothesis,
         keep Whisper. Otherwise take the winning Indic engine (conformer or sravaani).
    """
    indic_cands = [c for c in candidates if c != "en"]
    w_text, w_lang, eng_real = "", "", False
    repaired = False
    if "en" in candidates:
        try:
            w = whisper_infer(seg_wav)
            # Collapse FIRST; the English hallucination guard then judges the repaired text.
            w_text, w_fixed = whisper_text(w)
            repaired = repaired or w_fixed
            w_lang = (w.get("language") or "").lower()
            eng_real = looks_real_english(w_text)
        except Exception:
            pass

    indic_results: dict[str, str] = {}
    sra_box: dict[str, object] = {"text": "", "err": None}

    def _sra_worker() -> None:
        try:
            sr = sravaani_infer(seg_wav)
            if sr and sr.get("ok", True):
                sra_box["text"] = (sr.get("text") or "").strip()
        except Exception as ex:
            sra_box["err"] = ex

    sra_thread = None
    if USE_SRAVAANI and indic_cands:
        sra_thread = threading.Thread(target=_sra_worker, daemon=True)
        sra_thread.start()

    for i, L in enumerate(indic_cands):
        try:
            r = indic_infer(seg_wav, L)
            txt = (r.get("text") or "").strip()
            if len(txt) >= INDIC_MIN_CHARS:
                indic_results[L] = txt
        except Exception:
            txt = ""
        if i == 0 and SHORT_CIRCUIT and eng_real and not indic_results:
            # English already looked real and first Indic lang empty — skip rest of Conformer,
            # but still collect SraVaani (may rescue code-mix / non-en).
            break

    sra_text = ""
    if sra_thread is not None:
        sra_thread.join(timeout=SRAVAANI_TIMEOUT)
        if sra_box.get("err") is not None:
            sys.stderr.write(f"[eta-router] sravaani segment failed: {sra_box['err']!r}\n")
        sra_text = str(sra_box.get("text") or "")

    def english_segment() -> dict:
        text, fixed = w_text, repaired
        if w_lang != "en" or not text:
            try:
                rr = whisper_infer(seg_wav, language="en")
                text, fixed_en = whisper_text(rr)
                fixed = fixed or fixed_en
            except Exception:
                pass
        seg = {"start_s": round(start_s, 2), "end_s": round(end_s, 2),
               "lang": "en", "engine": "whisper", "text": text}
        if fixed:
            seg["repair_applied"] = True
        return seg

    # Build Indic-side hypotheses
    hyps: list[dict] = []
    for L, txt in indic_results.items():
        hyps.append({
            "lang": L,
            "engine": "indicconformer",
            "text": txt,
            "score": score_asr_text(txt),
        })
    if sra_text and len(sra_text) >= SRAVAANI_MIN_CHARS:
        hyps.append({
            "lang": guess_indic_lang(sra_text),
            "engine": "sravaani",
            "text": sra_text,
            "score": score_asr_text(sra_text),
        })

    if hyps:
        best = max(hyps, key=lambda h: h["score"])
        # When Whisper looks like real English, keep it unless Indic evidence is strong.
        # Conformer/SraVaani often emit longer Indic-script hallucinations on EN-only audio;
        # require Indic script AND clearly longer text before overriding eng_real.
        if eng_real:
            if (not has_indic_script(best["text"])
                    or len(w_text) >= len(best["text"])
                    or len(best["text"]) < max(24, int(len(w_text) * 1.8))):
                return english_segment()
        return {
            "start_s": round(start_s, 2),
            "end_s": round(end_s, 2),
            "lang": best["lang"],
            "engine": best["engine"],
            "text": best["text"],
            "score": round(best["score"], 2),
        }

    if eng_real:
        return english_segment()
    # Whisper produced text but failed the realism check — refuse as English gold.
    if w_text:
        return {"start_s": round(start_s, 2), "end_s": round(end_s, 2),
                "lang": "en", "engine": "whisper", "text": "",
                "confidence": "low_confidence",
                "refused": True, "refused_reason": "english_hallucination_guard",
                **({"repair_applied": True} if repaired else {})}
    return None


# --------------------------------------------------------------------------- #
# What `silent_skipped` may and may not mean (refuted 19 Sep).
#
# THREE OUTCOMES WERE BEING COLLAPSED INTO ONE. They are not the same thing, and a row must be able
# to tell them apart afterwards. This is the third time this month a status has been discarded and an
# absence made to share a value with a failure, so the distinction is NAMED here, not just fixed:
#
#   (a) NO_ENGINE       no engine ran at all — VAD/gate handed nothing to an engine. Nothing was
#                       listened to. This is the ONLY real silent_skip.
#   (b) ENGINE_NO_TEXT  an engine ran and returned nothing. The audio WAS heard; there were no words.
#   (c) ENGINE_TEXT     an engine ran and returned something. Normal, and not a skip at all.
#
# The discriminator is `n_engine_segments` — how many spans an engine was actually run on — NOT the
# count of OUTPUT segments. A window that ran an engine on noise and got nothing (b) is `ok`, never
# `silent_skipped`; calling that a skip manufactures a starvation finding, which is the exact bug the
# old `not segments` test produced.
NO_ENGINE = "no_engine"
ENGINE_NO_TEXT = "engine_no_text"
ENGINE_TEXT = "engine_text"


def engine_ran(n_engine_segments) -> bool:
    """True iff at least one span was handed to an engine. Its negation is the real silent_skip."""
    try:
        return int(n_engine_segments) > 0
    except (TypeError, ValueError):
        return False


def window_outcome(n_engine_segments, n_output_segments) -> str:
    """Name which of (a)/(b)/(c) a window — or a whole job — is, from its engine-run + output counts."""
    if not engine_ran(n_engine_segments):
        return NO_ENGINE
    try:
        produced = int(n_output_segments) > 0
    except (TypeError, ValueError):
        produced = False
    return ENGINE_TEXT if produced else ENGINE_NO_TEXT


def transcribe_norm_wav(norm_wav: str, cand_list: list[str], do_translate: bool,
                        translate_engine: str | None = None) -> dict:
    """Run the per-segment pipeline over an already-normalized 16k mono WAV.
    Timings are relative to this WAV's t=0. Shared by /route and the chunked job."""
    total_s = wav_duration_s(norm_wav)
    spans, seg_method = vad_segments(norm_wav, total_s)
    sdir = tempfile.mkdtemp(prefix="eta-seg-")
    try:
        if not spans:
            return {
                "dominant_language": None,
                "language_timeline": [],
                "transcript_native": "",
                "transcript_english": ("" if do_translate else None),
                # Every result carries the label fields, so a reader never has to tell "absent"
                # from "nothing was translated". Nothing was: there was no speech to translate.
                "translate_engine": None, "translate_model": None,
                "translate_ms": 0, "translate_error": None,
                "segments": [],
                "segmentation": {
                    "method": seg_method,
                    "max_window_s": SEG_SEC,
                    "overlap_s": OVERLAP_SEC,
                    "n_segments": 0,
                    "n_engine_segments": 0,   # (a) VAD found no speech: no engine ran.
                    "outcome": NO_ENGINE,
                    "n_skipped_silent": 0,
                    "silence_gate": {
                        "rms_threshold": SEG_SILENCE_RMS,
                        "max_abs_threshold": SEG_SILENCE_MAX_ABS,
                        "min_seg_s": SEG_MIN_S,
                    },
                },
                "candidates": cand_list,
                "repair_applied": False,
                "repair": {"applied": False, "segments_phrase_collapsed": 0,
                           "segments_dropped_duplicate": 0},
                "status": "silent_skipped",
            }
        seg_jobs = []
        n_skipped_silent = 0
        for idx, (s, e) in enumerate(spans):
            if (e - s) < SEG_MIN_S:
                n_skipped_silent += 1
                sys.stderr.write(f"[eta-router] skip short span {s:.2f}-{e:.2f}\n")
                continue
            seg_wav = os.path.join(sdir, f"seg_{idx:04d}.wav")
            slice_wav(norm_wav, s, e, seg_wav)
            silent, rms, peak = is_near_silent_wav(seg_wav)
            if silent:
                n_skipped_silent += 1
                sys.stderr.write(
                    f"[eta-router] silent_skipped span {s:.2f}-{e:.2f} "
                    f"rms={rms:.6f} max_abs={peak:.6f}\n"
                )
                continue
            seg_jobs.append((idx, s, e, seg_wav))
        results: list[dict | None] = [None] * len(spans)
        with ThreadPoolExecutor(max_workers=MAX_INFLIGHT) as pool:
            futs = {pool.submit(process_segment, sw, s, e, cand_list): idx
                    for (idx, s, e, sw) in seg_jobs}
            for fut in futs:
                idx = futs[fut]
                try:
                    results[idx] = fut.result()
                except Exception:
                    results[idx] = None
        segments = [r for r in results if r and (r.get("text") or r.get("confidence") == "low_confidence")]
        segments.sort(key=lambda r: r["start_s"])
        # A-ETA-2, before translation so the English matches the kept segments.
        n_phrase_repaired = sum(1 for r in segments if r.get("repair_applied"))
        segments, n_dup_dropped = collapse_segments(segments)
        repair = {"applied": bool(n_phrase_repaired or n_dup_dropped),
                  "segments_phrase_collapsed": n_phrase_repaired,
                  "segments_dropped_duplicate": n_dup_dropped}
        # TRANSLATION. This block used to end `except Exception: return seg["text"]` — a failed
        # translation stored NATIVE-SCRIPT text in transcript_english. Now every segment gets a
        # derived label, and if any segment failed every engine the window's English is None with
        # translate_error set: a partial English with a silent hole would drop content, and filling
        # the hole with source text is the lie this replaces.
        tr_results: list[dict] = []
        if do_translate:
            def tr_of(seg: dict) -> dict:
                return translate(seg.get("text") or "", seg.get("lang"), translate_engine)
            with ThreadPoolExecutor(max_workers=MAX_INFLIGHT) as pool:
                tr_results = list(pool.map(tr_of, segments))
            for seg, t in zip(segments, tr_results):
                seg["translate_engine"] = t["translate_engine"]
                seg["translate_model"] = t["translate_model"]
                seg["translate_ms"] = t["translate_ms"]
                if t["translate_error"]:
                    seg["translate_error"] = t["translate_error"]
        tr_summary = summarise_translation(tr_results) if do_translate else {
            "translate_engine": None, "translate_model": None, "translate_ms": 0, "translate_error": None}
        transcript_native = "\n".join(s["text"] for s in segments).strip()
        if not do_translate or tr_summary["translate_error"]:
            transcript_english = None
        else:
            transcript_english = "\n".join(t["english"] for t in tr_results if t["english"]).strip()
        timeline = [{"start_s": s["start_s"], "end_s": s["end_s"], "lang": s["lang"],
                     "engine": s["engine"], "chars": len(s["text"])} for s in segments]
        by_lang: dict[str, int] = {}
        for s in segments:
            by_lang[s["lang"]] = by_lang.get(s["lang"], 0) + len(s["text"])
        dominant = max(by_lang, key=by_lang.get) if by_lang else None
        # silent_skipped iff NO ENGINE RAN (a). An engine that ran and returned nothing (b) or little
        # (c) is `ok` — the audio was heard. Keyed on seg_jobs (spans dispatched to an engine), never
        # on `segments` (engine OUTPUT), which is what over-claimed the half-silence/half-noise clip.
        status = "silent_skipped" if not engine_ran(len(seg_jobs)) else "ok"
        return {"dominant_language": dominant, "language_timeline": timeline,
                "transcript_native": transcript_native, "transcript_english": transcript_english,
                **tr_summary,
                "segments": segments,
                "segmentation": {"method": seg_method, "max_window_s": SEG_SEC,
                                 "overlap_s": OVERLAP_SEC, "n_segments": len(spans),
                                 "n_engine_segments": len(seg_jobs),
                                 "outcome": window_outcome(len(seg_jobs), len(segments)),
                                 "n_skipped_silent": n_skipped_silent,
                                 "silence_gate": {
                                     "rms_threshold": SEG_SILENCE_RMS,
                                     "max_abs_threshold": SEG_SILENCE_MAX_ABS,
                                     "min_seg_s": SEG_MIN_S,
                                 }},
                "candidates": cand_list,
                "repair_applied": repair["applied"], "repair": repair,
                "status": status}
    finally:
        shutil.rmtree(sdir, ignore_errors=True)


# --------------------------------------------------------------------------- #
# Async chunked-job machinery
# --------------------------------------------------------------------------- #
def _job_path(jid: str) -> str:
    return os.path.join(JOBS_DIR, jid + ".json")


def _write_job(jid: str, obj: dict) -> None:
    tmp = _job_path(jid) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, _job_path(jid))


def _read_job(jid: str) -> dict | None:
    p = _job_path(jid)
    if not os.path.exists(p):
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None


def _cleanup_old_jobs(ttl: int = JOB_TTL_SEC) -> None:
    now = time.time()
    for fn in glob.glob(os.path.join(JOBS_DIR, "*.json")):
        try:
            if now - os.path.getmtime(fn) > ttl:
                os.unlink(fn)
        except Exception:
            pass


def _download(url: str, dst: str) -> None:
    with requests.get(url, stream=True, timeout=DOWNLOAD_TIMEOUT) as r:
        r.raise_for_status()
        with open(dst, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                if chunk:
                    f.write(chunk)


def job_verdict(window_results: list[dict]) -> tuple[str, dict]:
    """PURE. One job's status + segmentation, aggregated from its sub-windows.

    WHY THIS EXISTS. /route answers per call with `status` and `segmentation`; run_job splits the
    clip into window_s sub-windows, called /route's body once per sub-window, and then BUILT ITS
    OWN reply out of a fixed key set that had neither field. The room drain uses run_job and only
    run_job, so every starved room window still stored as a clean empty success no matter what the
    synchronous path reported. Refuted 19 Sep; this is the fix.

    THE RULE IS THE SINGLE-WINDOW RULE, LIFTED, AND IT DOES NOT OVER-CLAIM. `silent_skipped` means
    NO ENGINE RAN ANYWHERE (a): not one sub-window handed a span to an engine. A job that ran an
    engine on even one sub-window is `ok`, EVEN IF it produced no text (b) — the old test keyed on
    n_segments (engine OUTPUT), so a job that was heard but wordless was stored as never-heard, which
    is the very over-claim this fixes. The discriminator is n_engine_segments, aggregated below.

    PARTIAL STARVATION IS STILL VISIBLE without lying about the whole: windows_total and
    windows_skipped are always carried, so a job that starved on 4 of 5 sub-windows is readable as
    such even though its status is `ok`. `outcome` names (a)/(b)/(c) for the job as a whole.
    """
    methods: dict[str, int] = {}
    windows_skipped = 0
    n_segments = 0            # engine OUTPUT segments, summed across sub-windows
    n_engine_segments = 0     # spans an engine was actually RUN on, summed across sub-windows
    n_skipped_silent = 0
    for r in window_results:
        seg = r.get("segmentation") or {}
        m = seg.get("method")
        if isinstance(m, str) and m:
            methods[m] = methods.get(m, 0) + 1
        if r.get("status") == "silent_skipped":
            windows_skipped += 1
        n_segments += len(r.get("segments") or [])
        try:
            n_engine_segments += int(seg.get("n_engine_segments") or 0)
        except (TypeError, ValueError):
            pass
        try:
            n_skipped_silent += int(seg.get("n_skipped_silent") or 0)
        except (TypeError, ValueError):
            pass
    if len(methods) == 1:
        method = next(iter(methods))
    elif methods:
        method = "mixed"
    else:
        method = None
    status = "silent_skipped" if not engine_ran(n_engine_segments) else "ok"
    return status, {
        "method": method,
        "methods": methods,
        "windows_total": len(window_results),
        "windows_skipped": windows_skipped,
        "n_segments": n_segments,
        "n_engine_segments": n_engine_segments,
        "outcome": window_outcome(n_engine_segments, n_segments),
        "n_skipped_silent": n_skipped_silent,
        "max_window_s": SEG_SEC,
        "silence_gate": {
            "rms_threshold": SEG_SILENCE_RMS,
            "max_abs_threshold": SEG_SILENCE_MAX_ABS,
            "min_seg_s": SEG_MIN_S,
        },
    }


def job_repair(window_results: list[dict]) -> dict:
    """PURE. The A-ETA-2 repair counts summed across a job's sub-windows."""
    phrase = sum(int((r.get("repair") or {}).get("segments_phrase_collapsed") or 0) for r in window_results)
    dup = sum(int((r.get("repair") or {}).get("segments_dropped_duplicate") or 0) for r in window_results)
    return {"applied": bool(phrase or dup) or any(r.get("repair_applied") for r in window_results),
            "segments_phrase_collapsed": phrase, "segments_dropped_duplicate": dup}


def run_job(jid: str, audio_url: str, cand_list: list[str], do_translate: bool, window_s: float,
            translate_engine: str | None = None) -> None:
    t0 = time.time()
    jobdir = tempfile.mkdtemp(prefix="eta-job-")
    job = {"ok": True, "job_id": jid, "state": "running", "progress": {"done": 0, "total": 0},
           "dominant_language": None, "language_timeline": [], "transcript_native": "",
           "transcript_english": ("" if do_translate else None), "segments": [],
           "engine_versions": ENGINE_VERSIONS, "sec": 0.0, "error": None,
           # Carried from the FIRST write: a caller polling a running job must never read the
           # absence of these as "nothing was skipped". Filled per sub-window below.
           "status": None, "segmentation": None,
           "repair_applied": False,
           "repair": {"applied": False, "segments_phrase_collapsed": 0, "segments_dropped_duplicate": 0}}
    _write_job(jid, job)
    try:
        raw = os.path.join(jobdir, "input")
        _download(audio_url, raw)
        norm = os.path.join(jobdir, "norm.wav")
        normalize_to_wav(raw, norm)
        # ffmpeg TIME-split (not byte-split; webm/opus isn't byte-seekable, and we
        # normalized to wav anyway) into window_s windows.
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", norm,
                        "-f", "segment", "-segment_time", str(int(window_s)),
                        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                        os.path.join(jobdir, "win_%03d.wav")], check=True, capture_output=True)
        wins = sorted(glob.glob(os.path.join(jobdir, "win_*.wav")))
        total = len(wins)
        job["progress"] = {"done": 0, "total": total}
        _write_job(jid, job)
        acc_native, acc_eng, acc_seg, acc_tl, by_lang = [], [], [], [], {}
        acc_tr: list[dict] = []
        acc_tr_errors: list[str] = []
        win_results: list[dict] = []
        for i, win in enumerate(wins):
            with _WINDOW_SEM:
                r = transcribe_norm_wav(win, cand_list, do_translate, translate_engine)
            off = i * window_s
            for s in r["segments"]:
                acc_seg.append({**s, "start_s": round(s["start_s"] + off, 2),
                                "end_s": round(s["end_s"] + off, 2)})
            for t in r["language_timeline"]:
                acc_tl.append({**t, "start_s": round(t["start_s"] + off, 2),
                               "end_s": round(t["end_s"] + off, 2)})
            if r["transcript_native"]:
                acc_native.append(r["transcript_native"])
            # A sub-window whose translation FAILED is not skipped: skipping it would drop that
            # stretch from the job's English without a word. One failed sub-window fails the job's
            # English, exactly as one failed segment fails a window's.
            if do_translate and r.get("translate_error"):
                acc_tr_errors.append(r["translate_error"])
            elif do_translate and r.get("transcript_english"):
                acc_eng.append(r["transcript_english"])
            if do_translate:
                acc_tr.append(r)
            for s in r["segments"]:
                by_lang[s["lang"]] = by_lang.get(s["lang"], 0) + len(s["text"])
            win_results.append(r)
            job["status"], job["segmentation"] = job_verdict(win_results)
            job["repair"] = job_repair(win_results)
            job["repair_applied"] = job["repair"]["applied"]
            job["progress"] = {"done": i + 1, "total": total}
            job["segments"] = acc_seg
            job["language_timeline"] = acc_tl
            job["transcript_native"] = "\n".join(acc_native).strip()
            if do_translate and acc_tr_errors:
                job["transcript_english"] = None
                job["translate_error"] = f"{len(acc_tr_errors)} of {i + 1} windows failed: {acc_tr_errors[0]}"
            else:
                job["transcript_english"] = ("\n".join(acc_eng).strip() if do_translate else None)
                job["translate_error"] = None
            if do_translate:
                # Distinct engines and models that actually answered, across every sub-window.
                job["translate_engine"] = ",".join(sorted({
                    e for w in acc_tr for e in (w.get("translate_engine") or "").split(",") if e})) or None
                job["translate_model"] = ",".join(sorted({
                    m for w in acc_tr for m in (w.get("translate_model") or "").split(",") if m})) or None
                job["translate_ms"] = sum(int(w.get("translate_ms") or 0) for w in acc_tr)
            job["dominant_language"] = (max(by_lang, key=by_lang.get) if by_lang else None)
            job["sec"] = round(time.time() - t0, 2)
            _write_job(jid, job)
        job["state"] = "done"
        job["sec"] = round(time.time() - t0, 2)
        _write_job(jid, job)
    except Exception as e:
        sys.stderr.write(f"[eta-router] job {jid} failed: {e!r}\n")
        job["state"] = "failed"; job["ok"] = False; job["error"] = repr(e)[:300]
        job["sec"] = round(time.time() - t0, 2)
        _write_job(jid, job)
    finally:
        shutil.rmtree(jobdir, ignore_errors=True)


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/healthz")
def healthz():
    return {
        "ok": True,
        "version": "3.1-sravaani",
        "use_sravaani": USE_SRAVAANI,
        "engine_versions": ENGINE_VERSIONS,
        "urls": {
            "whisper": WHISPER_URL,
            "indic": INDIC_URL,
            "sravaani": SRAVAANI_URL,
        },
    }


def _route_blocking(raw_bytes: bytes, cand_list: list[str], translate: bool, t0: float,
                    translate_engine: str | None = None):
    """Blocking body of /route. Called via asyncio.to_thread under _ROUTE_SEM."""
    workdir = tempfile.mkdtemp(prefix="eta-route-")
    try:
        raw_path = os.path.join(workdir, "input")
        with open(raw_path, "wb") as fh:
            fh.write(raw_bytes)
        norm_wav = os.path.join(workdir, "norm.wav")
        try:
            normalize_to_wav(raw_path, norm_wav)
        except subprocess.CalledProcessError as e:
            return JSONResponse(status_code=400,
                                content={"ok": False, "error": "ffmpeg failed to decode audio",
                                         "detail": e.stderr.decode("utf-8", "ignore")[-500:]})
        res = transcribe_norm_wav(norm_wav, cand_list, bool(translate), translate_engine)
        res.update({"ok": True, "engine_versions": ENGINE_VERSIONS, "sec": round(time.time() - t0, 2)})
        return res
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# --------------------------------------------------------------------------- #
# /vad — speech spans only, no transcription
#
# WHY THIS EXISTS. The diarization path stores whatever pyannote returns, and nothing re-checks
# whether a segment contains speech. The app's gate (lib/stt/speech-gate.ts) needs an answer to one
# question — WHERE IS THE SPEECH IN THIS AUDIO — and until now the only way to ask this router was
# /route, which also transcribes. This route asks Silero and nothing else. The model is the one
# already loaded here; nothing is installed or downloaded.
#
# WHY IT DOES NOT CALL vad_segments(). That helper exists to PLAN TRANSCRIPTION: it merges spans
# into SEG_SEC chunks and, when Silero finds nothing, returns fixed windows so the engines still
# get a chance (`fixed-window-vad-empty`). Both behaviours are right there and wrong here. A gate
# that cannot tell "Silero found nothing" from "Silero found these spans" would convict a whole
# window of noise on a VAD failure — and on this audio an empty answer is a VAD failure far more
# often than a quiet room (see vad_segments' own comment). So this route reports emptiness
# HONESTLY, as `spans: []`, and lets the caller decide. The caller's decision is to judge nothing.
# --------------------------------------------------------------------------- #
@app.post("/vad")
async def vad(req: Request):
    t0 = time.time()
    # REFUSE BEFORE READING where the client declares a size. Content-Length is a claim, not a
    # guarantee, so the read below is capped again — but an honest oversized client is turned away
    # without ever putting its body in this process's memory.
    declared = req.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > VAD_MAX_BYTES:
        return JSONResponse({"ok": False, "error": "audio_too_large",
                             "limit_bytes": VAD_MAX_BYTES, "declared_bytes": int(declared)}, status_code=413)
    raw = await req.body()
    if not raw:
        return JSONResponse({"ok": False, "error": "empty_body"}, status_code=400)
    if len(raw) > VAD_MAX_BYTES:
        return JSONResponse({"ok": False, "error": "audio_too_large",
                             "limit_bytes": VAD_MAX_BYTES, "bytes": len(raw)}, status_code=413)
    try:
        threshold = float(req.query_params.get("threshold", VAD_THRESHOLD))
    except ValueError:
        return JSONResponse({"ok": False, "error": "bad_threshold"}, status_code=400)
    if not (0.0 < threshold < 1.0):
        return JSONResponse({"ok": False, "error": "bad_threshold"}, status_code=400)

    def _blocking():
        workdir = tempfile.mkdtemp(prefix="vad_")
        try:
            src = os.path.join(workdir, "in.bin")
            wav = os.path.join(workdir, "in.wav")
            with open(src, "wb") as f:
                f.write(raw)
            # 16 kHz mono, the same normalisation /route does. Silero fed 48 kHz while told 16 kHz
            # reports almost everything voiceless, so this conversion is not optional.
            normalize_to_wav(src, wav)
            audio_s = wav_duration_s(wav)
            # Bytes are a poor proxy for work: Silero's cost tracks DURATION. A 15-minute window is
            # ~3 s of VAD, so an hour is a generous ceiling and anything past it is a mistake.
            if audio_s > VAD_MAX_AUDIO_S:
                return {"__refused": {"ok": False, "error": "audio_too_long",
                                      "limit_s": VAD_MAX_AUDIO_S, "audio_s": round(audio_s, 1)}}

            import torch
            import soundfile as sf
            from silero_vad import load_silero_vad, get_speech_timestamps
            global _VAD_MODEL
            if _VAD_MODEL is None:
                _VAD_MODEL = load_silero_vad()
            arr, _sr = sf.read(wav, dtype="float32")
            if getattr(arr, "ndim", 1) > 1:
                arr = arr.mean(axis=1)
            ts = get_speech_timestamps(torch.from_numpy(arr), _VAD_MODEL,
                                       sampling_rate=16000, return_seconds=True,
                                       threshold=threshold)
            spans = [{"start_ms": round(float(t["start"]) * 1000.0, 1),
                      "end_ms": round(float(t["end"]) * 1000.0, 1)} for t in ts]
            speech_ms = round(sum(x["end_ms"] - x["start_ms"] for x in spans), 1)
            return {"ok": True, "spans": spans, "span_count": len(spans),
                    "speech_ms": speech_ms, "audio_ms": round(audio_s * 1000.0, 1),
                    "threshold": threshold, "model": "silero-vad",
                    "latency_ms": int((time.time() - t0) * 1000)}
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    # ITS OWN LIMIT, NOT /route's — see _VAD_SEM at the top. A VAD pass no longer waits behind a
    # transcription, because waiting there meant outliving the client's 120 s abort and then doing
    # the work anyway. Concurrency is still bounded (ETA_VAD_MAX_INFLIGHT, default 1), so a backlog
    # pass cannot fan out across the Mini; it simply queues against other VAD calls, not against
    # transcription.
    async with _VAD_SEM:
        # The client may have gone while we queued. Nothing here is worth doing for a caller that
        # has already been told vad_unavailable and moved on.
        if await req.is_disconnected():
            sys.stderr.write("[eta-router] /vad: client gone before start; dropping\n")
            return JSONResponse({"ok": False, "error": "client_gone"}, status_code=499)
        try:
            out = await asyncio.to_thread(_blocking)
            if isinstance(out, dict) and "__refused" in out:
                return JSONResponse(out["__refused"], status_code=413)
            return out
        except subprocess.CalledProcessError:
            return JSONResponse({"ok": False, "error": "decode_failed"}, status_code=400)
        except Exception as ex:
            sys.stderr.write(f"[eta-router] /vad failed: {ex!r}\n")
            return JSONResponse({"ok": False, "error": "vad_failed"}, status_code=500)


@app.post("/route")
async def route(file: UploadFile = File(...),
                candidates: str = Form(DEFAULT_CANDIDATES),
                translate: bool = Form(True),
                translate_engine: str = Form("")):
    t0 = time.time()
    # The bake-off override. `none` means translate off, so it is folded into `translate` here and
    # nothing downstream has to know two ways of saying the same thing.
    te = translate_engine.strip() or None
    if te == "none":
        translate, te = False, None
    cand_list = [c.strip().lower() for c in candidates.split(",") if c.strip()] or DEFAULT_CANDIDATES.split(",")
    raw_bytes = await file.read()
    async with _ROUTE_SEM:
        return await asyncio.to_thread(_route_blocking, raw_bytes, cand_list, translate, t0, te)


@app.post("/route/job")
async def route_job(req: Request):
    try:
        body = await req.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "error": "invalid JSON body"})
    audio_url = (body.get("audio_url") or "").strip()
    if not audio_url:
        return JSONResponse(status_code=400, content={"ok": False, "error": "audio_url required"})
    cand = body.get("candidates") or DEFAULT_CANDIDATES
    cand_list = [c.strip().lower() for c in cand.split(",") if c.strip()] or DEFAULT_CANDIDATES.split(",")
    do_translate = bool(body.get("translate", True))
    te = (body.get("translate_engine") or "").strip() or None
    if te == "none":
        do_translate, te = False, None
    window_s = float(body.get("window_s", WINDOW_S_DEFAULT))
    jid = uuid.uuid4().hex
    _write_job(jid, {"ok": True, "job_id": jid, "state": "queued",
                     "progress": {"done": 0, "total": 0}, "error": None})
    threading.Thread(target=run_job, args=(jid, audio_url, cand_list, do_translate, window_s, te),
                     daemon=True).start()
    _cleanup_old_jobs()
    return {"ok": True, "job_id": jid}


@app.get("/route/job/{job_id}")
async def route_job_status(job_id: str):
    obj = _read_job(job_id)
    if obj is None:
        return JSONResponse(status_code=404, content={"ok": False, "error": "unknown job_id"})
    return obj


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
