#!/usr/bin/env python3
"""Ruling 184 / lab-viewer #764: stage my parity raw twin outputs (patient text, from ~/vad/work/stt-parity/rawsync, copied off the hist-gpu nodes) into the vault layout
under ~/eta-data/lab-vault/staged/runs/stt-parity-backfill-20260924/<room>/<ist_date>/<id>.json. Backfill: provenance_complete=false. Write-once (O_EXCL); never overwrites.
Each file = {schema, provenance{...what I know}, context{set/node/run info}, payload{the router job result as returned}}. The secret never leaves the box; vault-push.py uploads."""
import json, os, re, time, hashlib, glob
from datetime import datetime, timezone, timedelta
W = os.path.expanduser("~/vad/work/stt-parity"); OUT = os.path.expanduser("~/eta-data/lab-vault/staged/runs/stt-parity-backfill-20260924")
IST = timezone(timedelta(hours=5, minutes=30))
rows = {}
for f in glob.glob(f"{W}/data/*.json"):
    if f.endswith("sha.json"): continue
    setname = "set2" if os.path.basename(f).startswith("v2_") else "set1"
    for r in json.load(open(f)):
        k = re.sub(r"\W", "_", r["id"])
        if k in rows and setname not in rows[k][0].split("-"): rows[k] = (rows[k][0] + "-" + setname, r)  # one production row (j9ijj8) is in both sets: its row was rewritten between the two pulls
        elif k not in rows: rows[k] = (setname, r)
sv = json.load(open(os.path.expanduser("~/eta-data/hist/stack_versions.json")))
sv_sha = hashlib.sha256(open(os.path.expanduser("~/eta-data/hist/stack_versions.json"), "rb").read()).hexdigest()
WORKDESC = {"work": "hist-gpu node local router 8083 (its own local CPU indic/SraVaani backends, default ORT threads); sets 1/2 first runs, plus exploratory repeat runs that overwrote the scored file for 3 windows (harness before the no-overwrite fix)",
            "work2": "router 8283 on the hist-gpu node with the paired hist-cpu node's stack-0 backends (ruling 117 short parity)",
            "work3": "router 8283 with the hist-cpu node stack-0 backends; random 10x3 twin-vs-twin test (eta-refuter-2 decisive test)"}
n = skipped = 0; os.makedirs(OUT, exist_ok=True)
for path in sorted(glob.glob(f"{W}/rawsync/*/*/*.json")):
    parts = path.split("/"); node, work, fn = parts[-3], parts[-2], parts[-1]
    m = re.match(r"(tr_[A-Za-z0-9]+)\.webm\.(?:a(\d+)\.)?run(\d+)\.json$", fn)
    if not m or m.group(1) not in rows: skipped += 1; continue
    tid, att, run = m.group(1), m.group(2) or "0", m.group(3)
    setname, r = rows[tid]; mj = r["mj"]; key = mj["clip_r2_key"]
    room = key.split("/")[1]; ist_date = datetime.fromtimestamp(mj["window"]["start_ms"] / 1000, IST).strftime("%Y-%m-%d")
    payload = json.load(open(path)); mt = datetime.fromtimestamp(os.path.getmtime(path), IST).strftime("%Y-%m-%dT%H:%M:%S+05:30")
    rec = {"schema": "eta-lab-result/1",
           "provenance": {"run_id": "stt-parity-backfill-20260924", "producer": "stt-parity", "created_at": mt, "provenance_complete": False, "not_run": ["diarizer"],
                          "stack": sv["stack"], "guards": sv["guards"], "diarizer": None, "stack_versions_sha256": sv_sha, "source_audio_keys": [key],
                          "notes": {"gaps": ["stack block is TODAY's HIST stack_versions; parity runs used the same files but the ORT thread cap was not applied at the time (added 16:45 IST) and node/router differ per context.workdir",
                                             "created_at is the file mtime on the node, not the moment the job ran"]}},
           "context": {"parity_set": setname, "node": node, "workdir": work, "workdir_description": WORKDESC[work], "run": int(run), "attempt": int(att),
                       "stored_production_row": r["id"], "stored_group": r.get("g"), "stored_dominant_language": r.get("dl"), "clip_sha256_verified_against_stored_audio_sha256": True,
                       "note": "MINING/PARITY ONLY; the stored production text is NOT included here (it lives in production transcription_run)"},
           "payload": payload}
    d = f"{OUT}/{room}/{ist_date}"; os.makedirs(d, exist_ok=True)
    name = f"{tid}.{setname}.{node[-1]}{work[-1] if work!='work' else ''}.run{run}" + (f".a{att}" if att != "0" else "") + ".json"
    try:
        fd = os.open(f"{d}/{name}", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with open(fd, "w") as f: json.dump(rec, f)
        n += 1
    except FileExistsError:
        skipped += 1
print("staged", n, "skipped", skipped, "->", OUT)
