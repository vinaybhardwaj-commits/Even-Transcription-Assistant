#!/usr/bin/env python3
"""eta-refuter's INDEPENDENT scorer for the r414.4 Jev-vs-V gate (rules: r414.4, r415.3, Fable 415b).
Written and committed BEFORE any calib30 label exists. Counts only; never prints text.

Inputs (all box-only, 0600):
  --items    calib30 item ids: jev_sidecar.json keys (or any JSON object/list of L###/P### ids); must be exactly 30
             (or 40 after a +10 top-up), 20+ L and 10+ B, ids unique.
  --jev-l    split-speaker's label200_jev.json   {L###: {label, conf, version}}   (version must be lv1.2)
  --jev-b    split-speaker's ba106_jev.json      {P###: {label, conf, version}}   (version must be bv1.2)
  --v        V's calib30 answers: {id: {a, mode, g, ts}} or {"labels": {...}} (lab-viewer rate.js calib30 shape)
  --flags    optional: indic-mt flag list (list of P### or {ids:[...]} or {rows:[{id,...}]}) for the flag_full split
RULES (frozen):
  label200 item: usable = {readable, romanised_readable}; not = {garbled, wrong_language}.  (r415.3)
  ba106 item: agreement = the same answer in {A_better, B_better, same, neither_readable}.   (r414.4 "preferred version")
  V answer in {unsure, cant_judge} or missing -> SKIPPED (excluded).                          (r414.4, 415b(1))
  Jev cannot_tell on an item V judged -> NOT agreeing; its count is reported.                 (415b(1))
  GATE (Fable 416c): judged >= 25 required (else INSUFFICIENT: V gets 10 more); PASS iff the POPULATION-WEIGHTED
  agreement >= 26/30 (86.7%): per Jev-label stratum, V-agreement rate x that stratum's share of the full set
  (label200 by the 200 counts, ba106 by the 106 counts, #2880), kinds combined by judged L:B counts. The raw
  proportion (agreements/judged vs 26/30) and per-stratum rates are reported beside it.
  Refuses: unknown ids, wrong Jev versions, bad V answer values, item-count drift.
Descriptive (never gate conditions): per-kind and per-Jev-label agreement with exact CP 95%; gloss opened vs not;
  mode audio vs text; flag_full vs unflagged ba106."""
import argparse, json, math, sys
from collections import Counter, defaultdict

L_USABLE, L_NOT = {"readable", "romanised_readable"}, {"garbled", "wrong_language"}
B_CHOICES = {"A_better", "B_better", "same", "neither_readable"}
SKIP = {"unsure", "cant_judge"}

def die(msg): print("REFUSED: " + msg); sys.exit(2)

def betai(a, b, x):
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    lb = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)
    def cf(a, b, x):
        qab, qap, qam, c, d = a + b, a + 1, a - 1, 1.0, 1 - (a + b) * x / (a + 1)
        d = 1 / (d if abs(d) > 1e-300 else 1e-300); h = d
        for m in range(1, 300):
            m2 = 2 * m; aa = m * (b - m) * x / ((qam + m2) * (a + m2))
            d = 1 + aa * d; d = 1 / (d if abs(d) > 1e-300 else 1e-300); c = 1 + aa / c; c = c if abs(c) > 1e-300 else 1e-300; h *= d * c
            aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
            d = 1 + aa * d; d = 1 / (d if abs(d) > 1e-300 else 1e-300); c = 1 + aa / c; c = c if abs(c) > 1e-300 else 1e-300; de = d * c; h *= de
            if abs(de - 1) < 1e-13: break
        return h
    return math.exp(lb) * cf(a, b, x) / a if x < (a + 1) / (a + b + 2) else 1 - math.exp(lb) * cf(b, a, 1 - x) / b

def cp(k, n, alpha=0.05):
    if n == 0: return (None, None)
    def inv(p, a, b):
        lo, hi = 0.0, 1.0
        for _ in range(100):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if betai(a, b, mid) < p else (lo, mid)
        return (lo + hi) / 2
    return (0.0 if k == 0 else inv(alpha / 2, k, n - k + 1), 1.0 if k == n else inv(1 - alpha / 2, k + 1, n - k))

# Option (A), eta-refuter #2908: POPULATION weights = Jev's full-set label counts (split-speaker #2880, frozen here before any V label).
POP_L = {"readable": 96, "romanised_readable": 7, "garbled": 75, "wrong_language": 18, "cannot_tell": 4}   # of 200
POP_B = {"A_better": 50, "B_better": 45, "same": 9, "neither_readable": 2, "cannot_tell": 0}               # of 106

def weighted(J, pop, kind):
    """Population-weighted agreement for one kind: sum over Jev-label strata present of (stratum agree rate x its population share),
    renormalised over the strata that have >= 1 judged item. None when no stratum is judged."""
    g = defaultdict(lambda: [0, 0])
    for r in J:
        if r["kind"] == kind: g[r["jev"]][0] += r["agree"]; g[r["jev"]][1] += 1
    tot = sum(pop[k] for k in g if pop.get(k)); 
    if not tot: return None
    return sum((a / m) * pop[k] / tot for k, (a, m) in g.items() if pop.get(k))

def load(p): return json.load(open(p))

def ids_of(obj):
    if isinstance(obj, dict): return list(obj.get("ids", obj.keys()) if "ids" in obj else obj.keys())
    if isinstance(obj, list): return [x if isinstance(x, str) else x.get("id") for x in obj]
    die("item list shape")

def flag_ids(obj):
    if obj is None: return set()
    if isinstance(obj, dict) and "rows" in obj: return {r["id"] for r in obj["rows"] if r.get("flag_full", True)}
    return set(ids_of(obj))

def score(items, jev_l, jev_b, v, flags=frozenset()):
    if len(set(items)) != len(items): die("duplicate item ids")
    L = [i for i in items if str(i).startswith("L")]; B = [i for i in items if str(i).startswith("P")]
    if len(L) + len(B) != len(items): die("item id neither L### nor P###")
    if len(items) not in (30, 40) or len(L) < 20 or len(B) < 10: die(f"item count drift: {len(L)} L + {len(B)} P")
    for i in L:
        if i not in jev_l: die(f"L item not in Jev label200 file ({len(L)} L items)")
        if jev_l[i].get("version") != "lv1.2": die("Jev label200 version is not lv1.2")
    for i in B:
        if i not in jev_b: die("P item not in Jev ba106 file")
        if jev_b[i].get("version") != "bv1.2": die("Jev ba106 version is not bv1.2")
    v = v.get("labels", v)
    extra = set(v) - set(items)
    if extra: die(f"{len(extra)} V answers for ids not in calib30")
    rows = []
    for i in items:
        ans = v.get(i); a = ans.get("a") if isinstance(ans, dict) else None
        kind = "L" if i in L else "B"
        allowed = (L_USABLE | L_NOT if kind == "L" else B_CHOICES) | SKIP
        if a is not None and a not in allowed: die(f"V answer value not allowed for a {kind} item")
        j = (jev_l if kind == "L" else jev_b)[i]["label"]
        if a is None or a in SKIP:
            rows.append(dict(id=i, kind=kind, judged=False, jev=j)); continue
        if kind == "L":
            vc = "usable" if a in L_USABLE else "not"
            jc = "usable" if j in L_USABLE else ("not" if j in L_NOT else "cannot_tell")
            agree = jc == vc
        else:
            agree = j == a
        rows.append(dict(id=i, kind=kind, judged=True, agree=agree, jev=j, jev_ct=(j == "cannot_tell"),
                         g=bool(ans.get("g")), mode=ans.get("mode"), flag=(i in flags)))
    J = [r for r in rows if r["judged"]]; A = sum(r["agree"] for r in J); n = len(J)
    out = dict(items=len(items), judged=n, skipped=len(items) - n, agree=A,
               jev_cannot_tell_on_judged=sum(r["jev_ct"] for r in J))
    out["raw_prop"] = dict(agree=A, judged=n, share=round(A / n, 3) if n else None, meets_26_of_30=(A * 30 >= 26 * n) if n else None,
                           note="raw, reported beside the gate (Fable 416c)")
    wl, wb = weighted(J, POP_L, "L"), weighted(J, POP_B, "B")
    nl, nb = sum(r["kind"] == "L" for r in J), sum(r["kind"] == "B" for r in J)
    if wl is not None and wb is not None and n:
        w = (nl * wl + nb * wb) / (nl + nb)                    # keep calib30's own L:B mix; reweight WITHIN each kind by Jev-label share
        out["population_weighted"] = dict(label200=round(wl, 3), ba106=round(wb, 3), overall=round(w, 3),
                                          kind_mix="judged L:B counts (calib30's own mix); weights WITHIN each kind = Jev-label shares of the full 200/106 (#2880)")
    if n < 25:
        out["GATE"] = "INSUFFICIENT (judged < 25): V gets 10 more (r414.4)"
    elif "population_weighted" not in out:
        out["GATE"] = "UNDEFINED (a kind has no judged item)"
    else:
        out["GATE"] = "PASS" if out["population_weighted"]["overall"] >= 26 / 30 else "FAIL"   # Fable 416c: population-weighted >= 86.7%
    lo, hi = cp(A, n); out["agree_rate_cp95"] = [round(A / n, 3) if n else None, lo and round(lo, 3), hi and round(hi, 3)]
    def split(key, sel):
        g = defaultdict(lambda: [0, 0])
        for r in J:
            if sel(r): g[key(r)][0] += r["agree"]; g[key(r)][1] += 1
        return {k: dict(agree=a, n=m, cp95=[round(x, 3) if x is not None else None for x in cp(a, m)]) for k, (a, m) in sorted(g.items())}
    out["by_kind"] = split(lambda r: r["kind"], lambda r: True)
    out["by_jev_label"] = split(lambda r: r["kind"] + ":" + r["jev"], lambda r: True)
    out["by_gloss_opened"] = split(lambda r: "gloss_opened" if r["g"] else "gloss_not_opened", lambda r: True)
    out["by_mode"] = split(lambda r: str(r["mode"]), lambda r: True)
    out["ba106_by_flag"] = split(lambda r: "flag_full" if r["flag"] else "unflagged", lambda r: r["kind"] == "B")
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); [ap.add_argument(f"--{k}", required=(k != "flags")) for k in ("items", "jev-l", "jev-b", "v", "flags")]
    a = ap.parse_args()
    print(json.dumps(score(ids_of(load(a.items)), load(a.jev_l), load(a.jev_b), load(a.v), flag_ids(load(a.flags)) if a.flags else set()), indent=1))
