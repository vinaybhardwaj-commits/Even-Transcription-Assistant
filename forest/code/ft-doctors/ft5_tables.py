"""Markdown tables for FT5-REPORT.md from the ft5_analysis.py outputs (admin-only: doctor names)."""
import pandas as pd, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from ft5 import load_ref
_, NAMES = load_ref(); nm = lambda u: NAMES.get(u, u[:6])
D = pd.read_csv('doctor_table.tsv', sep='\t'); V = pd.read_csv('specialty_volume.tsv', sep='\t')
PR = pd.read_csv('pairs.tsv', sep='\t'); P = pd.read_csv('pitches_by_doctor.tsv', sep='\t')
pct = lambda v: f'{100*v:.0f}%'
for lab in ('h14', 'h90'):
    print(f'\n#### {lab.upper()} by doctor (D split, matured episodes, doctors with n >= 10, specialties with >= 2 such doctors and >= 1 conversion)\n')
    print('| specialty | doctor | n | conv | rate (Wilson 95% CI) | expected (case mix) | O/E (95% CI) | top procedure class |\n|---|---|---|---|---|---|---|---|')
    for _, r in D[D.label == lab].sort_values(['specialty', 'oe'], ascending=[True, False]).iterrows():
        print(f'| {r.specialty} | {nm(r.doctor_uid)} | {r.n} | {r.pos} | {pct(r.rate)} ({pct(r.ci_lo)}-{pct(r.ci_hi)}) | {r.expected:.1f} | {r.oe:.2f} ({r.oe_lo:.2f}-{r.oe_hi:.2f}) | {r.top_pclass} |')
print('\n#### Non-converted volume (D split, matured; all doctors)\n')
print('| label | specialty | episodes | converted | not converted | rate | doctors | lost conv.: all to median O/E | +20% relative | all to best O/E (ceiling) |\n|---|---|---|---|---|---|---|---|---|---|')
for _, r in V[V.non >= 30].iterrows():
    f = lambda v: '-' if pd.isna(v) else f'{v:.1f}'
    print(f'| {r.label} | {r.specialty} | {r.n} | {r.pos} | {r.non} | {pct(r.rate)} | {r.n_doctors} ({r.n_elig_doctors} with n>=10) | {f(r.lost_to_median)} | {f(r.lost_plus20pct)} | {f(r.lost_to_best_point)} |')
print('\n#### Pitch lists\n')
for _, r in PR.iterrows():
    print(f'- {r.label.upper()} {r.specialty}: HIGH {nm(r.high_uid)} ({pct(r.high_rate)}, n {r.high_n}, O/E {r.high_oe:.2f}, {r.high_pitch} pitches) vs LOW {nm(r.low_uid)} ({pct(r.low_rate)}, n {r.low_n}, O/E {r.low_oe:.2f}, {r.low_pitch} pitches); O/E CIs overlap: {r.oe_ci_overlap}')
docs = sorted(set(PR.high_uid) | set(PR.low_uid))
for u in docs:
    g = P[P.doctor_uid == u].sort_values('date')
    print(f'\n{nm(u)} ({g.specialty.iloc[0]}), {len(g)} recorded pitches:\n')
    print('| consult_id | date | source | this episode H14 |\n|---|---|---|---|')
    for _, r in g.iterrows(): print(f'| {r.consult_uid} | {r.date} | {r.source} | {r.h14_episode} |')
