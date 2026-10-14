#!/usr/bin/env python3
"""vj-link ruling 250 (box, venv-gpu): KNOWN-VOICE CHECK cards for stored-print doctors: Salanki g071, Banerjee g008, Ankit g013 (weak anchor). Non-enrolment room-days only; only member voices whose centroid matches the doctor's stored print
at cos >= 0.60 are used. Per-turn clips as for the other cards (core turn, single diarizer speaker, 4-5 s, per-turn cos >= 0.60 to the member voice centroid, seeded draw, seed 24092026 + 5000 + n), 3 clips from different room-days when they exist,
contrast = a turn of another voice with cos < 0.30 (same rules). The proposed doctor is the ANCHOR's doctor (stored print), not the timing best doctor; no timing line and no timing caveat on these cards. Labelled 'KNOWN-VOICE CHECK' in the first evidence line.
Also drops the batch-1b LOW cards for g071 and g008 (same voices, timing-labelled: one is the wrong doctor) so the page never shows one voice under two labels.  Usage: anchored_cards.py     (BATCH=batch1b in ~/eta-data/voice-linkage)"""
import base64, collections, csv, glob, json, os, random, re, secrets, subprocess, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tiering as T
BOX = os.path.expanduser("~/eta-data/voice-linkage"); E = f"{BOX}/dtree_ext"; B = f"{BOX}/batch1b"; KEYF = f"{BOX}/batch1b-key/key.json"; ANCH_DIR = "/tmp/anch"; SEED = 24092026; TARGETS = ("g071", "g008", "g013"); DROP_GIDS = ("g071", "g008")
norm = lambda n: " ".join((n or "").lower().replace("dr.", "").replace("dr ", "").replace(".", " ").split())
name2uid, uid2name = {}, {}
for f in glob.glob(f"{BOX}/pilot/pqm-2026-09-*.csv"):
    for r in csv.DictReader(open(f)): name2uid[norm(r["doctor_name"])] = r["doctor_uid"]; uid2name[r["doctor_uid"]] = r["doctor_name"]
anch, ENROL = collections.defaultdict(dict), collections.defaultdict(set)
for f in sorted(glob.glob(f"{ANCH_DIR}/*.json")):
    b = os.path.basename(f)
    if any(w in b for w in ("payload", "meta", "raw", "match")) or b.startswith("ankit-pwa"): continue
    try: j = json.load(open(f))
    except Exception: continue
    k = j.get("embedding_base64") or j.get("centroid_base64")
    if not k: continue
    v = np.frombuffer(base64.b64decode(k), dtype="<f4").astype(float)
    if v.size != 192: continue
    uid = j.get("pulse_uid") or name2uid.get(norm(j.get("display_name") or j.get("full_name"))) or (b.split("-")[-1][:-5] if len(b.split("-")[-1][:-5]) == 20 else None)
    if not uid: continue
    anch[uid][b[:26]] = v / np.linalg.norm(v)
    for m in (f, f.replace(".json", ".meta.json"), f.replace(".json", "-payload.json")):
        if os.path.exists(m): ENROL[uid] |= set(re.findall(r"bs_[a-z0-9]{8}", open(m).read()))
glinks = {x["gid"]: x for x in json.load(open(f"{E}/overnight/glinks-complete.json"))}
rds = sorted({m[0] for g in TARGETS for m in glinks[g]["members"]}); L = T.load(rds, E); V = T.voices(L)
D = {}
for rd in rds:
    z = np.load(f"{E}/emb-{rd}.npz"); D[rd] = {"turns": json.load(open(f"{E}/turns-{rd}.json")), "idx": z["idx"], "E": z["emb"].astype(np.float64), "meta": {m["i"]: m for m in json.load(open(f"{E}/emb-{rd}.json"))}}
sessions_of = lambda rd: {"bs_" + w["window_id"].split("_")[1] for w in D[rd]["turns"]["windows"]}
cent = lambda rd, c: V[(rd, c)]["centroid"] / np.linalg.norm(V[(rd, c)]["centroid"])
def seg_overlap(rd, win, s_ms, e_ms):
    for w in D[rd]["turns"]["windows"]:
        if w["window_id"] != win or not w.get("segments_json"): continue
        segs = w["segments_json"]; segs = json.loads(segs) if isinstance(segs, str) else segs; w0 = int(w["start_ms"]); a, b = s_ms - w0, e_ms - w0; spk = {}
        for g in segs:
            ov = min(b, g["end_ms"]) - max(a, g["start_ms"])
            if ov > 0: spk[g["speaker_idx"]] = spk.get(g["speaker_idx"], 0) + ov
        return len(spk) > 1 and sorted(spk.values())[-2] > 300
    return None
def turns_of(rd, c, core_only, cv):
    d = D[rd]; Tt = d["turns"]["turns"]; core = set(L[rd]["core_turn_idx"][str(c)]) if core_only else None; out = []
    for n, i in enumerate(d["idx"].tolist()):
        m = d["meta"][i]
        if not (4.0 <= m["dur_s"] <= 8.0): continue
        cos = float(d["E"][n] @ cv)
        if core_only and (i not in core or cos < 0.60): continue
        if not core_only and cos >= 0.30: continue
        t = Tt[i]; s, e = int(t["s_ms"]), int(t["e_ms"])
        if seg_overlap(rd, m["window_id"], s, e) is not False: continue
        out.append({"rd": rd, "i": i, "win": m["window_id"], "off": m["off_s"], "dur": m["dur_s"], "cos": cos})
    return out
def cut(win, off, dur, dst): subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{off:.2f}", "-t", f"{dur:.2f}", "-i", f"{BOX}/pilot/audio/{win}.wav", "-ac", "1", "-ar", "22050", "-b:a", "32k", dst], check=True)
key = json.load(open(KEYF)); made, dropped = [], []
# drop the timing-labelled duplicates of the anchored voices
for k in list(key):
    if k.get("card_id") and k.get("kind") != "pair" and k.get("gid") in DROP_GIDS:
        for p in glob.glob(f"{B}/audio/{k['card_id']}_*.mp3") + [f"{B}/links/{k['card_id']}.json"]: os.remove(p)
        key.remove(k); dropped.append((k["card_id"], k["gid"]))
for n, gid in enumerate(TARGETS):
    A = json.load(open(f"{E}/overnight/anchored-groups.json")); a = next(x for x in A if x["gid"] == gid); doc = a["anchor_doctor_uid"]; r = random.Random(SEED + 5000 + n)
    mem = [(rd, c) for rd, c in glinks[gid]["members"] if not (sessions_of(rd) & ENROL[doc]) and max(float(cent(rd, c) @ p) for p in anch[doc].values()) >= 0.60]
    cosv = [max(float(cent(rd, c) @ p) for p in anch[doc].values()) for rd, c in mem]
    pool = {m: turns_of(m[0], m[1], True, cent(*m)) for m in mem}
    order = sorted(mem, key=lambda m: -len(pool[m])); chosen, used = [], set()
    for m in order:                                    # one clip per room-day first
        if pool[m] and m[0] not in used: chosen.append(r.choice(pool[m])); used.add(m[0])
        if len(chosen) == 3: break
    allp = [x for m in mem for x in pool[m] if x not in chosen]; r.shuffle(allp)
    while len(chosen) < 3 and allp: chosen.append(allp.pop())
    rep = order[0]; cont = turns_of(rep[0], None, False, cent(*rep)); r.shuffle(cont)
    if len(chosen) < 3 or not cont: print("NOT ENOUGH CLIPS", gid, len(chosen), len(cont)); continue
    cid = secrets.token_hex(3); cl = []
    for k, x in enumerate(chosen + cont[:1]):
        dst = f"{B}/audio/{cid}_{k}.mp3"; cut(x["win"], x["off"], x["dur"], dst); cl.append({"src": f"audio/{cid}_{k}.mp3", "duration_s": round(x["dur"], 1)})
    name = uid2name.get(doc); rooms = sorted({D[rd]["turns"]["room"]["room"] for rd, _ in glinks[gid]["members"]}); days = sorted({L[rd]["date"] for rd, _ in glinks[gid]["members"]})
    ev = [f"KNOWN-VOICE CHECK. This voice matches {name}'s stored voiceprint on {len(mem)} recording days (similarity {min(cosv):.2f} to {max(cosv):.2f} on a 0 to 1 scale; the doctor's own enrolment recordings are left out). Please listen: does it sound like this doctor?",
          f"The same voice is heard on {glinks[gid]['n_room_days']} room-days between {days[0]} and {days[-1]}, in {', '.join(rooms)}.",
          "How to read the similarity: above 0.85 is a strong match; 0.60 to 0.70 is moderate (a stored voiceprint made in one room matches other rooms and microphones less well)."]
    card = {"id": cid, "kind": "link", "room": D[rep[0]]["turns"]["room"]["room"], "date": L[rep[0]]["date"], "doctor": name, "evidence": ev, "clips": cl[:3], "contrast": cl[3], "batch": 1}
    json.dump(card, open(f"{B}/links/{cid}.json", "w"), indent=1)
    key.append({"card_id": cid, "gid": gid, "tier": "ANCHORED", "kind_note": "known-voice check", "doctor_uid": doc, "anchor_cos_by_day": [round(c, 3) for c in cosv], "members_used": [list(m) for m in mem], "enrolment_sessions_excluded": sorted(ENROL[doc]),
                "n_room_days_group": glinks[gid]["n_room_days"], "rep": list(rep), "clip_days": len({x["rd"] for x in chosen})})
    made.append((cid, gid, name is not None, len(mem), round(min(cosv), 2), round(max(cosv), 2), len({x["rd"] for x in chosen})))
json.dump(key, open(KEYF, "w"), indent=1)
print("dropped (timing-labelled duplicates):", dropped); print("made known-voice cards (id, group, name found, matching days, cos min, max, clip days):", made)
