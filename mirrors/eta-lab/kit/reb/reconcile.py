"""Compare R2 reb/ listing vs box cache (~/eta-data/reb) vs per-day index.jsonl (PALIMPSEST step 1).
Read-only: lists R2 keys, walks box directory NAMES, reads index.jsonl lines. Never opens track contents, never deletes.
Writes one report /home/eta/oc/palimpsest/out/reconcile-<ts>.md. Keys are reb-relative: <date>/<room>/<window>/tracks/<file>.
"""
import json
import os
import sys
import time

from kit.reb import r2_ls

BOX = os.path.expanduser("~/eta-data/reb")
OUT_DIR = r2_ls.OUT_DIR
EXAMPLES = 20


def r2_track_keys(client):
    """{date: set(rel keys)} for track files in R2 (only keys that parse as tracks; others ignored)."""
    out = {}
    for o in r2_ls.iter_objects(client, r2_ls.PREFIX):
        if r2_ls.parse_key(o["Key"]):
            rel = o["Key"][len(r2_ls.PREFIX):]
            out.setdefault(rel.split("/")[0], set()).add(rel)
    return out


def box_track_keys(box=BOX):
    out = {}
    if not os.path.isdir(box):
        return out
    for date in sorted(os.listdir(box)):
        dd = os.path.join(box, date)
        if not os.path.isdir(dd):
            continue
        s = set()
        for room in os.listdir(dd):
            rd = os.path.join(dd, room)
            if not os.path.isdir(rd):
                continue
            for win in os.listdir(rd):
                td = os.path.join(rd, win, "tracks")
                if os.path.isdir(td):
                    s.update(f"{date}/{room}/{win}/tracks/{f}" for f in os.listdir(td) if f.endswith(".json"))
        out[date] = s
    return out


def index_track_keys(box=BOX):
    """Paths from each date's index.jsonl (the 'path' field, reb-relative)."""
    out = {}
    if not os.path.isdir(box):
        return out
    for date in sorted(os.listdir(box)):
        p = os.path.join(box, date, "index.jsonl")
        if not os.path.isfile(p):
            continue
        s = set()
        with open(p) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    path = json.loads(line).get("path")
                except json.JSONDecodeError:
                    continue
                if path:
                    s.add(path)
        out[date] = s
    return out


def compare(r2, box, idx):
    rows = {}
    for date in sorted(set(r2) | set(box) | set(idx)):
        a, b, c = r2.get(date, set()), box.get(date, set()), idx.get(date, set())
        diffs = {"in_box_not_r2": sorted(b - a), "in_r2_not_box": sorted(a - b), "in_index_not_on_disk": sorted(c - b)}
        rows[date] = {"r2": len(a), "box": len(b), "index": len(c),
                      "diff_counts": {k: len(v) for k, v in diffs.items()},
                      "examples": {k: v[:EXAMPLES] for k, v in diffs.items()}}
    return rows


def render(rows):
    L = ["# REB reconcile: R2 vs box vs index", "", "| date | R2 | box | index | in-box-not-R2 | in-R2-not-box | in-index-not-on-disk |", "|---|---|---|---|---|---|---|"]
    for d, r in rows.items():
        c = r["diff_counts"]
        L.append(f"| {d} | {r['r2']} | {r['box']} | {r['index']} | {c['in_box_not_r2']} | {c['in_r2_not_box']} | {c['in_index_not_on_disk']} |")
    tot = {k: sum(r["diff_counts"][k] for r in rows.values()) for k in ("in_box_not_r2", "in_r2_not_box", "in_index_not_on_disk")}
    L += ["", f"Totals: R2={sum(r['r2'] for r in rows.values())} box={sum(r['box'] for r in rows.values())} "
          f"index={sum(r['index'] for r in rows.values())}; differences {tot}", ""]
    for d, r in rows.items():
        for k, ex in r["examples"].items():
            if ex:
                L += [f"## {d} {k} ({r['diff_counts'][k]}; up to {EXAMPLES} shown)"] + [f"- {x}" for x in ex] + [""]
    return "\n".join(L)


def main(client=None, box=BOX, out_dir=OUT_DIR):
    t0 = time.time()
    try:
        client = client or r2_ls.make_client()
        r2 = r2_track_keys(client)
    except Exception as e:
        print(f"reconcile: R2 list failed ({type(e).__name__})", file=sys.stderr)
        return 2
    rows = compare(r2, box_track_keys(box), index_track_keys(box))
    os.makedirs(out_dir, exist_ok=True)
    p = os.path.join(out_dir, f"reconcile-{time.strftime('%Y%m%dT%H%M%S')}.md")
    with open(p, "w") as f:
        f.write(render(rows) + f"\n\nelapsed {time.time()-t0:.1f}s\n")
    print("wrote", p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
