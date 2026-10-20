# ft-audio FT4 v2 (newcat-orch order 19 Oct 17:15): Ale label on the largest D cohort = ft-cohortb-expand features_all (anchors, labels.parquet v2)
# UNION ft-audio features.parquet (recorded surgery-discussion consults, ft4a outcomes). One row per patient (earliest cohort consult) = strict episode credit.
# ALE label: 1 = attributable surgery after the consult at any time up to READ (incl. consults < 14 d old); 0 = >= 14 d old, no surgery; drop = < 14 d, no surgery.
# Sensitivity labels: h14 (>= 18 d, surgery <= 14 d), h90 (needs >= 94 d: none in this window). Every id passes split_guard (D only). Ids/numbers only.
import os, sys, csv, json
import numpy as np, pandas as pd
H = os.path.expanduser; FT = H('~/oc/forest-lead/ft'); O = f'{FT}/out/ft-audio'
sys.path.insert(0, H('~/wt/forest-funnel-join/studies/2026-10-16-runo-linkage/split')); import split_guard as SG
G = SG.load(lock_dir=H('~/eta-data/forest/split'), pinned_list_sha256='52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65')
READ = pd.Timestamp('2026-10-19')
src = sys.argv[1] if len(sys.argv) > 1 else f'{FT}/out/ft-cohortb-expand/features_all.parquet'
X = pd.read_parquet(src); A = pd.read_parquet(f'{O}/features.parquet')
keep = [c for c in A.columns if c in X.columns]
X = X.assign(row_src='expand_anchor'); A = A.assign(row_src='ftaudio')
# anchors: labels.parquet v2 (full horizon to READ). anchor_excl -> negative (FT1/FT2 rule)
X['dts'] = np.where(X.anchor_excl.isna(), X.days_to_surgery, np.nan)
X['h14_s'] = X.h14
# ft-audio rows: ft4a, 30 d horizon, R1/R2/R4 already applied in assemble.py (excluded events never set days_to_surgery)
A['dts'] = A.days_to_surgery
A['h14_s'] = np.where(A.age_days >= 18, ((A.days_to_surgery.notna()) & (A.days_to_surgery <= 14)).astype(float), np.nan)
ov = set(X.consult_uid) & set(A.consult_uid)
chk = X[X.consult_uid.isin(ov)].set_index('consult_uid').dts.notna().eq(A[A.consult_uid.isin(ov)].set_index('consult_uid').dts.notna())
D = pd.concat([X[keep + ['row_src', 'dts', 'h14_s', 'episode_id', 'eligible_h14']], A[~A.consult_uid.isin(ov)][keep + ['row_src', 'dts', 'h14_s']]], ignore_index=True)
# seal: every row through split_guard (fail closed)
pk = {r['consult_uid']: r['patient_key'] for r in csv.DictReader(open(f'{FT}/../data/10b-patient-key-c2.tsv'), delimiter='\t')}
cl = {r['patient_key']: r['cluster_key'] for r in csv.DictReader(open(H('~/eta-data/forest/split/clusters-2026-10-18.tsv')), delimiter='\t')}
def dev(r):
    for k in (r.cluster_key, cl.get(pk.get(r.consult_uid), pk.get(r.consult_uid))):
        if isinstance(k, str):
            try: return G.set_of(k) == 'D'
            except SG.GuardError: pass
    return False
ok = D.apply(dev, axis=1); n_notD = int((~ok).sum()); D = D[ok]
D['age_days'] = (READ - pd.to_datetime(D.ist_date)).dt.days
D['ale'] = np.where(D.dts.notna() & (D.dts >= 0), 1.0, np.where(D.age_days >= 14, 0.0, np.nan))
D['h90_s'] = np.nan
D['jev_pitch_nof07'] = D[['jev_f03', 'jev_f18']].mean(axis=1)
# strict episode credit: one row per patient cluster, the earliest consult (a later consult of a converter is not a second positive)
D = D.sort_values(['cluster_key', 'ist_date']); n_rows = len(D); D = D.drop_duplicates('cluster_key', keep='first')
D.to_parquet(f'{O}/features_ale.parquet', index=False); os.chmod(f'{O}/features_ale.parquet', 0o600)
s = dict(src_rows=dict(expand=len(X), ftaudio=len(A), overlap=len(ov), overlap_label_agree=int(chk.sum())), not_D=n_notD, rows_before_patient_dedup=n_rows,
         patients=len(D))
for lab in ('ale', 'h14_s', 'h90_s'):
    e = D[D[lab].notna()]
    s[lab] = dict(n=len(e), pos=int(e[lab].sum()), doctors=int(e.doctor_uid.nunique()), by_src=e.groupby('row_src')[lab].agg(['size', 'sum']).astype(int).to_dict())
e = D[D.ale.notna()]
s['ale_pos_lag'] = sorted(e[e.ale == 1].dts.astype(int).tolist()); s['ale_pos_lt14d_old'] = int(((e.ale == 1) & (e.age_days < 14)).sum())
s['ale_by_specialty'] = e.groupby('specialty').ale.agg(['size', 'sum']).astype(int).to_dict('index')
s['fill_ale'] = {c: round(float(e[c].notna().mean()), 3) for c in ['consult_lang', 'doc_talk_share', 'pat_valence', 'val_change', 'jev_f07', 'jev_f03', 'jev_f18', 'age_y', 'payer', 'specialty', 'doc_prior_rate', 'turns_per_min']}
json.dump(s, open(f'{O}/ale_cohort.json', 'w'), indent=1, default=str); os.chmod(f'{O}/ale_cohort.json', 0o600)
print(json.dumps(s, indent=1, default=str))
