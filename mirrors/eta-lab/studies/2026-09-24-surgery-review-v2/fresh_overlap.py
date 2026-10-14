#!/usr/bin/env python3
"""fresh_overlap.py — is a candidate consult FRESH? Content check (word-trigram containment), not room_day or time (ship-key.json stores room_day_id = None for the wide-placed shipped items, and long shipped
encounters hide several sub-consults: 24 Sep, 8 of 40 judge-K items were consults V had already rated). Prints ids and numbers only, never text.
  containment(a, b) = |trigrams(a) & trigrams(b)| / |trigrams(a)|   (a candidate, b a shipped consult); pool pairs use the SMALLER set as the denominator.
usage: fresh_overlap.py <staging_dir> [--shipped-dir ship] [--hit 0.5] [--report 0.2]   (staging_dir under ~/eta-data/surgery-review-v3, in-encounter turns = phase not before/after)
       fresh_overlap.py --selftest"""
import glob, json, os, re, sys

V3 = os.path.expanduser("~/eta-data/surgery-review-v3")


def trigrams(turns):
    w = re.findall(r"[a-z0-9']+", " ".join((t.get("en") or t.get("orig") or "") for t in turns).lower())
    return {tuple(w[i:i + 3]) for i in range(len(w) - 2)}


def containment(a, b):
    return len(a & b) / len(a) if a else 0.0


def pool_overlap(a, b):
    return len(a & b) / min(len(a), len(b)) if a and b else 0.0


def check(cands, shipped, hit=0.5, report=0.2):
    """cands, shipped: {id: trigram set}. Returns (hits vs shipped, pool pairs) with score >= report; 'hit' marks the ones that are the SAME conversation."""
    vs = sorted((round(containment(s, t), 2), q, n) for q, s in cands.items() for n, t in shipped.items() if containment(s, t) >= report)[::-1]
    qs = sorted(cands)
    pool = sorted(((round(pool_overlap(cands[a], cands[b]), 2), a, b) for i, a in enumerate(qs) for b in qs[i + 1:] if pool_overlap(cands[a], cands[b]) >= report), reverse=True)
    return vs, pool


def selftest():
    T = lambda s: [{"en": s}]
    a = trigrams(T("the knee is stiff in the morning and we will operate on it next week under anaesthesia"))
    b = trigrams(T("the knee is stiff in the morning and we will operate on it next week under anaesthesia okay thank you doctor"))
    c = trigrams(T("your sugar was high last time please continue the tablets and come back after two months"))
    assert containment(a, b) == 1.0 and containment(b, a) < 1.0, "a candidate contained in a longer shipped consult scores 1.0, not the reverse"
    assert containment(a, c) == 0.0 and containment(set(), b) == 0.0
    vs, pool = check({"X": a, "Y": c}, {"S1": b}, report=0.2)
    assert vs == [(1.0, "X", "S1")], vs
    vs, pool = check({"X": a, "Y": b}, {}, report=0.2); assert pool == [(1.0, "X", "Y")], "pool pairs use the smaller set as denominator"
    vs, pool = check({"X": a, "Y": c}, {"S1": c}, report=0.2); assert vs == [(1.0, "Y", "S1")] and pool == []
    # partial: 12 distinct words = 10 trigrams; sharing the first 6 words shares 4 trigrams -> 0.4; reported at 0.2, not at 0.5
    p12 = trigrams(T("w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12")); q6 = trigrams(T("w1 w2 w3 w4 w5 w6 x7 x8 x9 x10"))
    assert containment(p12, q6) == 0.4, containment(p12, q6)
    assert check({"X": p12}, {"S": q6}, report=0.2)[0] == [(0.4, "X", "S")] and check({"X": p12}, {"S": q6}, report=0.5)[0] == [], "the report threshold is applied as >="
    # 3 words is the shortest text with a trigram; shorter gives an empty set and can never be 'fresh'-checked: scored 0.0, so callers must treat empty as UNCHECKED
    assert trigrams(T("only two")) == set()
    print("fresh_overlap selftest OK: containment direction, pool denominator, empty text scores 0 (caller must treat empty as unchecked), report threshold")


def main(argv):
    if argv == ["--selftest"]:
        return selftest()
    d = argv[0]; d = d if os.path.isabs(d) else f"{V3}/{d}"
    sd = argv[argv.index("--shipped-dir") + 1] if "--shipped-dir" in argv else "ship"
    hit = float(argv[argv.index("--hit") + 1]) if "--hit" in argv else 0.5
    rep = float(argv[argv.index("--report") + 1]) if "--report" in argv else 0.2
    shipped = {os.path.basename(f)[:-5]: trigrams([t for t in json.load(open(f))["turns"] if "outside" not in t]) for f in sorted(glob.glob(f"{V3}/{sd}/consults/*.json"))}
    cands = {os.path.basename(f)[:-5]: trigrams([t for t in json.load(open(f))["turns"] if t.get("phase") not in ("before", "after")]) for f in sorted(glob.glob(f"{d}/N*.json"))}
    empty = sorted(q for q, s in cands.items() if not s)
    vs, pool = check(cands, shipped, hit, rep)
    print(f"candidates {len(cands)} | shipped {len(shipped)} | UNCHECKED (no trigrams): {empty}")
    for sc, q, n in vs:
        print(f"{'SAME' if sc >= hit else 'partial'} vs shipped: {q} {n} {sc}")
    for sc, a, b in pool:
        print(f"{'SAME' if sc >= hit else 'partial'} in pool: {a} {b} {sc}")
    print("FRESH items (no SAME hit vs shipped, not empty):", len(cands) - len({q for sc, q, n in vs if sc >= hit}) - len(empty))


if __name__ == "__main__":
    main(sys.argv[1:])
