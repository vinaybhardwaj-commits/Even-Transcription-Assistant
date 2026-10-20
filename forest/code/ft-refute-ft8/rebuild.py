"""Independent FT8 rebuild (refuter, Opus 5.5). Reads raw pulls + labels D only. Writes nothing but refuter outputs."""
import os, re, sys, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.expanduser('~/oc/forest-lead/ft')); import ftio
os.umask(0o077)
OUT = '~/wt/ft-refute-ft8/work'
A = pd.DataFrame(ftio.read_export(os.path.expanduser('~/eta-data/forest/ft8/ft8-pull-a.tsv')))
B = pd.DataFrame(ftio.read_export(os.path.expanduser('~/eta-data/forest/ft8/ft8-pull-b.tsv')))
L = pd.read_parquet(os.path.expanduser('~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'),
                    filters=[('split', '=', 'D')])
assert (L.split == 'D').all() and len(L) == 1233
A = A.drop(columns=['pin_code'])
for c in ['n_prior_rx_all', 'n_prior_rx_12m', 'n_doctors_12m', 'n_ip_events_pre', 'n_meds_latest_prior_rx']:
    A[c] = A[c].astype(int)
A['dsf'] = pd.to_numeric(A.days_since_first_rx.replace('', np.nan))
A['bpa'] = pd.to_numeric(A.bp_age_d.replace('', np.nan))
D = L[['episode_id', 'prescription_uid', 'rx_date', 'consult_ist', 'h14', 'h90']].merge(A, on='prescription_uid', how='left', validate='1:1')
assert D.n_prior_rx_all.notna().all()

def icds(s):
    return {z.strip().upper() for z in (s or '').split('|') if z.strip() and '-' not in z}
FLAGS = {'dm': r'^E1[0-4]', 'htn': r'^I1[0-5]', 'ckd': r'^N18', 'cad': r'^I2[0-5]', 'obesity': r'^E66'}

def build(D, quarantine=True):
    F = pd.DataFrame({'episode_id': D.episode_id})
    hist = (D.n_prior_rx_all > 0) & ~((D.dsf == 0) if quarantine else False)
    F['has_prior_rx'] = hist.astype(int)
    z = lambda s: s.where(hist, 0)
    F['n_prior_rx_all'] = z(D.n_prior_rx_all); F['n_prior_rx_12m'] = z(D.n_prior_rx_12m)
    F['n_doctors_12m'] = z(D.n_doctors_12m); F['days_since_first_rx'] = D.dsf.where(hist)
    F['n_meds'] = D.n_meds_latest_prior_rx.where(hist)
    codes = [(icds(p) if h else set()) | icds(c) for p, c, h in zip(D.prior_rx_icd, D.cond_icd, hist)]
    F['has_icd'] = [int(bool(s)) for s in codes]
    F['n_icd'] = [len(s) if s else np.nan for s in codes]
    for k, rx in FLAGS.items():
        F[k] = [float(any(re.match(rx, x) for x in s)) if s else np.nan for s in codes]
    F['n_ip'] = D.n_ip_events_pre; F['n_comorb'] = D.comorb_names.fillna('').map(lambda s: len([x for x in s.split('|') if x]))
    bp = D.bp_latest.fillna('').str.extract(r'^\s*(\d+)\s*/\s*(\d+)').astype(float)
    ok = D.bpa >= 1
    F['sbp'] = bp[0].where(ok & bp[0].between(60, 260) & bp[1].between(30, 160))
    F['dbp'] = bp[1].where(F.sbp.notna()); F['bp_age_d'] = D.bpa.where(F.sbp.notna())
    return F

def labs(B, drop_epoch):
    B = B.copy(); B['v'] = pd.to_numeric(B.value, errors='coerce'); B['a'] = B.age_d.astype(int)
    u = B.unit.str.lower().str.strip()
    conv = pd.Series(np.nan, index=B.index)
    m = B.lab == 'hba1c'; conv[m & (u == '%')] = B.v
    m = B.lab == 'hb'; conv[m & u.isin(['g/dl', 'gm/dl'])] = B.v
    m = B.lab == 'creat'; conv[m & (u == 'mg/dl')] = B.v; conv[m & u.str.contains('mol')] = B.v / 88.4
    m = B.lab == 'egfr'; conv[m & u.str.startswith('ml/min')] = B.v
    m = B.lab == 'tsh'; conv[m & u.str.contains(r'iu|uu', regex=True)] = B.v
    rng = {'hba1c': (3, 20), 'hb': (3, 25), 'creat': (0.1, 20), 'egfr': (2, 200), 'tsh': (0.001, 200)}
    B['cv'] = [x if lo <= x <= hi else np.nan for x, (lo, hi) in zip(conv, B.lab.map(rng))]
    assert (B.a >= 1).all()
    if drop_epoch:
        B.loc[B.a > 15000, 'cv'] = np.nan
    W = B.pivot(index='prescription_uid', columns='lab', values='cv')
    G = B.assign(a=B.a.where(B.cv.notna())).pivot(index='prescription_uid', columns='lab', values='a')
    return W, G

F = build(D)
W, G = labs(B, drop_epoch=False)
for lab in ['hba1c', 'hb', 'creat', 'egfr', 'tsh']:
    F[lab] = D.prescription_uid.map(W[lab]).values; F[lab + '_age_d'] = D.prescription_uid.map(G[lab]).values
F.to_parquet(f'{OUT}/refuter_ft8.parquet')
cov = {c: int(F[c].notna().sum()) for c in F.columns if c != 'episode_id'}
cov.update({c: int(F[c].sum()) for c in ['has_prior_rx', 'has_icd']})
W2, _ = labs(B, drop_epoch=True)
cov_noepoch = {l: int(D.prescription_uid.map(W2[l]).notna().sum()) for l in W2.columns}
json.dump({'cov': cov, 'cov_lab_epoch_dropped': cov_noepoch}, open(f'{OUT}/refuter_cov.json', 'w'), indent=1)
print(json.dumps(cov)); print('epoch-dropped', cov_noepoch)
