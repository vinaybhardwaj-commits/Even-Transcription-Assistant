#!/usr/bin/env python3
"""vj-link steps 1-3 (voice-lab-1): which doctor's consults does a recurring VOICE in this room-day follow?  Run: voicelink.py <room_day_id>   (in ~/vj/link)
Inputs: emb-<rd>.npz (ECAPA per turn, embed_link.py), turns-<rd>.json, pqm-<date>.csv (lx's pqm_pull), rx-<date>.json (mb-rx's join).  Output: link-<rd>.json (doctor names: PHI, never in git).
1. VOICES: agglomerative (average linkage, cosine) over the room-day's turn embeddings, cut at sim 0.30; a cluster's CORE = turns with cos >= 0.45 to its centroid. The top clusters by core turns are the candidate 'recurring voices'.
2. TIMING x VOICE: per minute, is voice c heard (>= 1 core turn) and is doctor D in a PQM consult? For each (D, c): p_in = P(c heard | D consulting, room active), p_out = same when D is not consulting
   (room active = speech in the minute). CONTRAST = p_in - p_out; NULL = the same with D's consults shifted +-2 h, +-3 h (lx's null). EXCESS = contrast - null mean. A patient cannot follow a doctor's consults, only the doctor's voice can.
   PRESENT = share of D's consults (1-60 min, room active) in which c has >= 2 core turns inside [a-30 s, b+30 s]  (= step 2's 'recurring' share).
3. RX: of D's Rx (mb-rx), the number with >= 1 drug/test word heard in the window from c's core turns, and from all OTHER turns (rxscore.py matching).
Console prints ids and counts only."""
import bisect, csv, json, os, re, statistics, sys
from datetime import datetime
import numpy as np
from scipy.cluster.hierarchy import linkage, fcluster

H = os.path.expanduser(os.environ.get("LINK_H", "~/vj/link")); rd = sys.argv[1]
PL = float(os.environ.get("PLACEBO_H", "0")); SUF = f"-pl{os.environ['PLACEBO_H']}" if PL else ""   # placebo arm (ruling 201): every doctor time (PQM consults and Rx) shifted by a WRONG number of hours
SIM_CUT, CORE, TOPC, SHIFTS = 0.30, 0.45, 4, (-3, -2, 2, 3)   # cut set once from the pair-cosine distribution of ONE unlabelled room-day (23 Sep OPD 7), then fixed for all; no truth used
STOP = set("""tablet tablets capsule capsules syrup suspension injection inj cream gel ointment drops drop lotion solution powder sachet spray inhaler
 strip strips tab cap oral each daily twice thrice after before food meal meals morning night bedtime days week weeks month months forte plus extended release
 test tests blood profile complete count total serum level levels routine study scan screening panel with without fasting random report culture examination
 function general normal urine stool right left both view full body whole basic advanced package health checkup""".split())
WORD = re.compile(r"[a-z][a-z0-9]{4,}")
words = lambda s: [w for w in WORD.findall((s or "").lower()) if w not in STOP]


def close(a, b):
    from difflib import SequenceMatcher
    if a == b: return True
    if len(a) >= 6 and len(b) >= 6 and (a.startswith(b[:6]) or b.startswith(a[:6])): return True
    return len(a) >= 5 and len(b) >= 5 and a[0] == b[0] and abs(len(a) - len(b)) <= 2 and SequenceMatcher(None, a, b).ratio() >= 0.86


d = json.load(open(f"{H}/turns-{rd}.json")); date = d["room"]["date"]
z = np.load(f"{H}/emb-{rd}.npz"); idx, E = z["idx"], z["emb"].astype(np.float64)
T = d["turns"]
S = np.array([int(T[i]["s_ms"]) for i in idx]); Eend = np.array([int(T[i]["e_ms"]) for i in idx])
# ---- 1. voices
Z = linkage(E, "average", metric="cosine"); lab = fcluster(Z, 1 - SIM_CUT, "distance")
cent, core = {}, {}
for c in set(lab):
    m = lab == c; v = E[m].mean(0); v /= np.linalg.norm(v); cent[c] = v
    sim = E @ v; core[c] = np.where(m & (sim >= CORE))[0]
top = sorted(core, key=lambda c: -len(core[c]))[:TOPC]
top = [c for c in top if len(core[c]) >= 25]
# ---- minutes
room_min = set()
for t in T:
    if t.get("s_ms") and t.get("e_ms"):
        for m in range(int(t["s_ms"]) // 60000, int(t["e_ms"]) // 60000 + 1): room_min.add(m)
heard = {c: set((S[core[c]] // 60000).tolist()) for c in top}
pqm = list(csv.DictReader(open(f"{H}/pqm-{date}.csv"))); name_of = {p["doctor_uid"]: p["doctor_name"] for p in pqm}
ms = lambda ts: int(datetime.fromisoformat(ts).timestamp() * 1000)
by = {}
for p in pqm:
    if p["called_at"] and p["completed_at"]:
        a, b = ms(p["called_at"]) + int(PL * 3_600_000), ms(p["completed_at"]) + int(PL * 3_600_000)
        if 60_000 <= b - a <= 3_600_000: by.setdefault(p["doctor_uid"], []).append((p["token_uid"], a, b))


def contrast(cs, c, shift=0):
    inn = set()
    for _, a, b in cs:
        for m in range((a + shift) // 60000, (b + shift - 1) // 60000 + 1): inn.add(m)
    lo, hi = min(inn) - 30, max(inn) + 30                         # D's working span (+-30 min)
    ain = [m for m in room_min if m in inn]; aout = [m for m in room_min if lo <= m <= hi and m not in inn]
    if len(ain) < 10 or len(aout) < 10: return None, None, len(ain), len(aout)
    pi = sum(m in heard[c] for m in ain) / len(ain); po = sum(m in heard[c] for m in aout) / len(aout)
    return pi, po, len(ain), len(aout)


def n_core_in(c, a, b): return int(((S[core[c]] >= a - 30_000) & (S[core[c]] <= b + 30_000)).sum())


res = []
for doc, cs in by.items():
    if len(cs) < 3: continue
    for c in top:
        pi, po, nin, nout = contrast(cs, c)
        if pi is None: continue
        nulls = []
        for h in SHIFTS:
            x = contrast(cs, c, h * 3_600_000)
            if x[0] is not None: nulls.append(x[0] - x[1])
        inn = {m for _, a, b in cs for m in range(a // 60000, (b - 1) // 60000 + 1)}          # K1 (vj-refuter): is this voice the DOMINANT one in the doctor's consults (a nurse or attendant would not be)?
        in_turn = np.array([(S[n] // 60000) in inn for n in range(len(S))])
        share = {k: (len([n for n in core[k] if in_turn[n]]) / max(1, int(in_turn.sum()))) for k in top}
        dom_rank = sorted(top, key=lambda k: -share[k]).index(c) + 1
        active = [(t, a, b) for t, a, b in cs if sum(1 for m in range(a // 60000, (b - 1) // 60000 + 1) if m in room_min) >= 0.5 * max(1, (b - a) // 60000)]
        pres = [t for t, a, b in active if n_core_in(c, a, b) >= 2]
        core_in = sum(n_core_in(c, a, b) for _, a, b in cs)
        res.append({"doctor_uid": doc, "doctor_name": name_of.get(doc), "cluster": int(c), "consults": len(cs), "consults_room_active": len(active), "present": len(pres),
                    "present_share": round(len(pres) / len(active), 2) if active else None, "p_in": round(pi, 3), "p_out": round(po, 3), "contrast": round(pi - po, 3),
                    "null_mean": round(statistics.mean(nulls), 3) if nulls else None, "null_max": round(max(nulls), 3) if nulls else None,
                    "excess": round(pi - po - statistics.mean(nulls), 3) if nulls else None, "core_turns_in_consults": core_in, "core_share_in_consults": round(share[c], 3), "dominance_rank": dom_rank, "minutes_in": nin, "minutes_out": nout, "present_tokens": pres})
res = [r for r in res if r["excess"] is not None and r["consults_room_active"] >= 3 and r["minutes_in"] >= 30]   # a doctor with < 3 consults heard in this room cannot be judged
for r in res: r["beats_null_max"] = bool(r["contrast"] > r["null_max"])
res.sort(key=lambda r: -r["excess"])
# ---- 3. Rx by voice
rx = [r for r in json.load(open(f"{H}/rx-{date}.json")) if not r["is_draft"] and (r["meds"] or r["tests"])]
for r in rx:
    r["start_ms"] += int(PL * 3_600_000)
    if r["end_ms"]: r["end_ms"] += int(PL * 3_600_000)


def iw(r):
    o = set()
    for m in r["meds"]:
        for k in ("brand_name", "generic_name"): o.update(words(m.get(k)))
    for t in r["tests"]: o.update(words(t.get("name")))
    return o


for r in rx: r["_w"] = iw(r)
tw = [set(words(t.get("text"))) for t in T]
tstart = np.array([int(t["s_ms"]) if t.get("s_ms") else 0 for t in T]); tend = np.array([int(t["e_ms"]) if t.get("e_ms") else 0 for t in T])
core_turn = {c: set(idx[core[c]].tolist()) for c in top}


def heard_words(a, b, only=None, exclude=None):
    out = set()
    for i in np.where((tend >= a) & (tstart <= b))[0]:
        if only is not None and i not in only: continue
        if exclude is not None and i in exclude: continue
        out |= tw[i]
    return out


for r in res[:40]:
    docrx = [x for x in rx if x["doctor_uid"] == r["doctor_uid"] and x["_w"]]; hc = ho = 0; items_c = 0; items_all = 0
    for x in docrx:
        end = x["end_ms"] if x["end_ms"] and 0 < x["end_ms"] - x["start_ms"] <= 2_400_000 else x["start_ms"] + 720_000
        a, b = x["start_ms"] - 60_000, end + 60_000
        Hc = heard_words(a, b, only=core_turn[r["cluster"]]); Ho = heard_words(a, b, exclude=core_turn[r["cluster"]])
        wc = {w for w in x["_w"] if any(close(w, h) for h in Hc)}; wo = {w for w in x["_w"] if any(close(w, h) for h in Ho)}
        hc += bool(wc); ho += bool(wo); items_c += len(wc); items_all += len(x["_w"])
    r.update({"rx": len(docrx), "rx_hit_by_voice": hc, "rx_hit_by_others": ho, "rx_words_by_voice": items_c, "rx_words_total": items_all})
json.dump({"room": d["room"], "date": date, "n_turns_embedded": int(len(idx)), "clusters": {int(c): {"core_turns": int(len(core[c])), "all_turns": int((lab == c).sum())} for c in top},
           "pairs": res[:40], "centroids": {int(c): cent[c].tolist() for c in top}, "core_turn_idx": {int(c): idx[core[c]].tolist() for c in top}}, open(f"{H}/link-{rd}{SUF}.json", "w"))
os.chmod(f"{H}/link-{rd}{SUF}.json", 0o600)
print(f"LINK_DONE {rd} {d['room']['room']} {date} turns={len(idx)} clusters={len(set(lab))} top={[(int(c), len(core[c])) for c in top]}")
for r in res[:5]:
    print(f"  {r['doctor_uid']} c{r['cluster']} excess={r['excess']} contrast={r['contrast']} (in {r['p_in']} out {r['p_out']} null {r['null_mean']}/{r['null_max']}) present={r['present']}/{r['consults_room_active']} rx voice/others={r['rx_hit_by_voice']}/{r['rx_hit_by_others']} of {r['rx']}")
