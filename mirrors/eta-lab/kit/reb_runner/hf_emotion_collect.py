#!/usr/bin/env python3
"""Box-side collector for REB's emotion layer: reads hf_emotion_job.py's out.jsonl (pulled back from
the HF Job by whoever runs it — hf-fleet's own `hf buckets cp`/collect step, same shape as
studies/2026-09-25-speaker-labels/hf/hf_run.py's `collect`), verifies it covers every window in the
manifest that was sent, and commits each track via reb.writer.write_track(). This is the ONLY script
in this pair that calls write_track() — kit/reb_runner/DESIGN.md #2: "the box is the SOLE process
that calls write_track()"; hf_emotion_job.py (HF side) only ever computes and hands back a result.

    python3 hf_emotion_collect.py windows_turns_26sep.json out.jsonl

Exits non-zero (and writes nothing) if any window in the manifest is missing from out.jsonl — same
"NOT VERIFIED: nothing written" discipline as hf_run.py's collect, so a partial/truncated pull-back
can never silently commit an incomplete day.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reb.writer import MirrorPendingError, TrackExistsError, write_track


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("results", help="hf_emotion_job.py's out.jsonl")
    ap.add_argument("--root", default=None)
    args = ap.parse_args()

    import reb as reb_pkg
    root = args.root or reb_pkg.reb.DEFAULT_ROOT

    manifest = {w["window_id"]: w for w in json.load(open(args.manifest))}
    results = {}
    with open(args.results) as f:
        for line in f:
            line = line.strip()
            if line:
                rec = json.loads(line)
                results[rec["window_id"]] = rec["track"]

    missing = set(manifest) - set(results)
    if missing:
        sys.exit(f"NOT VERIFIED: {len(missing)}/{len(manifest)} windows missing from {args.results} "
                  f"(first few: {sorted(missing)[:5]}) — nothing written")

    written = skipped = mirror_pending = 0
    for window_id, w in manifest.items():
        track = results[window_id]
        try:
            write_track(root, w["ist_date"], w["room_id"], window_id, track, manifest_stub=w["manifest_stub"])
            written += 1
        except TrackExistsError:
            skipped += 1  # already committed by an earlier partial run of this same collect
        except MirrorPendingError:
            mirror_pending += 1  # local write IS durable; R2 mirror needs a separate retry (see writer.py)
    print(f"[hf-emotion-collect] {args.manifest}: written={written} skipped(exists)={skipped} "
          f"mirror_pending={mirror_pending} of {len(manifest)} windows")


if __name__ == "__main__":
    sys.exit(main())
