"""Independent refute of FT5 (d): pitch counts per doctor and same-specialty high/low O/E pairs. D split only."""
import json, csv, collections, math, numpy as np, pandas as pd, statsmodels.api as sm
from glmm import build, design
E = '~/eta-data'
lock = dict(l.split()[:2] for l in open(f'{E}/forest/split/lock-2026-10-18.tsv') if l.strip())
cl = {r['patient_key']: r['cluster_key'] for r in csv.DictReader(open(f'{E}/forest/split/clusters-2026-10-18.tsv'), delimiter='\t')}
c2k = collections.defaultdict(set)
for f in ('10.tsv', '10b.tsv'):
    for r in csv.DictReader(open(f'{E}/forest/split-input/{f}'), delimiter='\t'): c2k[r['consult_uid']].add(r['patient_key'])
def split_of(c):
    s = {lock.get(cl.get(k, k), '?') for k in c2k.get(c, ())}
    return 'H' if 'H' in s else ('D' if 'D' in s else '?')
L = {}
for line in open(f'{E}/convert/p1/linked.jsonl'):
    r = json.loads(line); L[r['clip_key']] = dict(consult_uid=r['consult_uid'], doctor_uid=r['doctor_uid'])
byc = {v['consult_uid']: v for v in L.values()}
src = {}
for c in (l.strip() for l in open('~/oc/forest-lead/ft/ft6-candidates.txt')):
    if c: src[c] = 'ft6'
for f, tag in ((f'{E}/convert/p2v2/cohort/haiku_f01.jsonl', 'p2v2'), (f'{E}/convert/rf775/haiku_f01.jsonl', 'rf775')):
    for line in open(f):
        h = json.loads(line)
        if h.get('p_yes', 0) >= 0.5 and h['clip_key'] in L: src.setdefault(L[h['clip_key']]['consult_uid'], tag)
P = pd.DataFrame([dict(consult_uid=c, source=s, doctor_uid=byc.get(c, {}).get('doctor_uid'), split=split_of(c)) for c, s in src.items()])
print('pitch consults', len(P), P.source.value_counts().to_dict(), 'split', P.split.value_counts().to_dict(), 'no doctor', int(P.doctor_uid.isna().sum()))
P.to_csv('pitches_refute.tsv', sep='\t', index=False)
PD = P[(P.split != 'H') & P.doctor_uid.notna()]
pc = PD.groupby('doctor_uid').size()
# per-doctor O/E from own case-mix GLM (specialty fixed, 'full' case mix), doctors n >= 10
D = build(); rows = []
for lab in ('h14', 'h90'):
    x = D[D[lab].notna()].copy(); x['y'] = x[lab].astype(int)
    x = x[x.specialty.isin(['General Surgery', 'Gynaecology', 'Orthopaedics', 'Urology'])]
    x = x[x.doctor_id.map(x.doctor_id.value_counts()) >= 10]
    for adj in ('lite', 'full'):
        X = design(x, adj); m = sm.GLM(x.y.values, X, family=sm.families.Binomial()).fit(); x['e'] = m.predict(X)
        for (s, u), g in x.groupby(['specialty', 'doctor_id']):
            o, e = int(g.y.sum()), g.e.sum()
            lo = 0 if o == 0 else o * (1 - 1 / (9 * o) - 1.96 / (3 * math.sqrt(o))) ** 3 / e
            hi = (o + 1) * (1 - 1 / (9 * (o + 1)) + 1.96 / (3 * math.sqrt(o + 1))) ** 3 / e
            rows.append(dict(label=lab, adj=adj, specialty=s, doctor_uid=u, n=len(g), pos=o, exp=e, oe=o / e, oe_lo=lo, oe_hi=hi, n_pitch=int(pc.get(u, 0))))
T = pd.DataFrame(rows); T.to_csv('doctor_oe_refute.tsv', sep='\t', index=False, float_format='%.4f')
pr = []
for (lab, adj, s), g in T.groupby(['label', 'adj', 'specialty']):
    g = g[g.n_pitch >= 5].sort_values('oe', ascending=False)
    if len(g) < 2: continue
    hi, lo = g.iloc[0], g.iloc[-1]
    pr.append(dict(label=lab, adj=adj, specialty=s, high=hi.doctor_uid[:6], high_n=hi.n, high_pos=hi.pos, high_oe=round(hi.oe, 2), high_ci=f'{hi.oe_lo:.2f}-{hi.oe_hi:.2f}', high_pitch=hi.n_pitch,
                   low=lo.doctor_uid[:6], low_n=lo.n, low_pos=lo.pos, low_oe=round(lo.oe, 2), low_ci=f'{lo.oe_lo:.2f}-{lo.oe_hi:.2f}', low_pitch=lo.n_pitch, overlap=bool(hi.oe_lo <= lo.oe_hi)))
PR = pd.DataFrame(pr); PR.to_csv('pairs_refute.tsv', sep='\t', index=False)
print(PR.to_string())
print(T[T.n_pitch >= 5].assign(d=T.doctor_uid.str[:6]).drop(columns='doctor_uid').round(2).to_string())
print('pitch>=5 doctors (any specialty):', int((pc >= 5).sum()))
