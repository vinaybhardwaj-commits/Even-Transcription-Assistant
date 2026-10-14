#!/usr/bin/env python3
"""tape_pull.py — ruling 370 item 4(b)/(c) (lab-mover): pull room tape chunks from R2 to the box, hourly, read-only on the sources.
Sources: chunk rows from Neon (read-only kit/neon-select.mjs) and objects from R2 through the READ-ONLY audio key (never printed).
Destination: ~/eta-data/tapes/<room_id>/<IST day>/<startedAtUTC>_i<idx>_<id8>.<ext> (dirs 0700, files 0600; patient audio: box only, never git).
Rules: never overwrite; download to a temp name then rename; size must equal the DB size_bytes (else recorded as mismatch, kept out); sha256 recorded in
~/eta-data/tapes/manifest.jsonl (append only). Only upload_state='verified' chunks are pulled; other states are counted in the report.
Usage: tape_pull.py [--since 2026-09-24T18:30:00Z] [--report]   (--report prints audio-hours per room, numbers only)"""
import argparse, fcntl, hashlib, json, os, subprocess, sys, time, datetime
import boto3
ROOT = os.path.expanduser("~/eta-data/tapes"); ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant")
NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")

def neon(q):
    r = subprocess.run(["node", NEON, q], cwd=ETA, capture_output=True, text=True, timeout=300)
    if r.returncode: raise SystemExit(f"neon-select rc={r.returncode}")
    return json.loads(r.stdout)

def r2():
    L = [l.strip() for l in open(os.path.expanduser("~/.claude/secrets/r2_audio_read")) if l.strip()]
    return boto3.client("s3", aws_access_key_id=L[0], aws_secret_access_key=L[1], endpoint_url=L[2], region_name="auto")

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--since", default="2026-09-24T18:30:00Z"); ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    os.makedirs(ROOT, 0o700, exist_ok=True); os.chmod(ROOT, 0o700)
    lock = open(ROOT + "/.lock", "w")
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError: print("another pull is running"); return
    rows = neon("SELECT c.id, c.session_id, bs.room_id, c.idx, c.r2_key, c.started_at, c.duration_ms, c.size_bytes, c.source, c.upload_state, "
                "to_char(c.started_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') d FROM bench_chunk c JOIN bench_session bs ON bs.id=c.session_id "
                f"WHERE c.started_at >= '{a.since}' ORDER BY c.started_at")
    mf = ROOT + "/manifest.jsonl"; have = {}
    if os.path.exists(mf):
        for l in open(mf):
            try: j = json.loads(l); have[j["id"]] = j
            except Exception: pass
    s3 = None if a.report else r2()
    new = mism = miss = err = 0; per = {}
    for c in rows:
        p = per.setdefault(c["room_id"], {"chunks": 0, "hours": 0.0, "pulled": 0, "not_verified": 0, "missing_or_bad": 0})
        p["chunks"] += 1; p["hours"] += int(c["duration_ms"] or 0) / 3.6e6
        if c["upload_state"] != "verified": p["not_verified"] += 1; continue
        if c["id"] in have: p["pulled"] += 1; continue
        if a.report: continue
        ext = os.path.splitext(c["r2_key"])[1] or ".bin"
        ts = c["started_at"].replace(":", "").replace("-", "")[:15]
        d = f'{ROOT}/{c["room_id"]}/{c["d"]}'; os.makedirs(d, 0o700, exist_ok=True)
        dst = f'{d}/{ts}_i{c["idx"]}_{c["id"][:8]}{ext}'; tmp = dst + ".part"
        try:
            head = s3.head_object(Bucket="eta-audio", Key=c["r2_key"])
        except Exception as e:
            miss += 1; p["missing_or_bad"] += 1; print("MISSING in R2:", c["id"][:8], c["room_id"], type(e).__name__); continue
        if c["size_bytes"] and int(head["ContentLength"]) != int(c["size_bytes"]):
            mism += 1; p["missing_or_bad"] += 1; print("SIZE MISMATCH:", c["id"][:8], c["room_id"], head["ContentLength"], c["size_bytes"]); continue
        if os.path.exists(dst): 
            print("exists, not overwritten:", os.path.basename(dst)); continue
        try:
            s3.download_file("eta-audio", c["r2_key"], tmp)
            h = hashlib.sha256(open(tmp, "rb").read()).hexdigest(); os.chmod(tmp, 0o600); os.rename(tmp, dst)
        except Exception as e:
            err += 1; p["missing_or_bad"] += 1; print("DOWNLOAD FAILED:", c["id"][:8], type(e).__name__)
            try: os.remove(tmp)
            except OSError: pass
            continue
        rec = {"id": c["id"], "session_id": c["session_id"], "room_id": c["room_id"], "idx": c["idx"], "r2_key": c["r2_key"], "started_at": c["started_at"],
               "duration_ms": c["duration_ms"], "size_bytes": os.path.getsize(dst), "sha256": h, "source": c["source"], "path": os.path.relpath(dst, ROOT),
               "pulled_at": datetime.datetime.utcnow().isoformat() + "Z"}
        with open(mf, "a") as f: f.write(json.dumps(rec) + "\n")
        os.chmod(mf, 0o600); have[c["id"]] = rec; p["pulled"] += 1; new += 1
    tot_h = sum(v["hours"] for v in per.values())
    print(time.strftime("%F %T"), f"chunks_in_db={len(rows)} new_pulled={new} missing_in_r2={miss} size_mismatch={mism} download_errors={err} audio_hours_db={tot_h:.2f}")
    for r, v in sorted(per.items()):
        print(f"  {r}: chunks {v['chunks']} audio-h {v['hours']:.2f} pulled {v['pulled']} not_verified {v['not_verified']} missing/bad {v['missing_or_bad']}")

if __name__ == "__main__":
    main()
