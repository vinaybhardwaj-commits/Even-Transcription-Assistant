#!/usr/bin/env python3
"""PROPOSED transport: hist-bulk's windows-reb manifest -> REB window manifest_stub + acoustics
track, via kit/reb/writer.write_track. Runs against a SCRATCH REB root only (--root), never the
live one (~/eta-data/reb) — hist-bulk's [BACKFILL] itself flagged this mapping as unnamed/unsettled,
so this is a proposal to confirm with Fable/reb/hist-bulk, not a live write.

Open questions this makes concrete (need a ruling before any live write):
  - r2_key: hist-bulk's window is stitched from >=1 source chunks (cut.chunk_keys); REB's audio
    schema wants exactly one r2_key. Proposed here: chunk_keys[0] (the first/primary source chunk),
    with the full chunk_keys list kept under config.extras for provenance — NOT dropped.
  - duration_ms: proposed as the nominal window length (cut.duration_s*1000, e.g. 900000 for a
    15-min window), not the covered/real-audio duration (cut.covered_fraction*duration_s*1000),
    since REB's audio.duration_ms elsewhere means the window span, not speech coverage.
  - sample_rate: 48000, per hist-bulk's stated cut_window.py recipe (not embedded in their manifest).
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO_ROOT)
from kit.reb import validate as reb_validate  # noqa: E402
from kit.reb import writer as reb_writer  # noqa: E402
from kit.reb.writer import TrackExistsError  # noqa: E402

LIVE_ROOT = os.path.expanduser("~/eta-data/reb")

sys.path.insert(0, os.path.dirname(__file__))
from acoustics_layer import compute_acoustics, to_track, CONFIG  # noqa: E402
import acoustics_layer as al  # noqa: E402

ROOM_SLUGS = {  # studies/2026-09-27-room-acoustics/aggregate.py's ROOMS table
    "room_yh3etjpf": "OPD 1", "room_87frpus9": "OPD 3", "room_ux92qpws": "OPD 4",
    "room_4ggnkg5x": "OPD 5", "room_pnyc9u49": "OPD 6", "room_qyzghzaf": "OPD 7",
    "room_d74hhmc4": "Third Floor", "room_bh6jtq4t": "Cardiology",
    "room_ymch4bxu": "Room 4-1 (after cards, before 5)", "room_jwyrr4dc": "ORB3",
}


sys.path.insert(0, os.path.expanduser("~/eta-data/drtpqma"))
import heldout  # noqa: E402  (import failure = crash = fail closed)

IST = timezone(timedelta(hours=5, minutes=30))


def is_blind(union, entry):
    t0, t1 = datetime.fromisoformat(entry["start"]), datetime.fromisoformat(entry["end"])
    if t0.tzinfo is None or t1.tzinfo is None:
        raise ValueError(f"tz-naive start/end for {entry.get('win_id')}: refusing (fail closed)")
    t0 = t0.astimezone(timezone.utc)
    t1 = t1.astimezone(timezone.utc) - timedelta(seconds=1)
    return any(heldout.is_held_out(union, d, entry["room"])
               for d in {t0.astimezone(IST).date().isoformat(), t1.astimezone(IST).date().isoformat()})


def epoch_ms(iso):
    return int(datetime.fromisoformat(iso).astimezone(timezone.utc).timestamp() * 1000)


def to_manifest_stub(entry):
    cut = entry["cut"]
    return {
        "window_id": entry["win_id"], "room_id": entry["room"],
        "room_slug": ROOM_SLUGS.get(entry["room"], entry["room"]),
        "ist_date": entry["ist_date"],
        "t0_ms": epoch_ms(entry["start"]), "t1_ms": epoch_ms(entry["end"]),
        "audio": {
            "r2_key": cut["chunk_keys"][0], "sha256": entry["sha256"],
            "sample_rate": 48000, "duration_ms": int(cut["duration_s"] * 1000),
            "extras": {"all_chunk_keys": cut["chunk_keys"], "covered_fraction": cut["covered_fraction"],
                       "n_chunks": cut["n_chunks"]},
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest_jsonl")
    ap.add_argument("--root", default=LIVE_ROOT)
    ap.add_argument("--live", action="store_true",
                     help="required to write to the live REB root (Fable [REB-UNBLOCK NOW], "
                          "self-contained per that order — see module docstring for the r2_key/"
                          "duration_ms convention this commits to)")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    if os.path.abspath(a.root) == os.path.abspath(LIVE_ROOT) and not a.live:
        sys.exit("refusing to write to the live REB root without --live (use --root for a scratch "
                 "dir instead, or pass --live to confirm)")
    os.makedirs(a.root, exist_ok=True)

    entries = [json.loads(l) for l in open(a.manifest_jsonl)]
    if a.limit:
        entries = entries[: a.limit]

    union, union_sha = heldout.load_union()
    n_manifest_ok = n_track_ok = n_written = n_skipped = n_blind = 0
    for entry in entries:
        if is_blind(union, entry):
            n_blind += 1
            print("BLIND SKIP (R3/W51)", entry["win_id"])
            continue
        stub = to_manifest_stub(entry)
        errs = reb_validate.validate_manifest(stub, raise_on_error=False)
        if errs:
            print("MANIFEST INVALID", entry["win_id"], errs)
            continue
        n_manifest_ok += 1

        # compute_acoustics() does os.path.join(TAPES, rec["path"]); since hist-bulk's audio field
        # is already an absolute path, os.path.join discards TAPES and uses it as-is.
        m = compute_acoustics({"id": entry["win_id"], "room_id": entry["room"],
                                "started_at": entry["start"], "path": entry["audio"]})
        track = to_track(m, entry["win_id"])
        terrs = reb_validate.validate_track(track, raise_on_error=False)
        if terrs:
            print("TRACK INVALID", entry["win_id"], terrs)
            continue
        n_track_ok += 1

        try:
            path = reb_writer.write_track(a.root, entry["ist_date"], entry["room"], entry["win_id"],
                                           track, manifest_stub=stub)
        except TrackExistsError:
            n_skipped += 1
            continue
        n_written += 1
        print("wrote", entry["win_id"], "->", os.path.relpath(path, a.root))

    mode = "LIVE" if a.live else "scratch"
    print(f"\nDONE transport ({mode} root={a.root}): {len(entries)} entries, "
          f"manifest_ok={n_manifest_ok} track_ok={n_track_ok} written={n_written} "
          f"already_written={n_skipped} blind_skipped={n_blind} union={union_sha}")


if __name__ == "__main__":
    main()
