# ft-refute-forest analysis: deltas, Holm families, bench, SELECTED, calibration, on the refuter's own OOF (work/oof_*.npz).
import os, json, glob
import numpy as np, pandas as pd
from sklearn.metrics import roc_auc_score, brier_score_loss, average_precision_score
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedGroupKFold
import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import rf_refute as R
W = os.path.dirname(os.path.abspath(__file__)); O = R.O
os.umask(0o077)
def load(dn, lab):
    z = np.load(f'{W}/oof_{dn}_{lab}.npz', allow_pickle=True)
    P = {k[4:]: z[k].mean(0) for k in z.files if k.startswith('oof_')}
    N = {k[5:]: z[k].mean(0) for k in z.files if k.startswith('nest_')}
    return z['y'], z['g'], z['ep'], P, N, {k[4:]: z[k] for k in z.files if k.startswith('oof_')}
def holm(ps):
    o = np.argsort(ps); m = len(ps); adj = np.zeros(m); run = 0
    for i, j in enumerate(o): run = max(run, (m - i) * ps[j]); adj[j] = min(1, run)
    return adj
T = []; out = {}; L = []
def add(fam, name, y, pa, pb, B):
    d = R.delta(y, pa, pb, B); T.append(dict(fam=fam, name=name, **d)); return d
# ---- A
for lab in ('h14', 'h90', 'ale'):
    y, g, ep, P, N, raw = load('rx', lab); B = R.bidx(g)
    out[f'rx_{lab}'] = {m: R.auc_ci(y, P[m], B) for m in P}
    if lab == 'ale': add('F-Ale-Rx', 'rx ale M1-M0', y, P['M0'], P['M1'], B)
    else:
        add('F-primary', f'rx {lab} M1-M0', y, P['M0'], P['M1'], B); add('F-Ale-Rx', f'rx {lab} M2-M1', y, P['M1'], P['M2'], B)
# ---- B
sel = {}
for T_ in (3, 7):
    for lab in ('h14', 'h90', 'ale'):
        dn = f'lm{T_}'; y, g, ep, P, N, raw = load(dn, lab); B = R.bidx(g)
        out[f'{dn}_{lab}'] = {m: R.auc_ci(y, P[m], B) for m in P}
        for k in range(1, 9): add('F-calls', f'{dn} {lab} L{k}-L{k-1}', y, P[f'L{k-1}'], P[f'L{k}'], B)
        add('F-calls', f'{dn} {lab} FULL-L0', y, P['L0'], P['L8'], B)
# ---- C
for lab in ('ale_strict', 'h14_ge18'):
    y, g, ep, P, N, raw = load('consult', lab); B = R.bidx(g)
    out[f'consult_{lab}'] = {m: R.auc_ci(y, P[m], B) for m in P}
    seq = ['C0', 'C1', 'C4', 'C5', 'C6', 'C7', 'C8']
    for a, b in zip(seq, seq[1:]): add('F-consults', f'consult {lab} {b}-{a}', y, P[a], P[b], B)
    add('F-consults', f'consult {lab} FULL-C0', y, P['C0'], P['C8'], B)
Tdf = pd.DataFrame(T)
for f, gdf in Tdf.groupby('fam'): Tdf.loc[gdf.index, 'holm'] = holm(gdf.p2.values); Tdf.loc[gdf.index, 'fam_n'] = len(gdf)
# ---- bench (F-bench: FULL - a/b/c, 6 B designs (ALL population, median fill for b/c, a = raw ordinal) + 2 C designs)
bs = pd.read_parquet(f'{O}/ft-bench/bench_scores-frozen-0910.parquet'); BT = []
for T_ in (3, 7):
    for lab in ('h14', 'h90', 'ale'):
        y, g, ep, P, N, raw = load(f'lm{T_}', lab); B = R.bidx(g)
        x = bs[(bs.lab == lab) & (bs['T'] == T_)].set_index('episode_id').reindex(ep); assert (x.y.values == y).all()
        for bn, col in (('a_intent_raw', 'a_intent_code'), ('b_jev', 'b_jev'), ('c_opus', 'c_opus')):
            s = x[col].astype(float); s = s.fillna(s.median()).values
            d = R.delta(y, s, P['L8'], B); BT.append(dict(name=f'lm{T_} {lab} FULL-{bn}', bench_auc=roc_auc_score(y, s), **d))
            if bn == 'c_opus': d7 = R.delta(y, s, P['L7'], B); BT[-1]['L7_minus_c'] = d7['d']
bc = pd.read_parquet(f'{O}/ft-bench/bench_scores_c.parquet').set_index('consult_uid')
for lab in ('ale_strict', 'h14_ge18'):
    y, g, ep, P, N, raw = load('consult', lab); B = R.bidx(g)
    dc = pd.read_parquet(f'{O}/ft-audio/designC_cohort.parquet'); cu = dc[dc[lab].notna()].consult_uid.values; assert len(cu) == len(y)
    assert (dc[dc[lab].notna()][lab].values.astype(int) == y).all(); x = bc.reindex(cu)
    for bn in ('a_intent_raw', 'b_jev', 'c_opus'):
        s = x[bn].astype(float); s = s.fillna(s.median()).values
        d = R.delta(y, s, P['C8'], B); BT.append(dict(name=f'consult {lab} FULL-{bn}', bench_auc=roc_auc_score(y, s), **d))
BTdf = pd.DataFrame(BT); BTdf['holm'] = holm(BTdf.p2.values); BTdf['fam_n'] = len(BTdf)
# ---- SELECTED forward pass (optimistic, not a test)
def selected(dn, lab, order):
    y, g, ep, P, N, raw = load(dn, lab); B = R.bidx(g); cur = order[0]; kept = [order[0]]
    # SELECTED needs refits of non-cumulative sets; here only report which cumulative steps pass the keep rule vs the previous cumulative model
    return [(m, R.delta(y, P[prev], P[m], B)) for prev, m in zip(order, order[1:])]
# ---- calibration (raw RF, cross-fitted sigmoid on OOF, nested in-fold Platt for A M0/M1)
def cal(y, p):
    lp = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    lr = LogisticRegression(C=1e6).fit(lp[:, None], y)
    return dict(brier=brier_score_loss(y, p), noskill=brier_score_loss(y, np.full(len(y), y.mean())), slope=float(lr.coef_[0, 0]), intercept=float(lr.intercept_[0]))
def xfit(y, p, g):
    q = np.zeros(len(y))
    for a, b in StratifiedGroupKFold(5, shuffle=True, random_state=R.RS).split(p, y, g):
        q[b] = LogisticRegression(C=1e6).fit(p[a][:, None], y[a]).predict_proba(p[b][:, None])[:, 1]
    return q
CAL = {}
for dn, lab, ms in [('rx', 'h14', ('M0', 'M1', 'M2')), ('rx', 'h90', ('M0', 'M1', 'M2')), ('lm3', 'h14', ('L8',)), ('lm7', 'h14', ('L8',)), ('lm7', 'h90', ('L8',)), ('consult', 'ale_strict', ('C8',))]:
    y, g, ep, P, N, raw = load(dn, lab)
    for m in ms:
        CAL[f'{dn} {lab} {m}'] = dict(raw=cal(y, P[m]), xfit=cal(y, xfit(y, P[m], g)), **({'nested': cal(y, N[m])} if m in N else {}))
pd.set_option('display.width', 250); pd.set_option('display.max_rows', 300)
Tdf.to_csv(f'{W}/tests_mine.tsv', sep='\t', index=False); BTdf.to_csv(f'{W}/bench_mine.tsv', sep='\t', index=False)
json.dump(dict(auc=out, cal=CAL), open(f'{W}/summary_mine.json', 'w'), indent=1, default=float)
print(Tdf.groupby('fam').agg(n=('p2', 'size'), holm_gain=('holm', lambda s: int(((s < .05) & (Tdf.loc[s.index, 'd'] > 0)).sum())), holm_loss=('holm', lambda s: int(((s < .05) & (Tdf.loc[s.index, 'd'] < 0)).sum()))))
print(Tdf.round(4).to_string()); print(BTdf.round(4).to_string())
for k, v in out.items(): print(k, {m: [round(x, 3) for x in a] for m, a in v.items()})
for k, v in CAL.items(): print(k, {t: {a: round(b, 4) for a, b in d.items()} for t, d in v.items()})
