"""ft-text2: Bolna episode-level features per landmark T in {3, 7} plus coverage cells. D only.
Calls used at T: day_from_rx < T, call day < surgery day (bolna_join), outcome-revealing calls dropped (Haiku verified or unverified, as ftc_model 'leak').
LEAK_UNION=1 also drops calls with Jev outcome_revealed p >= 0.8 (sensitivity).
Features: n_bolna_calls_tT, bolna_has_tT. Tags use ftc_model names prefixed bolna_ and suffixed _tT: obj_*, intent_{wants_surgery,undecided,declines},
next_step_any, next_visit, price_quoted. The primary columns are Jev-filtered: a Haiku positive with Jev p < 0.2 is set to 0 (FT-MODEL-SPEC layer 3).
The bolna_raw_* columns hold the raw Haiku tags (sensitivity). Episodes with no usable Bolna call before T have NaN tags (the model codes -1 and uses bolna_has_tT).
Output (0600): out/ft-text2/bolna_episode_feats.parquet (one row per D episode in labels, all 1233), COVERAGE cells as markdown on stdout."""
import os, sys
import numpy as np, pandas as pd
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ft2common as C

LU = os.environ.get('LEAK_UNION') == '1'
LB = f'{C.HOME}/oc/forest-lead/ft/out/ft-labels-base'
F = pd.read_parquet(f'{LB}/features_D.parquet')[['episode_id', 'cluster_key', 'rx_date', 'h14', 'h90', 'days_to_surgery', 'age_days', 'split']]
assert set(F.split) == {'D'}
F['ale'] = np.where(F.days_to_surgery <= 14, 1.0, np.where(F.age_days >= 14, 0.0, np.nan))      # ftc_model rule
_f1 = pd.read_csv(f'{C.HOME}/eta-data/forest/funnel/hash-only/f1-2026-10-19.tsv', sep='\t', dtype=str)
F['amb_hash'] = F.cluster_key.isin(set(_f1.loc[(_f1.split == 'D') & (_f1.ambiguous == 'true'), 'cluster_key']))
E = pd.read_parquet(f'{C.FTC}/episodes_D.parquet')[['episode_id', 'ambiguous']]
F = F.merge(E, on='episode_id', how='left'); F['ambiguous'] = F.ambiguous.fillna(False) | F.amb_hash

b = pd.read_parquet(f'{C.OUT}/bolna_calls.parquet').drop(columns=['transcript'])
t = pd.read_parquet(f'{C.OUT}/call_tags_jev.parquet'); t = t[t.src == 'S3'].rename(columns={'call_id': 'bolna_id'})
b = b.merge(t.drop(columns=['episode_id']), on='bolna_id', how='left')
assert b.h_outcome_revealed.notna().all(), 'untagged Bolna call'
b['leak'] = (b.h_outcome_revealed == 1) | (b.outcome_revealed_unverified == 1) | ((b.j_outcome_revealed >= 0.8) if LU else False)

X = F[['episode_id']].copy()
for T in (3, 7):
    w = b[(b.day_from_rx < T) & ~b.leak]; g = w.groupby('episode_id'); s = f'_t{T}'
    X[f'n_bolna_calls{s}'] = X.episode_id.map(g.size()).fillna(0)
    X[f'bolna_has{s}'] = (X[f'n_bolna_calls{s}'] > 0).astype(float)
    X[f'n_bolna_dropped_outcome{s}'] = X.episode_id.map(b[(b.day_from_rx < T) & b.leak].groupby('episode_id').size()).fillna(0)   # QC only, not a predictor
    for pre, k in (('bolna_', 'hf_'), ('bolna_raw_', 'h_')):
        for o in C.OBJ: X[f'{pre}obj_{o}{s}'] = X.episode_id.map(g[f'{k}obj_{o}'].max())
        for i in C.INTENT: X[f'{pre}intent_{i}{s}'] = X.episode_id.map(g[f'{k}intent_{i}'].max())
        X[f'{pre}next_step_any{s}'] = X.episode_id.map(w.assign(v=w[[f'{k}next_{n}' for n in C.NEXT]].max(axis=1)).groupby('episode_id').v.max())
        X[f'{pre}next_visit{s}'] = X.episode_id.map(g[f'{k}next_visit_or_consult_scheduled'].max())
        X[f'{pre}price_quoted{s}'] = X.episode_id.map(g[f'{k}price_quoted'].max())
p = f'{C.OUT}/bolna_episode_feats{"_leakunion" if LU else ""}.parquet'; X.to_parquet(p, index=False); os.chmod(p, 0o600)
print(f'rows {len(X)}; columns {len(X.columns) - 1}; file {os.path.basename(p)}\n')

D = F.merge(X, on='episode_id')
print('| label | T | cohort | at-risk episodes (n / pos) | with >= 1 usable Bolna call (n / pos) | Bolna calls used |')
print('|---|---|---|---|---|---|')
for lab in ('h14', 'h90', 'ale'):
    for T in (3, 7):
        for coh in ('all D', 'P', 'S'):
            d = D[D[lab].notna() & (D.rx_date >= '2026-01-01')]
            d = d if coh == 'all D' else (d[~d.amb_hash] if coh == 'P' else d[~d.ambiguous])
            d = d[~(d.days_to_surgery <= T)]
            c = d[d[f'bolna_has_t{T}'] == 1]
            print(f"| {lab} | {T} | {coh} | {len(d)} / {int(d[lab].sum())} | {len(c)} / {int(c[lab].sum())} | {int(c[f'n_bolna_calls_t{T}'].sum())} |")
u = b.drop_duplicates('bolna_id')
print(f"\nBolna calls in [Rx, Rx+14] before the surgery day: {len(u)} on {u.episode_id.nunique()} episodes; outcome-revealing (dropped): {int(u.leak.sum())}; "
      f"day 0: {int((u.day_from_rx == 0).sum())} (before the consult time: {int(u.before_consult_day0.sum())}); with day_from_rx < 3: {int((u.day_from_rx < 3).sum())}, < 7: {int((u.day_from_rx < 7).sum())}.")
print('Rx >= 2026-01-01 filter and labels follow ftc_model.run_one (cohort P = hash-only F1 ambiguity dropped; S = every ambiguity flag dropped).')
