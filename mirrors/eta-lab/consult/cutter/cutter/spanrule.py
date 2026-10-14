"""The span rule (pure functions, epoch seconds, no I/O). ORDERS m3-01:
  start = max(t_open - 60 s, previous window t_close in that room, tape start)
  explicit close (url_clear / endConsult): end = t_close + 15 s, capped at the next window t_open in that room
  idle_timeout / unclosed / cap_90m / anything else: with a confirmed doctor print: end = last doctor turn + 30 s, searching up to
      min(next window t_open, t_open + 30 min); without one: end = min(next window t_open, t_close + 10 min), flag end_estimated
  only windows closed >= 15 min ago are cut; a window whose t_close / close_reason / doctor changes is re-cut."""
from . import config as C

def room_neighbours(win, room_windows):
    """previous and next window of the same room by t_open (any window, closed or not)."""
    others = sorted((w for w in room_windows if w["id"] != win["id"]), key=lambda w: (w["t_open"], w["id"]))
    prev = [w for w in others if w["t_open"] < win["t_open"] or (w["t_open"] == win["t_open"] and w["id"] < win["id"])]
    nxt = [w for w in others if w["t_open"] > win["t_open"] or (w["t_open"] == win["t_open"] and w["id"] > win["id"])]
    return (prev[-1] if prev else None), (nxt[0] if nxt else None)

def eligible(win, now):
    """closed (t_close set) at least 15 min ago."""
    return win["t_close"] is not None and now - win["t_close"] >= C.MIN_AGE

def plan_signature(win, plan, has_print, coverage, day):
    """N1: what a re-cut depends on is the clip's OWN computed span, not the neighbouring windows' raw fields: start, end (fixed rule) or search_end (search rule), rule, doctor, whether he has a print,
    the tape coverage of the wanted span (0.01 steps), the room and the IST day (the directory). A neighbour change shows up here only if it moves this clip's start or end."""
    sig = dict(start=round(plan["start"], 2), rule=plan["rule"], mode=plan["mode"], doctor=win["doctor_uid"], print=bool(has_print), cov=round(coverage, 2), room=win.get("room_slug"), day=day)
    if plan["mode"] == "fixed": sig["end"] = round(plan["end"], 2)
    else: sig["search_end"] = round(plan["search_end"], 2); sig["t_close"] = round(win["t_close"], 2)          # the floor of the search rule
    return sig

def sig_changed(prev_sig, prev_row, cur):
    """True if the clip must be cut again. Fixed rules: any difference. Search rule (end = last doctor turn + 30 s): the planned search limit alone does not matter unless the cut clip would now be
    truncated (limit < its actual end) or it had hit the old limit and the limit moved out."""
    if not isinstance(prev_sig, dict): return True                                                           # an old-format signature: cut once more
    for k in ("start", "rule", "mode", "doctor", "print", "cov", "room", "day"):
        if prev_sig.get(k) != cur.get(k): return True
    if cur["mode"] == "fixed": return prev_sig.get("end") != cur.get("end")
    if prev_sig.get("t_close") != cur.get("t_close"): return True
    cur_se, prev_se = cur["search_end"], prev_sig.get("search_end")
    if cur_se == prev_se: return False
    pend = (prev_row or {}).get("span_end_epoch")
    if pend is None: return True
    if cur_se < pend - 0.01: return True                                                                     # the clip would now be cut short
    if "end_capped_search" in (prev_row.get("flags") or []) and cur_se > prev_se: return True                # it had hit the old limit and may extend
    return False

def plan_span(win, room_windows, tape_start, tape_end, has_print):
    """-> dict(start, mode 'fixed'|'search', end (fixed) or None, search_end (search) or None, rule, flags, next_open, prev_end).
    tape_start / tape_end = first / last second of tape of that room around the window (None = unknown, no cap)."""
    prev, nxt = room_neighbours(win, room_windows)
    t_open, t_close = win["t_open"], win["t_close"]
    prev_end = None if prev is None else (prev["t_close"] if prev["t_close"] is not None else prev["t_open"])
    next_open = None if nxt is None else nxt["t_open"]
    flags = []
    start = t_open - C.LEAD
    if tape_start is not None and tape_start > start: start = tape_start; flags.append("start_at_tape_start")
    if prev_end is not None and prev_end > start:                       # R10: start = max(t_open - 60, previous window t_close, tape start); an overlapping previous window cannot push the start past t_open
        start = min(prev_end, t_open); flags.append("start_at_previous_window_close" if prev_end <= t_open else "overlaps_previous_window")
    start = min(start, t_open)
    cap = lambda e, why: (min(e, next_open), flags.append(why) if next_open is not None and e > next_open else None)[0] if next_open is not None else e
    if win["close_reason"] in C.EXPLICIT:
        end = cap(t_close + C.EXPLICIT_TAIL, "end_capped_next_window"); rule, mode, search_end = "explicit_close+15s", "fixed", None
    elif has_print:
        # R3: never cut before the window's own t_close: the search reaches at least t_close + 30 s (a cap_90m / long idle window is searched to its own end); the 30-min horizon only applies to shorter windows
        search_end = max(t_close + C.VOICE_TAIL, t_open + C.VOICE_SEARCH)
        if next_open is not None and next_open < search_end: search_end = next_open; flags.append("search_capped_next_window")
        end, rule, mode = None, "doctor_voice+30s", "search"
    else:
        end = cap(t_close + C.NOPRINT_TAIL, "end_capped_next_window"); rule, mode, search_end = "no_print_t_close+10min", "fixed", None; flags.append("end_estimated")
    if mode == "fixed" and tape_end is not None and end > tape_end: end = tape_end; flags.append("tape_truncated")
    if mode == "search" and tape_end is not None and search_end > tape_end: search_end = tape_end; flags.append("search_tape_truncated")
    return dict(start=start, mode=mode, end=end, search_end=search_end, rule=rule, flags=flags, next_open=next_open, prev_end=prev_end)

def finalize_search_end(plan, t_close, last_doctor_turn_end):
    """after diarizing the search interval: end = last doctor turn + 30 s, never before t_close, never past the search end. -> (end, flags)."""
    flags = []
    if last_doctor_turn_end is None:
        end = min(t_close + C.EXPLICIT_TAIL, plan["search_end"]); flags.append("no_doctor_turn")
        return max(end, plan["start"]), flags
    end = last_doctor_turn_end + C.VOICE_TAIL
    if end < t_close: end = t_close; flags.append("end_floor_t_close")
    if end >= plan["search_end"]: end = plan["search_end"]; flags.append("end_capped_search")
    if end < t_close and plan["search_end"] >= t_close: end = t_close; flags.append("end_floor_t_close")        # the floor survives the cap (R3)
    return end, flags
