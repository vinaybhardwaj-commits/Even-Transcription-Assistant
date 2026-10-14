"""Move raw output rows that are no longer current to <file>.stale.jsonl (nothing is deleted). Current = last row per turn (or per L2 window) whose id exists in the current cards/clips file.
usage: split_stale.py --cards inputs/cards.jsonl out/real/arm2.jsonl out/real/arm3.jsonl [out/real/arm4.jsonl]   (do not run while that arm is still writing)
The scorer already ignores stale rows (score.current_rows); this only tidies the files and keeps the stale rows for the record."""
import argparse, os, sys
import common as C, score as S

ap = argparse.ArgumentParser(); ap.add_argument("--cards", required=True, help="inputs/cards.jsonl (or clips.jsonl): the current run's turns and windows"); ap.add_argument("files", nargs="+"); a = ap.parse_args()
cur = C.read_jsonl(a.cards); tids, wids = {r["turn_id"] for r in cur}, {r["window_id"] for r in cur if r.get("window_id")}
for f in a.files:
    rows = C.read_jsonl(f); keep, n = S.current_rows(rows, tids, wids)
    keep_ids = {id(r) for r in keep}; stale = [r for r in rows if id(r) not in keep_ids]
    if not stale: print(f"{f}: nothing stale ({len(rows)} rows)"); continue
    old = C.read_jsonl(f + ".stale.jsonl") if os.path.exists(f + ".stale.jsonl") else []        # earlier stale rows are kept, never overwritten
    C.write_jsonl(f + ".stale.jsonl", old + stale)
    tmp = f + ".tmp"; C.write_jsonl(tmp, [r for r in rows if id(r) in keep_ids]); os.replace(tmp, f)      # original row order kept
    print(f"{f}: {len(keep)} current rows kept, {len(stale)} moved to {f}.stale.jsonl")
