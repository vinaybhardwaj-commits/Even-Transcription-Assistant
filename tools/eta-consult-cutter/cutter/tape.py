"""Tape from the box mirror (~/eta-data/tapes/manifest.jsonl); missing chunks are pulled from R2 exactly like tools/tape_pull_room.py (read-only key, size check, never overwrite)."""
import collections, datetime as dt, json, os, subprocess, tempfile
from . import config as C

def load_manifest(path=None):
    by = collections.defaultdict(list)
    for l in open(path or f"{C.TAPES}/manifest.jsonl"):
        if not l.strip(): continue
        x = json.loads(l); s = dt.datetime.fromisoformat(x["started_at"].replace("Z", "+00:00")).timestamp()
        by[x["room_id"]].append((s, s + x["duration_ms"] / 1000, f"{path and os.path.dirname(path) or C.TAPES}/{x['path']}"))
    for v in by.values(): v.sort()
    return by

def coverage(by, room, a, b):
    if b <= a: return 0.0
    return sum(max(0.0, min(b, e) - max(a, s)) for s, e, _ in by.get(room, [])) / (b - a)

def bounds(by, room, t, around=10800.0):
    """first start / last end of the room's chunks within +-3 h of t (tape start / tape end), or (None, None)."""
    near = [(s, e) for s, e, _ in by.get(room, []) if s >= t - around and s <= t + around]
    return (min(s for s, _ in near), max(e for _, e in near)) if near else (None, None)

def plan(by, room, a, b):
    """ordered pieces ('sil', dur) / ('seg', path, offset_s, dur) covering [a, b] (clip-relative time = t - a, silence where the tape has a gap) and the coverage fraction."""
    pieces, cov, cur = [], 0.0, a
    for s, e, p in by.get(room, []):
        lo, hi = max(a, s), min(b, e)
        if hi <= lo: continue
        if lo - cur > 0.05: pieces.append(("sil", lo - cur))
        pieces.append(("seg", p, lo - s, hi - lo)); cov += hi - lo; cur = hi
    if b - cur > 0.05: pieces.append(("sil", b - cur))
    return pieces, cov / max(b - a, 1e-9)

def cut(pieces, out, workdir):
    """tape pieces -> one mono opus-in-m4a working file (the diarizer input)."""
    tmp = tempfile.mkdtemp(prefix="cut_", dir=workdir); paths = []
    try:
        for i, pc in enumerate(pieces):
            w = f"{tmp}/p{i:03d}.wav"
            cmd = (["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", f"{pc[1]:.3f}", w] if pc[0] == "sil" else
                   ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{pc[2]:.3f}", "-t", f"{pc[3]:.3f}", "-i", pc[1], "-ac", "1", "-ar", "48000", w])
            subprocess.run(cmd, check=True, capture_output=True); paths.append(w)
        open(f"{tmp}/c.txt", "w").write("".join(f"file '{p}'\n" for p in paths))
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", f"{tmp}/c.txt", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "mp4", out + ".tmp"], check=True, capture_output=True)
        os.replace(out + ".tmp", out)
    finally:
        for f in os.listdir(tmp): os.remove(f"{tmp}/{f}")
        os.rmdir(tmp)

LAST_PULL_ERROR = None

def pull_missing(room_id, t0, t1, runner=None):
    """pull the room's chunks overlapping [t0 - 300 s, t1 + 300 s] from R2 (the mirror's way). runner(args) -> (rc, text) injectable. -> True if the pull ran."""
    f = lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    args = [C.PULL_PY, C.PULL_ROOM, "--room", room_id, "--from", f(t0 - 300), "--to", f(t1 + 300)]
    try:
        if runner: rc, _ = runner(args); return rc == 0
        r = subprocess.run(args, capture_output=True, text=True, timeout=900); return r.returncode == 0
    except Exception as e:                                                    # R9: a timeout or OS error in one pull never aborts the run
        global LAST_PULL_ERROR; LAST_PULL_ERROR = f"{type(e).__name__}: {str(e)[:120]}"; return False

def loudness(path):
    """integrated loudness of a file by loudnorm's first pass: a float (LUFS), the string '-inf' for digital silence (every 400 ms block is under the -70 LUFS gate), or None if it could not be measured."""
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "loudnorm=I=-18:print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    try: raw = json.loads(p.stderr[p.stderr.rindex("{"):p.stderr.rindex("}") + 1])["input_i"]
    except Exception: return None
    try: v = float(raw)
    except ValueError: return None
    return v if v == v and v > -200 else "-inf"

def is_silent(path):
    """m3-05: -> (silent, measured LUFS or '-inf'). Digital silence (the OPD 3 C270 zero-fill since 1 Oct) has nothing to diarize and loudnorm cannot normalise it; anything under -70 LUFS counts as silent."""
    v = loudness(path)
    if v is None: return False, None                                             # not measurable: let the normal path decide
    return (v == "-inf" or v < -70.0), v
