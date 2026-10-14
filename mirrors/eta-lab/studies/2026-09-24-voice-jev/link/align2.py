#!/usr/bin/env python3
"""vj-link step 1b (box): continuous PQM-to-room alignment, a complement to align.py (lx's arm_a rank), for busy days where 10-35 segments cannot resolve 100+ consults.
For room R (speech from the production stt_turn cues, minute bins) and each PQM consult [a, b] of doctor D:
  cov_in  = share of minutes inside [a, b] with speech in R          (speech minute = >= 20% of its seconds covered by a turn)
  cov_out = mean share in the 6 minutes before a and the 6 minutes after b (the room should be quieter or between patients)
  matched = cov_in >= 0.60 and cov_in - cov_out >= 0.20
  exclusive = matched in R AND R has the highest cov_in among the date's rooms by >= 0.15 (a doctor is in one room at a time), else the consult counts nowhere.
NULL per doctor: the same match count after shifting the doctor's consults by +-2 h and +-3 h (lx's null).  EXCESS = matched - null mean.
Usage: align2.py <pilot_dir> <date>[,<date>..]   -> <pilot_dir>/align2-<date>.json (doctor names: box only). Console: ids and counts.
"""
import csv, glob, json, os, statistics, sys
from datetime import datetime

PD, DATES = sys.argv[1], sys.argv[2].split(",")
MIN_TURNS, COV_IN, CONTRAST, MARGIN, PAD = 300, 0.60, 0.20, 0.15, 6
SHIFTS = (-3, -2, 2, 3)
ms = lambda ts: int(datetime.fromisoformat(ts).timestamp() * 1000)


def minute_activity(turns):
    sec = {}
    for t in turns:
        for s in range(t["s_ms"] // 1000, t["e_ms"] // 1000 + 1): sec[s // 60] = sec.get(s // 60, set()) | {s}
    return {m: len(v) / 60 >= 0.20 for m, v in sec.items()}


def cov(act, a_min, b_min):
    n = b_min - a_min + 1
    return sum(1 for m in range(a_min, b_min + 1) if act.get(m)) / n if n > 0 else 0.0


def stat(act, a, b):
    am, bm = a // 60000, max(a // 60000, (b - 1) // 60000)
    ci = cov(act, am, bm)
    co = (cov(act, am - PAD, am - 1) + cov(act, bm + 1, bm + PAD)) / 2
    return ci, co


for date in DATES:
    rooms = [json.load(open(p)) for p in sorted(glob.glob(f"{PD}/turns-*.json"))]
    rooms = [r for r in rooms if r["room"]["date"] == date and r["room"]["n_turns"] >= MIN_TURNS]
    act = {}
    for r in rooms:
        r["turns"] = [dict(t, s_ms=int(t["s_ms"]), e_ms=int(t["e_ms"])) for t in r["turns"] if t.get("s_ms") and t.get("e_ms")]
        act[r["room"]["room_day_id"]] = minute_activity(r["turns"])
    pqm = list(csv.DictReader(open(f"{PD}/pqm-{date}.csv")))
    name_of = {p["doctor_uid"]: p["doctor_name"] for p in pqm}
    by = {}
    for p in pqm:
        if not p["called_at"] or not p["completed_at"]: continue
        a, b = ms(p["called_at"]), ms(p["completed_at"])
        if 60_000 <= b - a <= 3_600_000: by.setdefault(p["doctor_uid"], []).append((p["token_uid"], a, b))
    # per consult: cov_in per room
    table = {}
    for doc, cs in by.items():
        for tok, a, b in cs:
            table[tok] = {rd: stat(A, a, b) for rd, A in act.items()}
    res = {rd: [] for rd in act}
    for doc, cs in by.items():
        if len(cs) < 3: continue
        for rd in act:
            hit, excl, ex = [], [], []
            for tok, a, b in cs:
                ci, co = table[tok][rd]
                if ci >= COV_IN and ci - co >= CONTRAST:
                    hit.append(tok)
                    others = sorted((v[0] for k, v in table[tok].items() if k != rd), reverse=True)
                    if not others or ci - others[0] >= MARGIN: excl.append({"token_uid": tok, "called_ms": a, "completed_ms": b, "cov_in": round(ci, 2), "cov_out": round(co, 2)})
            nulls = []
            for h in SHIFTS:
                k = 0
                for tok, a, b in cs:
                    ci, co = stat(act[rd], a + h * 3_600_000, b + h * 3_600_000)
                    k += ci >= COV_IN and ci - co >= CONTRAST
                nulls.append(k)
            res[rd].append({"doctor_uid": doc, "doctor_name": name_of.get(doc), "consults": len(cs), "matched": len(hit), "excl": len(excl),
                            "null_mean": round(statistics.mean(nulls), 2), "excess": round(len(hit) - statistics.mean(nulls), 2), "excl_consults": excl})
    out = {}
    for r in rooms:
        rd = r["room"]["room_day_id"]; L = sorted(res[rd], key=lambda x: (-x["excl"], -x["excess"]))
        out[rd] = {"room": r["room"]["room"], "date": date, "top": L[:6]}
        b, u = (L[0], L[1]) if len(L) > 1 else (L[0] if L else None, None)
        print(f"{date} {r['room']['room']:<16} {rd} | " + (f"BEST {b['doctor_uid']} excl={b['excl']}/{b['consults']} matched={b['matched']} null={b['null_mean']} | RUNNER {u['doctor_uid']} excl={u['excl']}/{u['consults']} matched={u['matched']}" if b and u else "none"))
    json.dump(out, open(f"{PD}/align2-{date}.json", "w"), indent=1); os.chmod(f"{PD}/align2-{date}.json", 0o600)
