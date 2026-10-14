"""Tests for build_windows_set_c.py (ADDENDUM-23 settled shape). Includes a real validate_manifest check
against the FROZEN 1ee3b4a4 pin (subprocess-isolated) to prove, not assume, this shape validates with zero reb
change - no re-pin needed."""
import json
import os
import subprocess
import sys
import tempfile

import pytest

from build_windows_set_c import (
    build_manifest_stub, build_source_windows, build_windows_set_c, inventory_run_id, load_staged_manifest,
    _assert_plan_matches_staged, ist_date_from_iso,
)

REPO_DIR = os.path.dirname(os.path.abspath(__file__))
STAGED_MANIFEST_PRESENT = os.path.exists(os.path.expanduser("~/eta-data/terms/setc-stage/manifest.jsonl"))
HIST_MANIFEST_PRESENT = os.path.exists(os.path.expanduser("~/eta-data/terms/inventory/manifest.json"))

SAMPLE_ROW_NO_GAP = {
    "consult_id": "vs2usgDW6FioNC9vMuZZ", "day": "22", "room_id": "room_qyzghzaf",
    "span_start": "2026-09-22T09:23:30+05:30", "span_end": "2026-09-22T09:30:23+05:30",
    "span_duration_s": 413.0, "segment_sum_duration_s": 413.0, "decoded_duration_s": 412.993,
    "sha256": "d63a169c0701087ee87ce10fae0904e50f8c65cc71a919230e248cad47a4bcae", "sample_rate": 16000,
    "source_chunk_keys": [
        "bench/opd-7-y74w/2026-09-22/bs_m6nq7upz/chunk_00000.webm",
        "bench/opd-7-y74w/2026-09-22/bs_m6nq7upz/chunk_00001.webm",
    ],
}
SAMPLE_SEGMENTS_NO_GAP = [
    {"r2_key": "bench/opd-7-y74w/2026-09-22/bs_m6nq7upz/chunk_00000.webm",
     "local_start_s": 0.0, "local_end_s": 300.0, "source_manifest": "manifest.json"},
    {"r2_key": "bench/opd-7-y74w/2026-09-22/bs_m6nq7upz/chunk_00001.webm",
     "local_start_s": 0.0, "local_end_s": 113.0, "source_manifest": "manifest.json"},
]
SAMPLE_ROW_WITH_GAP = {
    "consult_id": "GQlym1PuFl9PvinnlikW", "day": "24", "room_id": "room_ux92qpws",
    "span_start": "2026-09-24T12:00:00+05:30", "span_end": "2026-09-24T12:13:35+05:30",
    "span_duration_s": 815.0, "segment_sum_duration_s": 813.739, "decoded_duration_s": 813.739,
    "sha256": "a" * 64, "sample_rate": 16000,
    "source_chunk_keys": ["bench/opd-4-ortho-778q/2026-09-24/bs_ekewxt9t/chunk_00042.webm"],
}
SAMPLE_SEGMENTS_WITH_GAP = [
    {"r2_key": "bench/opd-4-ortho-778q/2026-09-24/bs_ekewxt9t/chunk_00042.webm",
     "local_start_s": 10.0, "local_end_s": 823.739, "source_manifest": "manifest_tierC.json"},
]
FAKE_RUN_ID = "hist-inventory@50469e03c069+a645a9d154f5"


def test_build_source_windows_shape():
    sw = build_source_windows(SAMPLE_SEGMENTS_NO_GAP, FAKE_RUN_ID)
    assert sw == [
        {"run_id": FAKE_RUN_ID, "window_id": "bench/opd-7-y74w/2026-09-22/bs_m6nq7upz/chunk_00000.webm",
         "local_start_s": 0.0, "local_end_s": 300.0, "source_manifest": "manifest.json"},
        {"run_id": FAKE_RUN_ID, "window_id": "bench/opd-7-y74w/2026-09-22/bs_m6nq7upz/chunk_00001.webm",
         "local_start_s": 0.0, "local_end_s": 113.0, "source_manifest": "manifest.json"},
    ]


def test_manifest_stub_shape():
    stub = build_manifest_stub(SAMPLE_ROW_NO_GAP, SAMPLE_SEGMENTS_NO_GAP, FAKE_RUN_ID)
    assert stub["window_id"] == "vs2usgDW6FioNC9vMuZZ"
    assert stub["room_id"] == "room_qyzghzaf" == stub["room_slug"]
    assert stub["ist_date"] == "2026-09-22"
    assert stub["t0_ms"] == 0
    assert stub["t1_ms"] == 412993
    assert stub["source_kind"] == "dev_clip"
    assert stub["audio"]["sha256"] == SAMPLE_ROW_NO_GAP["sha256"]
    assert stub["audio"]["r2_key"] == "w50-setc-2026-09-28/vs2usgDW6FioNC9vMuZZ.wav"
    assert len(stub["source_windows"]) == 2
    assert all(sw["run_id"] == FAKE_RUN_ID for sw in stub["source_windows"])
    assert all("window_id" in sw and sw["window_id"] for sw in stub["source_windows"])


def test_clock_is_tape_utc_when_no_tolerated_gap():
    stub = build_manifest_stub(SAMPLE_ROW_NO_GAP, SAMPLE_SEGMENTS_NO_GAP, FAKE_RUN_ID)
    assert stub["clock"] == "tape_utc"


def test_clock_is_approx_when_tolerated_gap_present():
    """The real GQlym1Pu... case: span_duration_s (815.0) > segment_sum_duration_s (813.739)."""
    stub = build_manifest_stub(SAMPLE_ROW_WITH_GAP, SAMPLE_SEGMENTS_WITH_GAP, FAKE_RUN_ID)
    assert stub["clock"] == "approx"


def test_ist_date_from_iso_handles_already_ist_offset():
    assert ist_date_from_iso("2026-09-22T09:23:30+05:30") == "2026-09-22"


def test_ist_date_from_iso_converts_utc_correctly():
    """refuter-3 #5260 nit: a span recorded in UTC late at night would slip a day with naive string-slicing -
    23:00 UTC on the 21st is 04:30 IST on the 22nd."""
    assert ist_date_from_iso("2026-09-21T23:00:00+00:00") == "2026-09-22"


def test_ist_date_from_iso_converts_utc_near_midnight_ist_correctly():
    """18:29 UTC = 23:59 IST (same day); 18:31 UTC = 00:01 IST (next day) - exercises the exact boundary the
    naive slice would get wrong."""
    assert ist_date_from_iso("2026-09-21T18:29:00+00:00") == "2026-09-21"
    assert ist_date_from_iso("2026-09-21T18:31:00+00:00") == "2026-09-22"


def test_room_id_matches_real_room_id_pattern():
    import re
    REAL_ROOM_ID_RE = re.compile(r"^room_[a-z0-9]{8}$")
    for row, segs in ((SAMPLE_ROW_NO_GAP, SAMPLE_SEGMENTS_NO_GAP), (SAMPLE_ROW_WITH_GAP, SAMPLE_SEGMENTS_WITH_GAP)):
        stub = build_manifest_stub(row, segs, FAKE_RUN_ID)
        assert REAL_ROOM_ID_RE.match(stub["room_id"]), stub["room_id"]


@pytest.mark.skipif(not HIST_MANIFEST_PRESENT, reason="real hist manifest not present on this box")
def test_inventory_run_id_matches_the_frozen_snapshot_shas():
    """ADDENDUM-23 amendment (refuter-2 #5247): the live manifest_tierC.json is not stable (rewritten mid-study
    by a running ingestion job), so this checks against the FROZEN local snapshot's shas, not a live value that
    could drift again. manifest.json 50469e03c069 (stable, unaffected), manifest_tierC.json a645a9d154f5
    (corrects the original c5561681caae, a live-file version already superseded by recheck time)."""
    assert inventory_run_id() == "hist-inventory@50469e03c069+a645a9d154f5"


@pytest.mark.skipif(not (STAGED_MANIFEST_PRESENT and HIST_MANIFEST_PRESENT),
                     reason="real staged set (c) manifest / hist manifest not present on this box")
def test_real_staged_manifest_produces_87_windows():
    windows = build_windows_set_c()
    assert len(windows) == 87
    assert len({w["window_id"] for w in windows}) == 87  # no duplicate consult_ids
    assert all(w["manifest_stub"]["source_windows"] for w in windows)  # every window has >=1 source_windows entry


# --- build-time guard (refuter-2 #5257 / refuter-3 #5258): plan content must match what was actually staged ---

def test_assert_plan_matches_staged_passes_on_real_match():
    _assert_plan_matches_staged(SAMPLE_ROW_NO_GAP, SAMPLE_SEGMENTS_NO_GAP)  # no raise


def test_assert_plan_matches_staged_passes_within_duration_tolerance():
    row = dict(SAMPLE_ROW_NO_GAP, segment_sum_duration_s=SAMPLE_ROW_NO_GAP["segment_sum_duration_s"] + 0.0005)
    _assert_plan_matches_staged(row, SAMPLE_SEGMENTS_NO_GAP)  # 0.5ms diff is within the 1ms tolerance - no raise


def test_assert_plan_matches_staged_raises_on_different_chunk_keys():
    segments = [dict(SAMPLE_SEGMENTS_NO_GAP[0], r2_key="bench/some/other/chunk_09999.webm")]
    with pytest.raises(ValueError, match="chunk keys"):
        _assert_plan_matches_staged(SAMPLE_ROW_NO_GAP, segments)


def test_assert_plan_matches_staged_raises_on_different_chunk_order():
    reordered = list(reversed(SAMPLE_SEGMENTS_NO_GAP))
    with pytest.raises(ValueError, match="chunk keys"):
        _assert_plan_matches_staged(SAMPLE_ROW_NO_GAP, reordered)


def test_assert_plan_matches_staged_raises_on_duration_mismatch():
    row = dict(SAMPLE_ROW_NO_GAP, segment_sum_duration_s=SAMPLE_ROW_NO_GAP["segment_sum_duration_s"] + 5.0)
    with pytest.raises(ValueError, match="duration"):
        _assert_plan_matches_staged(row, SAMPLE_SEGMENTS_NO_GAP)


@pytest.mark.skipif(not (STAGED_MANIFEST_PRESENT and HIST_MANIFEST_PRESENT),
                     reason="real staged set (c) manifest / hist manifest not present on this box")
def test_real_build_raises_on_a_perturbed_staged_row(tmp_path, monkeypatch):
    """refuter-2 #5257: test the guard with one perturbed row, against the real 87-consult data."""
    import build_windows_set_c as m
    real_rows = load_staged_manifest()
    perturbed_path = tmp_path / "manifest.jsonl"
    perturbed_rows = [dict(r) for r in real_rows]
    perturbed_rows[0]["source_chunk_keys"] = ["bench/not-a-real/chunk_00000.webm"]
    with open(perturbed_path, "w") as f:
        for row in perturbed_rows:
            f.write(json.dumps(row) + "\n")
    with pytest.raises(ValueError, match="chunk keys"):
        m.build_windows_set_c(staged_manifest_path=str(perturbed_path))


# --- real validate_manifest check against the FROZEN pin, subprocess-isolated ---

def _checkout_kit_reb(commit, dest_kit_dir):
    files = ["__init__.py", "schema.py", "validate.py", "writer.py", "reb.py", "r2_mirror.py"]
    reb_dir = os.path.join(dest_kit_dir, "reb")
    os.makedirs(reb_dir, exist_ok=True)
    for fname in files:
        content = subprocess.run(
            ["git", "-C", REPO_DIR, "show", f"{commit}:kit/reb/{fname}"], check=True, capture_output=True,
        ).stdout
        with open(os.path.join(reb_dir, fname), "wb") as f:
            f.write(content)


def _validate_manifest_at_commit(manifest_stub, commit):
    with tempfile.TemporaryDirectory() as tmp_kit:
        _checkout_kit_reb(commit, tmp_kit)
        script = (
            "import sys, json\n"
            f"sys.path.insert(0, {tmp_kit!r})\n"
            "from reb import validate_manifest, ValidationError\n"
            "manifest = json.loads(sys.argv[1])\n"
            "try:\n"
            "    validate_manifest(manifest)\n"
            "    print('VALID')\n"
            "except ValidationError as e:\n"
            "    print('INVALID: ' + '; '.join(e.errors))\n"
        )
        result = subprocess.run(
            [sys.executable, "-c", script, json.dumps(manifest_stub)], capture_output=True, text=True,
        )
        out = result.stdout.strip()
        return out.startswith("VALID"), out


def test_stub_shape_passes_the_frozen_1ee3b4a4_pin_with_zero_reb_change():
    """ADDENDUM-23's whole point: this shape validates at the CURRENTLY pinned kit/reb - no re-pin needed."""
    stub = build_manifest_stub(SAMPLE_ROW_NO_GAP, SAMPLE_SEGMENTS_NO_GAP, FAKE_RUN_ID)
    is_valid, output = _validate_manifest_at_commit(stub, "1ee3b4a4")
    assert is_valid, f"expected the pinned validator to accept this shape, got: {output}"


def test_stub_missing_source_windows_run_id_fails_the_pin():
    """Sanity: a bare {r2_key}-only shape (the earlier, superseded eb012f45 draft) correctly FAILS at 1ee3b4a4 -
    confirms this test actually exercises the strict check, not a no-op."""
    stub = build_manifest_stub(SAMPLE_ROW_NO_GAP, SAMPLE_SEGMENTS_NO_GAP, FAKE_RUN_ID)
    stub["source_windows"] = [{"r2_key": s["r2_key"]} for s in SAMPLE_SEGMENTS_NO_GAP]
    is_valid, output = _validate_manifest_at_commit(stub, "1ee3b4a4")
    assert not is_valid
    assert "source_windows" in output
