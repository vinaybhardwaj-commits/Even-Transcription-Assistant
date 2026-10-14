#!/usr/bin/env python3
"""wide_scan.py — SURGERY-REVIEW-V3, more look-alikes (ruling 85): the placeable universe from voiceprint rooms is exhausted (5 doctors). CANDIDATE GENERATOR for the other consults of 21-24 Sep:
place a consult in the room whose transcript, in its PQM window (+-1 min), holds >=2 DISTINCT SPECIFIC procedure terms (lexicon.ALIAS vocabulary: never the generic words surgery/operation/procedure,
Fable: no keyword-only selection) and clearly more than any other room (best >= 2x the second, or the second has none). This only decides what gets SCORED: Jev (frozen wording), lx bounds, the
neighbour trim, the boundary review and the blind judge decide what enters the set. Read-only. Writes ~/eta-data/surgery-review-v3/selected_wide.json (ids W01..; private facts, 0600) and prints counts only."""
import json, os, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import anchor as an, locate, lexicon, select_v3 as sv

V3 = sv.V3
SPECIFIC = sorted({t for al in lexicon.ALIAS.values() for t in al} - lexicon.GENERIC)


def decide(rows):
    """rows [{room_day_id, t}] -> (room_day_id, best_terms) or None. Pure."""
    hits = {r["room_day_id"]: lexicon.hits(r["t"] or "", SPECIFIC) for r in rows}
    ranked = sorted(hits.items(), key=lambda kv: -len(kv[1]))
    if not ranked or len(ranked[0][1]) < 2:
        return None
    if len(ranked) > 1 and len(ranked[1][1]) * 2 > len(ranked[0][1]):
        return None
    return ranked[0][0], ranked[0][1]


def selftest():
    a = {"room_day_id": "A", "t": "we plan a hernia repair and the gall bladder stones"}
    b = {"room_day_id": "B", "t": "this is a big operation and surgery"}
    assert decide([a, b]) == ("A", ["gall bladder", "hernia"]) or decide([a, b])[0] == "A"
    assert decide([{"room_day_id": "A", "t": "hernia only"}, b]) is None, "one specific term is not enough"
    assert decide([{"room_day_id": "A", "t": "surgery operation procedure package"}]) is None, "generic words never count"
    assert decide([a, {"room_day_id": "B", "t": "hernia and gall bladder and stones"}]) is None, "two rooms with equal hits: ambiguous"
    assert decide([a, {"room_day_id": "B", "t": "hernia"}])[0] == "A", "second room with 1 vs 2+ hits (2x rule)"
    assert decide([]) is None
    print("wide_scan selftest OK")


def main():
    an.FROM, an.TO = "2026-09-21", "2026-09-24"
    cons = an.consults(); lab = sv.labelled()
    seen = {v["token_uid"] for v in json.load(open(f"{V3}/pool/index.json")).values()} | {v["token_uid"] for v in json.load(open(f"{V3}/selected_cand2.json")).values()}
    todo, skipped = [], {"seen": 0, "duration": 0, "labelled": 0}
    for c in cons:
        mins = (c["done"] - c["called"]).total_seconds() / 60
        item = {"token_uid": c["token_uid"], "room_day_id": None, "called": c["called"].isoformat(), "done": c["done"].isoformat()}
        if c["token_uid"] in seen:
            skipped["seen"] += 1; continue
        if not (3 <= mins <= 45):
            skipped["duration"] += 1; continue
        if any(t == c["token_uid"] for t, _, _, _ in lab):
            skipped["labelled"] += 1; continue
        todo.append(c)
    print("consults 21-24 Sep:", len(cons), "| to place:", len(todo), "| skipped:", skipped)

    def one(c):
        try:
            rows = locate.rooms_in_window({"called": c["called"].isoformat(), "done": c["done"].isoformat()})
        except SystemExit:
            return c, "error"
        return c, decide(rows)
    out, stat = {}, {"placed": 0, "none": 0, "error": 0, "labelled_time": 0}
    with ThreadPoolExecutor(6) as ex:
        for c, r in ex.map(one, todo):
            if r == "error":
                stat["error"] += 1; continue
            if r is None:
                stat["none"] += 1; continue
            rd, terms = r
            item = {"token_uid": c["token_uid"], "room_day_id": rd, "called": c["called"].isoformat(), "done": c["done"].isoformat()}
            if sv.leaks(item, lab):
                stat["labelled_time"] += 1; continue
            n = len(out) + 1
            out[f"W{n:02d}"] = {**item, "day": c["called"].date().isoformat(), "source": "content_placed", "booked_procedure": None, "doctor_uid": c["doctor_uid"], "doctor_name": c["doctor_name"], "terms": terms}
            stat["placed"] += 1
    print("placement:", stat, "| by day:", {d: sum(1 for v in out.values() if v["day"] == d) for d in sorted({v["day"] for v in out.values()})})
    p = f"{V3}/selected_wide.json"; json.dump(out, open(p, "w"), indent=1); os.chmod(p, 0o600)
    items = [{"item_id": q, "room_day_id": v["room_day_id"], "ist_date": v["day"], "called_at": v["called"], "completed_at": v["done"], "doctor_uid": v["doctor_uid"]} for q, v in out.items()]
    p = f"{V3}/items_wide.json"; json.dump(items, open(p, "w"), indent=1); os.chmod(p, 0o600)


if __name__ == "__main__":
    selftest() if sys.argv[1:] == ["--selftest"] else main()
