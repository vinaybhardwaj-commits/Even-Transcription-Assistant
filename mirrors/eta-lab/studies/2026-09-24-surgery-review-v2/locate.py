#!/usr/bin/env python3
"""locate.py — SURGERY-REVIEW-V3 truth anchor step 3: find WHICH ROOM an anchored consult happened in, by CONTENT, and keep it only if the transcript holds the booked procedure.
Why by content: doctor -> room needs a voiceprint-confirmed room-day, which exists for only ~5 doctors, so most anchors have no room. Method: take the consult's PQM window
(called -1 min .. completed +1 min), read EVERY room's transcript in that window (read-only, neon-select), and match the booked procedure's SPECIFIC spoken terms (lexicon.py; generic
words never count). A room with hits is the located room. Decisions: located (one room with hits, or a clear best), ambiguous (two rooms with comparable hits), no_match (transcript
present, no term heard), no_transcript (no room has any transcript in the window: an STT gap or not yet drained). Where a voiceprint-confirmed room exists for the same doctor the
two methods are compared. Prints counts; writes room ids and TERMS (never text) to ~/eta-data/surgery-review-v3/located.json (0600)."""
import json, os, subprocess
from concurrent.futures import ThreadPoolExecutor
import lexicon

OUT = os.path.expanduser("~/eta-data/surgery-review-v3")
HELPER = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
REPO = os.path.expanduser("~/dev/Even-Transcription-Assistant")
from datetime import datetime, timedelta


def rooms_in_window(a):
    c = datetime.fromisoformat(a["called"]) - timedelta(minutes=1)
    d = datetime.fromisoformat(a["done"]) + timedelta(minutes=1)
    q = (f"SELECT room_day_id, count(*)::int AS n, string_agg(lower(payload->>'text'), ' ' ORDER BY at) AS t FROM cue WHERE type='stt_turn' "
         f"AND at BETWEEN '{c.isoformat()}' AND '{d.isoformat()}' GROUP BY room_day_id")
    r = subprocess.run(["node", HELPER, q], cwd=REPO, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise SystemExit(f"neon-select failed rc={r.returncode}")
    return json.loads(r.stdout)


def decide(rows, terms):
    """rows: [{room_day_id, n, t}]. Pure: returns (decision, best_room, hit_rooms{room: [terms]}, rooms_with_transcript)."""
    hit_rooms = {}
    for r in rows:
        h = lexicon.hits(r["t"] or "", terms)
        if h:
            hit_rooms[r["room_day_id"]] = h
    if not rows:
        return "no_transcript", None, {}, 0
    if not terms:
        return "no_lexicon", None, {}, len(rows)
    if not hit_rooms:
        return "no_match", None, {}, len(rows)
    ranked = sorted(hit_rooms.items(), key=lambda kv: -len(kv[1]))
    if len(ranked) > 1 and len(ranked[1][1]) >= max(1, 0.6 * len(ranked[0][1])):
        return "ambiguous", ranked[0][0], hit_rooms, len(rows)
    return "located", ranked[0][0], hit_rooms, len(rows)


def one(a):
    terms = lexicon.terms_for(a["booked_procedure"])
    dec, best, hr, nr = decide(rooms_in_window(a), terms)
    return {"token_uid": a["token_uid"], "booked_procedure": a["booked_procedure"], "terms": terms, "decision": dec, "room_day_id": best, "hit_rooms": hr, "rooms_with_transcript": nr,
            "called": a["called"], "done": a["done"], "doctor_uid": a["doctor_uid"], "day": a["called"][:10]}


def selftest():
    rows = [{"room_day_id": "rdA", "n": 5, "t": "we will do a knee replacement and tkr next month"}, {"room_day_id": "rdB", "n": 4, "t": "this is a big operation and surgery"}]
    t = lexicon.terms_for("total knee replacement")
    assert decide(rows, t)[:2] == ("located", "rdA"), "generic words in room B must not make it a hit"
    assert decide([{"room_day_id": "rdB", "n": 4, "t": "big operation surgery"}], t)[0] == "no_match"
    assert decide([], t)[0] == "no_transcript" and decide(rows, [])[0] == "no_lexicon"
    two = [{"room_day_id": "rdA", "n": 5, "t": "knee replacement"}, {"room_day_id": "rdB", "n": 5, "t": "knee replacement discussed"}]
    assert decide(two, t)[0] == "ambiguous", "two rooms with comparable hits are ambiguous, never silently picked"
    print("selftest OK: generic-only room is not a hit, no_match / no_transcript / no_lexicon, ambiguity reported")


def main():
    import sys
    if "--selftest" in sys.argv:
        return selftest()
    A = json.load(open(f"{OUT}/anchors.json"))
    with ThreadPoolExecutor(3) as ex:
        res = list(ex.map(one, A))
    json.dump(res, open(f"{OUT}/located.json", "w"), indent=1); os.chmod(f"{OUT}/located.json", 0o600)
    from collections import Counter
    print("anchored:", len(res), "| decisions:", dict(Counter(r["decision"] for r in res)))
    print("by consult day:", {d: dict(Counter(r["decision"] for r in res if r["day"] == d)) for d in sorted({r["day"] for r in res})})
    print("no_lexicon names (cannot be checked):", sum(1 for r in res if r["decision"] == "no_lexicon"))
    conf = json.load(open(f"{OUT}/confirmed_room_days.json"))
    agree = disagree = 0
    for r in res:
        for o in conf:
            if o["date"] == r["day"] and o["doctor_uid"] and o["doctor_uid"] == r["doctor_uid"] and r["room_day_id"]:
                agree += (o["room_day_id"] == r["room_day_id"]); disagree += (o["room_day_id"] != r["room_day_id"])
    print("content-located rooms vs voiceprint-confirmed room for the same doctor:", f"agree {agree}, disagree {disagree}")


if __name__ == "__main__":
    main()
