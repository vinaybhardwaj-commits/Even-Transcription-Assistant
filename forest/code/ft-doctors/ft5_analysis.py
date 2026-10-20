"""FT5 analysis on episodes_D.pkl (built by ft5.py from labels.parquet, D split only). Writes tables to out/ft-doctors/ (0600).
(1) per-doctor H14/H90 within specialty, n >= 10, Wilson 95% CI, case-mix adjusted O/E;
    variance decomposition: one-way ANOVA (method of moments, observed scale, bootstrap CI), logistic GLMM (doctor random effect,
    latent-scale ICC, adjusted and unadjusted), fixed-effect LR test, deviance shares, repeated-CV check of doctor as a predictor.
(2) the 4 specialties with the most matured non-converted episodes + lost-conversion scenarios.
No doctor names in any file written here (names are rendered only into FT5-REPORT.md by ft5_tables.py).
(3) same-specialty high/low pairs with >= 5 recorded surgery pitches each (ft6-candidates + Haiku-confirmed f01, H excluded)."""
import os, sys, json, math, csv, collections, warnings
import numpy as np, pandas as pd
import statsmodels.api as sm, statsmodels.formula.api as smf
from statsmodels.genmod.bayes_mixed_glm import BinomialBayesMixedGLM
from scipy import stats
warnings.filterwarnings('ignore')
H = os.path.expanduser; FT = H('~/oc/forest-lead/ft'); OUT = f'{FT}/out/ft-doctors'
sys.path.insert(0, OUT); from ft5 import wilson, load_ref, lock_map

# ---- ML random-intercept logistic (Gauss-Hermite marginal likelihood), profile-likelihood CI for the doctor SD
from scipy import optimize, special
GH_X, GH_W = np.polynomial.hermite_e.hermegauss(40); GH_W = GH_W / GH_W.sum()   # nodes for N(0,1)
def ml_negll(beta, sig, X, y, g, G):
    lp = (X @ beta)[:, None] + sig * GH_X[None, :]
    ll = y[:, None] * lp - np.logaddexp(0, lp)
    S = np.zeros((G, len(GH_X))); np.add.at(S, g, ll)
    return -special.logsumexp(S + np.log(GH_W)[None, :], axis=1).sum()
def ml_fit_beta(sig, X, y, g, G, b0):
    f = lambda b: ml_negll(b, sig, X, y, g, G)
    o = optimize.minimize(f, b0, method='L-BFGS-B'); return o.fun, o.x
def ml_icc(e, formula_rhs):
    X = np.asarray(smf.glm(f'y ~ {formula_rhs}', e, family=sm.families.Binomial()).fit().model.exog); y = e.y.values.astype(float)
    codes, uniq = pd.factorize(e.doctor_uid); G = len(uniq)
    b0 = smf.glm(f'y ~ {formula_rhs}', e, family=sm.families.Binomial()).fit().params.values
    grid = np.r_[0.0, np.exp(np.linspace(np.log(0.02), np.log(2.0), 40))]
    prof = []
    for sg in grid:
        nll, b0 = ml_fit_beta(sg, X, y, codes, G, b0); prof.append(nll)
    prof = np.array(prof); i = int(prof.argmin()); s_hat = grid[i]; nll0 = prof[0]
    ok = grid[2 * (prof - prof[i]) <= 3.841]
    icc = lambda s: s * s / (s * s + math.pi ** 2 / 3)
    lr = max(0.0, 2 * (nll0 - prof[i]))
    return dict(sigma=float(s_hat), icc=icc(s_hat), icc_ci=[icc(ok.min()), icc(ok.max())], lr_sigma0=lr, p_sigma0=float(0.5 * stats.chi2.sf(lr, 1)) if lr > 0 else 1.0)

NMIN = 10; RNG = np.random.default_rng(20261019); NB = 1000
df = pd.read_pickle(f'{OUT}/episodes_D.pkl'); assert set(df.split) == {'D'}
spec_of, names = load_ref()
nm = lambda u: names.get(u, u[:6])
res = {}  # headline numbers -> results.json

# ---- case-mix covariates
df['age'] = df['age_y'].fillna(df['age_y'].median()).clip(0, 90)
df['age_c'] = (df['age'] - 40) / 15; df['age_c2'] = df['age_c'] ** 2
df['female'] = (df['sex'] == 'female').astype(int)
df['payer'] = df['payer_bill'].fillna(df['payer_appt']).map(lambda v: v if v in ('cash', 'credit') else ('other' if isinstance(v, str) else 'unknown'))
df['prior'] = (pd.to_numeric(df['n_prior_rx'], errors='coerce').fillna(0) > 0).astype(int)
small = df['pclass'].value_counts(); df['pc'] = df['pclass'].where(df['pclass'].map(small) >= 15, 'other')
df['n_icd'] = df['n_icd'].fillna(0).clip(0, 4); df['icd_missing'] = df['icd_missing'].fillna(1); df['n_inv'] = df['n_inv'].fillna(0); df['inv_missing'] = df['inv_missing'].fillna(1)
CASEMIX = 'C(pc) + age_c + age_c2 + female + C(payer) + prior + C(quarter) + n_icd + icd_missing + n_inv + inv_missing'

def fit_glm(formula, d):
    return smf.glm(formula, d, family=sm.families.Binomial()).fit()

def byar(o, e):
    lo = 0 if o == 0 else o * (1 - 1 / (9 * o) - 1.96 / (3 * math.sqrt(o))) ** 3
    hi = (o + 1) * (1 - 1 / (9 * (o + 1)) + 1.96 / (3 * math.sqrt(o + 1))) ** 3
    return lo / e, hi / e

def anova_tau(sub, y):
    """one-way random-effects ANOVA estimator of between-doctor variance within each specialty, pooled; returns (tau2, total var)."""
    num = den = 0.0
    for s, g in sub.groupby('specialty'):
        k = g.groupby('doctor_uid')[y].agg(['sum', 'size'])
        if len(k) < 2: continue
        N = k['size'].sum(); p = k['sum'].sum() / N; r = k['sum'] / k['size']
        msb = (k['size'] * (r - p) ** 2).sum() / (len(k) - 1)
        msw = (k['sum'] * (1 - r) ** 2 + (k['size'] - k['sum']) * r ** 2).sum() / (N - len(k))
        n0 = (N - (k['size'] ** 2).sum() / N) / (len(k) - 1)
        num += (msb - msw) / n0 * N; den += N
    # total variance pooled within specialty = mean p_s(1-p_s)
    pv = sum(g[y].mean() * (1 - g[y].mean()) * len(g) for s, g in sub.groupby('specialty') if g.doctor_uid.nunique() >= 2) / den
    return num / den, pv

out_doc = []; vd = {}
CONFIGS = (('h14', 'm14', 'h14', False), ('h90', 'm90', 'h90', False), ('h14_noobs', 'm14', 'h14', True), ('h90_noobs', 'm90', 'h90', True))
for key, mat, lab, noobs in CONFIGS:   # *_noobs: sensitivity without obstetric Rx (their surgeries are excluded by R1, so they cannot convert)
    x = df[df[mat]].copy(); x['y'] = x[lab].astype(int)
    if noobs: x = x[x.pc != 'obstetric']
    cnt = x.groupby('doctor_uid').size()
    x['elig'] = x['doctor_uid'].map(cnt) >= NMIN
    e = x[x.elig].copy()
    ns = e.groupby('specialty').doctor_uid.nunique(); sp = e.groupby('specialty').y.sum()
    e = e[(e.specialty.map(ns) >= 2) & (e.specialty.map(sp) > 0)].copy()   # within-specialty comparison needs >= 2 doctors and >= 1 conversion
    r = dict(n_matured=len(x), pos_matured=int(x.y.sum()), n_eligible_eps=len(e), pos_eligible=int(e.y.sum()),
             n_doctors=e.doctor_uid.nunique(), specialties=sorted(e.specialty.unique()))
    # case-mix model without doctor (specialty fixed) -> expected
    base = fit_glm(f'y ~ C(specialty) + {CASEMIX}', e); e['p_cm'] = base.predict(e)
    # per-doctor table
    for (s, u), g in e.groupby(['specialty', 'doctor_uid']):
        k, n = int(g.y.sum()), len(g); lo, hi = wilson(k, n); E = g.p_cm.sum(); olo, ohi = byar(k, E)
        if not noobs: out_doc.append(dict(label=lab, specialty=s, doctor_uid=u, n=n, pos=k, rate=k / n, ci_lo=lo, ci_hi=hi,
                            expected=E, oe=k / E, oe_lo=olo, oe_hi=ohi, adj_rate=k / E * e[e.specialty == s].y.mean(),
                            spec_rate=e[e.specialty == s].y.mean(), mean_age=g.age.mean(), pct_female=g.female.mean(),
                            top_pclass=g.pc.value_counts().index[0]))
    # (a) ANOVA, observed scale, unadjusted and on case-mix residual
    tau, pv = anova_tau(e, 'y')
    boots = []
    for b in range(NB):
        bb = e.groupby('doctor_uid', group_keys=False).apply(lambda g: g.sample(len(g), replace=True, random_state=RNG.integers(1e9)))
        t, v = anova_tau(bb, 'y'); boots.append(max(0, t) / v)
    r['anova_share_unadj'] = max(0, tau) / pv; r['anova_share_unadj_ci'] = list(np.percentile(boots, [2.5, 97.5]))
    # (b) GLMM: doctor random intercept, specialty fixed; unadjusted vs case-mix adjusted. Latent ICC = s2/(s2 + pi^2/3)
    for tag, fx in (('unadj', 'y ~ C(specialty)'), ('adj', f'y ~ C(specialty) + {CASEMIX}')):
        m = BinomialBayesMixedGLM.from_formula(fx, {'doc': '0 + C(doctor_uid)'}, e, vcp_p=1.0).fit_vb()
        ls, lsd = m.vcp_mean[0], m.vcp_sd[0]
        icc = lambda l: math.exp(2 * l) / (math.exp(2 * l) + math.pi ** 2 / 3)
        r[f'glmm_{tag}_sd'] = math.exp(ls); r[f'glmm_{tag}_icc'] = icc(ls)
        r[f'glmm_{tag}_icc_ci'] = [icc(ls - 1.96 * lsd), icc(ls + 1.96 * lsd)]
        # spread: OR between doctors at +1 SD and -1 SD; median odds ratio
        r[f'glmm_{tag}_MOR'] = math.exp(math.sqrt(2) * math.exp(ls) * 0.6745)
    # (c) GLMM with random specialty + random doctor (case mix fixed): between-specialty vs within-specialty doctor variance
    m2 = BinomialBayesMixedGLM.from_formula(f'y ~ {CASEMIX}', {'spec': '0 + C(specialty)', 'doc': '0 + C(doctor_uid)'}, e, vcp_p=1.0).fit_vb()
    vs, vdd = math.exp(2 * m2.vcp_mean[0]), math.exp(2 * m2.vcp_mean[1]); tot = vs + vdd + math.pi ** 2 / 3
    r['glmm2_share_specialty'] = vs / tot; r['glmm2_share_doctor_within'] = vdd / tot; r['glmm2_share_patient'] = (math.pi ** 2 / 3) / tot
    # (d) fixed effects: deviance shares and LR test for doctor within specialty
    m_s = fit_glm('y ~ C(specialty)', e); m_sc = fit_glm(f'y ~ C(specialty) + {CASEMIX}', e)
    m_sd = fit_glm('y ~ C(doctor_uid)', e); m_scd = fit_glm(f'y ~ C(doctor_uid) + {CASEMIX}', e)
    null = fit_glm('y ~ 1', e).deviance
    dd = lambda a, b: a.deviance - b.deviance
    r['dev_null'] = null; r['dev_explained_specialty'] = null - m_s.deviance
    r['dev_doctor_first'] = dd(m_s, m_sd); r['dev_casemix_after_doctor'] = dd(m_sd, m_scd)
    r['dev_casemix_first'] = dd(m_s, m_sc); r['dev_doctor_after_casemix'] = dd(m_sc, m_scd)
    df_doc = m_scd.df_model - m_sc.df_model
    r['lr_doctor_after_casemix_df'] = int(df_doc); r['lr_doctor_after_casemix_p'] = float(stats.chi2.sf(dd(m_sc, m_scd), df_doc))
    r['mcfadden_spec'] = 1 - m_s.deviance / null; r['mcfadden_spec_cm'] = 1 - m_sc.deviance / null
    r['mcfadden_spec_doc'] = 1 - m_sd.deviance / null; r['mcfadden_full'] = 1 - m_scd.deviance / null
    # Shapley split of the explained deviance beyond specialty between doctor and case mix
    sh_doc = (dd(m_s, m_sd) + dd(m_sc, m_scd)) / 2; sh_cm = (dd(m_s, m_sc) + dd(m_sd, m_scd)) / 2
    r['shapley_doctor_share_beyond_specialty'] = sh_doc / (sh_doc + sh_cm)
    # (e) repeated stratified 5x5 CV: does doctor add out-of-sample signal over specialty + case mix?
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import RepeatedStratifiedKFold
    from sklearn.metrics import roc_auc_score, log_loss
    Xb = pd.get_dummies(e[['specialty', 'pc', 'payer', 'quarter']].astype(str)).assign(age_c=e.age_c, age_c2=e.age_c2, female=e.female, prior=e.prior, n_icd=e.n_icd, icd_missing=e.icd_missing, n_inv=e.n_inv, inv_missing=e.inv_missing).astype(float)
    Xd = Xb.join(pd.get_dummies(e.doctor_uid, prefix='d').astype(float))
    yv = e.y.values; da, dl = [], []
    for tr, te in RepeatedStratifiedKFold(n_splits=5, n_repeats=5, random_state=7).split(Xb, yv):
        pa = LogisticRegression(C=1.0, max_iter=2000).fit(Xb.iloc[tr], yv[tr]).predict_proba(Xb.iloc[te])[:, 1]
        pb = LogisticRegression(C=1.0, max_iter=2000).fit(Xd.iloc[tr], yv[tr]).predict_proba(Xd.iloc[te])[:, 1]
        da.append(roc_auc_score(yv[te], pb) - roc_auc_score(yv[te], pa)); dl.append(log_loss(yv[te], pa) - log_loss(yv[te], pb))
        r.setdefault('cv_auc_base', []).append(roc_auc_score(yv[te], pa)); r.setdefault('cv_auc_doc', []).append(roc_auc_score(yv[te], pb))
    r['cv_auc_base'] = [float(np.mean(r['cv_auc_base'])), *np.percentile(r['cv_auc_base'], [2.5, 97.5])]
    r['cv_auc_doc'] = [float(np.mean(r['cv_auc_doc'])), *np.percentile(r['cv_auc_doc'], [2.5, 97.5])]
    r['cv_auc_gain'] = [float(np.mean(da)), *np.percentile(da, [2.5, 97.5])]; r['cv_logloss_gain'] = [float(np.mean(dl)), *np.percentile(dl, [2.5, 97.5])]
    # ML/profile alongside VB (VB's lognormal prior on the SD keeps its lower bound off 0)
    for tag, rhs in (('unadj', 'C(specialty)'), ('adj', f'C(specialty) + {CASEMIX}')):
        mlr = ml_icc(e, rhs)
        for k2, v2 in mlr.items(): r[f'ml_{tag}_{k2}'] = v2
    # doctor fixed-effect LR p under alternative covariate sets (sensitivity of the H90 p to the adjustment)
    for tag, rhs in (('none', ''), ('nosev', ' + C(pc) + age_c + age_c2 + female + C(payer) + prior + C(quarter)'), ('full', f' + {CASEMIX}')):
        a0 = fit_glm(f'y ~ C(specialty){rhs}', e); a1 = fit_glm(f'y ~ C(doctor_uid){rhs}', e)
        r[f'lr_p_{tag}'] = float(stats.chi2.sf(a0.deviance - a1.deviance, a1.df_model - a0.df_model))
    res[key] = r
    print(key, json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items() if k != 'specialties'}, default=float))

D = pd.DataFrame(out_doc); D.to_csv(f'{OUT}/doctor_table.tsv', sep='\t', index=False, float_format='%.4f')

# ---- (2) non-converted volume per specialty and lost-conversion scenarios
vol = []
for lab, mat in (('h14', 'm14'), ('h90', 'm90')):
    x = df[df[mat]]
    for s, g in x.groupby('specialty'):
        n, k = len(g), int(g[lab].sum()); dt_ = D[(D.label == lab) & (D.specialty == s)]
        row = dict(label=lab, specialty=s, n=n, pos=k, non=n - k, rate=k / n, n_doctors=g.doctor_uid.nunique(), n_elig_doctors=len(dt_))
        if len(dt_) >= 2:
            med_oe = float(np.median(dt_.oe)); best_lo = float(dt_.oe_lo.max())
            row['lost_to_median'] = float(sum(max(0, med_oe * E - o) for E, o in zip(dt_.expected, dt_.pos)))
            row['lost_to_best_lowerCI'] = float(sum(max(0, best_lo * E - o) for E, o in zip(dt_.expected, dt_.pos)))
            best = float(dt_.oe.max()); row['lost_to_best_point'] = float(sum(max(0, best * E - o) for E, o in zip(dt_.expected, dt_.pos)))
        row['lost_plus20pct'] = 0.2 * k
        months = g['d'].map(lambda d: (d.year, d.month)).nunique(); row['months'] = months
        vol.append(row)
V = pd.DataFrame(vol).sort_values(['label', 'non'], ascending=[True, False]); V.to_csv(f'{OUT}/specialty_volume.tsv', sep='\t', index=False, float_format='%.2f')

# ---- (3) recorded surgery pitches per doctor
L = {r['consult_uid']: r for r in map(json.loads, open(H('~/eta-data/convert/p1/linked.jsonl')))}
byk = {r['clip_key']: r for r in L.values()}
# SEAL: every pitch consult goes through split_guard (pinned RD-0 lock), D only. consult -> patient_key from 10.tsv AND 10b.tsv
# (10.tsv alone misses consults without a flagged Rx; ft-refute-doctors found 15 H consults that way), -> cluster key -> guard.
sys.path.insert(0, H('~/wt/forest-funnel-join/studies/2026-10-16-runo-linkage/split')); import split_guard
GUARD = split_guard.load(H('~/eta-data/forest/split'), pinned_list_sha256='52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65')
c2k = collections.defaultdict(set)
for f in ('10.tsv', '10b.tsv'):
    for r in csv.DictReader(open(H(f'~/eta-data/forest/split-input/{f}')), delimiter='\t'):
        if r['consult_uid']: c2k[r['consult_uid']].add(r['patient_key'])
cl = {r['patient_key']: r['cluster_key'] for r in csv.DictReader(open(H('~/eta-data/forest/split/clusters-2026-10-18.tsv')), delimiter='\t')}
def guard_split(c):
    """'D' only if the consult maps to >= 1 key and every key's cluster is D in the lock; else 'H' or 'unmapped' (both dropped)."""
    ks = c2k.get(c)
    if not ks: return 'unmapped'
    try: sets = {GUARD.set_of(cl.get(k, k)) for k in ks}
    except split_guard.UnknownKeyError: return 'unmapped'
    return 'H' if 'H' in sets else 'D'
GUARD.require_dev([c for c in df.cluster_key], context='ft5 episodes')   # the episode table itself must be all D
ft6 = [l.strip() for l in open(f'{FT}/ft6-candidates.txt') if l.strip()]
pitch = {c: 'ft6' for c in ft6}
for f in ('~/eta-data/convert/p2v2/cohort/haiku_f01.jsonl', '~/eta-data/convert/rf775/haiku_f01.jsonl'):
    for h in map(json.loads, open(H(f))):
        if h['p_yes'] >= 0.5 and h['clip_key'] in byk:
            c = byk[h['clip_key']]['consult_uid']; pitch.setdefault(c, 'haiku_f01')
gs = {c: guard_split(c) for c in pitch}
print('pitch candidates', len(pitch), 'guard', dict(collections.Counter(gs.values())), 'by source', dict(collections.Counter((pitch[c], gs[c]) for c in pitch)))
pitch = {c: s for c, s in pitch.items() if gs[c] == 'D' and c in L}
P = pd.DataFrame([dict(consult_uid=c, source=s, doctor_uid=L[c]['doctor_uid'], date=L[c]['ist_date'], days_elapsed_at_15oct=L[c]['days_elapsed'],
                       label_linked=L[c]['label']) for c, s in pitch.items()])
P['specialty'] = P.doctor_uid.map(lambda u: spec_of.get(u, 'unknown'))
lab_c = df.set_index('consult_uid')
lab_c = lab_c[~lab_c.index.duplicated()]
P['h14_episode'] = P.consult_uid.map(lambda c: ('no_flagged_episode' if c not in lab_c.index else int(lab_c.loc[c, 'h14']) if lab_c.loc[c, 'm14'] else 'immature'))
P.sort_values(['specialty', 'doctor_uid', 'date']).to_csv(f'{OUT}/pitches_by_doctor.tsv', sep='\t', index=False)
pc = P.groupby(['specialty', 'doctor_uid']).size().rename('n_pitch').reset_index()
pairs = []
for lab in ('h14', 'h90'):
    t = D[D.label == lab].merge(pc, on=['specialty', 'doctor_uid'], how='left').fillna({'n_pitch': 0})
    for s, g in t.groupby('specialty'):
        g = g[g.n_pitch >= 5].sort_values('oe', ascending=False)
        if len(g) < 2: continue
        hi, lo = g.iloc[0], g.iloc[-1]
        pairs.append(dict(label=lab, specialty=s, high_uid=hi.doctor_uid, high_rate=hi.rate, high_n=hi.n, high_oe=hi.oe, high_pitch=int(hi.n_pitch),
                          low_uid=lo.doctor_uid, low_rate=lo.rate, low_n=lo.n, low_oe=lo.oe, low_pitch=int(lo.n_pitch),
                          ci_overlap=bool(hi.ci_lo <= lo.ci_hi), oe_ci_overlap=bool(hi.oe_lo <= lo.oe_hi),
                          low_oe_hi=lo.oe_hi, high_oe_lo=hi.oe_lo))
PR = pd.DataFrame(pairs); PR.to_csv(f'{OUT}/pairs.tsv', sep='\t', index=False, float_format='%.4f')
json.dump(res, open(f'{OUT}/results.json', 'w'), indent=1, default=float)
for f in os.listdir(OUT):
    if f.endswith(('.tsv', '.json', '.pkl')): os.chmod(f'{OUT}/{f}', 0o600)
print('pitches', len(P), P.source.value_counts().to_dict(), 'doctors>=5', int((pc.n_pitch >= 5).sum()))
print(pc[pc.n_pitch >= 3].assign(d=lambda z: z.doctor_uid.str[:6]).drop(columns='doctor_uid').to_string())
print('pairs', len(PR))
