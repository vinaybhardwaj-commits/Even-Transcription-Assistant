#!/usr/bin/env python3
"""vj-link extension (box): rebuild the audio of every diarized window of the given room-days from R2 chunks (rebuild_window.py method; feasibility: lag <= 20 ms, corr 0.96-0.99 vs production clips).
One Neon query per room-day for windows and one per session for chunks; 6 download threads. Out: ~/eta-data/voice-linkage/pilot/audio/<window>.wav (16 kHz mono, 0600). Resumable. Run with ~/.venv-r2/bin/python.
Usage: rebuild_room_days.py rd_id ..."""
import concurrent.futures as cf, datetime, json, os, re, shutil, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rebuild_window as R
PD = os.path.expanduser("~/eta-data/voice-linkage/pilot"); OUT = f"{PD}/audio"; os.makedirs(OUT, exist_ok=True)
def one(job):
    w, chunks = job; dst = f"{OUT}/{w['window_id']}.wav"
    if os.path.exists(dst) and os.path.getsize(dst) > 1000: return 1
    a = datetime.datetime.fromtimestamp(int(w["start_ms"]) / 1000, datetime.timezone.utc); b = datetime.datetime.fromtimestamp(int(w["end_ms"]) / 1000, datetime.timezone.utc)
    old = os.umask(0o077); tmp = tempfile.mkdtemp(prefix="rw-")
    try:
        pieces, covered = [], 0.0
        for i, c in enumerate(chunks):
            cs, ce = R.ts(c["s"]), R.ts(c["e"]); os_, oe = max(a, cs), min(b, ce); dur = (oe - os_).total_seconds()
            if dur <= 0: continue
            raw = f"{tmp}/raw{i}.webm"; R.s3().download_file("eta-audio", c["r2_key"], raw); pcm = f"{tmp}/pcm{i}.wav"
            subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", raw, "-ss", f"{(os_ - cs).total_seconds():.3f}", "-t", f"{dur:.3f}", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", pcm], check=True)
            pieces.append(pcm); covered += dur
        if not pieces: return 0
        lst = f"{tmp}/l.txt"; open(lst, "w").write("".join(f"file '{p}'\n" for p in pieces)); j = f"{tmp}/j.wav"
        subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", j], check=True)
        subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", j, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst + ".part.wav"], check=True)
        got = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", dst + ".part.wav"], capture_output=True, text=True).stdout)
        if abs(got - covered) > 0.1: os.remove(dst + ".part.wav"); print("REFUSED", w["window_id"], f"{got:.1f} vs {covered:.1f}", flush=True); return 0
        os.replace(dst + ".part.wav", dst); os.chmod(dst, 0o600); return 1
    except Exception as e:
        print("FAIL", w["window_id"], type(e).__name__, str(e)[:60], flush=True); return 0
    finally:
        os.umask(old); shutil.rmtree(tmp, ignore_errors=True)
tot = ok = 0
for rd in sys.argv[1:]:
    d = json.load(open(f"{PD}/turns-{rd}.json")); wins = [w for w in d["windows"] if w.get("state") == "ok" and w.get("segments_json") and not os.path.exists(f"{OUT}/{w['window_id']}.wav")]
    jobs = []
    for w in wins:
        sess = R.neon(f"SELECT session_id FROM bench_window WHERE id='{w['window_id']}'")[0]["session_id"] if False else None
    if not wins: continue
    ids = ",".join(f"'{w['window_id']}'" for w in wins)
    meta = {r["id"]: r["session_id"] for r in R.neon(f"SELECT id, session_id FROM bench_window WHERE id IN ({ids})")}
    lo, hi = min(int(w["start_ms"]) for w in wins), max(int(w["end_ms"]) for w in wins)
    sess = set(meta.values()); chunks = {}
    for s in sess:
        chunks[s] = R.neon(f"SELECT r2_key, started_at::text s, ended_at::text e FROM bench_chunk WHERE session_id='{s}' AND upload_state='verified' AND ended_at > to_timestamp({lo}/1000.0) AND started_at < to_timestamp({hi}/1000.0) ORDER BY started_at")
    for w in wins:
        a_, b_ = R.ts(datetime.datetime.fromtimestamp(int(w["start_ms"]) / 1000, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f+00")), R.ts(datetime.datetime.fromtimestamp(int(w["end_ms"]) / 1000, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f+00"))
        cs = [c for c in chunks[meta[w["window_id"]]] if R.ts(c["e"]) > a_ and R.ts(c["s"]) < b_]
        jobs.append((w, cs))
    with cf.ThreadPoolExecutor(6) as ex: res = list(ex.map(one, jobs))
    tot += len(jobs); ok += sum(res); print("REBUILT", rd, sum(res), "of", len(jobs), flush=True)
print("REBUILD_DONE windows", tot, "ok", ok)
