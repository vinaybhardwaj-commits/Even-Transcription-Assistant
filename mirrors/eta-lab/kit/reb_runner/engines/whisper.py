"""Box-local whisper writer for REB's stt layer: 3 passes (whisper-auto, whisper-forced-en,
whisper-cap2) against box's whisper-server (:8080), each producing one REB track per window.

LID convention adopted from lid-debug's #4735 (Fable 15:22: adopt as-is, answers router-fix #4733):
  1. whisper.cpp's language-ID only scores the FIRST 30s of whatever audio it's given (server.cpp
     ~1066, whisper_lang_auto_detect at offset 0) -- so a whole-300s-window call gives one p(en) for
     just its first 30s. To get LID across the whole window, call per <=30s chunk, not per window.
  2. Per segment: extras.lid = {"detected": <code>, "p": <prob>, "probs": {<code>: p, ...} (entries
     >= 0.001), "scored_ms": [chunk_t0_ms, min(chunk_t1_ms, chunk_t0_ms + 30000)]}. Config records
     response_format/language/temperature/temperature_inc.
  3. Both whisper-auto and whisper-forced-en carry extras.lid (verbose_json computes it independently
     of the forced language).
This module produces (1)+(2)+(3); router-fix's fuser (#4735 point 4) does the duration-weighted
slice aggregation on the reader side.
"""
import json
import os
import subprocess
import tempfile
import time

from reb.writer import config_hash

WHISPER_URL = os.environ.get("REB_WHISPER_URL", "http://127.0.0.1:8080/inference")
CHUNK_S = 30.0  # lid-debug #4735 point 1: LID is only meaningful per <=30s slice
MODEL = "whisper-large-v3-turbo"
VERSION = "v1"
TEMPERATURE = 0.0
TEMPERATURE_INC = 0.2  # whisper.cpp's own documented default fallback step

CAP2_PROMPT_PATH = os.environ.get(
    "REB_CAP2_PROMPT_FILE", os.path.expanduser("~/eta-data/cap2/whisper_vocab_prompt.txt")
)

VARIANTS = ("whisper-auto", "whisper-forced-en", "whisper-cap2")


def _load_cap2_prompt():
    """The CAP-2 clinical vocabulary prompt asset (sizing report finding 6: doesn't exist yet as a
    built asset). Falls back to the same placeholder the sizing pass used, so whisper-cap2 keeps
    working before someone builds the real one — but the config records which one was used, so a
    later real prompt naturally produces a different config_hash (new track, nothing overwritten)."""
    try:
        with open(CAP2_PROMPT_PATH) as f:
            return f.read().strip(), "file"
    except OSError:
        return (
            "Clinical terms: hypertension, diabetes mellitus, tablet, capsule, mg, milligram, "
            "BP, blood pressure, ECG, echocardiogram, metformin, amlodipine, atorvastatin, "
            "telmisartan, HbA1c, creatinine, thyroid, TSH, prescription, follow-up, dosage, "
            "twice daily, once daily, before food, after food, OPD, consultation, symptoms, "
            "fever, cough, cold, chest pain, shortness of breath, angiography, stent, bypass."
        ), "placeholder"


def _variant_request(variant):
    """(language, prompt-or-None, prompt_source) for a whisper track variant."""
    if variant == "whisper-auto":
        return "auto", None, None
    if variant == "whisper-forced-en":
        return "en", None, None
    if variant == "whisper-cap2":
        prompt, source = _load_cap2_prompt()
        return "en", prompt, source
    raise ValueError(f"unknown whisper variant {variant!r}")


def _slice_wav(wav_path, start_s, dur_s):
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    out.close()
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start_s), "-t", str(dur_s),
         "-i", wav_path, "-ac", "1", "-ar", "16000", out.name],
        check=True, capture_output=True, timeout=60,
    )
    return out.name


def _call_whisper(chunk_wav, language, prompt, timeout=120):
    import requests

    data = {"language": language, "response_format": "verbose_json",
             "temperature": str(TEMPERATURE), "temperature_inc": str(TEMPERATURE_INC)}
    if prompt:
        data["prompt"] = prompt
    with open(chunk_wav, "rb") as f:
        r = requests.post(WHISPER_URL, files={"file": ("chunk.wav", f, "audio/wav")}, data=data, timeout=timeout)
    r.raise_for_status()
    return r.json()


def _lid_from_response(resp):
    """Derive {"detected","p","probs"} from whisper's verbose_json response. `language_probabilities`
    uses short codes directly, so the max-probability entry IS `detected_language` -- no need for a
    separate full-name-to-code lookup table."""
    probs_raw = resp.get("language_probabilities") or {}
    probs = {code: p for code, p in probs_raw.items() if p >= 0.001}
    if not probs:
        return None
    detected = max(probs, key=probs.get)
    return {"detected": detected, "p": probs[detected], "probs": probs}


def run_window(window_wav, window_duration_ms, variant):
    """Run one whisper variant over one window's audio (a local WAV path), chunked at <=30s so LID is
    meaningful throughout. Returns a list of REB segments (t0_ms/t1_ms global, text, extras.lid) and
    the config dict this run used."""
    if variant not in VARIANTS:
        raise ValueError(f"unknown whisper variant {variant!r}, expected one of {VARIANTS}")
    language, prompt, prompt_source = _variant_request(variant)

    config = {"language": language, "response_format": "verbose_json",
              "temperature": TEMPERATURE, "temperature_inc": TEMPERATURE_INC}
    if prompt:
        config["prompt"] = prompt
        config["prompt_source"] = prompt_source  # "file" once a real CAP-2 asset exists, else "placeholder"

    duration_s = window_duration_ms / 1000.0
    segments = []
    t = 0.0
    while t < duration_s:
        dur = min(CHUNK_S, duration_s - t)
        chunk_wav = _slice_wav(window_wav, t, dur)
        try:
            resp = _call_whisper(chunk_wav, language, prompt)
        finally:
            try:
                os.unlink(chunk_wav)
            except OSError:
                pass
        lid = _lid_from_response(resp)
        chunk_t0_ms = round(t * 1000)
        if lid is not None:
            lid = {**lid, "scored_ms": [chunk_t0_ms, min(chunk_t0_ms + 30000, round((t + dur) * 1000))]}
        for seg in resp.get("segments", []):
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            segments.append({
                "t0_ms": chunk_t0_ms + round(seg["start"] * 1000),
                "t1_ms": chunk_t0_ms + round(seg["end"] * 1000),
                "text": text,
                "extras": {"lid": lid} if lid is not None else {},
            })
        t += dur
    return segments, config


def build_track(window_id, window_wav, window_duration_ms, variant, machine="box"):
    """Build (not write) the REB track dict for one whisper variant over one window. Caller writes it
    via reb.writer.write_track with the window's manifest_stub — kept separate so a driver script can
    batch several variants under one manifest_stub lookup."""
    segments, config = run_window(window_wav, window_duration_ms, variant)
    status = "ok" if segments else "empty"
    return {
        "schema": "reb.track.v1", "window_id": window_id, "layer": "stt", "engine": variant,
        "model": MODEL, "version": VERSION, "config": config, "config_hash": config_hash(config),
        "machine": machine, "status": status,
        "reason": None if status == "ok" else "no non-empty segments in any chunk",
        "segments": segments,
    }
