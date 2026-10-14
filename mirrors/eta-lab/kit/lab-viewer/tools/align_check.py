#!/usr/bin/env python3
"""Pre-check for the viewer's ▶ mapping using LOCAL copies of the audio (no network, no patient text printed).

For N random transcript lines in staged/hist window files: map (window start + line start_s) to the source chunk
and offset the way the viewer does, then compare the audio energy over the line's span with the chunk's quiet floor
(p20 of 1-second RMS). A line that is speech should sit well above the floor; a mis-mapped offset lands on the floor.

  align_check.py [--n 5] [--seed 1] [--audio-dir ~/eta-data/hist-mining/audio]
"""
import argparse, array, glob, json, math, os, random, subprocess, sys
from datetime import datetime
from pathlib import Path

HOME = Path.home()


def utc(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def per_second_rms(path):
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], capture_output=True).stdout
    a = array.array("h"); a.frombytes(pcm)
    return [math.sqrt(sum(x * x for x in a[i:i + 8000]) / max(1, len(a[i:i + 8000]))) for i in range(0, len(a), 8000)]


def window_chunks(d):
    """Same rule as the viewer: provenance.source_chunks, else cut.chunk_keys timed from the producers' inventories."""
    p = d.get("provenance") or {}
    if p.get("source_chunks"):
        return p["source_chunks"]
    keys = (d.get("cut") or {}).get("chunk_keys") or p.get("source_audio_keys") or []
    timing = _timing()
    return [timing[k] for k in keys if k in timing]


_T = None
def _timing():
    global _T
    if _T is None:
        _T = {}
        try:
            for inv in json.load(open(HOME / "eta-data/hist/inventory.json")):
                for c in inv["chunks"]:
                    _T.setdefault(c["r2_key"], c)
            for chunks in json.load(open(HOME / "eta-data/hist-mining/link3_chunks.json")).values():
                for c in chunks:
                    _T.setdefault(c["r2_key"], c)
        except (OSError, ValueError):
            pass
    return _T


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--n", type=int, default=5); ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--audio-dir", default=str(HOME / "eta-data/hist-mining/audio")); a = ap.parse_args()
    random.seed(a.seed)
    files = glob.glob(str(HOME / "eta-data/lab-vault/staged/runs/*/*/*/*.json")) + glob.glob(str(HOME / "eta-data/hist/runs/*/*/*/*.json")) + glob.glob(str(HOME / "eta-data/hist-mining/runs/*/*/*/*.json")) + glob.glob(str(HOME / "eta-data/hist/runs/*/*/*/*.json"))
    random.shuffle(files)
    done = 0
    for f in files:
        d = json.load(open(f)); p = d["provenance"]; chunks = window_chunks(d)
        segs = [s for s in d.get("segments") or [] if s.get("end_s", 0) - s.get("start_s", 0) >= 2 and (s.get("text") or "").strip()]
        local = {c["r2_key"]: Path(a.audio_dir) / c["r2_key"].replace("/", "__") for c in chunks}
        if not segs or not chunks or not all(v.exists() for v in local.values()):
            continue
        s = random.choice(segs); ms = utc(d["start"]) * 1000 + s["start_s"] * 1000
        hit = [c for c in chunks if utc(c["started_at"]) * 1000 <= ms < utc(c["ended_at"]) * 1000]
        if not hit:
            print(f"{Path(f).stem}: line at +{s['start_s']}s falls in a recording gap (no chunk), viewer says 'no audio at this time'"); done += 1
            if done >= a.n: break
            continue
        c = hit[0]; off = (ms - utc(c["started_at"]) * 1000) / 1000
        rms = per_second_rms(local[c["r2_key"]]); floor = sorted(rms)[len(rms) // 5]
        span = rms[int(off):int(off + s["end_s"] - s["start_s"]) + 1]
        ratio = (sum(span) / len(span)) / max(floor, 1.0)
        print(f"{Path(f).stem}: line +{s['start_s']:.1f}s..{s['end_s']:.1f}s -> chunk {chunks.index(c)}/{len(chunks)} offset {off:.1f}s of {len(rms)}s; energy {ratio:.1f}x the chunk's quiet floor {'OK' if ratio > 2 else 'LOW'}")
        done += 1
        if done >= a.n: break
    if not done:
        print("no window with all source chunks on local disk"); return 1


if __name__ == "__main__":
    sys.exit(main())
