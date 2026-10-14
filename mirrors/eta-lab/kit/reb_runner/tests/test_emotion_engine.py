#!/usr/bin/env python3
"""Offline tests for reb_runner.engines.emotion_wavlm: diar-vs-whole-window turn fallback, the
min_speech_s gate, and schema validity. The model call is faked (score_fn injected) and slicing is
faked too (slice_fn injected) so no ffmpeg or transformers/GPU is needed to run this file — same
"fake the network/model call, keep the real arithmetic" split as test_whisper_engine.py."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))  # kit/ for `reb`
from reb.validate import validate_track
from reb_runner.engines import emotion_wavlm as e

WAV = "/tmp/fake-window.wav"

# --- turns_from_diar_segments: diar present -> its turns; diar empty/None -> one whole-window turn --
diar_segs = [{"t0_ms": 0, "t1_ms": 2000, "speaker": "clinician"}, {"t0_ms": 2000, "t1_ms": 5000, "speaker": None}]
turns = e.turns_from_diar_segments(diar_segs, 0, 5000)
assert turns == [(0, 2000, "clinician"), (2000, 5000, None)], turns

# fallback at window_t0_ms=0 is not a real test of the relative-vs-absolute conversion (0 looks the
# same either way) -- eta-refuter #5410 B1: use a real epoch window start, like every actual window
# will have, so a regression back to "return the absolute bounds" fails loudly here.
EPOCH_T0 = 1790500000000  # a real tape-clock ms value (~28 Sep 2026), same order of magnitude as prod
turns_fallback = e.turns_from_diar_segments(None, EPOCH_T0, EPOCH_T0 + 300_000)
assert turns_fallback == [(0, 300_000, None)], turns_fallback  # window-relative: starts at 0, not EPOCH_T0
turns_empty = e.turns_from_diar_segments([], EPOCH_T0, EPOCH_T0 + 5900)
assert turns_empty == [(0, 5900, None)], turns_empty
print("1/5 turns_from_diar_segments OK: diar turns used when present, whole-window fallback is "
      "window-relative (0-based) even for a real epoch window start")

# --- build_track: one clip cut and scored per turn, slice/score calls recorded in call order --------
calls = {"sliced": [], "scored": []}


def fake_slice(path, t0_ms, t1_ms):
    calls["sliced"].append((path, t0_ms, t1_ms))
    return f"{path}.{t0_ms}-{t1_ms}.clip.wav"


def fake_score(model, clip_path):
    calls["scored"].append(clip_path)
    return {"label": "neutral", "scores": {"neutral": 0.7, "anger": 0.1}}


track = e.build_track("w_test", WAV, 0, 5000, diar_segments=diar_segs, model="fake-model",
                       slice_fn=fake_slice, score_fn=fake_score)
validate_track(track)  # raises on any schema violation
assert track["layer"] == "emotion" and track["engine"] == "wavlm" and track["model"] == e.MODEL
assert track["status"] == "ok"
assert len(track["segments"]) == 2
assert track["segments"][0]["speaker"] == "clinician" and track["segments"][0]["value"]["label"] == "neutral"
assert "speaker" not in track["segments"][1]  # speaker=None must not be written as a null field
assert calls["sliced"] == [(WAV, 0, 2000), (WAV, 2000, 5000)]
print("2/5 build_track OK: validates against reb's schema, one slice+score per turn, null speaker omitted")

# --- min_speech_s gate: a turn shorter than 1.5s is never sliced/scored, carries skipped_short --------
calls["sliced"].clear(); calls["scored"].clear()
short_diar = [{"t0_ms": 0, "t1_ms": 800, "speaker": "clinician"}, {"t0_ms": 800, "t1_ms": 4000, "speaker": None}]
track2 = e.build_track("w_short", WAV, 0, 4000, diar_segments=short_diar, model="fake-model",
                        slice_fn=fake_slice, score_fn=fake_score)
assert track2["segments"][0]["extras"] == {"skipped_short": True}
assert "value" not in track2["segments"][0]
assert "value" in track2["segments"][1]
assert calls["sliced"] == [(WAV, 800, 4000)]  # the sub-1.5s turn never reached slice_fn at all
assert track2["status"] == "ok"  # at least one turn scored
print("3/5 min_speech_s gate OK: short turn skipped (extras.skipped_short), never sliced/scored")

# --- every turn below the gate -> status empty, with a reason -----------------------------------------
all_short = [{"t0_ms": 0, "t1_ms": 500, "speaker": None}]
track3 = e.build_track("w_allshort", WAV, 0, 500, diar_segments=all_short, model="fake-model",
                        slice_fn=fake_slice, score_fn=fake_score)
validate_track(track3)
assert track3["status"] == "empty" and track3["reason"]
print("4/5 all-short OK: status='empty' with a non-empty reason when every turn is gated out")

# --- eta-refuter #5410 B1 regression: no-diar fallback at a REAL epoch window start must slice the ---
# window wav at a small, in-file offset (0..duration), never at the raw epoch value -----------------
calls["sliced"].clear(); calls["scored"].clear()
track4 = e.build_track("w_epoch", WAV, EPOCH_T0, EPOCH_T0 + 300_000, diar_segments=None,
                        model="fake-model", slice_fn=fake_slice, score_fn=fake_score)
validate_track(track4)
assert calls["sliced"] == [(WAV, 0, 300_000)], calls["sliced"]  # NOT (WAV, EPOCH_T0, EPOCH_T0+300000)
assert track4["segments"] == [{"t0_ms": 0, "t1_ms": 300_000, "value": {"label": "neutral", "scores": {"neutral": 0.7, "anger": 0.1}}}]
print("5/5 no-diar fallback at a real epoch window start slices/writes window-relative times, "
      "not the absolute tape-clock epoch (eta-refuter #5410 B1)")
