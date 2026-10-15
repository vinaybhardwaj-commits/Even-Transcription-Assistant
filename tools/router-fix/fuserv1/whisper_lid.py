#!/usr/bin/env python3
"""FUSER v1 B1: whisper p(en) and top-3 languages per slice, against lid-debug's proposed REB
whisper-writer convention (#4735, no writer built yet -- this is the extraction side, reb owns the
runner/writer side): per segment, extras.lid = {"detected": <code>, "p": <prob>,
"probs": {<code>: p, ...}, "scored_ms": [t0, min(t1, t0+30000)]} (whisper.cpp's LID only scores the
first 30s of whatever audio it's given, #4735 point 1). Missing codes in `probs` mean < 0.001, treated
as 0.0 (#4735 point 4). No segment in the slice carries LID at all -> p_en is None ("unknown", the
same posture as the router's own gate: unknown is not English).
"""


def slice_p_en(segments: list[dict], slice_t0_ms: int, slice_t1_ms: int) -> float | None:
    """Duration-weighted mean of probs.get("en", 0.0) over segments (with a `lid` extras block)
    overlapping [slice_t0_ms, slice_t1_ms). None if no overlapping segment carries LID at all."""
    total = _weighted_sum(segments, slice_t0_ms, slice_t1_ms, lambda probs: probs.get("en", 0.0))
    return total


def slice_top_languages(segments: list[dict], slice_t0_ms: int, slice_t1_ms: int,
                        top_n: int = 3) -> list[tuple[str, float]]:
    """[(code, duration_weighted_mean_prob), ...] sorted highest first, top_n entries. [] if no
    overlapping segment carries LID."""
    weight, sums = 0.0, {}
    for seg in segments:
        lid = (seg.get("extras") or {}).get("lid")
        if not lid:
            continue
        s0, s1 = seg.get("t0_ms"), seg.get("t1_ms")
        if s0 is None or s1 is None:
            continue
        overlap = min(s1, slice_t1_ms) - max(s0, slice_t0_ms)
        if overlap <= 0:
            continue
        weight += overlap
        for code, p in (lid.get("probs") or {}).items():
            sums[code] = sums.get(code, 0.0) + p * overlap
    if weight == 0.0:
        return []
    means = [(code, round(total / weight, 4)) for code, total in sums.items()]
    means.sort(key=lambda x: (-x[1], x[0]))
    return means[:top_n]


def _weighted_sum(segments, slice_t0_ms, slice_t1_ms, extract) -> float | None:
    weight, total = 0.0, 0.0
    for seg in segments:
        lid = (seg.get("extras") or {}).get("lid")
        if not lid:
            continue
        s0, s1 = seg.get("t0_ms"), seg.get("t1_ms")
        if s0 is None or s1 is None:
            continue
        overlap = min(s1, slice_t1_ms) - max(s0, slice_t0_ms)
        if overlap <= 0:
            continue
        weight += overlap
        total += extract(lid.get("probs") or {}) * overlap
    return round(total / weight, 4) if weight > 0 else None
