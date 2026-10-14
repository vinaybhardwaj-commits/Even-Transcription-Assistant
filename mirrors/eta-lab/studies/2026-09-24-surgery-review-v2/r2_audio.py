#!/usr/bin/env python3
"""r2_audio.py — SURGERY-REVIEW-V3 audio from the R2 READ key (live since 11:33; read-only, write-denied). Runs under ~/.venv-r2/bin/python (boto3).
For one selected consult: chunk rows from Neon bench_chunk (via bench_session.room_id = room_day.room_id, overlapping the span) -> download each 5-min WebM to audio-tmp (0600)
-> full_audio.assemble on the wall-clock timeline (silence for gaps) -> final/audio/Q##/full.mp3 (mono 16 kHz 32 kbps) and a cached WAV for evidence clips -> chunks DELETED.
The key file (line 1 id, 2 secret, 3 endpoint) is read here and handed to boto3; it is never printed, logged or put on a command line. Only ids, counts and seconds are printed.
  full <Q##>...          whole-consult MP3 (+ coverage report)      clips <Q##>...   evidence clips from final/consults/<Q##>.json evidence turns (each <=15 s, turn +-3 s)
"""
import json, os, subprocess, sys, tempfile, wave
from datetime import datetime, timedelta, timezone
import full_audio as fa

V3 = os.path.expanduser("~/eta-data/surgery-review-v3"); F = f"{V3}/{os.environ.get('V3_FINAL', 'final')}"; TMP = f"{F}/audio-tmp"; BUCKET = "eta-audio"
KEY = os.path.expanduser("~/.claude/secrets/r2_audio_read"); SEL = os.environ.get("V3_SEL", "selected.json")


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc)


def chunk_rows(room_day_id, lo, hi):
    import fetch_turns as ft
    if not ft.IDRE.match(room_day_id):
        raise SystemExit("unexpected id characters")
    rows = ft.neon(f"""SELECT c.session_id, c.idx, c.r2_key, c.started_at, c.ended_at, c.duration_ms, c.upload_state, c.source
        FROM bench_chunk c JOIN bench_session s ON s.id = c.session_id JOIN room_day rd ON rd.room_id = s.room_id
        WHERE rd.id = '{room_day_id}' AND c.ended_at > '{lo.isoformat()}' AND c.started_at < '{hi.isoformat()}' ORDER BY c.started_at""")
    for r in rows:
        r["idx"] = f"{r['session_id']}:{r['idx']}"  # idx is per session: make it unique across sessions
    return rows


def client():
    lines = [l.strip() for l in open(KEY).read().splitlines() if l.strip()]
    import boto3
    from botocore.config import Config
    ep = lines[2] if lines[2].startswith("http") else "https://" + lines[2]
    return boto3.client("s3", endpoint_url=ep, aws_access_key_id=lines[0], aws_secret_access_key=lines[1], region_name="auto", config=Config(retries={"max_attempts": 4}))


def write_wav(pcm, path):
    with wave.open(path, "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(fa.SR); f.writeframes(pcm)
    os.chmod(path, 0o600)


def full(q, s3=None):
    st = json.load(open(f"{F}/staging/{q}.json")); S = json.load(open(f"{V3}/{SEL}"))[q]
    lo, hi = iso(st["span"]["start_ms"]), iso(st["span"]["end_ms"])
    rows = chunk_rows(S["room_day_id"], lo, hi)
    sel, rep = fa.plan(rows, lo, hi)
    os.makedirs(TMP, exist_ok=True); os.chmod(TMP, 0o700)
    s3 = s3 or client(); files = {}
    try:
        for c in sel:
            p = f"{TMP}/{q}-{abs(hash(c['idx'])) % 10**8}.webm"
            s3.download_file(BUCKET, c["r2_key"], p); os.chmod(p, 0o600); files[c["idx"]] = p
        pcm = fa.assemble(sel, files, lo, hi)
    finally:
        for p in files.values():
            if os.path.exists(p):
                os.remove(p)
    os.makedirs(f"{F}/audio/{q}", exist_ok=True); os.chmod(f"{F}/audio/{q}", 0o700)
    mp3 = f"{F}/audio/{q}/full.mp3"; fa.encode_mp3(pcm, mp3); write_wav(pcm, f"{TMP}/{q}.wav")
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3], capture_output=True, text=True).stdout)
    rep.update({"id": q, "mp3_s": round(dur, 1), "mb": round(os.path.getsize(mp3) / 1e6, 1), "chunks": len(sel)})
    return rep


def clips(q):
    doc = json.load(open(f"{F}/consults/{q}.json")); pcm = open(f"{TMP}/{q}.wav", "rb").read()[44:]
    by = {t["i"]: t for t in doc["turns"]}; made = 0
    for i in sorted({i for k in doc["jev"].values() for i in k["evidence"]}):
        t = by[i]; s = max(0.0, t["start_s"] - fa.__dict__.get("PAD", 3.0)); e = min(len(pcm) / 2 / fa.SR, t["end_s"] + 3.0)
        e = min(e, s + 15.0)
        seg = pcm[int(s * fa.SR) * 2:int(e * fa.SR) * 2]
        p = f"{F}/audio/{q}/{i}.mp3"; fa.encode_mp3(seg, p); t["audio"] = [f"audio/{q}/{i}.mp3"]; made += 1
    json.dump(doc, open(f"{F}/consults/{q}.json", "w"), ensure_ascii=False, indent=1); os.chmod(f"{F}/consults/{q}.json", 0o600)
    return made


if __name__ == "__main__":
    cmd, ids = sys.argv[1], sys.argv[2:]
    s3 = client() if cmd == "full" else None
    for q in ids:
        print(q, full(q, s3) if cmd == "full" else {"clips": clips(q)})
