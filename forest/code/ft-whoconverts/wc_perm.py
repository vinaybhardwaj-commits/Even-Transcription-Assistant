# ft-whoconverts (20 Oct 2026): per-feature permutation importance inside the frozen FULL forests. D split only.
# Usage: wc_perm.py <rx|lm7> <lab> [n_perm]. Design A (rx) FULL = M2, design B day 7 (lm7) FULL = every layer.
# Same protocol as ft-forest forest_run.Runner.perm (refit per training fold, frozen learner, folds RS + rep, repeats 0 and 1), but each
# input column is permuted alone in the held-out fold. Each fit's held-out scores are checked against the frozen OOF in model_frozen_*.json.
# Descriptive: AUC drop when one column is shuffled; correlated columns share credit, so a low drop does not mean "unused".
import os, sys, json, time
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.expanduser('~/wt/ft-forest/code'))
import warnings; warnings.simplefilter('ignore')
import numpy as np
from sklearn.metrics import roc_auc_score
import forest_lib as FL, forest_build as FB

OUT = os.path.expanduser('~/oc/forest-lead/ft/out/ft-whoconverts')
FR = os.path.expanduser('~/oc/forest-lead/ft/out/ft-forest')


def main(design, lab, n_perm=3, reps=(0, 1)):
    D = FB.build(design, lab); assert set(FB.load_F().split) == {'D'}
    full = 'M2' if design == 'rx' else 'FULL'
    fz = json.load(open(f'{FR}/model_frozen_{design}_{lab}.json'))[0]
    assert fz['oof']['episode_id'] == list(map(str, D.ids)) and fz['models'][full] == D.order
    ref = np.array(fz['oof']['by_model_repeat'][full])
    cols = [c for L in D.order for c in D.layers[L]]
    rng = np.random.default_rng(FL.BOOT_SEED); out = {c: [] for c in cols}; base_all = []; maxdiff = 0.0; t0 = time.time()
    for rep in reps:
        for k, (a, b) in enumerate(D.folds(rep)):
            tr, te = D.DX.iloc[a].reset_index(drop=True), D.DX.iloc[b].reset_index(drop=True)
            s0, sc = FL.fit_predict(cols, tr, D.y[a], D.g[a], te, use_doc=D.use_doc)
            maxdiff = max(maxdiff, float(np.abs(s0 - ref[rep, b]).max()))
            if not 0 < D.y[b].sum() < len(b): continue
            base = roc_auc_score(D.y[b], s0); base_all.append(base)
            for c in cols:
                for _ in range(n_perm):
                    Xp = te.copy(); Xp[c] = Xp[c].values[rng.permutation(len(Xp))]
                    out[c].append(base - roc_auc_score(D.y[b], sc(Xp)))
            print(f'rep {rep} fold {k}: base {base:.3f}, {round(time.time() - t0)}s, max |score - frozen| {maxdiff:.2e}', flush=True)
    res = dict(design=design, lab=lab, model=full, n=int(len(D.y)), pos=int(D.y.sum()), reps=list(reps), n_perm=n_perm,
               frozen_auc=fz['auc'][full]['auc'], fold_base_auc=base_all, max_abs_diff_vs_frozen_oof=maxdiff,
               layer_of={c: L for L in D.order for c in D.layers[L]},
               coverage={c: float(D.DX[c].notna().mean()) for c in cols},
               perm={c: dict(mean=float(np.mean(v)), lo=float(np.percentile(v, 2.5)), hi=float(np.percentile(v, 97.5)),
                             fold_pos=float(np.mean([np.mean(v[i:i + n_perm]) > 0 for i in range(0, len(v), n_perm)])), n=len(v))
                     for c, v in out.items()})
    p = f'{OUT}/perm_{design}_{lab}.json'
    with os.fdopen(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as fh: json.dump(res, fh)
    print('wrote', p, 'max diff', maxdiff, flush=True)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 3)
