# ft-refute-forest: independent rebuild + refit of the frozen FT forest (spec 704c50dffbef). D only. Written without reading ft-forest code.
# usage: rf_refute.py A|B|C [labels...]   -> work/oof_<design>_<lab>.npz + work/res_<design>_<lab>.json
import os, sys, json, time
import numpy as np, pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedGroupKFold, GroupKFold
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss

O = os.path.expanduser('~/oc/forest-lead/ft/out'); W = os.path.dirname(os.path.abspath(__file__))
RS = 20261019; NB = 1000
os.umask(0o077)

# ---------------- inputs ----------------
F = pd.read_parquet(f'{O}/ft-labels-base/features_D.parquet'); assert set(F.split) == {'D'}
BCOLS = [c for c in json.load(open(f'{O}/ft-labels-base/features_D.cols.json')) if c != 'payer']   # layer 0: no same-day payer
F['ale'] = np.where(F.days_to_surgery <= 14, 1.0, np.where(F.age_days >= 14, 0.0, np.nan))
F8 = pd.read_parquet(f'{O}/ft8-clinical/features_ft8.parquet'); L1 = [c for c in F8.columns if c.startswith('ft8_')]
assert len(L1) == 42
F = F.merge(F8, on='episode_id', how='left', validate='1:1')
E = pd.read_parquet(f'{O}/ft-calltext/episodes_D.parquet')[['episode_id', 'ambiguous']]
F = F.merge(E, on='episode_id', how='left', validate='1:1')
f1 = pd.read_csv(os.path.expanduser('~/eta-data/forest/funnel/hash-only/f1-2026-10-19.tsv'), sep='\t', dtype=str)
F['amb_hash'] = F.cluster_key.isin(set(f1.loc[(f1.split == 'D') & (f1.ambiguous == 'true'), 'cluster_key']))

OBJ = ['cost', 'insurance', 'fear', 'second_opinion', 'going_elsewhere', 'timing', 'family_decision', 'unreachable']
def tagframe(p):
    t = pd.read_json(p, lines=True)
    t['rev'] = t.outcome_revealed.eq(True) | t.outcome_revealed_unverified.eq(True) | t.outcome_revealed_jev_added.eq(True)
    t['jevadd'] = t.outcome_revealed_jev_added.eq(True)
    for o in OBJ: t[f'obj_{o}'] = t.objections.apply(lambda l: o in (l or []))
    for v in ('wants_surgery', 'undecided', 'declines'): t[f'intent_{v}'] = t.intent.eq(v)
    t['next_step_any'] = t.next_step.ne('none'); t['next_visit'] = t.next_step.eq('visit_or_consult_scheduled')
    t['price_quoted'] = t.price_quoted.astype(bool)
    k = [f'obj_{o}' for o in OBJ] + ['intent_wants_surgery', 'intent_undecided', 'intent_declines', 'next_step_any', 'next_visit', 'price_quoted', 'rev', 'jevadd']
    return t.groupby(['call_id', 'episode_id'], as_index=False)[k].max()   # S2 has several rows per call: any
TAGK = [f'obj_{o}' for o in OBJ] + ['intent_wants_surgery', 'intent_undecided', 'intent_declines', 'next_step_any', 'next_visit', 'price_quoted']
C1 = pd.read_parquet(f'{O}/ft-calltext/calls_D.parquet', columns=['episode_id', 'call_id', 'day_from_rx', 'duration', 'has_recording'])
S1 = tagframe(f'{O}/ft-text2/tags_D_jev.jsonl')
C1 = C1.merge(S1.drop(columns='episode_id'), on='call_id', how='left'); C1['tagged'] = C1.rev.notna(); C1['rev'] = C1.rev.eq(True); C1['jevadd'] = C1.jevadd.eq(True)
S2 = tagframe(f'{O}/ft-text2/rlfeat_tags_jev.jsonl')
RL = pd.read_parquet(os.path.expanduser('~/eta-data/forest/rl/feat/calls_basic.parquet'), columns=['call_id', 'day_from_rx'])
S2 = S2.merge(RL, on='call_id', how='left', validate='1:1'); assert S2.day_from_rx.notna().all()
BOL = pd.read_parquet(f'{O}/ft-text2/bolna_episode_feats.parquet')
ENG = pd.read_parquet(f'{O}/ft-engines/engine_feats_calls.parquet')
L8B = pd.read_parquet(f'{O}/ft-bench/bench_layer8.parquet')
ENC = pd.read_parquet(f'{O}/ft-engines/engine_feats_consults.parquet')
L8C = pd.read_parquet(f'{O}/ft-bench/bench_layer8_c.parquet')

# ---------------- layer builders (return frame aligned to D rows, NaN = missing) ----------------
def layer23(D, T):
    c = C1[C1.episode_id.isin(D.episode_id) & (C1.day_from_rx < T) & ~C1.rev]
    g = c.groupby('episode_id'); ix = D.episode_id.values
    X2 = pd.DataFrame(index=ix)
    X2['n_calls'] = g.size(); X2['n_connected'] = g.duration.apply(lambda s: (s > 0).sum()); X2['n_recorded'] = g.has_recording.sum()
    X2['talk_s'] = g.duration.sum(); X2['max_call_s'] = g.duration.max(); X2['first_call_day'] = g.day_from_rx.min()
    X2 = X2.reindex(ix).astype(float)
    X2[['n_calls', 'n_connected', 'n_recorded', 'talk_s', 'max_call_s']] = X2[['n_calls', 'n_connected', 'n_recorded', 'talk_s', 'max_call_s']].fillna(0)
    X3 = pd.DataFrame(index=ix)
    t = c[c.tagged]; gt = t.groupby('episode_id')
    X3['n_summaries'] = gt.size().reindex(ix).fillna(0); X3['no_summary'] = (X3.n_summaries == 0).astype(float)
    for k in TAGK: X3[f's1_{k}'] = gt[k].max().reindex(ix).astype(float).fillna(0)
    s = S2[S2.episode_id.isin(D.episode_id) & (S2.day_from_rx < T) & ~S2.rev]; gs = s.groupby('episode_id')
    X3['s2_n_tagged'] = gs.size().reindex(ix).fillna(0); X3['s2_has'] = (X3.s2_n_tagged > 0).astype(float)
    for k in TAGK: X3[f's2_{k}'] = gs[k].max().reindex(ix).astype(float)          # NaN (-1) when no S2 call
    b = BOL.set_index('episode_id').reindex(ix); sfx = f'_t{T}'
    bc = [f'n_bolna_calls{sfx}', f'bolna_has{sfx}'] + [f'bolna_{k}{sfx}' for k in TAGK]
    for k in bc: X3['b_' + k] = b[k].astype(float).values
    X3['b_bolna_has' + sfx] = X3['b_bolna_has' + sfx].fillna(0)
    return X2.reset_index(drop=True), X3.reset_index(drop=True)

ROLE = ('_patient_', '_counsellor_', 'nemo_patient', 'nemo_counsellor', 'nemo_mean_patient', 'nemo_mean_counsellor', 'ody_valence_gap')
def engine_layers(D, T):
    sfx = f'_t{T}'; e = ENG.set_index('episode_id').reindex(D.episode_id.values)
    base = lambda c: c[:-len(sfx)]
    cols = [c for c in ENG.columns if c.endswith(sfx) and 'lex2' not in c]
    nc = e[f'n_calls{sfx}'].fillna(0).values; rok = e[f'n_calls_roleok{sfx}'].fillna(0).values
    out = {}
    for L, pre in ((4, 'nemo_'), (5, 'ody_'), (6, 'e2v_'), (7, 'clef_')):
        cc = [c for c in cols if c.startswith(pre)]
        X = e[cc].astype(float).copy(); X.columns = [base(c) for c in cc]
        X.loc[nc == 0, :] = np.nan                                          # no usable call before T -> all missing (FTR fix 1)
        rc = [c for c in X.columns if any(r in c for r in ROLE)]
        X.loc[rok == 0, rc] = np.nan                                        # role columns masked when no non-fallback call
        X[f'has_L{L}'] = X.notna().any(axis=1).astype(float)
        out[L] = X.reset_index(drop=True)
    return out, cols

def layer8_B(D, T, lab):
    sc = 'opus_screen2_p90' if lab == 'h90' else 'opus_screen2_p14'
    l = L8B[L8B['T'] == T].drop_duplicates('episode_id').set_index('episode_id').reindex(D.episode_id.values)
    X = pd.DataFrame({'l8_score': l[sc].astype(float).values, 'l8_has': l.has_text_screen2.fillna(False).astype(float).values})
    X.loc[X.l8_has == 0, 'l8_score'] = np.nan
    return X

def consult_layers(cuids, lab):
    e = ENC.drop_duplicates('consult_uid').set_index('consult_uid').reindex(cuids)
    out = {}
    for L, pre in ((4, 'nemo_'), (5, 'ody_'), (6, 'e2v_'), (7, 'clef_')):
        cc = [c for c in ENC.columns if c.startswith(pre)]
        X = e[cc].astype(float).copy(); X.columns = ['c_' + c for c in cc]
        X[f'c_has_L{L}'] = X.notna().any(axis=1).astype(float); out[L] = X.reset_index(drop=True)
    sc = 'opus_screen2_p90' if lab == 'h90' else 'opus_screen2_p14'
    l = L8C.drop_duplicates('consult_uid').set_index('consult_uid').reindex(cuids)
    X = pd.DataFrame({'c_l8_score': l[sc].astype(float).values, 'c_l8_has': l.has_text_screen2.fillna(False).astype(float).values})
    X.loc[X.c_l8_has == 0, 'c_l8_score'] = np.nan; out[8] = X
    return out

# ---------------- learner (FT3 settings; in-fold doctor rate m=10 for A/B) ----------------
def docrate(tr_d, tr_y, ap_d, m=10):
    g = pd.DataFrame({'d': tr_d, 'y': tr_y}).groupby('d').y.agg(['sum', 'count']); p = tr_y.mean()
    r = ((g['sum'] + m * p) / (g['count'] + m)); return pd.Series(ap_d).map(r).fillna(p).values, pd.Series(ap_d).map(g['count']).fillna(0).values

def matrix(Xtr, Xte, cols, ytr=None, gtr=None, doc=True):
    cat = [c for c in cols if Xtr[c].dtype == object and c != 'doctor_id']; num = [c for c in cols if c not in cat and c != 'doctor_id']
    A = [Xtr[num].astype(float).fillna(-1).values]; B = [Xte[num].astype(float).fillna(-1).values]
    for c in cat:
        vc = Xtr[c].value_counts()
        for lv in [l for l, n in vc.items() if n >= 10]:
            A.append((Xtr[c] == lv).values[:, None].astype(float)); B.append((Xte[c] == lv).values[:, None].astype(float))
    if doc and 'doctor_id' in cols:
        rtr = np.zeros(len(Xtr)); vtr = np.zeros(len(Xtr))
        for a, b in GroupKFold(5).split(Xtr, ytr, gtr):
            rtr[b], vtr[b] = docrate(Xtr.doctor_id.values[a], ytr[a], Xtr.doctor_id.values[b])
        rte, vte = docrate(Xtr.doctor_id.values, ytr, Xte.doctor_id.values)
        A += [rtr[:, None], vtr[:, None]]; B += [rte[:, None], vte[:, None]]
    return np.hstack(A), np.hstack(B)

def rf(): return RandomForestClassifier(n_estimators=400, min_samples_leaf=5, max_features='sqrt', random_state=0, n_jobs=int(os.environ.get('NJ', 12)))

def cv_oof(DX, y, g, models, reps, foldseed, also_nested=()):
    oof = {m: np.zeros((reps, len(y))) for m in models}; nest = {m: np.zeros((reps, len(y))) for m in also_nested}
    for rep in range(reps):
        for a, b in StratifiedGroupKFold(5, shuffle=True, random_state=foldseed(rep)).split(DX, y, g):
            tr, te = DX.iloc[a].reset_index(drop=True), DX.iloc[b].reset_index(drop=True)
            for m, cols in models.items():
                Xa, Xb = matrix(tr, te, cols, y[a], g[a]); f = rf().fit(Xa, y[a]); oof[m][rep, b] = f.predict_proba(Xb)[:, 1]
                if m in nest:                                               # nested in-fold Platt: inner 5-fold OOF on the training rows only
                    inner = np.zeros(len(a))
                    for ia, ib in StratifiedGroupKFold(5, shuffle=True, random_state=rep).split(tr, y[a], g[a]):
                        t2, t3 = tr.iloc[ia].reset_index(drop=True), tr.iloc[ib].reset_index(drop=True)
                        Xi, Xj = matrix(t2, t3, cols, y[a][ia], g[a][ia]); inner[ib] = rf().fit(Xi, y[a][ia]).predict_proba(Xj)[:, 1]
                    from sklearn.linear_model import LogisticRegression
                    lr = LogisticRegression(C=1e6).fit(inner[:, None], y[a]); nest[m][rep, b] = lr.predict_proba(oof[m][rep, b][:, None])[:, 1]
    return oof, nest

# ---------------- bootstrap ----------------
def bidx(g, seed=RS):
    rng = np.random.default_rng(seed); ug = np.unique(g); ix = {k: np.where(g == k)[0] for k in ug}
    return [np.concatenate([ix[k] for k in rng.choice(ug, len(ug))]) for _ in range(NB)]
def auc_ci(y, p, B): v = [roc_auc_score(y[s], p[s]) for s in B if 0 < y[s].sum() < len(s)]; return [roc_auc_score(y, p), *np.percentile(v, [2.5, 97.5])]
def delta(y, pa, pb, B):
    d = np.array([roc_auc_score(y[s], pb[s]) - roc_auc_score(y[s], pa[s]) for s in B if 0 < y[s].sum() < len(s)])
    ple = float(np.mean(d <= 0)); pge = float(np.mean(d >= 0))
    return dict(d=roc_auc_score(y, pb) - roc_auc_score(y, pa), lo=float(np.percentile(d, 2.5)), hi=float(np.percentile(d, 97.5)),
                p_le0=ple, p2=max(2 * min(ple, pge), 1 / NB))

# ---------------- designs ----------------
def run_A(lab):
    D = F[F[lab].notna()].reset_index(drop=True); y = D[lab].values.astype(int); g = D.cluster_key.values
    CL = consult_layers(D.consult_uid.values, lab)
    DX = pd.concat([D] + [CL[k] for k in (4, 5, 6, 7, 8)], axis=1)
    ccols = [c for k in (4, 5, 6, 7, 8) for c in CL[k].columns]
    M = {'M0': BCOLS, 'M1': BCOLS + L1, 'M2': BCOLS + L1 + ccols}
    oof, nest = cv_oof(DX, y, g, M, 5, lambda r: RS + r, also_nested=('M0', 'M1') if lab in ('h14', 'h90') else ())
    cov = {f'C{k}': int(CL[k].iloc[:, -1].sum()) for k in (4, 5, 6, 7, 8)}
    return D, y, g, M, oof, nest, cov

def run_B(lab, T):
    D = F[F[lab].notna() & (F.rx_date >= '2026-01-01') & ~F.amb_hash]
    D = D[~(D.days_to_surgery <= T)].reset_index(drop=True); assert not (D.days_to_surgery <= T).any()
    y = D[lab].values.astype(int); g = D.cluster_key.values
    X2, X3 = layer23(D, T); EL, _ = engine_layers(D, T); X8 = layer8_B(D, T, lab)
    # ruling 4: layers 4-8 missing on rows with a Jev-added outcome-revealing call before T (S1 or S2)
    ja = set(C1.loc[C1.jevadd & (C1.day_from_rx < T), 'episode_id']) | set(S2.loc[S2.jevadd & (S2.day_from_rx < T), 'episode_id'])
    r4 = D.episode_id.isin(ja).values
    for k in (4, 5, 6, 7):
        EL[k].loc[r4, :] = np.nan; EL[k].loc[r4, f'has_L{k}'] = 0.0
    X8.loc[r4, :] = np.nan; X8.loc[r4, 'l8_has'] = 0.0
    LY = {2: X2, 3: X3, **EL, 8: X8}
    DX = pd.concat([D] + [LY[k] for k in range(2, 9)], axis=1)
    cols = {0: BCOLS, 1: L1, **{k: list(LY[k].columns) for k in range(2, 9)}}
    M = {}; acc = []
    for k in range(9): acc = acc + cols[k]; M[f'L{k}'] = list(acc)
    oof, _ = cv_oof(DX, y, g, M, 5, lambda r: RS + r)
    cov = {'r4_rows': int(r4.sum()), 'eng_rows': int((EL[4][f'has_L4'] > 0).sum()), 'l8_rows': int(X8.l8_has.sum()),
           'ncols': {k: len(cols[k]) for k in cols}}
    return D, y, g, M, oof, {}, cov

FT4MAP = {'General Surgery': 'GS', 'Orthopaedics': 'Ortho', 'Urology': 'Uro', 'Gastroenterology': 'Gastro', 'Gastroentrology Medical': 'Gastro',
          'Cardiology Interventional': 'Cardio', 'Cardiology Non Interventional': 'Cardio'}
def run_C(lab):
    dc = pd.read_parquet(f'{O}/ft-audio/designC_cohort.parquet'); fa = pd.read_parquet(f'{O}/ft-audio/features_ale.parquet')
    D = dc[dc[lab].notna()][['consult_uid', 'cluster_key', lab]].merge(fa[['consult_uid', 'specialty', 'doc_prior_rate', 'age_y', 'episode_id']], on='consult_uid', how='left', validate='1:1')
    D['specialty'] = D.specialty.map(FT4MAP).fillna('other')
    D = D.merge(F8, on='episode_id', how='left').reset_index(drop=True)
    y = D[lab].values.astype(int); g = D.cluster_key.values
    CL = consult_layers(D.consult_uid.values, lab)
    DX = pd.concat([D] + [CL[k] for k in (4, 5, 6, 7, 8)], axis=1)
    base = ['specialty', 'doc_prior_rate', 'age_y']
    M = {'C0': base}; acc = base + L1; M['C1'] = list(acc)
    for k in (4, 5, 6, 7, 8): acc = acc + list(CL[k].columns); M[f'C{k}'] = list(acc)
    # FT4 specialty levels are few; one-hot every level with >= 10 rows in train (same rule as A/B)
    oof, _ = cv_oof(DX, y, g, M, 20, lambda r: r)
    cov = {'ft8_linked': int(D.ft8_has_prior_rx.notna().sum()), 'l8': int(CL[8].c_l8_has.sum()), 'eng': int(CL[4].c_has_L4.sum())}
    return D, y, g, M, oof, {}, cov

if __name__ == '__main__':
    des = sys.argv[1]; t0 = time.time()
    jobs = {'A': [('rx', l) for l in ('h14', 'h90', 'ale')], 'B': [(f'lm{T}', l) for T in (3, 7) for l in ('h14', 'h90', 'ale')],
            'C': [('consult', l) for l in ('ale_strict', 'h14_ge18')]}[des]
    if len(sys.argv) > 2: jobs = [j for j in jobs if f'{j[0]}_{j[1]}' in sys.argv[2:]]
    for dn, lab in jobs:
        D, y, g, M, oof, nest, cov = run_A(lab) if des == 'A' else run_B(lab, int(dn[2:])) if des == 'B' else run_C(lab)
        np.savez_compressed(f'{W}/oof_{dn}_{lab}.npz', y=y, g=g, ep=(D.episode_id.values if 'episode_id' in D else D.consult_uid.values).astype(str),
                            **{f'oof_{m}': o for m, o in oof.items()}, **{f'nest_{m}': o for m, o in nest.items()})
        json.dump({'design': dn, 'lab': lab, 'n': len(y), 'pos': int(y.sum()), 'clusters': int(len(np.unique(g))), 'cols': M, 'cov': cov},
                  open(f'{W}/res_{dn}_{lab}.json', 'w'), indent=1, default=str)
        print(dn, lab, 'n', len(y), 'pos', int(y.sum()), {m: round(roc_auc_score(y, o.mean(0)), 3) for m, o in oof.items()}, cov, f'{time.time() - t0:.0f}s', flush=True)
