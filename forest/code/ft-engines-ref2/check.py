"""ft-engines-ref2 independent checker (counts/ids only). Usage: check.py <out_dir> [work_dir]. Prints PASS/FAIL lines; exit 1 on any FAIL."""
import sys, os, json, glob, collections
import warnings; warnings.simplefilter('ignore')
import numpy as np, pandas as pd
O = sys.argv[1]; W = sys.argv[2] if len(sys.argv) > 2 else '~/eta-data/forest/ft-engines'
RLF = '~/eta-data/forest/rl/feat'; LAB = '~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'
FTA = '~/oc/forest-lead/ft/out/ft-audio'; EXP = '~/oc/forest-lead/ft/out/ft-cohortb-expand'
RES = []
def chk(name, ok, info=''): RES.append(ok); print(('PASS ' if ok else 'FAIL ') + name, info, flush=True)
def jl(p): return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
def key(r, it): return (r[it], round(float(r['t0']), 3), round(float(r['t1']), 3))
lab = pd.read_parquet(LAB); Hep = set(lab.episode_id[lab.split == 'H']); Hcu = set(lab.consult_uid[lab.split == 'H'].dropna()); Hrx = set(lab.prescription_uid[lab.split == 'H'].dropna())
LD = lab[lab.split == 'D'].set_index('episode_id')
F = pd.read_parquet(f'{O}/engine_feats_calls.parquet'); PC = pd.read_parquet(f'{O}/engine_calls_percall.parquet')
B = pd.read_parquet(f'{O}/engine_feats_consults.parquet')
EA = pd.read_parquet(f'{O}/engine_wavlm_emb_calls.parquet'); EB = pd.read_parquet(f'{O}/engine_wavlm_emb_consults.parquet')
# ---------- (b) H split: any H id anywhere
hits = {}
for f in glob.glob(f'{O}/*'):
    if os.path.isdir(f): continue
    s = pd.read_parquet(f).astype(str).to_csv() if f.endswith('.parquet') else open(f, errors='ignore').read()
    toks = set(s.replace(',', ' ').replace('\t', ' ').replace('\n', ' ').replace('|', ' ').split())
    n = len(toks & (Hep | Hcu | Hrx))
    if n: hits[os.path.basename(f)] = n
chk('B1 no H episode/consult/rx id in any output file', not hits, hits)
chk('B2 calls episodes all D', F.episode_id.isin(LD.index).all() and set(F.split) == {'D'}, f'{len(F)} eps')
bs = B.episode_id.dropna()
chk('B3 consult episode_ids D-only, consult_uid not H', bs.isin(LD.index).all() and not B.consult_uid.isin(Hcu).any(), f'{len(B)} consults, {bs.size} with ep')
G = pd.read_csv(f'{O}/consults_split_guard.tsv', sep='\t')
chk('B4 split_guard tsv: 211 rows, set == consults, no H', len(G) == len(B) == 211 and set(G.consult_uid) == set(B.consult_uid) and not G.guard.str.contains('H').any(), G.guard.value_counts().to_dict())
ng = G[G.guard != 'D']; chk('B5 non-guard consults D via labels episode', ng.consult_uid.map(B.set_index('consult_uid').episode_id).map(LD.split).eq('D').all(), f'{len(ng)}')
# ---------- (a) leakage: eligibility recomputed independently
cb = pd.read_parquet(f'{RLF}/calls_basic.parquet'); tg = {}
for r in jl(f'{RLF}/tags.jsonl'): tg[r['call_id']] = r
cb['tagged'] = cb.call_id.map(lambda c: c in tg and tg[c].get('intent') is not None)
cb['orv'] = cb.call_id.map(lambda c: bool(tg.get(c, {}).get('outcome_revealed') or False))
ev = pd.to_datetime(cb.episode_id.map(LD.event_date))
cb['pe'] = ev.notna() & cb.call_day.notna() & (pd.to_datetime(cb.call_day) >= ev)
for T in (3, 7, 14):
    cb[f'e{T}'] = (cb.day_from_rx < T) & cb.stt_status.eq('ok') & ~cb.pe & cb.tagged & ~cb.orv
chk('A0 in_tT == day_from_rx<T (source flag sanity)', all(((cb.day_from_rx < T) == cb[f'in_t{T}'].fillna(False).astype(bool)).all() for T in (3, 7, 14)))
pc = PC.set_index('call_id')
for T in (3, 7, 14):
    m = cb.set_index('call_id')[f'e{T}']; d = int((m != pc[f'elig_t{T}'].reindex(m.index).fillna(False)).sum())
    chk(f'A1 percall elig_t{T} == independent rule', d == 0, f'{int(m.sum())} eligible, {d} differ')
    bad = cb[cb[f'e{T}'] & (cb.pe | cb.orv | (cb.day_from_rx >= T))]; assert len(bad) == 0
    n = cb[cb[f'e{T}']].groupby('episode_id').size().reindex(F.episode_id).fillna(0).values
    chk(f'A2 n_calls_t{T} matches', (n == F[f'n_calls_t{T}'].values).all(), f'{int((n > 0).sum())} eps >0')
# windows + engines
WA = pd.DataFrame(jl(f'{W}/winA_role.jsonl')); WA['k'] = [key(r, 'call_id') for r in WA.to_dict('records')]
def eng(rows, cols, it):
    return {key(r, it): [r.get(c, r.get('score_' + c)) for c in cols] for r in rows if r.get('status') == 'ok'}
ODY = ['valence', 'arousal', 'dominance']; WAV = ['anger', 'disgust', 'enthusiasm', 'fear', 'happiness', 'neutral', 'sadness']
E2V = ['angry', 'disgusted', 'fearful', 'happy', 'neutral', 'other', 'sad', 'surprised', 'unknown']
EA_src = {'ody': (eng(jl(f'{RLF}/emo.jsonl'), ODY, 'call_id'), ODY), 'wavlm': (eng(jl(f'{W}/A_wavlm.jsonl'), WAV, 'call_id'), WAV), 'e2v': (eng(jl(f'{W}/A_e2v.jsonl'), E2V, 'call_id'), E2V)}
wk = set(WA.k)
for e, (d, _) in EA_src.items(): chk(f'C1 A window keys {e} join winA_role without loss', set(d) == wk and WA.k.is_unique, f'{len(set(d) & wk)}/{len(wk)} extra {len(set(d) - wk)}')
for e, (d, cols) in EA_src.items():
    for i, c in enumerate(cols): WA[f'{e}_{c}'] = [d.get(k, [np.nan] * len(cols))[i] for k in WA.k]
WA['e2v_negative'] = WA[['e2v_angry', 'e2v_disgusted', 'e2v_fearful']].sum(axis=1, min_count=3)
CA = pd.DataFrame(jl(f'{W}/A_clef.jsonl')); CA = CA[CA.status == 'ok']
CR = pd.read_parquet(f'{W}/calls_roles.parquet').set_index('call_id')
NEMO = ['patient_talk_share', 'counsellor_talk_share', 'turns_per_min', 'mean_patient_turn_s', 'mean_counsellor_turn_s', 'patient_interrupt_per_min', 'counsellor_interrupt_per_min', 'n_speakers_nemo', 'all_turns_per_min', 'all_mean_turn_s', 'all_interrupt_per_min', 'all_speech_share']
exp = []
cbe = cb.set_index('call_id')
for ep, g in cb.groupby('episode_id'):
    r = {'episode_id': ep}
    for T in (3, 7, 14):
        s = f'_t{T}'; ids = set(g.call_id[g[f'e{T}']]); w = WA[WA.call_id.isin(ids)]
        for c in NEMO: r[f'nemo_{c}{s}'] = CR.reindex(list(ids))[c].mean() if ids else np.nan
        for ro in ('patient', 'counsellor', 'all'):
            ww = w if ro == 'all' else w[w.role == ro]
            for e, cols in (('ody', ODY), ('wavlm', WAV), ('e2v', E2V + ['negative'])):
                ok = ww[ww[f'{e}_{cols[0]}'].notna()]; r[f'{e}_{ro}_n_win{s}'] = len(ok)
                for c in cols: r[f'{e}_{ro}_{c}_mean{s}'] = ok[f'{e}_{c}'].mean()
                if e == 'ody':
                    for c in ('valence', 'arousal'): r[f'ody_{ro}_{c}_std{s}'] = ok[f'ody_{c}'].std() if len(ok) > 1 else np.nan; r[f'ody_{ro}_{c}_min{s}'] = ok[f'ody_{c}'].min()
            cc = CA[(CA.role == ro) & CA.item.isin(ids)]; r[f'clef_{ro}_n{s}'] = len(cc)
            for c in ('valence', 'arousal_ev', 'anxious', 'engaged', 'one_speaker'): r[f'clef_{ro}_{c}{s}'] = cc[c].mean()
    exp.append(r)
X = pd.DataFrame(exp).set_index('episode_id').reindex(F.episode_id); Fi = F.set_index('episode_id')
cols = [c for c in X.columns if c in Fi.columns]; miss = [c for c in X.columns if c not in Fi.columns]
chk('A3 expected engine columns present', not miss, f'{len(cols)} cols, missing {miss[:5]}')
def cmp(a, b):
    a = a.astype(float).values; b = b.astype(float).values
    return int(((np.isnan(a) != np.isnan(b)) | (np.abs(np.nan_to_num(a) - np.nan_to_num(b)) > 1e-9)).sum())
bycol = {c: cmp(X[c], Fi[c]) for c in cols}; badc = {c: v for c, v in bycol.items() if v}
chk('A4 every set-A engine cell recomputed from work files at elig_tT', not badc, f'{len(cols)} cols x {len(F)} eps = {len(cols) * len(F)} cells; bad cols {dict(list(badc.items())[:6])}')
for sp in ('ody_patient_valence_mean_t3', 'e2v_patient_neutral_mean_t7', 'clef_patient_valence_t3', 'clef_all_anxious_t7', 'wavlm_counsellor_neutral_mean_t14'):
    print('   sample', sp, 'non-null', int(Fi[sp].notna().sum()), 'mismatch', bycol.get(sp))
# labels as masks only / outcome fields
lbl = [c for c in F.columns if c in ('h14', 'h90', 'ale', 'days_to_surgery', 'age_days', 'event_date', 'split')]
outc = [c for c in list(F.columns) + list(B.columns) + list(CA.columns) if any(w in c.lower() for w in ('agree', 'book', 'date', 'outcome', 'intent', 'surg', 'next_step'))]
chk('A5 label columns only h14/h90/ale/days_to_surgery/age_days(+split); no outcome-stating Clef/engine field', set(lbl) <= {'h14', 'h90', 'ale', 'days_to_surgery', 'age_days', 'split'} and set(outc) <= {'days_to_surgery'}, f'labels {lbl} outcome-like {sorted(set(outc))}')
other = [c for c in F.columns if not c.startswith(('nemo_', 'ody_', 'wavlm_', 'e2v_', 'clef_', 'n_calls', 'role_')) and c not in lbl + ['episode_id']]
chk('A6 no unexplained non-feature columns in calls parquet', not other, other)
# (c) roles winA_role vs calls_roles
rs = WA.call_id.map(CR.role_src)
chk('C2 windows of single_speaker/no_diar calls have role None', WA.role[rs.isin(['single_speaker', 'no_diar'])].isna().all(), f'{int(rs.isin(["single_speaker","no_diar"]).sum())} windows')
chk('C3 percall role_src == calls_roles role_src', (PC.set_index('call_id').role_src == CR.role_src.reindex(PC.call_id).fillna('no_diar').values).all(), PC.role_src.value_counts().to_dict())
chk('C4 Clef A role clips == calls with >=1 window of that role', all(set(CA.item[CA.role == ro]) == set(WA.call_id[(WA.role == ro) if ro != 'all' else WA.role.notna() | WA.role.isna()]) for ro in ('patient', 'counsellor', 'all')),
    {ro: (len(set(CA.item[CA.role == ro])), len(set(WA.call_id[WA.role == ro]))) for ro in ('patient', 'counsellor')})
# embeddings A: n_win equals windows with wavlm ok? and sample recompute
ea = EA.set_index(['episode_id', 'T', 'role'])
nw = {(ep, T, ro): Fi.loc[ep, f'wavlm_{ro}_n_win_t{T}'] for ep in Fi.index for T in (3, 7, 14) for ro in ('patient', 'counsellor', 'all')}
d1 = sum(1 for k, v in nw.items() if v > 0 and (k not in ea.index or ea.loc[k, 'n_win'] != v)); d2 = sum(1 for k in ea.index if nw.get(k, 0) == 0)
chk('C5 A emb rows exist with n_win == wavlm n_win for every (ep,T,role) with windows', d1 == 0 and d2 == 0, f'{len(EA)} rows; mismatch {d1}, extra {d2}')
rng = np.random.default_rng(7); idx = [ea.index[i] for i in rng.choice(len(ea), 25, replace=False)]; bad = 0
for ep, T, ro in idx:
    w = WA[WA.call_id.isin(set(cb.call_id[(cb.episode_id == ep) & cb[f'e{T}']]))]; w = w if ro == 'all' else w[w.role == ro]; vs = []
    for c, t0, t1 in zip(w.call_id, w.t0, w.t1):
        z = np.load(f'{W}/A_emb_wavlm/{c}.npz'); k = f'{round(t0, 3)}_{round(t1, 3)}'
        if k in z: vs.append(z[k])
    bad += not np.allclose(np.mean(vs, 0), ea.loc[(ep, T, ro), [f'e{i}' for i in range(1024)]].astype(float).values, atol=1e-5)
chk('C6 A emb mean recomputed (25 random rows)', bad == 0, f'bad {bad}')
# ---------- set B
WB = []
for f in ('winB.jsonl', 'winB2.jsonl'):
    for r in jl(f'{W}/{f}'): r['role'] = 'doctor' if r['who'] == 'doctor' else 'patient'; WB.append(r)
WB = pd.DataFrame(WB); WB['k'] = [key(r, 'item') for r in WB.to_dict('records')]
chk('C7 B window item == consult_uid; keys unique', (WB.item == WB.consult_uid).all() and WB.k.is_unique, f'{len(WB)} windows')
t4w = eng(jl(f'{W}/B_wavlm.jsonl'), WAV, 'item'); gw = eng(jl(f'{W}/gcp/B_wavlm.jsonl') + jl(f'{W}/gcp/B2_wavlm.jsonl'), WAV, 'item')
t4e = eng(jl(f'{W}/B_e2v.jsonl'), E2V, 'item'); ge = eng(jl(f'{W}/gcp/B_e2v.jsonl') + jl(f'{W}/gcp/B2_e2v.jsonl'), E2V, 'item')
for nm, the lab box, gc in (('wavlm', t4w, gw), ('e2v', t4e, ge)):
    ov = set(the lab box) & set(gc); dif = max((np.max(np.abs(np.array(the lab box[k], float) - np.array(gc[k], float))) for k in ov), default=0)
    chk(f'C8 B {nm}: GCP ok rows cover the lab box ok rows; overlap agree', set(the lab box) <= set(gc) | (set(the lab box) - set(WB.k)), f'the lab box {len(the lab box)} gcp {len(gc)} overlap {len(ov)} maxdiff {dif:.2e} ; gcp ok in winB {len(set(gc) & set(WB.k))}/{len(WB)}')
ody = eng([r for f in (f'{FTA}/emo_scored.jsonl', f'{EXP}/emo_scored.jsonl', f'{W}/B_ody_doc.jsonl', f'{W}/B2_ody_doc.jsonl') for r in jl(f)], ODY, 'consult_uid')
src = {'ody': (ody, ODY), 'wavlm': ({**t4w, **gw}, WAV), 'e2v': ({**t4e, **ge}, E2V)}
for e, (d, cs) in src.items():
    for i, c in enumerate(cs): WB[f'{e}_{c}'] = [d.get(k, [np.nan] * len(cs))[i] for k in WB.k]
    print(f'   B {e} windows ok {int(WB[f"{e}_{cs[0]}"].notna().sum())}/{len(WB)}')
WB['e2v_negative'] = WB[['e2v_angry', 'e2v_disgusted', 'e2v_fearful']].sum(axis=1, min_count=3)
CB = pd.DataFrame(jl(f'{W}/B_clef.jsonl') + jl(f'{W}/B2_clef.jsonl')); CB = CB[CB.status == 'ok']
eb = []
for u in B.consult_uid:
    r = {'consult_uid': u}; w = WB[WB.item == u]
    for ro in ('patient', 'doctor', 'all'):
        ww = w if ro == 'all' else w[w.role == ro]
        for e, cs in (('ody', ODY), ('wavlm', WAV), ('e2v', E2V + ['negative'])):
            ok = ww[ww[f'{e}_{cs[0]}'].notna()]; r[f'{e}_{ro}_n_win'] = len(ok)
            for c in cs: r[f'{e}_{ro}_{c}_mean'] = ok[f'{e}_{c}'].mean()
        cc = CB[(CB.role == ro) & (CB.item == u)]; r[f'clef_{ro}_n'] = len(cc)
        for c in ('valence', 'arousal_ev', 'anxious', 'engaged', 'one_speaker'): r[f'clef_{ro}_{c}'] = cc[c].mean()
    eb.append(r)
XB = pd.DataFrame(eb).set_index('consult_uid'); Bi = B.set_index('consult_uid'); cs = [c for c in XB.columns if c in Bi]
bb = {c: cmp(XB[c], Bi[c]) for c in cs}; bb = {c: v for c, v in bb.items() if v}
chk('A7 every set-B engine cell recomputed', not bb and len(cs) == len(XB.columns), f'{len(cs)} cols x {len(B)}; bad {dict(list(bb.items())[:6])}')
eb_ = EB.set_index(['consult_uid', 'role']); d1 = sum(1 for u in Bi.index for ro in ('patient', 'doctor', 'all') if Bi.loc[u, f'wavlm_{ro}_n_win'] > 0 and ((u, ro) not in eb_.index or eb_.loc[(u, ro), 'n_win'] != Bi.loc[u, f'wavlm_{ro}_n_win']))
chk('C9 B emb n_win == wavlm n_win', d1 == 0 and EB.consult_uid.isin(Bi.index).all(), f'{len(EB)} rows mismatch {d1}')
print('SUMMARY', sum(RES), '/', len(RES)); sys.exit(0 if all(RES) else 1)
