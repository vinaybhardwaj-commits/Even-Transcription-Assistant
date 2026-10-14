"""Reads the raw tape chunk inventory for a (day, room_id) job, unioned across BOTH
~/eta-data/hist/manifest.json and ~/eta-data/hist/manifest_tierC.json (refuter-3 #5193: room_ux92qpws/2026-09-24
exists only in tierC, using a DIFFERENT job_id prefix convention - "c-<day>_<room_id>" vs manifest.json's
"<day>_<room_id>" - so this matches by the (day, room_id) FIELDS in each job record, never by re-deriving/
guessing a job_id string).

reb's #5192 finding: manifest.json is a raw-chunk inventory, upstream of any hist-bulk windowing pass.
refuter-2/refuter-3's #5198/#5199 finding (both independently verified here too - 111 shared chunks, 0 field
mismatches, 0 time-overlaps among the non-shared chunks): the 7 (day, room_id) pairs that appear in BOTH
manifest.json and manifest_tierC.json are NOT competing/conflicting inventories - they're two PARTIAL,
COMPLEMENTARY windowing passes over the same one recording session (manifest.json covers the earlier part of the
day, tierC the later part, with an overlapping stretch in between that is byte-for-byte identical in both files).
The correct behavior is to UNION the chunk lists by r2_key, not pick one tier over the other.

A REAL conflict (raised as HistManifestConflict, never silently resolved) is only:
  (a) the same r2_key with different started_at/ended_at/duration_ms/session_id across manifests, or
  (b) two DIFFERENT r2_keys (from different manifests) whose [started_at, ended_at) time ranges overlap, or
  (c) a different session_id claimed for an overlapping time range.
None of these occur in today's data (verified) - this is a live guard for future data, not a currently-firing one.

ADDENDUM-23 amendment (refuter-2 #5247): the live ~/eta-data/hist/manifest_tierC.json is NOT stable - it was
rewritten mid-study by a running tier-C ingestion job (adding new room-days; its sha changed from c5561681caae to
a645a9d154f5 within the same session), while manifest.json is stable. Hashing a live, actively-growing file as
"content-addressed provenance" is unreproducible by construction. Fixed: DEFAULT_MANIFEST_PATHS now points at
FROZEN local snapshots (~/eta-data/terms/inventory/, copied once, chmod 444, never touching the live files -
they aren't ours to modify) instead of the live ~/eta-data/hist/ files directly. refuter-2 verified all 329
chunk records the 87 staged consults actually use are identical between the live files (at re-check time) and
what was originally staged - no re-staging needed, only the provenance reference.
"""
import json
import os
from datetime import datetime

DEFAULT_MANIFEST_PATHS = (
    os.path.expanduser("~/eta-data/terms/inventory/manifest.json"),
    os.path.expanduser("~/eta-data/terms/inventory/manifest_tierC.json"),
)


class HistManifestConflict(RuntimeError):
    """A real, irreconcilable disagreement between manifests for one (day, room_id) - see module docstring for
    the 3 conditions that trigger this. Merely appearing in more than one manifest is NOT itself a conflict."""


def _parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _fields(c):
    return (c["started_at"], c["ended_at"], c["duration_ms"], c.get("session_id"))


def _check_no_real_conflict(chunks_by_source):
    """chunks_by_source: [(source_path, {r2_key: raw_chunk_dict})]. Raises HistManifestConflict on any of the 3
    real-conflict conditions (module docstring); returns nothing on success."""
    all_by_key = {}  # r2_key -> (source_path, chunk)
    for source, by_key in chunks_by_source:
        for r2_key, chunk in by_key.items():
            if r2_key in all_by_key:
                other_source, other_chunk = all_by_key[r2_key]
                if _fields(chunk) != _fields(other_chunk):
                    raise HistManifestConflict(
                        f"r2_key {r2_key!r} has different fields in {other_source} vs {source}: "
                        f"{other_chunk} vs {chunk}"
                    )
            else:
                all_by_key[r2_key] = (source, chunk)

    # (b)/(c): any two DIFFERENT r2_keys (necessarily from different sources, since within one source's own job
    # the chunks are already a consistent non-overlapping sequence) whose time ranges overlap, or that overlap
    # in time with different session_ids.
    all_chunks = list(all_by_key.values())
    for i in range(len(all_chunks)):
        src_i, c_i = all_chunks[i]
        s_i, e_i = _parse_iso(c_i["started_at"]), _parse_iso(c_i["ended_at"])
        for j in range(i + 1, len(all_chunks)):
            src_j, c_j = all_chunks[j]
            if c_i["r2_key"] == c_j["r2_key"]:
                continue  # already checked above
            s_j, e_j = _parse_iso(c_j["started_at"]), _parse_iso(c_j["ended_at"])
            if s_i < e_j and s_j < e_i:
                raise HistManifestConflict(
                    f"{c_i['r2_key']} ({src_i}, session {c_i.get('session_id')}) overlaps in time with "
                    f"{c_j['r2_key']} ({src_j}, session {c_j.get('session_id')}) - two different chunks claiming "
                    f"the same time range"
                )


def load_chunks_for_job(room_id, day, manifest_paths=DEFAULT_MANIFEST_PATHS):
    """day: "YYYY-MM-DD". -> list of {"r2_key", "started_at", "ended_at", "source_manifest"} (tz-aware datetimes;
    source_manifest is the basename of whichever manifest file this chunk was sourced from - for a chunk present
    in more than one manifest, whichever comes FIRST in `manifest_paths` order, i.e. manifest.json takes
    provenance precedence over manifest_tierC.json for their shared/identical stretch, deterministic since
    duplicates are verified identical in content, ADDENDUM-23), sorted chronologically by started_at (NOT by
    "idx", which is only meaningful within one manifest's own job and can collide across manifests - e.g. both
    manifest.json and manifest_tierC.json restart idx at 0).
    Raises KeyError if no manifest has this (day, room_id).
    Raises HistManifestConflict for a real disagreement (module docstring's 3 conditions) - never silently
    resolved.
    """
    found = []  # [(manifest_path, job), ...]
    for path in manifest_paths:
        if not os.path.exists(path):
            continue
        with open(path) as f:
            manifest = json.load(f)
        for job in manifest.get("jobs", []):
            if job.get("day") == day and job.get("room_id") == room_id:
                found.append((path, job))
    if not found:
        raise KeyError(f"no job for room_id={room_id!r} day={day!r} in any of {manifest_paths}")

    chunks_by_source = [(path, {c["r2_key"]: c for c in job["chunks"]}) for path, job in found]
    _check_no_real_conflict(chunks_by_source)

    union_by_key = {}  # r2_key -> (source_path, chunk) - first source in manifest_paths order wins provenance
    for path, by_key in chunks_by_source:
        for r2_key, chunk in by_key.items():
            if r2_key not in union_by_key:
                union_by_key[r2_key] = (path, chunk)
    ordered = sorted(union_by_key.values(), key=lambda pc: pc[1]["started_at"])
    return [
        {"r2_key": c["r2_key"], "started_at": _parse_iso(c["started_at"]), "ended_at": _parse_iso(c["ended_at"]),
         "source_manifest": os.path.basename(path)}
        for path, c in ordered
    ]
