"""ft-engines: Nemotron-3 diarization on Runo call audio (set A). Reuses kit/reb clip_lane_engines.Nemotron (stock nvidia/Nemotron-3-Diarization at the pinned
revision, offline 30.4 s setting, local HF cache only). Run in ~/eta-data/nemotron/venv-nemo-main. GPU: kit/reb clip_lanes.GpuGate per call.
Usage: nemo_diar.py <manifest.tsv> <out.jsonl>   D split + in_shard a/b/c only (same filter as ft-rl-feat rlf_prep). Resumable. Output: {call_id, status, segments:[[t0,t1,spk]]}."""
import sys, os, json, time, tempfile
import pandas as pd
sys.path.insert(0, os.environ.get('FTE_KIT', '~/dev/eta-lab-run'))
from kit.reb.clip_lane_engines import Nemotron, decode_f32, write_wav16, SR16, NEMOTRON_REV
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import gpu_manners

LAB = os.environ.get('FTE_LAB', '~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet')
man, out = sys.argv[1:3]
m = pd.read_csv(man, sep='\t', dtype=str).drop_duplicates('key_id')
m = m[m.in_shard.isin(['a', 'b', 'c'])]
lab = pd.read_parquet(LAB); D = set(lab[lab.split == 'D'].episode_id)
m = m[m.episode_id.isin(D)]
done = {json.loads(l)['call_id'] for l in open(out)} if os.path.exists(out) else set()
todo = [r for r in m.itertuples() if r.key_id not in done]
print('calls', len(m), 'todo', len(todo), flush=True)

with gpu_manners.hold(): eng = Nemotron('cuda')
t0 = time.time(); ok = err = 0
with open(out, 'a', opener=lambda p, f: os.open(p, f, 0o600)) as fh, tempfile.TemporaryDirectory(prefix='fte-nemo-') as td:
    for k, r in enumerate(todo):
        row = dict(call_id=r.key_id, episode_id=r.episode_id, model=Nemotron.model, model_rev=NEMOTRON_REV)
        try:
            x = decode_f32(r.path, SR16)
            wav = write_wav16(x, os.path.join(td, 'c.wav'))
            with gpu_manners.hold(): segs = eng.diarize(wav)
            row.update(status='ok', dur_s=round(len(x) / SR16, 2), segments=[[round(a, 3), round(b, 3), s] for a, b, s in segs]); ok += 1
        except Exception as e:
            row.update(status='error ' + type(e).__name__); err += 1
        fh.write(json.dumps(row) + '\n'); fh.flush()
        if k % 50 == 0: print('nemo', k, '/', len(todo), 'ok', ok, 'err', err, 's', round(time.time() - t0), flush=True)
print('DONE nemo ok', ok, 'err', err, 's', round(time.time() - t0, 1), flush=True)
