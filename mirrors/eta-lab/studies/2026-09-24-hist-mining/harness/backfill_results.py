#!/usr/bin/env python3
"""backfill_results.py — stage my PRE-provenance window records (~/eta-data/hist-mining/results/*.json, written before ruling 184) for the vault, run_id hist-miner-backfill-20260924 (lab-viewer #764).
Each file is staged UNCHANGED plus top-level schema + provenance (provenance_complete=false: these records were not written with provenance; what IS known is stated). room_id and ist_date come from the record (room_id, start);
source_audio_keys are RECONSTRUCTED from my chunk inventory (queue.json: that room's chunks overlapping [start, end]) and flagged as reconstructed; stack + guards are lab-mover's published stack_versions, valid for these windows because every stack unit's ActiveEnterTimestamp
(router 10:49 UTC, indic 11:11, sravaani 10:48, whisper 06:39/10:02) predates the first window (~12:00 UTC), i.e. no restart in between. Never overwrites a staged file. Out: ~/eta-data/lab-vault/staged/runs/hist-miner-backfill-20260924/<room_id>/<ist_date>/<window_id>.json (dir 0700, files 0600)."""
import glob, json, os, sys
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import provenance
HM = os.path.expanduser("~/eta-data/hist-mining"); ST = os.path.expanduser("~/eta-data/lab-vault/staged/runs/hist-miner-backfill-20260924")
IST = timezone(timedelta(hours=5, minutes=30)); iso = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
pub = provenance.published_stack_versions()
Q = json.load(open(f"{HM}/queue.json")); byprefix = {}
for q in Q: byprefix.setdefault(q["token_uid"][:8], []).append(q)
n_new = n_skip = n_bad = 0
for f in sorted(glob.glob(f"{HM}/results/*.json")):
    try: rec = json.load(open(f))
    except Exception: n_bad += 1; continue
    wid = rec.get("window_id") or os.path.basename(f)[:-5]; room = rec.get("room_id"); start = rec.get("start"); end = rec.get("end")
    if not (room and start and end and wid.replace("-", "").replace("_", "").isalnum()): n_bad += 1; continue
    day = iso(start).astimezone(IST).date().isoformat(); out = f"{ST}/{room}/{day}/{wid}.json"
    if os.path.exists(out): n_skip += 1; continue
    a, b = iso(start), iso(end); keys = []
    for q in byprefix.get(wid.split("-r")[0], []):
        for c in q["chunks"]:
            if c["room_id"] == room and iso(c["started_at"]) < b and iso(c["ended_at"]) > a and c["r2_key"] not in keys: keys.append(c["r2_key"])
    gaps = ["written before ruling 184: no provenance block was recorded at the time", "source_audio_keys RECONSTRUCTED from the chunk inventory (chunks of this room overlapping the window), not recorded by the writer"]
    prov = {"run_id": "hist-miner-backfill-20260924", "producer": "hist-miner", "created_at": datetime.fromtimestamp(os.path.getmtime(f), IST).isoformat(timespec="seconds"), "provenance_complete": False, "not_run": ["diarizer"], "diarizer": None,
            "source_audio_keys": keys, "source_audio_keys_reconstructed": True, "notes": {"gaps": gaps}}
    if pub:
        doc, sha, path = pub; prov.update({"stack": doc["stack"], "guards": doc["guards"], "stack_versions_sha256": sha, "stack_id": doc.get("stack_id")})
        prov["notes"]["stack"] = "lab-mover's published stack_versions applied: all stack units started before the first window, so no restart in between (ActiveEnterTimestamp checked)"
    body = dict(rec); body["schema"] = "eta-lab-result/1"; body["provenance"] = prov
    os.makedirs(os.path.dirname(out), mode=0o700, exist_ok=True)
    with open(out, "x") as h: json.dump(body, h, ensure_ascii=False)      # 'x': never overwrite
    os.chmod(out, 0o600); n_new += 1
print(f"staged {n_new} new | already staged {n_skip} | skipped (unusable record) {n_bad} | stack from published file: {bool(pub)}")
