#!/usr/bin/env python3
"""vj-link batch 2 (box, venv-gpu): the H05 candidate known-voice card and the H04 ordinary card (ruling 275/289; vj-refuter refute/27-28; frozen rule BATCH2-RULE.md v2).
 H05 (Manoj Kumar S, doctor Tbvyk1V5ijpcD194ZOWi): PASSED the pre-registered test (h05_result.json). Card = candidate known-voice check: proposed doctor from a booking + words heard, NOT a stored print (the card says so). Clips: 3 core turns of the
   encounter voice's FAMILY on OTHER days (cluster of each room-day with cos >= 0.70 to the encounter cluster 35; days other than 16 Sep OPD 4, which is excluded from scored cards), 3 different days, per-turn cos >= 0.60 to the member centroid, single speaker,
   seeded (24092026 + 7000). Contrast = another voice (cos < 0.30) on one of those days.
 H04 (Prathik R, doctor 1awHj0FcLQlGGcIsr1ga): ORDINARY card only (refute/27): voice = OPD 7 13 Sep cluster 30, clips = its core turns inside the doctor's PQM consults that day (the same rules as every other link card), timing-guess label, no known-voice text.
 Cards: surg-page contract fields + batch 2.  Out: ~/eta-data/voice-linkage/batch2-special/{links,audio}, key in batch2-special-key/ (session per clip).  Numbers/ids only in the key."""
import csv, glob, json, os, random, secrets, subprocess, sys
from datetime import datetime
import numpy as np
from scipy.cluster.hierarchy import linkage, fcluster
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
BOX = os.path.expanduser("~/eta-data/voice-linkage"); H = f"{BOX}/dtree84"; OUT = f"{BOX}/batch2-special"; KEY = f"{BOX}/batch2-special-key"; SEED = 24092026
for d in (f"{OUT}/links", f"{OUT}/audio", KEY): os.makedirs(d, exist_ok=True)
rds = json.load(open(f"{BOX}/overnight/rds80.json")); ms = lambda ts: int(datetime.fromisoformat(ts).timestamp() * 1000)
E, TURN, META, WIN, ROOM = {}, {}, {}, {}, {}
for rd in rds:
    z = np.load(f"{H}/emb-{rd}.npz"); E[rd] = (z["idx"], z["emb"].astype(np.float64)); TURN[rd] = json.load(open(f"{H}/turns-{rd}.json")); META[rd] = {m["i"]: m for m in json.load(open(f"{H}/emb-{rd}.json"))}
    ROOM[rd] = (TURN[rd]["room"]["room"], TURN[rd]["room"]["date"])
def clusters(rd):
    idx, X = E[rd]; lab = fcluster(linkage(X, "average", metric="cosine"), 0.70, "distance"); cent = {}
    for c in set(lab):
        m = lab == c
        if m.sum() >= 25: v = X[m].mean(0); cent[int(c)] = v / np.linalg.norm(v)
    return lab, cent
CL = {rd: clusters(rd) for rd in rds}
def core_idx(rd, c, thr=0.45):
    idx, X = E[rd]; lab, cent = CL[rd]; return {int(i) for n, i in enumerate(idx.tolist()) if lab[n] == c and float(X[n] @ cent[c]) >= thr}
def seg_overlap(rd, win, s_ms, e_ms):
    for w in TURN[rd]["windows"]:
        if w["window_id"] != win or not w.get("segments_json"): continue
        segs = w["segments_json"]; segs = json.loads(segs) if isinstance(segs, str) else segs; w0 = int(w["start_ms"]); a, b = s_ms - w0, e_ms - w0; spk = {}
        for g in segs:
            ov = min(b, g["end_ms"]) - max(a, g["start_ms"])
            if ov > 0: spk[g["speaker_idx"]] = spk.get(g["speaker_idx"], 0) + ov
        return len(spk) > 1 and sorted(spk.values())[-2] > 300
    return None
def turns_of(rd, cent, core, want_core, consults=None):
    idx, X = E[rd]; out = []
    for n, i in enumerate(idx.tolist()):
        m = META[rd][i]
        if not (4.0 <= m["dur_s"] <= 8.0): continue
        cos = float(X[n] @ cent)
        if want_core and (i not in core or cos < 0.60): continue
        if not want_core and cos >= 0.30: continue
        t = TURN[rd]["turns"][i]; s, e = int(t["s_ms"]), int(t["e_ms"])
        if consults is not None and not any(a - 30_000 <= s <= b + 30_000 for a, b in consults): continue
        if seg_overlap(rd, m["window_id"], s, e) is not False: continue
        out.append({"rd": rd, "i": i, "win": m["window_id"], "off": m["off_s"], "dur": m["dur_s"], "cos": cos})
    return out
def cut(win, off, dur, dst): subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{off:.2f}", "-t", f"{dur:.2f}", "-i", f"{BOX}/pilot/audio/{win}.wav", "-ac", "1", "-ar", "22050", "-b:a", "32k", dst], check=True)
name_of = {}
for f in glob.glob(f"{BOX}/pilot/pqm-2026-09-*.csv"):
    for r in csv.DictReader(open(f)): name_of[r["doctor_uid"]] = r["doctor_name"]
key, clips = [], []
def emit(kind, rd_rep, doctor_uid, chosen, contrast, evidence, extra):
    cid = secrets.token_hex(3); cl = []
    for k, x in enumerate(chosen + contrast):
        dst = f"{OUT}/audio/{cid}_{k}.mp3"; cut(x["win"], x["off"], x["dur"], dst); cl.append({"src": f"audio/{cid}_{k}.mp3", "duration_s": round(x["dur"], 1)})
        clips.append({"card_id": cid, "k": k, "role": "doctor" if k < 3 else "contrast", "room_day": x["rd"], "session": "bs_" + x["win"].split("_")[1], "turn_s_ms": int(TURN[x["rd"]]["turns"][x["i"]]["s_ms"]), "turn_e_ms": int(TURN[x["rd"]]["turns"][x["i"]]["e_ms"]), "window_id": x["win"], "offset_s": x["off"], "dur_s": x["dur"], "cos_to_voice_centroid": round(x["cos"], 3)})
    card = {"id": cid, "kind": "link", "room": ROOM[rd_rep][0], "date": ROOM[rd_rep][1], "doctor": name_of[doctor_uid], "evidence": evidence, "clips": cl[:3], "contrast": cl[3], "batch": 2}
    json.dump(card, open(f"{OUT}/links/{cid}.json", "w"), indent=1); key.append({"card_id": cid, "kind_note": kind, "doctor_uid": doctor_uid, **extra}); return cid
# ---------------- H05 (vj-refuter F1 v2, refute/32 + #1696): clips ONLY from inside the doctor's own consults
H05_DOC = "Tbvyk1V5ijpcD194ZOWi"; H05_RD, H05_C = "rd_ykw2rxjj", 35; ref = CL[H05_RD][1][H05_C]
FAM_COS = 0.60   # family = OPD 4 clusters with cos >= 0.60 to the encounter cluster: the SAME threshold as the frozen H05 test (an earlier exploration used 0.70; that excluded 24 Sep c80 at 0.687)
EXCL_CLIP = {"rd_6nwgyrpx", "rd_yck5kdc2", "rd_u6kdhc3b", H05_RD}   # the pre-registered test's reference room-days and the 16 Sep encounter day: not evidence for this doctor (R3)
def consults_of_day(rd):
    return [(ms(x["called_at"]), ms(x["completed_at"])) for x in csv.DictReader(open(f"{H}/pqm-{ROOM[rd][1]}.csv")) if x["doctor_uid"] == H05_DOC and x["called_at"] and x["completed_at"]]
def inside(rd, i, cons):
    t = TURN[rd]["turns"][i]; s_, e_ = int(t["s_ms"]), int(t["e_ms"]); return any(a <= s_ and e_ <= b for a, b in cons)
fam = sorted(((float(ref @ v), rd, c) for rd in rds if rd not in EXCL_CLIP and ROOM[rd][0].startswith("OPD 4") for c, v in CL[rd][1].items() if float(ref @ v) >= FAM_COS), reverse=True)
cand = []
for s_, rd, c in fam:
    cons = consults_of_day(rd)
    if not cons: continue
    core = core_idx(rd, c); idx, X = E[rd]
    ins_s = sum((int(TURN[rd]["turns"][i]["e_ms"]) - int(TURN[rd]["turns"][i]["s_ms"])) / 1000 for i in core if inside(rd, i, cons))
    pool = [x for x in turns_of(rd, CL[rd][1][c], core, True) if inside(rd, x["i"], cons)]     # 4-8 s, fully inside a consult, per-turn cos >= 0.60, single speaker
    if pool: cand.append((ins_s, s_, rd, c, pool))
cand.sort(key=lambda t: -t[0])                                     # by production timing only: most family-voice seconds inside his consults
r = random.Random(SEED + 7000); chosen, used_days = [], []
for ins_s, s_, rd, c, pool in cand[:3]:
    chosen.append(r.choice(pool)); used_days.append((ROOM[rd][1], rd, c, round(s_, 3), round(ins_s, 1)))
if len(chosen) < 3: print("H05: NOT ENOUGH DAYS", len(chosen))
else:
    rep = (used_days[0][1], used_days[0][2]); other = turns_of(rep[0], CL[rep[0]][1][rep[1]], set(), False); r.shuffle(other)
    ev = [f"KNOWN-VOICE CHECK (candidate, not a stored voiceprint). This voice is proposed as {name_of[H05_DOC]} because a procedure booked for one of this doctor's patients was heard in OPD 4 on 16 Sep, in an encounter whose main voice is similar to the voice in these clips. Please listen: does it sound like this doctor?",
          f"The clips are taken only from inside this doctor's own queue consults, on {', '.join(u[0][5:] for u in used_days)}. The same voice is also heard in OPD 4 at times when this doctor has no consults, so it may be more than one person.",
          "How to read it: this candidate rests on a booking and words heard, not on an enrolment, so it is weaker evidence than a stored voiceprint. Please judge by listening."]
    cid = emit("H05 candidate known-voice", rep[0], H05_DOC, chosen, other[:1], ev, {"test": "h05_result.json PASS", "selection": "vj-refuter F1 v2: family-voice core turns 4-8 s fully inside the doctor's called..completed windows, non-reference non-16-Sep days, top 3 days by seconds inside consults", "days": [{"date": u[0], "room_day": u[1], "cluster": u[2], "cos_to_encounter_cluster": u[3], "family_seconds_inside_consults": u[4]} for u in used_days], "excluded_room_days": sorted(EXCL_CLIP)}); print("H05 card", cid, used_days)
# ---------------- H04 ordinary card: OPD 7 13 Sep cluster 30, Prathik's consults
r = random.Random(SEED + 7001); RD, C, DOC = "rd_st7wkdg5", 30, "1awHj0FcLQlGGcIsr1ga"
cons = [(ms(x["called_at"]), ms(x["completed_at"])) for x in csv.DictReader(open(f"{H}/pqm-{ROOM[RD][1]}.csv")) if x["doctor_uid"] == DOC and x["called_at"] and x["completed_at"]]
pool = turns_of(RD, CL[RD][1][C], core_idx(RD, C), True, consults=cons); r.shuffle(pool)
other = turns_of(RD, CL[RD][1][C], set(), False); r.shuffle(other)
lk = json.load(open(f"{H}/link-{RD}.json")); pair = next((p for p in lk["pairs"] if p["doctor_uid"] == DOC and str(p["cluster"]) in (str(C),)), None)
if len(pool) < 3 or not other: print("H04: NOT ENOUGH CLIPS", len(pool), len(other))
else:
    chosen = []; seen = set()
    for x in pool:
        w = x["win"]
        if w not in seen: chosen.append(x); seen.add(w)
        if len(chosen) == 3: break
    for x in pool:
        if len(chosen) == 3: break
        if x not in chosen: chosen.append(x)
    ev = [f"Voice timing: in this room on this day the voice is heard in the doctor's consults ({len(cons)} queue consults that day); the timing label is a guess.",
          "Timing guess: this voice is heard on one day only in this comparison, so there is no cross-day vote; on that day the best timing match is this doctor (a random pick would give about 1 in 8).",
          "The doctor is proposed from queue timing, which is only weakly reliable: a control with the doctors' times shifted to the wrong hours finds pairings like this one just as often.",
          "This is an ordinary check of one proposed pairing; it is not a stored voiceprint and not a known answer."]
    cid = emit("H04 ordinary", RD, DOC, chosen, other[:1], ev, {"note": "ordinary card only (refute/27); 12 Sep Dietary excluded from scored cards", "rep": [RD, C], "n_consults": len(cons), "pair_present": bool(pair)}); print("H04 card", cid, len(pool))
json.dump(key, open(f"{KEY}/key.json", "w"), indent=1); json.dump(clips, open(f"{KEY}/clips.json", "w"), indent=1); print("special cards:", len(key))
