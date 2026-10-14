"""segmenter.py — the ENCOUNTER-FIRST consult segmenter, pure functions (lx, 24 Sep).

ONE implementation, shared by study.py (the 23 Sep study) and the E-7 rescore (studies/2026-09-24-e7-fullday),
so the out-of-sample check runs exactly the code and the DECLARED parameters that were scored in sample.

Inputs are plain data. No database, no audio, no text:
  levels  [(t_ms, peak)] for one room and IST date      (bench_level_sample)
  labels  [{window_id, engine, start_ms, end_ms, segments_json}] for one room-day   (diarize_window_label)
  queue   [(called_ms, completed_ms)] for the room's voice-confirmed doctor          (PQM)
"""
import bisect, json
from datetime import datetime

# ---- DECLARED parameters (fixed before the 23 Sep score; do not tune on the scored day)
BIN_S = 10          # energy bins
K_ACTIVE = 1.5      # a bin is active when its max peak >= K * the room's 20th-percentile peak (quiet floor)
MERGE_GAP_S = 60    # active runs closer than this are one stretch of talk
MIN_SEG_S = 180     # a consult-shaped segment lasts at least 3 min
MIN_ACTIVE_FRAC = 0.3
MAX_SEG_S = 1200    # a segment longer than 20 min is split (speaker turnover first, else the longest quiet gap)
SPLIT_QUIET_S = 20  # ...only at a quiet gap at least this long
TURN_WIN_S = 120    # speaker set in the 2 min before vs after t
TURN_JACC = 1 / 3   # turnover when Jaccard(before, after) <= 1/3
SNAP_S = 180        # queue edges move to an energy edge at most 3 min away
SPAN_PAD_S = 600    # arm d: the doctor's working span, padded 10 min either side
CLIN = ("07:30", "20:00")


def day_bounds(date):
    f = lambda hm: int(datetime.fromisoformat(f"{date}T{hm}:00+05:30").timestamp() * 1000)
    return f(CLIN[0]), f(CLIN[1])


def energy_bins(levels, date, k=K_ACTIVE):
    d0, d1 = day_bounds(date)
    xs = sorted((int(t), float(p)) for t, p in levels if d0 <= int(t) < d1)
    if not xs: return d0, [], None
    pk = sorted(p for _, p in xs); q20 = pk[int(0.2 * (len(pk) - 1))]
    nb = (d1 - d0) // (BIN_S * 1000); peak = [None] * nb
    for t, p in xs:
        i = (t - d0) // (BIN_S * 1000)
        if 0 <= i < nb: peak[i] = p if peak[i] is None else max(peak[i], p)
    return d0, [p is not None and p >= k * q20 for p in peak], q20


def runs(active, merge_bins):
    out, i, n = [], 0, len(active)
    while i < n:
        if not active[i]: i += 1; continue
        j = i
        while True:
            k = j + 1
            while k < n and not active[k] and k - j <= merge_bins: k += 1
            if k < n and active[k] and k - j <= merge_bins: j = k; continue
            break
        out.append((i, j)); i = j + 1
    return out


def turnovers(labels):
    """Speaker-set turnover points (epoch ms) and the labelled windows' spans. pyannoteai preferred per window."""
    best = {}
    for r in labels:
        if r["window_id"] not in best or r["engine"] == "pyannoteai": best[r["window_id"]] = r
    pts = []
    for r in best.values():
        w0 = int(r["start_ms"]); segs = r["segments_json"]; segs = json.loads(segs) if isinstance(segs, str) else segs
        L = int(r["end_ms"]) - w0
        for t in range(TURN_WIN_S * 1000, L - TURN_WIN_S * 1000 + 1, 30000):
            before = {s["speaker_idx"] for s in segs if s["end_ms"] > t - TURN_WIN_S * 1000 and s["start_ms"] < t}
            after = {s["speaker_idx"] for s in segs if s["start_ms"] < t + TURN_WIN_S * 1000 and s["end_ms"] > t}
            if before and after and len(before & after) / len(before | after) <= TURN_JACC: pts.append(w0 + t)
    pts.sort(); merged = []
    for p in pts:
        if merged and p - merged[-1][-1] <= 60000: merged[-1].append(p)
        else: merged.append([p])
    return [sum(g) // len(g) for g in merged], sorted((int(r["start_ms"]), int(r["end_ms"])) for r in best.values())


def arm_a(levels, labels, date, k=K_ACTIVE, merge_s=MERGE_GAP_S):
    """Acoustic only: energy runs, split at speaker turnover / long quiet gaps. [(start_ms, end_ms)]"""
    d0, active, _ = energy_bins(levels, date, k); B = BIN_S * 1000
    turns, _ = turnovers(labels)
    segs = []
    for i, j in runs(active, merge_s // BIN_S):
        pieces, stack = [], [(i, j)]
        while stack:
            s, e = stack.pop()
            if (e - s + 1) * BIN_S <= MAX_SEG_S: pieces.append((s, e)); continue
            inside = [t for t in turns if d0 + (s + 18) * B < t < d0 + (e - 18) * B]   # not within 3 min of an edge
            if inside:
                c = (inside[len(inside) // 2] - d0) // B; stack += [(s, c - 1), (c, e)]; continue
            best, g, gs = None, 0, None     # longest internal quiet gap
            for x in range(s, e + 1):
                if not active[x]: g, gs = g + 1, (gs if g else x)
                else:
                    if g * BIN_S >= SPLIT_QUIET_S and (best is None or g > best[1]): best = (gs, g)
                    g = 0
            if best: stack += [(s, best[0] - 1), (best[0] + best[1], e)]
            else: pieces.append((s, e))
        for s, e in sorted(pieces):
            if e < s: continue          # a split right at an edge can leave an empty piece
            dur = (e - s + 1) * BIN_S; act = sum(active[s:e + 1]) / (e - s + 1)
            if dur >= MIN_SEG_S and act >= MIN_ACTIVE_FRAC: segs.append((d0 + s * B, d0 + (e + 1) * B))
    return segs


def arm_d(levels, labels, date, queue):
    """Arm a, kept only inside the doctor's working span from the queue (first call / last completion, padded).
    The queue gives the span only, never a per-consult time. No queue rows -> no span -> no segments."""
    if not queue: return []
    lo = min(a for a, _ in queue) - SPAN_PAD_S * 1000; hi = max(b for _, b in queue) + SPAN_PAD_S * 1000
    return [(s, e) for s, e in arm_a(levels, labels, date) if e > lo and s < hi]


def edges(levels, date):
    d0, active, _ = energy_bins(levels, date); B = BIN_S * 1000
    on = [d0 + i * B for i in range(1, len(active)) if active[i] and not active[i - 1]]
    off = [d0 + i * B for i in range(1, len(active)) if active[i - 1] and not active[i]]
    return on, off, d0, active


def nearest(xs, t, lim):
    i = bisect.bisect_left(xs, t); c = [x for x in xs[max(0, i - 1):i + 1] if abs(x - t) <= lim]
    return min(c, key=lambda x: abs(x - t)) if c else None
