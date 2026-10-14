#!/usr/bin/env python3
"""337e core (diar-lab): speaker labels per transcript segment. Pure functions, no I/O, no audio, no text.
Clocks: transcript segments use the WALL clock relative to their window start (recording gaps kept as silence, `cut.gap_s`). Production diarization (pyannote.ai, local 3.1) ran on GAP-CLOSED
audio (bench-join), so its turns must be mapped to the wall clock through the window's chunk list BEFORE any join (closed_to_wall). Nemotron run on the hist-cut audio is already on the wall clock.
"""
from itertools import permutations

MIN_SPEECH_S = 1.0        # a segment with < 1.0 s of diarized speech (any speaker) is 'unlabeled' (pilot 25 Sep: most transcript segments are fixed ~30 s blocks with pauses, so a fraction-of-duration rule rejects real speech)
MIXED_SECOND = 0.30       # a second speaker holding >= 30% of the segment's diarized speech (and >= 2 s) marks it 'mixed'


def chunk_axis(chunks, win_start, win_end):
    """chunks: [(start, end)] wall seconds (any origin, same as win_start/win_end). Returns [(wall_a, wall_b, closed_a)] for each chunk trimmed to the window, in wall order; closed_a = the
    cumulative duration of the earlier chunks = where this chunk starts on the GAP-CLOSED axis."""
    out, acc = [], 0.0
    for a, b in sorted(chunks):
        a, b = max(a, win_start), min(b, win_end)
        if b <= a: continue
        out.append((a, b, acc)); acc += b - a
    return out


def closed_to_wall(turns, axis, win_start):
    """turns: [(t0, t1, spk)] in CLOSED-axis seconds from the window's first covered sample. Returns wall-clock turns [(w0, w1, spk)] relative to win_start; a turn straddling a chunk join is split at
    the join and the gap between chunks is excluded (nothing is spoken 'in' a recording gap)."""
    out = []
    for t0, t1, spk in turns:
        for wa, wb, ca in axis:
            cb = ca + (wb - wa)
            lo, hi = max(t0, ca), min(t1, cb)
            if hi > lo: out.append((wa - win_start + (lo - ca), wa - win_start + (hi - ca), spk))
    return sorted(out)


def letters(turns):
    """speaker id -> 'A','B',... by first appearance in the window (NOT stable across windows). >26 speakers -> 'S27'..."""
    order = []
    for _, _, spk in sorted(turns):
        if spk not in order: order.append(spk)
    return {spk: (chr(65 + i) if i < 26 else f"S{i + 1}") for i, spk in enumerate(order)}


def _overlap(a0, a1, b0, b1): return max(0.0, min(a1, b1) - max(a0, b0))


def assign(segments, turns):
    """segments: [(start_s, end_s)] wall-relative; turns: [(start_s, end_s, spk)] wall-relative. Per segment: speech = union of all turns' overlap (seconds); unlabeled if speech < MIN_SPEECH_S.
    Else the dominant speaker by overlap seconds, `purity` = dominant / total per-speaker overlap, `mixed` if the second speaker holds >= MIXED_SECOND of the diarized speech and >= 2 s, and `sequence` = the
    speaker letters in time order within the segment (consecutive repeats merged, max 6) so a multi-speaker block can be shown as 'A > B > A' instead of one false label (transcript segments carry no word times).
    Returns dicts {idx, speaker, purity, speech_s, coverage, unlabeled, mixed, sequence}."""
    lm = letters(turns); out = []
    for i, (s0, s1) in enumerate(segments):
        dur = max(s1 - s0, 1e-9); per, iv = {}, []
        for t0, t1, spk in sorted(turns):
            o = _overlap(s0, s1, t0, t1)
            if o > 0: per[spk] = per.get(spk, 0.0) + o; iv.append((max(s0, t0), min(s1, t1), spk))
        u, cur = 0.0, None
        for a_, b_, _ in sorted(iv):
            if cur is None or a_ > cur[1]:
                if cur: u += cur[1] - cur[0]
                cur = [a_, b_]
            else: cur[1] = max(cur[1], b_)
        if cur: u += cur[1] - cur[0]
        ranked = sorted(per.items(), key=lambda kv: -kv[1]); tot = sum(per.values())
        unl = u < MIN_SPEECH_S or not ranked
        seq = []
        for _, _, spk in sorted(iv, key=lambda x: x[0]):
            if not seq or seq[-1] != lm[spk]: seq.append(lm[spk])
        second = ranked[1][1] if len(ranked) > 1 else 0.0
        out.append(dict(idx=i, speaker=None if unl else lm[ranked[0][0]], purity=round(ranked[0][1] / tot, 3) if ranked else 0.0, speech_s=round(u, 2), coverage=round(min(u / dur, 1.0), 3),
                        unlabeled=unl, mixed=(not unl) and second >= 2.0 and second / tot >= MIXED_SECOND, sequence=[] if unl else seq[:6]))
    return out


def agreement(labels_a, labels_b, weights=None):
    """Segment-level agreement of two labelings of the SAME segments (speaker letters or None), after the best one-to-one relabelling of B onto A (brute force, <= 8 speakers each; larger sets
    use greedy on the confusion counts). Only segments labelled by BOTH count; weights (e.g. durations) default to 1. Returns (agreement, n_both, mapping)."""
    idx = [i for i, (x, y) in enumerate(zip(labels_a, labels_b)) if x is not None and y is not None]
    if not idx: return None, 0, {}
    w = weights or [1.0] * len(labels_a); conf = {}
    for i in idx: conf[(labels_b[i], labels_a[i])] = conf.get((labels_b[i], labels_a[i]), 0.0) + w[i]
    A = sorted({labels_a[i] for i in idx}); B = sorted({labels_b[i] for i in idx}); tot = sum(w[i] for i in idx)
    small, large, swap = (B, A, False) if len(B) <= len(A) else (A, B, True)
    if len(large) <= 8:
        best, bm = -1.0, {}
        for perm in permutations(large, len(small)):
            s = sum(conf.get((x, y) if not swap else (y, x), 0.0) for x, y in zip(small, perm))
            if s > best: best, bm = s, dict(zip(small, perm))
        mapping = bm if not swap else {v: k for k, v in bm.items()}
    else:
        used_b, used_a, best, mapping = set(), set(), 0.0, {}
        for (b, a), c in sorted(conf.items(), key=lambda kv: -kv[1]):
            if b in used_b or a in used_a: continue
            used_b.add(b); used_a.add(a); best += c; mapping[b] = a
    return best / tot, len(idx), mapping
