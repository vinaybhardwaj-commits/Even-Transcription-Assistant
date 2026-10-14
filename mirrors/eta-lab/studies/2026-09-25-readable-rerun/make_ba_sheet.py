#!/usr/bin/env python3
"""337c blind BEFORE/AFTER sheet for V/Sandhya (box-only, patient text). Pairs = (old stored text, whisper large-v3 forced-language re-run) for the
same audio segment. A/B order per row is randomised with a frozen seed; the sheet shows NO engine, score, flag or which side is old. The key
(row -> which side is old, engine, language cell) is a separate file, joined only after labelling. Rows are drawn from re-run results in a frozen
order (shuffled manifests: any prefix is a random sample). Both sides must be non-empty (EMPTY re-runs are counted separately as a LOSS, never shown blind: a blank side reveals itself).
  make_ba_sheet.py --n 96 --seed 20260940 --out ~/eta-data/readable-rerun/r1/ba_v1
Outputs: sheet.tsv (n, claimed_language, start_s, end_s, text_A, text_B, label), key.json, counts.json (ids/counts only)."""
import argparse, collections, json, os, random
R1 = os.path.expanduser("~/eta-data/readable-rerun/r1/"); H = os.path.expanduser("~/eta-data/hist/")
ap = argparse.ArgumentParser(); ap.add_argument("--n", type=int, default=96)
ap.add_argument("--unflagged-only", action="store_true", help="addendum 5 batch 2: draw only non-empty re-runs that are NOT stock strings (>=3x in the full set) and NOT text on near-silence")
ap.add_argument("--exclude-key", help="key.json of an earlier sheet: its segment ids are not drawn again")
ap.add_argument("--alloc", help="cell=count,... overrides the default shares, e.g. kn=30,hi=30,bn=12,ta=12,ml=8,other=8"); ap.add_argument("--seed", type=int, default=20260940); ap.add_argument("--out", required=True)
a = ap.parse_args()
hall = json.load(open(R1 + "results/hall.json")) if os.path.exists(R1 + "results/hall.json") else {}
excl = {v["id"] for v in json.load(open(a.exclude_key)).values()} if a.exclude_key else None
man = {}
for k in range(4):
    for l in open(R1 + f"s{k}/manifest.jsonl"):
        m = json.loads(l); man[m["id"]] = m
pool = collections.defaultdict(list); empties = collections.Counter(); seen = collections.Counter(); prefix = {}; wins = collections.defaultdict(set); rooms = collections.defaultdict(set)
for k in range(4):
    p = R1 + f"results/s{k}_whisper_large-v3.jsonl"
    if not os.path.exists(p): continue
    lines = open(p).read().splitlines(); prefix[f"s{k}"] = len(lines)      # the frozen prefix: exactly these lines, recorded in counts.json
    for l in lines:
        r = json.loads(l); m = man.get(r["id"])
        if not m or not m["force_lang"]: continue
        cell0 = m["force_lang"] if m["force_lang"] in ("kn", "hi", "bn", "ta", "ml") else "other"
        seen[cell0] += 1
        if not r["text"].strip(): empties[cell0] += 1; continue
        old = json.load(open(H + m["record"]))["segments"][m["idx"]]["text"]
        if not old.strip(): continue
        cell = m["force_lang"] if m["force_lang"] in ("kn", "hi", "bn", "ta", "ml") else "other"
        h = hall.get(r["id"], {})
        if a.unflagged_only and ((h.get("recur") or 0) >= 3 or h.get("near_silence_text")): continue
        if excl and r["id"] in excl: continue
        pool[cell].append((r["id"], old, r["text"], m))
        wins[cell].add(m["record"]); rooms[cell].add(m["record"].split("/")[2] if m["record"].startswith("runs/") else m["record"].split("/")[1])
alloc = {"kn": 0.25, "hi": 0.25, "bn": 0.125, "ta": 0.125, "ml": 0.125, "other": 0.125}
fixed = {c: int(n) for c, n in (kv.split("=") for kv in a.alloc.split(","))} if a.alloc else None
rnd = random.Random(a.seed); rows = []
for cell in alloc:
    rnd.shuffle(pool[cell]); rows += [(cell, x) for x in pool[cell][:(fixed[cell] if fixed else round(a.n * alloc[cell]))]]
# ATTENTION/BIAS CHECK (eta-refuter #2111 3b): ~10 % extra rows whose two sides are the SAME old text; a rater who prefers A or B there shows position bias.
idn = [(c, x) for c, xs in pool.items() for x in xs if x[0] not in {y[1][0] for y in rows}]
rnd.shuffle(idn); nid = max(1, round(a.n * 0.10)); rows += [("identical:" + c, x) for c, x in idn[:nid]]
rnd.shuffle(rows)
os.makedirs(a.out, mode=0o700, exist_ok=True); key = {}; counts = collections.Counter()
with open(os.path.join(a.out, "sheet.tsv"), "w") as f:
    f.write("n\tclaimed_language\tstart_s\tend_s\ttext_A\ttext_B\tlabel (A_better | B_better | same | neither_readable | unsure)\n")
    for i, (cell, (sid, old, new, m)) in enumerate(rows, 1):
        ident = cell.startswith("identical:")
        if ident: new = old
        flip = rnd.random() < 0.5; A, B = (new, old) if flip else (old, new)
        rec = json.load(open(H + m["record"])); s = rec["segments"][m["idx"]]
        f.write(f"{i}\t{m['force_lang']}\t{s['start_s']}\t{s['end_s']}\t{A.replace(chr(9),' ').replace(chr(10),' ')}\t{B.replace(chr(9),' ').replace(chr(10),' ')}\t\n")
        h = hall.get(sid, {})
        key[i] = {"id": sid, "cell": cell, "lang": m["force_lang"], "old_side": "B" if flip else "A", "old_engine": m["engine"], "flagged_id": m.get("flagged_id"),
                  "identical": ident, "recur": h.get("recur"), "near_silence_text": h.get("near_silence_text"), "cps_voiced": h.get("cps_voiced")}
        counts[cell] += 1
json.dump(key, open(os.path.join(a.out, "key.json"), "w")); json.dump({"n": len(rows), "by_cell": counts, "pool": {c: len(v) for c, v in pool.items()}, "seed": a.seed, "frozen_prefix_lines_per_shard": prefix,
           "rerun_empty_by_cell": {c: {"empty": empties[c], "seen": seen[c]} for c in seen}, "distinct_windows_by_cell": {c: len(v) for c, v in wins.items()}, "distinct_rooms_by_cell": {c: len(v) for c, v in rooms.items()}}, open(os.path.join(a.out, "counts.json"), "w"))
for fn in ("sheet.tsv", "key.json", "counts.json"): os.chmod(os.path.join(a.out, fn), 0o600)
print(json.dumps({"rows": len(rows), "by_cell": counts, "pool": {c: len(v) for c, v in pool.items()}}))
