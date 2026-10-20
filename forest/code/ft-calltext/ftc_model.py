# ft-calltext model (19 Oct 2026). D split only. RF Pulse baseline (FT3 features, FT3 fit_predict: doctor OOF prior) vs baseline + call
# features, on the SAME rows and SAME folds: repeated stratified group CV (5 folds x 5 repeats, groups = RD-0 cluster), pooled OOF AUC with
# cluster-bootstrap CI, paired delta AUC (call - base) with cluster-bootstrap CI, fold-wise permutation importance with CIs.
# Rows: Rx >= 2026-01-01 (Dec 2025 has no leads), label final; cohort P = drop shared contact_hash (brief), cohort S = drop all F1-ambiguous.
# Window designs (calls revealing the outcome are always dropped):
#   asis     : calls on days [0,14] after Rx and before the surgery day (brief rule). Positives' windows are shorter (bias, see report).
#   matched  : negatives' window also cut at a pseudo surgery day drawn from the positives' days_to_surgery (seeded), so window length
#              carries no label information.
#   lm3/lm7  : PRIMARY. Post-Rx landmark model (prediction at Rx+T, T=3/7): calls dated < T only; episodes with surgery <= T dropped;
#              label = surgery in (T, H] vs none by day H.
import os, json, sys, time
import numpy as np, pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedGroupKFold, GroupKFold
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss

OD = os.path.expanduser('~/oc/forest-lead/ft/out/ft-calltext'); LB = os.path.expanduser('~/oc/forest-lead/ft/out/ft-labels-base')
RS = 20261019; NB = int(os.environ.get('NB', 1000)); REPS = int(os.environ.get('REPS', 5))
F = pd.read_parquet(f'{LB}/features_D.parquet'); BCOLS = json.load(open(f'{LB}/features_D.cols.json'))
# FT3 primary baseline: same-day payer OFF (leaky at Rx time; refute fix 2, forest-lead 19 Oct). PAYER=1 = labelled sensitivity.
PAYER = os.environ.get('PAYER') == '1'
if not PAYER: BCOLS = [c for c in BCOLS if c != 'payer']
# Ale label (ft-audio assemble.py rule): 1 = attributable surgery within 14 d; 0 = Rx >= 14 d old with none; younger = drop
F['ale'] = np.where(F.days_to_surgery <= 14, 1.0, np.where(F.age_days >= 14, 0.0, np.nan))
# optional call-AUDIO features (ft-rl-feat). AUDIO=<parquet>: per-call rows (episode_id, call_id, day_from_rx, aud_* numeric) are
# aggregated per landmark window; episode-level rows (episode_id, aud_*) are used as-is and are valid only for the landmark they were built for.
AUDIO = os.environ.get('AUDIO'); AUDIO_T = os.environ.get('AUDIO_T')   # AUDIO_T: landmark the episode-level file was built for
assert set(F.split) == {'D'}
E = pd.read_parquet(f'{OD}/episodes_D.parquet')[['episode_id', 'amb_hash', 'ambiguous']]
F = F.merge(E, on='episode_id', how='left'); assert F.ambiguous.notna().all()
# forest-lead 19 Oct: primary ambiguity = hash-only F1 flag (contact_hash shared); cluster-level, D only
_f1 = pd.read_csv(os.path.expanduser('~/eta-data/forest/funnel/hash-only/f1-2026-10-19.tsv'), sep='\t', dtype=str)
F['amb_hash'] = F.cluster_key.isin(set(_f1.loc[(_f1.split == 'D') & (_f1.ambiguous == 'true'), 'cluster_key']))
F['ambiguous'] = F.ambiguous | F.amb_hash
C = pd.read_parquet(f'{OD}/calls_D.parquet')
T = pd.read_json(f'{OD}/tags_D.jsonl', lines=True).drop_duplicates('call_id', keep='last') if os.path.exists(f'{OD}/tags_D.jsonl') else None
OBJ = ['cost', 'insurance', 'fear', 'second_opinion', 'going_elsewhere', 'timing', 'family_decision', 'unreachable']

C = C.merge(T[['call_id', 'outcome_revealed', 'outcome_revealed_unverified', 'objections', 'intent', 'next_step', 'price_quoted']], on='call_id', how='left')
C['tagged'] = C.outcome_revealed.notna()
C['leak'] = C.outcome_revealed.eq(True) | C.outcome_revealed_unverified.eq(True)
C = C.merge(F[['episode_id', 'days_to_surgery']], on='episode_id')


def call_feats(D, y, design, rng):
    """Episode-level call features for rows D under a window design. Returns feature frame aligned to D and group dict."""
    cut = pd.Series(15.0, index=D.episode_id.values)                  # calls with day_from_rx < cut are usable (days 0..14)
    has = D.days_to_surgery.notna().values
    if design in ('asis', 'matched'):
        cut[has] = np.minimum(15, D.days_to_surgery.values[has])
        if design == 'matched':                                         # every negative gets a pseudo surgery day from the positives
            pool = np.minimum(15, D.days_to_surgery.values[y == 1])
            neg = y == 0
            cut[neg] = np.minimum(cut[neg].values, rng.choice(pool, neg.sum()))
    elif design.startswith('lm'):
        cut[:] = int(design[2:])                                        # landmark T (forest-lead 19 Oct): calls dated days 0..T-1 (< T)
    c = C[C.episode_id.isin(D.episode_id)].copy()
    c = c[(c.day_from_rx < c.episode_id.map(cut)) & ~c.leak]
    g = c.groupby('episode_id')
    X = pd.DataFrame(index=D.episode_id.values)
    X['n_calls'] = g.size(); X['n_connected'] = g.duration.apply(lambda s: (s > 0).sum())
    X['talk_s'] = g.duration.sum(); X['max_call_s'] = g.duration.max(); X['n_recorded'] = g.has_recording.sum()
    X['first_call_day'] = g.day_from_rx.min(); X['n_summaries'] = g.tagged.sum()
    t = c[c.tagged]
    for o in OBJ:
        X[f'obj_{o}'] = t.assign(v=t.objections.apply(lambda l: o in l)).groupby('episode_id').v.max()
    for v in ('wants_surgery', 'undecided', 'declines'):
        X[f'intent_{v}'] = t.assign(v=t.intent.eq(v)).groupby('episode_id').v.max()
    X['next_step_any'] = t.assign(v=t.next_step.ne('none')).groupby('episode_id').v.max()
    X['next_visit'] = t.assign(v=t.next_step.eq('visit_or_consult_scheduled')).groupby('episode_id').v.max()
    X['price_quoted'] = t.price_quoted.astype(bool).groupby(t.episode_id).max()
    X = X.astype(float)
    cnt = ['n_calls', 'n_connected', 'talk_s', 'max_call_s', 'n_recorded', 'n_summaries']
    X[cnt] = X[cnt].fillna(0); X['first_call_day'] = X.first_call_day.fillna(-1)   # -1 = no call in window
    X['no_summary'] = (X.n_summaries == 0).astype(float)
    tagc = [k for k in X.columns if k.startswith(('obj_', 'intent_', 'next_', 'price'))]
    X[tagc] = X[tagc].fillna(0)
    groups = {'n_calls': ['n_calls', 'n_connected', 'n_recorded'], 'talk_time': ['talk_s', 'max_call_s'], 'first_call_day': ['first_call_day'],
              'objections': [f'obj_{o}' for o in OBJ], 'intent': [k for k in tagc if k.startswith('intent_')],
              'next_step': ['next_step_any', 'next_visit'], 'price_quoted': ['price_quoted'], 'n_summaries': ['n_summaries', 'no_summary']}
    return X.reset_index(drop=True), groups


# ---- FT3 machinery (copied from ft-labels-base/code/ft3_model.py, parameterised by feature list) ----
def doc_rate(tr_doc, tr_y, ap_doc, m=10):
    g = pd.DataFrame({'d': tr_doc, 'y': tr_y}).groupby('d').y.agg(['sum', 'count']); p = tr_y.mean()
    r = ((g['sum'] + m * p) / (g['count'] + m)).to_dict(); v = g['count'].to_dict()
    return np.array([r.get(d, p) for d in ap_doc]), np.array([v.get(d, 0) for d in ap_doc])


class Enc:
    def __init__(self, cols, X):
        self.cat = [c for c in cols if X[c].dtype == object and c != 'doctor_id']; self.num = [c for c in cols if c not in self.cat + ['doctor_id']]
    def fit(self, X):
        self.levels = {c: [l for l, n in X[c].value_counts().items() if n >= 10] for c in self.cat}; return self
    def tf(self, X, dr, dv):
        out = [X[self.num].astype(float).fillna(-1).values]
        for c in self.cat:
            for l in self.levels[c]: out.append((X[c] == l).values[:, None].astype(float))
        out += [dr[:, None], dv[:, None]]
        return np.hstack(out)


def fit_predict(cols, Xtr, ytr, gtr, Xte, seed=RS):
    drt = np.zeros(len(Xtr)); dvt = np.zeros(len(Xtr))
    for a, b in GroupKFold(5).split(Xtr, ytr, gtr):
        drt[b], dvt[b] = doc_rate(Xtr.doctor_id.values[a], ytr[a], Xtr.doctor_id.values[b])
    enc = Enc(cols, Xtr).fit(Xtr)
    rf = RandomForestClassifier(n_estimators=400, min_samples_leaf=5, max_features='sqrt', n_jobs=int(os.environ.get('NJ', 12)), random_state=seed).fit(enc.tf(Xtr, drt, dvt), ytr)
    rf.n_jobs = 1
    g = pd.DataFrame({'d': Xtr.doctor_id.values, 'y': ytr}).groupby('d').y.agg(['sum', 'count']); p0 = ytr.mean()
    rm = ((g['sum'] + 10 * p0) / (g['count'] + 10)).to_dict(); vm = g['count'].to_dict()
    score = lambda X: rf.predict_proba(enc.tf(X, np.array([rm.get(d, p0) for d in X.doctor_id]), np.array([vm.get(d, 0) for d in X.doctor_id])))[:, 1]
    return score(Xte), score


def metrics(y, p): return dict(auc=roc_auc_score(y, p), prauc=average_precision_score(y, p), brier=brier_score_loss(y, p))


def cl_boot_idx(g, nb, seed):
    rng = np.random.default_rng(seed); ug = np.unique(g); idx = {k: np.where(g == k)[0] for k in ug}
    for _ in range(nb):
        yield np.concatenate([idx[k] for k in rng.choice(ug, len(ug))])


def boot(y, p, g, nb=NB, seed=RS):
    res = [list(metrics(y[s], p[s]).values()) for s in cl_boot_idx(g, nb, seed) if 0 < y[s].sum() < len(s)]
    lo, hi = np.percentile(res, [2.5, 97.5], axis=0); pt = metrics(y, p)
    return {k: (pt[k], lo[i], hi[i]) for i, k in enumerate(pt)}


def boot_delta(y, pa, pb, g, nb=NB, seed=RS):
    d = [roc_auc_score(y[s], pb[s]) - roc_auc_score(y[s], pa[s]) for s in cl_boot_idx(g, nb, seed) if 0 < y[s].sum() < len(s)]
    return (roc_auc_score(y, pb) - roc_auc_score(y, pa), *np.percentile(d, [2.5, 97.5]), float(np.mean(np.array(d) <= 0)))


BGROUPS = {'specialty': ['specialty'], 'doctor': ['doctor_id'], 'procedure': ['proc_class', 'n_procs'], **({'payer': ['payer']} if PAYER else {}),
           'icd': [c for c in BCOLS if c.startswith('ch_')] + ['n_icd', 'icd_missing'], 'age': ['age_y']}


def perm_imp(score, X, y, g, groups, nb, seed):
    rng = np.random.default_rng(seed); out = {f: [] for f in groups}
    for s in cl_boot_idx(g, nb, seed):
        Xs = X.iloc[s].reset_index(drop=True); ys = y[s]
        if not 0 < ys.sum() < len(s): continue
        base = roc_auc_score(ys, score(Xs))
        for f, cs in groups.items():
            Xp = Xs.copy(); pi_ = rng.permutation(len(Xp)); Xp[cs] = Xp[cs].values[pi_]; out[f].append(base - roc_auc_score(ys, score(Xp)))
    return {f: float(np.mean(v)) for f, v in out.items()}


RLF_DROP = ('n_calls_dropped_outcome', 'role_fallback_share')   # outcome-revealing-call count = leak; role QC is not a predictor


def rlfeat_to_aud(A, design):
    """ft-rl-feat rlf_assemble.py format: one row per episode, window columns suffixed _t7 / _t14 (day_from_rx < T, outcome-revealing and
    post-event calls already dropped). Only the suffix matching this landmark is used; unsuffixed columns (all-call STT counts) are never used."""
    assert design.startswith('lm'), 'rl-feat audio is landmark-only'
    sfx = f'_t{design[2:]}'
    cols = [c for c in A.columns if c.endswith(sfx) and not c.startswith(RLF_DROP) and pd.api.types.is_numeric_dtype(A[c])]
    if os.environ.get('AUDIO_NOPAT') == '1':   # refute-rlfeat (4): drop role-dependent patient-side features (73% role fallback)
        cols = [c for c in cols if not c.startswith(('patient_', 'valence_gap', 'mean_patient_turn_s', 'counsellor_'))]
    assert cols, f'no {sfx} columns in audio file (rl-feat builds T=7 and T=14 only)'
    TALK_ = ('minutes', 'n_calls', 'n_calls_tagged', 'speech_min', 'turns_per_min', 'wpm_all', 'patient_wpm', 'mean_patient_turn_s',
             'patient_interrupt_per_min', 'counsellor_interrupt_per_min')
    def grp(c):
        b = c[:-len(sfx)]
        if b.startswith(('obj_', 'intent_', 'next_', 'price_')): return 'tags'
        if b.endswith('talk_share') or b in TALK_: return 'talk'
        return 'emo'                                                       # patient_/counsellor_/mixed_ valence, arousal, windows, gap
    out = A[['episode_id']].copy()
    for c in cols:
        out[f'aud_{grp(c)}__{c[:-len(sfx)]}'] = A[c].astype(float)
    # ft-refute-ftr fix 1 (leak): file membership is not information at Rx+T. An episode with no usable audio call before T gets ALL audio
    # features missing (-1 after fill) and aud_has = 0, even if it is in the file because of calls at/after T or outcome-revealing calls.
    has = A[f'n_calls{sfx}'].fillna(0).values > 0
    fc = [c for c in out.columns if c.startswith('aud_')]
    out.loc[~has, fc] = np.nan
    out['aud_has'] = has.astype(float)
    return out.drop_duplicates('episode_id')


def audio_feats(D, design):
    """Call-audio features aligned to D, or (None, {}) if no AUDIO file. Missing audio -> -1 plus aud_has flag."""
    if not AUDIO:
        return None, {}
    A = pd.read_parquet(AUDIO)
    A = A[A.episode_id.isin(D.episode_id)]
    conv = not any(c.startswith('aud_') for c in A.columns)
    if conv:
        A = rlfeat_to_aud(A, design)                                       # already windowed for this landmark
    ac = [c for c in A.columns if c.startswith('aud_') and pd.api.types.is_numeric_dtype(A[c])]
    if 'day_from_rx' in A.columns:                                         # per-call: apply the same window as the text features
        T_ = int(design[2:]) if design.startswith('lm') else 15
        A = A[A.day_from_rx < T_]
        if 'leak' in A.columns: A = A[~A.leak.astype(bool)]
        cnt = [c for c in ac if c.startswith(('aud_n_', 'aud_s_', 'aud_obj_', 'aud_intent_', 'aud_next', 'aud_price'))]
        agg = {c: ('max' if c.startswith(('aud_obj_', 'aud_intent_', 'aud_next', 'aud_price')) else 'sum') if c in cnt else 'mean' for c in ac}
        A = A.groupby('episode_id').agg(agg)
    else:
        assert conv or not design.startswith('lm') or AUDIO_T == design[2:], f'episode-level audio built for T={AUDIO_T}, not {design}'
        A = A.drop_duplicates('episode_id').set_index('episode_id')[ac]
    X = A.reindex(D.episode_id.values)
    if conv:
        X['aud_has'] = X['aud_has'].fillna(0.0); ac = [c for c in ac if c != 'aud_has']
    else:
        X['aud_has'] = X[ac].notna().any(axis=1).astype(float)
    X = X.astype(float).fillna(-1).reset_index(drop=True)
    groups = {}
    for c in ac:                                                           # group by stem: aud_<group>__<feat> or aud_<feat>
        groups.setdefault('audio:' + c[4:].split('__')[0], []).append(c)
    groups['audio:has'] = ['aud_has']
    return X, groups


def run_one(lab, cohort, design):
    D = F[F[lab].notna() & (F.rx_date >= '2026-01-01')]
    D = D[~D.amb_hash] if cohort == 'P' else D[~D.ambiguous]
    if design.startswith('lm'):
        D = D[~(D.days_to_surgery <= int(design[2:]))]                 # surgery <= T: decided, not at risk at prediction time
    D = D.reset_index(drop=True); y = D[lab].values.astype(int); g = D.cluster_key.values
    if design.startswith('lm'):                                            # F1 (ft-refute-rlfeat): landmark at-risk rule, asserted
        assert not (D.days_to_surgery <= int(design[2:])).any(), 'episode with event <= T kept'
    rng = np.random.default_rng(RS + 7)
    X, CG = call_feats(D, y, design, rng)
    XA, AG = audio_feats(D, design)
    DX = pd.concat([D, X] + ([XA] if XA is not None else []), axis=1)
    ccols = [c for v in CG.values() for c in v]; acols = [c for v in AG.values() for c in v]
    M = {'base': BCOLS, 'text': BCOLS + ccols, 'text_only': ccols + ['specialty', 'doctor_id']}
    if acols:
        M['text_audio'] = BCOLS + ccols + acols; M['audio'] = BCOLS + acols
    r = {'lab': lab, 'cohort': cohort, 'design': design, 'payer': PAYER, 'audio': AUDIO, 'n': len(D), 'pos': int(y.sum()),
         'clusters': int(len(np.unique(g))), 'with_window_call': int((X.n_calls > 0).sum()),
         'with_tagged_call': int((X.n_summaries > 0).sum()), 'pos_with_tagged_call': int(((X.n_summaries > 0).values & (y == 1)).sum())}
    if acols:
        r['with_audio'] = int((XA.aud_has > 0).sum()); r['pos_with_audio'] = int(((XA.aud_has > 0).values & (y == 1)).sum())
    oof = {m: np.zeros((REPS, len(D))) for m in M}
    for rep in range(REPS):
        for a, b in StratifiedGroupKFold(5, shuffle=True, random_state=RS + rep).split(D, y, g):
            tr, te = DX.iloc[a].reset_index(drop=True), DX.iloc[b].reset_index(drop=True)
            for m, cols in M.items():
                oof[m][rep, b], _ = fit_predict(cols, tr, y[a], g[a], te, RS + rep)
    P_ = {m: o.mean(0) for m, o in oof.items()}
    r['oof'] = {'episode_id': D.episode_id.tolist(), 'y': y.tolist(), 'cluster': g.tolist(),
                'by_model_repeat': {m: o.round(6).tolist() for m, o in oof.items()}}   # ft-refute-ftr fix 3 (repro)
    r['per_repeat_auc'] = {m: [roc_auc_score(y, o) for o in oof[m]] for m in M}
    r['auc'] = {m: boot(y, P_[m], g) for m in M}
    pairs = [('base', 'text')] + ([('text', 'text_audio'), ('base', 'text_audio'), ('base', 'audio')] if acols else [])
    r['delta'] = {}
    for a_, b_ in pairs:
        d = boot_delta(y, P_[a_], P_[b_], g)
        rd = np.array(r['per_repeat_auc'][b_]) - np.array(r['per_repeat_auc'][a_])
        r['delta'][f'{b_}-{a_}'] = {'delta': d[0], 'ci': [d[1], d[2]], 'p_boot_le0': d[3],
                                    'per_repeat': rd.tolist(), 'p_repeats_le0': float(np.mean(rd <= 0))}
    # fold-wise permutation importance on the richest model (refit on 4/5, permute held-out 1/5), CI over folds x reps
    top = 'text_audio' if acols else 'text'
    groups = {**BGROUPS, **CG, **AG}; fi = {f: [] for f in groups}
    for rep in range(2):
        for k, (a, b) in enumerate(StratifiedGroupKFold(5, shuffle=True, random_state=RS + rep).split(D, y, g)):
            tr, te = DX.iloc[a].reset_index(drop=True), DX.iloc[b].reset_index(drop=True)
            _, sc = fit_predict(M[top], tr, y[a], g[a], te, RS + rep)
            pi = perm_imp(sc, te, y[b], g[b], groups, nb=20, seed=RS + 31 * rep + k)
            for f in groups: fi[f].append(pi[f])
    rr = np.random.default_rng(RS)
    r['perm_model'] = top
    r['perm'] = {f: (float(np.mean(v)), *np.percentile([np.mean(rr.choice(v, len(v))) for _ in range(2000)], [2.5, 97.5])) for f, v in fi.items()}
    r['uni'] = {c: float(roc_auc_score(y, DX[c])) for c in ccols + acols if DX[c].nunique() > 1}
    return r


if __name__ == '__main__':
    T0 = time.time(); R = []
    combos = [(l, c, d) for l in ('h14', 'h90', 'ale') for c in ('P', 'S') for d in ('asis', 'matched', 'lm3', 'lm7')]
    if len(sys.argv) > 1: combos = [x for x in combos if '-'.join(x) in sys.argv[1:]]
    tag = os.environ.get('TAG', 'v2' + ('_payer' if PAYER else '') + ('_audio' if AUDIO else ''))
    for l, c, d in combos:
        r = run_one(l, c, d); R.append(r)
        f3 = lambda t: f'{t[0]:.3f} [{t[1]:.3f}, {t[2]:.3f}]'
        print(l, c, d, 'n', r['n'], 'pos', r['pos'], ' '.join(f'{m} {r["auc"][m]["auc"][0]:.3f}' for m in r['auc']), '|',
              ' '.join(f'{k} {v["delta"]:+.3f} [{v["ci"][0]:+.3f},{v["ci"][1]:+.3f}] pRep {v["p_repeats_le0"]:.2f}' for k, v in r['delta'].items()),
              f'{round(time.time() - T0)}s', flush=True)
        json.dump(R, open(f'{OD}/model_{tag}_{"_".join(sys.argv[1:]) or "all"}.json', 'w'), indent=1, default=float)
