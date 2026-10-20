"""ft-rl-feat step 2 (timbre-nightly venv, the lab box GPU): Odyssey WavLM valence/arousal/dominance on the windows from rlf_prep. Numbers only.
Reuses ft-audio's setup (OdysseyExtractor odyssey_wavlm_dim.v1, offline cached weights). Resumable (appends; skips done call/who/t0).
Usage: rlf_emo.py <windows.jsonl> <emo.jsonl>   (audio decoded to 16 kHz mono with ffmpeg, in memory only)"""
import sys, os, json, time, subprocess, collections
import numpy as np
os.environ.setdefault('HF_HUB_OFFLINE', '1')
sys.path.insert(0, '~/dev/eta-fs-run')
from tools.timbre.catalog import SPEC_BY_NAME
from tools.timbre.extractors.odyssey_wavlm import OdysseyExtractor

W = [json.loads(l) for l in open(sys.argv[1])]; out = sys.argv[2]
key = lambda w: (w['call_id'], w['who'], w['t0'])
done = {key(json.loads(l)) for l in open(out)} if os.path.exists(out) else set()
by = collections.defaultdict(list)
for w in W:
    if key(w) not in done: by[w['call_id']].append(w)
ex = OdysseyExtractor(SPEC_BY_NAME['odyssey_wavlm_dim.v1'], 'cuda')
# the host is shared and RAM-tight: honour the catalog RAM guard (3.5 GB) by waiting for headroom instead of bypassing it; never write error rows for a failed load
for i in range(int(os.environ.get('RLF_WAIT_TRIES', '60'))):
    try: ex._load(); break
    except Exception as e:
        if type(e).__name__ != 'InsufficientMemory': raise
        print('waiting for RAM', i, flush=True); time.sleep(60)
else: sys.exit('no RAM headroom for Odyssey; nothing written')


def load(p):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


t0 = time.time(); n = err = 0
with open(out, 'a', opener=lambda p, f: os.open(p, f, 0o600)) as fh:
    for cid, ws in by.items():
        try: a = load(ws[0]['path'])
        except Exception as e:
            for w in ws: w.update(status='decode_error ' + type(e).__name__); fh.write(json.dumps(w) + '\n'); err += 1
            continue
        for w in ws:
            w = {k: v for k, v in w.items() if k != 'path'}
            try:
                f, _, _ = ex._extract(a[int(w['t0'] * 16000):int(w['t1'] * 16000)], 16000); w.update(f); w['status'] = 'ok'
            except Exception as e: w['status'] = 'error ' + type(e).__name__; err += 1
            fh.write(json.dumps(w) + '\n'); n += 1
        fh.flush()
print('scored', n, 'errors', err, 's', round(time.time() - t0, 1))
