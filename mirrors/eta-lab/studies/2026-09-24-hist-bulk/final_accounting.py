#!/usr/bin/env python3
"""final_accounting.py — hist-bulk's final per-window accounting (hist-miner #1547 form; ids and counts only, no text).
Per tier (A 2,209 / B 2,298): (1) counts per FINAL state (last state line per window) summing to the window count, with ids for no_audio / failed / unstarted / running;
(2) windows that were retried (a window with more than one terminal state line, or a later run): which ids, which run/router, new state; (3) per-run 'done' counts (final done only);
(4) claim files with no final done/no_signal/no_audio record (a claim without a result)."""
import json, os, collections
HD = os.path.expanduser("~/eta-data/hist")
rows = [json.loads(l) for l in open(f"{HD}/state.jsonl")]
last = {}; hist = collections.defaultdict(list)
for r in rows:
    last[r["win"]] = r; hist[r["win"]].append(r)
TERM = {"done", "failed", "no_audio", "no_signal"}
for tier in ("A", "B"):
    W = [w["win_id"] for w in json.load(open(f"{HD}/windows_tier{tier}.json"))]
    st = collections.Counter(last[w]["state"] if w in last else "unstarted" for w in W)
    print(f"\n== TIER {tier}: {len(W)} windows; final states: {dict(st)} (sum {sum(st.values())})")
    for k in ("no_audio", "failed", "running", "unstarted"):
        ids = [w for w in W if (last[w]["state"] if w in last else "unstarted") == k]
        if ids: print(f"   {k}: {len(ids)} ids: {ids[:40]}{' ...' if len(ids) > 40 else ''}")
    retried = [w for w in W if len([r for r in hist[w] if r["state"] in TERM]) > 1]
    print(f"   retried (more than one terminal state line): {len(retried)}")
    for w in retried[:40]:
        seq = [(r["state"], r.get("router"), r.get("run", "")[-15:]) for r in hist[w] if r["state"] in TERM]
        print("     ", w, "->", seq)
    per = collections.Counter(last[w].get("run", "old-layout/no-run-field") for w in W if w in last and last[w]["state"] == "done")
    print("   per-run FINAL done counts:", dict(per))
    nofinal = [w for w in W if os.path.exists(f"{HD}/claims/{w}") and (w not in last or last[w]["state"] not in ("done", "no_signal", "no_audio"))]
    print(f"   claim files without a final done/no_signal/no_audio state: {len(nofinal)} {nofinal[:20]}")
