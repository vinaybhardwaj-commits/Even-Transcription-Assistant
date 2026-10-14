#!/usr/bin/env python3
"""build_manifest.py — HIST-MINING stage 2: room-day job queue from inventory.json (no audio, no text; ids/keys/times only).
Dedupes backup chunks that overlap primary tape (>50% of their span). Tier A = room-days with NO prod-transcribed window (oldest first);
tier B = room-days with partial prod coverage (window-level skip list still to be aligned before they are queued). State per job: queued|running|done|failed.
Writes ~/eta-data/hist/manifest.json (0600). Never overwrites state of existing jobs."""
import json, os
from datetime import datetime
OUT = os.path.expanduser("~/eta-data/hist"); P = f"{OUT}/manifest.json"
p = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
old = {j["job_id"]: j for j in json.load(open(P))["jobs"]} if os.path.exists(P) else {}
jobs = []
for d in json.load(open(f"{OUT}/inventory.json")):
    prim = [(p(c["started_at"]), p(c["ended_at"])) for c in d["chunks"] if c["source"] == "primary"]
    keep = []
    for c in d["chunks"]:
        a, b = p(c["started_at"]), p(c["ended_at"])
        if c["source"] == "backup" and sum(max(0, (min(b, y) - max(a, x)).total_seconds()) for x, y in prim) > 0.5 * (b - a).total_seconds(): continue
        keep.append(c)
    keep.sort(key=lambda c: c["started_at"])
    jid = f"{d['day']}_{d['room_id']}"
    j = {"job_id": jid, "day": d["day"], "room_id": d["room_id"], "tier": "A" if not d["prod_transcribed"] else "B", "n_chunks": len(keep),
         "n_backup_dropped": len(d["chunks"]) - len(keep), "tape_hours": round(sum(int(c["duration_ms"] or 0) for c in keep) / 3.6e6, 2),
         "prod_windows": d["prod_windows"], "state": "queued", "chunks": keep}
    if jid in old: j["state"] = old[jid]["state"]
    jobs.append(j)
jobs.sort(key=lambda j: (j["tier"], j["day"], j["room_id"]))
json.dump({"stt_stack": "route (Whisper+IndicConformer+SraVaani) via lib/stt — HELD until parity PASS", "jobs": jobs}, open(P, "w")); os.chmod(P, 0o600)
for t in "AB":
    js = [j for j in jobs if j["tier"] == t]
    print(f"tier {t}: {len(js)} room-days, {sum(j['n_chunks'] for j in js)} chunks, {sum(j['tape_hours'] for j in js):.1f} h, {js[0]['day'] if js else '-'}..{js[-1]['day'] if js else '-'}")
print("backup chunks dropped:", sum(j["n_backup_dropped"] for j in jobs))
