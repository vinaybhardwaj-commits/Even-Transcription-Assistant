#!/usr/bin/env python3
"""vj-link step 1 (box): PQM timing -> best doctor per room-day, with lx's E-7 code REUSED (not rebuilt).
 reused, read-only from origin/main (copied to $LXDIR by run_align.sh): studies/2026-09-24-encounter-first/{segmenter,doctor_room_align}.py, PQM via e7-fullday/pqm_pull.py.
 - hypotheses = segmenter.arm_a (lx's DECLARED parameters). arm_a wants an energy log, which exists only from 23 Sep; before that we feed it a SPEECH-PRESENCE
   log built from the production stt_turn cues (peak 1.0 in a second covered by a turn, 0.1 elsewhere inside the recording span). Everything downstream of that is lx's code.
 - ranking = doctor_room_align.rank_doctors (matched consults, shifted-time null).
 - EXCLUSIVITY (lx's warning, inbox 691): a doctor cannot be in two rooms. Every consult of the date is assigned to the ONE room-day where it overlaps a hypothesis best
   (>= 50% of the shorter, and clearly better than the second-best room, else it is ambiguous and counted nowhere). 'excl' below counts only those.
Usage: align.py <pilot_dir> <lxdir> <date>[,<date>..]     Output: <pilot_dir>/align-<date>.json (doctor names = box only), console = ids and counts.
"""
import csv, glob, json, os, statistics, sys
from datetime import datetime

PD, LX, DATES = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
sys.path.insert(0, LX)
import segmenter as S
import doctor_room_align as A

MIN_TURNS = 300   # a room-day with fewer transcribed turns is not scored
CLEAR = 1.25      # the best room's overlap must beat the second-best by this factor (else the consult is ambiguous)


def faux_levels(turns):
    if not turns: return []
    a = min(t["s_ms"] for t in turns) // 1000; b = max(t["e_ms"] for t in turns) // 1000
    speech = set()
    for t in turns:
        for s in range(t["s_ms"] // 1000, t["e_ms"] // 1000 + 1): speech.add(s)
    return [(s * 1000, 1.0 if s in speech else 0.1) for s in range(a, b + 1)]


def labels_of(windows):
    out = []
    for w in windows:
        if w.get("state") == "ok" and w.get("segments_json"):
            out.append({"window_id": w["window_id"], "engine": "prod", "start_ms": int(w["start_ms"]), "end_ms": int(w["end_ms"]), "segments_json": w["segments_json"]})
    return out


def ov(a, b, hyps):
    best = 0.0
    for s, e in hyps:
        best = max(best, max(0, min(b, e) - max(a, s)) / min(b - a, e - s))
    return best


for date in DATES:
    rooms = [json.load(open(p)) for p in sorted(glob.glob(f"{PD}/turns-*.json"))]
    rooms = [r for r in rooms if r["room"]["date"] == date and r["room"]["n_turns"] >= MIN_TURNS]
    for r in rooms:   # Neon returns bigint as strings; drop turns without times
        r["turns"] = [dict(t, s_ms=int(t["s_ms"]), e_ms=int(t["e_ms"])) for t in r["turns"] if t.get("s_ms") and t.get("e_ms")]
    pqm = list(csv.DictReader(open(f"{PD}/pqm-{date}.csv")))
    name_of = {r["doctor_uid"]: r["doctor_name"] for r in pqm}
    hyps = {}
    for r in rooms:
        rd = r["room"]["room_day_id"]
        hyps[rd] = S.arm_a(faux_levels(r["turns"]), labels_of(r["windows"]), date)
    per_doc = {}   # doctor_uid -> [(token_uid, a, b, {rd: overlap})]
    for row in pqm:
        if not row["called_at"] or not row["completed_at"]: continue
        a, b = A._ms(row["called_at"]), A._ms(row["completed_at"])
        if not (60_000 <= b - a <= 3_600_000): continue
        per_doc.setdefault(row["doctor_uid"], []).append((row["token_uid"], a, b, {rd: ov(a, b, h) for rd, h in hyps.items()}))
    result = {}
    for r in rooms:
        rd = r["room"]["room_day_id"]
        ranked = A.rank_doctors(hyps[rd], pqm)
        rows = []
        for d in ranked[:12]:
            cs = per_doc[d["doctor_uid"]]; mine, amb = [], 0
            for tok, a, b, o in cs:
                srt = sorted(o.items(), key=lambda kv: -kv[1])
                top, second = srt[0], (srt[1][1] if len(srt) > 1 else 0.0)
                if top[1] < 0.5: continue
                if top[0] == rd and (second == 0 or top[1] >= CLEAR * second): mine.append((tok, a, b, top[1]))
                elif top[0] == rd: amb += 1
            m = A._match
            offs = [m(a, b, hyps[rd]) for _, a, b, _ in mine]; offs = [x for x in offs if x]
            rows.append({**d, "doctor_name": name_of.get(d["doctor_uid"]), "excl": len(mine), "ambiguous": amb,
                         "excl_consults": [{"token_uid": t, "called_ms": a, "completed_ms": b, "overlap": round(o, 2)} for t, a, b, o in mine],
                         "excl_start_err_median_s": round(statistics.median(x[0] for x in offs)) if offs else None,
                         "excl_end_err_median_s": round(statistics.median(x[1] for x in offs)) if offs else None})
        rows.sort(key=lambda x: (-x["excl"], -x["excess"]))
        result[rd] = {"room": r["room"]["room"], "date": date, "n_hyp": len(hyps[rd]), "n_doctors_scored": len(ranked), "top": rows[:6]}
        best = rows[0] if rows else None; run = rows[1] if len(rows) > 1 else None
        print(f"{date} {r['room']['room']:<16} {rd} hyp={len(hyps[rd]):3d} doctors={len(ranked):2d} | "
              + (f"BEST {best['doctor_uid']} excl={best['excl']}/{best['consults']} plain={best['matched']} null={best['null_mean']} off={best['excl_start_err_median_s']}/{best['excl_end_err_median_s']}s"
                 f" | RUNNER {run['doctor_uid']} excl={run['excl']}/{run['consults']}" if best and run else "none"))
    json.dump(result, open(f"{PD}/align-{date}.json", "w"), indent=1); os.chmod(f"{PD}/align-{date}.json", 0o600)
