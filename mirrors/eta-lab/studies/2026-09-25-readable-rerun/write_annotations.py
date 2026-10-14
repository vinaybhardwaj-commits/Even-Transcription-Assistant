#!/usr/bin/env python3
"""337c(2): turn the whisper re-run results into annotations kind=retranscription (ruling 341; lab-viewer #2007), NOT staged for upload.
Each result is attached to the record the VIEWER shows for that window (latest staged index view-*.jsonl: window_id -> key), only when that record's
segment `i` has the same start_s/end_s/lang as the segment I cut (else skipped and counted). Items: {k, i, text2, engine2, lang2, better: null, score_old, score_new}.
Sources are sha-bound by make_annotation.build (the local copy of runs/<k>.json, which must equal the vault object). Output goes to --out (a private dir); copy the
files into ~/eta-data/lab-vault/staged/annotations/... ONLY after eta-refuter has looked at a batch: staging = publishing to an immutable vault.
  write_annotations.py --out DIR [--limit N] [--min-score-gap X]      prints counts only"""
import argparse, collections, glob, importlib.util, json, os, sys
R1 = os.path.expanduser("~/eta-data/readable-rerun/r1/"); H = os.path.expanduser("~/eta-data/hist/"); ST = os.path.expanduser("~/eta-data/lab-vault/staged/")
ap = argparse.ArgumentParser(); ap.add_argument("--out", required=True); ap.add_argument("--limit", type=int, default=0); a = ap.parse_args()
spec = importlib.util.spec_from_file_location("mk", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "kit", "lab-vault", "tools", "make_annotation.py"))
mk = importlib.util.module_from_spec(spec); spec.loader.exec_module(mk)
idx = sorted(glob.glob(ST + "index/view-*.jsonl"))[-1]
view = {}
for l in open(idx):
    j = json.loads(l); view[j["window_id"]] = j["key"]           # key: runs/<run_id>/<room>/<date>/<window>.json
man = {}
for k in range(4):
    for l in open(R1 + f"s{k}/manifest.jsonl"):
        m = json.loads(l); man[m["id"]] = m
rows = {r["id"]: r for r in json.load(open(R1 + "results/rows.json"))} if os.path.exists(R1 + "results/rows.json") else {}
items, skipped = [], collections.Counter()
for k in range(4):
    p = R1 + f"results/s{k}_whisper_large-v3.jsonl"
    if not os.path.exists(p): continue
    for l in open(p):
        r = json.loads(l); m = man.get(r["id"])
        if not m or not r["text"].strip(): skipped["empty_or_unknown"] += 1; continue
        src = json.load(open(H + m["record"])); seg = src["segments"][m["idx"]]
        wid = src.get("window_id") or os.path.basename(m["record"])[:-5]
        vk = view.get(wid)
        if not vk: skipped["window_not_in_viewer_index"] += 1; continue
        vpath = next((c for c in (ST + vk, H + vk) if os.path.exists(c)), None)   # backfill runs are staged; live runs are under ~/eta-data/hist/runs (the uploader maps that dir to runs/)
        if not vpath: skipped["viewer_record_not_local"] += 1; continue
        vseg = (json.load(open(vpath)).get("segments") or [])
        if m["idx"] >= len(vseg) or abs(vseg[m["idx"]]["start_s"] - seg["start_s"]) > 0.06 or abs(vseg[m["idx"]]["end_s"] - seg["end_s"]) > 0.06 or vseg[m["idx"]].get("lang") != seg.get("lang"):
            skipped["viewer_segment_differs"] += 1; continue
        sc = rows.get(r["id"], {})
        items.append({"record": vpath, "i": m["idx"], "text2": r["text"], "engine2": r["engine"], "lang2": r.get("forced") or r.get("detected"),
                      "better": None, "score_old": sc.get("os"), "score_new": sc.get("ns")})
        if a.limit and len(items) >= a.limit: break
    if a.limit and len(items) >= a.limit: break
os.makedirs(a.out, mode=0o700, exist_ok=True)
written = mk.build("retranscription", "indic-mt", items, a.out) if items else {}
print(json.dumps({"items": len(items), "files": len(written), "skipped": dict(skipped)}))
