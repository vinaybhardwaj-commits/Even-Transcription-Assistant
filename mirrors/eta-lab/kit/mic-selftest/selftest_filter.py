"""selftest_filter.py: keep the mic self-test out of every patient record (ruling 369 item 4). INTERIM, lab side; the production-side filter belongs to the native build.

A transcript segment is dropped, and shown in the lab viewer only as 'mic self-test', when EITHER
  (a) it overlaps the exact tape interval of a live run logged by mic_selftest.py (record fields room, session, selftest_epoch = [start, end] epoch seconds), OR
  (b) its text fuzzy-matches the canary word (mic_selftest.fuzzy_canary), wherever it is.
Nothing else is dropped. Callers: notes, Jev inputs, linker, translations, rating pages (each calls filter_segments before it uses a segment).

segment = dict(room=..., start=epoch s, end=epoch s, text=..., [session=...]); a segment with no start/end is judged on (b) alone.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mic_selftest as M

LABEL = "mic self-test"


def load_intervals(log_path):
    """Every live run that played a sound, with its tape interval. A played run with no interval is an error: it would let the canary through."""
    out = []
    if not os.path.exists(log_path):
        return out
    with open(log_path) as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("mode") == "live" and r.get("played"):
                ep = r.get("selftest_epoch")
                if not (isinstance(ep, list) and len(ep) == 2 and ep[0] < ep[1]):
                    raise ValueError(f"{log_path}:{n}: a played run without a usable selftest_epoch")
                out.append(dict(room=r["room"], session=r.get("session"), start=float(ep[0]), end=float(ep[1])))
    return out


def _same_room(seg, iv, aliases):
    names = {iv["room"], *aliases.get(iv["room"], ())}
    if seg.get("room") in names:
        return True
    return bool(iv.get("session")) and seg.get("session") == iv["session"]


def classify(seg, intervals, aliases=None):
    """None (keep) or the reason to drop."""
    aliases = aliases or {}
    if seg.get("text") and M.fuzzy_canary(seg["text"])[0]:
        return "matches the canary word"
    s, e = seg.get("start"), seg.get("end")
    if s is not None and e is not None:
        for iv in intervals:
            if _same_room(seg, iv, aliases) and s < iv["end"] and e > iv["start"]:
                return "overlaps a self-test interval"
    return None


def filter_segments(segments, intervals, aliases=None):
    """(kept, dropped). dropped items are {'label': 'mic self-test', 'reason': ..., 'room', 'start', 'end'}: no text, so nothing downstream can use it."""
    kept, dropped = [], []
    for seg in segments:
        why = classify(seg, intervals, aliases)
        if why is None:
            kept.append(seg)
        else:
            dropped.append(dict(label=LABEL, reason=why, room=seg.get("room"), start=seg.get("start"), end=seg.get("end")))
    return kept, dropped
