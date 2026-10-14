#!/usr/bin/env python3
"""LISTEN-E3-CARDIOLOGY step 2. Diarize the 10 chosen windows on the Mini's eta-diarize, AFTER
night-drain has finished (checked by the caller, not this script — see check_drain_idle()).
~57s/window, ~10 min total. Writes out/diarize/<window_id>.json (raw diarize output)."""
import http.client
import json
import os
import subprocess
import sys
import time
import uuid

import audio_source

OUT = os.path.expanduser("~/dev/_fable/e3kit/out")
DIARIZE_DIR = os.path.join(OUT, "diarize")
PRESSURE = "/Users/vinaybhardwaj/dev/mini-pressure.jsonl"
DRAIN_RE_PID_CHECK = "^node /Users/vinaybhardwaj/night-drain/night-drain\\.mjs"
os.makedirs(DIARIZE_DIR, exist_ok=True)

WINDOWS = [
    ("bs_maaacrdh", 1790053200000, 1790054100000),
    ("bs_maaacrdh", 1790065800000, 1790066700000),
    ("bs_bxa23x5h", 1789968600000, 1789969500000),
    ("bs_gf2zntnq", 1789979400000, 1789980300000),
    ("bs_3phqhcre", 1789795800000, 1789796700000),
    ("bs_3phqhcre", 1789806600000, 1789807500000),
    ("bs_qjmagw6k", 1789452000000, 1789452900000),
    ("bs_qjmagw6k", 1789461000000, 1789461900000),
    ("bs_gkzmch9p", 1789191000000, 1789191900000),
    ("bs_gkzmch9p", 1789201800000, 1789202700000),
]


def window_id(session_id, start_ms):
    suffix = session_id.split("_", 1)[1]
    return "bw_%s_%d_primary" % (suffix, start_ms)


NIGHT_DRAIN_LOG = os.path.expanduser("~/night-drain/night-drain.log")
QUIET_S = 240  # night-drain idles rather than exiting after night_end, so it always matches
              # `pgrep`; the real signal the order asks for is "the log has stopped growing"


def check_drain_idle():
    """True if night-drain's log has not grown in the last QUIET_S seconds. Confirmed by hand
    before the first real run (night_end fired, 1688 lines held stable for 7+ min); this is the
    same test, so later re-checks (between windows) agree with that manual confirmation."""
    try:
        mtime = os.path.getmtime(NIGHT_DRAIN_LOG)
    except OSError:
        return True
    return (time.time() - mtime) > QUIET_S


def watchdog_ok():
    try:
        with open(PRESSURE) as f:
            f.seek(0, 2); n = f.tell(); f.seek(max(0, n - 2000))
            last = [l for l in f.read().splitlines() if l.strip()][-1]
        d = json.loads(last)
        return (not str(d["verdict"]).startswith("STOP_")) and isinstance(d.get("diarize_ms"), (int, float)) and d["diarize_ms"] < 400, d
    except Exception as e:
        return False, str(e)


def diarize_call(wav_path, encounter_id):
    audio = open(wav_path, "rb").read()
    b = "----lst" + uuid.uuid4().hex
    body = b"".join([('--%s\r\nContent-Disposition: form-data; name="encounter_id"\r\n\r\n%s\r\n' % (b, encounter_id)).encode(),
                      ('--%s\r\nContent-Disposition: form-data; name="clinician_centroids"\r\n\r\n[]\r\n' % b).encode(),
                      ('--%s\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n' % b).encode(),
                      audio, ("\r\n--%s--\r\n" % b).encode()])
    c = http.client.HTTPConnection("127.0.0.1", 8001, timeout=300)
    t0 = time.time()
    c.request("POST", "/diarize", body=body, headers={"Content-Type": "multipart/form-data; boundary=" + b, "Content-Length": str(len(body))})
    r = c.getresponse(); raw = r.read(); dt = time.time() - t0
    c.close()
    return dt, r.status, raw


def main():
    if not check_drain_idle():
        print("REFUSING: night-drain is still running. Not touching the Mini's diarize.")
        return 1
    for sid, ws, we in WINDOWS:
        wid = window_id(sid, ws)
        out_path = os.path.join(DIARIZE_DIR, "%s.json" % wid)
        if os.path.exists(out_path):
            print("skip (already have)", wid)
            continue
        if not check_drain_idle():
            print("ABORTING mid-run: night-drain started again."); return 1
        ok, why = watchdog_ok()
        if not ok:
            print("REFUSING on", wid, ":", why); return 1
        wav = "/tmp/e3listen_%s.wav" % wid
        audio_source.extract_clip(sid, ws, we, wav, fmt="wav", sr=16000)
        dt, status, raw = diarize_call(wav, "listen-e3-%s" % wid)
        os.remove(wav)
        if status != 200:
            print("FAILED", wid, status, raw[:200]); continue
        j = json.loads(raw)
        json.dump(j, open(out_path, "w"))
        print(wid, "wall=%.1fs speakers=%d segments=%d" % (dt, len(j.get("speakers") or []), len(j.get("transcript_segments") or [])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
