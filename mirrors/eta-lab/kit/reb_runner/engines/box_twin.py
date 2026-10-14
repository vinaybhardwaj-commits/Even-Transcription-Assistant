"""Box-twin writers for the clinical1/label200 DEV ingest only (Fable 16:20, per lid-debug #4782):
SraVaani and IndicConformer-CTC via box's own local twins (:8085, :8082), NOT the HF GPU path the
real 26 Sep backfill will use. machine="box-twin" and config always carries backend="box-twin-cpu"
so a DEV track's config_hash can never collide with a later real backfill run of the same engine name.

decoding=ctc explicitly (not the server's rnnt default) per lid-debug: rnnt returns empty on many
real clips (W30.2a); ctc is the design's choice for this layer regardless of speed.
"""
import os

from reb.writer import config_hash

SRAVAANI_URL = os.environ.get("REB_SRAVAANI_URL", "http://127.0.0.1:8085/inference")
INDIC_URL = os.environ.get("REB_INDIC_URL", "http://127.0.0.1:8082/inference")
INDIC_LANGS = ("kn", "hi", "ta", "te", "ml")
BACKEND = "box-twin-cpu"


def _post_file(url, wav_path, data=None, timeout=180):
    import requests

    with open(wav_path, "rb") as f:
        r = requests.post(url, files={"file": (os.path.basename(wav_path), f, "audio/wav")},
                           data=data or {}, timeout=timeout)
    r.raise_for_status()
    return r.json()


def build_sravaani_track(window_id, wav_path, machine="box-twin"):
    resp = _post_file(SRAVAANI_URL, wav_path)
    text = (resp.get("text") or "").strip()
    config = {"backend": BACKEND}
    return {
        "schema": "reb.track.v1", "window_id": window_id, "layer": "stt", "engine": "sravaani",
        "model": "ARTPARK-IISc/SraVaani-1.0", "version": "v1", "config": config,
        "config_hash": config_hash(config), "machine": machine,
        "status": "ok" if text else "empty",
        "reason": None if text else "empty text from box-twin sravaani",
        "segments": [],  # filled in by caller with real t0/t1 once it knows the clip's duration_ms
        "_text": text,  # internal: caller moves this into the one segment it builds
    }


def build_indic_ctc_track(window_id, wav_path, lang, machine="box-twin"):
    if lang not in INDIC_LANGS:
        raise ValueError(f"lang {lang!r} not one of {INDIC_LANGS}")
    resp = _post_file(INDIC_URL, wav_path, data={"language": lang, "decoding": "ctc"})
    text = (resp.get("text") or "").strip()
    config = {"decoding": "ctc", "backend": BACKEND}
    return {
        "schema": "reb.track.v1", "window_id": window_id, "layer": "stt", "engine": f"indic-ctc-{lang}",
        "model": "ai4bharat/indic-conformer-600m-multilingual", "version": "v1", "config": config,
        "config_hash": config_hash(config), "machine": machine,
        "status": "ok" if text else "empty",
        "reason": None if text else f"empty text from box-twin indic-ctc-{lang}",
        "segments": [],
        "_text": text,
    }


def finalize_single_span(track, duration_ms):
    """Both box-twin engines return one aggregate text for the whole (<=35s) clip, not per-segment
    timing — turn that into REB's one-segment-spanning-the-clip shape. Pops the internal _text key."""
    text = track.pop("_text")
    track["segments"] = [{"t0_ms": 0, "t1_ms": duration_ms, "text": text}] if text else []
    return track
