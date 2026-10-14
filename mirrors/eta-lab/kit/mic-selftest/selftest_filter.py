"""selftest_filter.py: keep the mic self-test out of every patient record (ruling 369 item 4). INTERIM, lab side; the production-side filter belongs to the native build.

A transcript segment is dropped, and shown in the lab viewer only as 'mic self-test', when ANY of
  (a) it overlaps a logged self-test interval widened by FILTER_MARGIN_S on each side (the log already carries +-2 s for the Mac clock's 1 s resolution),
  (b) its text fuzzy-matches the canary word (mic_selftest.fuzzy_canary: any spelling, any Indic script), wherever it is,
  (c) it cannot be ruled out: it has no times while a logged interval could be its room's, or it names no room and no session (then it counts as every room's, so
      any time overlap drops it). FAIL CLOSED: doubt drops the segment.
An unreadable log line raises; a played run without a usable interval raises. Nothing is ever kept because a check could not run.
Callers: notes, Jev inputs, linker, translations, rating pages (each calls filter_segments before it uses a segment).

segment = dict(room=..., [room_id=..., session=...], start=epoch s, end=epoch s, text=...). Interval record (from mic_selftest's log): room, room_id, session, selftest_epoch.
"""
import hashlib, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mic_selftest as M

LABEL = "mic self-test"
FILTER_MARGIN_S = 5.0      # named and fixed: added on each side of every logged interval


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
                out.append(dict(room=r["room"], room_id=r.get("room_id"), session=r.get("session"), start=float(ep[0]), end=float(ep[1]), run_id=r.get("run_id")))
    return out


def export_records(log_path):
    """One record per played run for the lab viewer: ids, dates and the tape interval as ISO with offset. No patient text, no audio."""
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
                for k in ("tape_start_iso", "tape_end_iso", "run_id", "canary_id", "date_ist"):
                    if not r.get(k):
                        raise ValueError(f"{log_path}:{n}: a played run without {k}")
                out.append(dict(run_id=r["run_id"], room=r["room"], room_id=r.get("room_id"), session=r.get("session"), date_ist=r["date_ist"],
                                t0=r["tape_start_iso"], t1=r["tape_end_iso"], canary_id=r["canary_id"]))
    return out


def _same_room(seg, iv, aliases):
    """True if the segment is that interval's room OR cannot be told apart from it (fail closed)."""
    names = ({iv["room"], iv.get("room_id"), *aliases.get(iv["room"], ())}) - {None}
    seg_names = ({seg.get("room"), seg.get("room_id")}) - {None}
    if seg_names & names:
        return True
    if iv.get("session") and seg.get("session") == iv["session"]:
        return True
    return not seg_names and not seg.get("session")


def classify(seg, intervals, aliases=None, margin_s=FILTER_MARGIN_S):
    """None (keep) or the reason to drop."""
    aliases = aliases or {}
    if seg.get("text") and M.fuzzy_canary(seg["text"])[0]:
        return "matches the canary word"
    s, e = seg.get("start"), seg.get("end")
    for iv in intervals:
        if not _same_room(seg, iv, aliases):
            continue
        if s is None or e is None:
            return "cannot verify overlap (no times)"
        if s < iv["end"] + margin_s and e > iv["start"] - margin_s:
            return "overlaps a self-test interval"          # a segment that names no room counts as this room's (see _same_room)
    return None


def filter_segments(segments, intervals, aliases=None, margin_s=FILTER_MARGIN_S):
    """(kept, dropped). dropped items are {'label': 'mic self-test', 'reason': ..., 'room', 'start', 'end'}: no text, so nothing downstream can use it."""
    kept, dropped = [], []
    for seg in segments:
        why = classify(seg, intervals, aliases, margin_s)
        if why is None:
            kept.append(seg)
        else:
            dropped.append(dict(label=LABEL, reason=why, room=seg.get("room"), start=seg.get("start"), end=seg.get("end")))
    return kept, dropped


def selftest_annotation_items(log_path):
    """(items, source_sha256) for the lab vault's 'selftest' annotation kind (lab-viewer r375): items {run_id, t0, t1} with ISO times and offset, and the sha256 of the
    run log the intervals come from. No canary text, no note. The caller groups by room and IST date (one file per key)."""
    items = [dict(run_id=r["run_id"], t0=r["t0"], t1=r["t1"]) for r in export_records(log_path)]
    if not os.path.exists(log_path):
        return items, None
    with open(log_path, "rb") as f:
        return items, hashlib.sha256(f.read()).hexdigest()
