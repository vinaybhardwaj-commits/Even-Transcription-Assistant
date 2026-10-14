#!/usr/bin/env python3
"""vj-link ruling 275 (box, venv-gpu + R2 read key): 16-17 Sep have audio chunks and bench windows but NO diarization. For each non-home room-day with >= 8 windows: rebuild each 15-min window from R2 chunks (rebuild_window method,
gap-closed, feasibility: lag <= 20 ms), diarize it with pyannote/speaker-diarization-3.1 (the offline snapshot copied from voice-lab-1, default settings, on the T4), and write turns-<rd>.json in the same shape as stage_seg.py
(turns = diarizer segments >= 0.3 s, text empty, windows[state ok, segments_json with start_ms/end_ms/speaker_idx]). Resumable (per-window segment cache). No transcripts on these days: no Rx, no Jev.
Usage: seg1617.py 2026-09-16 2026-09-17      Out: ~/eta-data/voice-linkage/pilot/{turns-<rd>.json, audio/<window>.wav, seg1617-rds.json}; cache ~/eta-data/voice-linkage/seg1617/<window>.json. Counts only on stdout."""
import concurrent.futures as cf, datetime, json, os, re, shutil, subprocess, sys, tempfile, time
BOX = os.path.expanduser("~/eta-data/voice-linkage"); PD = f"{BOX}/pilot"; CACHE = f"{BOX}/seg1617"; os.makedirs(CACHE, exist_ok=True); os.makedirs(f"{PD}/audio", exist_ok=True)
os.environ["HF_HUB_CACHE"] = f"{BOX}/models/pyannote"; os.environ["HF_HUB_OFFLINE"] = "1"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rebuild_window as R
IDRE = re.compile(r"^[A-Za-z0-9_\-]+$")
def rebuild_one(job):
    w, chunks = job; dst = f"{PD}/audio/{w['window_id']}.wav"
    if os.path.exists(dst) and os.path.getsize(dst) > 1000: return True
    a = datetime.datetime.fromtimestamp(int(w["start_ms"]) / 1000, datetime.timezone.utc); b = datetime.datetime.fromtimestamp(int(w["end_ms"]) / 1000, datetime.timezone.utc)
    old = os.umask(0o077); tmp = tempfile.mkdtemp(prefix="s17-")
    try:
        pieces, covered = [], 0.0
        for i, c in enumerate(chunks):
            cs, ce = R.ts(c["s"]), R.ts(c["e"]); os_, oe = max(a, cs), min(b, ce); dur = (oe - os_).total_seconds()
            if dur <= 0: continue
            raw = f"{tmp}/r{i}.webm"; R.s3().download_file("eta-audio", c["r2_key"], raw); pcm = f"{tmp}/p{i}.wav"
            subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", raw, "-ss", f"{(os_ - cs).total_seconds():.3f}", "-t", f"{dur:.3f}", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", pcm], check=True)
            pieces.append(pcm); covered += dur
        if not pieces: return False
        lst = f"{tmp}/l.txt"; open(lst, "w").write("".join(f"file '{p}'\n" for p in pieces)); j = f"{tmp}/j.wav"
        subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", j], check=True)
        subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", j, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst + ".part.wav"], check=True)
        got = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", dst + ".part.wav"], capture_output=True, text=True).stdout)
        if abs(got - covered) > 0.1: os.remove(dst + ".part.wav"); return False
        os.replace(dst + ".part.wav", dst); os.chmod(dst, 0o600); return True
    except Exception as e:
        print("REBUILD FAIL", w["window_id"], type(e).__name__, flush=True); return False
    finally:
        os.umask(old); shutil.rmtree(tmp, ignore_errors=True)
import torch
from pyannote.audio import Pipeline
pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1"); pipe.to(torch.device("cuda"))
def diarize(wid):
    cf_ = f"{CACHE}/{wid}.json"
    if os.path.exists(cf_): return json.load(open(cf_))
    diar = pipe(f"{PD}/audio/{wid}.wav"); lab = {}; segs = []
    for t, _, s in diar.itertracks(yield_label=True):
        lab.setdefault(s, len(lab)); segs.append({"start_ms": int(t.start * 1000), "end_ms": int(t.end * 1000), "speaker_idx": lab[s]})
    json.dump(segs, open(cf_, "w")); return segs
rds = []; t0 = time.time()
for date in sys.argv[1:]:
    for r in R.neon(f"SELECT rd.id room_day_id, rd.room_id, r.name room, rd.ist_date::text date FROM room_day rd JOIN room r ON r.id=rd.room_id WHERE rd.ist_date='{date}'::date AND r.name !~* '(home|scratch)'"):
        rd = r["room_day_id"]; assert IDRE.match(rd)
        wins = R.neon(f"SELECT id window_id, session_id, start_ms, end_ms FROM bench_window WHERE room_day_id='{rd}' ORDER BY start_ms")
        if len(wins) < 8: continue
        sess = {w["session_id"] for w in wins}; lo, hi = min(int(w["start_ms"]) for w in wins), max(int(w["end_ms"]) for w in wins); chunks = {}
        for s in sess: chunks[s] = R.neon(f"SELECT r2_key, started_at::text s, ended_at::text e FROM bench_chunk WHERE session_id='{s}' AND upload_state='verified' AND ended_at > to_timestamp({lo}/1000.0) AND started_at < to_timestamp({hi}/1000.0) ORDER BY started_at")
        jobs = []
        for w in wins:
            a_ = R.ts(datetime.datetime.fromtimestamp(int(w["start_ms"]) / 1000, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f+00")); b_ = R.ts(datetime.datetime.fromtimestamp(int(w["end_ms"]) / 1000, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f+00"))
            jobs.append((w, [c for c in chunks[w["session_id"]] if R.ts(c["e"]) > a_ and R.ts(c["s"]) < b_]))
        with cf.ThreadPoolExecutor(6) as ex: ok = list(ex.map(rebuild_one, jobs))
        wl, turns = [], []
        for (w, _), good in zip(jobs, ok):
            if not good: wl.append({"window_id": w["window_id"], "start_ms": w["start_ms"], "end_ms": w["end_ms"], "state": "no_audio", "clip_r2_key": None, "segments_json": None}); continue
            segs = diarize(w["window_id"]); w0 = int(w["start_ms"])
            wl.append({"window_id": w["window_id"], "start_ms": w["start_ms"], "end_ms": w["end_ms"], "state": "ok", "clip_r2_key": None, "segments_json": segs})
            for i, g in enumerate(segs):
                if g["end_ms"] - g["start_ms"] < 300: continue
                turns.append({"source_ref": f"seg|{w['window_id']}|{i}", "s_ms": str(w0 + g["start_ms"]), "e_ms": str(w0 + g["end_ms"]), "win": w["window_id"], "spk": str(g["speaker_idx"]), "lang": "", "text": "", "nsp": None})
        turns.sort(key=lambda t: int(t["s_ms"])); r["n_turns"], r["n_windows"] = len(turns), len(wins)
        p = f"{PD}/turns-{rd}.json"; json.dump({"room": r, "turns": turns, "windows": wl}, open(p, "w")); os.chmod(p, 0o600); rds.append(rd)
        print(date, r["room"], rd, "windows", len(wins), "with audio", sum(ok), "turns", len(turns), f"{time.time() - t0:.0f}s", flush=True)
json.dump(rds, open(f"{PD}/seg1617-rds.json", "w")); print("SEG1617_DONE room_days", len(rds))
