#!/usr/bin/env python3
"""plan_e2e.py — HF-4 box-side planner (READ-ONLY on box state; writes only into --out): the exact set of windows for the E2E Whisper lane.
Uses hf-lane1/launch_lane.plan() unchanged (blind predicate from heldout.py f672c1ef046089dd, BLIND-IGNORE lists, REB track exists, existing claims), over every windows-reb/manifest-<day>.jsonl in [--from, --to] (default 2026-08-19..2026-09-29).
Writes <out>/worklist.jsonl (win_id, room, ist_date, start, end, audio=<day>/<room>/<file> RELATIVE, audio_sha256 from the manifest, need), <out>/files-from.txt (the rsync --files-from list, same relative paths) and <out>/plan.json (counts + sha16s).
Re-checks: no blind window in the list, every audio file exists and is under windows-reb, no duplicate window or path. Exit non-zero (nothing usable) on any violation. Audio is not opened (sha comes from the manifest; the NODE re-hashes before transcribing)."""
import argparse, glob, hashlib, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); LANE = os.path.join(os.path.dirname(HERE), "hf-lane1"); sys.path.insert(0, LANE)
import launch_lane as L

def build(heldout, union, days, reb_root, claims_root, wreb=L.WREB):
    todo_all, stats = [], {}
    for day in days:
        mp = f"{wreb}/manifest-{day}.jsonl"
        if not os.path.exists(mp): stats[day] = "no_manifest"; continue
        man = {w["win_id"]: w for w in (json.loads(l) for l in open(mp))}
        todo, st, _ = L.plan(day, heldout, union, reb_root, claims_root, None, None, mp); stats[day] = st
        for t in todo:
            m = man[t["win_id"]]; rel = os.path.relpath(m["audio"], wreb)
            todo_all.append({"win_id": t["win_id"], "room": t["room"], "ist_date": t["ist_date"], "start": t["start"], "end": t["end"], "audio": rel, "audio_sha256": m["sha256"], "need": t["need"], "_abs": m["audio"], "_dur": t["_dur"]})
    cnt = {}
    for w in todo_all: cnt[w["win_id"]] = cnt.get(w["win_id"], 0) + 1
    coll = sorted(k for k, v in cnt.items() if v > 1)          # same win_id in two day manifests (IST-midnight straddle + a dup-empty copy): claims/out files are keyed by win_id => NEITHER is planned, listed for backfill-lead
    stats["_id_collision_excluded"] = coll
    return [w for w in todo_all if w["win_id"] not in set(coll)], stats

def check(todo, heldout, union, wreb=L.WREB):
    seen, paths = set(), set()
    for w in todo:
        if L.is_blind(w, heldout, union): raise SystemExit(f"VIOLATION: blind window in the list: {w['win_id']}")
        if w["win_id"] in seen or w["audio"] in paths: raise SystemExit(f"VIOLATION: duplicate {w['win_id']}")
        seen.add(w["win_id"]); paths.add(w["audio"])
        if w["audio"].startswith(("/", "..")) or ".." in w["audio"].split("/"): raise SystemExit(f"VIOLATION: audio path not relative/contained: {w['audio']}")
        if not os.path.isfile(w["_abs"]) or not os.path.realpath(w["_abs"]).startswith(os.path.realpath(wreb) + "/"): raise SystemExit(f"VIOLATION: audio missing/outside windows-reb: {w['win_id']}")
        if not isinstance(w.get("audio_sha256"), str) or len(w["audio_sha256"]) != 64: raise SystemExit(f"VIOLATION: no audio sha256: {w['win_id']}")

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True); ap.add_argument("--from", dest="d0", default="2026-08-19"); ap.add_argument("--to", dest="d1", default="2026-09-29")
    ap.add_argument("--reb-root", default=L.REB_DEFAULT); ap.add_argument("--claims-root", default=L.CLAIMS_DEFAULT); ap.add_argument("--limit", type=int, default=0, help="first N windows only (bench lists)")
    a = ap.parse_args(argv); heldout, union, jm = L.load_guard()
    days = sorted(os.path.basename(p)[9:19] for p in glob.glob(f"{L.WREB}/manifest-????-??-??.jsonl")); days = [d for d in days if a.d0 <= d <= a.d1]
    todo, stats = build(heldout, union, days, a.reb_root, a.claims_root); check(todo, heldout, union)
    if a.limit: todo = todo[:a.limit]
    os.makedirs(a.out, mode=0o700, exist_ok=True)
    def wr(name, lines):
        p = f"{a.out}/{name}"
        if os.path.exists(p): raise SystemExit(f"REFUSED: {p} exists (write-once; use a new --out)")
        open(p, "w").write("".join(lines)); return p
    wl = wr("worklist.jsonl", [json.dumps({k: v for k, v in w.items() if not k.startswith("_")}) + "\n" for w in todo]); ff = wr("files-from.txt", [w["audio"] + "\n" for w in todo])
    h = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
    rep = {"windows": len(todo), "tracks_needed": sum(len(w["need"]) for w in todo), "audio_bytes": sum(os.path.getsize(w["_abs"]) for w in todo), "days": len(days), "per_day": {d: (s["planned"] if isinstance(s, dict) else s) for d, s in stats.items() if d != "_id_collision_excluded"}, "id_collision_excluded": stats["_id_collision_excluded"],
           "heldout_sha16": L.HELDOUT_SHA16, "union": L.UNION_SHA8, "worklist_sha16": h(wl), "files_from_sha16": h(ff), "blind_in_list": 0, "plan_script_sha16": h(__file__)}
    open(f"{a.out}/plan.json", "w").write(json.dumps(rep, indent=1)); print(json.dumps(rep, indent=1)); return 0

if __name__ == "__main__": sys.exit(main())
