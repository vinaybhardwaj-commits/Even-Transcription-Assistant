#!/usr/bin/env python3
"""Tests for the source_kind/clock manifest fields (bus #4783/#4784: distinguishing real room tape
from a synthetic test suite (clinical1) and a real-room dev sub-clip (label200 DEV30))."""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import reb as reb_pkg
from reb.validate import ValidationError, validate_manifest
from reb.writer import config_hash, write_track

ROOT = tempfile.mkdtemp(prefix="reb-sourcekind-")
DATE = "2026-09-26"


def stub(window_id, room_id, **extra):
    return {
        "window_id": window_id, "room_id": room_id, "room_slug": room_id, "ist_date": DATE,
        "t0_ms": 0, "t1_ms": 30000,
        "audio": {"r2_key": "x/y.webm", "sha256": "ab" * 32, "sample_rate": 16000, "duration_ms": 30000},
        **extra,
    }


def track(window_id, engine="whisper-auto"):
    cfg = {"language": "auto"}
    return {
        "schema": "reb.track.v1", "window_id": window_id, "layer": "stt", "engine": engine,
        "model": "m", "version": "v1", "config": cfg, "config_hash": config_hash(cfg),
        "machine": "box", "status": "ok", "segments": [{"t0_ms": 0, "t1_ms": 500, "text": "x"}],
    }


# --- valid source_kind/clock values accepted, invalid rejected --------------------------------------
for sk in ("room_tape", "suite_synthetic", "dev_clip", None):
    room = "suite-clinical1" if sk == "suite_synthetic" else "room_jwyrr4dc"
    errors = validate_manifest(stub("w1", room, **({"source_kind": sk} if sk else {})), raise_on_error=False)
    assert errors == [], errors
try:
    validate_manifest(stub("w1", "room_jwyrr4dc", source_kind="bogus"))
    raise AssertionError("expected a bad source_kind to be rejected")
except ValidationError:
    pass
for c in ("tape_utc", "approx", "clip_local", None):
    errors = validate_manifest(stub("w1", "room_jwyrr4dc", **({"clock": c} if c else {})), raise_on_error=False)
    assert errors == [], errors
try:
    validate_manifest(stub("w1", "room_jwyrr4dc", clock="bogus"))
    raise AssertionError("expected a bad clock value to be rejected")
except ValidationError:
    pass
print("1/4 enum validation OK: source_kind/clock accept only their documented values")

# --- suite_synthetic MUST use the suite- room_id prefix; the prefix is reserved for it --------------
try:
    validate_manifest(stub("w1", "room_jwyrr4dc", source_kind="suite_synthetic"))
    raise AssertionError("a suite_synthetic window with a real-looking room_id must be rejected")
except ValidationError as e:
    assert "suite-" in str(e)
try:
    validate_manifest(stub("w1", "suite-clinical1", source_kind="room_tape"))
    raise AssertionError("a non-synthetic window must not use the reserved suite- room_id prefix")
except ValidationError:
    pass
assert validate_manifest(stub("w1", "suite-clinical1", source_kind="suite_synthetic"), raise_on_error=False) == []
print("2/4 suite- prefix enforcement OK: can't fake or omit it for suite_synthetic")

# --- defaults: a window written before this field existed reads back as room_tape/tape_utc ----------
write_track(ROOT, DATE, "room_jwyrr4dc", "w_old", track("w_old"), manifest_stub=stub("w_old", "room_jwyrr4dc"))
w_old = reb_pkg.load_window("w_old", ist_date=DATE, root=ROOT)
assert w_old.source_kind == "room_tape" and w_old.clock == "tape_utc"
print("3/4 defaults OK: an old-shape manifest with no source_kind/clock reads back as room_tape/tape_utc")

# --- round trip: a dev_clip (real room, short, reconstructed tape time) and a suite_synthetic window ---
write_track(ROOT, DATE, "room_jwyrr4dc", "w_devclip", track("w_devclip"),
            manifest_stub=stub("w_devclip", "room_jwyrr4dc", source_kind="dev_clip", clock="approx"))
w_dev = reb_pkg.load_window("w_devclip", ist_date=DATE, root=ROOT)
assert w_dev.source_kind == "dev_clip" and w_dev.clock == "approx"

write_track(ROOT, DATE, "suite-clinical1", "w_synth", track("w_synth"),
            manifest_stub=stub("w_synth", "suite-clinical1", source_kind="suite_synthetic", clock="clip_local"))
w_synth = reb_pkg.load_window("w_synth", ist_date=DATE, root=ROOT)
assert w_synth.source_kind == "suite_synthetic" and w_synth.clock == "clip_local"
print("4/4 round trip OK: dev_clip and suite_synthetic windows write/read correctly, room_tape windows unaffected")

shutil.rmtree(ROOT, ignore_errors=True)
print("ALL SOURCE_KIND/CLOCK TESTS OK")
