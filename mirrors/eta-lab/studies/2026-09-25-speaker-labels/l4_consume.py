#!/usr/bin/env python3
"""337e full run, stage 2 (eta-lab-l4): for each shipped <window_id>.flac (lossless, 16 kHz mono wall-clock window audio; .webm also accepted) decode with the L4's static ffmpeg, run Nemotron-3-Diarization (base, offline 30.4 s),
append TURNS ONLY (wall-clock seconds from the window start, speaker id) to a JSONL, delete the webm and the temp wav. Resumable (skips windows already in the JSONL). No text, no audio kept.
usage (NeMo venv, GPU, under flock ~/gpu.lock): l4_consume.py <inbox_dir> <out.jsonl> [--ffmpeg PATH] [--wav-check]"""
import glob, json, os, subprocess, sys, tempfile, time
import torch
from nemo.collections.asr.models import SortformerEncLabelModel
inbox, out = sys.argv[1], sys.argv[2]
ff = sys.argv[sys.argv.index("--ffmpeg") + 1] if "--ffmpeg" in sys.argv else os.path.expanduser("~/services/bin/ffmpeg")
done = set()
if os.path.exists(out):
    for l in open(out): done.add(json.loads(l)["window_id"])
m = SortformerEncLabelModel.from_pretrained("nvidia/Nemotron-3-Diarization", map_location="cuda").eval()
sm = m.sortformer_modules; sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period = 264, 40, 340, 40, 300; m._check_streaming_parameters()
parse = lambda s: (float(s.split()[0]), float(s.split()[1]), s.split()[2]) if isinstance(s, str) else (float(s[0]), float(s[1]), str(s[2]))
tmp = tempfile.mkdtemp(prefix="l4c-", dir=os.path.expanduser("~/eta-lab-night")); os.chmod(tmp, 0o700)
t0 = time.time(); n = 0; audio_s = 0.0
for p in sorted(glob.glob(os.path.join(inbox, "*.flac")) + glob.glob(os.path.join(inbox, "*.webm"))):
    wid = os.path.basename(p).rsplit(".", 1)[0]
    if wid in done: os.unlink(p); continue
    wav = os.path.join(tmp, wid + ".wav")
    r = subprocess.run([ff, "-v", "error", "-y", "-i", p, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], capture_output=True)
    if r.returncode: print(wid, "DECODE FAIL", flush=True); continue
    segs = [parse(s) for s in m.diarize(audio=[wav], batch_size=1, verbose=False)[0]]
    dur = os.path.getsize(wav) / 32000.0; audio_s += dur
    with open(out, "a") as f: f.write(json.dumps(dict(window_id=wid, engine="nemotron-3", audio_s=round(dur, 1), turns=[[round(a, 3), round(b, 3), s] for a, b, s in segs])) + "\n")
    os.unlink(wav); os.unlink(p); n += 1
    if n % 25 == 0: print(f"{n} windows {audio_s / 3600:.1f} audio-h {time.time() - t0:.0f}s ({(time.time() - t0) / max(audio_s / 3600, 1e-9):.1f} s per audio-h)", flush=True)
print(f"done {n} windows {audio_s / 3600:.1f} audio-h in {time.time() - t0:.0f}s on {torch.cuda.get_device_name(0)}")
os.rmdir(tmp)
