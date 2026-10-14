"""W49/W46 tiered-confidence consult linking (Fable GO, 28 Sep, design PASSed vj-refuter #5482).
This increment: base PQM-span link (ALL doctors, incl. non-completed as NOT-A-CONSULT) + T0
schedule_prior (KNOWN LIMITATION: only for doctor_uid Tbvyk1V5ijpcD194ZOWi/Manoj Kumar S - no
room-name-to-room_id mapping exists for the rest of the OPD schedule's named rooms, not guessed) +
T1 span_tape_available (every room with tape that day, per DESIGN-consult-linking-tiers.md's A1/A4
coverage rule) + a shifted-time null control for T1. T2 (voice_confirmed) is explicitly lx's to
build; T3 (rx_matched) is unchanged cap_link.py, referenced not recomputed here.

Usage: python3 link_tiers.py <YYYY-MM-DD>   ->  ~/eta-data/linker/link-tiers/<day>.jsonl (0600)
"""
import datetime as dt, hashlib, json, os, subprocess, sys
from multiprocessing import Pool

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-24-surgery-30"))  # in-repo mb.py, pinned by this commit
import mb

HOME = os.path.expanduser("~/eta-data/")
OUT_DIR = os.path.expanduser("~/eta-data/linker/link-tiers/")
AUDIO_DIR = HOME + "hist-mining/audio/"
RMS_CACHE = OUT_DIR + "rms-cache.json"
MANIFESTS = ("manifest.json", "manifest_tierC.json")
SILENT_RMS_FLOOR = 1e-4  # float32 full-scale RMS; 12 Sep calibration: 87/738 chunks at exactly 7e-6, next-lowest 1.25e-3
T2_MIN_EMBEDDED_S = 60.0  # DESIGN A3: T2 is NOT_TESTABLE below 60 s of scanned audio. Single source of truth: T2 (lx) must import this, not retype it.
T1_SEMANTICS = ("T1 = tape existed in some room for the span; it is NOT room evidence and must never be used "
                "alone. Room assignment is T2 (voice) only. taped_room_count>1 means several rooms recorded at once.")
MANOJ_KUMAR_S = "Tbvyk1V5ijpcD194ZOWi"
MANOJ_KUMAR_S_ROOM_BY_WEEKDAY = {0: "room_qyzghzaf", 1: "room_ux92qpws", 2: "room_qyzghzaf",
                                  3: "room_ux92qpws", 4: "room_qyzghzaf", 5: "room_ux92qpws"}  # Mon..Sat; schedule PRIOR only


def q(sql):
    cols, rows, trunc = mb.query(sql)
    assert not trunc and len(rows) < 1900, f"row cap hit: {len(rows)}"
    return cols, rows


def parse(v):
    """queue_token_steps' *_at are '... +0530' text (space-separated, not ISO8601)."""
    if not v:
        return None
    v = str(v).strip()
    for f in (None, "%Y-%m-%d %H:%M:%S %z"):
        try:
            return dt.datetime.fromisoformat(v) if f is None else dt.datetime.strptime(v, f)
        except ValueError:
            pass
    return None


def base_links(day):
    """Every completed-or-not CONSULTATION step that day, any doctor. Non-completed -> NOT-A-CONSULT (A7)."""
    d0 = dt.date.fromisoformat(day); d1 = d0 + dt.timedelta(days=1)
    cols, rows = q("SELECT uid, token_uid, status, called_at, completed_at, no_show_at, cancelled_at, "
                    "routing->>'DOCTOR_UID' AS doctor_uid FROM queue_token_steps "
                    f"WHERE station='CONSULTATION' AND called_at >= '{d0}' AND called_at < '{d1}' ORDER BY called_at, uid")
    out = []
    for r in rows:
        m = dict(zip(cols, r))
        not_a_consult = bool(m.get("no_show_at") or m.get("cancelled_at") or m.get("status") == "IN_PROGRESS")
        out.append(dict(step_uid=m["uid"], token_uid=m["token_uid"], doctor_uid=m.get("doctor_uid"),
                         called_at=m.get("called_at"), completed_at=m.get("completed_at"),
                         no_show_at=m.get("no_show_at"), cancelled_at=m.get("cancelled_at"),
                         status=m.get("status"), not_a_consult=not_a_consult))
    return out


def t0_schedule_prior(link):
    """KNOWN LIMITATION: only doctor_uid Tbvyk1V5ijpcD194ZOWi has a confirmed name->room_id mapping today.
    Every other doctor gets t0=None, not a guess (no room-name-to-room_id table exists for the schedule's
    other named rooms - flagged, not invented)."""
    if link["doctor_uid"] != MANOJ_KUMAR_S:
        return None
    c = parse(link["called_at"])
    if not c:
        return None
    return MANOJ_KUMAR_S_ROOM_BY_WEEKDAY.get(c.weekday())


def rooms_with_tape(day):
    rooms = set()
    for f in ("manifest.json", "manifest_tierC.json"):
        p = HOME + "hist/" + f
        if not os.path.exists(p):
            continue
        for j in json.load(open(p)).get("jobs", []):
            if j.get("day") == day:
                rooms.add(j["room_id"])
    return sorted(rooms)


def chunk_windows(day, room, with_key=False):
    """[(start_dt, end_dt), ...] for every chunk of that room-day, sorted, from either manifest.
    with_key=True -> (start, end, local_audio_basename) for the signal check."""
    out = []
    for f in MANIFESTS:
        p = HOME + "hist/" + f
        if not os.path.exists(p):
            continue
        for j in json.load(open(p)).get("jobs", []):
            if j.get("day") == day and j.get("room_id") == room:
                for c in j.get("chunks", []):
                    s, e = c.get("started_at"), c.get("ended_at")
                    if s and e:
                        t = (dt.datetime.fromisoformat(s.replace("Z", "+00:00")), dt.datetime.fromisoformat(e.replace("Z", "+00:00")))
                        out.append(t + (c.get("r2_key", "").replace("/", "__"),) if with_key else t)
    out.sort()
    return out


def coverage(windows, a, b):
    """(covered_fraction, max_gap_seconds) of [a,b] by the sorted, possibly-overlapping windows."""
    span_s = (b - a).total_seconds()
    if span_s <= 0:
        return 0.0, 0.0
    merged = []
    for s, e in windows:
        s, e = max(s, a), min(e, b)
        if s >= e:
            continue
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    covered = sum((e - s).total_seconds() for s, e in merged)
    cur = a; max_gap = 0.0
    for s, e in merged:
        max_gap = max(max_gap, (s - cur).total_seconds()); cur = e
    max_gap = max(max_gap, (b - cur).total_seconds())
    return covered / span_s, max_gap


def _rms_one(name):
    import numpy as np
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", AUDIO_DIR + name, "-f", "f32le", "-ac", "1", "-ar", "8000", "-"],
                       capture_output=True)
    x = np.frombuffer(r.stdout, dtype=np.float32)
    return name, (float(np.sqrt(np.mean(x.astype("float64") ** 2))) if len(x) else None)


def load_rms_cache():
    try:
        return json.load(open(RMS_CACHE))
    except (OSError, ValueError):
        return {}


def fill_rms_cache(names):
    """Decode every local chunk not yet in the cache (parallel); chunks with no local audio stay absent = UNKNOWN."""
    cache = load_rms_cache()
    todo = [n for n in dict.fromkeys(names) if n not in cache and os.path.exists(AUDIO_DIR + n)]
    if todo:
        with Pool(8) as p:
            cache.update(dict(p.map(_rms_one, todo, chunksize=4)))
        os.makedirs(OUT_DIR, mode=0o700, exist_ok=True)
        with open(RMS_CACHE, "w") as f:
            json.dump(cache, f)
        os.chmod(RMS_CACHE, 0o600)
    return cache


def signal_state(keyed_windows, a, b, rms, floor=SILENT_RMS_FLOOR):
    """Signal over [a,b] for one room. 'silent' iff >=1 overlapping chunk has known RMS and ALL known ones are
    below floor; 'present' iff any known chunk >= floor; 'unknown' iff no overlapping chunk has a known RMS.
    Silent tape is NOT_TESTABLE for voice tiers, never ABSENT (vj-refuter #5504)."""
    known = [rms[k] for s, e, k in keyed_windows if s < b and e > a and rms.get(k) is not None]
    if not known:
        return "unknown"
    return "present" if max(known) >= floor else "silent"


def signal_detail(keyed_windows, a, b, rms, floor=SILENT_RMS_FLOOR):
    """Seconds of the span [a,b] covered by chunks with known-silent / known-audible / unmeasured RMS.
    Overlapping chunk windows are counted once per class by clipping to the span (chunks are ~non-overlapping)."""
    sil = aud = unk = 0.0
    for s, e, k in keyed_windows:
        d = (min(e, b) - max(s, a)).total_seconds()
        if d <= 0:
            continue
        v = rms.get(k)
        if v is None:
            unk += d
        elif v >= floor:
            aud += d
        else:
            sil += d
    known = sil + aud
    return dict(span_s=round((b - a).total_seconds(), 1), silent_s=round(sil, 1), audible_s=round(aud, 1), unmeasured_s=round(unk, 1),
                silent_fraction=round(sil / known, 3) if known else None)


def voice_testable_rule(sig, detail, span_s):
    """Not testable if all-silent, or if measured audible tape in the span is < T2_MIN_EMBEDDED_S (partial mic failure).
    Audible RMS tape is an UPPER bound on what T2 can embed (speech turns only), so this can over-report testable, never under."""
    if sig == "silent":
        return False
    if sig in (None, "unknown"):
        return True   # never measured / not checked; consumers must read signal_measured
    return detail["audible_s"] >= T2_MIN_EMBEDDED_S


def t1_span_tape_available(link, day, room_windows_cache, keyed_cache=None, rms=None):
    """Every room with ANY tape that day (A1 - not just T0's guess). PASS iff coverage>=90% and no gap>30s (A4)."""
    c, e = parse(link["called_at"]), parse(link["completed_at"])
    if not c:
        return []
    if not e or e < c:
        e = c + dt.timedelta(hours=1)
    a_utc = c.astimezone(dt.timezone.utc); b_utc = e.astimezone(dt.timezone.utc)
    results = []
    for room in room_windows_cache:
        frac, gap = coverage(room_windows_cache[room], a_utc, b_utc)
        taped = bool(frac >= 0.90 and gap <= 30.0)
        sig = signal_state(keyed_cache[room], a_utc, b_utc, rms) if (taped and keyed_cache is not None) else None
        det = signal_detail(keyed_cache[room], a_utc, b_utc, rms) if sig is not None else None
        results.append(dict(room=room, covered_fraction=round(frac, 3), max_gap_s=round(gap, 1), taped=taped,
                             signal=sig, signal_measured=(sig in ("present", "silent")), tape_silent=(sig == "silent"),
                             signal_detail=det,
                             voice_testable=bool(taped and voice_testable_rule(sig, det, (b_utc - a_utc).total_seconds()))))
    return results


def t1_null_control(link, day, room_windows_cache, shift_minutes=(120, -120, 240, -240)):
    """Shifted-time control (A/the design's machine-only accuracy #1): does T1 pass similarly often on a
    shifted window that was never a real consult? A high shifted-pass rate would mean T1 isn't discriminating
    real consult timing (tape is just always on); a low one means T1's PASS is informative."""
    c, e = parse(link["called_at"]), parse(link["completed_at"])
    if not c:
        return None
    if not e or e < c:
        e = c + dt.timedelta(hours=1)
    passes = 0; n = 0
    for m in shift_minutes:
        a2 = (c + dt.timedelta(minutes=m)).astimezone(dt.timezone.utc)
        b2 = (e + dt.timedelta(minutes=m)).astimezone(dt.timezone.utc)
        for room in room_windows_cache:
            frac, gap = coverage(room_windows_cache[room], a2, b2)
            n += 1
            if frac >= 0.90 and gap <= 30.0:
                passes += 1
    return dict(shifted_trials=n, shifted_pass=passes, shifted_pass_rate=round(passes / n, 3) if n else None)


def manifest_provenance():
    out = {}
    for f in MANIFESTS:
        p = HOME + "hist/" + f
        if os.path.exists(p):
            out[f] = dict(sha256_12=hashlib.sha256(open(p, "rb").read()).hexdigest()[:12],
                          mtime=dt.datetime.fromtimestamp(os.path.getmtime(p)).astimezone().isoformat(timespec="seconds"))
    return out


def build_day(day):
    prov = manifest_provenance()
    links = base_links(day)
    rooms = rooms_with_tape(day)
    room_windows_cache = {r: chunk_windows(day, r) for r in rooms}
    keyed = {r: chunk_windows(day, r, with_key=True) for r in rooms}
    rms = fill_rms_cache([k for r in rooms for _, _, k in keyed[r]])
    out = []
    for link in links:
        rec = dict(link)
        rec["conflicting_status"] = bool(link["status"] == "COMPLETE" and (link["no_show_at"] or link["cancelled_at"]))
        rec["t0_schedule_prior"] = t0_schedule_prior(link)
        if link["not_a_consult"]:
            rec["t1"] = None; rec["t1_null_control"] = None; rec["taped_room_count"] = None
        else:
            rec["t1"] = t1_span_tape_available(link, day, room_windows_cache, keyed, rms)
            rec["t1_null_control"] = t1_null_control(link, day, room_windows_cache)
            rec["taped_room_count"] = sum(1 for x in rec["t1"] if x["taped"])
        rec["t1_semantics"] = T1_SEMANTICS
        out.append(rec)
    # partial day: chunk manifests may still be filling (today) or end before the last consult
    last_end = max((w[1] for r in rooms for w in room_windows_cache[r]), default=None)
    last_call = max((parse(l["called_at"]) for l in links if parse(l["called_at"])), default=None)
    partial = bool(day >= dt.date.today().isoformat() or (last_end and last_call and last_end < last_call.astimezone(dt.timezone.utc)))
    silent_rd = sorted({(r["t1"] and x["room"]) for r in out if r["t1"] for x in r["t1"] if x["tape_silent"]} - {None})
    summary = dict(day=day, total=len(out), not_a_consult=sum(1 for r in out if r["not_a_consult"]),
                   conflicting_status=sum(1 for r in out if r["conflicting_status"]),
                   consults=sum(1 for r in out if not r["not_a_consult"]),
                   t1_taped_some_room=sum(1 for r in out if r["t1"] and any(x["taped"] for x in r["t1"])),
                   t1_multi_room=sum(1 for r in out if (r["taped_room_count"] or 0) > 1),
                   consults_with_silent_room=sum(1 for r in out if r["t1"] and any(x["tape_silent"] for x in r["t1"])),
                   tape_silent_rooms=silent_rd, tape_silent_room_count=len(silent_rd),
                   short_span_lt_t2_bar_consult_rooms=sum(1 for r in out if r["t1"] for x in r["t1"] if x["taped"] and x["signal"] == "present" and not x["voice_testable"] and x["signal_detail"]["span_s"] < T2_MIN_EMBEDDED_S),
                   partial_mic_failure_consult_rooms=sum(1 for r in out if r["t1"] for x in r["t1"] if x["taped"] and x["signal"] == "present" and not x["voice_testable"] and x["signal_detail"]["span_s"] >= T2_MIN_EMBEDDED_S),
                   voice_testable_but_unmeasured=sum(1 for r in out if r["t1"] for x in r["t1"] if x["voice_testable"] and not x["signal_measured"]),
                   signal_unknown_consult_rooms=sum(1 for r in out if r["t1"] for x in r["t1"] if x["taped"] and x["signal"] == "unknown"),
                   silent_rms_floor=SILENT_RMS_FLOOR, partial_day=partial, manifests=prov, t1_semantics=T1_SEMANTICS)
    os.makedirs(OUT_DIR, mode=0o700, exist_ok=True); os.chmod(OUT_DIR, 0o700)
    p = OUT_DIR + day + ".jsonl"
    with open(p, "w") as f:
        for r in out:
            f.write(json.dumps(r) + "\n")
    os.chmod(p, 0o600)
    mp = OUT_DIR + day + ".meta.json"
    with open(mp, "w") as f:
        json.dump(summary, f, indent=1)
    os.chmod(mp, 0o600)
    return out, p, summary


if __name__ == "__main__":
    day = sys.argv[1]
    out, p, summary = build_day(day)
    print(json.dumps(dict(summary, out=p)))
