#!/usr/bin/env python3
"""Offline test for hf_emotion_job.py's pure pieces (chunking + probability averaging, no torch/av) and
hf_emotion_collect.track_from_scores (turns scored on HF -> a valid REB emotion track)."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))
from reb.validate import validate_track
import hf_emotion_job as j
import hf_emotion_collect as c
from reb_runner.engines import emotion_wavlm as e

assert (j.MODEL, j.MIN_SPEECH_S, j.SUBFOLDER, j.REVISION) == (e.MODEL, e.MIN_SPEECH_S, e.SUBFOLDER, e.REVISION)  # the standalone copies must not drift

SR = j.SR
assert j.chunk_bounds(10 * SR) == [[0, 10 * SR]]
assert j.chunk_bounds(60 * SR) == [[0, 30 * SR], [30 * SR, 60 * SR]]
assert j.chunk_bounds(30 * SR + SR // 2) == [[0, 30 * SR + SR // 2]]  # sub-1s tail folded in
assert j.chunk_bounds(900 * SR)[-1][1] == 900 * SR and len(j.chunk_bounds(900 * SR)) == 30
print("1/6 chunk_bounds OK")


class FakeClf:
    def __init__(self):
        self.calls = []

    def __call__(self, samples):
        self.calls.append(len(samples))
        # first 30 s piece says anger, later pieces say neutral
        if len(self.calls) == 1:
            return {"anger": 0.8, "neutral": 0.2}
        return {"anger": 0.2, "neutral": 0.8}


clf = FakeClf()
import numpy as np

LOUD = np.full(30 * SR, 0.1, dtype="float32")  # passes the silence gate
QUIET = np.zeros(30 * SR, dtype="float32")
label, scores, k, ns = j.score_samples(clf, np.tile(LOUD, 3))  # 3 pieces: anger .8, then .2, .2 -> mean .4
assert k == 3 and ns == 0 and clf.calls == [30 * SR] * 3
assert label == "neutral" and abs(scores["anger"] - 0.4) < 1e-9 and abs(scores["neutral"] - 0.6) < 1e-9
print("2/6 score_samples OK: <=30 s pieces, length-weighted mean of class probabilities")

# silence gate (eta-refuter #5741 B1): silent pieces are never classified nor averaged in
clf = FakeClf()
label, scores, k, ns = j.score_samples(clf, np.concatenate([QUIET, LOUD, QUIET]))
assert (k, ns) == (1, 2) and clf.calls == [30 * SR] and label == "anger" and abs(scores["anger"] - 0.8) < 1e-9
clf = FakeClf()
assert j.score_samples(clf, np.concatenate([QUIET, QUIET])) == (None, None, 0, 2) and clf.calls == []
clf = FakeClf()  # loud but < MIN_SPEECH_S of active frames: 1 s burst in a 30 s piece, rest at 0.005 (rms < .008, peak .1)
burst = np.full(30 * SR, 0.005, dtype="float32"); burst[:SR] = 0.1
assert j.silence_skip_reason(j.audio_energy(burst)) == "insufficient_speech"
assert j.silence_skip_reason(j.audio_energy(QUIET)) == "near_silent"
assert j.silence_skip_reason(j.audio_energy(LOUD)) is None
assert j.score_samples(clf, burst)[0] is None and clf.calls == []
print("2b silence gate OK: near_silent/insufficient_speech pieces skipped, all-skipped turn -> no label")

w = {"window_id": "w1", "t0_ms": 1790500000000, "t1_ms": 1790500000000 + 900_000,
     "turns": [[0, 900_000, None]]}
rec = {"window_id": "w1", "n_chunks": 30,
       "turns": [{"t0_ms": 0, "t1_ms": 900_000, "label": "neutral", "scores": {"neutral": 0.9, "anger": 0.1}}]}
track = c.track_from_scores(w, rec)
validate_track(track)
assert track["status"] == "ok" and track["segments"] == [
    {"t0_ms": 0, "t1_ms": 900_000, "value": {"label": "neutral", "scores": {"neutral": 0.9, "anger": 0.1}}}]
w2 = {"window_id": "w2", "t0_ms": 0, "t1_ms": 5000, "turns": [[0, 800, "0"], [800, 5000, "1"]]}
rec2 = {"window_id": "w2", "turns": [{"t0_ms": 800, "t1_ms": 5000, "label": "neutral", "scores": {"neutral": 1.0}}]}
t2 = c.track_from_scores(w2, rec2)
validate_track(t2)
assert t2["segments"][0]["extras"] == {"skipped_short": True} and t2["segments"][1]["value"]["label"] == "neutral"
try:
    c.track_from_scores(w2, {"window_id": "w2", "turns": []})
    raise SystemExit("a missing HF score for a scoreable turn was not rejected")
except KeyError:
    pass
print("3/6 track_from_scores OK: valid track, short turn gated, missing score fails loud")

# --- eta-refuter #5711 B1/B2: no window may crash the day -------------------------------------------
import json
import shutil
import tempfile
from reb.reb import load_window  # noqa: F401  (import check that the REB root API is present)
from reb.writer import write_track

# short audio: the job marks the turn skipped -> segment with extras.skipped_no_audio, track still valid
w3 = {"window_id": "w3", "t0_ms": 0, "t1_ms": 900_000, "turns": [[0, 300_000, "0"], [300_000, 900_000, "1"]]}
rec3 = {"window_id": "w3", "turns": [{"t0_ms": 0, "t1_ms": 300_000, "label": "neutral", "scores": {"neutral": 1.0}},
                                     {"t0_ms": 300_000, "t1_ms": 900_000, "skipped": "no_audio"}]}
t3 = c.track_from_scores(w3, rec3)
validate_track(t3)
assert t3["segments"][1]["extras"] == {"skipped_no_audio": True} and "value" not in t3["segments"][1]
rec_sil = {"window_id": "w1", "turns": [{"t0_ms": 0, "t1_ms": 300_000, "skipped": "silence", "n_pieces_skipped": 10},
                                        {"t0_ms": 300_000, "t1_ms": 900_000, "label": "neutral", "scores": {"neutral": 1.0}}]}
t4 = c.track_from_scores(dict(w, turns=[[0, 300_000, None], [300_000, 900_000, None]]), rec_sil)
validate_track(t4)
assert t4["segments"][0]["extras"] == {"skipped_silence": True} and "value" not in t4["segments"][0]
assert t4["segments"][1]["value"]["label"] == "neutral"
print("4/6 short audio OK: no_audio turn kept as a segment with extras.skipped_no_audio")

# truncated last line of out.jsonl (kill mid-write): done_ids ignores it, next append starts a fresh line
tmp = tempfile.mkdtemp(prefix="emotion-job-test-")
out = os.path.join(tmp, "out.jsonl")
with open(out, "w") as f:
    f.write(json.dumps({"window_id": "a", "turns": []}) + "\n" + '{"window_id": "b", "tur')
assert j.done_ids(out) == {"a"}
j.ensure_trailing_newline(out)
with open(out, "a") as f:
    f.write(json.dumps({"window_id": "b", "turns": []}) + "\n")
assert j.done_ids(out) == {"a", "b"}
print("5/6 resume OK: a truncated last line is ignored and the window redone")

# collect on a real (temp) REB root: one window scored, one absent from out.jsonl, one missing_audio
ROOT = os.path.join(tmp, "reb")
DATE = "2026-09-26"


def stub(wid):
    return {"window_id": wid, "room_id": "room_11111111", "room_slug": "room_11111111", "ist_date": DATE,
            "t0_ms": 0, "t1_ms": 5000,
            "audio": {"r2_key": f"x/{wid}.webm", "sha256": "0" * 64, "sample_rate": 16000, "duration_ms": 5000}}


man = [{"window_id": wid, "ist_date": DATE, "room_id": "room_11111111", "t0_ms": 0, "t1_ms": 5000,
        "turns": [[0, 5000, None]], "manifest_stub": stub(wid)} for wid in ("g", "absent", "nomedia", "hole")]
json.dump(man, open(os.path.join(tmp, "m.json"), "w"))
with open(os.path.join(tmp, "o.jsonl"), "w") as f:
    f.write(json.dumps({"window_id": "g", "turns": [{"t0_ms": 0, "t1_ms": 5000, "label": "neutral", "scores": {"neutral": 1.0}}]}) + "\n")
    f.write(json.dumps({"window_id": "nomedia", "missing_audio": True, "turns": []}) + "\n")
    f.write(json.dumps({"window_id": "hole", "turns": []}) + "\n")  # scoreable turn with no score -> KeyError path
    f.write("{trunc")
sys.argv = ["collect", os.path.join(tmp, "m.json"), os.path.join(tmp, "o.jsonl"), "--root", ROOT]
assert c.main() == 1  # (absent, nomedia, hole are incomplete)  # incomplete windows -> exit 1, but the good one was still written
assert load_window("g", ist_date=DATE, room_id="room_11111111", root=ROOT).tracks(layer="emotion")
shutil.rmtree(tmp, ignore_errors=True)
print("6/6 collect OK: absent/missing_audio windows are counted incomplete, the good window is still written")

nested = tempfile.mkdtemp(prefix="emotion-audio-idx-")
os.makedirs(os.path.join(nested, "room_x"))
for wid in ("w1", "w2"):
    open(os.path.join(nested, "room_x", f"{wid}.webm"), "w").close()
open(os.path.join(nested, "w3.webm"), "w").close()
open(os.path.join(nested, "w4.wav"), "w").close()
idx = j.index_audio(nested, "webm")
assert set(idx) == {"w1", "w2", "w3"} and idx["w1"].endswith("room_x/w1.webm")
shutil.rmtree(nested, ignore_errors=True)
print("index_audio OK: finds flat (HF bucket) and nested (hist-bulk local) layouts, filters by extension")

if shutil.which("ffmpeg"):
    import subprocess
    d = tempfile.mkdtemp(prefix="emotion-ffdec-")
    src = os.path.join(d, "t.webm")
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libopus", src], check=True)
    n = len(j._decode_ffmpeg(src))
    assert abs(n - 3 * SR) < SR // 10, n
    shutil.rmtree(d, ignore_errors=True)
    print("ffmpeg fallback decode OK: 3 s opus webm -> ~48000 samples at 16 kHz mono")
