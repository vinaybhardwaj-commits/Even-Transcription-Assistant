#!/usr/bin/env python3
"""Offline test for hf_emotion_manifest.py against a synthetic REB root (fake windows, no real
patient data) built with reb.writer.write_track itself — exercises: diar-turns-used-when-present,
whole-window-fallback-when-absent, already-done windows skipped, and suite_synthetic windows excluded
from the real-room emotion backfill."""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))  # kit/ for `reb`
from reb.writer import config_hash, write_track
from reb_runner import hf_emotion_manifest as m

ROOT = tempfile.mkdtemp(prefix="reb-emotion-test-")
DATE = "2026-09-26"


def stub(window_id, room_id, t0_ms=0, t1_ms=5000, source_kind=None):
    d = {"window_id": window_id, "room_id": room_id, "room_slug": room_id, "ist_date": DATE,
         "t0_ms": t0_ms, "t1_ms": t1_ms,
         "audio": {"r2_key": f"x/{window_id}.webm", "sha256": "0" * 64, "sample_rate": 16000, "duration_ms": t1_ms - t0_ms}}
    if source_kind:
        d["source_kind"] = source_kind
        d["clock"] = "clip_local" if source_kind == "suite_synthetic" else "tape_utc"
    return d


def diar_track(window_id, segments):
    cfg = {"backend": "hosted-api"}
    return {"schema": "reb.track.v1", "window_id": window_id, "layer": "diar", "engine": "pyannote",
            "model": "pyannote.ai", "version": "v1", "config": cfg, "config_hash": config_hash(cfg),
            "machine": "api", "status": "ok", "reason": None, "segments": segments}


def emotion_track(window_id):
    cfg = {"backend": "hf-l4x1", "min_speech_s": 1.5}
    return {"schema": "reb.track.v1", "window_id": window_id, "layer": "emotion", "engine": "wavlm",
            "model": "Aniemore/wavlm-emotion-v1-crosslingual", "version": "v1", "config": cfg,
            "config_hash": config_hash(cfg), "machine": "hf-l4x1", "status": "ok", "reason": None,
            "segments": [{"t0_ms": 0, "t1_ms": 5000, "value": {"label": "neutral", "scores": {"neutral": 0.9}}}]}


def acoustics_track(window_id):
    """Some other layer, just to create a window/manifest with no diar and no emotion track."""
    cfg = {"backend": "silero"}
    return {"schema": "reb.track.v1", "window_id": window_id, "layer": "acoustics", "engine": "vad",
            "model": "silero-vad", "version": "v1", "config": cfg, "config_hash": config_hash(cfg),
            "machine": "box", "status": "ok", "reason": None, "segments": []}


# w_diar: has an ok diar track -> should use its turns
write_track(ROOT, DATE, "room_11111111", "w_diar",
            diar_track("w_diar", [{"t0_ms": 0, "t1_ms": 2000, "speaker": "clinician"},
                                   {"t0_ms": 2000, "t1_ms": 5000, "speaker": None}]),
            manifest_stub=stub("w_diar", "room_11111111"))

# w_nodiar: no diar track -> whole-window fallback. Real epoch t0 (not 0), per eta-refuter #5410 B1:
# a window_t0_ms=0 fixture can't tell "window-relative" apart from "absolute" and hid this exact bug.
EPOCH_T0 = 1790500000000
write_track(ROOT, DATE, "room_11111111", "w_nodiar", acoustics_track("w_nodiar"),
            manifest_stub=stub("w_nodiar", "room_11111111", t0_ms=EPOCH_T0, t1_ms=EPOCH_T0 + 5000))

# w_done: already has an OK emotion track -> must be excluded from the manifest
write_track(ROOT, DATE, "room_11111111", "w_done", emotion_track("w_done"),
            manifest_stub=stub("w_done", "room_11111111"))

# w_suite: suite_synthetic -> excluded regardless of diar/emotion state
write_track(ROOT, DATE, "suite-clinical1", "w_suite",
            diar_track("w_suite", [{"t0_ms": 0, "t1_ms": 3000, "speaker": "clinician"}]),
            manifest_stub=stub("w_suite", "suite-clinical1", t0_ms=0, t1_ms=3000, source_kind="suite_synthetic"))

try:
    out = {w["window_id"]: w for w in m.build_manifest(ROOT, DATE)}

    assert set(out) == {"w_diar", "w_nodiar"}, out.keys()
    print("1/3 OK: w_done (already scored) and w_suite (synthetic) excluded from the manifest")

    assert out["w_diar"]["turns"] == [[0, 2000, "clinician"], [2000, 5000, None]]
    print("2/3 OK: w_diar's turns come from its diar track")

    assert out["w_nodiar"]["turns"] == [[0, 5000, None]]  # window-relative, not [EPOCH_T0, EPOCH_T0+5000]
    print("3/3 OK: w_nodiar (no diar track, real epoch t0) falls back to one window-relative turn")
finally:
    shutil.rmtree(ROOT, ignore_errors=True)
