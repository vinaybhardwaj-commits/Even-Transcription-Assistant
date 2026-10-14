"""doctor_room_align.py — which doctor's PQM consults line up with a room-day's audio? (lx, 24 Sep; ruling 183 step 1)

The E-7 code (studies/2026-09-24-e7-fullday, e7_score.py) takes the doctor AS GIVEN (from stored voiceprints, which ruling
182 says fail on current audio) and scores how well that doctor's consults match the room's detected encounters. This is the
REVERSE, with no voiceprint: for one room-day, score EVERY doctor's PQM consults that day against the room's audio and rank.

HYPOTHESES are arm a of the ENCOUNTER-FIRST segmenter (segmenter.arm_a: energy + speaker turnover), which uses NO queue
information, so a doctor's times are never scored against a segmentation built from them (arm d would be circular).
MATCH is E-7's rule: a consult matches a hypothesis when they overlap by >= 50% of the shorter; consults must have both
times and last 1-60 min (E-7's filter).
CHANCE: arm a is dense (~30 clips per room-day), so some overlap is chance. Each doctor's own NULL is the same count after
shifting all their consult times by +-2 h and +-3 h (a different part of the clinic day); a link is credible when the
best doctor beats their null by a clear margin AND the runner-up.

VALIDATION (23 Sep; 3 rooms where the stored voiceprints name a doctor; 23 doctors with >= 3 timed consults). CAUTION: that
truth is the very thing ruling 182 doubts, so agreement is mutual support and disagreement is unresolved, not proof.
  * OVERLAP match (rank_doctors): the confirmed doctor is rank 1 (OPD 3), 4 (OPD 5), 10 (Cardiology). One busy doctor (16
    consults) matches 13/16 in BOTH Cardiology and OPD 5: chance (own shifted null 7.5-8.5/16). Overlap is unsafe on busy days.
  * Cross-room EXCLUSIVITY on overlap (a doctor is in one room at a time) made almost every consult ambiguous (~35 long
    candidates in each of 9 rooms): confirmed doctors fell to rank 5-19. Don't use.
  * EDGE alignment (rank_doctors_edge: start within ts AND end within te of a candidate's start/end; z = (aligned - null)/sqrt(n)),
    tolerances declared BEFORE scoring, all three reported: confirmed doctor is rank 1-3 in OPD 5 (3/3 aligned vs null 0.5) and
    2-4 in OPD 3 (2-5/11 vs null 0-0.75), rank 12-14 in Cardiology (0/3). A greedy one-to-one doctor<->room assignment over all
    9 rooms gets 1 of 3 right at best. So PQM TIMING ALONE IS A PRIOR (a shortlist), NOT A LINK: use it with recurring voice,
    Rx content, Jev and cross-day agreement (ruling 183 steps 2-5), and never tier HIGH on "matched >= 3 consults" without the null.

Usage (library):  from doctor_room_align import rank_doctors, rank_doctors_edge
                  rank_doctors(hyps, pqm_rows)  -> [dict per doctor, best first]
  hyps     [(start_ms, end_ms)]  from segmenter.arm_a(levels_or_audio_energy, labels, date)
  pqm_rows [{"doctor_uid", "called_at", "completed_at"}]  (ISO with offset; pqm_pull.py writes this CSV)
CLI (validation on 23 Sep):  python3 doctor_room_align.py <data_dir>   (data_dir as study.py: levels.json, labels-23sep.json,
                             rooms.json, pqm-23sep-metabase.csv). Prints ids, counts and offsets only.
Days without a level log (before 23 Sep): energy from R2 chunk audio, see r2audio.py / encounter_bounds.py.
"""
import csv, json, os, statistics, sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segmenter as S

MIN_CONSULTS = 3
SHIFTS_H = (-3, -2, 2, 3)
EDGE_TOL_S = ((180, 300), (240, 360), (300, 480))   # (start tol s, end tol s), declared before scoring; E-7 median errors 175 / 328 s


def _ms(ts): return int(datetime.fromisoformat(ts).timestamp() * 1000)


def _match(a, b, hyps):
    """Best-overlap hypothesis for consult [a, b): (start_err_s, end_err_s) or None when no hypothesis overlaps >= 50%."""
    best, best_ov = None, 0.0
    for s, e in hyps:
        ov = max(0, min(b, e) - max(a, s)) / min(b - a, e - s)
        if ov >= 0.5 and ov > best_ov: best, best_ov = (s, e), ov
    return None if best is None else ((best[0] - a) / 1000, (best[1] - b) / 1000)


def rank_doctors(hyps, pqm_rows, min_consults=MIN_CONSULTS):
    by = {}
    for r in pqm_rows:
        if not r.get("called_at") or not r.get("completed_at"): continue
        a, b = _ms(r["called_at"]), _ms(r["completed_at"])
        if 60_000 <= b - a <= 3_600_000: by.setdefault(r["doctor_uid"], []).append((a, b))
    out = []
    for doc, cs in by.items():
        if len(cs) < min_consults: continue
        m = [x for x in (_match(a, b, hyps) for a, b in cs) if x]
        nulls = [sum(1 for a, b in cs if _match(a + h * 3_600_000, b + h * 3_600_000, hyps)) for h in SHIFTS_H]
        out.append({"doctor_uid": doc, "consults": len(cs), "matched": len(m), "frac": round(len(m) / len(cs), 2),
                    "null_mean": round(statistics.mean(nulls), 2), "null_max": max(nulls),
                    "excess": round(len(m) - statistics.mean(nulls), 2),
                    "start_err_median_s": round(statistics.median(x[0] for x in m)) if m else None,
                    "end_err_median_s": round(statistics.median(x[1] for x in m)) if m else None})
    out.sort(key=lambda d: (-d["excess"], -d["matched"]))
    for i, d in enumerate(out): d["rank"] = i + 1
    return out


def _edge_ok(a, b, hyps, ts, te):
    return any(abs(s - a) <= ts * 1000 and abs(e - b) <= te * 1000 for s, e in hyps)


def rank_doctors_edge(hyps, pqm_rows, tol=(240, 360), min_consults=MIN_CONSULTS):
    """Like rank_doctors but a consult counts only when its START and END both land near a candidate's start and end
    (much rarer by chance than a 50% overlap). Ranked by z = (aligned - null mean) / sqrt(n consults), so a doctor with
    more consults is not favoured just for having more."""
    import math
    ts, te = tol; by = {}
    for r in pqm_rows:
        if not r.get("called_at") or not r.get("completed_at"): continue
        a, b = _ms(r["called_at"]), _ms(r["completed_at"])
        if 60_000 <= b - a <= 3_600_000: by.setdefault(r["doctor_uid"], []).append((a, b))
    out = []
    for doc, cs in by.items():
        if len(cs) < min_consults: continue
        al = sum(1 for a, b in cs if _edge_ok(a, b, hyps, ts, te))
        nul = [sum(1 for a, b in cs if _edge_ok(a + h * 3_600_000, b + h * 3_600_000, hyps, ts, te)) for h in SHIFTS_H]
        nm = statistics.mean(nul)
        out.append({"doctor_uid": doc, "consults": len(cs), "aligned": al, "null_mean": round(nm, 2), "null_max": max(nul),
                    "z": round((al - nm) / math.sqrt(len(cs)), 2), "tol_s": tol})
    out.sort(key=lambda d: (-d["z"], -d["aligned"]))
    for i, d in enumerate(out): d["rank"] = i + 1
    return out


if __name__ == "__main__":
    DATA = sys.argv[1]; DATE = "2026-09-23"
    rooms = json.load(open(f"{DATA}/rooms.json")); levels = json.load(open(f"{DATA}/levels.json"))
    labels = json.load(open(f"{DATA}/labels-23sep.json"))
    pqm = list(csv.DictReader(open(f"{DATA}/pqm-23sep-metabase.csv")))
    name_of = {r["doctor_uid"]: r["doctor_name"] for r in pqm}
    norm = lambda n: " ".join((n or "").lower().replace("dr.", "").replace("dr ", "").split())
    widened = json.load(open(os.path.expanduser("~/dev/eta-lab/studies/2026-09-23-e7-pqm-truth/voiceprint-23sep-widened.json")))["room_days"]
    truth_name = {x["room_day_id"]: norm(x.get("confirmed_doctor")) for x in widened if x.get("confirmed")}
    print(f"PQM {DATE}: {len(pqm)} rows, {len({r['doctor_uid'] for r in pqm})} doctors")
    for rd, rid in rooms.items():
        lv = [(int(x["t"]), float(x["peak"])) for x in levels if x["room_id"] == rid]
        lb = [x for x in labels if x["room_day_id"] == rd]
        hyps = S.arm_a(lv, lb, DATE)
        R = rank_doctors(hyps, pqm)
        true_uid = next((u for u, n in name_of.items() if norm(n) == truth_name.get(rd)), None)
        true_rank = next((d["rank"] for d in R if d["doctor_uid"] == true_uid), None)
        top = R[0]; run = R[1] if len(R) > 1 else None
        print(f"{rd}: {len(hyps)} hypotheses, {len(R)} doctors scored | TOP {top['doctor_uid']} matched {top['matched']}/{top['consults']} "
              f"(null mean {top['null_mean']}, max {top['null_max']}, excess {top['excess']}), offsets {top['start_err_median_s']}/{top['end_err_median_s']} s"
              f" | runner-up {run['doctor_uid']} excess {run['excess']} | voiceprint-confirmed doctor is rank {true_rank} "
              f"({'TOP' if true_rank == 1 else 'NOT top'}; PQM name match {'yes' if true_uid else 'no'})")
        for tol in EDGE_TOL_S:
            E = rank_doctors_edge(hyps, pqm, tol); er = next((d for d in E if d["doctor_uid"] == true_uid), None)
            print(f"   edge tol {tol[0]}/{tol[1]}s: confirmed doctor rank {er['rank'] if er else None}/{len(E)}"
                  f" (aligned {er['aligned'] if er else '-'}/{er['consults'] if er else '-'}, null {er['null_mean'] if er else '-'})"
                  f" | top {E[0]['doctor_uid'][:6]} z {E[0]['z']} aligned {E[0]['aligned']}/{E[0]['consults']}")
