#!/usr/bin/env python3
"""vj-link: download the 15-min production window clips of the pilot room-days from R2 (READ key, never printed) -> 16 kHz mono wav in ~/eta-data/voice-linkage/pilot/audio (0700/0600).
Same method as studies/2026-09-24-voice-jev/data/fetch_audio.py. Run with ~/.venv-r2/bin/python. Only windows with a clip_r2_key (a diarizer row) exist in R2 as production clips.
Usage: fetch_pilot.py rd_id [rd_id ...]     Prints ids/counts only."""
import json, os, subprocess, sys, tempfile, concurrent.futures as cf
PD = os.path.expanduser("~/eta-data/voice-linkage/pilot"); OUT = f"{PD}/audio"
KEY = os.path.expanduser("~/.claude/secrets/r2_audio_read")
os.makedirs(OUT, exist_ok=True); os.chmod(OUT, 0o700)
lines = [l.strip() for l in open(KEY).read().splitlines() if l.strip()]
import boto3
from botocore.config import Config
ep = lines[2] if lines[2].startswith("http") else "https://" + lines[2]
s3 = boto3.client("s3", endpoint_url=ep, aws_access_key_id=lines[0], aws_secret_access_key=lines[1], region_name="auto", config=Config(retries={"max_attempts": 4}))
del lines
want = {}
for rd in sys.argv[1:]:
    for w in json.load(open(f"{PD}/turns-{rd}.json"))["windows"]:
        if w.get("clip_r2_key"): want[w["window_id"]] = w["clip_r2_key"]

def one(item):
    w, k = item; dst = f"{OUT}/{w}.wav"
    if os.path.exists(dst) and os.path.getsize(dst) > 1000: return 1
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".webm", dir=OUT, delete=False) as t: tmp = t.name
        s3.download_file("eta-audio", k, tmp)
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", tmp, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst], check=True)
        os.chmod(dst, 0o600); return 1
    except Exception as e:
        print("FAIL", w, type(e).__name__, str(e)[:60], flush=True); return 0
    finally:
        if tmp and os.path.exists(tmp): os.remove(tmp)

with cf.ThreadPoolExecutor(6) as ex: r = list(ex.map(one, sorted(want.items())))
print("FETCH_DONE wanted", len(want), "ok", sum(r), "fail", len(r) - sum(r))
