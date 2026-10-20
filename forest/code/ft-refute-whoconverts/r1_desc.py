# ft-refute-whoconverts (20 Oct 2026): independent recompute of the WHO-CONVERTS h14 rows, BH flags, doctor spread test, day-7 call table.
# D split only: features_D (asserted D), ft8 (1,233 rows keyed to D), ft8-pull-a-day (uid set == D, asserted), calls_D + tags_D_jev,
# frozen lm7 OOF ids. No forest_build import; f1 hash-only TSV (holds H rows) is NOT read: lm7 rows come from the frozen OOF ids.
import os, sys, json
sys.dont_write_bytecode = True
import warnings; warnings.simplefilter('ignore')
import numpy as np, pandas as pd
from scipy.stats import fisher_exact
from statsmodels.stats.contingency_tables import StratifiedTable
from statsmodels.stats.multitest import multipletests

H = os.path.expanduser; O = H('~/oc/forest-lead/ft/out'); OUT = f'{O}/ft-refute-whoconverts'
F = pd.read_parquet(f'{O}/ft-labels-base/features_D.parquet'); assert set(F.split) == {'D'} and len(F) == 1233
F8 = pd.read_parquet(f'{O}/ft8-clinical/features_ft8.parquet'); assert len(F8) == 1233 and set(F8.episode_id) == set(F.episode_id)
F = F.merge(F8, on='episode_id', validate='1:1')
pin = pd.read_csv(H('~/eta-data/forest/ft8/ft8-pull-a-day.tsv'), sep='\t', dtype=str, usecols=['prescription_uid', 'pin_code'])
assert set(pin.prescription_uid) == set(F.prescription_uid) and len(pin) == 1233
F = F.merge(pin, on='prescription_uid', validate='1:1')
p3 = F.pin_code.where(F.pin_code.fillna('').str.match(r'^\d{6}$')).str[:3]
vc = p3.value_counts(); big = vc[vc >= 30].index
F['zone'] = np.where(p3.isna(), 'nopin', np.where(p3.isin(big), 'Z' + p3.map({z: str(i + 1) for i, z in enumerate(big)}).fillna(''), 'other'))
F = F.drop(columns=['pin_code']); del pin, p3
F['ale'] = np.where(F.days_to_surgery <= 14, 1.0, np.where(F.age_days >= 14, 0.0, np.nan))   # as forest_build.load_F


def test(y, m):
    k1, n1 = int(y[m].sum()), int(m.sum()); k0, n0 = int(y[~m].sum()), int((~m).sum())
    return fisher_exact([[k1, n1 - k1], [k0, n0 - k0]])[1]


def mh(y, m, s):
    T = []
    for v in np.unique(s):
        i = s == v; t = np.array([[np.sum(m & i & (y == 1)), np.sum(m & i & (y == 0))], [np.sum(~m & i & (y == 1)), np.sum(~m & i & (y == 0))]], float)
        if (t.sum(1) > 0).all() and (t.sum(0) > 0).all(): T.append(t)
    if not T: return (np.nan, [np.nan, np.nan])
    st = StratifiedTable(T); return round(st.oddsratio_pooled, 2), [round(x, 2) for x in st.oddsratio_pooled_confint()]


def family(lev, y, name, out, strat=None):
    lev = np.asarray(pd.Series(lev).fillna('NA').astype(str)); L = pd.Series(lev).value_counts()
    two = len(L) == 2; done = False
    for l, n in L.items():
        m = lev == l
        r = dict(fam=name, level=l, n=int(n), k=int(y[m].sum()), rate=round(y[m].mean(), 3), p=np.nan)
        if n >= 10 and (~m).sum() >= 10 and not (two and done):
            r['p'] = test(y, m); done = True
        if strat is not None and n >= 10 and name != 'specialty': r['mh'] = mh(y, m, strat)
        out.append(r)


HIST = ['ft8_has_meds', 'ft8_has_icd', 'ft8_charlson_n', 'ft8_dm', 'ft8_htn', 'ft8_ckd', 'ft8_cad', 'ft8_obesity', 'ft8_n_comorb_names',
        'ft8_n_ip_events_pre', 'ft8_has_bp', 'ft8_has_hba1c', 'ft8_has_hb', 'ft8_has_creat', 'ft8_has_egfr', 'ft8_has_tsh']


def lm7_calls(lab):
    fz = json.load(open(f'{O}/ft-forest/model_frozen_lm7_h14.json'))[0]; ids = fz['oof']['episode_id']
    X = F.set_index('episode_id').loc[ids]
    if lab != 'h14':        # other labels: same rule as the builder (Rx >= 2026, not converted by day 7); amb_hash unknown without f1 -> use h14 ids' complement rule
        X = F[F[lab].notna() & (F.rx_date >= '2026-01-01') & ~(F.days_to_surgery <= 7)].set_index('episode_id')
    C = pd.read_parquet(f'{O}/ft-calltext/calls_D.parquet'); t = pd.read_json(f'{O}/ft-text2/tags_D_jev.jsonl', lines=True).drop_duplicates('call_id', keep='last')
    C = C.merge(t[['call_id', 'outcome_revealed', 'outcome_revealed_unverified']], on='call_id', how='left')
    leak = C.outcome_revealed.eq(True) | C.outcome_revealed_unverified.eq(True)
    keep_leak = os.environ.get('KEEP_LEAK') == '1'
    c = C[(keep_leak | ~leak) & (C.day_from_rx < 7) & C.episode_id.isin(X.index)]
    g = c.groupby('episode_id'); n = g.size().reindex(X.index).fillna(0); fd = g.day_from_rx.min().reindex(X.index)
    conn = g.duration.apply(lambda s: (s > 0).sum()).reindex(X.index).fillna(0); talk = g.duration.sum().reindex(X.index).fillna(0)
    y = X[lab].values.astype(int)
    ncat = np.where(n >= 3, '3+', n.astype(int).astype(str))
    first = np.where(n == 0, 'none', np.where(fd <= 1, 'd0-1', 'd2-6'))
    tk = np.where(talk == 0, '0', np.where(talk < 120, '<2m', '2m+'))
    # leak calls dropped: how many lm7 rows lose a call that way, by outcome
    lc = C[leak & (C.day_from_rx < 7) & C.episode_id.isin(X.index)].episode_id.unique()
    return X, y, dict(ncalls=ncat, connected=np.where(conn > 0, 'yes', 'no'), first=first, talk=tk), dict(rows_with_dropped_leak_call=len(lc),
            pos_among=int(X.loc[lc, lab].sum()) if len(lc) else 0)


def doctor_test(doc, spec, y, rng, nperm=2000):
    # statistic: sum over specialties of the G (likelihood-ratio) statistic of doctor x outcome; permute y within specialty
    def G(yy):
        tot = 0.0
        for s in np.unique(spec):
            i = spec == s; d = pd.crosstab(doc[i], yy[i]).values.astype(float)
            if d.shape[1] < 2 or d.shape[0] < 2: continue
            e = d.sum(1, keepdims=True) * d.sum(0, keepdims=True) / d.sum()
            tot += 2 * np.nansum(np.where(d > 0, d * np.log(d / e), 0))
        return tot
    g0 = G(y); idx = {s: np.where(spec == s)[0] for s in np.unique(spec)}; null = []
    for _ in range(nperm):
        yy = y.copy()
        for s, ix in idx.items(): yy[ix] = y[rng.permutation(ix)]
        null.append(G(yy))
    return (1 + np.sum(np.array(null) >= g0)) / (nperm + 1)


def run(lab, rng, extra_mask=None):
    A = F[F[lab].notna()].reset_index(drop=True)
    if extra_mask is not None: A = A[extra_mask(A)].reset_index(drop=True)
    y = A[lab].values.astype(int); out = []
    sc = A.specialty.value_counts(); sg = A.specialty.where(A.specialty.isin(sc[sc >= 20].index), 'other').values
    family(pd.cut(A.age_y, [-1, 17, 29, 39, 49, 59, 200]).astype(str), y, 'age', out, sg)
    family(A.sex, y, 'sex', out, sg); family(np.where(A.ft8_has_prior_rx > 0, 'ret', 'new'), y, 'newret', out, sg)
    family(A.payer_prior, y, 'payer_prior', out, sg); family(A.zone, y, 'zone', out, sg)
    family(sg, y, 'specialty', out); family(A.proc_class, y, 'proc', out, sg); family(A.n_procs.clip(upper=2), y, 'nprocs', out, sg)
    family(A.inv_missing, y, 'inv', out, sg); family(A.doctor_gender, y, 'docgender', out, sg)
    family(A.weekday, y, 'weekday', out, sg); family(A.rx_date.dt.strftime('%Y-%m'), y, 'month', out, sg)
    # consult language: own join (features_ale first, then features_all), D asserted
    la = pd.concat([pd.read_parquet(f'{O}/ft-audio/features_ale.parquet', columns=['episode_id', 'consult_lang', 'split']),
                    pd.read_parquet(f'{O}/ft-cohortb-expand/features_all.parquet', columns=['episode_id', 'consult_lang', 'split'])])
    assert set(la.split) == {'D'}; la = la.dropna(subset=['episode_id']).drop_duplicates('episode_id').set_index('episode_id').consult_lang
    lang = np.where(~A.episode_id.isin(la.index), 'noaudio', A.episode_id.map(la).fillna('nodetect').astype(str))
    lang = np.where(np.isin(lang, ['en-IN', 'kn-IN', 'hi-IN', 'noaudio', 'nodetect']), lang, 'other')
    family(lang, y, 'lang', out, sg)
    for c in HIST: family(np.where(A[c].fillna(0) > 0, 'present', 'absent'), y, 'hist:' + c, out, sg)
    rt = (A.ft8_has_prior_rx > 0).values
    for c in HIST: family(np.where(A[c].fillna(0)[rt] > 0, 'present', 'absent'), y[rt], 'histret:' + c, out, sg[rt])
    X, yb, cc, leakinfo = lm7_calls(lab)
    sb = X.specialty.value_counts(); sgb = X.specialty.where(X.specialty.isin(sb[sb >= 20].index), 'other').values
    for k, v in cc.items(): family(v, yb, 'calls:' + k, out, sgb)
    pd_ = doctor_test(A.doctor_id.values, A.specialty.values, y, rng)
    out.append(dict(fam='doctor', level='spread', n=len(A), k=int(y.sum()), p=pd_))
    p = np.array([r['p'] for r in out], float); ok = ~np.isnan(p)
    q = np.full(len(p), np.nan); q[ok] = multipletests(p[ok], method='fdr_bh')[1]
    for r, qq in zip(out, q): r['q'] = qq
    return dict(n=len(A), pos=int(y.sum()), n_lm7=len(yb), pos_lm7=int(yb.sum()), n_tests=int(ok.sum()), n_flag=int((q[ok] < 0.10).sum()),
                leak_calls=leakinfo, rows=out)


if __name__ == '__main__':
    rng = np.random.default_rng(7); res = {}
    for lab in ('h14', 'h90', 'ale'):
        res[lab] = run(lab, rng); print(lab, res[lab]['n'], res[lab]['pos'], res[lab]['n_lm7'], res[lab]['pos_lm7'], 'tests', res[lab]['n_tests'], 'flags', res[lab]['n_flag'], res[lab]['leak_calls'])
    os.umask(0o077)
    json.dump(res, open(f'{OUT}/r1_desc.json', 'w'), default=float, indent=0)
