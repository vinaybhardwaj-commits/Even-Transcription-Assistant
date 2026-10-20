# ft-bench CALIBRATION + PERMUTATION harness for the FT final forest (spec FT-MODEL-SPEC-20OCT s6). D split only.
# Input contract (ft-calltext FTR v2 JSON 'oof' block, also accepted as parquet with the same columns):
#   oof = {episode_id: [n], y: [n], cluster: [n], by_model_repeat: {model: [[n] x REPS]}}
#   Folds are NOT stored; they are regenerated exactly: StratifiedGroupKFold(5, shuffle=True, random_state=RS + rep) on (y, cluster),
#   which depends only on y, groups and n (same as ftc_model.run_one / FT3).
# Calibration (s6): Brier with the no-skill Brier (prev*(1-prev)) and Brier skill; reliability table (10 quantile bins: n, mean predicted,
#   observed rate with Wilson 95% CI); calibration slope and intercept (logistic regression of y on logit(p)); calibration-in-the-large
#   (intercept with logit(p) as offset); ECE; 1,000-draw cluster-bootstrap percentile CIs (seed 20261019), same as FTR.
#   Both the raw RF scores and a sigmoid-recalibrated version:
#     nested_platt  : spec version. Per outer training fold, inner GroupKFold(3) OOF scores -> logistic map -> applied to the outer test
#                     fold; needs the model's fit_predict (refits). Fitted on the training folds only.
#     crossfit_platt: fast check from saved OOF only. Map for fold k is fitted on the OOF scores of the other folds. Those scores come from
#                     models that saw fold k's labels, so this is a second-order approximation; labelled as such.
# Permutation ranking (s6): grouped permutation importance (layer / engine groups), refit on each training fold, permute the group's columns
#   jointly in the held-out fold, AUC drop; n_perm permutations per fold; mean and 2.5-97.5 percentiles over folds x permutations.
#   Descriptive, not a test.
# Usage: calib.py oof <file.json|file.parquet> [--models m1,m2] [--designs lm3,lm7] [--out md]
#        calib.py perm-ftr <lab> <design> [--model text_audio]   (FTR v2 forest via ftc_model; same machinery the frozen model will use)
#        calib.py selftest
import os, sys, json, argparse
import numpy as np, pandas as pd
from sklearn.model_selection import StratifiedGroupKFold, GroupKFold
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

RS = 20261019; NB = int(os.environ.get('NB', 1000)); EPS = 1e-4


def logit(p): p = np.clip(np.asarray(p, float), EPS, 1 - EPS); return np.log(p / (1 - p))


def cl_boot_idx(g, nb, seed):
    """Cluster bootstrap index sets; identical generator to ftc_model.cl_boot_idx (same seed -> same draws)."""
    rng = np.random.default_rng(seed); ug = np.unique(g); idx = {k: np.where(g == k)[0] for k in ug}
    for _ in range(nb):
        yield np.concatenate([idx[k] for k in rng.choice(ug, len(ug))])


def _lr(x, y, offset=None):
    """Unpenalised logistic regression of y on x (1-d), optionally with an offset (then intercept only). -> (intercept, slope)."""
    if offset is not None:                                   # Newton on the intercept with fixed offset
        a = 0.0
        for _ in range(50):
            q = 1 / (1 + np.exp(-(a + offset))); gr = np.sum(y - q); h = np.sum(q * (1 - q))
            if h <= 0: break
            st = gr / h; a += st
            if abs(st) < 1e-10: break
        return a, 1.0
    X = np.column_stack([np.ones(len(x)), x]); b = np.zeros(2)          # Newton-Raphson (IRLS), unpenalised MLE
    for _ in range(100):
        q = 1 / (1 + np.exp(-(X @ b))); W = q * (1 - q); Hm = X.T @ (X * W[:, None]); gr = X.T @ (y - q)
        try: st = np.linalg.solve(Hm, gr)
        except np.linalg.LinAlgError: break
        b += st
        if np.max(np.abs(st)) < 1e-10: break
    return float(b[0]), float(b[1])


def wilson(k, n, z=1.96):
    if n == 0: return (np.nan, np.nan)
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def reliability(y, p, bins=10):
    """Quantile bins on p (ties kept together). -> DataFrame bin, n, mean_p, obs, obs_lo, obs_hi."""
    q = np.unique(np.quantile(p, np.linspace(0, 1, bins + 1)))
    b = np.clip(np.searchsorted(q, p, side='right') - 1, 0, len(q) - 2) if len(q) > 1 else np.zeros(len(p), int)
    rows = []
    for k in np.unique(b):
        s = b == k; n = int(s.sum()); o = int(y[s].sum()); lo, hi = wilson(o, n)
        rows.append(dict(bin=int(k) + 1, n=n, pos=o, p_lo=float(p[s].min()), p_hi=float(p[s].max()), mean_p=float(p[s].mean()),
                         obs=o / n, obs_lo=lo, obs_hi=hi))
    return pd.DataFrame(rows)


def point(y, p):
    y = np.asarray(y, int); p = np.asarray(p, float); prev = y.mean(); lp = logit(p)
    br = float(np.mean((p - y) ** 2)); ns = float(prev * (1 - prev))
    a, s = _lr(lp, y); citl, _ = _lr(None, y, offset=lp)
    rel = reliability(y, p)
    ece = float(np.sum(rel.n * np.abs(rel.mean_p - rel.obs)) / len(y))
    return dict(n=len(y), pos=int(y.sum()), prev=float(prev), auc=float(roc_auc_score(y, p)) if 0 < y.sum() < len(y) else np.nan,
                brier=br, brier_noskill=ns, bss=1 - br / ns, slope=s, intercept=a, citl=citl, mean_p=float(p.mean()), ece=ece)


def calibration(y, p, g, nb=NB, seed=RS, bins=10):
    """Point estimates + cluster-bootstrap percentile CIs for brier, bss, slope, intercept, citl, ece, auc; reliability table."""
    y = np.asarray(y, int); p = np.asarray(p, float); g = np.asarray(g)
    pt = point(y, p); keys = ['auc', 'brier', 'bss', 'slope', 'intercept', 'citl', 'ece', 'mean_p']; B = {k: [] for k in keys}
    for s in cl_boot_idx(g, nb, seed):
        if not 0 < y[s].sum() < len(s): continue
        try: q = point(y[s], p[s])
        except Exception: continue
        for k in keys: B[k].append(q[k])
    ci = {k: tuple(np.percentile(v, [2.5, 97.5])) if len(v) else (np.nan, np.nan) for k, v in B.items()}
    return dict(point=pt, ci=ci, reliability=reliability(y, p, bins), nboot=len(B['auc']))


def folds(y, g, rep, k=5):
    return list(StratifiedGroupKFold(k, shuffle=True, random_state=RS + rep).split(np.zeros(len(y)), y, g))


def crossfit_platt(P, y, g, reps):
    """P: (REPS, n) OOF scores. Per repeat and outer fold k: logistic map on logit(OOF) of the other folds, applied to fold k.
    Returns repeat-averaged recalibrated scores. APPROXIMATE (see header)."""
    out = np.zeros_like(P, dtype=float)
    for rep in range(len(P)):
        for a, b in folds(y, g, rep):
            ia, sa = _lr(logit(P[rep, a]), y[a]); out[rep, b] = 1 / (1 + np.exp(-(ia + sa * logit(P[rep, b]))))
    return out.mean(0)


def nested_platt(fit_predict, cols, DX, y, g, reps=5, inner=3, seed0=RS):
    """Spec version. fit_predict(cols, Xtr, ytr, gtr, Xte, seed) -> (scores_te, score_fn) as in FT3/ftc_model.
    For each repeat/outer fold: inner GroupKFold OOF scores on the training folds -> logistic map; full-train model scores the test fold;
    map applied. Returns (raw_oof_mean, platt_oof_mean)."""
    n = len(y); R = np.zeros((reps, n)); C = np.zeros((reps, n))
    for rep in range(reps):
        for a, b in folds(y, g, rep):
            tr = DX.iloc[a].reset_index(drop=True); te = DX.iloc[b].reset_index(drop=True); ya, ga = y[a], g[a]
            inn = np.zeros(len(a))
            for ia, ib in GroupKFold(inner).split(tr, ya, ga):
                inn[ib], _ = fit_predict(cols, tr.iloc[ia].reset_index(drop=True), ya[ia], ga[ia], tr.iloc[ib].reset_index(drop=True), seed0 + rep)
            i0, s0 = _lr(logit(inn), ya)
            R[rep, b], _ = fit_predict(cols, tr, ya, ga, te, seed0 + rep)
            C[rep, b] = 1 / (1 + np.exp(-(i0 + s0 * logit(R[rep, b]))))
    return R.mean(0), C.mean(0)


def perm_rank(fit_predict, cols, DX, y, g, groups, reps=(0, 1), n_perm=10, seed=RS):
    """Grouped permutation importance (AUC drop) of the model `cols`, refit per training fold, permuting each group's columns jointly
    in the held-out fold. -> DataFrame group, n_cols, mean, p2.5, p97.5, n (folds x perms), sorted by mean."""
    rng = np.random.default_rng(seed); D = {k: [] for k in groups}
    for rep in reps:
        for a, b in folds(y, g, rep):
            tr = DX.iloc[a].reset_index(drop=True); te = DX.iloc[b].reset_index(drop=True)
            if not 0 < y[b].sum() < len(b): continue
            _, sc = fit_predict(cols, tr, y[a], g[a], te, RS + rep)
            base = roc_auc_score(y[b], sc(te))
            for k, cs in groups.items():
                cs = [c for c in cs if c in te.columns]
                for _ in range(n_perm):
                    Xp = te.copy(); pi = rng.permutation(len(Xp)); Xp[cs] = Xp[cs].values[pi]
                    D[k].append(base - roc_auc_score(y[b], sc(Xp)))
    rows = [dict(group=k, n_cols=len(groups[k]), mean=float(np.mean(v)), lo=float(np.percentile(v, 2.5)), hi=float(np.percentile(v, 97.5)), n=len(v))
            for k, v in D.items() if v]
    return pd.DataFrame(rows).sort_values('mean', ascending=False).reset_index(drop=True)


# ---------------- reporting ----------------
def f3(x): return 'NA' if x is None or (isinstance(x, float) and np.isnan(x)) else f'{x:.3f}'


def md_calib(name, c):
    p, ci = c['point'], c['ci']
    L = [f'**{name}**: n {p["n"]}, positives {p["pos"]} (prevalence {f3(p["prev"])}), mean predicted {f3(p["mean_p"])} [{f3(ci["mean_p"][0])}, {f3(ci["mean_p"][1])}]',
         '', '| AUC | Brier | no-skill Brier | Brier skill | slope | intercept | CITL | ECE |', '|---|---|---|---|---|---|---|---|',
         '| ' + ' | '.join(f'{f3(p[k])} [{f3(ci[k][0])}, {f3(ci[k][1])}]' if k in ci else f3(p[k])
                          for k in ('auc', 'brier', 'brier_noskill', 'bss', 'slope', 'intercept', 'citl', 'ece')) + ' |', '',
         '| bin | n | pos | p range | mean predicted | observed [95% Wilson] |', '|---|---|---|---|---|---|']
    for r in c['reliability'].itertuples():
        L.append(f'| {r.bin} | {r.n} | {r.pos} | {r.p_lo:.3f}-{r.p_hi:.3f} | {r.mean_p:.3f} | {r.obs:.3f} [{r.obs_lo:.3f}, {r.obs_hi:.3f}] |')
    return L + ['']


def load_oof(path):
    """-> list of (name, oof dict). JSON: FTR list of run dicts (or one dict) with 'oof'; parquet: episode_id, y, cluster, rep, p_<model>."""
    if path.endswith('.parquet'):
        d = pd.read_parquet(path); ms = [c[2:] for c in d.columns if c.startswith('p_')]
        reps = sorted(d.rep.unique()); base = d[d.rep == reps[0]]
        o = dict(episode_id=base.episode_id.tolist(), y=base.y.tolist(), cluster=base.cluster.tolist(),
                 by_model_repeat={m: [d[d.rep == r].set_index('episode_id').loc[base.episode_id, f'p_{m}'].tolist() for r in reps] for m in ms})
        return [(os.path.basename(path), o)]
    J = json.load(open(path)); J = J if isinstance(J, list) else [J]
    return [(f'{r.get("lab", "?")} {r.get("design", "")}'.strip(), r['oof']) for r in J if 'oof' in r]


def run_oof(path, models=None, designs=None, crossfit=True):
    L = []
    for name, o in load_oof(path):
        if designs and not any(name.endswith(d) for d in designs): continue
        y = np.array(o['y'], int); g = np.array(o['cluster'])
        for m, P in o['by_model_repeat'].items():
            if models and m not in models: continue
            P = np.array(P, float)
            L += md_calib(f'{name} / {m} / raw RF (repeat-averaged OOF)', calibration(y, P.mean(0), g))
            if crossfit: L += md_calib(f'{name} / {m} / sigmoid, cross-fitted on OOF (approximate)', calibration(y, crossfit_platt(P, y, g, len(P)), g))
    return L


def ftr_setup(lab, design):
    """Rebuild the FTR v2 design (DX, y, g, M, groups) with ftc_model's own code (AUDIO env must point at the rl-feat parquet)."""
    sys.path.insert(0, os.path.expanduser('~/wt/ft-calltext/code')); import ftc_model as fm
    D = fm.F[fm.F[lab].notna() & (fm.F.rx_date >= '2026-01-01')]; D = D[~D.amb_hash]
    D = D[~(D.days_to_surgery <= int(design[2:]))].reset_index(drop=True); y = D[lab].values.astype(int); g = D.cluster_key.values
    X, CG = fm.call_feats(D, y, design, np.random.default_rng(fm.RS + 7)); XA, AG = fm.audio_feats(D, design)
    DX = pd.concat([D, X] + ([XA] if XA is not None else []), axis=1)
    cc = [c for v in CG.values() for c in v]; ac = [c for v in AG.values() for c in v]
    M = {'base': fm.BCOLS, 'text': fm.BCOLS + cc, 'text_audio': fm.BCOLS + cc + ac}
    return fm, DX, y, g, M, {**fm.BGROUPS, **CG, **AG}


def selftest():
    rng = np.random.default_rng(1); n = 3000; g = np.arange(n) // 3
    x = rng.normal(size=n); p = 1 / (1 + np.exp(-(-2 + x))); y = (rng.random(n) < p).astype(int)
    c = point(y, p); assert abs(c['slope'] - 1) < 0.15 and abs(c['intercept']) < 0.3 and abs(c['citl']) < 0.15, c
    po = 1 / (1 + np.exp(-(-2 + 2 * x)))                     # overconfident -> slope ~0.5
    c2 = point(y, po); assert 0.35 < c2['slope'] < 0.65, c2
    c3 = point(y, np.clip(p * 2, 0, 1)); assert c3['citl'] < -0.4, c3      # over-predicts -> negative CITL
    assert c['brier'] < c['brier_noskill'] and c['bss'] > 0
    r = reliability(y, p); assert r.n.sum() == n and len(r) == 10
    P = np.vstack([po, po]); cf = crossfit_platt(P, y, g, 2); assert abs(point(y, cf)['slope'] - 1) < 0.2
    full = calibration(y, p, g, nb=200); assert full['ci']['slope'][0] < 1 < full['ci']['slope'][1], full['ci']
    # permutation: informative column ranks first, noise ~0
    DX = pd.DataFrame({'x': x, 'z': rng.normal(size=n)})
    def fp(cols, Xtr, ytr, gtr, Xte, seed):
        m = LogisticRegression().fit(Xtr[cols].values, ytr); sc = lambda X: m.predict_proba(X[cols].values)[:, 1]; return sc(Xte), sc
    pr = perm_rank(fp, ['x', 'z'], DX, y, g, {'x': ['x'], 'z': ['z']}, reps=(0,), n_perm=5)
    assert pr.group[0] == 'x' and pr['mean'][0] > 0.1 and abs(pr.set_index('group').at['z', 'mean']) < 0.01, pr
    raw, cal = nested_platt(fp, ['x'], DX, y, g, reps=1)
    assert abs(point(y, cal)['slope'] - 1) < 0.2 and abs(point(y, cal)['citl']) < 0.2
    print('selftest OK: slope/intercept/CITL/Brier/reliability/crossfit/nested/perm')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('cmd'); ap.add_argument('args', nargs='*')
    ap.add_argument('--models'); ap.add_argument('--designs'); ap.add_argument('--out'); ap.add_argument('--model', default='text_audio')
    ap.add_argument('--reps', default='0,1'); ap.add_argument('--n-perm', type=int, default=10); ap.add_argument('--nested', action='store_true')
    a = ap.parse_args()
    if a.cmd == 'selftest': selftest()
    elif a.cmd == 'oof':
        L = run_oof(a.args[0], a.models and a.models.split(','), a.designs and a.designs.split(','))
        txt = '\n'.join(L); print(txt) if not a.out else open(a.out, 'w').write(txt + '\n')
    elif a.cmd == 'perm-ftr':
        lab, design = a.args; fm, DX, y, g, M, G = ftr_setup(lab, design)
        G = {k: v for k, v in G.items() if any(c in M[a.model] for c in v)}
        L = [f'**Permutation ranking: FTR v2 {lab} {design} / {a.model}** (n {len(y)}, positives {int(y.sum())}; folds of repeats {a.reps}, {a.n_perm} permutations each; AUC drop, mean [2.5, 97.5 pct]; descriptive)', '',
             '| group | cols | AUC drop | 2.5% | 97.5% | draws |', '|---|---|---|---|---|---|']
        pr = perm_rank(fm.fit_predict, M[a.model], DX, y, g, G, reps=tuple(int(r) for r in a.reps.split(',')), n_perm=a.n_perm)
        L += [f'| {r.group} | {r.n_cols} | {r.mean:+.4f} | {r.lo:+.4f} | {r.hi:+.4f} | {r.n} |' for r in pr.itertuples()]
        if a.nested:
            raw, cal = nested_platt(fm.fit_predict, M[a.model], DX, y, g, reps=int(os.environ.get('REPS', 5)))
            L += [''] + md_calib(f'{lab} {design} / {a.model} / raw RF (refit here)', calibration(y, raw, g)) \
                 + md_calib(f'{lab} {design} / {a.model} / nested in-fold sigmoid (spec)', calibration(y, cal, g))
        txt = '\n'.join(L); print(txt) if not a.out else open(a.out, 'w').write(txt + '\n')
    else: sys.exit('cmd: oof | perm-ftr | selftest')
