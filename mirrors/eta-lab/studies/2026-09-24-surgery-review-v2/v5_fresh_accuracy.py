#!/usr/bin/env python3
"""v5_fresh_accuracy.py — the FIRST accuracy check of the frozen v5 (4830ae152bf4) on a FRESH set (judge-K: 40 blind items, labels locked by eta-refuter-2, sha256 0db3647c...). Ids and counts only.
Per class, n in every cell, no single number. The 40 are sampled by stratum (24 status-bearing, 6 gate-held, 6 below-recall, 4 borderline) so cells describe THIS sample, not the population.
Conventions from the labels' author: CT angiography = category intervention (score ct_status separately); a procedure done during the visit = proposed_now; a test is not a procedure; J03 is scored under the gate.
Low-confidence items (J02 J04 J06 J25 J31 J38 J40) and medium alternates (J15 J35) are reported SEPARATELY. These 40 must never be used to adjust v5 (leakage)."""
import collections, json, os, sys
V3 = os.path.expanduser("~/eta-data/surgery-review-v3"); LOW = {"J02", "J04", "J06", "J25", "J31", "J38", "J40"}; MED = {"J15", "J35"}
SHIPPED = {"J11", "J13", "J14", "J16", "J27", "J29", "J30", "J33"}  # the SAME conversation as a consult V rated in v3, confirmed by CONTENT (word-trigram share >= 0.7; eta-refuter-2 #1174, fresh_overlap.py). NOT a time/room_day match: J11 and J29 are invisible to those (ship-key room_day_id is None for wide-placed items)


SET = os.environ.get("SET", "K")  # K = judge-K (40, final-v5fresh); L = judge-L (15 from the 24 Sep delta pass, labels sha256 f3c58748..., final-v5delta)
SETS = {"K": ("judge-K", "final-v5fresh"), "L": ("judge-L", "final-v5delta")}


def load():
    jn, fd = SETS[SET]
    lab = json.load(open(os.path.expanduser(f"~/eta-data/refuter2/{jn}.json")))["labels"]; key = json.load(open(f"{V3}/{jn}-key.json")); pred = {}
    if SET == "L":
        global LOW, MED
        LOW = {j for j, l in lab.items() if str(l["confidence"]).lower().startswith("low")}; MED = {j for j, l in lab.items() if str(l["confidence"]).lower().startswith("medium")}
    for jid, k in key.items():
        d = json.load(open(f"{V3}/{fd}/jev/{k['working_id']}.json")); m = d["meta"]; j = d["jev"] or {}
        pred[jid] = {"present": m["present_p"], "named": m["named_p"], "described": m["described_p"], "held": m["held"], "status": (j.get("status") or {}).get("answer"), "category": (j.get("named") or {}).get("category"),
                     "stratum": k.get("stratum", "n/a")}
    return lab, pred


def mat(pairs, rows, cols):
    c = collections.Counter(pairs); out = {r: {k: c[(r, k)] for k in cols} for r in rows}; return out


def show(title, m, cols):
    print(f"\n{title}\n" + " " * 16 + "".join(f"{k:>15}" for k in cols) + "   n")
    for r, v in m.items():
        print(f"{r:>15} " + "".join(f"{v[k]:>15}" for k in cols) + f"   {sum(v.values())}")


def main(exclude=()):
    lab, pred = load(); ids = [j for j in sorted(lab) if j not in exclude]
    print(f"items scored: {len(ids)} (excluded: {sorted(exclude) or 'none'})")
    # A. gate
    gate_pred = {j: ("held" if pred[j]["held"] == "not_a_consult" else "kept") for j in ids}; gate_lab = {j: ("staff" if lab[j]["consult"] == "staff_case_talk" else "consult") for j in ids}
    show("A. GATE: v5 (rows = label) vs held / kept", mat([(gate_lab[j], gate_pred[j]) for j in ids], ["consult", "staff"], ["kept", "held"]), ["kept", "held"])
    print("   by sampling stratum, gate-HELD by v5 (n) and how many the label calls consult:", {s: (sum(1 for j in ids if pred[j]["stratum"] == s and gate_pred[j] == "held"), sum(1 for j in ids if pred[j]["stratum"] == s and gate_pred[j] == "held" and gate_lab[j] == "consult")) for s in ("gate_held", "scored_with_status", "below_recall", "borderline_no_status")})
    if "J03" in pred and SET == "K":
        print("   J03 (label: conditional, named no, described no) v5 gate:", gate_pred.get("J03"), "present", pred["J03"]["present"])
    # B. named / described
    for f in ("named", "described"):
        m = mat([(lab[j][f], "yes" if pred[j][f] >= 0.5 else "no") for j in ids], ["yes", "no"], ["yes", "no"]); show(f"B. {f.upper()}: label (rows) vs v5 p>=0.5 (cols), ALL items", m, ["yes", "no"])
        kept = [j for j in ids if gate_pred[j] == "kept"]; m2 = mat([(lab[j][f], "yes" if pred[j][f] >= 0.5 else "no") for j in kept], ["yes", "no"], ["yes", "no"]); show(f"   {f.upper()} among items the gate KEPT", m2, ["yes", "no"])
    # C. status end to end
    cls = ["proposed_now", "conditional", "already_done", "mentioned_only", "none"]; ps = {j: (pred[j]["status"] or "none") if pred[j]["held"] is None else "none" for j in ids}
    show("C. STATUS end to end: label (rows) vs v5 (cols); v5 'none' = held, below recall or no status", mat([(lab[j]["status"], ps[j]) for j in ids], cls, cls + ["referred"]), cls + ["referred"])
    for c in cls[:4]:
        tp = sum(1 for j in ids if lab[j]["status"] == c and ps[j] == c); fp = sum(1 for j in ids if lab[j]["status"] != c and ps[j] == c); fn = sum(1 for j in ids if lab[j]["status"] == c and ps[j] != c)
        print(f"   {c:>15}: v5 predicted {tp + fp}, of which label agrees {tp} (precision n={tp + fp}); label has {tp + fn}, v5 finds {tp} (recall n={tp + fn})")
    # D. category among labelled procedures
    lp = [j for j in ids if lab[j]["status"] != "none"]; cats = ["operation", "intervention", "minor", "imaging_ct", "none"]
    show("D. CATEGORY, items with a labelled procedure: label (rows) vs v5 named.category (cols; none = not reached / absent)", mat([(lab[j]["category"], pred[j]["category"] or "none") for j in lp], cats[:4], cats), cats)
    # E. CT stratum
    print("\nE. CT stratum (label ct_status not empty): id | label status / category / ct_status | v5 status / category | gate / named / described")
    for j in ids:
        if lab[j].get("ct_status"):
            print(f"   {j} | {lab[j]['status']} / {lab[j]['category']} / {str(lab[j]['ct_status'])[:22]} | {ps[j]} / {pred[j]['category']} | {gate_pred[j]} {pred[j]['named']:.2f} {pred[j]['described']:.2f}")


if __name__ == "__main__":
    if SET == "L" and sys.argv[1:] in ([], ["headline"]):
        lab, _ = load(); main(exclude=(LOW | MED) if sys.argv[1:] else ())
        print("\nlow-confidence:", sorted(LOW), "| medium:", sorted(MED))
    elif sys.argv[1:] == ["notshipped"]:
        main(exclude=SHIPPED)
    elif sys.argv[1:] == ["notshipped-headline"]:
        main(exclude=SHIPPED | LOW | MED)
    elif sys.argv[1:] == ["headline"]:
        main(exclude=LOW | MED)
    elif sys.argv[1:] == ["low"]:
        lab, pred = load(); print("LOW / MEDIUM confidence items (separate):")
        for j in sorted(LOW | MED):
            print(f"  {j} label: consult={lab[j]['consult']} named={lab[j]['named']} described={lab[j]['described']} status={lab[j]['status']} cat={lab[j]['category']} ({lab[j]['confidence']}) | v5: {pred[j]['held'] or 'scored'} present {pred[j]['present']:.2f} named {pred[j]['named']:.2f} described {pred[j]['described']:.2f} status {pred[j]['status']}")
    else:
        main()
