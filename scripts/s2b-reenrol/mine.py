#!/usr/bin/env python3
"""Mine a clinician's strongest room-audio segments and embed them through the SAME path /enroll uses.

    python3 mine.py --manifest manifest.json --out mined.json

manifest.json is a list of {clinician_id, day, audio, diarize_json, speaker_idx}. `audio` is the day
file the diarizer ran on; `diarize_json` is that run's /diarize response (only start_ms, end_ms,
speaker_idx, overlap are read from it; transcript text is never opened). Presence -- that speaker_idx
IS this clinician -- is the manifest's assertion, made by a person; this script does not decide it.

Each clip is cut with ffmpeg (mono, 16 kHz) and POSTed to ${EMBED_BASE:-http://127.0.0.1:8001}/enroll.
/enroll returns the raw un-normalised 192-dim vector as base64 little-endian float32 -- the bytes are
stored exactly as returned, never re-serialised here.

MINI DISCIPLINE: /enroll shares the diarizer's one heavy slot with the production drain. Before EVERY
ffmpeg cut and EVERY POST this waits on the watchdog (last line of MINI_PRESSURE) and proceeds only
on GO (verdict not STOP_*, diarize_ms < 400; free_pct ignored). There is no iteration cap on the
wait: it waits as long as it takes.

Reads no database, writes no database, prints ids and counts only.
"""
import argparse, json, os, subprocess, sys, tempfile, time, urllib.request, uuid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s2b_lib import select_segments, gate, decode_emb

MINI_PRESSURE = os.environ.get("MINI_PRESSURE", "/Users/vinaybhardwaj/dev/mini-pressure.jsonl")
EMBED_BASE = os.environ.get("EMBED_BASE", "http://127.0.0.1:8001").rstrip("/")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")


def last_line(path: str) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 4096))
            lines = f.read().decode("utf-8", "replace").strip().splitlines()
        return lines[-1] if lines else ""
    except OSError:
        return ""


def wait_for_go(log) -> None:
    """Block until the watchdog says GO. Unbounded by design. The gate is CALLED here, in the path
    of every heavy step, so it cannot be printed-and-ignored."""
    waited = 0
    while True:
        ok, why = gate(last_line(MINI_PRESSURE))
        if ok:
            if waited:
                log(f"gate: GO after {waited}s")
            return
        if waited % 60 == 0:
            log(f"gate: holding ({why})")
        time.sleep(15)
        waited += 15


def cut_clip(audio: str, clip: list[dict], out_wav: str) -> None:
    parts = [f"[0:a]atrim=start={s['start_ms']/1000:.3f}:end={s['end_ms']/1000:.3f},asetpts=PTS-STARTPTS[a{i}]"
             for i, s in enumerate(clip)]
    graph = ";".join(parts) + ";" + "".join(f"[a{i}]" for i in range(len(clip))) + \
        f"concat=n={len(clip)}:v=0:a=1,aresample=16000,pan=mono|c0=c0[out]"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", audio, "-filter_complex", graph, "-map", "[out]",
                    "-ac", "1", "-ar", "16000", out_wav], check=True)


def post_enroll(wav_path: str, clinician_id: str) -> dict:
    boundary = uuid.uuid4().hex
    with open(wav_path, "rb") as f:
        body = f.read()
    pre = (f'--{boundary}\r\nContent-Disposition: form-data; name="clinician_id"\r\n\r\n{clinician_id}\r\n'
           f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.wav"\r\n'
           f'Content-Type: audio/wav\r\n\r\n').encode()
    post = f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{EMBED_BASE}/enroll", data=pre + body + post, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--budget-ms", type=int, default=60_000)
    ap.add_argument("--clip-ms", type=int, default=20_000)
    a = ap.parse_args()
    log = lambda m: print(m, file=sys.stderr, flush=True)
    manifest = json.load(open(a.manifest))
    out = []
    for m in manifest:
        with open(m["diarize_json"]) as f:
            segs = json.load(f)["transcript_segments"]
        clips = select_segments(segs, m["speaker_idx"], budget_ms=a.budget_ms, clip_ms=a.clip_ms)
        rec = {"clinician_id": m["clinician_id"], "day": m["day"], "speaker_idx": m["speaker_idx"], "clips": []}
        for ci, clip in enumerate(clips):
            with tempfile.TemporaryDirectory() as td:
                wav = os.path.join(td, "clip.wav")
                wait_for_go(log)
                cut_clip(m["audio"], clip, wav)
                wait_for_go(log)
                res = post_enroll(wav, m["clinician_id"])
            if not res.get("ok"):
                log(f"{m['day']} clip {ci}: enroll error {res.get('error')}")
                continue
            decode_emb(res["embedding_base64"])  # shape check: 768 bytes or it raises
            rec["clips"].append({
                "n_segments": len(clip),
                "speech_ms": sum(s["end_ms"] - s["start_ms"] for s in clip),
                "embedding_base64": res["embedding_base64"],
            })
            log(f"{m['day']} clip {ci}: ok n_seg={len(clip)}")
        out.append(rec)
    json.dump(out, open(a.out, "w"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
