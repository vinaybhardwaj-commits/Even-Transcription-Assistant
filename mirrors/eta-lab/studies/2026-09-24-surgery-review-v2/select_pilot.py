#!/usr/bin/env python3
"""select_pilot.py — SURGERY-REVIEW-V2 selection by TRUTH, not keyword (orders/SURGERY-REVIEW-V2.md).

Buckets (kept in a separate key, never shown to reviewers):
  L  a non-cancelled surgery_cases row created within 48 h AFTER the consult   (linked via queue_tokens.metadata INDIVIDUAL_UID)
  F  a prescription_surgery_recommendation flag 'yes' dated the consult's IST day or the next, and no L
  N  neither
Only consults of voiceprint-confirmed room-days (>=30 clinician-attributed turns, one clinician >=80% of them) on 23-24 Sep.
Counts and ids only are printed. Output: ~/eta-data/surgery-review-v2/selection.json (0600, outside git).
"""
import csv, json, os, random, re, subprocess, sys
from datetime import datetime, timedelta, timezone, date
import mb

IST = timezone(timedelta(hours=5, minutes=30))
OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
HELPER = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
REPO = os.path.expanduser("~/dev/Even-Transcription-Assistant")
DAYS = ("2026-09-23", "2026-09-24")
PILOT = {"L": 3, "F": 1, "N": 1}
MIN_CHARS, MIN_MIN, MAX_MIN = 600, 3, 45


def neon(sql):
    r = subprocess.run(["node", HELPER, sql], cwd=REPO, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise SystemExit(f"neon-select failed rc={r.returncode}")
    return json.loads(r.stdout)


def norm(n):
    n = (n or "").strip().lower()
    for p in ("dr. ", "dr "):
        if n.startswith(p):
            n = n[len(p):]
    return re.sub(r"\s+", " ", n).strip()


def ts(s):
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=IST)


def confirmed_room_days():
    days = ",".join(f"'{d}'" for d in DAYS)
    rows = neon(f"""SELECT rd.ist_date::text AS d, rd.id AS room_day_id, c.legacy_doctor_id AS doctor_uid, c.full_name AS doctor_name,
        count(*) FILTER (WHERE rts.role='clinician')::int AS attributed
        FROM room_day rd JOIN room_turn_speaker rts ON rts.room_day_id = rd.id AND rts.role='clinician'
        JOIN clinician c ON c.id = rts.clinician_id WHERE rd.ist_date IN ({days}) GROUP BY 1,2,3,4 ORDER BY 1,2,5 DESC""")
    by = {}
    for x in rows:
        by.setdefault(x["room_day_id"], []).append(x)
    out = []
    for rd, xs in by.items():
        tot = sum(x["attributed"] for x in xs)
        if tot >= 30 and xs[0]["attributed"] / tot >= 0.8:
            out.append({"date": xs[0]["d"], "room_day_id": rd, "doctor_uid": xs[0]["doctor_uid"], "doctor_name": xs[0]["doctor_name"]})
    return out


def consults_for(day, rds):
    dd = date.fromisoformat(day)
    b = ",".join(f"'{(dd + timedelta(days=k)).isoformat()}'" for k in (-1, 0, 1))
    cols, rows, tr = mb.query(f"""SELECT qts.token_uid, qts.routing->>'DOCTOR_UID' AS doctor_uid, qts.metadata->>'DOCTOR_NAME' AS doctor_name,
        qt.metadata->>'INDIVIDUAL_UID' AS individual_uid, nullif(qts.called_at,'')::timestamptz AS called_at, nullif(qts.completed_at,'')::timestamptz AS completed_at
        FROM queue_token_steps qts JOIN queue_tokens qt ON qt.uid = qts.token_uid
        WHERE qts.station='CONSULTATION' AND qts.status='COMPLETE' AND qts.cycle_bucket IN ({b}) ORDER BY 5""")
    assert not tr and len(rows) < 1999, "row cap"
    ix = {c: i for i, c in enumerate(cols)}
    out, skipped = [], {"other_day": 0, "no_confirmed_doctor": 0, "two_rooms": 0, "no_individual": 0}
    for r in rows:
        if not r[ix["called_at"]] or not r[ix["completed_at"]]:
            continue
        called, done = ts(r[ix["called_at"]]).astimezone(IST), ts(r[ix["completed_at"]]).astimezone(IST)
        if called.date().isoformat() != day:
            skipped["other_day"] += 1
            continue
        m = [o for o in rds if (o["doctor_uid"] and o["doctor_uid"] == r[ix["doctor_uid"]]) or (norm(o["doctor_name"]) and norm(o["doctor_name"]) == norm(r[ix["doctor_name"]]))]
        if not m:
            skipped["no_confirmed_doctor"] += 1; continue
        if len({x["room_day_id"] for x in m}) > 1:
            skipped["two_rooms"] += 1; continue
        if not r[ix["individual_uid"]]:
            skipped["no_individual"] += 1; continue
        out.append({"token_uid": r[ix["token_uid"]], "individual_uid": r[ix["individual_uid"]], "room_day_id": m[0]["room_day_id"],
                    "called": called, "done": done})
    return out, skipped


def transcript_stats(c):
    for v in (c["room_day_id"], c["token_uid"]):
        if not re.match(r"^[A-Za-z0-9_\-]+$", v):
            raise SystemExit("unexpected id characters")
    r = neon(f"""SELECT count(*)::int turns, coalesce(sum(length(payload->>'text')),0)::int chars FROM cue WHERE type='stt_turn'
        AND room_day_id='{c['room_day_id']}' AND at BETWEEN '{c['called'].isoformat()}' AND '{c['done'].isoformat()}'""")[0]
    return r["turns"], r["chars"]


def main():
    os.makedirs(OUT, exist_ok=True); os.chmod(OUT, 0o700)
    rds = confirmed_room_days()
    print("confirmed room-days:", {d: sum(1 for o in rds if o["date"] == d) for d in DAYS})
    cons, skipped = [], {}
    for d in DAYS:
        c, s = consults_for(d, [o for o in rds if o["date"] == d])
        cons += c; skipped[d] = s
    print("consults matched to a confirmed room-day:", len(cons), "| skipped:", skipped)
    _, leads, _ = mb.query("SELECT individual_uid, created_at, status FROM surgery_cases WHERE created_at >= '2026-09-23'")
    _, flags, _ = mb.query("""SELECT i.uid, p.prescription_date FROM prescription_surgery_recommendation p JOIN individuals i ON i.kx_uhid = p.patient_uhid
        WHERE p.surgery_recommended='yes' AND p.prescription_date >= '2026-09-23'""")
    L = {}
    for u, at, st in leads:
        if (st or "").upper() != "CANCELLED":
            L.setdefault(u, []).append(ts(at))
    F = {}
    for u, d in flags:
        F.setdefault(u, []).append(date.fromisoformat(d))
    for c in cons:
        u = c["individual_uid"]
        if any(c["called"] <= t <= c["called"] + timedelta(hours=48) for t in L.get(u, [])):
            c["bucket"] = "L"
        elif any(c["called"].date() <= d <= c["called"].date() + timedelta(days=1) for d in F.get(u, [])):
            c["bucket"] = "F"
        else:
            c["bucket"] = "N"
    print("buckets (all matched consults):", {b: sum(1 for c in cons if c["bucket"] == b) for b in "LFN"})
    usable = []
    for c in cons:
        mins = (c["done"] - c["called"]).total_seconds() / 60
        if not (MIN_MIN <= mins <= MAX_MIN):
            continue
        turns, chars = transcript_stats(c)
        if chars >= MIN_CHARS:
            usable.append({**c, "turns": turns, "chars": chars, "minutes": round(mins, 1)})
    print("usable (3-45 min, >=600 chars of transcript):", {b: sum(1 for c in usable if c["bucket"] == b) for b in "LFN"})
    rng = random.Random(24)
    chosen, short = [], {}
    for b, n in PILOT.items():
        pool = sorted([c for c in usable if c["bucket"] == b], key=lambda c: c["token_uid"]); rng.shuffle(pool)
        chosen += pool[:n]
        if len(pool) < n:
            short[b] = (len(pool), n)
    backfilled = 0
    if len(chosen) < sum(PILOT.values()):  # a short bucket is reported in `short`; the pilot itself is topped up from N, never from L/F
        rest = sorted([c for c in usable if c["bucket"] == "N" and c not in chosen], key=lambda c: c["token_uid"]); rng.shuffle(rest)
        need = sum(PILOT.values()) - len(chosen)
        chosen += rest[:need]; backfilled = len(rest[:need])
    for i, c in enumerate(chosen, 1):
        c["id"] = f"C{i:02d}"
    sel = [{k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in c.items()} for c in chosen]
    p = os.path.join(OUT, "selection.json")
    json.dump({"pilot": sel, "short": short, "backfilled_from_N": backfilled, "usable_by_bucket": {b: sum(1 for c in usable if c["bucket"] == b) for b in "LFN"}}, open(p, "w"), indent=1)
    os.chmod(p, 0o600)
    print("pilot:", {b: sum(1 for c in chosen if c["bucket"] == b) for b in "LFN"}, "| short:", short or "none", "| backfilled from N:", backfilled, "| written", p)


if __name__ == "__main__":
    main()
