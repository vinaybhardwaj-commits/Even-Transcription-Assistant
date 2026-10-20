# ft-whoconverts (20 Oct 2026): conversion rate by patient, visit, doctor and process characteristics. D split only. Descriptive, post hoc.
# Rows: design A (every D episode with the label final; features_D) for patient/visit/doctor/history; design B day 7 (lm7 rows: Rx >= 1 Jan
# 2026, not converted by day 7) for counsellor calls before day 7. Outcomes h14 (primary), h90, Ale (secondary).
# Tests: each level with n >= 10 vs the rest of its characteristic, two-sided Fisher exact; doctor = one permutation test of doctor
# heterogeneity within specialty; duplicate masks untested (UNTEST). Ale rows restricted to age_days >= 14 (refute finding 9). Benjamini-Hochberg within each outcome; flag q < 0.10. Clusters (cluster_key) are ~1 row each; ignored.
import os, sys, json, hashlib
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.expanduser('~/wt/ft-forest/code'))
import warnings; warnings.simplefilter('ignore')
import numpy as np, pandas as pd
from scipy.stats import fisher_exact
from statsmodels.stats.contingency_tables import StratifiedTable
import forest_build as FB

OUT = os.path.expanduser('~/oc/forest-lead/ft/out/ft-whoconverts')
PIN = os.path.expanduser('~/eta-data/forest/ft8/ft8-pull-a-day.tsv')     # D-only day-cut pull (1,233 rows); pin_code used as 3-digit zone only
# Levels shown but not tested because their mask repeats (or complements) another tested level (ft-refute-whoconverts finding 3/16).
UNTEST = {'Procedures advised': ('0',), 'First call': ('no call',), 'Talk time before day 7': ('0',), 'Pincode zone (3-digit)': ('Z1',)}
LABS = ['h14', 'h90', 'ale']; MIN_TEST = 10; M_DOC = 10; NPERM = 2000; SEED = 20261019


def wilson(k, n, z=1.96):
    if n == 0: return (np.nan, np.nan)
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def bh(p):
    p = np.asarray(p, float); m = len(p); o = np.argsort(p); q = np.empty(m); run = 1.0
    for i in range(m - 1, -1, -1):
        run = min(run, p[o[i]] * m / (i + 1)); q[o[i]] = run
    return q


def sha12(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()[:12]


def frame():
    F = FB.load_F(); assert set(F.split) == {'D'}
    F8, c8 = FB.load_ft8(); F = F.merge(F8, on='episode_id', how='left', validate='1:1')
    pin = pd.read_csv(PIN, sep='\t', dtype=str, usecols=['prescription_uid', 'pin_code'])
    assert len(pin) == len(F) and set(pin.prescription_uid) == set(F.prescription_uid)
    F = F.merge(pin, on='prescription_uid', how='left', validate='1:1')
    z3 = F.pin_code.where(F.pin_code.fillna('').str.fullmatch(r'\d{6}')).str[:3]
    top = z3.value_counts(); top = top[top >= 30].index.tolist()
    zmap = {z: f'Z{i + 1}' for i, z in enumerate(top)}
    F['zone'] = np.where(z3.isna(), 'no pincode', z3.map(zmap).fillna('other zones (<30 each)'))
    F = F.drop(columns=['pin_code'])
    la = pd.concat([pd.read_parquet(FB.P['features_ale'])[['episode_id', 'consult_lang', 'split']],
                    pd.read_parquet(FB.P['features_all'])[['episode_id', 'consult_lang', 'split']]])
    assert set(la.split) == {'D'}
    la = la.dropna(subset=['episode_id']).drop_duplicates('episode_id')
    F = F.merge(la[['episode_id', 'consult_lang']], on='episode_id', how='left')
    F['lang'] = F.consult_lang.map({'en-IN': 'English', 'kn-IN': 'Kannada', 'hi-IN': 'Hindi'}).fillna('other / mixed')
    F.loc[~F.episode_id.isin(la.episode_id), 'lang'] = 'no consult audio'
    F.loc[F.episode_id.isin(la.episode_id) & F.consult_lang.isna(), 'lang'] = 'language not detected'
    return F, zmap


def spec_group(s):
    vc = s.value_counts(); return s.where(s.isin(vc[vc >= 20].index), 'other')


def chars(F):
    """-> list of (family, characteristic, Series of levels) on design A rows."""
    sc = F.specialty.value_counts(); keep = sc[sc >= 20].index
    age = pd.cut(F.age_y, [-1, 17, 29, 39, 49, 59, 200], labels=['<18', '18-29', '30-39', '40-49', '50-59', '60+']).astype(str)
    wd = F.weekday.map(dict(enumerate(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])))
    mo = F.rx_date.dt.strftime('%Y-%m')
    pp = F.payer_prior.map({'none': 'none recorded', 'cash': 'cash', 'other': 'insurance / other'})
    ret = np.where(F.ft8_has_prior_rx > 0, 'returning (earlier Even Rx)', 'new to Even')
    return [
        ('patient', 'Age band', age), ('patient', 'Sex', F.sex.map({'m': 'male', 'f': 'female'})),
        ('patient', 'New vs returning', pd.Series(ret, index=F.index)),
        ('patient', 'Payer before the advice', pp), ('patient', 'Pincode zone (3-digit)', F.zone),
        ('visit', 'Specialty', F.specialty.where(F.specialty.isin(keep), 'other specialties (<20 each)')),
        ('visit', 'Procedure group', F.proc_class), ('visit', 'Procedures advised', F.n_procs.clip(upper=2).map({0: '0', 1: '1', 2: '2+'})),
        ('visit', 'Investigations ordered', np.where(F.inv_missing == 0, 'yes', 'no')),
        ('visit', 'Consult language', F.lang),
        ('doctor', 'Doctor gender', F.doctor_gender.map({'m': 'male', 'f': 'female'})),
        ('process', 'Day of week of advice', wd), ('process', 'Month of advice', mo),
    ]


HIST = [('Meds on latest prior Rx', 'ft8_has_meds'), ('Any ICD history', 'ft8_has_icd'),
        ('Charlson condition', 'ft8_charlson_n'), ('Diabetes', 'ft8_dm'), ('Hypertension', 'ft8_htn'), ('Kidney disease', 'ft8_ckd'),
        ('Heart disease (CAD)', 'ft8_cad'), ('Obesity', 'ft8_obesity'), ('Named comorbidity', 'ft8_n_comorb_names'),
        ('Earlier IP admission', 'ft8_n_ip_events_pre'), ('BP recorded', 'ft8_has_bp'), ('HbA1c on file', 'ft8_has_hba1c'),
        ('Hb on file', 'ft8_has_hb'), ('Creatinine on file', 'ft8_has_creat'), ('eGFR on file', 'ft8_has_egfr'), ('TSH on file', 'ft8_has_tsh')]


def call_chars(X):
    nc = X.n_calls.clip(upper=3).astype(int).map({0: '0', 1: '1', 2: '2', 3: '3+'})
    fd = np.select([X.n_calls == 0, X.first_call_day <= 1], ['no call', 'day 0-1'], 'day 2-6')
    tk = np.select([X.talk_s == 0, X.talk_s < 120], ['0', '<2 min'], '2+ min')
    return [('process', 'Counsellor calls before day 7', nc), ('process', 'Any connected call before day 7', np.where(X.n_connected > 0, 'yes', 'no')),
            ('process', 'First call', pd.Series(fd)), ('process', 'Talk time before day 7', pd.Series(tk))]


def mh_or(m, y, strat):
    """Mantel-Haenszel odds ratio (level vs rest) stratified by specialty group: is the gap still there within specialty?"""
    T = [np.array([[np.sum(m & (y == 1) & (strat == s)), np.sum(m & (y == 0) & (strat == s))],
                   [np.sum(~m & (y == 1) & (strat == s)), np.sum(~m & (y == 0) & (strat == s))]], float) for s in np.unique(strat)]
    T = [t for t in T if t[0].sum() > 0 and t[1].sum() > 0 and t[:, 0].sum() > 0 and t[:, 1].sum() > 0]
    if not T: return (np.nan, np.nan, np.nan)
    st = StratifiedTable([t + 0.0 for t in T]); lo, hi = st.oddsratio_pooled_confint()
    return (float(st.oddsratio_pooled), float(lo), float(hi))


def rows_for(fam, name, lev, y, sub='', strat=None, untest=()):
    lev = pd.Series(np.asarray(lev), dtype=object).fillna('missing').values; y = np.asarray(y).astype(int); out = []
    for L in sorted(set(lev), key=lambda v: -np.sum(lev == v)):
        m = lev == L; n = int(m.sum()); k = int(y[m].sum()); lo, hi = wilson(k, n)
        p = np.nan
        if n >= MIN_TEST and (~m).sum() >= MIN_TEST and len(set(lev)) > 1 and L not in untest:
            p = float(fisher_exact([[k, n - k], [int(y[~m].sum()), int((~m).sum() - y[~m].sum())]])[1])
        mh = mh_or(m, y, strat) if (strat is not None and not np.isnan(p)) else (np.nan, np.nan, np.nan)
        out.append(dict(family=fam, char=name, sub=sub, level=str(L), n=n, k=k, rate=k / n, lo=lo, hi=hi, p=p, or_mh=mh[0], or_lo=mh[1], or_hi=mh[2]))
    if len(set(lev)) == 2:          # a two-level split is one comparison, not two
        for r in out[1:]: r['p'] = np.nan
    return out


def hist_rows(F, y, sub, strat):
    out = []
    for name, c in HIST:
        out += rows_for('history', name, np.where(F[c].fillna(0).values > 0, 'present', 'absent'), y, sub, strat)
    return out


def doctors(F, y, rng):
    d = pd.DataFrame({'doc': F.doctor_id.values, 'spec': F.specialty.values, 'y': y})
    ps = d.groupby('spec').y.transform('mean').values
    def stat(yy):
        g = pd.DataFrame({'doc': d.doc, 'e': ps, 'y': yy}).groupby('doc').agg(k=('y', 'sum'), e=('e', 'sum'), n=('y', 'size'))
        v = (g.e / g.n) * (1 - g.e / g.n) * g.n
        return float((((g.k - g.e) ** 2) / v.where(v > 0)).sum())
    s0 = stat(y); sp = d.spec.values; null = []
    for _ in range(NPERM):
        yy = y.copy()
        for s in np.unique(sp):
            ix = np.where(sp == s)[0]; yy[ix] = y[rng.permutation(ix)]
        null.append(stat(yy))
    p = (1 + np.sum(np.array(null) >= s0)) / (NPERM + 1)
    g = d.groupby('doc').agg(spec=('spec', 'first'), n=('y', 'size'), k=('y', 'sum')).reset_index()
    sr = d.groupby('spec').y.mean(); g['spec_rate'] = g.spec.map(sr)
    g['raw'] = g.k / g.n; g['shrunk'] = (g.k + M_DOC * g.spec_rate) / (g.n + M_DOC)
    g = g.sort_values(['n', 'k'], ascending=False).reset_index(drop=True); g['label'] = [f'D{i + 1}' for i in range(len(g))]
    return g.drop(columns=['doc']), float(p), s0


def main():
    rng = np.random.default_rng(SEED)
    F, zmap = frame(); res = {}; docs = {}
    for lab in LABS:
        A = F[F[lab].notna() & ((F.age_days >= 14) if lab == 'ale' else True)].reset_index(drop=True); y = A[lab].values.astype(int); R = []
        sp = spec_group(A.specialty).values
        for fam, name, lev in chars(A): R += rows_for(fam, name, lev, y, strat=None if name == 'Specialty' else sp, untest=UNTEST.get(name, ()))
        B = FB.build('lm7', lab); X = B.DX; spb = spec_group(X.specialty).values
        if lab == 'ale':
            keep = X.age_days.values >= 14; X = X[keep].reset_index(drop=True); yb = B.y[keep]; spb = spb[keep]
        else: yb = B.y
        for fam, name, lev in call_chars(X): R += [dict(r, cohort='lm7') for r in rows_for(fam, name, lev, yb, strat=spb, untest=UNTEST.get(name, ()))]
        R += hist_rows(A, y, '', sp)
        rt = A.ft8_has_prior_rx.values > 0
        R += hist_rows(A[rt].reset_index(drop=True), y[rt], 'returning only', sp[rt])
        g, pdoc, s0 = doctors(A, y, rng)
        R.append(dict(family='doctor', char='Doctor (within specialty)', sub='', level='spread test', n=len(A), k=int(y.sum()),
                      rate=y.mean(), lo=np.nan, hi=np.nan, p=pdoc))
        p = np.array([r['p'] for r in R], float); ok = ~np.isnan(p); q = np.full(len(p), np.nan); q[ok] = bh(p[ok])
        for r, qq in zip(R, q): r['q'] = qq; r.setdefault('cohort', 'A')
        res[lab] = dict(n=int(len(A)), pos=int(y.sum()), n_lm7=int(len(yb)), pos_lm7=int(yb.sum()), n_tests=int(ok.sum()),
                        n_flag=int(np.sum(q[ok] < 0.10)), rows=R, n_returning=int(rt.sum()), pos_returning=int(y[rt].sum()))
        docs[lab] = g
        print(lab, res[lab]['n'], res[lab]['pos'], 'tests', res[lab]['n_tests'], 'flag', res[lab]['n_flag'], 'doctor p', round(pdoc, 4), flush=True)
    os.umask(0o077)
    json.dump(dict(res=res, zones=len(zmap), inputs={k: sha12(v) for k, v in
              dict(features_D=FB.P['features_D'], labels=FB.P['labels'], ft8=FB.P['ft8'], features_all=FB.P['features_all'],
                   features_ale=FB.P['features_ale'], calls_D=FB.P['calls_D'], pin_pull=PIN).items()}),
              open(f'{OUT}/desc.json', 'w'), default=float)
    for lab, g in docs.items(): g.to_csv(f'{OUT}/doctors_{lab}.csv', index=False)
    zl = os.path.expanduser('~/eta-data/forest/whoconverts'); os.makedirs(zl, exist_ok=True)      # prefixes kept out of the shared out tree
    pd.DataFrame({'zone': list(zmap.values()), 'prefix3': list(zmap.keys())}).to_csv(f'{zl}/zones_map_LOCAL.tsv', sep='\t', index=False)


if __name__ == '__main__':
    main()
