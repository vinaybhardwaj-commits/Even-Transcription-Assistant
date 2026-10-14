#!/usr/bin/env python3
"""run_tier_batch.py -- W46 switch (Fable 29 Sep): consult population + surgery outcome from linker's
link-tiers (~/eta-data/linker/link-tiers/<day>.jsonl, code linker/w49-link-tiers @ c931eacb) instead of only
the CAP consults that happened to link to a Pulse Rx.

Base link = the PQM CONSULTATION step (token/doctor/called_at/completed_at), per linker's caveats (#5728):
  - T1 `tape_available` is NOT room evidence (multi-room); this script never reads `t1`, never assigns a room,
    and emits no room field. T2 (voice) does not exist yet; CAP consumes T3 only.
  - rows with not_a_consult=true are dropped; conflicting_status rows are kept but flagged.
Pitch detection needs a room, so it is NOT redone here: the existing run_cap_batch.py output
(cap-batch-<day>.json, T3 content-match) is attached by time-span match (CAP span vs step called/completed
within +-TOL_S, unique match only; ambiguous or absent -> pitch_join says why, never guessed).

Per consult: individual_uid from queue_tokens.metadata->>'INDIVIDUAL_UID', then surgery_cases (non-CANCELLED,
created_at in [consult_at, consult_at+90d], consult_at = called_at (else completed_at), so a case booked DURING
the consult counts; the EARLIEST case in the window wins) -> booked (+days_to_surgery, same_doctor) / not_booked_yet
(window still open) / not_booked (window elapsed) / no_individual / no_anchor. referred_out is NOT computable
here (needs the Rx consult_uid); it only exists on rows carried from the cap-batch pitch layer.

Read-only: link-tiers + cap-batch files in, Metabase read-only (mb.py), no network besides that, no Jev.
Output ~/eta-data/surg-link/tier-batch-<day>.json {"day","partial_day","generated_at","results":[...]},
0600 via atomic temp+replace, dir 0700. Recomputed from scratch every run (cheap; outcomes mature).
Prints only aggregate counts. Usage: run_tier_batch.py [YYYY-MM-DD ...]   (default: every link-tiers day >= MIN_DAY)
"""
import datetime as dt
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "dev", "eta-lab",
                                "studies", "2026-09-24-surgery-30"))

HOME = os.path.expanduser("~/eta-data")
TIERS_DIR = f"{HOME}/linker/link-tiers"
CAP_DIR = f"{HOME}/cap"
OUT = f"{HOME}/surg-link"
MIN_DAY = "2026-09-22"
WINDOW_DAYS = 90
TOL_S = 90
CHUNK = 200
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
_DAY_RX = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ID_RX = re.compile(r"[A-Za-z0-9_\-]+")


def _parse_ts(s):
    """created_at/called_at are Postgres timestamptz and mb returns them with an explicit offset (checked 29 Sep:
    '2026-09-29T11:34:12+05:30'), so conversion to IST is exact; a naive string is assumed to already be IST.
    IST-naive datetime from '2026-09-22 08:59:00 +0530', ISO with offset/Z, or a datetime; None if empty."""
    if s is None or s == "":
        return None
    if isinstance(s, dt.datetime):
        d = s
    else:
        s = str(s).strip().replace("Z", "+00:00")
        try:
            d = dt.datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z")
        except ValueError:
            d = dt.datetime.fromisoformat(s)
    if d.tzinfo:
        d = d.astimezone(IST).replace(tzinfo=None)
    return d


def _atomic_write_0600(path, write_fn):
    tmp = f"{path}.tmp{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            write_fn(f)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


DROPPED_IDS = 0


def _in(vals):
    global DROPPED_IDS
    keep = sorted(set(v for v in vals if v and _ID_RX.fullmatch(str(v))))
    DROPPED_IDS += len(set(v for v in vals if v)) - len(keep)
    return ",".join(f"'{v}'" for v in keep)


def _chunks(seq, n=CHUNK):
    seq = sorted(set(seq))
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _rows(sql):
    import mb
    cols, rows, trunc = mb.query(sql)
    if trunc:
        raise SystemExit("mb: rows_truncated")
    return [dict(zip(cols, r)) for r in rows]


def fetch_individuals(token_uids):
    out = {}
    for ch in _chunks(token_uids):
        for r in _rows(f"select uid, metadata->>'INDIVIDUAL_UID' as individual_uid from queue_tokens "
                       f"where uid in ({_in(ch)})"):
            if r.get("individual_uid"):
                out[r["uid"]] = r["individual_uid"]
    return out


def fetch_cases(individual_uids):
    out = {}
    for ch in _chunks(individual_uids):
        for r in _rows(f"select uid, individual_uid, created_at, status, treating_doctor_uid, procedure_name "
                       f"from surgery_cases where individual_uid in ({_in(ch)})"):
            if (r.get("status") or "").upper() == "CANCELLED":
                continue
            r["created_at"] = _parse_ts(r["created_at"])
            if r["created_at"] is None:
                continue
            out.setdefault(r["individual_uid"], []).append(r)
    return out


def load_tiers(day):
    p = f"{TIERS_DIR}/{day}.jsonl"
    if not os.path.exists(p):
        return [], {}
    rows = [json.loads(l) for l in open(p) if l.strip()]
    mp = f"{TIERS_DIR}/{day}.meta.json"
    meta = json.load(open(mp)) if os.path.exists(mp) else {}
    return rows, meta


def load_pitch_layer(day):
    """[(span_start, span_end, cap_row)] for CAP consults that have a span and a cap-batch row; else []."""
    cp = f"{OUT}/cap-batch-{day}.json"
    lp = f"{CAP_DIR}/{day}/links.jsonl"
    if not (os.path.exists(cp) and os.path.exists(lp)):
        return []
    d = json.load(open(cp))
    res = {r["consult_id"]: r for r in d.get("results", [])} if isinstance(d, dict) else {}
    out = []
    for l in open(lp):
        l = json.loads(l)
        r = res.get(l.get("consult_id"))
        if r and l.get("span"):
            out.append((_parse_ts(l["span"][0]), _parse_ts(l["span"][1]), r))
    return out


def _near(a, b, called, completed, tol_s=TOL_S):
    return abs((a - called).total_seconds()) <= tol_s and abs((b - completed).total_seconds()) <= tol_s


def join_pitch(called, completed, layer, step_times=(), tol_s=TOL_S):
    """Unique match in BOTH directions: exactly one CAP span near this step, and that CAP span near exactly one
    step (step_times = every real consult's (called, completed)); a parallel-doctor pair can otherwise share one
    CAP span. Returns (pitch_join, cap_row|None)."""
    if not layer:
        return "no_cap_layer", None
    if called is None or completed is None:
        return "no_step_times", None
    hits = [(a, b, r) for a, b, r in layer if _near(a, b, called, completed, tol_s)]
    if not hits:
        return "no_cap_match", None
    if len(hits) > 1:
        return "ambiguous_time_match", None
    a, b, r = hits[0]
    if sum(1 for c, d in step_times if c is not None and d is not None and _near(a, b, c, d, tol_s)) != 1:
        return "ambiguous_time_match", None
    return "matched", r


def classify(anchor, individual, cases_by_ind, doctor_uid, now, window_days=WINDOW_DAYS):
    if anchor is None:
        return {"outcome": "no_anchor"}
    if not individual:
        return {"outcome": "no_individual"}
    hi = anchor + dt.timedelta(days=window_days)
    cands = [c for c in cases_by_ind.get(individual, []) if anchor <= c["created_at"] <= hi]
    if cands:
        c = min(cands, key=lambda c: c["created_at"])
        return {"outcome": "booked", "days_to_surgery": (c["created_at"] - anchor).days,
                "case_uid": c["uid"], "case_created_at": c["created_at"].isoformat(),
                "procedure_name": c.get("procedure_name"),
                "same_doctor": c.get("treating_doctor_uid") == doctor_uid}
    return {"outcome": "not_booked" if now >= hi else "not_booked_yet"}


def build_rows(tier_rows, individuals, cases_by_ind, layer, now):
    out = []
    step_times = [(_parse_ts(r.get("called_at")), _parse_ts(r.get("completed_at")))
                  for r in tier_rows if not r.get("not_a_consult")]
    for r in tier_rows:
        if r.get("not_a_consult"):
            continue
        called, completed = _parse_ts(r.get("called_at")), _parse_ts(r.get("completed_at"))
        anchor = called or completed
        tok = r["token_uid"]
        row = {"step_uid": r["step_uid"], "token_uid": tok, "doctor_uid": r.get("doctor_uid"),
               "status": r.get("status"), "conflicting_status": bool(r.get("conflicting_status")),
               "consult_at": anchor.isoformat() if anchor else None,
               "individual_uid": individuals.get(tok)}
        row.update(classify(anchor, individuals.get(tok), cases_by_ind, r.get("doctor_uid"), now))
        pj, cap = join_pitch(called, completed, layer, step_times)
        row["pitch_join"] = pj
        if cap:
            row["pitch_outcome"] = cap.get("outcome")
            row["family_guess"] = cap.get("family_guess")
        out.append(row)
    return out


def days_to_run(argv):
    if argv:
        for d in argv:
            if not _DAY_RX.match(d):
                raise SystemExit(f"bad day: {d}")
        return argv
    days = sorted(os.path.basename(p)[:-6] for p in glob.glob(f"{TIERS_DIR}/*.jsonl"))
    return [d for d in days if _DAY_RX.match(d) and d >= MIN_DAY]


def run(days, now=None, fetch_ind=fetch_individuals, fetch_cs=fetch_cases):
    now = now or dt.datetime.now(IST).replace(tzinfo=None)
    os.makedirs(OUT, exist_ok=True, mode=0o700)
    os.chmod(OUT, 0o700)
    summaries = {}
    for day in days:
        tier_rows, meta = load_tiers(day)
        if not tier_rows:
            print(f"{day}: no link-tiers rows, skipped")
            continue
        real = [r for r in tier_rows if not r.get("not_a_consult")]
        individuals = fetch_ind([r["token_uid"] for r in real])
        cases = fetch_cs(list(individuals.values()))
        rows = build_rows(tier_rows, individuals, cases, load_pitch_layer(day), now)
        doc = {"day": day, "partial_day": bool(meta.get("partial_day")),
               "generated_at": now.isoformat(), "results": rows}
        _atomic_write_0600(f"{OUT}/tier-batch-{day}.json", lambda f: json.dump(doc, f))
        oc, pj = {}, {}
        for r in rows:
            oc[r["outcome"]] = oc.get(r["outcome"], 0) + 1
            pj[r["pitch_join"]] = pj.get(r["pitch_join"], 0) + 1
        summaries[day] = {"consults": len(rows), "partial_day": doc["partial_day"], "outcomes": oc,
                          "pitch_join": pj, "conflicting_status": sum(r["conflicting_status"] for r in rows)}
        print(f"{day}: {summaries[day]}")
    if DROPPED_IDS:
        print(f"WARNING: {DROPPED_IDS} ids failed the id-shape filter and were left out of the DB lookups")
    print("NOTE: base link = PQM step (patient/doctor/time). No room is assigned (T1 tape is not room evidence); "
          "pitch attached only on a unique CAP time-span match; referred_out only exists on the pitch layer.")
    return summaries


def selftest():
    now = dt.datetime(2026, 9, 29, 12, 0)
    d0 = _parse_ts("2026-09-22 09:11:14 +0530")
    assert d0 == dt.datetime(2026, 9, 22, 9, 11, 14)
    assert _parse_ts("2026-09-22T03:41:14Z") == dt.datetime(2026, 9, 22, 9, 11, 14)
    assert _parse_ts(None) is None and _parse_ts("") is None

    def T(step, tok, doc, called, done, **kw):
        return {"step_uid": step, "token_uid": tok, "doctor_uid": doc, "called_at": called,
                "completed_at": done, "status": "COMPLETE", "not_a_consult": False,
                "conflicting_status": False, **kw}
    tiers = [
        T("s1", "t1", "dA", "2026-09-22 09:00:00 +0530", "2026-09-22 09:10:00 +0530"),
        T("s2", "t2", "dA", "2026-09-22 10:00:00 +0530", "2026-09-22 10:10:00 +0530"),
        T("s3", "t3", "dB", "2026-09-22 10:00:30 +0530", "2026-09-22 10:10:30 +0530"),   # parallel with s2
        T("s4", "t4", "dB", "2026-09-22 11:00:00 +0530", "2026-09-22 11:05:00 +0530", not_a_consult=True),
        T("s5", "t5", "dB", "2026-09-22 12:00:00 +0530", "2026-09-22 12:05:00 +0530", conflicting_status=True),
        T("s6", "t6", "dB", None, None),
        T("s7", "t7", "dB", "2026-09-28 12:00:00 +0530", "2026-09-28 12:05:00 +0530"),
    ]
    inds = {"t1": "p1", "t2": "p2", "t3": "p3", "t5": "p5", "t6": "p6", "t7": "p7"}
    cases = {"p1": [{"uid": "c1", "individual_uid": "p1", "created_at": dt.datetime(2026, 9, 25, 9, 0),
                     "treating_doctor_uid": "dA", "procedure_name": "X"},
                    {"uid": "c1b", "individual_uid": "p1", "created_at": dt.datetime(2026, 9, 22, 9, 5),
                     "treating_doctor_uid": "dA", "procedure_name": "during-consult"}],   # during the consult: counts, earliest wins
             "p2": [{"uid": "c2", "individual_uid": "p2", "created_at": dt.datetime(2027, 1, 30),
                     "treating_doctor_uid": "dA", "procedure_name": "late"}]}         # beyond 90d: excluded
    cap = [(dt.datetime(2026, 9, 22, 9, 0, 5), dt.datetime(2026, 9, 22, 9, 10, 5), {"outcome": "pitched_booked_x",
                                                                                    "family_guess": "fam"}),
           (dt.datetime(2026, 9, 22, 10, 0, 10), dt.datetime(2026, 9, 22, 10, 10, 10), {"outcome": "no_pitch"})]
    rows = {r["step_uid"]: r for r in build_rows(tiers, inds, cases, cap, now)}
    assert "s4" not in rows, "not_a_consult dropped"
    assert rows["s1"]["outcome"] == "booked" and rows["s1"]["case_uid"] == "c1b" and rows["s1"]["same_doctor"] is True
    assert rows["s1"]["days_to_surgery"] == 0, "booked during the consult (09:05 in a 09:00-09:10 visit) is booked"
    assert classify(dt.datetime(2026, 9, 22, 9, 0), "p1", {"p1": [cases["p1"][0]]}, "dA", now)["days_to_surgery"] == 3
    assert classify(dt.datetime(2026, 9, 22, 9, 6), "p1", {"p1": [cases["p1"][1]]}, "dA", now)["outcome"] == "not_booked_yet", "case before the consult start is excluded"
    assert rows["s1"]["pitch_join"] == "matched" and rows["s1"]["family_guess"] == "fam"
    assert rows["s2"]["outcome"] == "not_booked_yet", "case beyond 90d not counted; window still open on 29 Sep"
    late = {r["step_uid"]: r for r in build_rows(tiers, inds, cases, cap, dt.datetime(2027, 3, 1))}
    assert late["s2"]["outcome"] == "not_booked", "window elapsed and only case is beyond 90d"
    assert rows["s2"]["pitch_join"] == "ambiguous_time_match" and "pitch_outcome" not in rows["s2"]
    assert rows["s3"]["outcome"] == "not_booked_yet"
    assert rows["s3"]["pitch_join"] == "ambiguous_time_match"
    assert rows["s5"]["conflicting_status"] is True
    assert rows["s6"]["outcome"] == "no_anchor" and rows["s6"]["pitch_join"] == "no_step_times"
    assert rows["s7"]["outcome"] == "not_booked_yet", "window still open"
    assert all("room" not in r for r in rows.values()), "never emit a room"
    assert join_pitch(dt.datetime(2026, 9, 22), dt.datetime(2026, 9, 22), [])[0] == "no_cap_layer"
    print("selftest OK: not_a_consult dropped, conflicting flagged, 90d window bounds, booked/not_booked/"
          "not_booked_yet/no_anchor/no_individual, unique-only pitch join (ambiguous never guessed), no room emitted")


def main():
    if "--selftest" in sys.argv:
        return selftest()
    run(days_to_run(sys.argv[1:]))


if __name__ == "__main__":
    main()
