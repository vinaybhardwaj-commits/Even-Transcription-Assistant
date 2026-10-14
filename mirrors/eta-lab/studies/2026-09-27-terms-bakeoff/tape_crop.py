"""W50 set (c): plan how to crop+concatenate raw tape chunks into one consult span, and detect real tape gaps.

Pure planning logic (no audio decoding, no filesystem access) - given the union of tape chunks covering a
room-day (from one or more hist-bulk run jsons' `cut.chunks_used`) and a consult's already-padded `span`
(ADDENDUM-2 G1: `links.jsonl`'s span is `called_at-30s..completed_at+30s`), returns one of THREE distinct
outcomes (refuter-3 #5193: "no_tape_in_span" must be told apart from a genuine recording gap - a confirmed/probable
link with literally no tape overlapping its claimed call time is a possible LINKER error, worth a human glancing
at it, not the same signal as a real mid-recording dropout):
  - status="ok": an ordered list of non-overlapping (r2_key, local_start_s, local_end_s, source_manifest)
    segments to decode and concatenate - source_manifest (ADDENDUM-23) is passed through from each input chunk
    dict (hist_manifest.py sets it), used to build set (c)'s manifest_stub's per-segment source_windows entries.
  - status="tape_gap": at least one chunk overlaps the span, but the union of coverage doesn't fully cover it
    (tolerance <=2s for chunk-boundary rounding, ADDENDUM-2 G1) - the consult is DROPPED, not fed
    partial/discontinuous audio to any engine.
  - status="no_tape_in_span": ZERO chunks overlap the span at all, even though this room-day has SOME tape
    inventory (distinct from hist_manifest.py's KeyError, which means the room-day has NO inventory whatsoever).
"""
from datetime import timedelta

GAP_TOLERANCE_S = 2.0  # ADDENDUM-2 G1: gaps <=2s are chunk-boundary rounding, not a real gap


def plan_crop(chunks, span_start, span_end, gap_tolerance_s=GAP_TOLERANCE_S):
    """chunks: iterable of {"r2_key", "started_at", "ended_at"} (tz-aware datetimes; any order; may include
    duplicates/overlaps, e.g. from unioning multiple hist-bulk windows' chunks_used).
    -> {"status": "ok", "segments": [...]} / {"status": "tape_gap", "reason": "..."} /
       {"status": "no_tape_in_span", "reason": "..."} - see module docstring."""
    if span_end <= span_start:
        raise ValueError(f"span_end {span_end} must be after span_start {span_start}")

    # Dedup by r2_key (a chunk can appear in more than one overlapping hist-bulk window's chunks_used).
    by_key = {}
    for c in chunks:
        by_key[c["r2_key"]] = c
    overlapping = [
        c for c in by_key.values()
        if c["ended_at"] > span_start and c["started_at"] < span_end
    ]
    overlapping.sort(key=lambda c: c["started_at"])

    if not overlapping:
        return {
            "status": "no_tape_in_span",
            "reason": f"0 of {len(by_key)} chunks for this room-day overlap [{span_start.isoformat()}, "
                      f"{span_end.isoformat()}]",
        }

    tolerance = timedelta(seconds=gap_tolerance_s)
    segments = []
    covered_until = span_start
    for c in overlapping:
        chunk_start = max(c["started_at"], span_start)
        chunk_end = min(c["ended_at"], span_end)
        if chunk_start > covered_until + tolerance:
            return {
                "status": "tape_gap",
                "reason": f"gap of {(chunk_start - covered_until).total_seconds():.1f}s before "
                          f"{c['r2_key']} (covered up to {covered_until.isoformat()}, "
                          f"next chunk starts {chunk_start.isoformat()})",
            }
        if chunk_end <= covered_until:
            continue  # fully redundant with what's already covered - skip, don't emit a zero/negative segment
        # Trim the start to avoid re-decoding/duplicating time already covered by the previous segment.
        effective_start = max(chunk_start, covered_until)
        local_start_s = (effective_start - c["started_at"]).total_seconds()
        local_end_s = (chunk_end - c["started_at"]).total_seconds()
        segments.append({
            "r2_key": c["r2_key"], "local_start_s": local_start_s, "local_end_s": local_end_s,
            "source_manifest": c.get("source_manifest"),  # ADDENDUM-23: which inventory file this chunk came from
        })
        covered_until = chunk_end

    if covered_until < span_end - tolerance:
        return {
            "status": "tape_gap",
            "reason": f"trailing gap of {(span_end - covered_until).total_seconds():.1f}s "
                      f"(covered up to {covered_until.isoformat()}, span ends {span_end.isoformat()})",
        }
    # `overlapping` is non-empty here (the early no_tape_in_span check above), and the first overlapping chunk
    # always yields >=1 segment (its chunk_end must exceed span_start), so `segments` is guaranteed non-empty.
    return {"status": "ok", "segments": segments}
