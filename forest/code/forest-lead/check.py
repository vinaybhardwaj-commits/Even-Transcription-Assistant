# ref1 independent checker. Usage: check.py <out> <work>. Prints counts/ids only. Exit code = n failures.
import sys, os, json, re, glob, collections
import numpy as np, pandas as pd
OUT, WORK = sys.argv[1:3]
RLF = os.path.expanduser('~/eta-data/forest/rl/feat'); LAB = os.environ.get('REF_LAB') or os.path.expanduser('~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet')
FAIL = []
def chk(name, ok, info=''):
    print(('PASS ' if ok else 'FAIL ') + name, info); (None if ok else FAIL.append(name))
def jl(p): return [json.loads(l) for l in open(p)]
lab = pd.read_parquet(LAB); H = set(lab.episode_id[lab.split == 'H']); Dl = lab[lab.split == 'D'].set_index('episode_id')
F = pd.read_parquet(f'{OUT}/engine_feats_calls.parquet'); PC = pd.read_parquet(f'{OUT}/engine_calls_percall.parquet')
# ---- (a) eligibility, own reimplementation of rlf_assemble lines 37-53
cb = pd.read_parquet(f'{RLF}/calls_basic.parquet'); tg = {}
for r in jl(f'{RLF}/tags.jsonl'): tg[r['call_id']] = r
tagged = cb.call_id.map(lambda c: c in tg and tg[c].get('intent') is not None)
orv = cb.call_id.map(lambda c: bool(tg.get(c, {}).get('outcome_revealed') or False))
ev = pd.to_datetime(cb.episode_id.map(Dl.event_date)); post = ev.notna() & cb.call_day.notna() & (cb.call_day >= ev)
E = {}
for T in (3, 7, 14):
    E[T] = set(cb.call_id[cb[f'in_t{T}'].fillna(False).astype(bool) & cb.stt_status.eq('ok') & ~post & tagged & ~orv])
    chk(f'elig_t{T} percall == own rule', set(PC.call_id[PC[f'elig_t{T}']]) == E[T], f'n={len(E[T])}')
    # no eligible call with day_from_rx >= T / post-event / outcome_revealed
    bad = cb[cb.call_id.isin(E[T]) & ((cb.day_from_rx >= T) | post | orv)]
    chk(f'no late/post/orv call in elig_t{T}', len(bad) == 0, len(bad))
print('info outcome_revealed', int(orv.sum()), 'post_event', int(post.sum()), 'untagged stt-ok', int((~tagged & cb.stt_status.eq('ok')).sum()))
# windows + engines, own join at 2 dp
def key(r, it): return (r[it], round(r['t0'], 2), round(r['t1'], 2))
W = pd.DataFrame(jl(f'{WORK}/winA_role.jsonl')); W['k'] = [key(r, 'call_id') for r in W.to_dict('records')]
ody = {key(r, 'call_id'): r for r in jl(f'{RLF}/emo.jsonl') if r.get('status') == 'ok'}
e2v = {key(r, 'call_id'): r for r in jl(f'{WORK}/A_e2v.jsonl') if r.get('status') == 'ok'}
wav = {key(r, 'call_id'): r for r in jl(f'{WORK}/A_wavlm.jsonl') if r.get('status') == 'ok'}
for n, d in (('ody', ody), ('e2v', e2v), ('wavlm', wav)):
    chk(f'(c) A window keys join {n}', W.k.isin(d).all(), f'{int(W.k.isin(d).sum())}/{len(W)} engine_keys={len(d)}')
W['ody_v'] = W.k.map(lambda k: ody.get(k, {}).get('valence', np.nan)); W['e2v_h'] = W.k.map(lambda k: e2v.get(k, {}).get('score_happy', np.nan))
W['e2v_neg'] = W.k.map(lambda k: sum(e2v[k][f'score_{x}'] for x in ('angry', 'disgusted', 'fearful')) if k in e2v else np.nan)
W['wav_n'] = W.k.map(lambda k: wav.get(k, {}).get('neutral', np.nan))
C = pd.DataFrame(jl(f'{WORK}/A_clef.jsonl')); C = C[C.status == 'ok']
Fi = F.set_index('episode_id'); ep_calls = cb.groupby('episode_id').call_id.apply(set)
mism = collections.Counter(); ncmp = collections.Counter()
for ep in Fi.index:
    for T in (3, 7, 14):
        ids = ep_calls.get(ep, set()) & E[T]; w = W[W.call_id.isin(ids)]
        exp = {f'n_calls_t{T}': len(ids), f'ody_patient_valence_mean_t{T}': w[w.role == 'patient'].ody_v.mean(), f'e2v_patient_happy_mean_t{T}': w[w.role == 'patient'].e2v_h.mean(),
               f'e2v_counsellor_negative_mean_t{T}': w[w.role == 'counsellor'].e2v_neg.mean(), f'wavlm_all_neutral_mean_t{T}': w.wav_n.mean(), f'ody_all_n_win_t{T}': len(w),
               f'clef_patient_valence_t{T}': C[C.item.isin(ids) & (C.role == 'patient')].valence.mean(), f'clef_all_n_t{T}': int((C.item.isin(ids) & (C.role == 'all')).sum())}
        for c, v in exp.items():
            g = Fi.at[ep, c]; ncmp[c[:-len(str(T)) - 2]] += 1
            if not ((pd.isna(g) and pd.isna(v)) or (not pd.isna(g) and not pd.isna(v) and abs(g - v) < 1e-9)): mism[c] += 1
chk('(a) recomputed episode values match (8 cols x 3 T x all eps)', not mism, dict(mism) or f'{sum(ncmp.values())} cells')
# leakage sensitivity: values differ if all calls used (shows the check has power)
lab_cols = {'h14', 'h90', 'days_to_surgery', 'age_days', 'ale', 'split'}
susp = [c for c in F.columns if re.search(r'surg|outcome|reveal|book|convert|decid|admit|event|label|price|h14|h90|^ale', c) and c not in lab_cols]
chk('(a) no outcome-ish feature column', not susp, susp[:5]); chk('(a) label cols only the documented masks', lab_cols & set(F.columns) == lab_cols - {'split'} | {'split'} & set(F.columns), sorted(lab_cols & set(F.columns)))
ck = set().union(*[set(r) for r in jl(f'{WORK}/A_clef.jsonl')]) | set().union(*[set(r) for r in jl(f'{WORK}/B_clef.jsonl')])
chk('(a) Clef raw fields carry no outcome field', not [k for k in ck if re.search(r'surg|outcome|book|decid|convert|admit', k)], sorted(ck))
# ---- (b) H split
for f in sorted(glob.glob(f'{OUT}/*.parquet')):
    d = pd.read_parquet(f); n = len(set(d.episode_id.dropna()) & H) if 'episode_id' in d else 0
    chk(f'(b) no H episode in {os.path.basename(f)}', n == 0, n)
txt = ''.join(open(f, errors='ignore').read() for f in glob.glob(f'{OUT}/*.md') + glob.glob(f'{OUT}/*.tsv'))
chk('(b) no H episode id in md/tsv', not (set(re.findall(r'\b[0-9a-f]{16}\b', txt)) & H))
chk('(b) calls episodes all D', F.episode_id.isin(Dl.index).all() and F.split.eq('D').all(), len(F))
B = pd.read_parquet(f'{OUT}/engine_feats_consults.parquet'); G = pd.read_csv(f'{OUT}/consults_split_guard.tsv', sep='\t')
chk('(b) guard covers all 211 consults, none H', set(G.consult_uid) == set(B.consult_uid) and not G.guard.str.contains('H').any(), G.guard.value_counts().to_dict())
nl = B[B.consult_uid.isin(G.consult_uid[G.guard.str.startswith('not_a_linked')])]
chk('(b) not-linked consults: episode split D in labels', nl.episode_id.map(lab.set_index('episode_id').split).eq('D').all(), f'{len(nl)} consults, eps={nl.episode_id.nunique()}')
# ---- (c) roles consistency + B joins + gcp vs the lab box + embeddings
R = pd.read_parquet(f'{WORK}/calls_roles.parquet').set_index('call_id')
N = {r['call_id']: r for r in jl(f'{WORK}/A_nemo.jsonl')}; bad = 0; nonrole = 0
for r in W[W.role.notna()].itertuples():
    rs = R.at[r.call_id, 'role_src']
    if rs in ('single_speaker', 'no_diar'): nonrole += 1; continue
    segs = N[r.call_id]['segments']; o = collections.Counter(); tk = collections.Counter()
    for a, b, s in segs: o[s] += max(0, min(b, r.t1) - max(a, r.t0)); tk[s] += b - a
    s = o.most_common(1)[0][0]; top2 = [x for x, _ in tk.most_common(2)]; share = tk[s] / sum(tk[x] for x in top2) if s in top2 else -1
    if abs(share - R.at[r.call_id, f'{r.role}_talk_share']) > 1e-6: bad += 1
chk('(c) window role == calls_roles speaker role (talk-share identity)', bad == 0 and nonrole == 0, f'bad={bad} nonrole={nonrole} of {int(W.role.notna().sum())}')
chk('(c) percall role_src == calls_roles', (PC.set_index('call_id').role_src.reindex(R.index).fillna('no_diar') == R.role_src).all())
WB = jl(f'{WORK}/winB.jsonl') + jl(f'{WORK}/winB2.jsonl'); kb = {key(r, 'consult_uid') for r in WB}
for eng, fs in (('wavlm', ['B_wavlm.jsonl', 'gcp/B_wavlm.jsonl', 'gcp/B2_wavlm.jsonl']), ('e2v', ['B_e2v.jsonl', 'gcp/B_e2v.jsonl', 'gcp/B2_e2v.jsonl'])):
    the lab box = {key(r, 'consult_uid'): r for r in jl(f'{WORK}/{fs[0]}') if r['status'] == 'ok'}; gc = {key(r, 'consult_uid'): r for f in fs[1:] for r in jl(f'{WORK}/{f}') if r['status'] == 'ok'}
    col = 'neutral' if eng == 'wavlm' else 'score_neutral'; both = set(the lab box) & set(gc)
    dif = max((abs(the lab box[k][col] - gc[k][col]) for k in both), default=0); cl = [c for c in the lab box[next(iter(both))] if isinstance(the lab box[next(iter(both))][c], float) and c not in ('t0','t1')]; agree = np.mean([max(cl, key=lambda c: the lab box[k][c]) == max(cl, key=lambda c: gc[k][c]) for k in both]); revs = {r['model_rev'] for r in list(the lab box.values()) + list(gc.values())}
    chk(f'(c) B {eng} gcp vs the lab box agree on overlap', agree >= 0.98 and len(revs) == 1, f'the lab box={len(the lab box)} gcp={len(gc)} overlap={len(both)} t4_only={len(set(the lab box)-set(gc))} maxdiff={dif:.4f} argmax_agree={agree:.4f} revs={len(revs)}')
    print(f'info B {eng} window keys ok', len(kb & (set(the lab box) | set(gc))), '/', len(kb))
gB = {key(r, 'consult_uid'): r['neutral'] for f in ('B_wavlm.jsonl', 'gcp/B_wavlm.jsonl', 'gcp/B2_wavlm.jsonl') for r in jl(f'{WORK}/{f}') if r['status'] == 'ok'}
WBd = pd.DataFrame([dict(c=r['consult_uid'], ro='doctor' if r['who'] == 'doctor' else 'patient', v=gB.get(key(r, 'consult_uid'), np.nan)) for r in WB]).drop_duplicates()
bm = 0
for ro in ('patient', 'doctor'):
    m = WBd[WBd.ro == ro].groupby('c').v.mean(); g = B.set_index('consult_uid')[f'wavlm_{ro}_neutral_mean']
    bm += int(sum(not ((pd.isna(g[c]) and pd.isna(m.get(c, np.nan))) or abs(g[c] - m.get(c, np.nan)) < 1e-9) for c in g.index))
chk('(c) B wavlm per-consult means recomputed (gcp-priority)', bm == 0, f'mismatch={bm}/{2*len(B)}')
EA = pd.read_parquet(f'{OUT}/engine_wavlm_emb_calls.parquet'); bad = 0; n = 0
for r in EA.itertuples():
    n += 1; bad += int(Fi.at[r.episode_id, f'wavlm_{r.role}_n_win_t{r.T}'] != r.n_win)
nexp = sum(int((F[f'wavlm_{ro}_n_win_t{T}'] > 0).sum()) for T in (3, 7, 14) for ro in ('patient', 'counsellor', 'all'))
chk('(c) A emb n_win == feats wavlm n_win; row count', bad == 0 and n == nexp, f'rows={n} exp={nexp} bad={bad} dims={sum(c.startswith("e") and c[1:].isdigit() for c in EA.columns)}')
EB = pd.read_parquet(f'{OUT}/engine_wavlm_emb_consults.parquet'); Bi = B.set_index('consult_uid')
bad = sum(int(Bi.at[r.consult_uid, f'wavlm_{r.role}_n_win'] != r.n_win) for r in EB.itertuples())
nexp = sum(int((B[f'wavlm_{ro}_n_win'] > 0).sum()) for ro in ('patient', 'doctor', 'all'))
chk('(c) B emb n_win == feats wavlm n_win; row count', bad == 0 and len(EB) == nexp, f'rows={len(EB)} exp={nexp} bad={bad}')
# ---- (d) coverage spot recompute
cov = open(f'{OUT}/COVERAGE.md').read()
for T in (3, 7, 14):
    lt = F[F[f'n_calls_t{T}'] > 0]; ar = F[F.h14.notna() & ~(F.days_to_surgery <= T)]
    row = f'| {T} | h14 | {len(ar)} | {int(ar.h14.sum())} | {int((ar[f"n_calls_t{T}"] > 0).sum())} |'
    chk(f'(d) COVERAGE T={T} h14 cells', row in cov, row)
chk('(d) role_src counts', str(dict(sorted(R.role_src.value_counts().items(), key=lambda x: -x[1]))) in cov.replace("'", "'"), R.role_src.value_counts().to_dict())
chk('(d) window counts 9823 / calls 911', f'| ody | window | {len(W)} |' in cov and f'| ody | call | {W.call_id.nunique()} |' in cov, (len(W), W.call_id.nunique()))
print('FAILURES', len(FAIL), FAIL); sys.exit(len(FAIL))
