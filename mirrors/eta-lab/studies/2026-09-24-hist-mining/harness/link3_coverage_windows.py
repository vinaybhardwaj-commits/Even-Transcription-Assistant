#!/usr/bin/env python3
"""link3_coverage_windows.py — linker ruling 200 (A): the (room, start, end) windows for a +-60 min COVERAGE PASS on the 8 below-floor items (c002 c003 c007 c009 c017 c018 c019 c022): EVERY room with tape in [consult_start-60, consult_end+60],
minus what is already transcribed. Sizes come from real TAPE coverage (bench_chunk times, union per room), not span x rooms. 'Already transcribed' = every ok HIST window record found under ~/eta-data/hist/{out,runs} and ~/eta-data/hist-mining/{runs,results}
(their start/end/room_id), subtracted per room; what remains is tiled into windows of <= 15 min (window size of the production room path; remainders < 90 s are dropped and counted). Ids and times only: no text is read from the records except their room_id/start/end fields.
Out: ~/eta-data/hist-mining/link3_coverage_windows.json (0600) with per-item and total audio-hours."""
import glob, json, os, subprocess, sys
from collections import defaultdict
from datetime import datetime, timedelta
HM = os.path.expanduser("~/eta-data/hist-mining"); iso = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs"); ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant")
ITEMS = ["c002", "c003", "c007", "c009", "c017", "c018", "c019", "c022"]; PAD = timedelta(minutes=60); WIN = timedelta(minutes=15); MIN_S = 90
def neon(q):
    r = subprocess.run(["node", NEON, q], cwd=ETA, capture_output=True, text=True, timeout=300)
    if r.returncode: raise SystemExit(f"neon-select rc={r.returncode}")
    return json.loads(r.stdout)
def union(iv):
    out = []
    for a, b in sorted(iv):
        if out and a <= out[-1][1]: out[-1][1] = max(out[-1][1], b)
        else: out.append([a, b])
    return out
def subtract(iv, cut):
    res = []
    for a, b in iv:
        cur = a
        for c, d in cut:
            if d <= cur or c >= b: continue
            if c > cur: res.append([cur, c])
            cur = max(cur, d)
        if cur < b: res.append([cur, b])
    return res
inp = {i["item"]: i for i in json.load(open(os.path.expanduser("~/eta-data/surgical-chain/p1/link3_inputs_blind.json")))}
# finished HIST windows per room (ok records only; room_id + start/end)
done = defaultdict(list); n_rec = 0
for pat in ("~/eta-data/hist/out/*/*.json", "~/eta-data/hist/runs/*/*/*/*.json", "~/eta-data/hist-mining/runs/*/*/*/*.json", "~/eta-data/hist-mining/results/*.json"):
    for f in glob.glob(os.path.expanduser(pat)):
        if ".attempt" in f: continue
        try: r = json.load(open(f))
        except Exception: continue
        if not (isinstance(r, dict) and r.get("ok") and r.get("start") and r.get("end")): continue
        room = r.get("room_id") or (r.get("window") or {}).get("room_id")
        if not room: room = f.split("/")[-3] if "/runs/" in f else None
        if not room: continue
        try: done[room].append((iso(r["start"]), iso(r["end"]))); n_rec += 1
        except Exception: pass
done = {k: union(v) for k, v in done.items()}
wins, per_item, excluded_h = [], {}, 0.0
for it in ITEMS:
    a, b = iso(inp[it]["start"]) - PAD, iso(inp[it]["end"]) + PAD
    rows = neon(f"SELECT c.id, c.session_id, bs.room_id, c.idx, c.r2_key, c.started_at, c.ended_at, c.upload_state, c.source FROM bench_chunk c JOIN bench_session bs ON bs.id=c.session_id WHERE c.started_at < '{b.isoformat()}' AND c.ended_at > '{a.isoformat()}'")
    byroom = defaultdict(list)
    for r in rows: byroom[r["room_id"]].append(r)
    tape_s = need_s = 0.0
    for room, rs in sorted(byroom.items()):
        tape = union([(max(iso(r["started_at"]), a), min(iso(r["ended_at"]), b)) for r in rs if min(iso(r["ended_at"]), b) > max(iso(r["started_at"]), a)])
        tape = [[x, y] for x, y in tape]; tape_s += sum((y - x).total_seconds() for x, y in tape)
        need = subtract(tape, done.get(room, [])); need_s += sum((y - x).total_seconds() for x, y in need)
        for x, y in need:
            cur = x
            while cur < y:
                end = min(cur + WIN, y)
                if (end - cur).total_seconds() >= MIN_S:
                    ch = [{k: r[k] for k in ("id", "session_id", "room_id", "idx", "r2_key", "started_at", "ended_at", "upload_state", "source")} for r in rs if iso(r["started_at"]) < end and iso(r["ended_at"]) > cur]
                    wins.append({"window_id": f"l3c-{it}-{room.split('_')[-1]}-{cur.astimezone(a.tzinfo):%H%M}", "item": it, "room_id": room, "day": inp[it]["day"], "start": cur.isoformat(), "end": end.isoformat(), "n_chunks": len(ch), "chunks": ch})
                cur = end
    per_item[it] = {"rooms_with_tape": len(byroom), "tape_h": round(tape_s / 3600, 2), "to_transcribe_h": round(need_s / 3600, 2), "already_finished_h": round((tape_s - need_s) / 3600, 2)}
wins.sort(key=lambda w: (w["item"], w["start"]))      # item-major, then time: an item's rooms/hours finish together; no class is known here
for i, w in enumerate(wins, 1): w["queue_position"] = i; w["priority_group"] = "COVERAGE_PASS_60MIN"      # hist-bulk's --priority reader sorts by queue_position (ruling 212)
tot_h = round(sum((iso(w["end"]) - iso(w["start"])).total_seconds() for w in wins) / 3600, 1)
out = {"purpose": "linker ruling 200 (A): +-60 min coverage pass windows for the 8 below-floor items, every room with tape, minus windows already transcribed (ok HIST records in hist/ and hist-mining/). <= 15 min windows. Blind item ids only. MINING ONLY. Nothing queued.",
       "n_windows": len(wins), "audio_h_total": tot_h, "per_item": per_item, "finished_records_used": n_rec, "windows": wins}
p = f"{HM}/link3_coverage_windows.json"; json.dump(out, open(p, "w"), indent=1); os.chmod(p, 0o600)
print("windows", len(wins), "| audio-h to transcribe:", tot_h, "| finished HIST records subtracted:", n_rec)
for it, v in per_item.items(): print(" ", it, v)
print("windows with >=1 chunk:", sum(1 for w in wins if w["n_chunks"]), "| rooms used:", len({w['room_id'] for w in wins}))
