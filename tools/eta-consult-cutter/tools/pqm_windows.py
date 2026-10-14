#!/usr/bin/env python3
"""m3-17: build the cutter's windows JSONL (cutter --windows-file) from the PQM encounter files ~/eta-data/drtpqma/<day>/encounters.json.
Placed rows ONLY (a room_id and room_source schedule|voice); room_unknown rows are not cut. One window per row:
  consult_uid = "pqm_" + first 22 hex of sha256("pqm:" + step_uid)   (step_uid = the CONSULTATION step, not the token)
  t_open = called - 60 s, t_close = completed + 60 s, close_reason "pqm", doctor_uid from PQM, doctor_source "warehouse_pqm"
  completed - called == 3600 s exactly (PQM timeout artefact): quality "suspect", flags ["pqm_timeout_3600"], still cut; every other row quality "pqm"
  id = window_id(step_uid) (see there); the clip span is EXACTLY t_open..t_close (cutter/spanrule.py rule pqm_exact)
  index fields on these rows only: boundary_source "pqm", room_source, pqm_step_uid
Order (the cutter keeps it: day newest first, then prio, then time): within a day OPD 3, 4, 5, 6, 7 first, then the rest.
  python3 tools/pqm_windows.py [--from D] [--to D] [--out FILE] [--dry-run]    (default: every day with an encounters.json)     --dry-run prints per-day counts and writes nothing. Stdout: counts only (no names, no uids)."""
import argparse, collections, csv, datetime as dt, hashlib, json, os, sys, time
H = os.path.expanduser("~"); E = f"{H}/eta-data"; DRT = f"{E}/drtpqma"; INDEX = f"{E}/consult/clips/index.jsonl"; TAPES = f"{E}/tapes/manifest.jsonl"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30)); PAD = 60.0; PRIO_ROOMS = ("OPD 3", "OPD 4", "OPD 5", "OPD 6", "OPD 7"); SOURCES = ("schedule", "voice", "pulse", "presence", "usual")                                             # m3-19: pulse | presence | usual come from encounters.placed.json
PLACE_FROM = "2026-10-02"; UNCERTAIN = ("usual", "schedule")                                             # m3-19: days from here use encounters.placed.json when fresh (September is never re-placed); a placed row with room_source in UNCERTAIN (confidence < 0.9) is cut but flagged room_uncertain, quality suspect

def window_id(step_uid):
    """m3-17 minor 2: 10**15 + int(sha256("pqm:" + step_uid)[:12], 16): stable (independent of the day set), above every Neon window id (those are small integers), below 2**53."""
    return 10 ** 15 + int(hashlib.sha256(("pqm:" + step_uid).encode()).hexdigest()[:12], 16)

def consult_uid(step_uid): return "pqm_" + hashlib.sha256(("pqm:" + step_uid).encode()).hexdigest()[:22]

def room_slugs(index=INDEX, tapes=TAPES):
    """room_id -> room_slug as the cutter wrote them (the clip directory name; the index wins), else the slug in the tape key; never a doctor name."""
    out = {}
    try:
        for l in open(index):
            try: r = json.loads(l)
            except ValueError: continue
            if r.get("room_id") and r.get("room_slug"): out[r["room_id"]] = r["room_slug"]
    except OSError: pass
    try:                                                                                                          # a room the cutter has not cut yet: the slug in the tape key (bench/<room_slug>/<day>/...)
        for l in open(tapes):
            try: r = json.loads(l)
            except ValueError: continue
            k = str(r.get("r2_key", "")).split("/")
            if r.get("room_id") and r["room_id"] not in out and len(k) > 2 and k[0] == "bench" and k[1]: out[r["room_id"]] = k[1]
    except OSError: pass
    return out

def window_of(e, day, slugs):
    """-> (window dict without id, None) or (None, reason). Placed-only filter lives here."""
    if not e.get("room_id") or e.get("room_source") not in SOURCES: return None, "not_placed"
    if not e.get("step_uid") or not e.get("doctor_uid"): return None, "no_step_or_doctor"
    try: a, b = dt.datetime.fromisoformat(e["start"]).timestamp(), dt.datetime.fromisoformat(e["end"]).timestamp()
    except (KeyError, TypeError, ValueError): return None, "bad_time"
    if not b > a: return None, "bad_time"
    slug = slugs.get(e["room_id"])
    if not slug: return None, "no_room_slug"
    timeout = abs((b - a) - 3600.0) < 1.0
    unc = "room_confidence" in e and e["room_source"] in UNCERTAIN                                                  # only rows that came from the placed file carry a confidence
    fl = (["pqm_timeout_3600"] if timeout else []) + (["room_uncertain"] if unc else [])
    label = e.get("room_label") or ""
    return dict(consult_uid=consult_uid(e["step_uid"]), machine="pqm", room_id=e["room_id"], room_slug=slug, t_open=a - PAD, t_close=b + PAD, close_reason="pqm", quality="suspect" if (timeout or unc) else "pqm",
                resolver_version="pqm-1", computed_at=f"pqm:{day}", doctor_uid=e["doctor_uid"], doctor_name=e.get("doctor") or "", doctor_source="warehouse_pqm", boundary_source="pqm", room_source=e["room_source"],
                pqm_step_uid=e["step_uid"], pqm_called=a, pqm_completed=b, prio=PRIO_ROOMS.index(label) if label in PRIO_ROOMS else len(PRIO_ROOMS), **({"room_confidence": e["room_confidence"]} if "room_confidence" in e else {}), **({"flags": fl} if fl else {})), None

PULSE_FROM = "2026-10-02"; PULSE_MIN_SHARE = 0.5                                                                    # m3-18: from this IST day the hourly Pulse path cuts consults too; a PQM visit it already covers is dropped

def _ist_epoch(s):
    """index t_open / t_close are naive IST wall-clock strings ("2026-10-12 17:47:40.459") -> epoch seconds, or None."""
    try: return dt.datetime.fromisoformat(str(s)).replace(tzinfo=IST).timestamp()
    except (TypeError, ValueError): return None

OPEN_CAP_S = 5400.0                                                                                               # the resolver cap_90m: an open Pulse window (t_close None) covers up to min(now, t_open + 90 min)

def open_close(p, now=None):
    """m3-19: t_close of a Pulse window; None (still open) -> min(now, t_open + OPEN_CAP_S). Never skipped: skipping would cut a duplicate of a consult in progress."""
    if p.get("t_close") is not None: return p["t_close"]
    return min(time.time() if now is None else now, p["t_open"] + OPEN_CAP_S)

def planned_uids(path):
    """m3-19 F7: consult_uids already in palimpsest planned-clips.csv (first column); a missing / unreadable file = none."""
    out = set()
    try:
        for i, l in enumerate(open(path)):
            u = l.split(",", 1)[0].strip()
            if i and u: out.add(u)
    except OSError: pass
    return out

def pulse_context(index=INDEX, loader=None, since_epoch=None, now=None, planned=None):
    """-> dict(windows=[dict(room_id, doctor_uid, t_open, t_close)], cut_pqm_uids=set()). Pulse windows = eta_encounter_windows rows (READ-ONLY Neon, the same fetch as cutter/windows.py; loader injectable)
    PLUS live index rows whose boundary_source is not pqm. cut_pqm_uids = consult_uids the index already holds as pqm rows (never dropped later: the uid and the planned row stay stable). A Neon failure RAISES:
    planning without the coverage data would plant duplicates."""
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from cutter import windows as Wn
    if since_epoch is None: since_epoch = dt.datetime.fromisoformat(PULSE_FROM).replace(tzinfo=IST).timestamp() - 86400
    ws = [dict(room_id=w["room_id"], doctor_uid=w["doctor_uid"], t_open=w["t_open"], t_close=open_close(w, now)) for w in Wn.fetch(since_epoch, loader=loader)]
    cut = planned_uids(planned) if planned else set(); pqm_rows = {}                                                  # F7: a planned uid is never dropped later, same as a cut one
    try:
        for l in open(index):
            try: r = json.loads(l)
            except ValueError: continue
            if not isinstance(r, dict): continue
            if r.get("boundary_source") == "pqm":
                if r.get("consult_uid"): cut.add(r["consult_uid"]); pqm_rows[r["consult_uid"]] = r
                continue
            a, b = _ist_epoch(r.get("t_open")), _ist_epoch(r.get("t_close"))
            if a is not None and b is not None and b > a and r.get("room_id"): ws.append(dict(room_id=r["room_id"], doctor_uid=r.get("doctor_uid"), t_open=a, t_close=b))
    except OSError: pass
    return dict(windows=ws, cut_pqm_uids=cut, pqm_rows=pqm_rows)

def covered_by_pulse(w, pulse, now=None):
    """True when a Pulse window overlaps the PQM window w (t_open..t_close) by >= 50% of w's span, in the same room_id OR with the same doctor_uid."""
    lo, hi = w.get("pqm_called", w["t_open"]), w.get("pqm_completed", w["t_close"])                              # F1: the RAW visit span called..completed, not the padded one
    span = hi - lo
    for p in pulse["windows"]:
        if not (p["room_id"] == w["room_id"] or (p.get("doctor_uid") and p["doctor_uid"] == w["doctor_uid"])): continue
        if min(hi, open_close(p, now)) - max(lo, p["t_open"]) >= PULSE_MIN_SHARE * span: return True
    return False

def encounters_path(day, drt=DRT):
    """m3-19: encounters.placed.json when the day is on/after PLACE_FROM and the file is at least as new as encounters.json, else encounters.json."""
    base, placed = f"{drt}/{day}/encounters.json", f"{drt}/{day}/encounters.placed.json"
    try:
        if day >= PLACE_FROM and os.path.getmtime(placed) >= os.path.getmtime(base): return placed
    except OSError: pass
    return base

def keep_index_room(w, row):
    """m3-19 F2: a uid the index already holds as CUT keeps the room, slug and source of that row (the clip is on that room tape); room_uncertain follows the row's flags."""
    w.update(room_id=row["room_id"], room_slug=row.get("room_slug") or w["room_slug"], room_source=row.get("room_source") or w["room_source"])
    if row.get("room_confidence") is not None: w["room_confidence"] = row["room_confidence"]
    else: w.pop("room_confidence", None)
    fl = [f for f in w.get("flags", []) if f != "room_uncertain"] + (["room_uncertain"] if "room_uncertain" in (row.get("flags") or []) else [])
    if fl: w["flags"] = fl
    else: w.pop("flags", None)
    w["quality"] = "suspect" if fl else "pqm"
    return w

def build(days, drt=DRT, slugs=None, pulse=None, planned=None):
    """-> (windows in cut order with integer ids, per-day Counter of kept / skipped reasons). Days on or after PULSE_FROM drop the visits a Pulse window covers (counter covered_by_pulse);
    pulse = a pulse_context() result, loaded lazily (Neon) only when such a day has an encounters.json."""
    slugs = slugs if slugs is not None else room_slugs(); ws, stat = [], collections.OrderedDict()
    for day in sorted(days, reverse=True):
        c = stat.setdefault(day, collections.Counter()); path = encounters_path(day, drt)
        if not os.path.exists(path): c["no_file"] += 1; continue
        day_ws = []
        for e in json.load(open(path))["encounters"]:
            w, why = window_of(e, day, slugs)
            if w is None: c["skip_" + why] += 1; continue
            if day >= PULSE_FROM:
                if pulse is None: pulse = pulse_context(planned=planned)
                row = pulse.get("pqm_rows", {}).get(w["consult_uid"])
                if row and row.get("status") == "cut" and row.get("room_id"): keep_index_room(w, row)
                if w["consult_uid"] not in pulse["cut_pqm_uids"] and covered_by_pulse(w, pulse): c["covered_by_pulse"] += 1; continue
            c["windows"] += 1; c["timeout_3600"] += "pqm_timeout_3600" in w.get("flags", ()); c["prio_opd3_7"] += w["prio"] < len(PRIO_ROOMS); day_ws.append(w)
        ws += sorted(day_ws, key=lambda w: (w["prio"], w["t_open"], w["consult_uid"]))
    for w in ws: w["id"] = window_id(w["pqm_step_uid"])
    return ws, stat

PLANNED_HEADER = ("consult_uid", "room_id", "t0_utc_ms", "t1_utc_ms", "room_source", "status")

def planned_rows(ws, status_of=lambda uid: "planned"):
    """palimpsest's skip file (addendum 1): the SAME consult_uid and the same t0 / t1 (= the window's t_open / t_close, UTC ms) as the windows file; status planned | cut | dead."""
    return [(w["consult_uid"], w["room_id"], round(w["t_open"] * 1000), round(w["t_close"] * 1000), w["room_source"], status_of(w["consult_uid"])) for w in ws]

def write_planned(path, ws, status_of=lambda uid: "planned"):
    """atomic: tmp in the same directory, then rename. Header + one line per window, in the cut order."""
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n"); w.writerow(PLANNED_HEADER)
        for r in planned_rows(ws, status_of): w.writerow(r)
    os.chmod(tmp, 0o664); os.replace(tmp, path)

def all_days(drt=DRT, d_from=None, d_to=None):
    """every IST day that has an encounters.json under drt (addendum 2: 9 Sep to 1 Oct today), optionally cut to [d_from, d_to]; sorted oldest first."""
    out = []
    try: names = os.listdir(drt)
    except OSError: return out
    for n in names:
        try: dt.date.fromisoformat(n)
        except ValueError: continue
        if os.path.exists(f"{drt}/{n}/encounters.json") and (not d_from or n >= d_from) and (not d_to or n <= d_to): out.append(n)
    return sorted(out)

def days_of(d_from=None, d_to=None, drt=DRT):
    """--from / --to are optional; with neither, every day with an encounters.json (the runner must rewrite planned-clips.csv for ALL planned days, never a subset)."""
    if d_from and d_to and d_from > d_to: raise SystemExit("--from is after --to")
    return all_days(drt, d_from, d_to)

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--from", dest="d_from"); ap.add_argument("--to"); ap.add_argument("--out"); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args(argv)
    if bool(a.out) == bool(a.dry_run): ap.error("exactly one of --out FILE or --dry-run")
    days = days_of(a.d_from, a.to)
    ws, stat = build(days)
    uids = [w["consult_uid"] for w in ws]
    if len(set(uids)) != len(uids): print("REFUSED duplicate consult_uid (a step_uid appears twice)", file=sys.stderr); return 2
    for day, c in stat.items(): print(day, dict(c))
    print("total windows", len(ws))
    if a.out:
        tmp = f"{a.out}.tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            for w in ws: fh.write(json.dumps(w, sort_keys=True) + "\n")
        os.replace(tmp, a.out); print("written", a.out, len(ws))
    return 0

if __name__ == "__main__": sys.exit(main())
