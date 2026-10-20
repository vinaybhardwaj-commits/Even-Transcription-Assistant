"""ft-engines: score speaker windows with a Timbre catalog extractor (wavlm_aniemore.v1 | emotion2vec_plus_large.v1 | odyssey_wavlm_dim.v1). Numbers only.
Reuses the Timbre extractors in ~/dev/eta-fs-run (no new model code). GPU manners as kit/reb clip_lanes.GpuGate: ~/gpu.lock + 2048 MiB free, held for ONE item
(call / consult) at a time, released between items so the palimpsest hourly lane and the production worker can interleave.
Usage: score_windows.py <spec_name> <windows.jsonl> <out.jsonl> <emb.npy-dir>
windows rows: {item, path, t0, t1, ...}; output = the row (minus path) + scalar features + status; embeddings (if any) -> <emb dir>/<item>.npz keyed by t0.
Resumable: skips (item, t0, t1) already in out."""
import sys, os, json, time, subprocess, collections
import numpy as np
os.environ.setdefault('HF_HUB_OFFLINE', '1')
sys.path.insert(0, os.environ.get('FTE_TIMBRE', '~/dev/eta-fs-run')); sys.path.insert(0, os.environ.get('FTE_KIT', '~/dev/eta-lab-run'))
from tools.timbre.catalog import SPEC_BY_NAME
from tools.timbre.extractors.base import build_extractor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import gpu_manners

spec, win_p, out, embdir = sys.argv[1:5]
os.makedirs(embdir, mode=0o700, exist_ok=True)
W = [json.loads(l) for l in open(win_p)]
key = lambda w: (w['item'], w['t0'], w['t1'])
done = {key(json.loads(l)) for l in open(out)} if os.path.exists(out) else set()
by = collections.defaultdict(list)
for w in W:
    if key(w) not in done: by[w['item']].append(w)
ex = build_extractor(spec, 'cuda')

for i in range(60):   # catalog RAM guard: wait for headroom, never bypass
    try:
        with gpu_manners.hold(): ex._load()
        break
    except Exception as e:
        if type(e).__name__ != 'InsufficientMemory': raise
        print('waiting for RAM', i, flush=True); time.sleep(60)
else: sys.exit('no RAM headroom; nothing written')


def load(p):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', p, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


t0 = time.time(); n = err = 0; rev = None
with open(out, 'a', opener=lambda p, f: os.open(p, f, 0o600)) as fh:
    for k, (item, ws) in enumerate(by.items()):
        try: a = load(ws[0]['path'])
        except Exception as e:
            for w in ws:
                w = {x: v for x, v in w.items() if x != 'path'}; w['status'] = 'decode_error ' + type(e).__name__; fh.write(json.dumps(w) + '\n'); err += 1
            continue
        embs = {}
        with gpu_manners.hold():
            for w in ws:
                w = {x: v for x, v in w.items() if x != 'path'}
                seg = a[int(w['t0'] * 16000):int(w['t1'] * 16000)]
                try:
                    f, e, rev = ex._extract(seg, 16000); w.update(f); w['status'] = 'ok'; w['model_rev'] = rev
                    if e is not None: embs[f"{w['t0']}_{w['t1']}"] = np.asarray(e, dtype=np.float32)
                except Exception as e_:
                    w['status'] = 'error ' + type(e_).__name__; err += 1
                fh.write(json.dumps(w) + '\n'); n += 1
        if embs:
            ep = f'{embdir}/{item}.npz'
            old = dict(np.load(ep)) if os.path.exists(ep) else {}
            old.update(embs); np.savez(ep, **old); os.chmod(ep, 0o600)
        fh.flush()
        if k % 50 == 0: print(spec, 'items', k, '/', len(by), 'windows', n, 'err', err, 's', round(time.time() - t0), flush=True)
print('DONE', spec, 'scored', n, 'errors', err, 's', round(time.time() - t0, 1), 'rev', rev, flush=True)
