#!/usr/bin/env python3
"""today_plan.py — ruling 370 item 5 (hist-bulk): tier C = tape recorded AFTER my Aug-Sep inventory (chunk ids not in ~/eta-data/hist/inventory.json), planned into 15-min grid windows.
Read-only Neon (kit/neon-select.mjs); ids/keys/times only, no audio, no text. Re-run hourly: it rewrites ONLY manifest_tierC.json and windows_tierC.json (never manifest.json / windows_tierA/B).
Window ids are 'c-<day>_<room>_<HHMM>' so they can never collide with the A/B ids (a grid window that straddled the inventory cut is planned again here with its full tape).
A window is planned only when it is COMPLETE enough: its end is at least --settle minutes old (default 20), so chunks that are still uploading are not cut short. Newest windows first (V reads today's text first).
  today_plan.py [--settle 20]"""
import argparse, json, os, subprocess
from datetime import datetime, timedelta, timezone
NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs"); ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant")
HD = os.path.expanduser("~/eta-data/hist"); W = timedelta(minutes=15)
IST = timezone(timedelta(hours=5, minutes=30))
p = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
ap = argparse.ArgumentParser(); ap.add_argument("--settle", type=int, default=20); a = ap.parse_args()
inv_ids = {c["id"] for d in json.load(open(f"{HD}/inventory.json")) for c in d["chunks"]}
r = subprocess.run(["node", NEON, "SELECT c.id, c.session_id, bs.room_id, c.idx, c.r2_key, c.started_at, c.ended_at, c.duration_ms, c.size_bytes, c.source, to_char(c.started_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') d "
                    "FROM bench_chunk c JOIN bench_session bs ON bs.id=c.session_id WHERE c.started_at >= '2026-09-24T05:00:00Z' AND c.upload_state='verified' ORDER BY c.started_at"],
                   cwd=ETA, capture_output=True, text=True, timeout=300)
if r.returncode: raise SystemExit(f"neon-select rc={r.returncode}")
allc = json.loads(r.stdout); new_ids = {c["id"] for c in allc if c["id"] not in inv_ids}
by = {}
for c in allc: by.setdefault((c["d"], c["room_id"]), []).append(c)   # FULL tape of the room-day (inventory + new): a window that straddles the inventory cut needs both
by = {k: v for k, v in by.items() if any(c["id"] in new_ids for c in v)}
now = datetime.now(timezone.utc); jobs, wins = [], []
for (d, room), cs in sorted(by.items()):
    prim = [(p(c["started_at"]), p(c["ended_at"])) for c in cs if c["source"] == "primary"]
    keep = []
    for c in cs:
        s, e = p(c["started_at"]), p(c["ended_at"])
        if c["source"] == "backup" and sum(max(0, (min(e, y) - max(s, x)).total_seconds()) for x, y in prim) > 0.5 * (e - s).total_seconds(): continue
        keep.append(c)
    keep.sort(key=lambda c: c["started_at"])
    jid = f"c-{d}_{room}"
    jobs.append({"job_id": jid, "day": d, "room_id": room, "tier": "C", "n_chunks": len(keep), "n_backup_dropped": len(cs) - len(keep), "tape_hours": round(sum(int(c["duration_ms"] or 0) for c in keep) / 3.6e6, 2),
                 "state": "queued", "chunks": [{x: c[x] for x in ("id", "session_id", "idx", "r2_key", "started_at", "ended_at", "duration_ms", "size_bytes", "source")} for c in keep]})
    # windows must see the FULL tape of their span (a straddling window also has chunks that are in the inventory), so read those from the inventory too
    cs_all = [(p(c["started_at"]), p(c["ended_at"]), c) for c in keep]
    news = [x for x, _, c in cs_all if c["id"] in new_ids]
    if not news: continue   # the room-day's only new chunks were dropped backups (refuter-2 #2264 item 5): nothing to plan, do not raise
    first_new = min(news); t0 = first_new; t = t0.astimezone(IST).replace(minute=t0.astimezone(IST).minute // 15 * 15, second=0, microsecond=0).astimezone(timezone.utc)
    end = max(y for _, y, _ in cs_all)
    while t < end:
        if t + W <= now - timedelta(minutes=a.settle):
            ov = [c for x, y, c in cs_all if x < t + W and y > t]
            if ov and any(c["id"] in new_ids for c in ov):
                ts = t.astimezone(IST)
                wins.append({"win_id": f"c-{d}_{room}_{ts.strftime('%H%M')}", "job_id": jid, "day": d, "room_id": room, "start": t.isoformat(), "end": (t + W).isoformat(),
                             "chunk_ids": [c["id"] for c in ov], "tape_s": round(sum((min(y, t + W) - max(x, t)).total_seconds() for x, y, _ in cs_all if x < t + W and y > t)), "state": "queued"})
        t += W
# refuter-2 #2264 item 4: a chunk that uploads AFTER its window was planned and done would be added to the same win_id, but the runner skips a done window. Remember each window's chunk set at first sight; a done window whose set later grew is listed in tierC_grown.json (re-run = a follow-up decision, not silent).
SEEN = f"{HD}/tierC_seen.json"; seen = json.load(open(SEEN)) if os.path.exists(SEEN) else {}
for w in wins: seen.setdefault(w["win_id"], sorted(w["chunk_ids"]))
last = {}
for l in open(f"{HD}/state.jsonl"):
    r = json.loads(l)
    if r["win"].startswith("c-"): last[r["win"]] = r["state"]
grown = [w["win_id"] for w in wins if last.get(w["win_id"]) == "done" and sorted(w["chunk_ids"]) != seen[w["win_id"]]]
for name, obj in ((os.path.basename(SEEN), seen), ("tierC_grown.json", grown)):
    tmp = f"{HD}/{name}.tmp"; json.dump(obj, open(tmp, "w")); os.chmod(tmp, 0o600); os.replace(tmp, f"{HD}/{name}")
if grown: print("WARNING: done windows whose chunk set grew after planning:", len(grown), "(tierC_grown.json)")
wins.sort(key=lambda w: w["start"], reverse=True)   # newest first
for name, obj in (("manifest_tierC.json", {"stt_stack": "route (Whisper+IndicConformer+SraVaani) twin; r370 item 5", "jobs": jobs}), ("windows_tierC.json", wins)):
    f = f"{HD}/{name}"; tmp = f + ".tmp"; json.dump(obj, open(tmp, "w")); os.chmod(tmp, 0o600); os.replace(tmp, f)
print(f"tier C: {len(jobs)} room-days, {sum(j['n_chunks'] for j in jobs)} chunks, {sum(j['tape_hours'] for j in jobs):.1f} h; {len(wins)} windows planned, {sum(w['tape_s'] for w in wins) / 3600:.1f} tape-h; "
      f"{sum(1 for w in wins if w['tape_s'] < 60)} with <60 s tape; newest window start {wins[0]['start'] if wins else '-'}")
