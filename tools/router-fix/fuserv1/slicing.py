#!/usr/bin/env python3
"""FUSER v1 B1: cut a REB window into fusion slices (design section 2). Cut points come from diar
speaker-turn boundaries when a diar track is available; fall back to VAD (acoustics layer) segment
boundaries otherwise. Each slice is <= MAX_SLICE_MS of CORE span, plus CONTEXT_MS of read-only context
on each side (clipped to the window's own bounds) so the model has surrounding audio to disambiguate a
boundary word, without being asked to transcribe/fuse that context itself.
"""

MAX_SLICE_MS = 45_000
CONTEXT_MS = 5_000


def _boundaries_from_segments(segments: list[dict], window_t0_ms: int, window_t1_ms: int) -> list[int]:
    """Sorted, deduplicated t0/t1 edges of the given segments, always including the window's own
    start/end so the first and last slice reach the window edges even if the segments don't."""
    pts = {window_t0_ms, window_t1_ms}
    for seg in segments:
        t0, t1 = seg.get("t0_ms"), seg.get("t1_ms")
        if t0 is not None:
            pts.add(max(window_t0_ms, min(window_t1_ms, t0)))
        if t1 is not None:
            pts.add(max(window_t0_ms, min(window_t1_ms, t1)))
    return sorted(pts)


def _split_long_gaps(boundaries: list[int], max_slice_ms: int) -> list[int]:
    """Insert extra cut points into any gap between consecutive boundaries that exceeds max_slice_ms,
    so no slice core ever exceeds it even when the turn/VAD-span itself is very long."""
    out = [boundaries[0]]
    for b in boundaries[1:]:
        prev = out[-1]
        span = b - prev
        if span > max_slice_ms:
            n = -(-span // max_slice_ms)  # ceil div
            step = span / n
            out.extend(round(prev + i * step) for i in range(1, n))
        out.append(b)
    return out


def cut_slices(window_t0_ms: int, window_t1_ms: int, diar_segments: list[dict] | None = None,
               vad_segments: list[dict] | None = None, max_slice_ms: int = MAX_SLICE_MS,
               context_ms: int = CONTEXT_MS) -> list[dict]:
    """[{t0_ms, t1_ms, core_t0_ms, core_t1_ms, cut_source}]: t0_ms/t1_ms include context (clipped to
    the window), core_t0_ms/core_t1_ms is the span actually being fused this slice. cut_source is
    "diar" or "vad" (or "window" if neither was available -- one slice, the whole window, split only
    if it exceeds max_slice_ms)."""
    if diar_segments:
        pts, source = _boundaries_from_segments(diar_segments, window_t0_ms, window_t1_ms), "diar"
    elif vad_segments:
        pts, source = _boundaries_from_segments(vad_segments, window_t0_ms, window_t1_ms), "vad"
    else:
        pts, source = [window_t0_ms, window_t1_ms], "window"
    pts = _split_long_gaps(pts, max_slice_ms)
    slices = []
    for core_t0, core_t1 in zip(pts, pts[1:]):
        if core_t1 <= core_t0:
            continue
        slices.append({
            "t0_ms": max(window_t0_ms, core_t0 - context_ms),
            "t1_ms": min(window_t1_ms, core_t1 + context_ms),
            "core_t0_ms": core_t0, "core_t1_ms": core_t1, "cut_source": source,
        })
    return slices
