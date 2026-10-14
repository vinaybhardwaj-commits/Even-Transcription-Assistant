"""Pre-registered decoy false-positive check (refuter-2 D2), run BEFORE any candidate is scored.
Pulls public, non-patient text from ekacare/eka-medical-asr-evaluation-dataset (en split) rows whose medical_entities
carries NO "drugs" entity, runs detect_drug_groups against the real union 22/23/24 Sep drug_master lexicon, and reports
the fraction of decoy rows producing >=1 spurious group hit. See ADDENDUM-3-W50-STEP1.md for the pre-registered ceiling
this result sets, and the honest caveat about decoy contamination (some "non-drug-entity" rows do contain a real drug/
supplement name that Eka's own tagging simply missed - not all hits below are genuine detector false positives).
Network access required (public HF datasets-server); not run automatically as part of the test suite.
"""
import json
import urllib.request

from detect_drug_mentions import detect_drug_groups


def load_lexicon():
    master = {}
    for day in ("22", "23", "24"):
        d = json.load(open(f"/home/eta/eta-data/cap/raw-2026-09-{day}/drug_master.json"))
        for uid, brand, generic, _strength in d["rows"]:
            master[uid] = {"uid": uid, "brand_name": brand or "", "generic_name": generic or ""}
    return list(master.values())


def load_decoy_texts(target_n=250, batch=50, max_offset=3600, start_offset=0):
    texts = []
    for off in range(start_offset, max_offset, batch):
        url = (
            "https://datasets-server.huggingface.co/rows?dataset=ekacare%2Feka-medical-asr-evaluation-dataset"
            f"&config=en&split=test&offset={off}&length={batch}"
        )
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.load(resp)
        for row in data.get("rows", []):
            r = row["row"]
            try:
                ents = json.loads(r.get("medical_entities") or "[]")
            except Exception:
                ents = []
            has_drug_entity = any(len(e) > 1 and e[1] == "drugs" for e in ents)
            if not has_drug_entity and r.get("text"):
                texts.append(r["text"])
        if len(texts) >= target_n:
            break
    return texts


def main(start_offset=0):
    lexicon = load_lexicon()
    texts = load_decoy_texts(start_offset=start_offset)
    fp = [(t, detect_drug_groups(t, lexicon)) for t in texts]
    fp_hits = [(t, g) for t, g in fp if g]
    rate = len(fp_hits) / len(texts) if texts else 0.0
    print(f"lexicon rows: {len(lexicon)}")
    print(f"decoy rows: {len(texts)}")
    print(f"spurious-hit rows: {len(fp_hits)} ({rate:.4f})")
    for t, g in fp_hits[:10]:
        print("  -", t[:70].replace("\n", " "), "->", sorted(g))


if __name__ == "__main__":
    import sys as _sys
    main(start_offset=int(_sys.argv[1]) if len(_sys.argv) > 1 else 0)
