#!/usr/bin/env python3
"""N1(d): replay the hourly :35 runs over the REAL 2-7 Oct windows as a dry run (no GPU, no audio, no writes): at each simulated run only windows already opened at that time are visible
(t_close of a not-yet-closed window is unknown), windows are loaded from (now - 48 h - 24 h) and selected from now - 48 h, a 'cut' is simulated by writing an index row with the plan signature.
Counts first cuts, skipped rows, re-cuts (select mode 'new' on an existing row) and hourly re-checks (pull-only). --old replays the m3-02 signature (previous close / next open raw) as the baseline (the refuter measured 97).
Limits: the final t_close / close_reason of every window is used (the resolver's later recomputes cannot be replayed) and the tape manifest is static (no late-tape coverage changes).
  ~/oc/consult/cutter-venv/bin/python tools/replay.py [--old] [--from 2026-10-02 --to 2026-10-07T12:35]"""
import argparse, collections, datetime as dt, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from cutter import config as C, spanrule as S, windows as Wn, tape as T, speak as SP, run as R
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

def old_signature(win, rw):
    prev, nxt = S.room_neighbours(win, rw)
    return [round(win["t_close"], 3) if win["t_close"] is not None else None, win["close_reason"], win["doctor_uid"], round(win["t_open"], 3), win.get("room_slug"),
            None if prev is None else (round(prev["t_close"], 3) if prev["t_close"] is not None else round(prev["t_open"], 3)), None if nxt is None else round(nxt["t_open"], 3)]

def replay(windows, by, prints, t_from, t_to, old=False):
    ctx = dict(by=by, prints=prints); index = {}; state = {}; out = collections.Counter(); recut_ids = collections.Counter(); spurious = 0
    now = t_from
    while now <= t_to:
        vis = []
        for w in windows:
            if w["t_open"] > now: continue
            vis.append(dict(w, t_close=w["t_close"] if (w["t_close"] is not None and w["t_close"] <= now) else None))
        loaded = [w for w in vis if w["t_open"] >= now - 48 * 3600 - (0 if old else C.LOOKBACK_S)]            # the m3-02 code loaded only the last 48 h
        rooms = Wn.by_room(loaded)
        if old:
            todo = []
            for w in sorted(loaded, key=lambda w: w["t_open"]):
                if w["t_open"] < now - 48 * 3600 or not S.eligible(w, now): continue
                prev = index.get(w["consult_uid"])
                if prev is None or prev["signature"] != old_signature(w, rooms[w["room_id"]]): todo.append((w, rooms[w["room_id"]], "new"))
        else:
            todo = R.select(loaded, index, now, state=state, sigfn=lambda w, rw: R.window_sig(w, rw, ctx)[0], min_open=now - 48 * 3600)
        for w, rw, mode in todo:
            state[w["consult_uid"]] = now
            sig, pr0, cov = R.window_sig(w, rw, ctx); had = w["consult_uid"] in index
            if mode == "new":
                out["recuts" if had else "first_cuts"] += 1
                if had: recut_ids[w["consult_uid"]] += 1; spurious += (index[w["consult_uid"]].get("plan") == (pr0["start"], pr0["end"], pr0["search_end"]))
                hi = pr0["end"] if pr0["mode"] == "fixed" else pr0["search_end"]
                index[w["consult_uid"]] = dict(status="cut" if cov >= C.MIN_COVERAGE else "skipped", signature=old_signature(w, rw) if old else sig, span_end_epoch=hi, flags=[], coverage=round(cov, 3), plan=(pr0["start"], pr0["end"], pr0["search_end"]))
            else:
                out["rechecks_" + mode] += 1
                if mode == "final": index[w["consult_uid"]]["final"] = True                                              # the real run appends a final row: no further checks
        now += 3600
    out["windows_seen"] = len(index); out["spurious_recuts"] = spurious; return out, recut_ids

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--old", action="store_true"); ap.add_argument("--from", dest="t0", default="2026-10-02T00:35"); ap.add_argument("--to", dest="t1", default="2026-10-07T12:35"); a = ap.parse_args()
    f = lambda s: dt.datetime.strptime(s, "%Y-%m-%dT%H:%M").replace(tzinfo=IST).timestamp(); t0, t1 = f(a.t0), f(a.t1)
    windows = Wn.fetch(t0 - 3 * 86400); by = T.load_manifest(); prints = SP.load_prints()
    out, ids = replay(windows, by, prints, t0, t1, old=a.old)
    print(("OLD m3-02 signature" if a.old else "NEW plan signature"), dict(out), "re-cut windows:", len(ids), "max re-cuts of one window:", max(ids.values(), default=0))

if __name__ == "__main__": main()
