#!/usr/bin/env python3
"""m3-19 room placement: read <day>/encounters.json (gating's file, never modified), write <day>/encounters.placed.json beside it.
Each row gets room_id, room_source (pulse|presence|usual|schedule|None) and room_confidence. Order a > b > c > d (REPORT-m3-19-study.md):
  pulse    a Pulse window, same doctor, overlap >= 50% of the visit                     (truth in the study)
  presence b Mac whose latest doctor-bearing presence event (<= 15 min old) is this doctor at called_at, exactly one Mac (99.5% vs pulse)
  usual    c the doctor's usual room for the IST weekday (85.9% vs pulse)
  schedule d the existing room_id in encounters.json (82.0% vs pulse)
A usual/schedule row that overlaps (> 60 s, other doctor) a pulse/presence row in the same room is dropped to unplaced (room_note=conflict_dropped).
Neon is read-only (cutter.db). Usage: room_place.py <drtpqma day dir> [--usual FILE] [--dry-run]"""
import argparse, bisect, collections, datetime as dt, json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
MIN_OVERLAP, PRESENCE_MAX_AGE, CONFLICT_S = 0.5, 900.0, 60.0
CONF = {"voice": 0.90, "pulse": 0.95, "presence": 0.90, "usual": 0.85, "schedule": 0.80}        # study accuracy, rounded down; usual is scaled by the doctor's share
WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
PRESENCE_EVENTS = ("login", "logout", "heartbeat", "active", "idle", "encounter_open", "encounter_close", "locked")
WIN_SQL = ("SELECT machine, room_id, t_open, t_close, warehouse_doctor_uid, consulting_doctor_uid, doctor_uid FROM eta_encounter_windows WHERE t_open >= %s AND t_open < %s")
MAP_SQL = "SELECT DISTINCT machine, room_id FROM eta_encounter_windows WHERE room_id IS NOT NULL AND machine IS NOT NULL AND t_open >= %s"   # machine -> room over 30 days, so a day with only room-less windows still maps
EV_SQL = ("SELECT machine, event, ts, payload->>'doctor_uid' AS uid FROM pulse_presence_events WHERE source = 'ext' AND ts >= %s AND ts < %s "
          "AND payload->>'doctor_uid' IS NOT NULL AND event = ANY(%s) ORDER BY machine, ts, id")

def epoch(x):
    return x.timestamp() if hasattr(x, "timestamp") else dt.datetime.fromisoformat(x).timestamp()

def machine_rooms(wins):
    return {w["machine"]: w["room_id"] for w in wins if w.get("room_id")}

def prep_windows(wins, m2r):
    out = []
    for w in wins:
        doc = w.get("warehouse_doctor_uid") or w.get("consulting_doctor_uid") or w.get("doctor_uid")
        rid = w.get("room_id") or m2r.get(w.get("machine"))
        if doc and rid and w.get("t_close") is not None: out.append(dict(doc=doc, room=rid, s=epoch(w["t_open"]), t=epoch(w["t_close"])))
    return out

def prep_events(evs):
    by = collections.defaultdict(list)
    for e in sorted(evs, key=lambda e: (e["machine"], epoch(e["ts"]))): by[e["machine"]].append((epoch(e["ts"]), e["event"], e["uid"]))
    return by, {m: [x[0] for x in v] for m, v in by.items()}

def pulse_room(v, wins):
    best = None
    for w in wins:
        if w["doc"] != v["doctor_uid"]: continue
        ov = min(v["_t"], w["t"]) - max(v["_s"], w["s"])
        if ov > 0 and ov / (v["_t"] - v["_s"]) >= MIN_OVERLAP and (best is None or ov > best[0]): best = (ov, w["room"], ov / (v["_t"] - v["_s"]))
    return best

def presence_room(doc, t, by, ts, m2r):
    rooms = set()
    for m, rows in by.items():
        i = bisect.bisect_right(ts[m], t) - 1
        if i < 0 or m not in m2r: continue
        at, ev, uid = rows[i]
        if uid == doc and ev != "logout" and t - at <= PRESENCE_MAX_AGE: rooms.add(m2r[m])
    return next(iter(rooms)) if len(rooms) == 1 else None

def usual_table(rows):
    return {(r["doctor_uid"], r["weekday"]): max(r["rooms"], key=lambda x: x["share"]) for r in rows if r.get("rooms")}

def place(encounters, wins, events, usual, m2r=None):
    """encounters: list of dict (gating rows); wins/events: raw DB-shaped rows; usual: usual_table(). Returns new list of rows (copies) with room fields set."""
    m2r = dict(machine_rooms(wins), **(m2r or {})); W = prep_windows(wins, m2r); by, ts = prep_events(events)
    rows = []
    for e in encounters:
        r = dict(e); rows.append(r)
        try: s, t = epoch(e["start"]), epoch(e["end"])
        except Exception: s = t = None
        r["_s"], r["_t"] = s, t
        r.update(room_id=None, room_source=None, room_confidence=None)
        if s is None or t <= s: continue
        p = pulse_room(r, W)
        if p: r.update(room_id=p[1], room_source="pulse", room_confidence=CONF["pulse"]); continue
        pr = presence_room(e["doctor_uid"], s, by, ts, m2r)
        if pr: r.update(room_id=pr, room_source="presence", room_confidence=CONF["presence"]); continue
        if e.get("room_source") == "voice" and e.get("room_id"): r.update(room_id=e["room_id"], room_source="voice", room_confidence=CONF["voice"]); continue      # F8: gating voice evidence outranks usual and schedule
        u = usual.get((e["doctor_uid"], WD[dt.datetime.fromtimestamp(s, IST).weekday()]))
        if u: r.update(room_id=u["room_id"], room_source="usual", room_confidence=round(CONF["usual"] * float(u.get("share", 1.0)), 3)); continue
        if e.get("room_id"): r.update(room_id=e["room_id"], room_source="schedule", room_confidence=CONF["schedule"])
    firm = collections.defaultdict(list)
    for r in rows:
        if r["room_source"] in ("pulse", "presence"): firm[r["room_id"]].append(r)
    for r in rows:
        if r["room_source"] in ("usual", "schedule") and any(f["doctor_uid"] != r["doctor_uid"] and min(f["_t"], r["_t"]) - max(f["_s"], r["_s"]) > CONFLICT_S for f in firm.get(r["room_id"], ())):
            r.update(room_id=None, room_source=None, room_confidence=None, room_note="conflict_dropped")
    for r in rows: r.pop("_s"); r.pop("_t")
    return rows

def summary(rows):
    c = collections.Counter(r["room_source"] for r in rows)
    return dict(visits=len(rows), **{str(k): v for k, v in sorted(c.items(), key=lambda kv: str(kv[0]))})

def db_loaders(day):
    """-> (windows, events, machine->room map) for the IST day +- 12 h of context; read-only connection from cutter.db."""
    from psycopg.rows import dict_row
    from cutter import db
    d0 = dt.datetime.fromisoformat(day).replace(tzinfo=IST); lo, hi = d0 - dt.timedelta(hours=12), d0 + dt.timedelta(hours=36)
    with db.connect(row_factory=dict_row) as c:
        wins, evs = c.execute(WIN_SQL, (lo, hi)).fetchall(), c.execute(EV_SQL, (lo, hi, list(PRESENCE_EVENTS))).fetchall()
        m2r = {r["machine"]: r["room_id"] for r in c.execute(MAP_SQL, (d0 - dt.timedelta(days=30),)).fetchall()}
    return wins, evs, m2r

def run(day_dir, usual_file, wins=None, events=None, dry=False, m2r=None):
    day = os.path.basename(os.path.normpath(day_dir))
    src = json.load(open(os.path.join(day_dir, "encounters.json")))
    if wins is None: wins, events, m2r = db_loaders(day)
    usual = usual_table(json.load(open(usual_file))["table"]) if usual_file else {}
    rows = place(src["encounters"], wins, events or [], usual, m2r)
    out = dict(src, encounters=rows, room_place=dict(version="m3-19", summary=summary(rows)))
    if not dry:
        dest = os.path.join(day_dir, "encounters.placed.json"); fd, tmp = tempfile.mkstemp(dir=day_dir, prefix=".placed.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh: json.dump(out, fh, indent=1)
            os.chmod(tmp, 0o644); os.replace(tmp, dest)                                                              # F6: same mode as encounters.json
        except BaseException:
            try: os.remove(tmp)                                                                                      # F5: no stray tmp file in gating's day dir
            except OSError: pass
            raise
    return out["room_place"]["summary"]

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0]); ap.add_argument("day_dir"); ap.add_argument("--usual"); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv); print(json.dumps(run(a.day_dir, a.usual, dry=a.dry_run)))

if __name__ == "__main__": main()
