#!/usr/bin/env python3
"""337e on Hugging Face Jobs (r386 S4): Nemotron-3-Diarization over every *.flac/*.wav under <inbox>, turns ONLY -> <out.jsonl> (one line per window: window_id, engine, audio_s, turns, env).
Same model + offline config as l4_consume.py (spkcache 264 / fifo 40 / chunk 340 / right-context 40 / update 300). Audio is decoded with soundfile (16 kHz mono int16 is bit-exact to the FLAC),
written to a local temp wav, diarized, deleted. Inputs are NOT deleted (the bucket copy is removed by the owner after the results are verified). Resumable: skips ids already in <out.jsonl>.
usage: hf_consume.py <inbox_dir> <out.jsonl> [--shard i/n] [--limit N]   (NeMo venv; GPU)"""
import glob, json, os, sys, tempfile, time
import numpy as np, soundfile as sf, torch
from nemo.collections.asr.models import SortformerEncLabelModel
inbox, out = sys.argv[1], sys.argv[2]
shard = sys.argv[sys.argv.index("--shard") + 1] if "--shard" in sys.argv else "0/1"; si, sn = (int(x) for x in shard.split("/"))
limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
files = sorted(glob.glob(os.path.join(inbox, "**", "*.flac"), recursive=True) + glob.glob(os.path.join(inbox, "**", "*.wav"), recursive=True))[si::sn][:limit]
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
done = set()
if os.path.exists(out):
    for l in open(out): done.add(json.loads(l)["window_id"])
m = SortformerEncLabelModel.from_pretrained("nvidia/Nemotron-3-Diarization", map_location="cuda").eval()
sm = m.sortformer_modules; sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period = 264, 40, 340, 40, 300; m._check_streaming_parameters()
parse = lambda s: (float(s.split()[0]), float(s.split()[1]), s.split()[2]) if isinstance(s, str) else (float(s[0]), float(s[1]), str(s[2]))
env = dict(torch=torch.__version__, gpu=torch.cuda.get_device_name(0))
tmp = tempfile.mkdtemp(prefix="hfc-"); os.chmod(tmp, 0o700); t0 = time.time(); n = 0; audio_s = 0.0
for p in files:
    wid = os.path.basename(p).rsplit(".", 1)[0]
    if wid in done: continue
    x, sr = sf.read(p, dtype="int16")
    if x.ndim > 1: x = x[:, 0]
    assert sr == 16000, (wid, sr)
    wav = os.path.join(tmp, wid + ".wav"); sf.write(wav, x, 16000, subtype="PCM_16")
    segs = [parse(s) for s in m.diarize(audio=[wav], batch_size=1, verbose=False)[0]]
    dur = len(x) / 16000.0; audio_s += dur
    with open(out, "a") as f: f.write(json.dumps(dict(window_id=wid, engine="nemotron-3", audio_s=round(dur, 1), turns=[[round(a, 3), round(b, 3), s] for a, b, s in segs], env=env)) + "\n")
    os.unlink(wav); n += 1
    if n % 25 == 0: print(f"{n} windows {audio_s / 3600:.1f} audio-h {time.time() - t0:.0f}s ({(time.time() - t0) / max(audio_s / 3600, 1e-9):.1f} s per audio-h)", flush=True)
print(f"done {n} windows {audio_s / 3600:.2f} audio-h in {time.time() - t0:.0f}s on {env['gpu']} torch {env['torch']}", flush=True)
os.rmdir(tmp)
