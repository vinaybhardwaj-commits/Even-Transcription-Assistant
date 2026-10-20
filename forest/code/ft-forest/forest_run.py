# ft-forest runner (20 Oct 2026). One (design, lab) per call -> model_frozen_<design>_<lab>.json (a one-record list in the FTR format,
# which ft-bench run_frozen.sh / bench_score.py read: lab, design, oof{episode_id, y, cluster, by_model_repeat}).
# Usage: forest_run.py <design rx|lm3|lm7|consult> <lab> [--out DIR] [--reps N] [--nb N] [--no-l8] [--no-perm] [--tag T] [--raw-tags] [--role-free]
# Models: A (rx) M0 = L0, M1 = L0+L1, M2 = M1 + consult C3-C7. B (lm3/lm7) L0..L8 cumulative in the fixed order, FULL (= every layer), SELECTED.
# C (consult) C0, C1, C3..C8 cumulative, FULL, SELECTED. SELECTED = forward pass in the fixed order: a layer is kept if its paired delta AUC over
# the current model (repeat-averaged OOF) is > 0 and the bootstrap P(delta <= 0) <= 0.20 (spec s5). Not a test; its AUC is optimistic.
import os, sys, json, time, argparse, datetime as dt
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import warnings; warnings.simplefilter('ignore')
import numpy as np, pandas as pd
from sklearn.metrics import roc_auc_score
import forest_lib as FL, forest_build as FB

KEEP_P = 0.20


def now_ist(): return dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).strftime('%Y-%m-%d %H:%M IST')


def model_name(design, layers_used, order):
    if design == 'rx':
        return {('L0',): 'M0', ('L0', 'L1'): 'M1'}.get(tuple(layers_used), 'M2' if layers_used == order else None)
    last = layers_used[-1]
    if layers_used != order[:order.index(last) + 1]: return None
    return ('C' if design == 'consult' else 'L') + last[1]


class Runner:
    def __init__(self, Dz, nb):
        self.D = Dz; self.nb = nb; self.cache = {}; self.t0 = time.time()

    def cols(self, layers):
        return [c for L in layers for c in self.D.layers[L]]

    def oof(self, layers):
        k = tuple(layers)
        if k in self.cache: return self.cache[k]
        D = self.D; cols = self.cols(layers); O = np.zeros((D.reps, len(D.y)))
        for rep in range(D.reps):
            for a, b in D.folds(rep):
                tr, te = D.DX.iloc[a].reset_index(drop=True), D.DX.iloc[b].reset_index(drop=True)
                O[rep, b], _ = FL.fit_predict(cols, tr, D.y[a], D.g[a], te, use_doc=D.use_doc)
        self.cache[k] = O
        print(f'  fit {"+".join(layers)}: {len(cols)} cols, AUC {roc_auc_score(D.y, O.mean(0)):.3f}, {round(time.time() - self.t0)}s', flush=True)
        return O

    def delta(self, la, lb):
        D = self.D; A, B = self.oof(la), self.oof(lb)
        d = FL.boot_delta(D.y, A.mean(0), B.mean(0), D.g, self.nb)
        rd = np.array([roc_auc_score(D.y, b) - roc_auc_score(D.y, a) for a, b in zip(A, B)])
        d.update(per_repeat=rd.tolist(), p_repeats_le0=float(np.mean(rd <= 0)))
        return d

    def selected(self):
        order = self.D.order; cur = [order[0]]; path = []
        for L in order[1:]:
            cand = cur + [L]; d = self.delta(cur, cand)
            keep = d['delta'] > 0 and d['p_boot_le0'] <= KEEP_P
            path.append(dict(layer=L, over='+'.join(cur), delta=d['delta'], ci=d['ci'], p_boot_le0=d['p_boot_le0'], kept=bool(keep)))
            if keep: cur = cand
        return cur, path

    def perm(self, layers, groups, reps=(0, 1), n_perm=10, seed=FL.BOOT_SEED):
        """Grouped permutation importance (AUC drop), refit per training fold, each group's columns permuted jointly in the held-out fold
        (ft-bench calib.perm_rank protocol). Descriptive."""
        D = self.D; cols = self.cols(layers); rng = np.random.default_rng(seed); out = {k: [] for k in groups}
        for rep in reps:
            for a, b in D.folds(rep):
                if not 0 < D.y[b].sum() < len(b): continue
                tr, te = D.DX.iloc[a].reset_index(drop=True), D.DX.iloc[b].reset_index(drop=True)
                _, sc = FL.fit_predict(cols, tr, D.y[a], D.g[a], te, use_doc=D.use_doc)
                base = roc_auc_score(D.y[b], sc(te))
                for k, cs in groups.items():
                    cs = [c for c in cs if c in cols]
                    if not cs: continue
                    for _ in range(n_perm):
                        Xp = te.copy(); pi = rng.permutation(len(Xp)); Xp[cs] = Xp[cs].values[pi]
                        out[k].append(base - roc_auc_score(D.y[b], sc(Xp)))
        return {k: dict(n_cols=len([c for c in groups[k] if c in cols]), mean=float(np.mean(v)), lo=float(np.percentile(v, 2.5)),
                        hi=float(np.percentile(v, 97.5)), n=len(v)) for k, v in out.items() if v}


def coverage(Dz):
    X, y = Dz.DX, Dz.y; C = {}
    def has(L):
        cols = Dz.layers[L]; fl = [c for c in cols if c.startswith(('has_', 'c_has_', 'bolna_has', 'ft8_has_', 'roles_ok'))]
        if L == 'L0': return np.ones(len(X), bool)
        if L == 'L1' and any(c.startswith('ft8_has_') for c in cols): return (X[[c for c in cols if c.startswith('ft8_has_')]] > 0).any(axis=1).values
        if L == 'L2' and 'n_calls' in X: return X.n_calls.values > 0
        if L == 'L3' and 'has_stt_tags' in X: return (X.n_summaries.values > 0) | (X.has_stt_tags.values > 0) | (X.bolna_has.values > 0)
        f = [c for c in fl if c.endswith(('has_jev_items', 'has_nemo', 'has_ody', 'has_e2v', 'has_clef', 'has_l8'))]
        return (X[f] > 0).any(axis=1).values if f else X[cols].notna().any(axis=1).values
    for L in Dz.order:
        h = has(L)
        C[L] = dict(n=int(h.sum()), share=float(h.mean()), pos=int((h & (y == 1)).sum()), pos_share=float(h[y == 1].mean()),
                    neg=int((h & (y == 0)).sum()), neg_share=float(h[y == 0].mean()))
        if L == 'L3' and 'has_stt_tags' in X:
            C[L]['sources'] = {'runo_summary': int((X.n_summaries > 0).sum()), 'runo_stt': int((X.has_stt_tags > 0).sum()), 'bolna': int((X.bolna_has > 0).sum())}
        if L in ('L4', 'L5', 'L6', 'L7', 'C4', 'C5', 'C6', 'C7'):
            rc = Dz.subgroups.get(f'{L}:role', [])
            if rc: C[L]['role_cols_present'] = int(X[rc].notna().any(axis=1).sum())
    return C


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('design'); ap.add_argument('lab')
    ap.add_argument('--out', default=os.path.expanduser('~/oc/forest-lead/ft/out/ft-forest'))
    ap.add_argument('--reps', type=int); ap.add_argument('--nb', type=int, default=1000)
    ap.add_argument('--no-l8', action='store_true'); ap.add_argument('--no-perm', action='store_true')
    ap.add_argument('--raw-tags', action='store_true'); ap.add_argument('--role-free', action='store_true')
    ap.add_argument('--tag', default='')
    a = ap.parse_args(argv)
    started = now_ist()
    Dz = FB.build(a.design, a.lab, reps=a.reps, include_l8=not a.no_l8, raw_tags=a.raw_tags, role_free=a.role_free)
    print(a.design, a.lab, 'n', len(Dz.y), 'pos', int(Dz.y.sum()), Dz.notes, flush=True)
    R = Runner(Dz, a.nb); order = Dz.order
    models = {}
    if a.design == 'rx':
        models = {'M0': ['L0'], 'M1': ['L0', 'L1'], 'M2': order}
        pairs = [('M0', 'M1'), ('M1', 'M2'), ('M0', 'M2')]
    else:
        for i in range(len(order)): models[model_name(a.design, order[:i + 1], order)] = order[:i + 1]
        models['FULL'] = order
        sel, path = R.selected()
        models['SELECTED'] = sel
        names = [model_name(a.design, order[:i + 1], order) for i in range(len(order))]
        pairs = list(zip(names[:-1], names[1:])) + [(names[0], 'FULL')]
    oof = {m: R.oof(L) for m, L in models.items()}
    y, g = Dz.y, Dz.g; P_ = {m: o.mean(0) for m, o in oof.items()}
    r = dict(lab=a.lab, design=a.design, tag=a.tag, n=int(len(y)), pos=int(y.sum()), clusters=int(len(np.unique(g))), reps=Dz.reps,
             fold_seed='RS + rep, RS = 20261019' if Dz.use_doc else 'rep (FT4)', boot_draws=a.nb, boot_seed=FL.BOOT_SEED,
             learner=f'RandomForestClassifier({FL.RF_KW})' + (' + in-fold doctor rate m=10' if Dz.use_doc else ''),
             layer_order=order, layers={L: Dz.layers[L] for L in order}, layer_names=FB.LAYER_NAMES, models=models, notes=Dz.notes,
             include_l8=not a.no_l8, raw_tags=a.raw_tags, role_free=a.role_free, started=started)
    r['oof'] = {'episode_id': list(map(str, Dz.ids)), 'y': y.tolist(), 'cluster': list(map(str, g)),
                'by_model_repeat': {m: o.round(6).tolist() for m, o in oof.items()}}
    r['per_repeat_auc'] = {m: [float(roc_auc_score(y, o)) for o in oof[m]] for m in models}
    r['auc'] = {m: FL.boot(y, P_[m], g, a.nb) for m in models}
    r['delta'] = {f'{b}-{a_}': R.delta(models[a_], models[b]) for a_, b in pairs}
    if a.design != 'rx':
        r['selected_path'] = path
        r['delta']['SELECTED-' + pairs[0][0]] = R.delta(models[pairs[0][0]], models['SELECTED'])
    r['coverage'] = coverage(Dz)
    if not a.no_perm:
        full = models['M2' if a.design == 'rx' else 'FULL']
        groups = {L: Dz.layers[L] + (['doctor_id'] if L == 'L0' and Dz.use_doc and 'doctor_id' not in Dz.layers[L] else []) for L in full}
        groups.update({k: v for k, v in Dz.subgroups.items() if v})
        r['perm'] = R.perm(full, groups)
        r['perm_model'] = 'M2' if a.design == 'rx' else 'FULL'
    r['finished'] = now_ist()
    os.makedirs(a.out, exist_ok=True)
    p = f'{a.out}/model_frozen_{a.design}_{a.lab}{a.tag}.json'
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh: json.dump([r], fh, default=float)
    os.chmod(p, 0o600)
    print('wrote', p, ' '.join(f'{m} {r["auc"][m]["auc"][0]:.3f}' for m in models), flush=True)
    return r


if __name__ == '__main__':
    main()
