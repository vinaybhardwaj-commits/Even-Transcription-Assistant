#!/usr/bin/env python3
"""Offline tests for reb_runner.engines.whisper: chunk-boundary arithmetic, LID extraction/attachment
per lid-debug's #4735 convention, and status logic. The real whisper-server call is monkeypatched
(network + model inference isn't what this module is responsible for getting right) but chunk slicing
uses a REAL short synthetic (silence) wav via ffmpeg, so the chunk-loop's timing math is genuinely
exercised, not just asserted."""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))  # kit/ for `reb`
from reb.validate import validate_track
from reb_runner.engines import whisper as w

# a 65s synthetic silent wav -> 3 chunks (30, 30, 5) to exercise the chunk loop's boundaries
WAV = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                 "-t", "65", WAV], check=True)

# canned verbose_json-shaped responses, one per expected chunk call, in call order
CANNED = [
    {"segments": [{"start": 1.0, "end": 2.5, "text": " hello"}],
     "language_probabilities": {"en": 0.9, "hi": 0.05, "kn": 0.0001}},
    {"segments": [{"start": 0.5, "end": 1.0, "text": " world"}],
     "language_probabilities": {"hi": 0.8, "en": 0.15}},
    {"segments": [],  # last (short, 5s) chunk: genuinely empty
     "language_probabilities": {"en": 0.5, "hi": 0.5}},
]
calls = {"n": 0, "args": []}


def fake_call(chunk_wav, language, prompt, timeout=120):
    calls["args"].append((language, prompt))
    resp = CANNED[calls["n"]]
    calls["n"] += 1
    return resp


w._call_whisper = fake_call

segments, config = w.run_window(WAV, 65000, "whisper-auto")

# --- chunk-boundary global-time offsets ---
assert len(segments) == 2, segments  # the empty 3rd chunk contributes nothing
assert segments[0]["t0_ms"] == 1000 and segments[0]["t1_ms"] == 2500 and segments[0]["text"] == "hello"
assert segments[1]["t0_ms"] == 30500 and segments[1]["t1_ms"] == 31000 and segments[1]["text"] == "world", segments[1]
print("1/4 chunk offsets OK: 2nd chunk's local times correctly shifted by its 30000ms global start")

# --- LID per segment, max-prob entry derived correctly, low-prob entries (<0.001) dropped ---
lid0 = segments[0]["extras"]["lid"]
assert lid0["detected"] == "en" and abs(lid0["p"] - 0.9) < 1e-9
assert "kn" not in lid0["probs"], "a probability below 0.001 must be dropped"
assert lid0["scored_ms"] == [0, 30000]
lid1 = segments[1]["extras"]["lid"]
assert lid1["detected"] == "hi" and lid1["scored_ms"] == [30000, 60000]
print("2/4 LID extraction OK: max-prob entry, sub-0.001 probs dropped, scored_ms per chunk")

# --- 3 chunks called (30, 30, 5), each with the expected language/prompt for whisper-auto ---
assert calls["n"] == 3
assert all(lang == "auto" and prompt is None for lang, prompt in calls["args"])
print("3/4 chunking OK: 65s audio -> exactly 3 calls (30/30/5s), auto-lang, no prompt")

# --- build_track: status/ok, config recorded, and it validates against REB's own schema -----------
calls["n"] = 0
track = w.build_track("w_test", WAV, 65000, "whisper-auto")
validate_track(track)  # raises on any schema violation
assert track["status"] == "ok" and track["engine"] == "whisper-auto"
assert track["config"] == {"language": "auto", "response_format": "verbose_json", "temperature": 0.0, "temperature_inc": 0.2}
print("4/4 build_track OK: validates against reb's schema, config faithfully recorded")

# --- forced-en and cap2 variants request the right language/prompt ---------------------------------
calls["n"] = 0; calls["args"].clear()
w.run_window(WAV, 65000, "whisper-forced-en")
assert all(lang == "en" and prompt is None for lang, prompt in calls["args"])
calls["n"] = 0; calls["args"].clear()
w.run_window(WAV, 65000, "whisper-cap2")
assert all(lang == "en" and prompt for lang, prompt in calls["args"]), "cap2 must send a non-empty prompt"
print("variants OK: forced-en has no prompt, cap2 always sends one")

# --- an all-empty run is status='empty', not 'ok', and still validates -----------------------------
calls["n"] = 0; calls["args"].clear()
w._call_whisper = lambda *a, **k: {"segments": [], "language_probabilities": {}}
empty_track = w.build_track("w_test2", WAV, 65000, "whisper-forced-en")
validate_track(empty_track)
assert empty_track["status"] == "empty" and empty_track["segments"] == []
print("empty-status OK: no segments -> status='empty' (not 'ok'), still schema-valid")

os.unlink(WAV)
print("ALL WHISPER ENGINE TESTS OK")
