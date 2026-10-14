#!/usr/bin/env python3
"""W45.3 real-data pilot (Fable 13:22: pilot on 24 Sep via room_diarize_window.segments_json, switch to 26 Sep
once hist-bulk reaches it). PATIENT AUDIO: downloads one window's R2 clip read-only, cuts per-turn wavs to a
local tmp dir, deletes the window clip immediately after. Run only via tone/run_real.sh (Fable's 13:00 permission).

Turn = consecutive room_diarize_window.segments_json micro-segments from the SAME speaker_idx, merged when the
gap between them is <= GAP_MS, split if the merged span would exceed turn_translate.MAX_S (31 s) - a real turn
this long is rare but not impossible, and a silent truncation would be worse than a second, shorter turn.
Role comes from room_turn_speaker joined on (window_id, speaker_idx, run_id=last_run_id) - the exact join
TONE-DESIGN.md specifies for acoustic emotion; text sentiment reuses it for role, not a new join.

Runs under the R2 read venv (~/.venv-r2, boto3) for the download step; ffmpeg (system) for the cuts.

Usage: python3 extract_turns.py --window WINDOW_ID --out DIR   -> DIR/manifest.jsonl + DIR/*.wav (0600),
       ready for turn_translate.py turns --manifest DIR/manifest.jsonl --out ...
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.normpath(os.path.join(HERE, "..", ".."))  # the eta-lab worktree root (kit/neon-select.mjs lives here)
NEON = os.path.join(LAB, "kit", "neon-select.mjs")
NODE_PATH = "/home/eta/eta-ci/nm-cache/10309957e8b2a3686437d386493f4960e0b76381ecb4aa5fb3950a04ead3fc94/node_modules"
R2_KEY = os.path.expanduser("~/.claude/secrets/r2_audio_read")
BUCKET = "eta-audio"
GAP_MS = 1500       # merge same-speaker micro-segments closer together than this into one turn
MIN_TURN_MS = 800   # drop turns shorter than this (VAD blips, not real speech)
MAX_TURN_S = 30.0   # split a merged turn before it would exceed turn_translate.MAX_S (31s), with margin


def neon(sql):
    env = dict(os.environ, NODE_PATH=NODE_PATH)
    p = subprocess.run(["node", NEON, sql], cwd=LAB, env=env, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-2000:])
    return json.loads(p.stdout)


def window_info(window_id):
    rows = neon("""
        SELECT dw.clip_r2_key, dw.segments_json, dw.last_run_id
        FROM room_diarize_window dw WHERE dw.window_id = '%s' AND dw.state = 'ok'
    """ % window_id)
    if not rows:
        raise SystemExit("no diarize-ok row for " + window_id)
    return rows[0]


def role_map(window_id, run_id):
    rows = neon("""
        SELECT speaker_idx, role, match_confidence, no_role_reason
        FROM room_turn_speaker WHERE window_id = '%s' AND run_id = '%s'
    """ % (window_id, run_id))
    return {r["speaker_idx"]: r for r in rows}


def merge_turns(segments):
    """segments: [{start_ms, end_ms, speaker_idx}], as stored (not necessarily time-sorted per speaker overall,
    but sorted by start_ms across all speakers - room_diarize_window's own convention). -> list of merged turns."""
    segs = sorted(segments, key=lambda s: s["start_ms"])
    turns = []
    cur = None
    for s in segs:
        if cur and cur["speaker_idx"] == s["speaker_idx"] and s["start_ms"] - cur["end_ms"] <= GAP_MS and \
                (s["end_ms"] - cur["start_ms"]) <= MAX_TURN_S * 1000:
            cur["end_ms"] = max(cur["end_ms"], s["end_ms"])
        else:
            if cur:
                turns.append(cur)
            cur = dict(speaker_idx=s["speaker_idx"], start_ms=s["start_ms"], end_ms=s["end_ms"])
    if cur:
        turns.append(cur)
    return [t for t in turns if t["end_ms"] - t["start_ms"] >= MIN_TURN_MS]


def r2_client():
    lines = [l.strip() for l in open(R2_KEY).read().splitlines() if l.strip()]
    import boto3
    from botocore.config import Config
    ep = lines[2] if lines[2].startswith("http") else "https://" + lines[2]
    return boto3.client("s3", endpoint_url=ep, aws_access_key_id=lines[0], aws_secret_access_key=lines[1],
                         region_name="auto", config=Config(retries={"max_attempts": 4}))


def download_clip(s3, r2_key, dst):
    s3.download_file(BUCKET, r2_key, dst)
    os.chmod(dst, 0o600)


def cut_turn(src_webm, start_ms, end_ms, dst_wav, pad_ms=150):
    s = max(0.0, (start_ms - pad_ms) / 1000.0)
    dur = (end_ms - start_ms + 2 * pad_ms) / 1000.0
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "%.3f" % s, "-i", src_webm, "-t", "%.3f" % dur,
                     "-ac", "1", "-ar", "16000", dst_wav], check=True)
    os.chmod(dst_wav, 0o600)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--window", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)

    info = window_info(a.window)
    roles = role_map(a.window, info["last_run_id"])
    turns = merge_turns(info["segments_json"])

    os.makedirs(a.out, mode=0o700, exist_ok=True)
    webm = os.path.join(a.out, "_window.webm")
    s3 = r2_client()
    try:
        download_clip(s3, info["clip_r2_key"], webm)
        rows = []
        for i, t in enumerate(turns):
            role_row = roles.get(t["speaker_idx"])
            wav = os.path.join(a.out, "turn-%03d.wav" % i)
            cut_turn(webm, t["start_ms"], t["end_ms"], wav)
            rows.append(dict(id="%s/turn-%03d" % (a.window, i), audio=wav, window_id=a.window,
                              speaker_idx=t["speaker_idx"], role=(role_row or {}).get("role"),
                              no_role_reason=(role_row or {}).get("no_role_reason"),
                              match_confidence=(role_row or {}).get("match_confidence"),
                              start_ms=t["start_ms"], end_ms=t["end_ms"]))
        man = os.path.join(a.out, "manifest.jsonl")
        with open(man, "w") as f:
            os.chmod(man, 0o600)
            for r in rows:
                f.write(json.dumps(r) + "\n")
        print(json.dumps(dict(window=a.window, turns=len(rows),
                               roled=sum(1 for r in rows if r["role"]),
                               unattributed=sum(1 for r in rows if not r["role"]))))
    finally:
        if os.path.exists(webm):
            os.remove(webm)   # the window clip is not kept - only the per-turn cuts remain, and only until translated


if __name__ == "__main__":
    main()
