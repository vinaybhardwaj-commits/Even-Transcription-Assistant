#!/usr/bin/env python3
"""cut_window.py — HIST harness piece 1 (hist-miner, ruling 146): cut ONE room window from raw R2 chunks the way the production audio-join does.
Production join (services/audio-join/container/join-core.mjs @5970852): every input normalised to 48 kHz mono, concat, libopus 32k, 48000 Hz, mono, webm.
This reuses fleet's full_audio.plan/assemble/decode (read-only import; SR forced to 48000 at call time, their file is not edited), so gaps stay silent on the wall clock and overlaps are trimmed.
Raw chunks are patient voice: they stay under ~/eta-data/hist-mining/audio (0700). The window file is 0600 and is deleted by the caller after the router job.
  cut(chunks, start_iso, end_iso, out_path, files) -> {duration_s, covered_fraction, gap_s, n_chunks}     files: {chunk id: local path}
  python3 cut_window.py --selftest     (synthetic tones only)"""
import os, subprocess, sys, tempfile
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-surgery-review-v2"))
import full_audio as fa

SR = 48000

def utc(s): return fa.utc(s)

def _decodable(path):
    """True if ffmpeg can actually DECODE audio from the file: first 2 s -> >= 0.2 s of PCM. NOT 'ffprobe reports a duration': valid opus webm chunks written without a duration header (e.g. the 24 Aug chunks, ~8 MB each) report duration=N/A yet decode fine
    (hist-bulk #855: my first check dropped every one of them and 4 link-3 windows silently became 'no audio'). The real 110-byte stub still fails: ffmpeg rc 1, zero bytes."""
    if not path or not os.path.exists(path): return False
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-t", "2", "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], capture_output=True)
    return r.returncode == 0 and len(r.stdout) >= 3200

def cut(chunks, start, end, out_path, files):
    """chunks: bench_chunk rows of ONE room (r2_key, idx, session_id, started_at, ended_at, upload_state, source, id). start/end: aware datetimes."""
    sessions = {}
    for c in chunks: sessions.setdefault(c["session_id"], []).append(c)
    if len(sessions) > 1:   # idx is per session; keep the session with the most tape so plan()'s per-idx de-dup cannot mix two sessions
        chunks = max(sessions.values(), key=lambda cs: sum((utc(c["ended_at"]) - utc(c["started_at"])).total_seconds() for c in cs))
    good, dropped = [], []
    for c in chunks:                # a chunk ffprobe cannot read (e.g. a 110-byte, 131 ms stub: hist-bulk, 19 Aug) is DROPPED and reported, never allowed to raise (fleet's decode() raises SystemExit, which kills a worker thread)
        (good if _decodable(files.get(c["id"])) else dropped).append(c)
    if chunks and not good:      # chunks EXIST but none can be decoded: a data/harness fault, never a silent 'no audio' (hist-bulk #855)
        raise RuntimeError(f"cut_window: all {len(chunks)} chunks undecodable ({[c['id'] for c in dropped][:5]})")
    sel, rep = fa.plan(good, start, end)
    if not sel: return {"duration_s": 0.0, "covered_fraction": 0.0, "gap_s": (end - start).total_seconds(), "n_chunks": 0, "chunks_dropped": [c["id"] for c in dropped]}
    old = fa.SR; fa.SR = SR
    try:
        pcm = fa.assemble(sel, {c["idx"]: files[c["id"]] for c in sel}, start, end)
    except SystemExit as e:         # a mid-file decode failure that ffprobe did not catch: a normal, countable error instead of a dead thread
        raise RuntimeError(f"cut_window: undecodable chunk in window ({e})")
    finally:
        fa.SR = old
    with tempfile.NamedTemporaryFile(suffix=".pcm", delete=False, dir=os.path.dirname(out_path)) as f:
        f.write(pcm); raw = f.name
    try:
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", raw, "-c:a", "libopus", "-b:a", "32k", "-ar", str(SR), "-ac", "1", "-f", "webm", out_path], capture_output=True)
        if r.returncode: raise SystemExit("cut_window: ffmpeg encode failed")
    finally:
        os.unlink(raw)
    os.chmod(out_path, 0o600)
    return {"duration_s": round(len(pcm) / 2 / SR, 2), "covered_fraction": rep.get("covered_fraction"), "gap_s": rep.get("gap_s"), "n_chunks": len(sel), "chunk_keys": [c["r2_key"] for c in sel],
            "chunks_used": [{"r2_key": c["r2_key"], "started_at": c["started_at"], "ended_at": c["ended_at"], "duration_ms": int(round((utc(c["ended_at"]) - utc(c["started_at"])).total_seconds() * 1000))} for c in sel], "chunks_dropped": [c["id"] for c in dropped]}

def selftest():
    def tone(freq, secs, p):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=48000:duration={secs}", "-ac", "1", "-c:a", "libopus", p], check=True)
    base = datetime(2026, 9, 10, 10, 0, 0, tzinfo=timezone.utc)
    with tempfile.TemporaryDirectory() as d:
        files, chunks = {}, []
        # chunk A 10:00:00-10:00:10 (440 Hz), 4 s GAP, chunk B 10:00:14-10:00:24 (880 Hz)
        for i, (off, f) in enumerate(((0, 440), (14, 880))):
            p = os.path.join(d, f"c{i}.webm"); tone(f, 10, p); files[f"id{i}"] = p
            chunks.append({"id": f"id{i}", "idx": i, "session_id": "s1", "r2_key": f"k{i}", "upload_state": "verified", "source": "primary",
                           "started_at": (base + timedelta(seconds=off)).isoformat(), "ended_at": (base + timedelta(seconds=off + 10)).isoformat()})
        # a valid opus webm with NO duration header (ffmpeg writing to a pipe cannot seek back): ffprobe says N/A, ffmpeg decodes it. It must be KEPT.
        nod = os.path.join(d, "nodur.webm")
        raw = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=10", "-ac", "1", "-c:a", "libopus", "-f", "webm", "pipe:1"], capture_output=True, check=True).stdout
        open(nod, "wb").write(raw)
        pr = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", nod], capture_output=True, text=True).stdout.strip()
        assert pr in ("N/A", ""), f"the test file must really lack a duration header (got {pr!r})"
        assert _decodable(nod), "a valid webm without a duration header must be decodable"
        bad = os.path.join(d, "bad.webm"); open(bad, "wb").write(b"\x1aE\xdf\xa3" + b"\x00" * 106); files["idbad"] = bad         # a 110-byte undecodable stub like the real one
        chunks.append({"id": "idbad", "idx": 2, "session_id": "s1", "r2_key": "kbad", "upload_state": "verified", "source": "primary",
                       "started_at": (base + timedelta(seconds=10)).isoformat(), "ended_at": (base + timedelta(seconds=10.13)).isoformat()})
        out = os.path.join(d, "w.webm")
        rep = cut(chunks, base + timedelta(seconds=2), base + timedelta(seconds=20), out, files)
        assert rep["chunks_dropped"] == ["idbad"], rep       # dropped and reported, no exception
        assert [c["r2_key"] for c in rep["chunks_used"]] == rep["chunk_keys"] and all(c["duration_ms"] == 10000 for c in rep["chunks_used"]), rep["chunks_used"]      # exactly the used chunks, with timing (lab-viewer #1025)
        assert not _decodable(bad), "the 110-byte stub must still be refused"
        try: cut([chunks[-1]], base, base + timedelta(seconds=20), os.path.join(d, "w2.webm"), files); raise AssertionError("chunks that all fail to decode must raise, not return 'no audio'")
        except RuntimeError: pass
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], capture_output=True, text=True).stdout)
        info = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "csv=p=0", out], capture_output=True, text=True).stdout.strip()
        assert abs(dur - 18.0) < 0.3 and rep["duration_s"] == 18.0, (dur, rep)
        assert info.startswith("opus,48000,1"), info
        # energy per second: tone at seconds 0-8 (10-2), silence 8-12 (the gap), tone 12-18
        pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", out, "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], capture_output=True).stdout
        import array; a = array.array("h"); a.frombytes(pcm)
        sec = [max(abs(x) for x in a[i * 8000:(i + 1) * 8000]) for i in range(18)]
        assert all(s > 2000 for s in sec[0:7]) and all(s < 500 for s in sec[9:11]) and all(s > 2000 for s in sec[13:17]), sec
        print("selftest OK: 18 s window, opus 48 kHz mono webm, the 4 s recording gap stays silent at the right seconds, tones on either side")

if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest()
    else: print(__doc__)
