#!/usr/bin/env python3
"""vj-link: rebuild a 15-min window's audio from R2 chunks for windows that have NO production clip key (9-15 Sep). Same method as kit/clip_fetch_core.py (K1/K2 fixes): decode each overlapping chunk with
OUTPUT-side seeking, trim to the overlap with the window, concatenate back-to-back with NO padding (gap-closed, like bench-join), then 16 kHz mono wav. Reads chunk rows from Neon (read-only) and audio from R2 with the box READ key
(never printed). Range check: result duration must equal the covered audio within 0.1 s or the window is refused.
Library: rebuild(window_id, out_wav) -> (n_chunks, seconds).  CLI: rebuild_window.py <window_id> <out.wav>"""
import datetime, json, os, re, shutil, subprocess, sys, tempfile
HELPER = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs"); REPO = os.path.expanduser("~/dev/Even-Transcription-Assistant")
KEY = os.path.expanduser("~/.claude/secrets/r2_audio_read"); IDRE = re.compile(r"^[A-Za-z0-9_\-]+$"); _s3 = None


def neon(sql):
    r = subprocess.run(["node", HELPER, sql], cwd=REPO, capture_output=True, text=True, timeout=300)
    if r.returncode: raise RuntimeError("neon-select failed: " + r.stderr[:200])
    return json.loads(r.stdout)


def s3():
    global _s3
    if _s3 is None:
        import boto3
        from botocore.config import Config
        L = [l.strip() for l in open(KEY).read().splitlines() if l.strip()]
        ep = L[2] if L[2].startswith("http") else "https://" + L[2]
        _s3 = boto3.client("s3", endpoint_url=ep, aws_access_key_id=L[0], aws_secret_access_key=L[1], region_name="auto", config=Config(retries={"max_attempts": 4}))
    return _s3


def ts(v):
    """Neon timestamptz text: '2026-09-23 13:11:38.45+00' (fraction 0-6 digits, tz '+00')."""
    m = re.match(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2})(?::?(\d{2}))?$", v.strip())
    if not m: raise ValueError(f"bad timestamp {v!r}")
    d, t, f, h, mi = m.groups()
    return datetime.datetime.fromisoformat(f"{d}T{t}.{(f or '0').ljust(6, '0')[:6]}{h}:{mi or '00'}")


def rebuild(window_id, out_wav, sr=16000):
    assert IDRE.match(window_id)
    w = neon(f"SELECT session_id, start_ms, end_ms FROM bench_window WHERE id='{window_id}'")[0]
    a = datetime.datetime.fromtimestamp(int(w["start_ms"]) / 1000, datetime.timezone.utc); b = datetime.datetime.fromtimestamp(int(w["end_ms"]) / 1000, datetime.timezone.utc)
    chunks = neon(f"SELECT r2_key, started_at::text s, ended_at::text e FROM bench_chunk WHERE session_id='{w['session_id']}' AND upload_state='verified' AND ended_at > to_timestamp({int(w['start_ms'])}/1000.0) AND started_at < to_timestamp({int(w['end_ms'])}/1000.0) ORDER BY started_at")
    if not chunks: raise RuntimeError("no covering chunk")
    old = os.umask(0o077); tmp = tempfile.mkdtemp(prefix="rebuild-")
    try:
        pieces, covered = [], 0.0
        for i, c in enumerate(chunks):
            cs, ce = ts(c["s"]), ts(c["e"]); os_, oe = max(a, cs), min(b, ce)
            dur = (oe - os_).total_seconds()
            if dur <= 0: continue
            raw = f"{tmp}/raw{i}.webm"; s3().download_file("eta-audio", c["r2_key"], raw)
            pcm = f"{tmp}/pcm{i}.wav"
            subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", raw, "-ss", f"{(os_ - cs).total_seconds():.3f}", "-t", f"{dur:.3f}", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", pcm], check=True)
            pieces.append(pcm); covered += dur
        lst = f"{tmp}/l.txt"; open(lst, "w").write("".join(f"file '{p}'\n" for p in pieces))
        joined = f"{tmp}/j.wav"; subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], check=True)
        subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", joined, "-ac", "1", "-ar", str(sr), "-c:a", "pcm_s16le", out_wav], check=True)
        got = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out_wav], capture_output=True, text=True).stdout)
        if abs(got - covered) > 0.1: raise RuntimeError(f"duration {got:.2f}s != covered {covered:.2f}s: refused")
        os.chmod(out_wav, 0o600); return len(pieces), covered
    finally:
        os.umask(old); shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    print(rebuild(sys.argv[1], sys.argv[2]))
