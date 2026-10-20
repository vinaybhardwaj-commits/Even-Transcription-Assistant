# ft-whoconverts (20 Oct 2026): readable comparison model. L2 logistic regression (C = 1, fixed, not tuned) on the Pulse baseline (layer 0)
# plus the 10 non-baseline inputs with the largest permutation drop in that design's FULL forest (perm_<design>_h14.json). D split only.
# Same rows, folds (StratifiedGroupKFold(5, RS + rep), 5 repeats) and in-fold doctor rate (m = 10) as the frozen forest.
# Encoding (fit on the training rows only): numeric -> median-imputed + missing flag where any value is missing, then z-scored;
# categorical -> one-hot for levels with n >= 10, reference = the most common level; 0/1 inputs, flags and one-hots are left unscaled (OR = yes vs no). ORs: full-data fit, per 1 SD (numeric) or vs reference,
# 95% interval from 300 cluster-bootstrap refits (of the penalised estimate, so pulled towards 1). Direction only; not causal.
import os, sys, json
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.expanduser('~/wt/ft-forest/code')); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import warnings; warnings.simplefilter('ignore')
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.metrics import roc_auc_score
import forest_lib as FL, forest_build as FB
from wc_names import plain

OUT = os.path.expanduser('~/oc/forest-lead/ft/out/ft-whoconverts'); FR = os.path.expanduser('~/oc/forest-lead/ft/out/ft-forest')
TOPK = int(os.environ.get('TOPK', 10)); SUF = '' if TOPK == 10 else f'_top{TOPK}'
NB_OR = int(os.environ.get("NB_OR", 300)); C_L2 = 1.0


class LEnc:
    def __init__(self, cols, X, dr=None):
        self.cat = [c for c in cols if X[c].dtype == object and c != 'doctor_id']; self.num = [c for c in cols if c not in self.cat + ['doctor_id']]
        self.doc = 'doctor_id' in cols
        self.lev = {}
        for c in self.cat:
            vc = X[c].value_counts(); L = [l for l, n in vc.items() if n >= 10]; self.lev[c] = L[1:]
            self.lev[c + '__ref'] = L[0] if L else None
        self.med = X[self.num].median(); self.miss = [c for c in self.num if X[c].isna().any()]
        Z = self._raw(X, dr); self.mu = Z.mean(0); self.sd = Z.std(0); self.sd[self.sd == 0] = 1
        self.bin = [c for c in self.num if set(X[c].dropna().unique()) <= {0, 1}]
        nb = len(self.num) + len(self.miss); ib = [i for i, c in enumerate(self.num) if c in self.bin] + list(range(len(self.num), nb))
        ib += list(range(nb, Z.shape[1] - int(self.doc)))          # flags and one-hots stay 0/1: OR = yes vs no
        self.mu[ib] = 0; self.sd[ib] = 1

    def _raw(self, X, dr):
        out = [X[self.num].astype(float).fillna(self.med).values, X[self.miss].isna().values.astype(float)]
        for c in self.cat: out += [(X[c] == l).values[:, None].astype(float) for l in self.lev[c]]
        if self.doc: out.append((dr if dr is not None else np.zeros(len(X)))[:, None])
        return np.hstack(out)

    def tf(self, X, dr=None): return (self._raw(X, dr) - self.mu) / self.sd

    def names(self):
        n = [(c, 'yes vs no' if c in self.bin else 'per SD') for c in self.num] + [(c, 'missing vs present') for c in self.miss]
        for c in self.cat: n += [(c, f'{l} vs {self.lev[c + "__ref"]}') for l in self.lev[c]]
        if self.doc: n.append(('doctor_id', 'per SD of doctor rate'))
        return n


def fit(cols, Xtr, ytr, gtr):
    use_doc = 'doctor_id' in cols; drt = None
    if use_doc:
        drt = np.zeros(len(Xtr))
        for a, b in GroupKFold(5).split(Xtr, ytr, gtr): drt[b], _ = FL.doc_rate(Xtr.doctor_id.values[a], ytr[a], Xtr.doctor_id.values[b])
    enc = LEnc(cols, Xtr, drt); Z = enc.tf(Xtr, drt)
    lr = LogisticRegression(C=C_L2, max_iter=5000).fit(Z, ytr)
    def score(X): return lr.predict_proba(enc.tf(X, FL.doc_rate(Xtr.doctor_id.values, ytr, X.doctor_id.values)[0] if use_doc else None))[:, 1]
    return lr, enc, score


def main(design, lab='h14'):
    D = FB.build(design, lab); P = json.load(open(os.environ.get('PERM_JSON', f'{OUT}/perm_{design}_{lab}.json')))
    full = 'M2' if design == 'rx' else 'FULL'; fz = json.load(open(f'{FR}/model_frozen_{design}_{lab}.json'))[0]
    base = D.layers['L0']
    top = [c for c, _ in sorted(P['perm'].items(), key=lambda kv: -kv[1]['mean']) if c not in base][:TOPK]
    cols = base + top
    O = np.zeros((D.reps, len(D.y)))
    for rep in range(D.reps):
        for a, b in D.folds(rep):
            tr, te = D.DX.iloc[a].reset_index(drop=True), D.DX.iloc[b].reset_index(drop=True)
            O[rep, b] = fit(cols, tr, D.y[a], D.g[a])[2](te)
    pl = O.mean(0); pf = np.array(fz['oof']['by_model_repeat'][full]).mean(0)
    auc_l = FL.boot(D.y, pl, D.g, 1000); dlt = FL.boot_delta(D.y, pf, pl, D.g, 1000)
    lr, enc, _ = fit(cols, D.DX, D.y, D.g); names = enc.names(); beta = lr.coef_[0]
    rng = np.random.default_rng(FL.BOOT_SEED); ug = np.unique(D.g); idx = {k: np.where(D.g == k)[0] for k in ug}; B = []
    for _ in range(NB_OR):
        s = np.concatenate([idx[k] for k in rng.choice(ug, len(ug))]); Xs = D.DX.iloc[s].reset_index(drop=True)
        if not 0 < D.y[s].sum() < len(s): continue
        l2, e2, _ = fit(cols, Xs, D.y[s], D.g[s]); m = dict(zip(e2.names(), l2.coef_[0])); B.append([m.get(n, np.nan) for n in names])
    B = np.array(B)
    ors = [dict(col=c, input=plain(c), contrast=k, top10=c in top, OR=float(np.exp(b)), lo=float(np.exp(np.nanpercentile(B[:, i], 2.5))),
                hi=float(np.exp(np.nanpercentile(B[:, i], 97.5))), n_boot=int(np.sum(~np.isnan(B[:, i]))))
           for i, ((c, k), b) in enumerate(zip(names, beta))]
    res = dict(design=design, lab=lab, n=int(len(D.y)), pos=int(D.y.sum()), top10=top, top10_plain=[plain(c) for c in top], C=C_L2,
               auc_logit=auc_l['auc'], auc_forest=fz['auc'][full]['auc'], delta_logit_minus_forest=dlt, ors=ors)
    with os.fdopen(os.open(f'{OUT}/logit_{design}_{lab}{SUF}.json', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as fh: json.dump(res, fh, default=float)
    print(design, lab, 'logit AUC', [round(x, 3) for x in auc_l['auc']], 'forest', [round(x, 3) for x in fz['auc'][full]['auc']],
          'delta', round(dlt['delta'], 3), [round(x, 3) for x in dlt['ci']], flush=True)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'h14')
