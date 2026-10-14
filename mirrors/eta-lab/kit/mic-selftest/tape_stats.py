"""tape_stats.py: per-second RMS and peak of recorded chunks, numbers only (ruling 369 item 1, Fable 10:30: nothing patient-identifying leaves the box beyond RMS/peak stats).

  python3 tape_stats.py TAPES_DIR [--since ISO] [--until ISO] [--room room_xxxxxxxx] > stats.jsonl

TAPES_DIR is lab-mover's hourly pull (box: ~/eta-data/tapes): manifest.jsonl + room_<id>/<date>/<chunk>.webm. Each chunk is decoded with ffmpeg to 16 kHz mono int16 (the tape's own
format), then reduced to one line of numbers: room_id, started_at, seconds, rms (list, one per full second), peak (list), exact_zero_seconds. No audio, no text, no file path.
CAVEAT the caller must keep in mind: these chunks are the uploaded, compressed copies (webm/opus), not tape.pcm. Compression can hide very quiet noise or add its own, so a
threshold calibrated here needs a spot check against a raw tape.pcm tail before it is trusted.
"""
import argparse, json, math, os, subprocess, sys

SR = 16000


def decode(path):
    """Raw s16le 16 kHz mono bytes of one chunk."""
    p = subprocess.run(["nice", "-n", "19", "ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ar", str(SR), "-ac", "1", "-"], capture_output=True, timeout=300)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg failed")
    return p.stdout


def per_second(pcm):
    """(rms list, peak list, exact-zero seconds) over the full seconds of pcm (full scale = 1.0)."""
    n = len(pcm) // 2
    vals = memoryview(pcm[: n * 2]).cast("h")
    rms, peak, zero = [], [], 0
    for i in range(0, n - SR + 1, SR):
        seg = vals[i:i + SR]
        s2 = 0
        pk = 0
        for v in seg:
            s2 += v * v
            a = -v if v < 0 else v
            if a > pk:
                pk = a
        rms.append(round(math.sqrt(s2 / SR) / 32768.0, 6))
        peak.append(round(pk / 32768.0, 5))
        if pk == 0:
            zero += 1
    return rms, peak, zero


def chunk_record(meta, pcm):
    rms, peak, zero = per_second(pcm)
    return dict(room_id=meta["room_id"], started_at=meta["started_at"], idx=meta.get("idx"), seconds=len(rms), rms=rms, peak=peak, exact_zero_seconds=zero)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("tapes_dir")
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--room")
    a = ap.parse_args(argv)
    with open(os.path.join(a.tapes_dir, "manifest.jsonl")) as f:
        metas = [json.loads(l) for l in f if l.strip()]
    for m in sorted(metas, key=lambda m: (m["room_id"], m["started_at"])):
        if a.room and m["room_id"] != a.room:
            continue
        if a.since and m["started_at"] < a.since:
            continue
        if a.until and m["started_at"] >= a.until:
            continue
        path = os.path.join(a.tapes_dir, m["path"])
        if not os.path.isfile(path):
            continue
        try:
            rec = chunk_record(m, decode(path))
        except (RuntimeError, subprocess.TimeoutExpired):
            rec = dict(room_id=m["room_id"], started_at=m["started_at"], idx=m.get("idx"), error="decode failed")
        print(json.dumps(rec))
    return 0


if __name__ == "__main__":
    sys.exit(main())
