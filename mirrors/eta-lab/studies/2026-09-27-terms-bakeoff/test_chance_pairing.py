"""Synthetic fixtures + one real-data structural check (counts only, no drug/room content beyond what's already
public structure - room ids and consult ids, no patient text)."""
import json

from chance_pairing import build_chance_pairs


def test_synthetic_pairing_picks_different_room_with_drugs():
    consults = [
        ("d1", "c1", "roomA"),
        ("d1", "c2", "roomA"),  # same room as c1 - must be skipped
        ("d1", "c3", "roomB"),  # different room, has drugs -> valid partner for c1/c2
        ("d1", "c4", "roomC"),  # different room, no drugs -> not a valid partner
    ]
    truth_groups = {("d1", "c3"): {"paracetamol"}}
    pairs = build_chance_pairs(consults, truth_groups)
    assert pairs[("d1", "c1")] == ("d1", "c3")
    assert pairs[("d1", "c2")] == ("d1", "c3")
    # c3's own nearest different-room drug-having partner (itself excluded) - none exists here but c3 wraps to c4 (no
    # drugs) then c1/c2 (same room as neither... wait c3 is roomB, c1/c2 are roomA (different) but have no drugs) so
    # c3 has no valid partner in this tiny fixture - documents the "None when nothing qualifies" behaviour.
    assert pairs[("d1", "c3")] is None


def test_no_partner_within_own_room_ever():
    consults = [("d1", "c1", "roomA"), ("d1", "c2", "roomA")]
    truth_groups = {("d1", "c2"): {"x"}}
    pairs = build_chance_pairs(consults, truth_groups)
    # c1's only candidate (c2) is the SAME room -> must stay None, never pick a same-room "chance" partner.
    assert pairs[("d1", "c1")] is None


def test_fallback_skips_a_partner_fully_absorbed_by_own_truth():
    """refuter-3's C2 fallback (bus #4889): the nearest different-room candidate (c2) has truth == c1's own truth
    (paracetamol only) - partner_truth - own_truth would be empty, so the walk must skip c2 and continue to c3."""
    consults = [
        ("d1", "c1", "roomA"),
        ("d1", "c2", "roomB"),  # different room, but truth is a SUBSET of c1's own -> must be skipped
        ("d1", "c3", "roomC"),  # different room, has an extra drug c1 doesn't -> valid fallback partner
    ]
    truth_groups = {
        ("d1", "c1"): {"paracetamol"},
        ("d1", "c2"): {"paracetamol"},
        ("d1", "c3"): {"paracetamol", "azithromycin"},
    }
    pairs = build_chance_pairs(consults, truth_groups)
    assert pairs[("d1", "c1")] == ("d1", "c3")


def test_real_data_full_coverage():
    """Structural check only: every one of the 99 real linked 22/23/24 Sep consults gets a valid chance partner.
    No drug names, no patient text - room ids and consult ids only, same as ADDENDUM-4's own verification."""
    import re

    def norm(s):
        return re.sub(r"[^a-z0-9]", "", (s or "").lower())

    master = {}
    for day in ("22", "23", "24"):
        d = json.load(open(f"/home/eta/eta-data/cap/raw-2026-09-{day}/drug_master.json"))
        for uid, brand, generic, strength in d["rows"]:
            master[uid] = (brand or "", generic or "", strength or "")
    name_to_group = {}
    for uid, (b, g, s) in master.items():
        key = norm(g) if g.strip() else norm(b)
        if not key:
            continue
        if b.strip():
            name_to_group.setdefault(norm(b), key)
        if g.strip():
            name_to_group.setdefault(norm(g), key)

    def truth_group(alts):
        for a in alts or []:
            k = name_to_group.get(norm(a))
            if k:
                return k
        return None

    consults = []
    for day in ("22", "23", "24"):
        with open(f"/home/eta/eta-data/cap/2026-09-{day}/links.jsonl") as f:
            for line in f:
                r = json.loads(line)
                if r.get("status") in ("confirmed", "probable"):
                    consults.append((day, r["consult_id"], r.get("room")))

    truth_groups = {}
    for day in ("22", "23", "24"):
        with open(f"/home/eta/eta-data/cap/2026-09-{day}/items.jsonl") as f:
            for line in f:
                it = json.loads(line)
                if it.get("cls") != "drug":
                    continue
                cid = it["consult_id"]
                g = truth_group(it.get("alt") or [])
                if g:
                    truth_groups.setdefault((day, cid), set()).add(g)

    pairs = build_chance_pairs(consults, truth_groups)
    assert len(pairs) == 99
    missing = [k for k, v in pairs.items() if v is None]
    assert missing == []
    # no consult is ever paired with itself, or with a same-room consult
    room_of = {(day, cid): room for day, cid, room in consults}
    for c, partner in pairs.items():
        assert partner != c
        assert room_of[partner] != room_of[c]
