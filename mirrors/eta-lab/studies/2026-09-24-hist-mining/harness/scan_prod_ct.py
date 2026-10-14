#!/usr/bin/env python3
"""scan_prod_ct.py — plain-CT cue scan over PRODUCTION stt_turn transcripts (read-only Neon, per IST day) for ruling 164. v2 after eta-refuter-2 #580:
  * hits are DEDUPED BY PASSAGE (room_day + sha1 of the normalised turn text): overlapping windows repeat turns (20 samples were ~12 distinct passages);
  * categories: candidate (strong CT, not history-only) | history_only (strong CT, only history cues) | weak_scan ('scan'+body part, modality unknown; NOT a candidate) | angio_only;
  * seeded precision sample = 15 candidates + 10 history_only, each with +-90 s neighbouring turns, so BOTH the candidate precision and the false-veto rate of the history rule can be judged.
Prefilter in SQL is a superset; the exact rule is ct_cues.scan. Writes counts (no text) to ct_prod_counts.json and the text sample to ct_precision_sample_v2.json (0600, ~/eta-data/hist-mining/). Prints counts only."""
import hashlib, json, os, random, re, subprocess, sys
from collections import Counter
from datetime import date, timedelta
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ct_cues
HM = os.path.expanduser("~/eta-data/hist-mining")
NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs"); ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant")
def neon(q):
    r = subprocess.run(["node", NEON, q], cwd=ETA, capture_output=True, text=True, timeout=300)
    if r.returncode: raise SystemExit(f"neon-select rc={r.returncode}")
    return json.loads(r.stdout)
PRE = r"(\mc\.?\s?t\M|\mct\M|scan|city|\mcat\M|ncct|hrct|tomograph|सी|सि|ಸಿ)"
def category(s):
    if s["plain_ct"]: return "candidate" if s["candidate"] else "history_only"
    if s["weak_scan"]: return "weak_scan"
    return "angio_only" if s["ct_angio"] else None
d, end = date(2026, 8, 1), date(2026, 9, 24)
seen, hits, turns_seen, raw_hits = set(), [], 0, 0
while d <= end:
    lo, hi = (d - timedelta(days=1)).isoformat() + "T18:30:00Z", d.isoformat() + "T18:30:00Z"     # IST day
    for r in neon(f"SELECT cu.room_day_id, cu.at, cu.payload->>'text' AS t FROM cue cu WHERE cu.type='stt_turn' AND cu.at >= '{lo}' AND cu.at < '{hi}' AND (cu.payload->>'text') ~* '{PRE}'"):
        turns_seen += 1; s = ct_cues.scan(r["t"]); cat = category(s)
        if not cat: continue
        raw_hits += 1
        key = (r["room_day_id"], hashlib.sha1(re.sub(r"\W+", " ", (r["t"] or "").lower()).strip().encode()).hexdigest())
        if key in seen: continue
        seen.add(key)
        hits.append({"day": d.isoformat(), "room_day_id": r["room_day_id"], "at": r["at"], "cat": cat, "hint": s["proposal_hint"], "declined": s["declined_cue"], "angio": s["ct_angio"], "contrast": s["contrast_mentioned"], "text": r["t"]})
    d += timedelta(days=1)
# passage merge: hits in the same room_day within 120 s are ONE passage (overlapping windows repeat the same speech with slightly different text; eta-refuter-2 #580); keep the first, the strongest category wins
from datetime import datetime
RANK = {"candidate": 3, "history_only": 2, "weak_scan": 1, "angio_only": 0}
hits.sort(key=lambda h: (h["room_day_id"], h["at"])); merged = []
for h in hits:
    t = datetime.fromisoformat(h["at"].replace("Z", "+00:00"))
    if merged and merged[-1]["room_day_id"] == h["room_day_id"] and (t - merged[-1]["_t"]).total_seconds() <= 120:
        if RANK[h["cat"]] > RANK[merged[-1]["cat"]]: merged[-1].update({k: v for k, v in h.items() if k != "at"})
        merged[-1]["_t"] = t; continue
    merged.append({**h, "_t": t})
hits = merged
summ = {"prefilter_turns": turns_seen, "hits_before_dedupe": raw_hits, "distinct_passages_120s": len(hits), "by_category": dict(Counter(h["cat"] for h in hits)),
        "candidate_by_hint": dict(Counter(h["hint"] for h in hits if h["cat"] == "candidate")), "candidates_with_declined_cue": sum(1 for h in hits if h["cat"] == "candidate" and h["declined"]),
        "contrast_flagged": sum(1 for h in hits if h["contrast"]), "room_days_with_candidates": len({h["room_day_id"] for h in hits if h["cat"] == "candidate"})}
json.dump(summ, open(f"{HM}/ct_prod_counts.json", "w"), indent=1); os.chmod(f"{HM}/ct_prod_counts.json", 0o600)
rnd = random.Random(164); cand = [h for h in hits if h["cat"] == "candidate"]; hist = [h for h in hits if h["cat"] == "history_only"]
pick = rnd.sample(cand, min(15, len(cand))) + rnd.sample(hist, min(10, len(hist))); out, ids = [], []
for i, h in enumerate(pick, 1):
    ok = all(c.isalnum() or c == "_" for c in h["room_day_id"])
    nb = neon(f"SELECT cu.payload->>'text' AS t FROM cue cu WHERE cu.type='stt_turn' AND cu.room_day_id='{h['room_day_id']}' AND cu.at BETWEEN '{h['at']}'::timestamptz - interval '90 seconds' AND '{h['at']}'::timestamptz + interval '90 seconds' ORDER BY cu.at") if ok else []
    ids.append({"n": i, "room_day_id": h["room_day_id"], "at": h["at"], "day": h["day"], "cat": h["cat"]})
    out.append({"n": i, "cat": h["cat"], "hint": h["hint"], "declined_cue": h["declined"], "day": h["day"], "hit_turn": h["text"], "context_turns_90s": [x["t"] for x in nb]})
json.dump(ids, open(f"{HM}/ct_pool_ids.json", "w"), indent=1); os.chmod(f"{HM}/ct_pool_ids.json", 0o600)      # pool n -> room_day_id + time (ids only)
json.dump(out, open(f"{HM}/ct_precision_sample_v2.json", "w"), ensure_ascii=False, indent=1); os.chmod(f"{HM}/ct_precision_sample_v2.json", 0o600)
print(json.dumps(summ), "| sample:", len(out), "(candidates", sum(1 for o in out if o["cat"] == "candidate"), "+ history_only", sum(1 for o in out if o["cat"] == "history_only"), ")")
