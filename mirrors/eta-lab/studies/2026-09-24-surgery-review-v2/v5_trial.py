#!/usr/bin/env python3
"""v5_trial.py — ruling 164: does the v5 IMAGING SCOPE (plain CT in; MRI, X-ray, ultrasound, echo, ECG, treadmill out) change the named / described answers the way it should? Trial of v4 (frozen) vs the v5 DRAFT
questions on: the 12 shipped consults, imaging-mention fixtures (CT / MRI / X-ray consults from the pool, single-encounter only) and 10 negatives. De-identified in-encounter text only. Each item asked twice.
Development trial only (no freeze, no score). Prints ids and probabilities."""
import json, os, sys
import u9, build_consult as bc, finalize, v4, v5

V3 = os.path.expanduser("~/eta-data/surgery-review-v3")


def state(d, q):
    doc = json.load(open(f"{V3}/{d}/deid/{q}.json")); inn = [t for t in doc["turns"] if "phase" not in t]
    assert not finalize.residual_identifiers(inn), q
    return bc.state_text(finalize.to_bc_turns({"turns": inn}))


def main():
    key = json.load(open(f"{V3}/ship-key.json")); items = {n: (k["dir"], k["working_id"], "shipped") for n, k in sorted(key.items())}
    for q, d in (("W03", "final-wide"), ("W36", "final-wide"), ("W37", "final-wide"), ("W38", "final-wide"), ("Q19", "final-cand"), ("W76", "final-wide"), ("W90", "final-wide"), ("W91", "final-wide")):
        items[f"fx-{q}"] = (d, q, "fixture")
    for q in ("Q03", "Q04", "Q05", "Q08", "Q10", "Q12", "Q14", "Q21", "Q22", "Q25"):
        items[f"neg-{q}"] = ("final-cand", q, "negative")
    # dedupe: the pool holds the SAME consult at different offsets (eta-refuter-2: W03/W36/W37/W38, W89/W95, W55/W66): one item per in-encounter text
    import hashlib
    seen, uniq = {}, {}
    for nid, (d, q, kind) in items.items():
        doc = json.load(open(f"{V3}/{d}/deid/{q}.json")); txt = " ".join(t["orig"] for t in doc["turns"] if "phase" not in t)
        sig = frozenset(hashlib.sha256(" ".join(t["orig"].split()).lower().encode()).hexdigest() for t in doc["turns"] if "phase" not in t and len(t["orig"].split()) >= 8)
        dup = next((k for k, s in seen.items() if len(sig & s) >= 0.5 * min(len(sig), len(s)) and min(len(sig), len(s)) > 0), None)
        if dup: print("skip duplicate:", nid, "== ", dup); continue
        seen[nid] = sig; uniq[nid] = (d, q, kind)
    items = uniq
    rows = []
    for nid, (d, q, kind) in items.items():
        st = state(d, q); res = {"v4n": [], "v4d": [], "v5n": [], "v5d": []}
        for _ in range(2):
            a = u9.ask(st, {"v4n": v4.A["named"], "v4d": v4.A["described"], "v5n": v5.A["named"], "v5d": v5.A["described"]})["answers"]
            for k in res:
                res[k].append(a[k]["noul"])
        m = {k: round(sum(v) / len(v), 2) for k, v in res.items()}
        rows.append((nid, q, kind, m)); print(f"{nid:10s} {q:5s} {kind:9s} v4 named {m['v4n']:.2f} desc {m['v4d']:.2f} | v5 named {m['v5n']:.2f} desc {m['v5d']:.2f}", flush=True)
    json.dump(rows, open(f"{V3}/v5_trial.json", "w")); os.chmod(f"{V3}/v5_trial.json", 0o600)


if __name__ == "__main__":
    main()
