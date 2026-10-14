#!/usr/bin/env python3
"""apply_grey.py <dir> <id> <i_from> <i_to> <before|after> — mark turns i_from..i_to (inclusive, turns[].i) as OUTSIDE the consult (phase before|after) in BOTH the raw staging file and its
de-identified twin, and move the encounter edge to the neighbouring in-encounter turn (a judge's or a reviewer's boundary call, e.g. eta-refuter-2's 'grey Q28 115-233'). Jev is then re-run on the reduced encounter.
'before' must reach the current encounter start; 'after' must reach the current encounter end (a grey range in the MIDDLE of an encounter would split it: refused)."""
import json, os, sys

V3 = os.path.expanduser("~/eta-data/surgery-review-v3")


def grey(doc, i_from, i_to, phase):
    T = doc["turns"]; lo = doc["span"]["start_ms"]
    inn = [t["i"] for t in T if "phase" not in t]
    assert phase in ("before", "after") and i_from <= i_to
    rng = [t for t in T if i_from <= t["i"] <= i_to]
    assert rng, "no turns in the range"
    if phase == "before":
        assert min(inn) >= i_from and i_to >= min(inn) - 0 and not [i for i in inn if i < i_from], "a 'before' range must start at or before the first in-encounter turn"
    else:
        assert not [i for i in inn if i > i_to], "an 'after' range must reach the last in-encounter turn"
        assert i_from <= max(inn) + 1
    for t in rng:
        t["phase"] = phase
    inn2 = [t for t in T if "phase" not in t]
    assert inn2, "the range would remove the whole encounter"
    doc["encounter"] = {"start_ms": lo + int(round(inn2[0]["start_s"] * 1000)), "end_ms": lo + int(round(inn2[-1]["end_s"] * 1000))}
    return doc


def set_encounter(doc, start_ms, end_ms):
    """Re-cut the encounter to [start_ms, end_ms): every turn is re-labelled by its start time (before / after / inside = no phase). Used when a reviewer's read says lx's cut dropped part of the
    SAME patient's consult (Q29: the clip before the proposal)."""
    lo = doc["span"]["start_ms"]
    assert doc["span"]["start_ms"] <= start_ms < end_ms <= doc["span"]["end_ms"]
    for t in doc["turns"]:
        ms = lo + t["start_s"] * 1000
        if ms < start_ms:
            t["phase"] = "before"
        elif ms >= end_ms:
            t["phase"] = "after"
        else:
            t.pop("phase", None)
    assert any("phase" not in t for t in doc["turns"]), "no turn left inside the encounter"
    doc["encounter"] = {"start_ms": start_ms, "end_ms": end_ms}
    return doc


def selftest():
    mk = lambda n: {"span": {"start_ms": 1000000, "end_ms": 2000000}, "encounter": {}, "turns": [{"i": i, "start_s": i * 10.0, "end_s": i * 10.0 + 5.0, **({"phase": "before"} if i < 3 else {})} for i in range(n)]}
    d = grey(mk(10), 8, 9, "after"); assert [t["i"] for t in d["turns"] if t.get("phase") == "after"] == [8, 9] and d["encounter"] == {"start_ms": 1000000 + 30000, "end_ms": 1000000 + 75000}, d["encounter"]
    d = grey(mk(10), 3, 5, "before"); assert d["encounter"]["start_ms"] == 1000000 + 60000 and [t["i"] for t in d["turns"] if t.get("phase") == "before"] == [0, 1, 2, 3, 4, 5]
    for bad in ((lambda: grey(mk(10), 5, 6, "after")), (lambda: grey(mk(10), 4, 5, "before")), (lambda: grey(mk(10), 3, 9, "after")), (lambda: grey(mk(10), 20, 25, "after"))):
        try:
            bad(); raise SystemExit("a bad range must be refused")
        except AssertionError:
            pass
    d = set_encounter(mk(10), 1000000 + 25000, 1000000 + 70000); assert [t["i"] for t in d["turns"] if t.get("phase") == "before"] == [0, 1, 2] and [t["i"] for t in d["turns"] if t.get("phase") == "after"] == [7, 8, 9] and d["encounter"] == {"start_ms": 1025000, "end_ms": 1070000}, "turns re-labelled by start time"
    d = set_encounter(mk(10), 1000000, 1000000 + 100000); assert not any("phase" in t for t in d["turns"]), "a wider encounter clears the phase of the turns it now covers"
    d = set_encounter(mk(10), 1000000 + 30000, 1000000 + 60000); assert [t["i"] for t in d["turns"] if "phase" not in t] == [3, 4, 5], "a turn AT the start is inside, a turn AT the end is outside"
    try:
        set_encounter(mk(10), 1000000 + 60000, 1000000 + 30000); raise SystemExit("an inverted range must be refused")
    except AssertionError:
        pass
    print("apply_grey selftest OK")


def main(d, q, a, z, phase):
    for sub in ("staging", "deid"):
        p = f"{V3}/{d}/{sub}/{q}.json"; doc = json.load(open(p))
        if "span" not in doc:  # the de-id twin carries span/encounter as staging does (deid.py keeps unknown keys); fall back to staging's
            doc["span"] = json.load(open(f"{V3}/{d}/staging/{q}.json"))["span"]
        grey(doc, a, z, phase); json.dump(doc, open(p, "w"), ensure_ascii=False); os.chmod(p, 0o600)
    e = doc["encounter"]; print(q, "encounter now", round((e["end_ms"] - e["start_ms"]) / 60000, 1), "min; in-encounter turns", sum(1 for t in doc["turns"] if "phase" not in t))


if __name__ == "__main__":
    if sys.argv[1] == "--selftest":
        selftest()
    elif sys.argv[1] == "encounter":  # encounter <dir> <id> <start_ms> <end_ms>
        d, q, a, z = sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
        for sub in ("staging", "deid"):
            p = f"{V3}/{d}/{sub}/{q}.json"; doc = json.load(open(p)); doc.setdefault("span", json.load(open(f"{V3}/{d}/staging/{q}.json"))["span"])
            set_encounter(doc, a, z); json.dump(doc, open(p, "w"), ensure_ascii=False); os.chmod(p, 0o600)
        print(q, "encounter now", round((z - a) / 60000, 1), "min; in-encounter turns", sum(1 for t in doc["turns"] if "phase" not in t))
    else:
        main(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5])
