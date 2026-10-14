#!/usr/bin/env python3
"""stage_ct_fixtures.py — RAW staging of eta-refuter-2's real plain-CT trial fixtures (#607) from ct_precision_sample_v2.json, in fleet's consult contract ({id, turns:[{i, speaker, lang, orig, en}]}).
NOT de-identified: surg-deid/fleet's deid CLI must run before any text reaches Jev. Ids are neutral and seeded-shuffled (they do not encode the label). speaker='other' for every turn (this sample has no speaker labels);
lang='und'; en = orig (no translation). The +-90 s context turns include the hit turn; its index goes in the KEY file (ids only), never in the doc.
Out: ~/eta-data/hist-mining/ct-fixtures/staging/CT<nn>.json (0600, dir 0700) + fixtures-key.json (ids, pool n, refuter label, hit turn index; no text). Prints counts only."""
import json, os, random
HM = os.path.expanduser("~/eta-data/hist-mining"); OUT = f"{HM}/ct-fixtures"; ST = f"{OUT}/staging"
LABELS = {2: "positive_proposed", 11: "positive_conditional", 6: "history_negative", 7: "history_negative", 10: "history_negative", 15: "history_negative"}   # eta-refuter-2 #599/#607
S = {o["n"]: o for o in json.load(open(f"{HM}/ct_precision_sample_v2.json"))}
os.makedirs(ST, mode=0o700, exist_ok=True); os.chmod(OUT, 0o700); os.chmod(ST, 0o700)
order = sorted(LABELS); random.Random(607).shuffle(order); key = {}
for k, n in enumerate(order, 1):
    o = S[n]; turns = [t for t in o["context_turns_90s"] if (t or "").strip()]
    hit = next((i for i, t in enumerate(turns) if t.strip() == (o["hit_turn"] or "").strip()), None)
    fid = f"CT{k:02d}"
    doc = {"id": fid, "turns": [{"i": i, "speaker": "other", "lang": "und", "orig": t, "en": t} for i, t in enumerate(turns)]}
    json.dump(doc, open(f"{ST}/{fid}.json", "w"), ensure_ascii=False); os.chmod(f"{ST}/{fid}.json", 0o600)
    key[fid] = {"pool_n": n, "label": LABELS[n], "day": o["day"], "n_turns": len(turns), "hit_turn_i": hit}
json.dump(key, open(f"{OUT}/fixtures-key.json", "w"), indent=1); os.chmod(f"{OUT}/fixtures-key.json", 0o600)
print("staged", len(key), "fixtures | turns per fixture:", [v["n_turns"] for v in key.values()], "| hit turn located in context:", sum(1 for v in key.values() if v["hit_turn_i"] is not None), "of", len(key))
