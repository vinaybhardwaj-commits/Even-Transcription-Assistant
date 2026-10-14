#!/usr/bin/env python3
"""v4_trial.py — ruling 143 (V3-02: a procedure DESCRIBED but not NAMED): trial of two INDEPENDENT recall questions against the frozen v3 combined question, on de-identified in-encounter text.
Items: the 12 shipped v3 consults (blind-judge labels known) + 10 negatives (consults that scored ~0 under v3). Each item is asked 2 times (Jev is non-deterministic). Prints ids and probabilities only.
This is a DEVELOPMENT trial (wording candidates), never a score; the v3 freeze (a29f22245670) is untouched: nothing here calls v3.scan."""
import json, os, sys
import u9, build_consult as bc, finalize

V3 = os.path.expanduser("~/eta-data/surgery-review-v3")
NAMED = {"type": "noul", "instructions":
    "Does the doctor say the NAME of a specific surgical, interventional or diagnostic procedure for this patient (for example a tympanoplasty, an angiogram, a hernia repair, an endoscopy, a biopsy)? "
    "The name itself must be spoken. The words 'surgery', 'operation', 'procedure', 'scan' or 'test' alone are NOT a name. It does not matter whether it is proposed, already done or only mentioned, and it does not matter whether anything is explained about it."}
DESCRIBED = {"type": "noul", "instructions":
    "Does the doctor explain what a surgical, interventional or diagnostic procedure would involve, or how it would affect this patient (what is done, anaesthesia, how long, recovery, risks), whether or not the procedure is ever named? "
    "Explaining a plan such as 'we will operate on the ear drum and close it up' counts even without a technical name. A general remark that surgery may be needed, with nothing said about what it involves, does NOT count."}
COMBINED = {"type": "noul", "instructions": None}  # filled from the frozen v3 wording


def texts():
    out = {}
    ship = json.load(open(f"{V3}/ship-key.json"))
    for nid, k in sorted(ship.items()):
        out[nid] = (k["dir"], k["working_id"], "shipped")
    return out


def state(d, q):
    doc = json.load(open(f"{V3}/{d}/deid/{q}.json"))
    inn = [t for t in doc["turns"] if "phase" not in t]
    bad = finalize.residual_identifiers(inn)
    assert not bad, f"{q}: identifier hits"
    return bc.state_text(finalize.to_bc_turns({"turns": inn}))


def main():
    import v3
    COMBINED["instructions"] = v3.A["recall"]["instructions"]
    items = dict(texts())
    for q in ("Q03", "Q04", "Q05", "Q08", "Q10", "Q12", "Q14", "Q21", "Q22", "Q25"):
        items[f"neg-{q}"] = ("final-cand", q, "negative")
    truth = json.load(open(f"{V3}/ship-key.json"))
    rows = []
    for nid, (d, q, kind) in items.items():
        st = state(d, q); ps = {"combined": [], "named": [], "described": []}
        for _ in range(2):
            a = u9.ask(st, {"combined": COMBINED, "named": NAMED, "described": DESCRIBED})["answers"]
            for k in ps:
                ps[k].append(a[k]["noul"])
        rows.append((nid, q, kind, {k: round(sum(v) / len(v), 2) for k, v in ps.items()}, {k: round(max(v) - min(v), 2) for k, v in ps.items()}))
        print(nid, q, kind, rows[-1][3], "noise", rows[-1][4], flush=True)
    json.dump(rows, open(f"{V3}/v4_trial.json", "w")); os.chmod(f"{V3}/v4_trial.json", 0o600)


if __name__ == "__main__":
    main()
