#!/usr/bin/env python3
"""Runs ON the HF Job (hf-fleet's L4x1 image, RULINGS 13:52 flavour), against real room audio
hf-fleet/reb have already staged there for the REB backfill — this script never uploads or fetches
audio itself. For every window in <manifest>, loads each turn's clip from <audio_dir>/<window_id>.wav
(or .flac), scores it with the wavlm crosslingual model (kit/reb_runner/engines/emotion_wavlm.py, same
model id as the box :8086 Mini service), and appends one {"window_id", "track"} line to <out.jsonl> —
a complete REB track BODY, not yet written anywhere (per kit/reb_runner/DESIGN.md: only box-side code
calls write_track(); this process just computes and hands back a result). Resumable: windows already
in <out.jsonl> are skipped, same convention as hf_consume.py (studies/2026-09-25-speaker-labels/hf).

    python3 hf_emotion_job.py windows_turns_26sep.json /data/in out.jsonl

<manifest> is hf_emotion_manifest.py's output. <audio_dir> is wherever hf-fleet's uploader staged this
date's window audio (bucket-mounted inbox, matching the REB backfill's own audio layout — coordinate
the exact path/extension with hf-fleet before running; this script does not assume one on its own,
see --ext/--audio-dir).
"""
import argparse
import glob
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reb_runner.engines import emotion_wavlm


def _find_audio(audio_dir, window_id, ext):
    for e in ([ext] if ext else ["wav", "flac"]):
        matches = glob.glob(os.path.join(audio_dir, "**", f"{window_id}.{e}"), recursive=True)
        if matches:
            return matches[0]
    return None


def _done_ids(out_path):
    done = set()
    if os.path.exists(out_path):
        with open(out_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    done.add(json.loads(line)["window_id"])
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("audio_dir")
    ap.add_argument("out")
    ap.add_argument("--ext", default=None, help="audio extension (default: try wav then flac)")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    windows = json.load(open(args.manifest))
    if args.limit:
        windows = windows[: args.limit]
    done = _done_ids(args.out)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    model = emotion_wavlm.load_model()
    t0 = time.time()
    n = ok = missing = 0
    for w in windows:
        window_id = w["window_id"]
        if window_id in done:
            continue
        wav_path = _find_audio(args.audio_dir, window_id, args.ext)
        if wav_path is None:
            missing += 1
            print(f"[hf-emotion-job] MISSING audio for {window_id}", flush=True)
            continue
        diar_segments = [{"t0_ms": t0_ms, "t1_ms": t1_ms, "speaker": sp} for t0_ms, t1_ms, sp in w["turns"]] or None
        track = emotion_wavlm.build_track(
            window_id, wav_path, w["t0_ms"], w["t1_ms"], diar_segments=diar_segments, model=model,
        )
        with open(args.out, "a") as f:
            f.write(json.dumps({"window_id": window_id, "track": track}, ensure_ascii=False) + "\n")
        n += 1
        ok += 1 if track["status"] == "ok" else 0
        if n % 25 == 0:
            print(f"[hf-emotion-job] {n} windows ({ok} ok) in {time.time() - t0:.0f}s", flush=True)
    print(f"[hf-emotion-job] done: {n} windows ({ok} ok), {missing} missing audio, "
          f"{time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
