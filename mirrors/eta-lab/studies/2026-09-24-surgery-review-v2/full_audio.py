#!/usr/bin/env python3
"""full_audio.py — WHOLE-CONSULT audio (SURGERY-REVIEW-V3 addendum 11:05, owner fleet): ONE continuous MP3 per consult, built ON THE BOX from the raw R2 chunks with ffmpeg.
No Cloudflare join Worker is used, so the "no joins while rooms record" guard does not apply and it works in clinic hours.

  * chunk rows come from Neon bench_chunk (session_id, idx, r2_key, started_at, ended_at, duration_ms, gap_before_ms, upload_state, source): read-only, no R2 listing needed;
  * each chunk (5-min mono Opus WebM) is decoded to mono 16 kHz PCM and PLACED ON THE WALL-CLOCK TIMELINE: silence is inserted for a recording gap, an overlap is trimmed, so
    a turn's start_s maps to the same second in the clip whatever happened between chunks (a plain concat would drift by every gap);
  * the requested span [span_start, span_end] is cut and encoded MP3 mono 16 kHz 32 kbps (~14 MB/hour). MP3 because Safari on iOS plays Opus-in-WebM only on recent versions:
    WebM ships only if a real Slack-iOS check proves it (Fable, addendum 3);
  * the page contract (surg-page bus #185): audio_full = {src, t0_s, duration_s}; t0_s = which turn.start_s the clip's second 0 corresponds to;
  * whole chunks are raw patient voice: downloaded to audio-tmp/ only to cut from, then DELETED. The R2 key is read from a 0600 file and passed to curl through a 0600 config file,
    never argv, never printed.
DOWNLOAD IS UNTESTED against real R2: the read key does not exist yet (ruling 55 mint is blocked on V). Everything else is tested offline with synthetic tones (--selftest).
"""
import json, math, os, subprocess, sys, tempfile, wave
from datetime import datetime, timedelta, timezone

SR = 16000
OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
TMP = f"{OUT}/audio-tmp"
IST = timezone(timedelta(hours=5, minutes=30))


def utc(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def _rank(c):
    """A verified row beats an unverified one; a PRIMARY microphone row beats a backup row."""
    return (c.get("upload_state") == "verified", c.get("source") == "primary")


def plan(chunks, span_start, span_end):
    """Chunks that overlap [span_start, span_end], one per idx (a verified PRIMARY row wins over a backup row), ordered by start time.
    Returns (selected, report{n, gap_s, uncovered_s, covered_fraction})."""
    by = {}
    for c in chunks:
        s, e = utc(c["started_at"]), utc(c["ended_at"])
        if e <= span_start or s >= span_end:
            continue
        cur = by.get(c["idx"])
        if cur is None or _rank(c) > _rank(cur):
            by[c["idx"]] = c
    sel = sorted(by.values(), key=lambda c: utc(c["started_at"]))
    covered = 0.0
    cur = span_start
    gap = 0.0
    for c in sel:
        s, e = max(utc(c["started_at"]), span_start), min(utc(c["ended_at"]), span_end)
        if s > cur:
            gap += (s - cur).total_seconds()
        covered += max(0.0, (e - max(s, cur)).total_seconds())
        cur = max(cur, e)
    if cur < span_end:
        gap += (span_end - cur).total_seconds()
    total = (span_end - span_start).total_seconds()
    return sel, {"n": len(sel), "gap_s": round(gap, 2), "covered_fraction": round(covered / total, 4) if total else 0.0, "span_s": round(total, 2)}


def decode(path):
    """-> mono 16 kHz signed-16 little-endian PCM bytes."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True)
    if r.returncode != 0:
        raise SystemExit("ffmpeg could not decode a chunk")
    return r.stdout


def assemble(selected, files, span_start, span_end):
    """selected: chunk rows in time order; files: {idx: local path}. Returns the PCM bytes for exactly [span_start, span_end] on the wall clock."""
    n = int(round((span_end - span_start).total_seconds() * SR))
    buf = bytearray(n * 2)  # zero = silence for any gap
    for c in selected:
        pcm = decode(files[c["idx"]])
        off = int(round((utc(c["started_at"]) - span_start).total_seconds() * SR))
        s_from = max(0, -off)  # samples of this chunk that fall before the span start
        dst = max(0, off)
        take = min(len(pcm) // 2 - s_from, n - dst)
        if take > 0:
            buf[dst * 2:(dst + take) * 2] = pcm[s_from * 2:(s_from + take) * 2]
    return bytes(buf)


def encode_mp3(pcm, out_path, kbps=32):
    with tempfile.TemporaryDirectory() as d:
        w = os.path.join(d, "x.wav")
        with wave.open(w, "wb") as f:
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(SR); f.writeframes(pcm)
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", w, "-ac", "1", "-ar", str(SR), "-c:a", "libmp3lame", "-b:a", f"{kbps}k", out_path], capture_output=True)
        if r.returncode != 0:
            raise SystemExit("ffmpeg mp3 encode failed")
    os.chmod(out_path, 0o600)


def audio_full_field(rel_path, called_at, span_start, duration_s):
    """The page's field. t0_s = the turn.start_s of clip second 0: turn start_s is seconds since the consult's PQM called_at, and the clip starts at span_start."""
    return {"src": rel_path, "t0_s": round((span_start - utc(called_at)).total_seconds(), 2), "duration_s": round(duration_s, 1)}


# ---- download (UNTESTED against real R2; the key does not exist yet) -------------------------------------------------------------------------------------------
def download(chunk, dest, endpoint_host, bucket, key_file=os.path.expanduser("~/.claude/secrets/r2_audio_read")):
    """S3 SigV4 GET through curl. Key file: 0600, line 1 access key id, line 2 secret. The secret goes to curl in a 0600 -K config file, never argv."""
    lines = [l.strip() for l in open(key_file).read().splitlines() if l.strip()]
    kid, secret = lines[0], lines[1]
    url = f"https://{bucket}.{endpoint_host}/{chunk['r2_key']}"
    with tempfile.NamedTemporaryFile("w", delete=False, dir=TMP) as f:
        os.chmod(f.name, 0o600)
        f.write(f'user = "{kid}:{secret}"\naws-sigv4 = "aws:amz:auto:s3"\nurl = "{url}"\noutput = "{dest}"\nsilent\nfail\n')
        cfg = f.name
    try:
        r = subprocess.run(["curl", "-K", cfg, "-m", "180"], capture_output=True)
        if r.returncode != 0:
            raise SystemExit(f"download failed rc={r.returncode} for chunk {chunk['idx']}")
    finally:
        os.remove(cfg)
    os.chmod(dest, 0o600)


def selftest():
    import struct
    d = tempfile.mkdtemp(); base = datetime(2026, 9, 23, 5, 30, 0, tzinfo=timezone.utc)
    freqs = {0: 440, 1: 880, 2: 1320}
    rows, files = [], {}
    # chunk k covers 10 s; chunk 2 starts 3 s after chunk 1 ends (a recording gap)
    starts = {0: 0.0, 1: 10.0, 2: 23.0}
    for k, f in freqs.items():
        p = os.path.join(d, f"c{k}.webm")
        if k == 0:  # first half 440 Hz, second half 550 Hz: the span starts 5 s in, so the clip must open on 550 Hz
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5", "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000:duration=5",
                            "-filter_complex", "[0][1]concat=n=2:v=0:a=1", "-ac", "1", "-c:a", "libopus", p], check=True)
        else:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency={f}:sample_rate=48000:duration=10", "-ac", "1", "-c:a", "libopus", p], check=True)
        files[k] = p
        s = base + timedelta(seconds=starts[k])
        rows.append({"idx": k, "started_at": s.isoformat(), "ended_at": (s + timedelta(seconds=10)).isoformat(), "upload_state": "verified", "source": "primary", "r2_key": f"k{k}"})
    span_s, span_e = base + timedelta(seconds=5), base + timedelta(seconds=28)  # 5 s of chunk 0, all of chunk 1, the 3 s gap, 5 s of chunk 2
    sel, rep = plan(rows, span_s, span_e)
    assert [c["idx"] for c in sel] == [0, 1, 2] and rep["gap_s"] == 3.0 and abs(rep["covered_fraction"] - 20 / 23) < 1e-3, rep
    pcm = assemble(sel, files, span_s, span_e)
    assert len(pcm) // 2 == 23 * SR, "the PCM is exactly the span long"

    def dom(seg):  # zero-crossing frequency estimate
        x = struct.unpack("<%dh" % (len(seg) // 2), seg)
        zc = sum(1 for i in range(1, len(x)) if (x[i - 1] < 0) != (x[i] < 0))
        return zc / 2 / (len(x) / SR)

    def at(t0, t1):
        return pcm[int(t0 * SR) * 2:int(t1 * SR) * 2]
    assert abs(dom(at(0.5, 4.5)) - 550) < 30, "seconds 0-5 of the clip are chunk 0's SECOND half (the span starts 5 s into that chunk)"
    assert abs(dom(at(5.5, 14.5)) - 880) < 40, "seconds 5-15 are chunk 1"
    assert max(abs(v) for v in struct.unpack("<%dh" % (len(at(15.3, 17.7)) // 2), at(15.3, 17.7))) == 0, "the 3 s recording gap is SILENCE, not squeezed out"
    assert abs(dom(at(18.5, 22.5)) - 1320) < 60, "seconds 18-23 are chunk 2: the gap kept the timeline aligned"
    mp3 = os.path.join(d, "full.mp3"); encode_mp3(pcm, mp3)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3], capture_output=True, text=True).stdout)
    assert abs(dur - 23.0) < 0.15, dur
    assert os.path.getsize(mp3) < 23 * 32000 / 8 * 1.6, "about 32 kbps"
    f = audio_full_field("audio/P01/full.mp3", (base + timedelta(seconds=2)).isoformat(), span_s, dur)
    assert f["src"] == "audio/P01/full.mp3" and f["t0_s"] == 3.0 and abs(f["duration_s"] - 23.0) < 0.2, f
    # a backup row never replaces a verified primary; a missing chunk is reported as a gap
    bk = rows + [{**rows[1], "source": "backup", "upload_state": "verified", "r2_key": "bk"}]
    sel2, _ = plan(bk, span_s, span_e)
    assert [c["r2_key"] for c in sel2 if c["idx"] == 1] == ["k1"], "primary wins"
    pend = [dict(rows[1], upload_state="pending"), dict(rows[1], source="backup", upload_state="verified", r2_key="bkv")]
    assert [c["r2_key"] for c in plan(rows[:1] + pend + rows[2:], span_s, span_e)[0] if c["idx"] == 1] == ["bkv"], "a verified backup beats an UNVERIFIED primary"
    _, rep3 = plan(rows[:1] + rows[2:], span_s, span_e)
    assert rep3["gap_s"] == 13.0, rep3
    print("selftest OK: timeline placement (tones at the right seconds), the 3 s gap stays silent, exact span length, ~32 kbps mp3, t0_s, primary beats backup, missing chunk reported")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
