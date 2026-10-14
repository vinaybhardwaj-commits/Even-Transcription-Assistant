#!/usr/bin/env python3
"""Box-side collector for REB's emotion layer: reads hf_emotion_job.py's out.jsonl (scored turns) (pulled back from
the HF Job by whoever runs it — hf-fleet's own `hf buckets cp`/collect step, same shape as
studies/2026-09-25-speaker-labels/hf/hf_run.py's `collect`), verifies it covers every window in the
manifest that was sent, and commits each track via reb.writer.write_track(). This is the ONLY script
in this pair that calls write_track() — kit/reb_runner/DESIGN.md #2: "the box is the SOLE process
that calls write_track()"; hf_emotion_job.py (HF side) only ever computes and hands back a result.

    python3 hf_emotion_collect.py windows_turns_26sep.json out.jsonl

A window missing from out.jsonl, flagged missing_audio, or with an unscored scoreable turn is counted
"incomplete", named, and NOT written (a later run can still fill it); every other window is written.
Exits 1 if any window was incomplete.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reb.writer import MirrorPendingError, TrackExistsError, write_track
from reb_runner.engines import emotion_wavlm


def track_from_scores(w, rec):
    """Builds the REB emotion track for one manifest window from the HF job's scored turns. A turn the
    job marked skipped (no audio) becomes a segment with extras.skipped_no_audio. A scoreable turn the
    job said nothing about raises KeyError: the caller counts that window incomplete and writes nothing,
    rather than committing a track with a hole (tracks are append-only)."""
    def value(t):
        if t.get("skipped") == "no_audio":
            return None
        if t.get("skipped"):
            return {"skipped": t["skipped"]}
        return {"label": t["label"], "scores": t["scores"]}

    scored = {(t["t0_ms"], t["t1_ms"]): value(t) for t in rec["turns"]}
    cur = {}

    def slice_fn(_wav, t0_ms, t1_ms):
        cur["k"] = (t0_ms, t1_ms)
        return _wav

    def score_fn(_model, _clip):
        return scored[cur["k"]]

    segs = [{"t0_ms": a, "t1_ms": b, "speaker": sp} for a, b, sp in w["turns"]]
    return emotion_wavlm.build_track(w["window_id"], "", w["t0_ms"], w["t1_ms"], diar_segments=segs,
                                     slice_fn=slice_fn, score_fn=score_fn)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("results", help="hf_emotion_job.py's out.jsonl (scored turns)")
    ap.add_argument("--root", default=None)
    args = ap.parse_args()

    import reb as reb_pkg
    root = args.root or reb_pkg.reb.DEFAULT_ROOT

    manifest = {w["window_id"]: w for w in json.load(open(args.manifest))}
    results = {}
    with open(args.results) as f:
        for line in f:
            try:
                rec = json.loads(line)
                results[rec["window_id"]] = rec
            except (ValueError, KeyError):
                pass  # truncated/blank line: that window counts as incomplete below

    written = skipped = mirror_pending = 0
    incomplete = []
    for window_id, w in manifest.items():
        rec = results.get(window_id)
        if rec is None or rec.get("missing_audio"):
            incomplete.append(window_id)
            continue
        try:
            track = track_from_scores(w, rec)
        except KeyError:
            incomplete.append(window_id)
            continue
        try:
            write_track(root, w["ist_date"], w["room_id"], window_id, track, manifest_stub=w["manifest_stub"])
            written += 1
        except TrackExistsError:
            skipped += 1  # already committed by an earlier partial run of this same collect
        except MirrorPendingError:
            mirror_pending += 1  # local write IS durable; R2 mirror needs a separate retry (see writer.py)
    print(f"[hf-emotion-collect] {args.manifest}: written={written} skipped(exists)={skipped} "
          f"mirror_pending={mirror_pending} incomplete={len(incomplete)} of {len(manifest)} windows")
    if incomplete:
        print(f"[hf-emotion-collect] incomplete (not written, no/partial job output): {sorted(incomplete)}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
