#!/usr/bin/env python3
"""neighbour_check.py — does an item's ENCOUNTER swallow another consult? For each item (with a doctor_uid) list the doctor's OTHER completed CONSULTATION steps that day (Metabase, read-only) and report how
much of each other PQM interval the item's encounter covers. FLAG when the encounter covers >=50% of another consult's PQM interval (or another consult's called_at falls inside it by >=1 min):
the cut then holds two conversations (eta-refuter-2: Q17's 34-min lx cut spanned >=4 encounters). Prints ids, minutes and fractions only.
usage: neighbour_check.py <selected.json> <bounds.json> [ids...]"""
import json, os, sys
from datetime import datetime, timezone, timedelta
import mb

IST = timezone(timedelta(hours=5, minutes=30))
V3 = os.path.expanduser("~/eta-data/surgery-review-v3")


def ts(s):
    s = s.replace("Z", "+0000").replace(" +", "+").replace(" -", "-").replace("T", " ")  # Metabase: '2026-09-23 13:47:55 +0530'
    for f in ("%Y-%m-%d %H:%M:%S%z", "%Y-%m-%d %H:%M:%S.%f%z"):
        try:
            return int(datetime.strptime(s, f).timestamp() * 1000)
        except ValueError:
            pass
    return int(datetime.fromisoformat(s).timestamp() * 1000)


def overlap_ms(a0, a1, b0, b1):
    return max(0, min(a1, b1) - max(a0, b0))


def flags(enc, others, own_token):
    """enc {start_ms,end_ms}; others [(token, start_ms, end_ms)] -> [(token, covered_fraction, called_inside_min)] for the ones that trip the rule."""
    out = []
    for t, s, e in others:
        if t == own_token or e <= s:
            continue
        frac = overlap_ms(enc["start_ms"], enc["end_ms"], s, e) / (e - s)
        inside = (enc["end_ms"] - s) / 60000 if enc["start_ms"] < s < enc["end_ms"] else 0.0
        if frac >= 0.5 or (enc["start_ms"] < s < enc["end_ms"] - 60000):
            out.append((t, round(frac, 2), round(inside, 1)))
    return out


def trim(b, others, own_token):
    """Never swallow a neighbour. Returns bounds whose ENCOUNTER excludes every other consult's PQM interval and always keeps this item's OWN PQM interval; the cut-off parts stay in the
    greyed list ('other consult') so the doc still shows them outside the encounter. others: [(token, start_ms, end_ms)]."""
    e0, e1 = b["encounter"]["start_ms"], b["encounter"]["end_ms"]
    p0, p1 = b["pqm"]["start_ms"], b["pqm"]["end_ms"]
    cut = []
    for t, s, e in sorted(others, key=lambda x: x[1]):
        if t == own_token or e <= s or overlap_ms(e0, e1, s, e) == 0:
            continue
        if s >= p1:                      # after this consult's own interval: the encounter ends where the neighbour starts
            cut.append((s, e1)); e1 = min(e1, s)
        elif e <= p0:                    # before it: the encounter starts where the neighbour ends
            cut.append((e0, min(e, p0))); e0 = max(e0, min(e, p0))
    if not cut:
        return b, []
    grey = [g for g in b["greyed"]] + [{"start_ms": a, "end_ms": z, "why": "other consult (cut off)"} for a, z in cut if z > a]
    return {**b, "encounter": {"start_ms": e0, "end_ms": e1}, "greyed": grey}, cut


def selftest():
    enc = {"start_ms": 0, "end_ms": 30 * 60000}
    assert flags(enc, [("a", 5 * 60000, 15 * 60000)], "x") == [("a", 1.0, 25.0)], "another consult fully inside"
    assert flags(enc, [("a", 0, 10 * 60000)], "a") == [], "its own token is never a neighbour"
    assert flags(enc, [("a", 40 * 60000, 50 * 60000)], "x") == [], "a consult after the encounter is not a neighbour"
    assert flags(enc, [("a", 29 * 60000 + 30000, 40 * 60000)], "x") == [], "a sub-minute edge overlap (starts 30 s before the end) is not a swallow"
    assert flags(enc, [("a", 25 * 60000, 40 * 60000)], "x") != [], "the encounter holds the first 5 min of another consult: flagged"
    assert flags(enc, [("a", 10 * 60000, 40 * 60000)], "x") != [], "a consult that STARTS well inside the encounter is a swallow even if it runs past the end"
    assert flags(enc, [("a", 0, 10 * 60000)], "x")[0][1] == 1.0
    assert flags(enc, [("a", -4 * 60000, 6 * 60000)], "x") != [], "a neighbour that starts BEFORE the encounter and is 60% inside it: flagged (fraction rule)"
    assert flags(enc, [("a", -7 * 60000, 3 * 60000)], "x") == [], "a neighbour 30% inside the start edge is not flagged"
    b = {"encounter": {"start_ms": 0, "end_ms": 40 * 60000}, "pqm": {"start_ms": 10 * 60000, "end_ms": 20 * 60000}, "greyed": []}
    t, c = trim(b, [("n", 25 * 60000, 38 * 60000)], "x")
    assert t["encounter"] == {"start_ms": 0, "end_ms": 25 * 60000} and len(t["greyed"]) == 1 and t["greyed"][0]["why"].startswith("other consult"), "a later neighbour ends the encounter at its start; the cut part stays greyed"
    t, c = trim(b, [("n", 1 * 60000, 8 * 60000)], "x")
    assert t["encounter"]["start_ms"] == 8 * 60000 and t["encounter"]["end_ms"] == 40 * 60000, "an earlier neighbour moves the encounter start to its end"
    t, c = trim(b, [("n", 12 * 60000, 18 * 60000)], "x")
    assert t["encounter"] == b["encounter"] or (t["encounter"]["start_ms"] <= 10 * 60000 and t["encounter"]["end_ms"] >= 20 * 60000), "a neighbour inside the item's OWN interval never removes the item's own interval"
    t, c = trim(b, [("x", 25 * 60000, 38 * 60000)], "x")
    assert t is b and c == [], "the item's own token is never a neighbour"
    t, c = trim(b, [("n", 50 * 60000, 60 * 60000)], "x")
    assert t is b and c == [], "a neighbour outside the encounter changes nothing"
    t, c = trim(b, [("n", 25 * 60000, 30 * 60000), ("m", 32 * 60000, 38 * 60000)], "x")
    assert t["encounter"]["end_ms"] == 25 * 60000 and len(c) == 1 and c[0] == (25 * 60000, 40 * 60000) and t["encounter"]["end_ms"] >= b["pqm"]["end_ms"], "two later neighbours: the earliest start wins, everything after it is greyed as one cut, own interval kept"
    t, c = trim(b, [("n", 20 * 60000, 30 * 60000)], "x")
    assert t["encounter"]["end_ms"] == 20 * 60000, "a neighbour that starts exactly when this consult's own interval ends is still cut"
    t, c = trim(b, [("n", 2 * 60000, 10 * 60000)], "x")
    assert t["encounter"]["start_ms"] == 10 * 60000, "a neighbour that ends exactly when this consult's own interval starts is still cut"
    print("neighbour_check selftest OK")


def main():
    sel = json.load(open(f"{V3}/{sys.argv[1]}")); B = {x["item_id"]: x for x in json.load(open(f"{V3}/{sys.argv[2]}"))}
    ids = sys.argv[3:] or sorted(sel)
    docs = {}
    for q in ids:
        m, b = sel[q], B[q]
        du, dn = m.get("doctor_uid") or None, (m.get("doctor_name") or "").replace("'", "''")
        if not du and not dn:
            print(q, "no doctor uid or name: cannot check"); continue
        day = m["day"] if "day" in m else m["called"][:10]
        key = (du or dn, day)
        if key not in docs:
            _, rows, tr = mb.query(f"""SELECT qts.token_uid, nullif(qts.called_at,''), nullif(qts.completed_at,'') FROM queue_token_steps qts
                WHERE qts.station='CONSULTATION' AND qts.status='COMPLETE' AND qts.cycle_bucket IN ('{day}') AND ({"qts.routing->>'DOCTOR_UID'='" + du + "'" if du else "lower(qts.metadata->>'DOCTOR_NAME')=lower('" + dn + "')"})""")
            docs[key] = [(r[0], ts(r[1]), ts(r[2])) for r in rows if r[1] and r[2]]
        f = flags(b["encounter"], docs[key], m["token_uid"])
        print(q, "doctor's other consults that day:", len(docs[key]) - 1, "| encounter min:", round((b["encounter"]["end_ms"] - b["encounter"]["start_ms"]) / 60000, 1), "| FLAGS:", f or "none")


def day_consults(day):
    """All completed CONSULTATION steps of one cycle day: [(token, doctor_uid, doctor_name, start_ms, end_ms)] (Metabase, read-only)."""
    _, rows, tr = mb.query(f"""SELECT qts.token_uid, qts.routing->>'DOCTOR_UID', qts.metadata->>'DOCTOR_NAME', nullif(qts.called_at,''), nullif(qts.completed_at,'')
        FROM queue_token_steps qts WHERE qts.station='CONSULTATION' AND qts.status='COMPLETE' AND qts.cycle_bucket IN ('{day}')""")
    assert not tr and len(rows) < 1999
    return [(r[0], r[1], r[2], ts(r[3]), ts(r[4])) for r in rows if r[3] and r[4]]


def trim_file(sel_name, bounds_name, out_name):
    import anchor as an
    sel = json.load(open(f"{V3}/{sel_name}")); B = [x for x in json.load(open(f"{V3}/{bounds_name}"))]
    days, out, changed = {}, [], {}
    for b in B:
        m = sel[b["item_id"]]; day = m["called"][:10]
        days.setdefault(day, day_consults(day))
        du, dn = m.get("doctor_uid"), m.get("doctor_name")
        if not du and not dn:
            out.append(b); print(b["item_id"], "doctor unknown: NOT trimmed"); continue
        others = [(t, s, e) for t, u, n, s, e in days[day] if (du and u == du) or (dn and n and an.same_doctor_name(dn, n))]
        nb, cut = trim(b, others, m["token_uid"])
        out.append(nb)
        if cut:
            changed[b["item_id"]] = [round((z - a) / 60000, 1) for a, z in cut]
        print(b["item_id"], "doctor's consults that day:", len(others), "| enc min", round((b["encounter"]["end_ms"] - b["encounter"]["start_ms"]) / 60000, 1), "->",
              round((nb["encounter"]["end_ms"] - nb["encounter"]["start_ms"]) / 60000, 1), "| cut minutes:", changed.get(b["item_id"], "none"))
    p = f"{V3}/{out_name}"; json.dump(out, open(p, "w"), indent=1); os.chmod(p, 0o600)
    print("trimmed", len(changed), "of", len(B), "->", out_name)


if __name__ == "__main__":
    if sys.argv[1] == "--selftest":
        selftest()
    elif sys.argv[1] == "trim":
        trim_file(*sys.argv[2:5])
    else:
        main()
