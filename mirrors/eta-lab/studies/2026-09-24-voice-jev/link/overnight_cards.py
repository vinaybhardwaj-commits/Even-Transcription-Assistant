#!/usr/bin/env python3
"""vj-link overnight step 3 (voice-lab-1): final tiers (Jev merged) -> page composition (ruling 204) -> clips -> cards.
 Composition: ALL HIGH, then ALL MED (together capped at 48), then LOW controls up to 60 cards in total (>= 12 LOW). HIGH/MED are never padded with weaker cards; if fewer than 30 HIGH exist the counts are printed and go on the page.
 Clips (vj-refuter C1/C2): per TURN, from the voice's CORE inside the proposed doctor's consults, single-speaker (no other diarizer speaker overlapping > 0.3 s), 4-5 s, per-turn cos >= 0.60 to its voice centroid; 3 clips from
 DIFFERENT consults, from >= 2 different room-days when the voice spans several; seeded random draw (seed 24092026 + card no.); contrast = a turn of another voice of the rep room-day with cos < 0.30, same rules.
 Pair cards ('Same person?', batch 1): one per HIGH/MED cross-day link (max 10): a clip from day A and a clip from day B, not used on the link card.
 Cards carry only surg-page's fields (+ batch); tier, criteria, cluster ids go to key.json only.
Usage: overnight_cards.py [batch=1]     Out: ~/vj/link/overnight/cards/{links,audio}, key.json, clips.json"""
import csv, json, os, random, subprocess, sys, secrets, collections
from datetime import datetime
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tiering as T
H = os.path.expanduser(os.environ.get("LINK_H", "~/vj/link")); OUT = f"{H}/overnight/cards"; BATCH = int(sys.argv[1]) if len(sys.argv) > 1 else 1
SEED, SIM_CLIP, SIM_CONTRAST, CAP, HM_CAP = 24092026, 0.60, 0.30, int(os.environ.get("CAP", "60")), 48
ONLY_LOW = bool(os.environ.get("ONLY_LOW")); EXCL = json.load(open(os.environ["EXCLUDE_FILE"])) if os.environ.get("EXCLUDE_FILE") else {"gids": [], "voices": [], "room_days": []}
for d in ("links", "audio"): os.makedirs(f"{OUT}/{d}", exist_ok=True)
glinks = json.load(open(f"{H}/overnight/glinks.json")); ms = lambda ts: int(datetime.fromisoformat(ts).timestamp() * 1000)
jev = {}
for g in glinks:
    p = f"{H}/overnight/jev/{g['gid']}.json"
    if os.path.exists(p):
        j = json.load(open(p)); jev[g["gid"]] = j; g["lq"] = bool(j["lq_noul"] >= 0.5 and not j["lq_void"])
def tier(g):
    ok = g["rx"] or bool(g["lq"])
    return "HIGH" if (g["xday"] and g["excl"] and g["n5"] and ok and g["stable"]) else "MED" if (g["xday"] and g["excl"] and g["n5"]) else "LOW"
for g in glinks: g["tier"] = tier(g)
cnt = collections.Counter(g["tier"] for g in glinks); print("final tiers (all groups):", dict(cnt), "| jev results", len(jev))
rng = random.Random(SEED)
def excluded(g): return g["gid"] in EXCL["gids"] or any(list(m) in EXCL["voices"] for m in g["members"]) or g["rep"][0] in EXCL["room_days"]
high = [g for g in glinks if g["tier"] == "HIGH" and not ONLY_LOW]; med = [g for g in glinks if g["tier"] == "MED" and not ONLY_LOW]; low = [g for g in glinks if g["tier"] == "LOW" and not excluded(g)]
rng.shuffle(high); rng.shuffle(med); rng.shuffle(low)
hm = (high + med)[:HM_CAP]; sel = hm + low   # LOW controls are drawn in seeded order until the page has CAP cards (a LOW pick without enough eligible clips is skipped, not counted)
print("candidates:", len(hm), "HIGH/MED +", len(low), "LOW available; the page stops at", CAP, "link cards")
rds = sorted({m[0] for g in sel for m in g["members"]})   # (all groups: LOW picks may be skipped, so every room-day is loaded)
L = T.load(rds, H); V = T.voices(L); D = {}
for rd in rds:
    z = np.load(f"{H}/emb-{rd}.npz"); D[rd] = {"turns": json.load(open(f"{H}/turns-{rd}.json")), "idx": z["idx"], "E": z["emb"].astype(np.float64), "meta": {m["i"]: m for m in json.load(open(f"{H}/emb-{rd}.json"))}}


def consults_of(rd, doc):
    date = L[rd]["date"]
    return [(r["token_uid"], ms(r["called_at"]), ms(r["completed_at"])) for r in csv.DictReader(open(f"{H}/pqm-{date}.csv")) if r["doctor_uid"] == doc and r["called_at"] and r["completed_at"]]


def name_of(rd, doc):
    date = L[rd]["date"]
    return next((r["doctor_name"] for r in csv.DictReader(open(f"{H}/pqm-{date}.csv")) if r["doctor_uid"] == doc), None)


def seg_overlap(rd, win, s_ms, e_ms):
    for w in D[rd]["turns"]["windows"]:
        if w["window_id"] != win or not w.get("segments_json"): continue
        segs = w["segments_json"]; segs = json.loads(segs) if isinstance(segs, str) else segs
        w0 = int(w["start_ms"]); a, b = s_ms - w0, e_ms - w0; spk = {}
        for g in segs:
            ov = min(b, g["end_ms"]) - max(a, g["start_ms"])
            if ov > 0: spk[g["speaker_idx"]] = spk.get(g["speaker_idx"], 0) + ov
        return len(spk) > 1 and sorted(spk.values())[-2] > 300
    return None


def eligible(rd, cluster, cent, cons, core_only=True):
    d = D[rd]; Tt = d["turns"]["turns"]; core = set(L[rd]["core_turn_idx"][str(cluster)]) if cluster is not None else None; out = []
    for n, i in enumerate(d["idx"].tolist()):
        m = d["meta"][i]
        if not (4.0 <= m["dur_s"] <= 8.0): continue
        cos = float(d["E"][n] @ cent)
        t = Tt[i]; s, e = int(t["s_ms"]), int(t["e_ms"])
        cno = next((c for c, (_, a, b) in enumerate(cons) if a - 30_000 <= s <= b + 30_000), None)
        out.append({"rd": rd, "i": i, "win": m["window_id"], "off": m["off_s"], "dur": m["dur_s"], "cos": cos, "s": s, "e": e, "consult": (rd, cno) if cno is not None else None, "in_core": core is not None and i in core})
    return out


def cut(win, off, dur, dst):
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{off:.2f}", "-t", f"{dur:.2f}", "-i", f"{H}/audio/{win}.wav", "-ac", "1", "-ar", "22050", "-b:a", "32k", dst], check=True)


key, cliplist, jev_out, cards_n = [], [], [], 0
pair_pool = []
for gi, g in enumerate(sel):
    if cards_n >= CAP: break
    r = random.Random(SEED + gi); doc = g["doctor_uid"]; mem = [tuple(m) for m in g["members_naming_D"]]
    el = []
    for rd, c in mem:
        el += [x for x in eligible(rd, c, V[(rd, c)]["centroid"], consults_of(rd, doc)) if x["in_core"] and x["cos"] >= SIM_CLIP and x["consult"] is not None and seg_overlap(x["rd"], x["win"], x["s"], x["e"]) is False]
    r.shuffle(el); chosen, used, days = [], set(), set()
    for x in sorted(el, key=lambda x: 0):   # pass 1: prefer a new day, then a new consult
        pass
    for x in el:
        if x["consult"] in used or (L[x["rd"]]["date"] in days and len({L[m[0]]["date"] for m in mem}) > 1 and len(days) < 2 and len(chosen) < 2): continue
        chosen.append(x); used.add(x["consult"]); days.add(L[x["rd"]]["date"])
        if len(chosen) == 3: break
    for x in el:
        if len(chosen) == 3: break
        if x not in chosen and x["consult"] not in used: chosen.append(x); used.add(x["consult"])
    for x in el:
        if len(chosen) == 3: break
        if x not in chosen: chosen.append(x)
    rep = tuple(g["rep"]); others = [x for x in eligible(rep[0], None, V[rep].get("centroid"), consults_of(rep[0], doc)) if x["cos"] < SIM_CONTRAST and seg_overlap(x["rd"], x["win"], x["s"], x["e"]) is False]
    r.shuffle(others); contrast = others[:1]
    if len(chosen) < 3 or not contrast:
        key.append({"gid": g["gid"], "card_id": None, "reason": "not enough eligible clips", "tier": g["tier"], "n_eligible": len(el), "n_contrast": len(others)}); continue
    cid = secrets.token_hex(3); cl = []
    for k, x in enumerate(chosen + contrast):
        dst = f"{OUT}/audio/{cid}_{k}.mp3"; cut(x["win"], x["off"], x["dur"], dst)
        cl.append({"src": f"audio/{cid}_{k}.mp3", "duration_s": round(x["dur"], 1)})
        cliplist.append({"card_id": cid, "k": k, "role": "doctor" if k < 3 else "contrast", "room_day": x["rd"], "window_id": x["win"], "offset_s": x["off"], "dur_s": x["dur"], "cos_to_voice_centroid": round(x["cos"], 3), "turn_index": x["i"]})
    P = next(p for p in V[rep]["pairs"] if p["doctor_uid"] == doc); days_all = sorted({L[m[0]]["date"] for m in g["members"]})
    ev = [f"Voice timing: this voice is heard in {round(P['p_in']*100)}% of the busy minutes when the doctor is in a queue consult, and in {round(P['p_out']*100)}% of the busy minutes when they are not (a gap of {round(P['contrast']*100)} points; at a wrong time of day the gap would be about {round(P['null_mean']*100)} points).",
          f"Recurring: the voice is present in {P['present']} of {P['consults_room_active']} of the doctor's consults that day in this room.",
          f"Prescriptions: {g['rx_hits']} prescription(s) have a drug or test named in the words of this voice during the consult (drug and test words heard in English text only)."]
    if g["xday"]:
        ev.append(f"Cross-day: the same voice is heard on {g['n_room_days']} room-days ({', '.join(days_all)}), and each time the best match is this doctor.")
    elif g["n_room_days"] == 1 and len(g["members"]) == 1:
        ev.append("Cross-day: this voice was not found again on another day.")
    if g["staff_candidate"]:
        ev.append(f"WARNING: this voice matches different doctors on different days ({len(g['doctors_named'])} doctors), so it may be a nurse or attendant who stays in the room.")
    card = {"id": cid, "kind": "link", "room": D[rep[0]]["turns"]["room"]["room"], "date": L[rep[0]]["date"], "doctor": name_of(rep[0], doc), "evidence": ev, "clips": cl[:3], "contrast": cl[3], "batch": BATCH}
    json.dump(card, open(f"{OUT}/links/{cid}.json", "w"), indent=1); cards_n += 1
    key.append({"card_id": cid, "gid": g["gid"], "tier": g["tier"], "doctor_uid": doc, "members": g["members"], "rep": g["rep"], "criteria": {k: g[k] for k in ("xday", "excl", "staff_candidate", "n5", "rx", "stable", "lq")}, "n_room_days": g["n_room_days"],
                "core_turns_in_consults": g["core_turns_in_consults"], "rx_hits": g["rx_hits"], "stable_tolerances_max": g["stable_tolerances_max"], "excess_rep": g["excess_rep"], "doctors_named": g["doctors_named"],
                "jev": ({k: jev[g["gid"]][k] for k in ("q1_choice", "q1_confidence", "lq_noul", "control_noul", "lq_void", "jev_term")} if g["gid"] in jev else None),
                "clip_consults": len({x["consult"] for x in chosen}), "clip_days": len({L[x["rd"]]["date"] for x in chosen}), "n_eligible": len(el)})
    if g["tier"] in ("HIGH", "MED") and g["xday"]: pair_pool.append((g, cid, chosen, el))
# ---- 'Same person?' pair cards
pairs = 0
for g, cid, chosen, el in pair_pool[:10]:
    r = random.Random(SEED + 1000 + pairs); byday = collections.defaultdict(list)
    for x in el:
        if x not in chosen: byday[L[x["rd"]]["date"]].append(x)
    ds = [d for d in byday if byday[d]]
    if len(ds) < 2: continue
    a, b = r.choice(byday[ds[0]]), r.choice(byday[ds[1]]); pid = secrets.token_hex(3); cl = []
    for k, x in enumerate((a, b)):
        dst = f"{OUT}/audio/{pid}_{k}.mp3"; cut(x["win"], x["off"], x["dur"], dst); cl.append({"src": f"audio/{pid}_{k}.mp3", "duration_s": round(x["dur"], 1)})
        cliplist.append({"card_id": pid, "k": k, "role": "pair", "room_day": x["rd"], "window_id": x["win"], "offset_s": x["off"], "dur_s": x["dur"], "cos_to_voice_centroid": round(x["cos"], 3), "turn_index": x["i"]})
    json.dump({"id": pid, "kind": "pair", "a": cl[0], "b": cl[1], "batch": BATCH}, open(f"{OUT}/links/{pid}.json", "w"), indent=1)
    key.append({"card_id": pid, "kind": "pair", "gid": g["gid"], "tier": g["tier"], "same_voice_group": g["gid"], "doctor_uid": g["doctor_uid"]}); pairs += 1
json.dump(key, open(f"{OUT}/key.json", "w"), indent=1); json.dump(cliplist, open(f"{OUT}/clips.json", "w"), indent=1)
print("CARDS_DONE link cards", cards_n, "pair cards", pairs, "| no-clip", sum(1 for k in key if k.get("card_id") is None), "| tiers on page", dict(collections.Counter(k["tier"] for k in key if k.get("card_id") and k.get("kind") != "pair")))
