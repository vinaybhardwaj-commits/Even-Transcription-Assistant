#!/usr/bin/env python3
"""m3-20: daily encounter reconciliation. Read-only on every source. For one IST day and every OPD room it reports PQM visits, visits placed, Pulse windows, clips cut, clips not cut (with reasons),
palimpsest lane tracks, R2 mirror state and tape hours; raises alerts; writes <out>/<date>.json, <out>/<date>.md and appends one line per alert to the alert spool.
Exit 0 even when alerts fire or encounters.json is missing (status nodata + alert pqm_missing); exit 2 on a corrupt or unreadable input; 4 when the R2 upload failed (local outputs already written); 6 when the export leak guard fired (nothing uploaded).
  ~/oc/consult/cutter-venv/bin/python tools/daily_recon.py [--date YYYY-MM-DD | --auto] [--out DIR] [--alerts FILE] [--eta-data DIR] [--labels FILE] [--no-db] [--no-r2]
--auto: after 18:00 IST reconcile today, before it reconcile yesterday (one service for the 22:00 and 10:00 timers)."""
import argparse, collections, hashlib, re, datetime as dt, json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))          # tools/index_mirror.py: R2 client and leak guards are reused
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
H = os.path.expanduser("~")
LABELS = f"{H}/oc/palimpsest/in/room-labels.json"
TAPE_MIN_H = 2.0          # tape hours at or above which 0 clips is an alert
CLIP_RATIO_MIN = 0.80     # clips / placed visits
LANE_MIN = 0.95           # lane tracks / clips (after the grace)
LANE_GRACE_S = 3 * 3600   # a clip younger than this is not yet counted against a lane
UNPLACED_MAX = 0.20       # unplaced visits / all visits (day level)
LANES = ("sarvam", "nemotron", "role", "acoustics")

class BrokenInput(Exception): pass

def _json(path, what):
    try:
        with open(path) as fh: return json.load(fh)
    except Exception as e: raise BrokenInput(f"{what} {path}: {type(e).__name__}: {e}")

def load_rooms(path):
    j = _json(path, "room labels")
    try: rooms = [(r["room_id"], r["label"]) for r in j["rooms"]]
    except Exception as e: raise BrokenInput(f"room labels {path}: bad shape ({type(e).__name__}: {e})")
    return [(i, l) for i, l in rooms if not l.upper().startswith("ORB")]      # OPD rooms only: the OT rooms are not consult rooms

def _visits(path, what):
    j = _json(path, what)
    if not isinstance(j, dict) or not isinstance(j.get("encounters"), list): raise BrokenInput(f"{what} {path}: no 'encounters' list")
    for e in j["encounters"]:
        if not isinstance(e, dict) or not e.get("step_uid"): raise BrokenInput(f"{what} {path}: an encounter has no step_uid")
    return j["encounters"]

def load_visits(eta, date):
    """PQM visits for the day; encounters.placed.json (m3-19) overrides the room of a visit when present and names one."""
    d = f"{eta}/drtpqma/{date}"
    if not os.path.exists(f"{d}/encounters.json"): return None                     # not pulled yet: status nodata, not a broken input
    vis = {e["step_uid"]: dict(e) for e in _visits(f"{d}/encounters.json", "encounters")}
    pp = f"{d}/encounters.placed.json"
    if os.path.exists(pp):
        for e in _visits(pp, "encounters.placed"):
            if e.get("room_id"): vis.setdefault(e["step_uid"], {}).update(e)
    return list(vis.values())

def _jsonl(path):
    rows, bad = [], 0
    if not os.path.exists(path): return rows, bad
    with open(path) as fh:
        for l in fh:
            if not l.strip(): continue
            try: rows.append(json.loads(l))
            except Exception: bad += 1
    return rows, bad

def parse_ts(v):
    """epoch seconds from 'YYYY-MM-DD HH:MM:SS(.fff)' or ISO-T (with Z or an offset); a naive time is IST. None when unparseable."""
    try:
        d = dt.datetime.fromisoformat(str(v).strip().replace("Z", "+00:00"))
        return (d if d.tzinfo else d.replace(tzinfo=IST)).timestamp()
    except Exception: return None

def load_clips(eta, date):
    rows, bad = _jsonl(f"{eta}/consult/clips/index.jsonl"); latest = {}
    for r in rows:
        if isinstance(r, dict) and r.get("consult_uid"): latest[r["consult_uid"]] = r        # latest row per uid wins
    return [r for r in latest.values() if r.get("ist_date") == date], bad

def load_tape(eta, date):
    rows, bad = _jsonl(f"{eta}/tapes/manifest.jsonl"); h = collections.defaultdict(float)
    for r in rows:
        try:
            s = dt.datetime.fromisoformat(r["started_at"].replace("Z", "+00:00")).astimezone(IST)
            if s.strftime("%Y-%m-%d") == date: h[r["room_id"]] += r["duration_ms"] / 3.6e6
        except Exception: bad += 1
    return h, bad

LANE_TRACK = {"sarvam": "stt.sarvam-saaras-v3", "nemotron": "diar.nemotron", "role": "role.text-judge"}      # palimpsest's definition of processed (#11747)
def lane_set(tracks_dir):
    """lanes present under tracks/: a lane counts when its track file exists with top-level status ok or empty (sarvam = stt.sarvam-saaras-v3, nemotron = diar.nemotron, role = role.text-judge);
    acoustics counts on file presence (acoustics.*)."""
    try: names = os.listdir(tracks_dir)
    except OSError: return set()
    s = set()
    for f in names:
        if not f.endswith(".json"): continue
        if f.startswith("acoustics"): s.add("acoustics"); continue
        for lane, pre in LANE_TRACK.items():
            if f.split("__")[0] == pre:
                try:
                    with open(os.path.join(tracks_dir, f)) as fh: st = json.load(fh).get("status")
                except Exception: continue
                if st in ("ok", "empty"): s.add(lane)
    return s

def processed(ls): return all(k in ls for k in LANE_TRACK)

def load_windows(date, no_db=False):
    """Pulse windows per room from Neon (eta_encounter_windows, read-only connection). None when unavailable: the caller falls back to the index rows."""
    if no_db: return None, False
    try:
        from cutter import db
        d0 = dt.datetime.fromisoformat(date + "T00:00:00+05:30"); d1 = d0 + dt.timedelta(days=1); out = collections.Counter()
        with db.connect() as c:
            for room, in c.execute("select room_id from eta_encounter_windows where t_open >= %s and t_open < %s", (d0, d1)).fetchall(): out[room] += 1
        return out, False
    except Exception as e:
        print(f"note: windows from Neon unavailable ({type(e).__name__}); using index rows", file=sys.stderr); return None, True

COVER_MIN = 0.5           # same rule as m3-18 (tools/pqm_windows.py PULSE_MIN_SHARE): a visit's window [start-60 s, end+60 s] is covered by a cut clip that overlaps at least half of it
def covered(e, cut_by_room, pq):
    c = pq.get(e.get("step_uid"))
    if c and c.get("status") == "cut": return True
    a, b = parse_ts(e.get("start")), parse_ts(e.get("end"))
    if a is None or b is None or b <= a: return False
    lo, hi = a - 60, b + 60
    for k in cut_by_room.get(e.get("room_id"), ()):
        o, cl = parse_ts(k.get("t_open")), parse_ts(k.get("t_close"))
        if o is not None and cl is not None and (min(hi, cl) - max(lo, o)) >= COVER_MIN * (hi - lo): return True
    return False

def build(date, rooms, visits, clips, tape, windows, eta, now=None, bad=0):
    """pure given its inputs (lane tracks are read from disk under eta). now = epoch seconds."""
    now = time.time() if now is None else now
    label = dict(rooms); order = [r for r, _ in rooms]
    for c in clips:
        if c.get("room_id") and c["room_id"] not in label: label[c["room_id"]] = c.get("room_slug") or c["room_id"]; order.append(c["room_id"])
    placed_raw = visits; visits = visits or []
    cut_by_room = collections.defaultdict(list)
    for c in clips:
        if c.get("status") == "cut": cut_by_room[c.get("room_id")].append(c)
    pq = {c.get("pqm_step_uid"): c for c in clips if c.get("boundary_source") == "pqm"}
    unplaced = collections.Counter(str(e.get("room_unknown_reason") or "unknown").split(":")[0] for e in visits if not e.get("room_id"))
    day = dict(pqm_visits=len(visits), placed=sum(1 for e in visits if e.get("room_id")), unplaced=sum(unplaced.values()), unplaced_reasons=dict(unplaced))
    out = []
    for rid in order:
        rv = [e for e in visits if e.get("room_id") == rid]; rc = [c for c in clips if c.get("room_id") == rid]
        cut = [c for c in rc if c.get("status") == "cut"]; nocut = collections.Counter((c.get("skip_reason") or c.get("status") or "unknown") for c in rc if c.get("status") != "cut")
        pulse_n = windows[rid] if windows is not None else sum(1 for c in rc if c.get("boundary_source") != "pqm")
        proc = 0; lanes = {k: 0 for k in LANES}; graced = {k: 0 for k in LANES}; ngrace = 0
        for c in cut:
            ls = lane_set(f"{eta}/reb/{date}/{rid}/_consults/{c['consult_uid']}/tracks"); proc += processed(ls)
            t_close = parse_ts(c.get("t_close")) or 0
            old = now - t_close >= LANE_GRACE_S; ngrace += old
            for k in LANES:
                if k in ls:
                    lanes[k] += 1
                    if old: graced[k] += 1
        miss = collections.Counter()
        for e in rv:
            if covered(e, cut_by_room, pq): continue
            c = pq.get(e["step_uid"])
            miss[("pqm_clip_" + str(c.get("skip_reason") or c.get("status"))) if c else "no_cut_clip"] += 1
        out.append(dict(room_id=rid, room=label[rid], pqm_visits=len(rv), placed=len(rv), pulse_windows=pulse_n, clips_cut=len(cut),
                        clips_pulse=sum(1 for c in cut if c.get("boundary_source") != "pqm"), clips_pqm=sum(1 for c in cut if c.get("boundary_source") == "pqm"),
                        clips_not_cut=sum(nocut.values()), not_cut_reasons=dict(nocut), not_isolated=sum(miss.values()), visit_miss_reasons=dict(miss),
                        processed=proc, lanes=lanes, lane_graced_clips=ngrace, lane_graced=graced, r2_mirrored=sum(1 for c in cut if (c.get("r2") or {}).get("status") == "mirrored"),
                        r2_pending=sum(1 for c in cut if (c.get("r2") or {}).get("status") != "mirrored"), tape_h=round(tape.get(rid, 0.0), 1)))
    missing = placed_raw is None
    alerts = []
    def al(room, code, count, msg): alerts.append(dict(date=date, room=room, code=code, count=int(count), message=msg))
    for r in out:
        codes = []
        if missing: r["status"] = "nodata"; continue
        if r["tape_h"] >= TAPE_MIN_H and r["clips_cut"] == 0: al(r["room"], "tape_no_clips", round(r["tape_h"]), f"{r['tape_h']} h of tape and 0 clips"); codes.append("alert")
        if r["placed"] and r["clips_cut"] / r["placed"] < CLIP_RATIO_MIN: al(r["room"], "clips_low", r["clips_cut"], f"{r['clips_cut']} clips for {r['placed']} placed visits ({100 * r['clips_cut'] // r['placed']}%, under {int(CLIP_RATIO_MIN * 100)}%)"); codes.append("alert")
        for k in LANES:
            if r["lane_graced_clips"] and r["lane_graced"][k] / r["lane_graced_clips"] < LANE_MIN: al(r["room"], f"lane_{k}_low", r["lane_graced_clips"] - r["lane_graced"][k], f"lane {k} on {r['lane_graced'][k]} of {r['lane_graced_clips']} clips older than 3 h (under {int(LANE_MIN * 100)}%)"); codes.append("warn")
        if r["r2_pending"]: al(r["room"], "r2_pending", r["r2_pending"], f"{r['r2_pending']} clips not yet mirrored to R2"); codes.append("warn")
        r["status"] = "alert" if "alert" in codes else "warn" if codes else ("ok" if (r["placed"] or r["clips_cut"] or r["pulse_windows"] or r["tape_h"]) else "nodata")
        r["alerts"] = [dict(code=a["code"], message=a["message"], count=a["count"]) for a in alerts if a["room"] == r["room"]]
    if missing: al(None, "pqm_missing", 1, "no PQM encounters file for this day; every room is nodata")
    elif day["pqm_visits"] and day["unplaced"] / day["pqm_visits"] > UNPLACED_MAX:
        al(None, "unplaced_high", day["unplaced"], f"{day['unplaced']} of {day['pqm_visits']} visits have no room ({100 * day['unplaced'] // day['pqm_visits']}%, over {int(UNPLACED_MAX * 100)}%)")
    for r in out: r.setdefault("alerts", [])
    return dict(date=date, pqm_present=not missing, generated_at=dt.datetime.fromtimestamp(now, IST).isoformat(timespec="seconds"), windows_source="neon" if windows is not None else "index",
                bad_input_lines=bad, day=day, rooms=out, alerts=alerts,
                thresholds=dict(tape_min_h=TAPE_MIN_H, clips_over_placed_min=CLIP_RATIO_MIN, lane_min=LANE_MIN, lane_grace_h=LANE_GRACE_S / 3600, unplaced_max=UNPLACED_MAX))

def render_md(rep):
    d = rep["day"]; L = [f"# Daily reconciliation {rep['date']}", "",
        f"{len(rep['alerts'])} alert(s). {d['pqm_visits']} PQM visits, {d['placed']} placed in a room, {d['unplaced']} with no room. Pulse windows counted from {rep['windows_source']}. Generated {rep['generated_at']}.", ""]
    if rep["alerts"]: L += ["## Alerts", ""] + [f"- {a['room'] or 'whole day'}: {a['message']}" for a in rep["alerts"]] + [""]
    L += ["## Rooms", "", "| room | PQM visits placed | Pulse windows | clips cut | not cut | processed | sarvam | nemotron | role | acoustics | R2 mirrored | R2 pending | tape h |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rep["rooms"]: L.append(f"| {r['room']} | {r['placed']} | {r['pulse_windows']} | {r['clips_cut']} | {r['clips_not_cut']} | {r['processed']} | " + " | ".join(str(r["lanes"][k]) for k in LANES) + f" | {r['r2_mirrored']} | {r['r2_pending']} | {r['tape_h']} |")
    L += ["", "## Why clips are missing", ""]
    for r in rep["rooms"]:
        bits = [f"{n} {k}" for k, n in {**r["not_cut_reasons"], **{"visit:" + k: v for k, v in r["visit_miss_reasons"].items()}}.items()]
        if bits: L.append(f"- {r['room']}: " + ", ".join(bits))
    L.append("- visits with no room: " + (", ".join(f"{n} {k}" for k, n in d["unplaced_reasons"].items()) or "none"))
    return "\n".join(L) + "\n"

def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True); tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as fh: fh.write(text); fh.flush(); os.fsync(fh.fileno())
    os.replace(tmp, path)

def _alert_state(path):
    """last (count) per key (date, room, code) already in the spool for source daily_recon; bad lines skipped."""
    st = {}
    try: fh = open(path)
    except OSError: return st
    with fh:
        for l in fh:
            try: r = json.loads(l)
            except ValueError: continue
            if isinstance(r, dict) and r.get("source") == "daily_recon" and "code" in r: st[(r.get("date"), r.get("room"), r["code"])] = r.get("count")
    return st

def append_alerts(path, alerts):
    """cutter.run.alert's line format (at, source, alert) plus date, room, code, count. Deduplicated on (date, room, code): a new key is appended; a key seen with a different count is appended again
    with superseded=true; an unchanged key is skipped. One write call, 0600."""
    if not alerts: return 0
    os.makedirs(os.path.dirname(path), exist_ok=True); st = _alert_state(path); at = time.strftime("%Y-%m-%dT%H:%M:%S%z"); lines = []
    for a in alerts:
        k = (a["date"], a["room"], a["code"])
        if k in st and st[k] == a["count"]: continue
        d = dict(at=at, source="daily_recon", alert=f"ALERT daily_recon {a['date']} {a['room'] or 'whole day'}: {a['message']}", date=a["date"], room=a["room"], code=a["code"], count=a["count"])
        if k in st: d["superseded"] = True
        lines.append(json.dumps(d) + "\n")
    if lines:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a") as fh: fh.write("".join(lines))
    return len(lines)

# ---- ENC-W3: export to R2 eta-lab-results (contract: ENC-MODULE-PRD-12-OCT-2026 "Data flow") ----
SOURCE = "daily_recon/m3-20"
def _iso(s):
    try: return dt.datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=IST).isoformat()
    except Exception: return None

def daily_rows(rep):
    out = []
    for r in rep["rooms"]:
        out.append(dict(ist_date=rep["date"], room_id=r["room_id"], visits=r["pqm_visits"], placed=r["placed"], isolated=r["clips_cut"], isolated_pulse=r["clips_pulse"], isolated_pqm=r["clips_pqm"],
                        not_isolated=r["not_isolated"], lane_sarvam=r["lanes"]["sarvam"], lane_nemotron=r["lanes"]["nemotron"], lane_role=r["lanes"]["role"], lane_parts=0, rx_matched=0,
                        tape_hours=r["tape_h"], status=r["status"], alerts=r["alerts"], computed_at=rep["generated_at"], source=SOURCE))
    return out

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
class Refused(Exception): pass                                 # the date is not fully computed: nothing goes to R2 (exit 3)

def isolation_rows(rep, clips, visits, eta):
    """-> (rows, dropped). One row per index row of the day (latest wins; no room -> room_id 'unplaced'; status error -> skipped/'error') plus one 'planned' row per placed visit covered by no cut clip.
    ids only; no updated_at (ETA sets it). A row whose consult_uid or room_id is outside [A-Za-z0-9_-] is dropped and counted. parts and rx are null until those lanes exist."""
    date = rep["date"]; rows = []; dropped = 0
    cut_by_room = collections.defaultdict(list)
    for c in clips:
        if c.get("status") == "cut": cut_by_room[c.get("room_id")].append(c)
    pq = {c.get("pqm_step_uid"): c for c in clips if c.get("boundary_source") == "pqm"}
    def lim(v, n): return None if v is None else str(v)[:n]
    def tm(v):
        t = parse_ts(v); return None if t is None else dt.datetime.fromtimestamp(t, IST).isoformat()
    for c in clips:
        st = c.get("status"); reason = c.get("skip_reason")
        if st == "cut": status = "cut"
        elif st == "skipped": status = "skipped"
        elif st == "error": status, reason = "skipped", "error"
        elif str(st).startswith("deferred"): status = "deferred"
        else: status = "planned"
        room = c.get("room_id") or "unplaced"
        if not (ID_RE.match(str(c["consult_uid"])) and ID_RE.match(str(room))) or tm(c.get("t_open")) is None or tm(c.get("t_close")) is None: dropped += 1; continue
        ls = lane_set(f"{eta}/reb/{date}/{c.get('room_id')}/_consults/{c['consult_uid']}/tracks") if c.get("room_id") else set()
        r2 = c.get("r2") or {}
        rows.append(dict(consult_uid=c["consult_uid"], ist_date=date, room_id=room, doctor_uid=lim(c.get("doctor_uid"), 128), t_start=tm(c.get("t_open")), t_end=tm(c.get("t_close")),
                         boundary_source=c.get("boundary_source") or "pulse", room_source=lim(c.get("room_source"), 64), confidence=None, status=status, skip_reason=lim(reason, 120),
                         r2_prefix=lim(r2.get("prefix"), 300) if (status == "cut" and r2.get("status") == "mirrored") else None,
                         lanes=dict({k: k in ls for k in LANES}, parts=False, processed=processed(ls)), parts=None, rx=None, pqm_step_uid=lim(c.get("pqm_step_uid"), 128)))
    for e in visits or []:
        if not e.get("room_id") or covered(e, cut_by_room, pq): continue
        uid = "planned_" + str(e["step_uid"])
        if not (ID_RE.match(uid) and ID_RE.match(str(e["room_id"]))) or tm(e.get("start")) is None or tm(e.get("end")) is None: dropped += 1; continue
        rows.append(dict(consult_uid=uid, ist_date=date, room_id=e["room_id"], doctor_uid=lim(e.get("doctor_uid"), 128), t_start=tm(e.get("start")), t_end=tm(e.get("end")),
                         boundary_source="pqm", room_source=lim(e.get("room_source"), 64), confidence=None, status="planned", skip_reason=None, r2_prefix=None,
                         lanes=dict({k: False for k in LANES}, parts=False, processed=False), parts=None, rx=None, pqm_step_uid=lim(e["step_uid"], 128)))
    return rows, dropped

def slug_guard(iso, clips):
    """upload-time only (never the local report or alerts): the room_slug/doctor_name word-overlap guard on the slugs behind r2_prefix; V's INDEX_MIRROR_SKIP_SLUG_GUARD=1 override honoured as index_mirror does."""
    import index_mirror as IM
    if os.environ.get("INDEX_MIRROR_SKIP_SLUG_GUARD") == "1": return
    try: names = IM.read_index(IM.INDEX)[3]
    except IM.ConfigError: names = set()
    with_prefix = {r["consult_uid"] for r in iso if r["r2_prefix"]}
    hits = IM.slug_name_hits([(None, {"room_slug": c.get("room_slug")}) for c in clips if c["consult_uid"] in with_prefix], names)
    if hits: raise IM.SlugNameError(hits, {})

def export_payloads(rep, iso, clips, eta):
    """-> (daily_bytes, isolation_bytes, n_daily, n_iso). Runs the index_mirror guards: no key containing name/path at any depth, no absolute path, no doctor_name of the index in any string,
    (the slug guard is separate and runs at upload only). LeakError on a hit."""
    import index_mirror as IM
    d = daily_rows(rep)
    try: names = IM.read_index(IM.INDEX)[3]
    except IM.ConfigError: names = set()
    ns = IM.name_forms(names)
    def keys(o):
        if isinstance(o, dict):
            for k, v in o.items(): yield k; yield from keys(v)
        elif isinstance(o, list):
            for v in o: yield from keys(v)
    for r in d + iso:
        for k in keys(r):
            if any(w in IM.fold(k) for w in IM.NEVER_KEY_PARTS): raise IM.LeakError("a name/path key in export")
        for t in IM.walk(r):
            if t.startswith("/") or "/home/" in t or IM.E in t: raise IM.LeakError("absolute path in export")
            ft = IM.fold(t)
            if any(n in ft for n in ns): raise IM.LeakError("a doctor_name value in export")
    db = (json.dumps(d, indent=1, sort_keys=True) + "\n").encode(); ib = "".join(json.dumps(r, sort_keys=True) + "\n" for r in iso).encode()
    return db, ib, len(d), len(iso)

def _read_manifest(client, bucket):
    try: man = json.loads(client.get_object(Bucket=bucket, Key="enc/manifest.json")["Body"].read())
    except Exception as e:
        if "NoSuchKey" not in repr(e) and "404" not in repr(e): raise                      # any other read failure must not blank the other dates
        return {}
    return man if isinstance(man, dict) else {}

MANIFEST_LOCK = f"{H}/eta-data/consult/recon/.manifest.lock"      # fixed, whatever --out is: every writer of enc/manifest.json takes the same lock
def upload(client, date, db, ib, nd, ni, lock_path, n_clip_rows, bucket=None):
    """under flock: refuse (Refused) a 0-row isolation export over a date R2 already holds rows for; put both files; re-read the manifest just before writing it; manifest last."""
    import fcntl, index_mirror as IM
    bucket = bucket or IM.BUCKET; os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    with open(lock_path, "a") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        old = _read_manifest(client, bucket).get(date) or {}
        if ni == 0 and (old.get("isolation_rows") or 0) > 0: raise Refused(f"0 isolation rows but R2 already holds {old['isolation_rows']} for {date}")
        if n_clip_rows == 0 and old:                                                  # no cut/skipped index row for the date: refuse if R2 already holds cut rows for it
            try: prev = client.get_object(Bucket=bucket, Key=f"enc/isolation/{date}.jsonl")["Body"].read().decode().splitlines()
            except Exception as e:
                if "NoSuchKey" not in repr(e) and "404" not in repr(e): raise
                prev = []
            if any('"status": "cut"' in l for l in prev): raise Refused(f"0 clip rows for {date} but R2 already holds cut rows")
        client.put_object(Bucket=bucket, Key=f"enc/daily/{date}.json", Body=db, ContentType="application/json")
        client.put_object(Bucket=bucket, Key=f"enc/isolation/{date}.jsonl", Body=ib, ContentType="application/x-ndjson")
        man = _read_manifest(client, bucket)                                                  # re-read: another writer may have added dates meanwhile
        man[date] = dict(sha256=hashlib.sha256(db).hexdigest(), rows=nd, isolation_sha256=hashlib.sha256(ib).hexdigest(), isolation_rows=ni)
        client.put_object(Bucket=bucket, Key="enc/manifest.json", Body=(json.dumps(man, indent=1, sort_keys=True) + "\n").encode(), ContentType="application/json")

def run(date, eta, labels, out, alerts_path, no_db=False, now=None, no_r2=True, client=None):
    rooms = load_rooms(labels); visits = load_visits(eta, date); clips, b1 = load_clips(eta, date); tape, b2 = load_tape(eta, date)
    windows, w_failed = load_windows(date, no_db)
    refuse = []
    if visits is None: refuse.append("pqm_missing")
    for what, p in (("index", f"{eta}/consult/clips/index.jsonl"), ("tape_manifest", f"{eta}/tapes/manifest.jsonl")):
        try: open(p).close()
        except OSError: refuse.append(f"{what}_unreadable")
    if not _jsonl(f"{eta}/consult/clips/index.jsonl")[0]: refuse.append("index_empty")
    if w_failed: refuse.append("partial_run_neon_windows_unavailable")
    rep = build(date, rooms, visits, clips, tape, windows, eta, now=now, bad=b1 + b2)
    iso, dropped = isolation_rows(rep, clips, visits, eta)
    if dropped:
        rep["alerts"].append(dict(date=date, room=None, code="bad_id", count=dropped, message=f"{dropped} rows dropped from the export: id outside [A-Za-z0-9_-] or no usable times"))
    db, ib, nd, ni = export_payloads(rep, iso, clips, eta)                     # guard first: a leak stops everything, including the local files
    write_atomic(f"{out}/{date}.json", json.dumps(rep, indent=1) + "\n"); write_atomic(f"{out}/{date}.md", render_md(rep)); append_alerts(alerts_path, rep["alerts"])
    write_atomic(f"{out}/enc/daily/{date}.json", db.decode()); write_atomic(f"{out}/enc/isolation/{date}.jsonl", ib.decode())     # local copy of exactly what is (or would be) uploaded
    rep["export"] = dict(daily_rows=nd, isolation_rows=ni, uploaded=False, refused=refuse)
    if not no_r2:
        if refuse: raise Refused(", ".join(refuse))
        import index_mirror as IM
        slug_guard(iso, clips)
        upload(client or IM.r2_client(), date, db, ib, nd, ni, MANIFEST_LOCK, sum(1 for c in clips if c.get("status") in ("cut", "skipped"))); rep["export"]["uploaded"] = True
    return rep

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--date"); ap.add_argument("--auto", action="store_true"); ap.add_argument("--no-db", action="store_true"); ap.add_argument("--no-r2", action="store_true")
    ap.add_argument("--eta-data", default=f"{H}/eta-data"); ap.add_argument("--labels", default=LABELS); ap.add_argument("--out"); ap.add_argument("--alerts")
    a = ap.parse_args(argv); now = dt.datetime.now(IST)
    date = a.date or ((now if (not a.auto or now.hour >= 18) else now - dt.timedelta(days=1)).strftime("%Y-%m-%d"))
    try: dt.date.fromisoformat(date)
    except ValueError: print(f"bad --date {date}", file=sys.stderr); return 2
    try: rep = run(date, a.eta_data, a.labels, a.out or f"{a.eta_data}/consult/recon", a.alerts or f"{a.eta_data}/consult/ALERTS.jsonl", a.no_db, no_r2=a.no_r2)
    except BrokenInput as e: print(f"BROKEN INPUT: {e}", file=sys.stderr); return 2
    except Exception as e:
        import index_mirror as IM
        if isinstance(e, Refused): print(f"R2 export refused ({e}); local outputs written, nothing uploaded", file=sys.stderr); return 3
        if isinstance(e, IM.LeakError): print("export leak guard fired; nothing written", file=sys.stderr); return 6
        if isinstance(e, IM.SlugNameError): print(f"upload refused: room_slug matches a doctor_name token in {e.hits} rows (INDEX_MIRROR_SKIP_SLUG_GUARD=1 is V's override); local outputs written, nothing uploaded", file=sys.stderr); return 5
        if isinstance(e, IM.ConfigError) or e.__class__.__module__.startswith(("botocore", "boto3")): print(f"R2 export failed ({e.__class__.__name__}); local outputs written", file=sys.stderr); return 4
        raise
    print(f"{date}: {len(rep['alerts'])} alert(s); {rep['day']['pqm_visits']} visits, {rep['day']['placed']} placed, {sum(r['clips_cut'] for r in rep['rooms'])} clips; export {rep['export']['daily_rows']} daily rows, {rep['export']['isolation_rows']} isolation rows, uploaded={rep['export']['uploaded']}"); return 0

if __name__ == "__main__": sys.exit(main())
