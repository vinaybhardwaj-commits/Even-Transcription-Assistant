#!/usr/bin/env python3
"""Offline tests for reb_runner.engines.box_twin: track shape, config_hash isolation from any real
backfill run of the same engine, empty-status handling, and the long-audio chunking fix
(eta-refuter-2/3 #4914/#4916): SraVaani's chunk_s mode never shares a config_hash with the original
single-shot mode, produces multiple segments, and indic-ctc's timeout scales with duration."""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
from reb.validate import validate_track
from reb.writer import config_hash
from reb_runner.engines import box_twin as bt

bt._post_file = lambda url, wav_path, data=None, timeout=180: (
    {"text": "namaskara", "sec": 0.7} if "8085" in url else {"text": "hi text", "language": data.get("language"), "decoding": data.get("decoding"), "segments": [], "sec": 2.8}
)

t = bt.build_sravaani_track("w1", "/tmp/fake.wav")
t = bt.finalize_single_span(t, 15000)
validate_track(t)
assert t["engine"] == "sravaani" and t["status"] == "ok"
assert t["segments"] == [{"t0_ms": 0, "t1_ms": 15000, "text": "namaskara"}]
assert t["config"] == {"backend": "box-twin-cpu"}
print("1/5 sravaani box-twin OK: single span, correct config, validates")

t2 = bt.build_indic_ctc_track("w1", "/tmp/fake.wav", "kn")
t2 = bt.finalize_single_span(t2, 15000)
validate_track(t2)
assert t2["engine"] == "indic-ctc-kn" and t2["config"] == {"decoding": "ctc", "backend": "box-twin-cpu"}
try:
    bt.build_indic_ctc_track("w1", "/tmp/fake.wav", "en")
    raise AssertionError("expected a non-IN22 lang to be rejected")
except ValueError:
    pass
print("2/5 indic-ctc box-twin OK: correct engine name/config, bad lang rejected")

# config_hash must differ from a hypothetical HF-backfill run of the SAME engine name using a plain
# {"decoding": "ctc"} config (no backend field) -- the backend field is what keeps them from colliding.
hf_style_config = {"decoding": "ctc"}
assert config_hash(hf_style_config) != t2["config_hash"], "box-twin and a differently-configured HF run must not collide"
print("3/5 isolation OK: box-twin's config_hash differs from a same-engine run without backend=box-twin-cpu")

# --- LONG AUDIO: chunk_s mode produces multiple segments, never shares a hash with single-shot ------
WAV = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                 "-t", "65", WAV], check=True)

chunk_calls = {"n": 0}
CHUNK_TEXTS = ["chunk one text", "chunk two text", ""]  # 3rd (5s) chunk empty


def chunked_post(url, wav_path, data=None, timeout=180):
    i = chunk_calls["n"]
    chunk_calls["n"] += 1
    return {"text": CHUNK_TEXTS[i]}


bt._post_file = chunked_post
t3 = bt.build_sravaani_track("w2", WAV, chunk_s=30)
validate_track(t3)
assert "_text" not in t3, "chunked mode must return a complete track, not the caller-finalizes shape"
assert t3["config"] == {"backend": "box-twin-cpu", "chunk_s": 30}
assert t3["config_hash"] != config_hash({"backend": "box-twin-cpu"}), "chunked config must not collide with single-shot's cee5af35-style hash"
assert len(t3["segments"]) == 2, t3["segments"]  # the empty 3rd chunk contributes nothing
assert t3["segments"][0] == {"t0_ms": 0, "t1_ms": 30000, "text": "chunk one text"}
assert t3["segments"][1] == {"t0_ms": 30000, "t1_ms": 60000, "text": "chunk two text"}
assert chunk_calls["n"] == 3, "65s audio at chunk_s=30 must make exactly 3 calls (30/30/5)"
print("4/5 sravaani chunked mode OK: multiple real segments, own config_hash, no collision with single-shot")

# --- eta-refuter-3 #4929 N1: chunk_s as a float must hash the SAME as the equivalent int -------------
chunk_calls["n"] = 0
t3b = bt.build_sravaani_track("w2", WAV, chunk_s=30.0)
assert t3b["config"] == {"backend": "box-twin-cpu", "chunk_s": 30}, "chunk_s must be normalized to int in the stored config"
assert t3b["config_hash"] == t3["config_hash"], "chunk_s=30 and chunk_s=30.0 must hash identically, not silently diverge"
print("N1 fix OK: chunk_s=30.0 (float) normalizes to the same config/hash as chunk_s=30 (int)")

# --- indic-ctc: timeout scales with duration, segment shape unchanged (deliberately not touched) ----
captured_timeout = {}
def capture_timeout_post(url, wav_path, data=None, timeout=180):
    captured_timeout["value"] = timeout
    return {"text": "namaskara"}
bt._post_file = capture_timeout_post
bt.build_indic_ctc_track("w1", "/tmp/fake.wav", "kn")  # no duration_s -> default 180
assert captured_timeout["value"] == 180
bt.build_indic_ctc_track("w1", "/tmp/fake.wav", "kn", duration_s=781)  # terms' set-c median
assert captured_timeout["value"] >= 780 * 3, captured_timeout["value"]
print("5/5 indic-ctc timeout OK: scales with duration, defaults unchanged when duration_s is omitted")

# --- eta-refuter-3 #4935 nit: chunk_s < 1 must fail loudly, not loop forever in plan_chunks --------
try:
    bt.build_sravaani_track("w2", WAV, chunk_s=0.5)
    raise AssertionError("expected chunk_s < 1 to be rejected")
except ValueError:
    pass
print("nit fix OK: chunk_s < 1 raises instead of hanging plan_chunks")

os.unlink(WAV)
print("ALL BOX_TWIN TESTS OK")
