#!/usr/bin/env python3
"""Offline tests for reb_runner.engines.box_twin: track shape, config_hash isolation from any real
backfill run of the same engine, empty-status handling."""
import os
import sys

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
print("1/3 sravaani box-twin OK: single span, correct config, validates")

t2 = bt.build_indic_ctc_track("w1", "/tmp/fake.wav", "kn")
t2 = bt.finalize_single_span(t2, 15000)
validate_track(t2)
assert t2["engine"] == "indic-ctc-kn" and t2["config"] == {"decoding": "ctc", "backend": "box-twin-cpu"}
try:
    bt.build_indic_ctc_track("w1", "/tmp/fake.wav", "en")
    raise AssertionError("expected a non-IN22 lang to be rejected")
except ValueError:
    pass
print("2/3 indic-ctc box-twin OK: correct engine name/config, bad lang rejected")

# config_hash must differ from a hypothetical HF-backfill run of the SAME engine name using a plain
# {"decoding": "ctc"} config (no backend field) -- the backend field is what keeps them from colliding.
hf_style_config = {"decoding": "ctc"}
assert config_hash(hf_style_config) != t2["config_hash"], "box-twin and a differently-configured HF run must not collide"
print("3/3 isolation OK: box-twin's config_hash differs from a same-engine run without backend=box-twin-cpu")

print("ALL BOX_TWIN TESTS OK")
