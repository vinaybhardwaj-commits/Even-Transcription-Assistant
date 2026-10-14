"""W50 set (c): window list + manifest_stub construction from the staged decode manifest
(~/eta-data/terms/setc-stage/manifest.jsonl, decode_set_c_audio.stage_all's output).

Settled shape (bus #5227/#5239, ADDENDUM-23, superseding this module's earlier ed800d9e-based draft, eb012f45 -
see #5242's timing-crossed-messages flag): kit/reb STAYS PINNED at 1ee3b4a4 (ADDENDUM-9), no re-pin. `dev_clip`'s
`source_windows` at 1ee3b4a4 strictly requires `{run_id, window_id}` per entry (confirmed by reading validate.py
directly) - so this uses a content-addressed SYNTHETIC run_id that honestly says "this is not a real hist-bulk
run": `run_id = "hist-inventory@<sha256(manifest.json)[:12]>+<sha256(manifest_tierC.json)[:12]>"`, pinning the
exact raw-chunk inventory the crop was built from, with `window_id = r2_key` (the actual chunk) plus
`local_start_s`/`local_end_s`/`source_manifest` per entry - one entry per crop segment, in order. Verified nothing
in the codebase dereferences `source_windows` as a real hist-bulk run lookup (refuter-2 #5228), so this is honest,
inspectable provenance, not a shape gamed just to pass validation.

The staged manifest.jsonl (already decoded) only records a flat `source_chunk_keys` list per consult, not each
segment's local_start_s/local_end_s/source_manifest - so this module re-derives the full per-segment detail via a
fresh `build_set_c_crop_plan.build_plan()` call (pure/no I/O beyond reading links.jsonl/manifest*.json, cheap),
joined to the staged manifest by consult_id, rather than only using what's already staged.

ADDENDUM-23 amendment (refuter-2 #5247): HIST_MANIFEST_PATHS points at the FROZEN local inventory snapshots
(~/eta-data/terms/inventory/, see hist_manifest.py's module docstring) - the live ~/eta-data/hist/manifest_tierC.json
is not stable (rewritten mid-study by a running ingestion job), so hashing it directly for run_id would be
unreproducible. Today's frozen shas: manifest.json 50469e03c069, manifest_tierC.json a645a9d154f5 (corrects
ADDENDUM-23's original c5561681caae, which named a live-file version already gone by the time of recheck).
"""
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone

from build_set_c_crop_plan import build_plan
from hist_manifest import DEFAULT_MANIFEST_PATHS as HIST_MANIFEST_PATHS

IST = timezone(timedelta(hours=5, minutes=30))


def ist_date_from_iso(span_start_iso):
    """refuter-3 #5260 nit: today's spans all carry a +05:30 offset, so naive string-slicing (span_start[:10])
    happens to give the right IST date - but that would silently be WRONG (off by a day near midnight) for a
    span ever recorded in UTC or another offset. Parse and convert to IST explicitly instead, so this is correct
    regardless of the source string's own offset."""
    return datetime.fromisoformat(span_start_iso).astimezone(IST).strftime("%Y-%m-%d")

DEFAULT_STAGED_MANIFEST_PATH = os.path.expanduser("~/eta-data/terms/setc-stage/manifest.jsonl")
GAP_EPSILON_S = 1e-6  # float-compare tolerance for "did this consult have a tolerated gap at all"


def _sha256_file_prefix(path, n=12):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:n]


def inventory_run_id(hist_manifest_paths=HIST_MANIFEST_PATHS):
    """-> "hist-inventory@<sha12>+<sha12>...", one <sha12> per existing path in hist_manifest_paths, in order.
    Content-addressed, so a future change to either inventory file produces a visibly different run_id - never
    silently stale."""
    prefixes = [_sha256_file_prefix(p) for p in hist_manifest_paths if os.path.exists(p)]
    if not prefixes:
        raise FileNotFoundError(f"none of {hist_manifest_paths} exist - can't build an inventory run_id")
    return "hist-inventory@" + "+".join(prefixes)


def load_staged_manifest(path=DEFAULT_STAGED_MANIFEST_PATH):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def build_source_windows(segments, run_id):
    """segments: tape_crop.plan_crop's ordered [{"r2_key", "local_start_s", "local_end_s", "source_manifest"},
    ...] for one consult. -> the source_windows list per ADDENDUM-23's settled shape, one entry per segment."""
    return [
        {
            "run_id": run_id, "window_id": seg["r2_key"],
            "local_start_s": seg["local_start_s"], "local_end_s": seg["local_end_s"],
            "source_manifest": seg["source_manifest"],
        }
        for seg in segments
    ]


def build_manifest_stub(staged_row, segments, run_id, audio_file=None):
    """staged_row: one row from the staged decode manifest (decode_set_c_audio.stage_consult's shape).
    segments: this consult's crop-plan segments (for source_windows' full per-segment detail).
    -> a manifest_stub dict for kit/reb's write_track() first-call seed, source_kind="dev_clip", validating at
    the FROZEN 1ee3b4a4 pin (no reb change needed - proven in test_build_windows_set_c.py).
    clock (refuter-2/refuter-3's settled (c)): "approx" if the consult's crop had a tolerated (<=2s,
    ADDENDUM-2 G1) gap (span_duration_s > segment_sum_duration_s, both already in the staged row - D1 fix), else
    "tape_utc"."""
    consult_id = staged_row["consult_id"]
    audio_file = audio_file or f"{consult_id}.wav"
    had_tolerated_gap = staged_row["span_duration_s"] > staged_row["segment_sum_duration_s"] + GAP_EPSILON_S
    clock = "approx" if had_tolerated_gap else "tape_utc"
    duration_ms = round(staged_row["decoded_duration_s"] * 1000)
    ist_date = ist_date_from_iso(staged_row["span_start"])
    return {
        "window_id": consult_id, "room_id": staged_row["room_id"], "room_slug": staged_row["room_id"],
        "ist_date": ist_date, "t0_ms": 0, "t1_ms": duration_ms,
        "audio": {
            "r2_key": f"w50-setc-2026-09-28/{audio_file}",  # Fable's ruling: this bucket/prefix, exactly
            "sha256": staged_row["sha256"], "sample_rate": staged_row["sample_rate"], "duration_ms": duration_ms,
        },
        "source_kind": "dev_clip",
        "clock": clock,
        "source_windows": build_source_windows(segments, run_id),
    }


DURATION_MATCH_TOLERANCE_S = 0.001  # 1ms - both checkers' #5257/#5258 ask


def _assert_plan_matches_staged(row, segments):
    """refuter-2 #5257 / refuter-3 #5258: the build-time guard previously only checked that a staged consult was
    still present ('ok') in a fresh crop plan - not that the plan's CONTENT still matches what was actually
    decoded and staged. Raises ValueError (never silently proceeds) if either check fails - this is what ties
    the manifest_stub's provenance claims to the audio that was actually staged."""
    consult_id = row["consult_id"]
    plan_keys = [seg["r2_key"] for seg in segments]
    staged_keys = row["source_chunk_keys"]
    if plan_keys != staged_keys:
        raise ValueError(
            f"{consult_id}: fresh crop plan's chunk keys {plan_keys} != staged manifest's source_chunk_keys "
            f"{staged_keys} - the inventory changed since staging; re-stage before proceeding, don't guess"
        )
    plan_sum = sum(seg["local_end_s"] - seg["local_start_s"] for seg in segments)
    staged_sum = row["segment_sum_duration_s"]
    if abs(plan_sum - staged_sum) > DURATION_MATCH_TOLERANCE_S:
        raise ValueError(
            f"{consult_id}: fresh crop plan's segment-sum duration {plan_sum:.6f}s != staged manifest's "
            f"{staged_sum:.6f}s (diff {abs(plan_sum - staged_sum):.6f}s > {DURATION_MATCH_TOLERANCE_S}s "
            f"tolerance) - the inventory changed since staging; re-stage before proceeding, don't guess"
        )


def build_windows_set_c(staged_manifest_path=DEFAULT_STAGED_MANIFEST_PATH,
                         hist_manifest_paths=HIST_MANIFEST_PATHS):
    """-> list of {"window_id", "audio_file", "room_id", "ist_date", "manifest_stub"} - same top-level shape
    build_windows_set_b.py produces for the scored launcher's WINDOWS env var. Raises KeyError if a staged
    consult's segments can't be found at all in a fresh crop-plan build, or ValueError if they're found but
    don't match what was staged (_assert_plan_matches_staged) - either way, a real mismatch here means the
    underlying inventory changed since staging, worth surfacing loudly, never silently guessed past."""
    run_id = inventory_run_id(hist_manifest_paths)
    staged_rows = load_staged_manifest(staged_manifest_path)
    plan_results, _excluded = build_plan()
    segments_by_consult = {r["consult_id"]: r["segments"] for r in plan_results if r["status"] == "ok"}

    windows = []
    for row in staged_rows:
        consult_id = row["consult_id"]
        if consult_id not in segments_by_consult:
            raise KeyError(
                f"{consult_id} is in the staged manifest but not in a fresh 'ok' crop plan - the underlying "
                f"inventory may have changed since staging; re-stage before proceeding, don't guess"
            )
        segments = segments_by_consult[consult_id]
        _assert_plan_matches_staged(row, segments)
        stub = build_manifest_stub(row, segments, run_id)
        ist_date = ist_date_from_iso(row["span_start"])
        windows.append({
            "window_id": consult_id, "audio_file": f"{consult_id}.wav",
            "room_id": row["room_id"], "ist_date": ist_date,
            "manifest_stub": stub,
        })
    return windows


if __name__ == "__main__":
    import sys
    windows = build_windows_set_c()
    print(f"# {len(windows)} set (c) windows, run_id={inventory_run_id()!r}", file=sys.stderr)
    print(json.dumps(windows, indent=1))
