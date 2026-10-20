# ft-refute-whoconverts: fidelity checks on perm_*.json and logit_*.json without forest_build (which reads the f1 TSV that holds H rows).
# Folds rebuilt from features_D (y, cluster_key) for the frozen OOF ids; frozen OOF AUC per fold vs the perm run's refit base AUC.
import os, sys, json
sys.dont_write_bytecode = True
import numpy as np, pandas as pd
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.metrics import roc_auc_score

H = os.path.expanduser; O = H('~/oc/forest-lead/ft/out'); W = f'{O}/ft-whoconverts'; R = {}
F = pd.read_parquet(f'{O}/ft-labels-base/features_D.parquet'); assert set(F.split) == {'D'}
F = F.set_index('episode_id')
for d, full in (('rx', 'M2'), ('lm7', 'FULL')):
    fz = json.load(open(f'{O}/ft-forest/model_frozen_{d}_h14.json'))[0]; P = json.load(open(f'{W}/perm_{d}_h14.json'))
    G = json.load(open(f'{W}/logit_{d}_h14.json')); G0 = json.load(open(f'{W}/logit_{d}_h14_top0.json'))
    ids = fz['oof']['episode_id']; y = F.loc[ids, 'h14'].values.astype(int); g = F.loc[ids, 'cluster_key'].values
    ref = np.array(fz['oof']['by_model_repeat'][full])
    fold_auc = []
    for rep in P['reps']:
        for a, b in StratifiedGroupKFold(5, shuffle=True, random_state=20261019 + rep).split(np.zeros(len(y)), y, g):
            fold_auc.append(roc_auc_score(y[b], ref[rep, b]))
    base = sorted(P['perm'], key=lambda c: -P['perm'][c]['mean'])
    top_nb = [c for c in base if c not in fz['layers']['L0']][:10]
    R[d] = dict(n=len(y), pos=int(y.sum()), frozen_reps=fz['reps'], oof_shape=list(ref.shape), fold_seed=fz.get('fold_seed'),
                perm_reps=P['reps'], perm_n_per_input=sorted({v['n'] for v in P['perm'].values()}), perm_max_diff=P['max_abs_diff_vs_frozen_oof'],
                fold_auc_frozen_vs_perm_base_maxdiff=float(np.max(np.abs(np.array(fold_auc) - np.array(P['fold_base_auc'])))),
                n_inputs=len(P['perm']), n_interval_above0=int(sum(v['lo'] > 0 for v in P['perm'].values())),
                logit_top10_matches_perm=(G['top10'] == top_nb), logit_auc=G['auc_logit'], logit_top0_auc=G0['auc_logit'],
                forest_auc_full=fz['auc'][full]['auc'], forest_auc_L0=fz['auc']['M0' if d == 'rx' else 'L0']['auc'],
                delta_top0=G0['delta_logit_minus_forest'], delta_top10=G['delta_logit_minus_forest'],
                top10_or_clear=[(o['input'], round(o['OR'], 2), round(o['lo'], 2), round(o['hi'], 2)) for o in G['ors'] if o['top10'] and o['contrast'] != 'missing vs present' and (o['lo'] > 1 or o['hi'] < 1)])
    # mean-OOF AUC over repeats (what the logistic is compared with)
    R[d]['frozen_meanoof_auc'] = float(roc_auc_score(y, ref.mean(0)))
os.umask(0o077); json.dump(R, open(f'{O}/ft-refute-whoconverts/r4_models.json', 'w'), default=float, indent=1)
print(json.dumps(R, default=float, indent=1))
