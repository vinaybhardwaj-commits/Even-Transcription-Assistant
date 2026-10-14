#!/usr/bin/env python3
"""inventory.py — HIST-MINING stage 2 (hist-bulk): chunk inventory + room-day queue for the Aug-Sep bulk corpus.
Read-only Neon (kit/neon-select.mjs). No audio downloaded, nothing transcribed (STT-STACK-PARITY order 3).
Writes ids/keys/times/counts only (no text) to ~/eta-data/hist/inventory.json (0600); prints a summary."""
import json, os, subprocess, sys
from collections import defaultdict
NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs"); ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant")
OUT = os.path.expanduser("~/eta-data/hist")
SINCE = "2026-07-31T18:30:00Z"  # 1 Aug 00:00 IST

def neon(q):
    r = subprocess.run(["node", NEON, q], cwd=ETA, capture_output=True, text=True, timeout=300)
    if r.returncode: raise SystemExit(f"neon-select rc={r.returncode}")
    return json.loads(r.stdout)

chunks = neon(f"SELECT c.id, c.session_id, bs.room_id, c.idx, c.r2_key, c.started_at, c.ended_at, c.duration_ms, c.size_bytes, c.source, to_char(c.started_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') d FROM bench_chunk c JOIN bench_session bs ON bs.id=c.session_id WHERE c.started_at >= '{SINCE}' AND c.upload_state='verified' ORDER BY c.started_at")
wins = neon(f"SELECT w.id, w.session_id, w.state, w.start_ms, w.end_ms, rd.room_id, rd.ist_date::text d FROM bench_window w JOIN room_day rd ON rd.id=w.room_day_id WHERE w.created_at >= '{SINCE}'")
tape = defaultdict(lambda: {"chunks": [], "backup": 0})
for c in chunks:
    k = (c["room_id"], c["d"])
    if c["source"] == "backup": tape[k]["backup"] += 1
    tape[k]["chunks"].append({x: c[x] for x in ("id", "session_id", "idx", "r2_key", "started_at", "ended_at", "duration_ms", "size_bytes", "source")})
wstate = defaultdict(lambda: defaultdict(int))
for w in wins: wstate[(w["room_id"], w["d"])][w["state"]] += 1
days = []
for (room, d), t in sorted(tape.items(), key=lambda kv: (kv[0][1], kv[0][0])):
    ws = wstate.get((room, d), {})
    hrs = sum(int(c["duration_ms"] or 0) for c in t["chunks"]) / 3.6e6
    days.append({"room_id": room, "day": d, "n_chunks": len(t["chunks"]), "n_backup_chunks": t["backup"], "tape_hours": round(hrs, 2),
                 "gb": round(sum(int(c["size_bytes"] or 0) for c in t["chunks"]) / 1e9, 3), "prod_windows": dict(ws),
                 "prod_transcribed": ws.get("transcribed", 0), "chunks": t["chunks"]})
p = f"{OUT}/inventory.json"; json.dump(days, open(p, "w")); os.chmod(p, 0o600)
tot = lambda f: sum(x for x in map(f, days))
print("room-days:", len(days), "| chunks:", tot(lambda x: x["n_chunks"]), "| backup chunks:", tot(lambda x: x["n_backup_chunks"]), "| tape hours: %.1f" % tot(lambda x: x["tape_hours"]), "| GB: %.1f" % tot(lambda x: x["gb"]))
print("room-days with >=1 prod-transcribed window:", sum(1 for x in days if x["prod_transcribed"]), "| with none:", sum(1 for x in days if not x["prod_transcribed"]),
      "| hours in none: %.1f" % sum(x["tape_hours"] for x in days if not x["prod_transcribed"]))
