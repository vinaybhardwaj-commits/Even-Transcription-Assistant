"""Refuter day-level rebuild (v3 delta). Own code: reuses only refuter rebuild.py helpers, not lane code."""
import os, sys, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rebuild as rb          # refuter v1 rebuild (runs its module code: writes refuter_ft8.parquet again, same result)
os.umask(0o077)
OUT = rb.OUT
A = pd.DataFrame(rb.ftio.read_export(os.path.expanduser('~/eta-data/forest/ft8/ft8-pull-a-day.tsv'))).drop(columns=['pin_code'])
for c in ['n_prior_rx_all', 'n_prior_rx_12m', 'n_doctors_12m', 'n_ip_events_pre', 'n_meds_latest_prior_rx']:
    A[c] = A[c].astype(int)
A['dsf'] = pd.to_numeric(A.days_since_first_rx.replace('', np.nan))
TS = ['src_max_ts_prior_rx', 'src_max_ts_cond', 'src_max_ts_comorb', 'src_max_ts_ip', 'src_max_ts_bp', 'cut_ist_midnight']
for c in TS:
    A[c] = pd.to_datetime(A[c].replace('', None), utc=True).dt.tz_convert('Asia/Kolkata')
D = rb.L[['episode_id', 'prescription_uid', 'rx_date', 'h14', 'h90']].merge(A, on='prescription_uid', how='left', validate='1:1')
chk = {'cut_date_eq_rx_date': int((D.cut_ist_midnight.dt.tz_localize(None) == D.rx_date.dt.normalize()).sum())}
for c in TS[:-1]:
    t = D[c]; chk[c] = {'n': int(t.notna().sum()), 'ge_cut': int((t >= D.cut_ist_midnight).sum()),
                        'ist_date_ge_rx': int((t.dt.tz_localize(None).dt.normalize() >= D.rx_date.dt.normalize()).sum()),
                        'pre2000': int((t.dt.year < 2000).sum())}
# a used block must have a source ts: prior Rx (counts/meds/prior ICD) and cond/ip/comorb/bp
chk['used_without_ts'] = {'prior_rx': int(((D.n_prior_rx_all > 0) & D.src_max_ts_prior_rx.isna()).sum()),
                          'cond': int(((D.cond_icd != '') & D.src_max_ts_cond.isna()).sum()),
                          'ip': int(((D.n_ip_events_pre > 0) & D.src_max_ts_ip.isna()).sum()),
                          'comorb': int(((D.comorb_names != '') & D.src_max_ts_comorb.isna()).sum()),
                          'bp': int(((D.bp_latest != '') & D.src_max_ts_bp.isna()).sum())}
D['bpa_cal'] = (D.rx_date.dt.normalize() - D.src_max_ts_bp.dt.tz_localize(None).dt.normalize()).dt.days
chk['bp_age_pull_vs_calendar_diff'] = int((pd.to_numeric(D.bp_age_d.replace('', np.nan)) != D.bpa_cal)[D.bpa_cal.notna()].sum())
D['bpa'] = D.bpa_cal
F = rb.build(D, quarantine=False)
W, G = rb.labs(rb.B, drop_epoch=True)
for lab in ['hba1c', 'hb', 'creat', 'egfr', 'tsh']:
    F[lab] = D.prescription_uid.map(W[lab]).values
    F[lab + '_age_d'] = D.prescription_uid.map(G[lab].where(W[lab].notna())).values
F.to_parquet(f'{OUT}/refuter_ft8_day.parquet')
cov = {c: int(F[c].notna().sum()) for c in F.columns if c != 'episode_id'}
cov.update({c: int(F[c].sum()) for c in ['has_prior_rx', 'has_icd']}); cov['meds_gt0'] = int((F.n_meds > 0).sum())
cov['ip_gt0'] = int((F.n_ip > 0).sum()); cov['comorb_gt0'] = int((F.n_comorb > 0).sum())
cov['bp_rows'] = int((D.bp_latest != '').sum())
json.dump({'checks': chk, 'cov': cov}, open(f'{OUT}/refuter_cov_day.json', 'w'), indent=1)
print(json.dumps(chk)); print(json.dumps(cov))
