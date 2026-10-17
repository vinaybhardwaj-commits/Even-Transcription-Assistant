#!/usr/bin/env python3
"""A1.3 record (COUNTS ONLY, nothing tuned): for v2-D's correct D-any inserts on DEV (clinical1), which v2-E rule first removes each.
Order: M3, M4b, M5 (name level); then span level on v2-D's own mention tokens: M4a, M2, M1, other-matcher (margin/no-match);
then D4-E (P holds the drug under D4-E but not under v2-D). usage: fuserv2e_removal_counts.py V2D_OUT.jsonl"""
import collections, json, os, sys
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for d in ("fuserv2e", "fuserv2", "fuserv1"):
    sys.path.insert(0, os.path.join(_REPO, d))
sys.path.insert(0, "/tmp/wt-reb-a447dc36/kit"); sys.path.insert(0, os.path.expanduser("~/eta-data/drtpqma"))
import reb as reb_pkg, lexicon  # noqa: E402
import fuserv2e as fe, fuserv2 as f2, tokenize_tracks as tt  # noqa: E402

SUITE = "/home/eta/eta-data/diag-rig/stimuli/clinical1"
P_DIR = "/home/eta/oc/router-fix/s1-results/old"
CAT = {e["window_id"]: e for e in json.load(open("/tmp/dev_ingest_catalog_fixed.json"))}
HASH = {"whisper-forced-en": "a2131b2d", "whisper-cap2": "c7bd317b", "whisper-auto": "4b67551a"}

lx = lexicon.load_lexicon("/home/eta/eta-data/cap2/rx_history.jsonl")
excl = open(os.path.join(_REPO, "fuserv2e", "m5_exclusions.txt")).read().split()
lexE = fe.LexE(lx, excl); v2dlex = f2.Lex(lx); EN = fe.english_words()
cnt = collections.Counter(); total = 0
for l in open(sys.argv[1]):
    r = json.loads(l)
    if r.get("header") or r["variant"] != "D-any":
        continue
    w = r["window_id"]; t = json.load(open(f"{SUITE}/{w}.truth.json"))
    drugs = {lexicon.clean_ingredient(i["name"]) for i in t["clinical_items"] if i["type"] == "drug"}
    good = [i for i in r["inserts"] if i["drug"] in drugs]
    if not good:
        continue
    p = json.load(open(f"{P_DIR}/{w}.result.json"))["engines"]["stt"]["text"]
    e = CAT[w]; win = reb_pkg.load_window(w, ist_date=e["ist_date"], room_id=e["room_id"])
    toks = {}
    for k, n in enumerate(fe.TRACKS):
        ts = [x for x in win.tracks(layer="stt", engine=n, latest_ok=False) if x.entry.get("config_hash") == HASH[n]]
        toks[k] = tt.tokenize_track(k, ts[0].segments)
    mem = {k: fe.track_mentions(k, ts_segs, lexE) for k, ts_segs in
           ((k, [s for s in win.tracks(layer="stt", engine=n, latest_ok=False) if s.entry.get("config_hash") == HASH[n]][0].segments) for k, n in enumerate(fe.TRACKS))}
    for i in good:
        total += 1; d = i["drug"]; ws = d.split()
        if len(fe.letters(d)) < fe.MIN_NAME_LETTERS: cnt["M3"] += 1; continue
        if all(x.lower() in EN for x in ws): cnt["M4b"] += 1; continue
        if d in excl: cnt["M5"] += 1; continue
        if len(ws) > fe.MAX_WORDS: cnt["other(>4 words)"] += 1; continue
        if any(d in mem[k] for k in mem):
            cnt["D4-E" if fe.p_has_drug(p, d, lexE) else "kept"] += 1; continue
        by_id = {t2["id"]: t2["text"] for k in toks for t2 in toks[k]}
        span = [fe._norm(by_id[x]) for x in i["token_ids"] if x in by_id and f2._is_latin_word(fe._norm(by_id[x]))]
        if any(x.lower() in EN for x in span): cnt["M4a"] += 1
        elif len(span) == 2 and any(len(fe.letters(x)) < 3 for x in span): cnt["M2"] += 1
        elif fe.letter_sim("".join(span), d.replace(" ", "")) < fe.T_LETTER: cnt["M1"] += 1
        else: cnt["other(margin/no-match)"] += 1
print("v2-D correct D-any inserts:", total)
for k, v in sorted(cnt.items(), key=lambda x: -x[1]): print(f"  {k}: {v}")
