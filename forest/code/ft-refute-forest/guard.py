# Refuter H-seal check: every input -> cluster_key -> split_guard.require_dev. Counts only.
import sys, os, glob, hashlib, pandas as pd
sys.path.insert(0, os.path.expanduser('~/wt/forest-rd0/studies/2026-10-16-runo-linkage/split'))
import split_guard as sg
G = sg.load(pinned_list_sha256='52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65')
assert G.list_sha256.startswith('52959278edd8') and G.seed_sha256.startswith('3b10cbf1f278'), 'pins'
print('guard', G.lock_id, 'list', G.list_sha256[:12], 'seed', (G.seed_sha256 or '')[:12], 'seed file verified', G.seed is not None, 'n_H', G.n_held_out())
O = os.path.expanduser('~/oc/forest-lead/ft/out')
lab = pd.read_parquet(f'{O}/ft-labels-base/labels.parquet')
ep2ck = dict(zip(lab.episode_id, lab.cluster_key))
calls = pd.read_parquet(f'{O}/ft-calltext/calls_D.parquet', columns=['call_id', 'episode_id'])
rlc = pd.read_parquet(os.path.expanduser('~/eta-data/forest/rl/feat/calls_basic.parquet'), columns=['call_id', 'episode_id'])
c2e = {**dict(zip(rlc.call_id, rlc.episode_id)), **dict(zip(calls.call_id, calls.episode_id))}
dc = pd.read_parquet(f'{O}/ft-audio/designC_cohort.parquet'); cu2ck = dict(zip(dc.consult_uid, dc.cluster_key))
fa = pd.read_parquet(f'{O}/ft-audio/features_ale.parquet'); cu2ck.update({k: v for k, v in zip(fa.consult_uid, fa.cluster_key) if pd.notna(v)})
def sha(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()[:12]
def keys(p):
    d = pd.read_parquet(p) if p.endswith('.parquet') else pd.read_json(p, lines=True)
    if 'cluster_key' in d and d.cluster_key.notna().all(): return d.cluster_key, len(d), 'cluster_key'
    if 'episode_id' in d and d.episode_id.notna().all(): return d.episode_id.map(ep2ck), len(d), 'episode_id'
    if 'consult_uid' in d:
        k = d.consult_uid.map(cu2ck)
        if 'episode_id' in d: k = k.fillna(d.episode_id.map(ep2ck))
        return k, len(d), 'consult_uid'
    return d.call_id.map(c2e).map(ep2ck), len(d), 'call_id'
F = ['ft-labels-base/features_D.parquet', 'ft8-clinical/features_ft8.parquet', 'ft-calltext/calls_D.parquet', 'ft-calltext/episodes_D.parquet',
     'ft-text2/tags_D_jev.jsonl', 'ft-text2/rlfeat_tags_jev.jsonl', 'ft-text2/bolna_episode_feats.parquet', 'ft-engines/engine_feats_calls.parquet',
     'ft-engines/engine_feats_consults.parquet', 'ft-bench/bench_layer8.parquet', 'ft-bench/bench_layer8_c.parquet', 'ft-audio/designC_cohort.parquet',
     'ft-audio/features_ale.parquet', 'ft-bench/bench_scores-frozen-0910.parquet', 'ft-bench/bench_scores_c.parquet', os.path.expanduser('~/eta-data/forest/rl/feat/calls_basic.parquet')]
for f in F:
    p = f if f.startswith('/') else f'{O}/{f}'
    k, n, via = keys(p); miss = int(k.isna().sum())
    G.require_dev(k.dropna().astype(str).tolist(), context=os.path.basename(p))
    print(f'{os.path.basename(p):40s} sha {sha(p)} rows {n:5d} via {via:12s} unmapped {miss} H 0 (require_dev passed)')
lab_h = (lab.split == 'H').sum(); print('labels.parquet has', lab_h, 'H rows by split column: NOT used; refuter filters split==D before anything')
