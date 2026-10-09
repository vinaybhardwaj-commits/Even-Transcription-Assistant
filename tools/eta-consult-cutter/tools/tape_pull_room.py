#!/usr/bin/env python3
"""vp-consult-01: pull ONLY the chunks of one room in one time window from R2 to the box mirror, exactly like studies/2026-09-25-tape-pull/tape_pull.py (read-only Neon via kit/neon-select.mjs,
read-only R2 key, verified chunks only, size must equal the DB size, never overwrite, temp name then rename, append to ~/eta-data/tapes/manifest.jsonl, same lock). Differences: a room_id and an
[from, to] started_at filter in the query. Patient audio: box only (dirs 0700, files 0600).
Usage: tape_pull_room.py --room room_EXAMPLE --from 2026-10-07T04:00:00Z --to 2026-10-07T04:45:00Z"""
import argparse, fcntl, hashlib, json, os, sys, time, datetime
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-25-tape-pull"))
import tape_pull as tp
ROOT = tp.ROOT

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--room", required=True); ap.add_argument("--from", dest="t0", required=True); ap.add_argument("--to", dest="t1", required=True); a = ap.parse_args()
    assert a.room.replace("_", "").isalnum() and ":" in a.t0 and ":" in a.t1
    lock = open(ROOT + "/.lock", "w")
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError: sys.exit("another pull is running")
    rows = tp.neon("SELECT c.id, c.session_id, bs.room_id, c.idx, c.r2_key, c.started_at, c.duration_ms, c.size_bytes, c.source, c.upload_state, "
                   "to_char(c.started_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') d FROM bench_chunk c JOIN bench_session bs ON bs.id=c.session_id "
                   f"WHERE bs.room_id = '{a.room}' AND c.started_at >= '{a.t0}' AND c.started_at <= '{a.t1}' ORDER BY c.started_at")
    mf = ROOT + "/manifest.jsonl"; have = {}
    for l in open(mf):
        try: j = json.loads(l); have[j["id"]] = j
        except Exception: pass
    s3 = tp.r2(); new = skipped = bad = 0
    for c in rows:
        if c["upload_state"] != "verified": skipped += 1; continue
        if c["id"] in have: continue
        ext = os.path.splitext(c["r2_key"])[1] or ".bin"; ts = c["started_at"].replace(":", "").replace("-", "")[:15]
        d = f'{ROOT}/{c["room_id"]}/{c["d"]}'; os.makedirs(d, 0o700, exist_ok=True); dst = f'{d}/{ts}_i{c["idx"]}_{c["id"][:8]}{ext}'; tmp = dst + ".part"
        head = s3.head_object(Bucket="eta-audio", Key=c["r2_key"])
        if c["size_bytes"] and int(head["ContentLength"]) != int(c["size_bytes"]): bad += 1; print("SIZE MISMATCH", c["id"][:8]); continue
        if os.path.exists(dst): print("exists, not overwritten:", os.path.basename(dst)); continue
        s3.download_file("eta-audio", c["r2_key"], tmp); h = hashlib.sha256(open(tmp, "rb").read()).hexdigest(); os.chmod(tmp, 0o600); os.rename(tmp, dst)
        rec = {"id": c["id"], "session_id": c["session_id"], "room_id": c["room_id"], "idx": c["idx"], "r2_key": c["r2_key"], "started_at": c["started_at"], "duration_ms": c["duration_ms"],
               "size_bytes": os.path.getsize(dst), "sha256": h, "source": c["source"], "path": os.path.relpath(dst, ROOT), "pulled_at": datetime.datetime.utcnow().isoformat() + "Z"}
        with open(mf, "a") as f: f.write(json.dumps(rec) + "\n")
        os.chmod(mf, 0o600); have[c["id"]] = rec; new += 1
    print(time.strftime("%F %T"), f"room={a.room} window={a.t0}..{a.t1} chunks_in_db={len(rows)} new_pulled={new} not_verified={skipped} bad={bad}")
    for c in rows: print("  ", c["started_at"], c["idx"], c["upload_state"], c["duration_ms"])

if __name__ == "__main__": main()
