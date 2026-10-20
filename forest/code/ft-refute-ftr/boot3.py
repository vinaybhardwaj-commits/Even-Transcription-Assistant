import numpy as np
from sklearn.metrics import roc_auc_score
def cl_boot_idx(g, nb, seed):
    rng = np.random.default_rng(seed); ug = np.unique(g); idx = {k: np.where(g == k)[0] for k in ug}
    for _ in range(nb): yield np.concatenate([idx[k] for k in rng.choice(ug, len(ug))])
def boot_delta(y, pa, pb, g, nb=1000, seed=0):
    d = [roc_auc_score(y[s], pb[s]) - roc_auc_score(y[s], pa[s]) for s in cl_boot_idx(g, nb, seed) if 0 < y[s].sum() < len(s)]
    return (roc_auc_score(y, pb) - roc_auc_score(y, pa), *np.percentile(d, [2.5, 97.5]), float(np.mean(np.array(d) <= 0)))
for lab,T,a,b in (('h90',7,'base','audio'),('ale',7,'base','ta'),('h14',7,'text','ta')):
    z=np.load(f'oof_{lab}_lm{T}_s0.npz',allow_pickle=True); y=z['y']; g=z['grp']
    for seed in (0,1,2):
        r=boot_delta(y,z[a].mean(0),z[b].mean(0),g,seed=seed); print(lab,T,f'{b}-{a}','seed',seed,' '.join(f'{x:+.3f}' for x in r))
