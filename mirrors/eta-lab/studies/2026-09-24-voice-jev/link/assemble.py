#!/usr/bin/env python3
"""vj-link steps 4-5 + artifacts (voice-lab-1): from link-<rd>.json (voicelink.py) build the pilot links, tiers, clips and cards.
Run: assemble.py rd_a rd_b ...   (in ~/vj/link)   Out: ~/vj/link/cards/{links/<id>.json, audio/<id>_<k>.mp3, key.json, clips.json}
 links   : per room-day the best (doctor, voice) by EXCESS, plus the best pair of a DIFFERENT doctor on a DIFFERENT voice (else the same voice, flagged 'competing'): 2 per room-day.
 cross-day (step 5): cosine between the voice centroids of the pilot links, and to the stored room-mic centroids (V-verified anchors). K4 (vj-refuter): evidence counts only against
           AGREED links or V-verified clips, and none exist yet, so 'cross-day' is reported and left UNMET in the tier; a link that would be HIGH otherwise is tiered 'HIGH-pending-xday'.
 clips   : per TURN (vj-refuter C1/C2): a turn of the voice's CORE inside one of the doctor's consults, no other diarizer speaker overlapping it, 4-8 s, per-turn cosine >= 0.60 to the voice
           centroid, from >= 3 different consults when they exist, chosen by a SEEDED random draw (seed 24092026 + link no.), never 'best sounding'. Contrast: a turn of another voice in the
           same room-day with cosine < 0.30 to the centroid (same rules). Cut from the 16 kHz window wav, MP3 32 kbps mono.
 cards   : exactly surg-page's contract (id, kind, room, date, doctor, evidence[], clips[3], contrast). Tier, scores, cluster ids only in key.json.
 Jev     : NOT run (LQ freeze pending); the evidence line says so."""
import json, os, random, subprocess, sys, secrets
import numpy as np
H = os.path.expanduser("~/vj/link"); OUT = f"{H}/cards"; os.makedirs(f"{OUT}/links", exist_ok=True); os.makedirs(f"{OUT}/audio", exist_ok=True)
SEED, SIM_CLIP, SIM_CONTRAST = 24092026, 0.60, 0.30
rds = sys.argv[1:]
D = {}
for rd in rds:
    L = json.load(open(f"{H}/link-{rd}.json")); T = json.load(open(f"{H}/turns-{rd}.json")); z = np.load(f"{H}/emb-{rd}.npz")
    D[rd] = {"link": L, "turns": T, "idx": z["idx"], "E": z["emb"].astype(np.float64), "emb_meta": {m["i"]: m for m in json.load(open(f"{H}/emb-{rd}.json"))}}


def pick_links(rd):
    P = D[rd]["link"]["pairs"]
    if not P: return []
    first = P[0]
    rest = [p for p in P if p["doctor_uid"] != first["doctor_uid"]]
    second = next((p for p in rest if p["cluster"] != first["cluster"]), rest[0] if rest else None)
    return [(first, False)] + ([(second, second["cluster"] == first["cluster"])] if second else [])


EDGE = {}
for rd in rds:
    dt = json.load(open(f"{H}/turns-{rd}.json"))["room"]["date"]
    if dt not in EDGE: EDGE[dt] = json.load(open(f"{H}/edge-{dt}.json"))
links = []
for rd in rds:
    for k, (p, competing) in enumerate(pick_links(rd)):
        rows = D[rd]["link"]["pairs"]
        others = [r for r in rows if r["doctor_uid"] != p["doctor_uid"]]
        runner = max((r["excess"] for r in others), default=None)
        links.append({"rd": rd, "rank_in_room": k + 1, "pair": p, "competing_voice": competing, "runner_up_excess": runner,
                      "centroid": np.array(D[rd]["link"]["centroids"][str(p["cluster"])])})
# ---- cross-day (step 5)
for a in links:
    a["xday"] = []
    for b in links:
        if a is b or a["rd"] == b["rd"]: continue
        a["xday"].append({"other_rd": b["rd"], "same_doctor": a["pair"]["doctor_uid"] == b["pair"]["doctor_uid"], "cos": round(float(a["centroid"] @ b["centroid"]), 3)})
    same = [x["cos"] for x in a["xday"] if x["same_doctor"]]; diff = [x["cos"] for x in a["xday"] if not x["same_doctor"]]
    a["xday_summary"] = {"same_doctor_links": len(same), "same_max": max(same) if same else None, "other_doctor_max": max(diff) if diff else None}


def stored_anchors():
    """Stored room/source centroids by pulse_uid (= PQM doctor_uid). Ruling 182: they barely match current audio, so this is INFORMATION only, never a criterion."""
    import base64
    out = {}
    cdir = os.path.expanduser("~/vj/centroids")
    for f in sorted(os.listdir(cdir)):
        if not f.endswith(".json") or f.endswith((".meta.json", "-raw.json", ".match.json")): continue
        try:
            j = json.load(open(f"{cdir}/{f}"))
            if "embedding_base64" not in j or not j.get("pulse_uid"): continue
            v = np.frombuffer(base64.b64decode(j["embedding_base64"]), dtype="<f4").astype(np.float64)
            if v.size == 192: out.setdefault(j["pulse_uid"], {})[f[:-5]] = v / np.linalg.norm(v)
        except Exception: pass
    return out


ANCH = stored_anchors()
for a in links:
    own = ANCH.get(a["pair"]["doctor_uid"], {})
    a["anchor_max"] = {"own_doctor": {k: round(float(a["centroid"] @ v), 3) for k, v in own.items()},
                       "other_doctors_max": round(max((float(a["centroid"] @ v) for u, d in ANCH.items() if u != a["pair"]["doctor_uid"] for v in d.values()), default=float("nan")), 3)}


# ---- clips
def seg_overlap(rd, win, s_ms, e_ms):
    for w in D[rd]["turns"]["windows"]:
        if w["window_id"] != win or not w.get("segments_json"): continue
        segs = w["segments_json"]; segs = json.loads(segs) if isinstance(segs, str) else segs
        w0 = int(w["start_ms"]); a, b = s_ms - w0, e_ms - w0
        spk = {}
        for g in segs:
            ov = min(b, g["end_ms"]) - max(a, g["start_ms"])
            if ov > 0: spk[g["speaker_idx"]] = spk.get(g["speaker_idx"], 0) + ov
        return len(spk) > 1 and sorted(spk.values())[-2] > 300   # another diarizer speaker overlaps > 0.3 s
    return None                                                     # no diarizer row: overlap unknown -> not eligible


def eligible(rd, cluster_or_not, cent, consults):
    d = D[rd]; T = d["turns"]["turns"]; E = d["E"]; idx = d["idx"]; out = []
    core = set(d["link"]["core_turn_idx"][str(cluster_or_not)]) if cluster_or_not is not None else None
    for n, i in enumerate(idx.tolist()):
        m = d["emb_meta"][i]
        if not (4.0 <= m["dur_s"] <= 8.0): continue
        t = T[i]; s, e = int(t["s_ms"]), int(t["e_ms"])
        cos = float(E[n] @ cent)
        out.append({"i": i, "n": n, "win": m["window_id"], "off": m["off_s"], "dur": m["dur_s"], "cos": cos, "s": s, "e": e,
                    "consult": next((c for c, (_, a, b) in enumerate(consults) if a - 30_000 <= s <= b + 30_000), None), "in_core": core is not None and i in core})
    return out


def cut(rd, win, off, dur, dst):
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{off:.2f}", "-t", f"{dur:.2f}", "-i", f"{H}/audio/{win}.wav", "-ac", "1", "-ar", "22050", "-b:a", "32k", dst], check=True)


import csv
from datetime import datetime
ms = lambda ts: int(datetime.fromisoformat(ts).timestamp() * 1000)
key, cards, cliplist, jev_in = [], [], [], []
for li, a in enumerate(links):
    rd = a["rd"]; p = a["pair"]; rng = random.Random(SEED + li); date = D[rd]["link"]["date"]
    pq = [r for r in csv.DictReader(open(f"{H}/pqm-{date}.csv")) if r["doctor_uid"] == p["doctor_uid"] and r["called_at"] and r["completed_at"]]
    consults = [(r["token_uid"], ms(r["called_at"]), ms(r["completed_at"])) for r in pq]
    el = [x for x in eligible(rd, p["cluster"], a["centroid"], consults) if x["in_core"] and x["cos"] >= SIM_CLIP and x["consult"] is not None and seg_overlap(rd, x["win"], x["s"], x["e"]) is False]
    rng.shuffle(el); chosen, used = [], set()
    for x in el:                                   # first pass: distinct consults
        if x["consult"] in used: continue
        chosen.append(x); used.add(x["consult"])
        if len(chosen) == 3: break
    for x in el:                                   # second pass only if fewer than 3 consults available
        if len(chosen) == 3: break
        if x not in chosen: chosen.append(x)
    others = [x for x in eligible(rd, None, a["centroid"], consults) if x["cos"] < SIM_CONTRAST and seg_overlap(rd, x["win"], x["s"], x["e"]) is False]
    rng.shuffle(others); contrast = others[:1]
    a["clips_ok"] = len(chosen) == 3 and len(contrast) == 1
    a["n_clip_consults"] = len({x["consult"] for x in chosen}); a["n_eligible"] = len(el)
    cid = secrets.token_hex(3)
    if not a["clips_ok"]:
        key.append({"card_id": None, "reason": "not enough eligible clips", "rd": rd, **{k: p[k] for k in ("doctor_uid", "cluster")}, "n_eligible": len(el), "n_contrast": len(others)}); continue
    cl = []
    for k, x in enumerate(chosen + contrast):
        dst = f"{OUT}/audio/{cid}_{k}.mp3"; cut(rd, x["win"], x["off"], x["dur"], dst)
        cl.append({"src": f"audio/{cid}_{k}.mp3", "duration_s": round(x["dur"], 1)})
        cliplist.append({"card_id": cid, "k": k, "role": "doctor" if k < 3 else "contrast", "room_day": rd, "window_id": x["win"], "offset_s": x["off"], "dur_s": x["dur"],
                         "cos_to_voice_centroid": round(x["cos"], 3), "consult_no": x["consult"], "turn_index": x["i"]})
    a["card_id"] = cid; a["clips"] = cl
    core_i = D[rd]["link"]["core_turn_idx"][str(p["cluster"])]; Tt = D[rd]["turns"]["turns"]
    jc = []
    for tok, ca, cb in consults:
        ti = [i for i in core_i if ca - 30_000 <= int(Tt[i]["s_ms"]) <= cb + 30_000]
        if len(ti) >= 2: jc.append({"token_uid": tok, "called_ms": ca, "completed_ms": cb, "turn_idx": ti})
    jev_in.append({"card_id": cid, "rd": rd, "doctor_uid": p["doctor_uid"], "doctor_name": p["doctor_name"], "consults": jc})
    # evidence in plain words (numbers only, no tier)
    edge = EDGE[date][rd].get(p["doctor_uid"], {})
    ev = [
          (f"Queue timing: {edge['aligned']} of {edge['consults']} of the doctor's consults start and end within 4-6 minutes of a conversation heard in this room (by chance about {edge['null_mean']}); it holds at {edge['stable_tolerances']} of 3 time tolerances, and this is only a shortlist filter." if edge else "Queue timing: not scored."),
          f"Voice timing: this voice is heard in {round(p['p_in']*100)}% of the busy minutes when the doctor is in a queue consult, and in {round(p['p_out']*100)}% of the busy minutes when they are not (a gap of {round(p['contrast']*100)} points; at a wrong time of day the gap would be about {round(p['null_mean']*100)} points).",
          f"Recurring: the voice is present in {p['present']} of {p['consults_room_active']} of the doctor's consults that day in this room.",
          f"Prescriptions: {p['rx_hit_by_voice']} of {p['rx']} prescriptions have a drug or test named in the words of this voice during the consult; {p['rx_hit_by_others']} are named by other voices (drug and test words heard in English text only).",
          "Jev: not asked yet (waiting for the question wording to be frozen).",
          ("Cross-day: matches this doctor's voice on another day (cos %.2f)." % a["xday_summary"]["same_max"]) if a["xday_summary"]["same_max"] is not None else "Cross-day: no other pilot day with this doctor to compare."]
    card = {"id": cid, "kind": "link", "room": D[rd]["turns"]["room"]["room"], "date": date, "doctor": p["doctor_name"], "evidence": ev,
            "clips": cl[:3], "contrast": cl[3], "batch": 0}   # batch 0 = the 21:00 pilot for Fable; V's first 60-card batch will be batch 1 (surg-page #725)
    json.dump(card, open(f"{OUT}/links/{cid}.json", "w"), indent=1); cards.append(card)
    m = {k: p[k] for k in ("excess", "contrast", "null_max", "present", "consults_room_active", "rx_hit_by_voice", "rx_hit_by_others")}
    edge = EDGE[date][rd].get(p["doctor_uid"], {})
    c1 = bool(edge.get("crit1"))      # ruling 189: edge-aligned consults minus the shifted-time null >= 2, doctor in the room-day's top 3 by z, exclusive across rooms
    c2 = m["consults_room_active"] >= 3 and m["present"] / m["consults_room_active"] >= 0.70                          # recurring voice
    c3 = m["rx_hit_by_voice"] >= 1                                                                                   # Rx items spoken (order); strict variant below (refuter K3)
    c3s = m["rx_hit_by_voice"] >= 1 and m["rx_hit_by_voice"] >= 0.5 * (m["rx_hit_by_voice"] + m["rx_hit_by_others"])
    # ruling 194 (d): criterion 1 alone never carries a tier: MED needs >= 3 criteria AND at least 2 of them other than crit 1; HIGH needs all five (crit 1 includes n >= 5 consults).
    def tier2(c1_, others): return "HIGH" if (c1_ and others == 4) else "MED" if (c1_ + others >= 3 and others >= 2) else "LOW"
    n_now = sum([c1, c2, c3]); tier = lambda n: None
    key.append({"card_id": cid, "edge": edge, "placebo_caveat": "lx #739: about half of crit-1 passers are chance; crit 1 is a shortlist filter", "criteria": {"timing_edge_ruling194": c1, "edge_stable_tolerances": edge.get("stable_tolerances"), "recurring": c2, "rx_ge1": c3, "rx_strict_share": c3s, "jev": "pending LQ freeze", "cross_day": "pending: no agreed link to compare with"},
                "tier_now": tier2(c1, int(c2) + int(c3)), "tier_if_jev_and_xday_pass": tier2(c1, int(c2) + int(c3) + 2), "tier_strict_rx_now": tier2(c1, int(c2) + int(c3s)), "room_day": rd, "rank_in_room": a["rank_in_room"], "competing_voice": a["competing_voice"], "doctor_uid": p["doctor_uid"], "cluster": p["cluster"],
                "metrics": {k: p[k] for k in ("excess", "contrast", "p_in", "p_out", "null_mean", "null_max", "present", "consults_room_active", "consults", "rx", "rx_hit_by_voice", "rx_hit_by_others", "rx_words_by_voice", "rx_words_total", "core_share_in_consults", "dominance_rank")},
                "runner_up_excess": a["runner_up_excess"], "xday": a["xday"], "xday_summary": a["xday_summary"], "anchors_ge_0.3": a["anchor_max"], "n_clip_consults": a["n_clip_consults"], "n_eligible": a["n_eligible"]})
json.dump(jev_in, open(f"{OUT}/jev_in.json", "w")); json.dump(key, open(f"{OUT}/key.json", "w"), indent=1); json.dump(cliplist, open(f"{OUT}/clips.json", "w"), indent=1)
print("ASSEMBLE_DONE links", len(links), "cards", len(cards), "no-clip", sum(1 for a in links if not a["clips_ok"]))
