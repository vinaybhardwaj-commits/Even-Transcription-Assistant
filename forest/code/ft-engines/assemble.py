"""ft-engines assembly (venv-forest): per-episode landmark aggregates for set A (Runo calls) and per-consult aggregates for set B (OPD consults), plus COVERAGE.md inputs.
Set A call eligibility at landmark T is ft-rl-feat's rule, recomputed from its work files (rlf_assemble.main): day_from_rx < T (in_tT), STT ok, call_day < event_date,
tagged (or outcome_revealed), and not outcome_revealed. Episodes keyed episode_id; columns suffixed _t3 / _t7 / _t14; n_calls_tT masks rows without audio before T.
Roles: A patient | counsellor (Nemotron + lexicon, roles_A.py) | all (role-free: every window, any role); B patient (patient or patient_side) | doctor | all.
Engines: nemo (turns), ody (Odyssey V/A/D), wavlm (Aniemore 7 probs), e2v (emotion2vec+ 9 probs + negative = angry+disgusted+fearful), clef (Clef-omni per item x role).
WavLM per-role mean embeddings (raw 1024-d, no PCA) go to separate long-format parquets. D split asserted. Usage: assemble.py <work> <out>"""
import sys, os, json, glob, collections
import warnings; warnings.simplefilter('ignore')
import numpy as np, pandas as pd

LAB = '~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'
RLF = '~/eta-data/forest/rl/feat'
FTA = '~/oc/forest-lead/ft/out/ft-audio'; EXP = '~/oc/forest-lead/ft/out/ft-cohortb-expand'
WAVLM = ['anger', 'disgust', 'enthusiasm', 'fear', 'happiness', 'neutral', 'sadness']
E2V = ['angry', 'disgusted', 'fearful', 'happy', 'neutral', 'other', 'sad', 'surprised', 'unknown']
CLEF = ['valence', 'arousal_ev', 'anxious', 'engaged', 'one_speaker']
ODY = ['valence', 'arousal', 'dominance']
NEMO_A = ['patient_talk_share', 'counsellor_talk_share', 'turns_per_min', 'mean_patient_turn_s', 'mean_counsellor_turn_s', 'patient_interrupt_per_min',
          'counsellor_interrupt_per_min', 'n_speakers_nemo', 'all_turns_per_min', 'all_mean_turn_s', 'all_interrupt_per_min', 'all_speech_cover_share', 'all_overlap_s']
NEMO_ROLE = ['patient_talk_share', 'counsellor_talk_share', 'mean_patient_turn_s', 'mean_counsellor_turn_s', 'patient_interrupt_per_min', 'counsellor_interrupt_per_min']
# spec section 4: a role-specific feature is set missing when the call's roles come only from the "more words" fallback. Main role columns use calls with
# role_src in ROLE_OK; the *_lex2 role columns use only role_src == 'lexicon' (|score| >= 2, rlf_prep's own threshold), i.e. lexicon_weak also treated as fallback.
ROLE_OK = {'lexicon', 'lexicon_weak'}
ROLE_OK_LEX2 = {'lexicon'}
LABEL_COLS = ['h14', 'h90', 'ale', 'days_to_surgery', 'age_days']
ROLE_SRC = ['lexicon', 'lexicon_weak', 'fallback', 'single_speaker', 'no_diar']


def jl(p): return [json.loads(l) for l in open(p)] if os.path.exists(p) else []


def k3(d, item='item'): return (d[item], round(float(d['t0']), 3), round(float(d['t1']), 3))


def window_table(win_rows, engines):
    """win_rows: dicts with item,t0,t1,role. engines: {name: list of scored rows}. -> DataFrame one row per window with engine columns (NaN where not ok)."""
    df = pd.DataFrame([dict(item=w['item'], t0=round(w['t0'], 3), t1=round(w['t1'], 3), role=w.get('role')) for w in win_rows]).drop_duplicates(['item', 't0', 't1'])
    df = df.set_index(['item', 't0', 't1'])
    for name, (rows, cols) in engines.items():
        recs = {}
        for r in rows:
            if r.get('status') != 'ok': continue
            recs[k3(r, 'item' if 'item' in r else ('call_id' if 'call_id' in r else 'consult_uid'))] = [r.get(c, r.get('score_' + c, np.nan)) for c in cols]   # emotion2vec rows carry score_<label>
        e = pd.DataFrame.from_dict(recs, orient='index', columns=[f'{name}__{c}' for c in cols])
        if len(e): e.index = pd.MultiIndex.from_tuples(e.index, names=['item', 't0', 't1'])
        df = df.join(e, how='left')
        st = collections.Counter(r.get('status', '')[:5] for r in rows)
        print(name, 'rows', len(rows), dict(st), 'joined ok', int(df[f'{name}__{cols[0]}'].notna().sum()) if len(e) else 0, '/', len(df))
    df = df.reset_index()
    if 'e2v__angry' in df: df['e2v__negative'] = df[['e2v__angry', 'e2v__disgusted', 'e2v__fearful']].sum(axis=1, min_count=3)
    return df


def win_feats(g, prefix_role):
    """aggregate a set of windows -> dict of features with prefix '<engine>_<role>_'."""
    o = {}
    r = prefix_role
    for eng, cols in (('ody', ODY), ('wavlm', WAVLM), ('e2v', E2V + ['negative'])):
        okc = f'{eng}__{cols[0]}'
        gg = g[g[okc].notna()] if okc in g else g.iloc[0:0]
        o[f'{eng}_{r}_n_win'] = len(gg)
        for c in cols:
            o[f'{eng}_{r}_{c}_mean'] = gg[f'{eng}__{c}'].mean() if len(gg) else np.nan
        if eng == 'ody':
            for c in ('valence', 'arousal'):
                o[f'ody_{r}_{c}_std'] = gg[f'ody__{c}'].std() if len(gg) > 1 else np.nan
                o[f'ody_{r}_{c}_min'] = gg[f'ody__{c}'].min() if len(gg) else np.nan
    return o


def clef_feats(C, items, r):
    g = C[(C.role == r) & C.item.isin(items) & (C.status == 'ok')] if len(C) else pd.DataFrame()
    o = {f'clef_{r}_n': len(g)}
    for c in CLEF: o[f'clef_{r}_{c}'] = g[c].mean() if len(g) else np.nan
    return o


def emb_rows(win, embdir, key_cols, roles):
    """per (key, role) mean raw WavLM embedding over the windows in `win` (DataFrame with item,t0,t1,role + key cols)."""
    cache, out = {}, []
    for keys, g in win.groupby(key_cols):
        keys = keys if isinstance(keys, tuple) else (keys,)
        for r in roles:
            gg = g if r == 'all' else g[g.role == r]
            vs = []
            for it, t0, t1 in zip(gg.item, gg.t0, gg.t1):
                if it not in cache:
                    p = f'{embdir}/{it}.npz'; cache[it] = dict(np.load(p)) if os.path.exists(p) else {}
                v = cache[it].get(f'{t0}_{t1}')
                if v is None: v = cache[it].get(f'{float(t0)}_{float(t1)}')
                if v is not None: vs.append(v)
            if vs: out.append(dict(zip(key_cols, keys), role=r, n_win=len(vs), **{f'e{i}': x for i, x in enumerate(np.mean(vs, axis=0))}))
    return pd.DataFrame(out)


# ------------------------------------------------------------------ set A
def calls_eligibility():
    cb = pd.read_parquet(f'{RLF}/calls_basic.parquet')
    tg = pd.DataFrame(jl(f'{RLF}/tags.jsonl')).drop_duplicates('call_id', keep='last')
    lab = pd.read_parquet(LAB); lab = lab[lab.split == 'D'].set_index('episode_id')
    cb = cb.merge(tg[['call_id', 'outcome_revealed', 'intent']], on='call_id', how='left')
    cb['tagged'] = cb.intent.notna(); cb['outcome_revealed'] = cb.outcome_revealed.fillna(False).astype(bool)
    ev = pd.to_datetime(cb.episode_id.map(lab.event_date))
    cb['post_event'] = ev.notna() & cb.call_day.notna() & (cb.call_day >= ev)
    for T in (3, 7, 14):
        cb[f'elig_t{T}'] = cb[f'in_t{T}'].fillna(False).astype(bool) & cb.stt_status.eq('ok') & ~cb.post_event & (cb.tagged | cb.outcome_revealed) & ~cb.outcome_revealed
    return cb, lab


def set_a(work, out):
    cb, lab = calls_eligibility()
    roles = pd.read_parquet(f'{work}/calls_roles.parquet')
    W = jl(f'{work}/winA_role.jsonl')
    ody = [dict(r, item=r['call_id']) for r in jl(f'{RLF}/emo.jsonl')]
    win = window_table(W, {'ody': (ody, ODY), 'wavlm': (jl(f'{work}/A_wavlm.jsonl'), WAVLM), 'e2v': (jl(f'{work}/A_e2v.jsonl'), E2V)})
    C = pd.DataFrame(jl(f'{work}/A_clef.jsonl'))
    old = [c for c in roles.columns if c != 'call_id' and c in cb.columns]
    cb = cb.rename(columns={c: c + '_sarvam_old' for c in old}).merge(roles, on='call_id', how='left')   # old Sarvam/guessed-role columns kept only for audit
    cb['role_src'] = cb.role_src.fillna('no_diar'); cb['diar_status'] = cb.diar_status.fillna('missing')
    win = win.merge(cb[['call_id', 'episode_id']].rename(columns={'call_id': 'item'}), on='item', how='left')
    # per-call file (role source + per-call engine features, all calls, eligibility flags)
    erows, emb_in = [], []
    for ep, g in cb.groupby('episode_id'):
        r = dict(episode_id=ep, n_calls_manifest=len(g))
        for T in (3, 7, 14):
            s = f'_t{T}'; w = g[g[f'elig_t{T}']]; ids = set(w.call_id)
            r['n_calls' + s] = len(w)
            r['n_calls_diarized' + s] = int(w.diar_status.eq('ok').sum())
            for rs in ROLE_SRC: r[f'role_{rs}_share' + s] = w.role_src.eq(rs).mean() if len(w) else np.nan
            wr = w[w.role_src.isin(ROLE_OK)]; wr2 = w[w.role_src.isin(ROLE_OK_LEX2)]
            r['n_calls_roleok' + s] = len(wr); r['n_calls_rolelex2' + s] = len(wr2)
            for c in NEMO_A:
                src = wr if c in NEMO_ROLE else w
                r[f'nemo_{c}' + s] = src[c].mean() if len(src) and c in src else np.nan
                if c in NEMO_ROLE: r[f'nemo_{c}_lex2' + s] = wr2[c].mean() if len(wr2) else np.nan
            wg = win[win.item.isin(ids)]
            for ro, base, cids in (('patient', 'patient', set(wr.call_id)), ('counsellor', 'counsellor', set(wr.call_id)), ('all', None, ids),
                                   ('patient_lex2', 'patient', set(wr2.call_id)), ('counsellor_lex2', 'counsellor', set(wr2.call_id))):
                gg = wg if base is None else wg[(wg.role == base) & wg.item.isin(cids)]
                for k, v in win_feats(gg, ro).items(): r[k + s] = v
                cc = C.assign(role=C.role.replace({base: ro})) if base and ro != base and len(C) else C
                for k, v in clef_feats(cc, cids, ro).items(): r[k + s] = v
            r['ody_valence_gap_patient_minus_counsellor' + s] = r['ody_patient_valence_mean' + s] - r['ody_counsellor_valence_mean' + s]
            if len(wg): emb_in.append(wg.assign(episode_id=ep, T=T))
        erows.append(r)
    df = pd.DataFrame(erows)
    df = df[df.n_calls_manifest > 0].reset_index(drop=True)
    df['split'] = df.episode_id.map(lab.split)
    assert df.split.eq('D').all(), 'non-D episode'
    for c in ('h14', 'h90', 'days_to_surgery', 'age_days'): df[c] = df.episode_id.map(lab[c])
    df['ale'] = np.where(df.days_to_surgery.notna(), 1.0, np.where(df.age_days >= 14, 0.0, np.nan))
    # labels are NOT in the feature file (refute fix): sidecar for masking / at-risk only
    pl = f'{out}/engine_calls_label_sidecar.parquet'; df[['episode_id', 'split'] + LABEL_COLS].to_parquet(pl, index=False); os.chmod(pl, 0o600)
    p = f'{out}/engine_feats_calls.parquet'; df.drop(columns=LABEL_COLS).to_parquet(p, index=False); os.chmod(p, 0o600)
    # per-call table (role source, eligibility) for audit
    keep = ['call_id', 'episode_id', 'day_from_rx', 'diar_status', 'role_src', 'lex_score', 'elig_t3', 'elig_t7', 'elig_t14', 'outcome_revealed', 'post_event', 'role_src_sarvam_old'] + [c for c in NEMO_A if c in cb]
    pc = f'{out}/engine_calls_percall.parquet'; cb[keep].to_parquet(pc, index=False); os.chmod(pc, 0o600)
    if emb_in:
        EI = pd.concat(emb_in).merge(cb[['call_id', 'role_src']].rename(columns={'call_id': 'item'}), on='item', how='left')
        EI.loc[EI.role.isin(['patient', 'counsellor']) & ~EI.role_src.isin(ROLE_OK), 'role'] = 'masked_fallback'   # same role masking as the scalar features; 'all' still uses every window
        E = emb_rows(EI, f'{work}/A_emb_wavlm', ['episode_id', 'T'], ('patient', 'counsellor', 'all'))
        pe = f'{out}/engine_wavlm_emb_calls.parquet'; E.to_parquet(pe, index=False); os.chmod(pe, 0o600)
    return df, cb, win, C


# ------------------------------------------------------------------ set B
def set_b(work, out):
    lab = pd.read_parquet(LAB)
    b1 = pd.read_parquet(f'{FTA}/base.parquet'); b1 = b1[b1.split == 'D']
    fa = pd.read_parquet(f'{FTA}/features_ale.parquet')
    eb = pd.read_parquet(f'{EXP}/base.parquet')
    b2 = eb[eb.consult_uid.isin(fa.consult_uid) & ~eb.consult_uid.isin(b1.consult_uid) & eb.split.eq('D')]
    items = pd.DataFrame({'consult_uid': list(b1.consult_uid) + list(b2.consult_uid), 'set_src': ['ft-audio-125'] * len(b1) + ['ale-extension'] * len(b2)})
    ep = pd.concat([eb[['consult_uid', 'episode_id']], fa[['consult_uid', 'episode_id']]]).dropna().drop_duplicates('consult_uid')
    items = items.merge(ep, on='consult_uid', how='left')
    W = []
    for f in ('winB.jsonl', 'winB2.jsonl'):
        for w in jl(f'{work}/{f}'): w['role'] = 'doctor' if w['who'] == 'doctor' else 'patient'; W.append(w)
    ody = [dict(r, item=r['consult_uid']) for f in (f'{FTA}/emo_scored.jsonl', f'{EXP}/emo_scored.jsonl', f'{work}/B_ody_doc.jsonl', f'{work}/B2_ody_doc.jsonl') for r in jl(f)]
    # set B WavLM / emotion2vec: GCP L4 runs (gcp/, every window) override the partial the lab box rows of the same engine version (later rows win on the same window key)
    G = f'{work}/gcp'
    win = window_table(W, {'ody': (ody, ODY), 'wavlm': (jl(f'{work}/B_wavlm.jsonl') + jl(f'{G}/B_wavlm.jsonl') + jl(f'{G}/B2_wavlm.jsonl'), WAVLM),
                           'e2v': (jl(f'{work}/B_e2v.jsonl') + jl(f'{G}/B_e2v.jsonl') + jl(f'{G}/B2_e2v.jsonl'), E2V)})
    C = pd.DataFrame(jl(f'{work}/B_clef.jsonl') + jl(f'{work}/B2_clef.jsonl'))
    af = pd.concat([pd.read_parquet(f'{FTA}/audio_feats.parquet').assign(_s=1), pd.read_parquet(f'{EXP}/audio_feats.parquet').assign(_s=2)])
    af = af.sort_values('_s').drop_duplicates('consult_uid')
    turn_cols = ['doc_talk_share', 'patient_talk_share', 'turns_per_min', 'mean_patient_turn_s', 'doc_interrupt_per_min', 'pat_interrupt_per_min', 'n_speakers_nemo', 'speech_min', 'consult_min']
    rows = []
    for it in items.itertuples():
        r = dict(consult_uid=it.consult_uid, episode_id=it.episode_id, set_src=it.set_src)
        a = af[af.consult_uid == it.consult_uid]
        r['role_src'] = a.role_src.iloc[0] if len(a) else 'none'
        r['diar_src'] = a.diar_src.iloc[0] if len(a) and 'diar_src' in a and pd.notna(a.diar_src.iloc[0]) else ('nemotron' if len(a) else None)
        for c in turn_cols: r[f'nemo_{c}'] = a[c].iloc[0] if len(a) and c in a else np.nan
        g = win[win.item == it.consult_uid]
        for ro in ('patient', 'doctor', 'all'):
            gg = g if ro == 'all' else g[g.role == ro]
            r.update(win_feats(gg, ro)); r.update(clef_feats(C, {it.consult_uid}, ro))
        rows.append(r)
    df = pd.DataFrame(rows)
    ls = lab.set_index('episode_id').split
    df['split'] = df.episode_id.map(ls)
    assert not df.split.eq('H').any(), 'H episode in consults'
    p = f'{out}/engine_feats_consults.parquet'; df.to_parquet(p, index=False); os.chmod(p, 0o600)
    E = emb_rows(win.rename(columns={}).assign(consult_uid=win.item), f'{work}/gcp/B_emb_wavlm', ['consult_uid'], ('patient', 'doctor', 'all'))
    pe = f'{out}/engine_wavlm_emb_consults.parquet'; E.to_parquet(pe, index=False); os.chmod(pe, 0o600)
    return df, win, C, items


if __name__ == '__main__':
    work, out = sys.argv[1:3]; os.makedirs(out, exist_ok=True)
    A = set_a(work, out); B = set_b(work, out)
    pd.to_pickle({'A': A, 'B': B}, f'{work}/assembled.pkl'); os.chmod(f'{work}/assembled.pkl', 0o600)
    print('A episodes', len(A[0]), 'B consults', len(B[0]))
