#!/usr/bin/env python3
"""FUSER v1 B1: stable per-track token IDs "k:s:i" (track index, segment index, token index) with
t0/t1, from REB track segments. Uses the engine's own word-level times when a segment provides
`words` (REB-SPEC-v1.md section 2's schema); otherwise interpolates evenly across the segment's own
span and marks each token `interp: True` (design L4/section 2: never claim precision an engine didn't
give). Track index k is assigned by the caller (a stable position in whatever track list it built for
the slice), not derived here -- this module only tokenizes ONE track's segments at a time.
"""


def tokenize_track(track_index: int, segments: list[dict]) -> list[dict]:
    """[{id, text, t0_ms, t1_ms, interp, seg_index}] flattened across every segment of one track.
    A segment with no text contributes nothing (an empty/refused segment has no tokens to cite)."""
    out = []
    for s_idx, seg in enumerate(segments):
        words = seg.get("words")
        if words:
            for i, w in enumerate(words):
                out.append({"id": f"{track_index}:{s_idx}:{i}", "text": w.get("w", ""),
                           "t0_ms": w.get("t0_ms"), "t1_ms": w.get("t1_ms"),
                           "interp": w.get("t0_ms") is None or w.get("t1_ms") is None,
                           "seg_index": s_idx})
            continue
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        toks = text.split()
        t0, t1 = seg.get("t0_ms"), seg.get("t1_ms")
        if t0 is None or t1 is None or t1 <= t0 or not toks:
            # can't interpolate without a real span; still emit tokens, just with no times.
            for i, w in enumerate(toks):
                out.append({"id": f"{track_index}:{s_idx}:{i}", "text": w, "t0_ms": None, "t1_ms": None,
                           "interp": True, "seg_index": s_idx})
            continue
        step = (t1 - t0) / len(toks)
        for i, w in enumerate(toks):
            out.append({"id": f"{track_index}:{s_idx}:{i}", "text": w,
                       "t0_ms": round(t0 + i * step), "t1_ms": round(t0 + (i + 1) * step),
                       "interp": True, "seg_index": s_idx})
    # ADDENDUM-6: V4 needs to know what language whisper-auto detected for each token's own segment.
    for tok in out:
        lid = (segments[tok["seg_index"]].get("extras") or {}).get("lid") or {}
        tok["lid_detected"] = lid.get("detected")
    return out


def tokenize_tracks(tracks: dict[int, list[dict]]) -> dict[str, dict]:
    """{token_id: token} across several tracks, tracks given as {track_index: segments}."""
    flat = {}
    for k, segments in tracks.items():
        for tok in tokenize_track(k, segments):
            flat[tok["id"]] = tok
    return flat


def is_monotone(token_ids: list[str], flat: dict[str, dict]) -> bool:
    """V1's monotone check: within ONE track (same k), cited token indices must be non-decreasing in
    (seg_index, i) order -- catches a reference sequence that jumps backward within its own track."""
    by_track: dict[str, list[tuple]] = {}
    for tid in token_ids:
        k, s, i = tid.split(":")
        by_track.setdefault(k, []).append((int(s), int(i)))
    return all(seq == sorted(seq) for seq in by_track.values())
