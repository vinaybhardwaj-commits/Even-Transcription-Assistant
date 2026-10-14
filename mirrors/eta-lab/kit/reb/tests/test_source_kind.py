#!/usr/bin/env python3
"""Tests for the source_kind/clock manifest fields (bus #4783/#4784) AND the fixes eta-refuter-2/3
found on top (#4799/#4805): the stub/argument room_id-ist_date-window_id consistency check, the
POSITIVE real-room-id pattern (the safe default, not just an opt-in rejection), source_kind<->clock
pairing, dev_clip's required source_windows (a list -- a clip can span more than one tape chunk),
source_kind on the index line, and real_room_windows()."""
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
REAL_ROOM = "room_jwyrr4dc"
SUITE_ROOM = "suite-clinical1"
SRC_WIN = {"run_id": "hist-bulk-x", "window_id": "2026-09-12_room_x_0600"}


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


def expect_invalid(m, why):
    try:
        validate_manifest(m)
        raise AssertionError(f"expected ValidationError for: {why}")
    except ValidationError:
        pass


# --- valid combinations for each source_kind -------------------------------------------------------
assert validate_manifest(stub("w1", REAL_ROOM), raise_on_error=False) == []  # default = room_tape, real room, default clock
assert validate_manifest(stub("w1", REAL_ROOM, source_kind="room_tape", clock="approx"), raise_on_error=False) == []
assert validate_manifest(stub("w1", SUITE_ROOM, source_kind="suite_synthetic", clock="clip_local"), raise_on_error=False) == []
assert validate_manifest(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[SRC_WIN]), raise_on_error=False) == []
print("1/8 valid combinations OK: room_tape (default+explicit), suite_synthetic, dev_clip all pass with correct pairing")

# --- POSITIVE real-room check is the DEFAULT, not opt-in (eta-refuter-2 #4805 S1) -------------------
expect_invalid(stub("w1", "clinical1"), "a made-up room_id with source_kind OMITTED must still be rejected")
expect_invalid(stub("w1", "clinical1", source_kind="room_tape"), "same, source_kind explicit")
expect_invalid(stub("w1", "not_a_room", source_kind="dev_clip", source_windows=[SRC_WIN]), "dev_clip with a fake room_id must be rejected")
print("2/8 positive real-room check OK: rejected by default, not just when source_kind is set")

# --- suite_synthetic room_id pattern, including the case-sensitivity gap (#4799 N1) ------------------
expect_invalid(stub("w1", REAL_ROOM, source_kind="suite_synthetic", clock="clip_local"), "suite_synthetic needs the suite- pattern")
for bad in ("SUITE-x", "Suite-x", "suite_x", "suitex"):
    expect_invalid(stub("w1", bad, source_kind="suite_synthetic", clock="clip_local"), f"bad suite room_id {bad!r}")
    # and the SAME bad ids must also fail as a (default) room_tape room_id -- neither side accepts them
    expect_invalid(stub("w1", bad), f"{bad!r} is not a valid room_tape room_id either")
print("3/8 suite- pattern OK: case-sensitive, non-conforming ids rejected on both sides (no gap)")

# --- clock<->source_kind pairing (#4799 N2 / #4805 S2) -----------------------------------------------
expect_invalid(stub("w1", SUITE_ROOM, source_kind="suite_synthetic", clock="tape_utc"), "suite_synthetic must not use tape_utc")
expect_invalid(stub("w1", REAL_ROOM, clock="clip_local"), "room_tape must not use clip_local")
expect_invalid(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="clip_local", source_windows=[SRC_WIN]), "dev_clip must not use clip_local")
print("4/8 clock pairing OK: clip_local only for suite_synthetic, never for room_tape/dev_clip")

# --- dev_clip requires source_windows: a non-empty LIST, one entry per tape chunk/hist-bulk window
# this sub-clip actually spans (eta-refuter-2 #4805/#4853, eta-refuter-3 #4855: a consult-length crop
# often crosses more than one) -----------------------------------------------------------------------
expect_invalid(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx"), "dev_clip without source_windows at all")
expect_invalid(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[]), "an empty list doesn't count")
expect_invalid(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows={"run_id": "x", "window_id": "y"}),
               "the OLD singular-dict shape must now be rejected, not silently accepted as a 1-item anything")
expect_invalid(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[{"run_id": "x"}]),
               "an entry missing window_id must be rejected")
expect_invalid(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[SRC_WIN, {"run_id": "y"}]),
               "one good entry does not excuse a bad SECOND entry -- every listed source must be complete")
multi = [SRC_WIN, {"run_id": "hist-bulk-y", "window_id": "2026-09-12_room_x_0605"}]
assert validate_manifest(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=multi),
                          raise_on_error=False) == [], "a multi-chunk consult crop must validate with 2+ sources listed"
print("5/8 dev_clip source_windows OK: non-empty list required, every entry complete, multi-source clips supported")

# --- dev_clip source_windows: the CHUNK-level shape ({r2_key}), added for terms' set-(c) crops built
# directly from ~/eta-data/hist/manifest.json's raw chunk inventory rather than hist-bulk window jsons
# (#5225) -- r2_key alone fully qualifies one chunk, no run_id needed alongside it -------------------
CHUNK_A = {"r2_key": "bench/opd-1-xqj7/2026-09-22/bs_2zyc66ef/chunk_00003.webm"}
CHUNK_B = {"r2_key": "bench/opd-1-xqj7/2026-09-22/bs_2zyc66ef/chunk_00004.webm"}
assert validate_manifest(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[CHUNK_A]),
                          raise_on_error=False) == [], "a single chunk-level source must validate"
assert validate_manifest(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[CHUNK_A, CHUNK_B]),
                          raise_on_error=False) == [], "a multi-chunk consult crop (chunk-level) must validate"
assert validate_manifest(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[SRC_WIN, CHUNK_A]),
                          raise_on_error=False) == [], "mixing window-level and chunk-level entries in one list is allowed"
expect_invalid(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[{"r2_key": ""}]),
               "an empty r2_key must not count as a valid chunk source")
expect_invalid(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[{"r2_key": 12345}]),
               "a non-string r2_key must be rejected (eta-refuter-3 #5234 nit)")
expect_invalid(stub("w1", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[{}]),
               "an entry with neither shape (no run_id/window_id, no r2_key) must be rejected")
print("5b/8 dev_clip chunk-level source_windows OK: {r2_key} alone validates, mixes with window-level entries")

# --- write_track refuses a stub that disagrees with its own arguments (eta-refuter-3 #4799 B1) -------
try:
    write_track(ROOT, DATE, REAL_ROOM, "w2", track("w2"), manifest_stub=stub("w2", "room_completely_different"))
    raise AssertionError("expected a room_id mismatch between stub and argument to be refused")
except ValueError as e:
    assert "does not match" in str(e)
try:
    write_track(ROOT, "2026-01-01", REAL_ROOM, "w2", track("w2"), manifest_stub=stub("w2", REAL_ROOM))
    raise AssertionError("expected an ist_date mismatch to be refused")
except ValueError:
    pass
assert not os.path.exists(os.path.join(ROOT, DATE, "room_completely_different"))
print("6/8 stub/argument consistency OK: a mismatched stub is refused before anything is written")

# --- round trip: index.jsonl carries source_kind, real_room_windows() filters correctly --------------
write_track(ROOT, DATE, REAL_ROOM, "w_tape", track("w_tape"), manifest_stub=stub("w_tape", REAL_ROOM))
write_track(ROOT, DATE, REAL_ROOM, "w_dev", track("w_dev"),
            manifest_stub=stub("w_dev", REAL_ROOM, source_kind="dev_clip", clock="approx", source_windows=[SRC_WIN]))
write_track(ROOT, DATE, SUITE_ROOM, "w_synth", track("w_synth"),
            manifest_stub=stub("w_synth", SUITE_ROOM, source_kind="suite_synthetic", clock="clip_local"))

index_lines = [json.loads(l) for l in open(os.path.join(ROOT, DATE, "index.jsonl")) if l.strip()]
by_window = {l["window_id"]: l["source_kind"] for l in index_lines}
assert by_window == {"w_tape": "room_tape", "w_dev": "dev_clip", "w_synth": "suite_synthetic"}, by_window

windows = [reb_pkg.load_window(w, ist_date=DATE, root=ROOT) for w in ("w_tape", "w_dev", "w_synth")]
real_only = reb_pkg.real_room_windows(windows)
assert [w.window_id for w in real_only] == ["w_tape"], [w.window_id for w in real_only]
print("7/8 index+helper OK: index.jsonl carries source_kind; real_room_windows() excludes dev_clip and suite_synthetic")

# --- old-shape manifest (no source_kind/clock at all) still defaults and validates fine --------------
write_track(ROOT, DATE, REAL_ROOM, "w_old", track("w_old"), manifest_stub=stub("w_old", REAL_ROOM))
w_old = reb_pkg.load_window("w_old", ist_date=DATE, root=ROOT)
assert w_old.source_kind == "room_tape" and w_old.clock == "tape_utc"
print("8/8 backward-compat OK: an old-shape manifest still defaults to room_tape/tape_utc and validates")

shutil.rmtree(ROOT, ignore_errors=True)
print("ALL SOURCE_KIND/CLOCK TESTS OK")
