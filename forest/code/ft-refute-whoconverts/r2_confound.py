# ft-refute-whoconverts (20 Oct 2026): confounding checks behind the WHO-CONVERTS summary lines. D only (same loaders as r1_desc).
import os, sys, json
sys.dont_write_bytecode = True; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import warnings; warnings.simplefilter('ignore')
import numpy as np, pandas as pd
import statsmodels.formula.api as smf
from r1_desc import F, mh, run, OUT

R = {}
A = F[F.h14.notna()].reset_index(drop=True); y = A.h14.values.astype(int)
sc = A.specialty.value_counts(); A['sg'] = A.specialty.where(A.specialty.isin(sc[sc >= 20].index), 'other')
A['ret'] = (A.ft8_has_prior_rx > 0).astype(int); A['nopin'] = (A.zone == 'nopin').astype(int); A['y'] = y
A['fem_doc'] = (A.doctor_gender == 'f').astype(int); A['mon'] = A.rx_date.dt.strftime('%Y-%m')

# 1. doctor gender: how many doctors carry it; doctor-level permutation of gender within specialty
dg = A.groupby('doctor_id').agg(g=('doctor_gender', 'first'), s=('specialty', 'first'), n=('y', 'size'), k=('y', 'sum'))
R['gender_doctors'] = {g: dict(doctors=int((dg.g == g).sum()), doctors_n10=int(((dg.g == g) & (dg.n >= 10)).sum()), rows=int(dg.n[dg.g == g].sum()))
                       for g in ('m', 'f')}
spec_mixed = [s for s, d in dg.groupby('s') if d.g.nunique() == 2]
R['gender_mixed_specialties'] = {s: dict(rows=int(A.specialty.eq(s).sum()), f_docs=int(((dg.s == s) & (dg.g == 'f')).sum()), m_docs=int(((dg.s == s) & (dg.g == 'm')).sum()))
                                 for s in spec_mixed}
obs = mh(y, A.fem_doc.values == 0, A.specialty.values)[0]; rng = np.random.default_rng(11); null = []
for _ in range(2000):
    g2 = dg.g.copy()
    for s, d in dg.groupby('s'): g2.loc[d.index] = rng.permutation(d.g.values)
    m = A.doctor_id.map(g2).values == 'm'
    try: null.append(mh(y, m, A.specialty.values)[0])
    except Exception: pass
null = np.array(null); R['gender_doctorlevel_perm'] = dict(mh_or_male=obs, p_two=float((1 + np.sum(np.abs(np.log(null)) >= abs(np.log(obs)))) / (1 + len(null))), draws=len(null))
# GS-only: drop the dominant GS doctor
big = A.doctor_id.value_counts().index[0]
B = A[A.doctor_id != big]; R['gender_mh_without_top_doctor'] = mh(B.y.values, B.fem_doc.values == 0, B.specialty.values)

# 2. labs on file vs returning / specialty / prior Rx count
for c in ('ft8_has_egfr', 'ft8_has_hba1c', 'ft8_obesity'):
    m = A[c].fillna(0).values > 0
    R[f'{c}_xtab_ret'] = pd.crosstab(A.ret, m).to_dict()
    R[f'{c}_mh_spec_x_ret'] = mh(y, m, (A.sg + '|' + A.ret.astype(str)).values)
    A['x'] = m.astype(int)
    f = smf.logit('y ~ x + C(sg) + ret + np.log1p(ft8_n_prior_rx_all) + age_y', A).fit(disp=0)
    R[f'{c}_logit_adj'] = [round(float(np.exp(f.params['x'])), 2)] + [round(float(v), 2) for v in np.exp(f.conf_int().loc['x'])]
R['obesity_counts'] = dict(n=int((A.ft8_obesity > 0).sum()), k=int(A.y[A.ft8_obesity > 0].sum()))

# 3. missing pincode: what it travels with; adjusted OR
R['nopin_by_ret'] = A.groupby('ret').nopin.mean().round(3).to_dict()
R['nopin_by_month'] = A.groupby('mon').nopin.mean().round(2).to_dict()
R['nopin_by_sg'] = A.groupby('sg').nopin.mean().round(2).to_dict()
R['nopin_by_payer_prior'] = A.groupby('payer_prior').nopin.mean().round(2).to_dict()
f = smf.logit('y ~ nopin + C(sg) + ret + C(proc_class) + fem_doc + C(mon)', A).fit(disp=0, method='bfgs', maxiter=2000)
R['nopin_logit_adj'] = [round(float(np.exp(f.params['nopin'])), 2)] + [round(float(v), 2) for v in np.exp(f.conf_int().loc['nopin'])]
R['nopin_mh_spec_x_ret'] = mh(y, A.nopin.values == 1, (A.sg + '|' + A.ret.astype(str)).values)
R['nopin_mh_doctor'] = mh(y, A.nopin.values == 1, A.doctor_id.values)
# timing probe: rows never converted (h90 = 0) vs converted after day 14 (h14 = 0, h90 = 1) vs h14 converters
H = F[F.h90.notna()]
grp = np.where(H.h14 == 1, 'conv<=14', np.where(H.h90 == 1, 'conv15-90', 'never'))
R['nopin_by_conversion_timing_h90rows'] = pd.Series((H.zone == 'nopin').values).groupby(grp).agg(['mean', 'size']).round(3).to_dict()

# 4. Ale October artefact: Ale flags with Oct-2026 Rx (and Rx < 14 d old) removed
rng = np.random.default_rng(7)
full = run('ale', rng)
cut = run('ale', rng, extra_mask=lambda X: X.age_days >= 14)
def flags(r): return sorted(f"{x['fam']}={x['level']}" for x in r['rows'] if x.get('q', 1) < 0.10)
R['ale_full'] = dict(n=full['n'], pos=full['pos'], tests=full['n_tests'], flags=flags(full))
R['ale_age14plus'] = dict(n=cut['n'], pos=cut['pos'], tests=cut['n_tests'], flags=flags(cut))
R['ale_extra_rows'] = dict(rows=int(F.ale.notna().sum() - F.h14.notna().sum()),
                           extra_pos=int(F.ale.fillna(0).sum() - F.h14.fillna(0).sum()),
                           young_rows=int((F.ale.notna() & (F.age_days < 14)).sum()), young_pos=int((F.ale.eq(1) & (F.age_days < 14)).sum()))

os.umask(0o077)
json.dump(R, open(f'{OUT}/r2_confound.json', 'w'), default=str, indent=1)
print(json.dumps(R, default=str, indent=1))
