#!/usr/bin/env python3
"""FUSER v2-E M5 decoy sweep (pre-reg r3 §1 M5). No DEV and no fresh-set content: only wordfreq word lists and the lexicon.
(i) wordfreq top_n_list("en", 50000) as single tokens; (ii) all ordered pairs of the top 500 words as 2-token spans.
Runs the v2-E matcher (D1 + M1-M4) with the current exclusion set; every lexicon entry that produced a hit is excluded and the
sweep repeats until 0 candidates. Writes the frozen exclusion list (one name per line, sorted) and a JSON report.
usage: fuserv2e_m5_sweep.py --out-list EXCL.txt --out-report REPORT.json"""
import argparse, hashlib, itertools, json, os, sys

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO, "fuserv2e")); sys.path.insert(0, os.path.join(_REPO, "fuserv1"))
import fuserv2e as f  # noqa: E402
import lexicon  # noqa: E402
from wordfreq import top_n_list  # noqa: E402

RX_PATH = "/home/eta/eta-data/cap2/rx_history.jsonl"


def sweep(lex, w50k, top500):
    hits = {}
    for w in w50k:
        m = lex.match_span([w])
        if m:
            hits.setdefault(m["name"], []).append([w])
    for a, b in itertools.product(top500, repeat=2):
        m = lex.match_span([a, b])
        if m:
            hits.setdefault(m["name"], []).append([a, b])
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-list", required=True); ap.add_argument("--out-report", required=True)
    a = ap.parse_args()
    for p in (a.out_list, a.out_report):
        if os.path.exists(p):
            sys.exit(f"refusing: {p} exists")
    lx = lexicon.load_lexicon(RX_PATH)
    w50k = [w for w in top_n_list("en", 50000) if w.isalpha() and w.isascii()]
    top500 = top_n_list("en", 500)
    excluded, rounds = set(), []
    while True:
        lex = f.LexE(lx, excluded)
        hits = sweep(lex, w50k, top500)
        rounds.append({"round": len(rounds) + 1, "n_eligible_names": len(lex.names), "n_hit_names": len(hits),
                       "hits": {k: v[:5] for k, v in sorted(hits.items())}})
        print(f"round {len(rounds)}: eligible {len(lex.names)}, hit names {len(hits)}", flush=True)
        if not hits:
            break
        excluded |= set(hits)
    body = "".join(n + "\n" for n in sorted(excluded))
    open(a.out_list, "x").write(body)
    rep = {"wordfreq": f.wordfreq_version(), "n_tokens_i": len(w50k), "n_pairs_ii": len(top500) ** 2,
           "lexicon_n": len(lx), "final_excluded_n": len(excluded), "final_eligible_n": len(lex.names),
           "exclusion_list_sha256": hashlib.sha256(body.encode()).hexdigest(), "rounds": rounds}
    json.dump(rep, open(a.out_report, "x"), indent=1, ensure_ascii=False)
    print("exclusion list sha256", rep["exclusion_list_sha256"], "n", len(excluded))


if __name__ == "__main__":
    main()
