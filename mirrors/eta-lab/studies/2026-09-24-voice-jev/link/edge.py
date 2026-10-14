#!/usr/bin/env python3
"""vj-link step 1, ruling 189 criterion 1 (box): lx's EDGE alignment (#699), scored per (room-day, doctor) over every room-day of the date.
 aligned consult = a candidate encounter (segmenter.arm_a, lx's declared parameters; energy log replaced by the stt_turn speech-presence log, see align.py) whose START is within 240 s of the
 consult's called_at AND whose END is within 360 s of its completed_at (lx's middle tolerance pair, fixed before scoring, not tuned).
 null = the same count with the doctor's consults shifted +-2 h, +-3 h.   excess = aligned - null mean;  z = excess / sqrt(n consults).
 top3 = the doctor is among the 3 highest z in the room-day;  exclusive = no other room-day of the date gives this doctor a higher z (a doctor cannot top two rooms in the same hours).
 HIGH criterion 1 (ruling 189) = excess >= 2 AND top3 AND exclusive.
Usage: edge.py <pilot_dir> <lxdir> <date>[,<date>..]  ->  <pilot_dir>/edge-<date>.json   {room_day_id: {doctor_uid: {...}}}  (uids only)"""
import csv, glob, json, os, statistics, sys
sys.argv = [sys.argv[0]] + sys.argv[1:]
PD, LX, DATES = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
sys.path.insert(0, LX); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segmenter as S, doctor_room_align as A
PL = float(os.environ.get("PLACEBO_H", "0")); DOFF = int(os.environ.get("PLACEBO_DOFF", "0")); SUF = f"-pl{os.environ['PLACEBO_H']}" if PL else (f"-pd{DOFF}" if DOFF else "")   # placebo arm: consult times shifted by a wrong number of hours
TOLS, SHIFTS, MIN_TURNS = ((180_000, 300_000), (240_000, 360_000), (300_000, 480_000)), (-3, -2, 2, 3), 300   # lx #739 tolerance pairs, declared before scoring
def faux_levels(turns):
    a = min(t["s_ms"] for t in turns) // 1000; b = max(t["e_ms"] for t in turns) // 1000; sp = set()
    for t in turns:
        for s in range(t["s_ms"] // 1000, t["e_ms"] // 1000 + 1): sp.add(s)
    return [(s * 1000, 1.0 if s in sp else 0.1) for s in range(a, b + 1)]
def labels_of(ws): return [{"window_id": w["window_id"], "engine": "prod", "start_ms": int(w["start_ms"]), "end_ms": int(w["end_ms"]), "segments_json": w["segments_json"]} for w in ws if w.get("state") == "ok" and w.get("segments_json")]
def aligned(cs, hyps, tol, shift=0): return sum(1 for a, b in cs if any(abs(s - (a + shift)) <= tol[0] and abs(e - (b + shift)) <= tol[1] for s, e in hyps))
for date in DATES:
    rooms = [json.load(open(p)) for p in sorted(glob.glob(f"{PD}/turns-*.json"))]
    rooms = [r for r in rooms if r["room"]["date"] == date and r["room"]["n_turns"] >= MIN_TURNS]
    hyps = {}
    for r in rooms:
        ts = [dict(t, s_ms=int(t["s_ms"]), e_ms=int(t["e_ms"])) for t in r["turns"] if t.get("s_ms") and t.get("e_ms")]
        hyps[r["room"]["room_day_id"]] = S.arm_a(faux_levels(ts), labels_of(r["windows"]), date)
    by = {}
    ALT, SHIFT_MS = date, 0
    if DOFF:
        _has_rx = lambda d: os.path.getsize(f"{PD}/rx-{d}.json") > 5
        pool = sorted(os.path.basename(p)[4:14] for p in glob.glob(f"{PD}/pqm-2026-09-??.csv") if os.path.exists(f"{PD}/rx-{os.path.basename(p)[4:14]}.json") and _has_rx(os.path.basename(p)[4:14]) == _has_rx(date)); ALT = pool[(pool.index(date) + DOFF) % len(pool)]
        from datetime import datetime as _dt
        SHIFT_MS = (_dt.fromisoformat(date + "T00:00:00+05:30") - _dt.fromisoformat(ALT + "T00:00:00+05:30")).days * 86_400_000
    for p in csv.DictReader(open(f"{PD}/pqm-{ALT}.csv")):
        if p["called_at"] and p["completed_at"]:
            a, b = A._ms(p["called_at"]) + int(PL * 3_600_000) + SHIFT_MS, A._ms(p["completed_at"]) + int(PL * 3_600_000) + SHIFT_MS
            if 60_000 <= b - a <= 3_600_000: by.setdefault(p["doctor_uid"], []).append((a, b))
    out = {rd: {} for rd in hyps}
    for doc, cs in by.items():
        if len(cs) < 3: continue
        for rd, h in hyps.items():
            n = len(cs); e = {"consults": n, "tol": []}
            for tol in TOLS:
                al = aligned(cs, h, tol); nl = [aligned(cs, h, tol, x * 3_600_000) for x in SHIFTS]; ex = al - statistics.mean(nl)
                e["tol"].append({"tol_s": [tol[0] // 1000, tol[1] // 1000], "aligned": al, "null_mean": round(statistics.mean(nl), 2), "excess": round(ex, 2), "z": round(ex / n ** 0.5, 3)})
            e["aligned"], e["null_mean"], e["excess"], e["z"] = (e["tol"][1][k] for k in ("aligned", "null_mean", "excess", "z"))   # the middle tolerance is the one shown on cards
            out[rd][doc] = e
    # ruling 194 (lx #739 a-d). Per tolerance: pass = excess >= 2 and top 3 by z in the room-day. (a) a doctor passing in more than one room at that tolerance is dropped from ALL of them.
    # (b) crit 1 must hold at ALL THREE tolerances. (c) n >= 5 consults for HIGH. (d) crit 1 alone never carries a tier (assemble.py).
    for t in range(len(TOLS)):
        passed = {}
        for rd in out:
            rank = sorted(out[rd], key=lambda d: -out[rd][d]["tol"][t]["z"])
            for i, d in enumerate(rank):
                out[rd][d]["tol"][t]["top3"] = i < 3
                out[rd][d]["tol"][t]["pass"] = bool(out[rd][d]["tol"][t]["excess"] >= 2 and i < 3)
                if out[rd][d]["tol"][t]["pass"]: passed.setdefault(d, []).append(rd)
        for rd in out:
            for d, e in out[rd].items():
                e["tol"][t]["pass_exclusive"] = bool(e["tol"][t]["pass"] and len(passed[d]) == 1)
    for rd in out:
        rank = sorted(out[rd], key=lambda d: -out[rd][d]["z"])
        for i, d in enumerate(rank):
            e = out[rd][d]; e["rank"] = i + 1
            e["stable_tolerances"] = sum(x["pass_exclusive"] for x in e["tol"])
            e["crit1"] = bool(e["stable_tolerances"] == len(TOLS) and e["consults"] >= 5)
            e["crit1_lx739"] = e["crit1"]
    json.dump(out, open(f"{PD}/edge-{date}{SUF}.json", "w"), indent=1); os.chmod(f"{PD}/edge-{date}{SUF}.json", 0o600)
    for r in rooms:
        rd = r["room"]["room_day_id"]; top = sorted(out[rd].items(), key=lambda kv: kv[1]["rank"])[:3]
        print(date, f"{r['room']['room']:<16}", rd, "hyp", len(hyps[rd]), "| top3", [(d[:6], v["aligned"], v["consults"], v["null_mean"], v["z"], "stable%d/3" % v["stable_tolerances"], "C1" if v["crit1"] else "") for d, v in top])
