#!/usr/bin/env python3
"""stage_pool.py — SURGERY-REVIEW-V3: stage the WHOLE candidate pool as RAW consult files for de-identification (never shared) in ~/eta-data/surgery-review-v3/pool/staging/Q<nn>.json.
Pool = (a) unlabelled consults of voiceprint-confirmed rooms, 21-24 Sep, 3-45 min, >=600 chars (pool-voiceprint.json) UNION (b) truth anchors that could be placed in a room and are
unlabelled and usable. Ids are neutral (Q01..): they do not encode source or booking. pool/index.json (0600) keeps the private facts: source, booked procedure, token, room-day, span.
Turns come from stt_turn cues joined to the diarize speaker roles (fetch_turns.label_turns), the PQM window. Counts only are printed."""
import json, os
from collections import Counter
from datetime import datetime
import fetch_turns, scan_anchors as sa

V3 = os.path.expanduser("~/eta-data/surgery-review-v3")
P = f"{V3}/pool"


def main():
    os.makedirs(f"{P}/staging", exist_ok=True); os.chmod(P, 0o700); os.chmod(f"{P}/staging", 0o700)
    cands = {}
    for c in json.load(open(f"{V3}/pool-voiceprint.json")):
        cands[c["token_uid"]] = {"token_uid": c["token_uid"], "room_day_id": c["room_day_id"], "called": c["called"], "done": c["done"], "source": "voiceprint_pool", "booked_procedure": None,
                                 "day": c["called"][:10], "placed_by": "voiceprint"}
    placed, skipped = sa.placed()
    for r in placed:
        cur = cands.get(r["token_uid"])
        mins = (datetime.fromisoformat(r["done"]) - datetime.fromisoformat(r["called"])).total_seconds() / 60
        if not (3 <= mins <= 45):
            continue
        base = {"token_uid": r["token_uid"], "room_day_id": r["room_day_id"], "called": r["called"], "done": r["done"], "day": r["day"], "placed_by": r["placed_by"]}
        cands[r["token_uid"]] = {**(cur or base), "source": "anchor", "booked_procedure": r["booked_procedure"], "anchor_terms": r["terms"]}
    order = sorted(cands.values(), key=lambda x: (x["day"], x["token_uid"]))
    idx = {}
    for n, c in enumerate(order, 1):
        qid = f"Q{n:02d}"
        turns = fetch_turns.fetch({"room_day_id": c["room_day_id"], "called": c["called"], "done": c["done"]})
        chars = sum(len(t["text"]) for t in turns)
        if chars < 600:
            continue
        doc = {"id": qid, "turns": [{"i": i, "speaker": t["speaker"], "lang": "en", "orig": t["text"], "en": t["text"]} for i, t in enumerate(turns)]}
        p = f"{P}/staging/{qid}.json"; json.dump(doc, open(p, "w"), ensure_ascii=False); os.chmod(p, 0o600)
        idx[qid] = {**c, "turns": len(turns), "chars": chars}
    json.dump(idx, open(f"{P}/index.json", "w"), indent=1); os.chmod(f"{P}/index.json", 0o600)
    print("staged", len(idx), "| by source:", dict(Counter(v["source"] for v in idx.values())), "| by day:", dict(Counter(v["day"] for v in idx.values())),
          "| total chars:", sum(v["chars"] for v in idx.values()), "| anchors skipped:", dict(skipped))


if __name__ == "__main__":
    main()
