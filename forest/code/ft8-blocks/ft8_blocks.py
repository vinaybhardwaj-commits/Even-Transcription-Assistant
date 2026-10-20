# ft8-blocks (20 Oct 2026): POST-HOC, DESCRIPTIVE block ablation of FT8 (layer 1) in design A (at the Rx), D split only. H is never read.
# Reuses ft-forest code unchanged (forest_build.build('rx'), forest_lib learner / folds / bootstrap): RF(400, leaf 5, sqrt, random_state 0),
# in-fold doctor rate m = 10, NaN -> -1 plus has_ flags, 5 x 5 StratifiedGroupKFold(RS + rep), 1,000-draw cluster bootstrap (BOOT_SEED).
# Usage: ft8_blocks.py <lab h14|h90|ale> --out DIR [--nb 1000]. Writes blocks_<lab>.json (deltas, coverage, OOF arrays).
# Models: M0 = L0; M1 = L0 + all 42 ft8_*; (a) M0 + one block; (b) M1 - one block; (c) M0 + all 9 ft8_has_* flags,
# M0 + one "any history" flag, M0 + ft8_has_prior_rx alone ("new to Even"); (d) M0 + the 42 ft8 columns row-shuffled (dilution control).
import os, sys, json, argparse, time
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.expanduser('~/wt/ft-forest/code'))
import warnings; warnings.simplefilter('ignore')
import numpy as np, pandas as pd
from sklearn.metrics import roc_auc_score
import forest_lib as FL, forest_build as FB, forest_run as FR

BLOCKS = {  # FT-MODEL-SPEC-20OCT s10 field lists
    'utilisation': ['ft8_n_prior_rx_all', 'ft8_n_prior_rx_12m', 'ft8_n_doctors_12m', 'ft8_days_since_first_rx', 'ft8_has_prior_rx'],
    'comorbidity': ['ft8_n_icd_codes', 'ft8_charlson_n', 'ft8_charlson_score', 'ft8_dm', 'ft8_htn', 'ft8_ckd', 'ft8_cad', 'ft8_obesity',
                    'ft8_has_icd', 'ft8_n_comorb_names'],
    'admissions': ['ft8_n_ip_events_pre'],
    'vitals': ['ft8_sbp', 'ft8_dbp', 'ft8_bp_age_d', 'ft8_has_bp'],
    'labs': [f'ft8_{l}{s}' for l in ('hba1c', 'hb', 'creat', 'egfr', 'tsh') for s in ('', '_age_d', '_n_pre')] +
            [f'ft8_has_{l}' for l in ('hba1c', 'hb', 'creat', 'egfr', 'tsh')],
    'medicines': ['ft8_n_meds_latest_prior_rx', 'ft8_has_meds'],
}
HAS = [c for b in BLOCKS.values() for c in b if c.startswith('ft8_has_')]


def block_has(X, b):
    """Row has any data in block b (its has_ flag(s); admissions: >= 1 prior IP event)."""
    if b == 'admissions': return X.ft8_n_ip_events_pre.fillna(0).values > 0
    return (X[[c for c in BLOCKS[b] if c.startswith('ft8_has_')]].fillna(0) > 0).any(axis=1).values


def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument('lab'); ap.add_argument('--out', required=True); ap.add_argument('--nb', type=int, default=1000)
    a = ap.parse_args(argv); t0 = time.time()
    Dz = FB.build('rx', a.lab, include_l8=False)
    c8 = Dz.layers['L1']; assert sorted(c8) == sorted(c for b in BLOCKS.values() for c in b) and len(c8) == 42
    X = Dz.DX
    X['ft8x_any_history'] = np.column_stack([block_has(X, b) for b in BLOCKS]).any(axis=1).astype(float)
    L0 = Dz.layers['L0']
    sets = {'M0': L0, 'M1': L0 + c8}
    for b, cs in BLOCKS.items():
        sets[f'M0+{b}'] = L0 + cs
        sets[f'M1-{b}'] = L0 + [c for c in c8 if c not in cs]
    sets['M0+has_flags'] = L0 + HAS
    sets['M0+any_history'] = L0 + ['ft8x_any_history']
    sets['M0+has_prior_rx'] = L0 + ['ft8_has_prior_rx']
    # (d) dilution control: all 42 ft8 columns with rows permuted jointly (fixed seed): same columns and missingness mix, no link to y
    pi = np.random.default_rng(FL.BOOT_SEED).permutation(len(X)); sh = ['ft8sh_' + c[4:] for c in c8]
    X[sh] = X[c8].values[pi]; sets['M0+ft8_shuffled'] = L0 + sh
    Dz.layers = {k: v for k, v in sets.items()}                 # Runner.cols(layers) concatenates Dz.layers[name] for each name
    R = FR.Runner(Dz, a.nb)
    oof = {m: R.oof([m]) for m in sets}
    pairs = [('M0', 'M1')] + [('M0', f'M0+{b}') for b in BLOCKS] + [('M1', f'M1-{b}') for b in BLOCKS] + \
            [('M0', 'M0+has_flags'), ('M0', 'M0+any_history'), ('M0', 'M0+has_prior_rx'), ('M0', 'M0+ft8_shuffled'),
             ('M0+ft8_shuffled', 'M1')]
    y, g = Dz.y, Dz.g
    r = dict(lab=a.lab, n=int(len(y)), pos=int(y.sum()), clusters=int(len(np.unique(g))), reps=Dz.reps, nb=a.nb, boot_seed=FL.BOOT_SEED,
             learner=f'RandomForestClassifier({FL.RF_KW}) + in-fold doctor rate m=10', blocks=BLOCKS, models={k: len(v) for k, v in sets.items()},
             post_hoc='POST-HOC DESCRIPTIVE; not a test; D only')
    r['auc'] = {m: FL.boot(y, o.mean(0), g, a.nb)['auc'] for m, o in oof.items()}
    r['delta'] = {}
    for x, z in pairs:
        d = R.delta([x], [z]); d.pop('per_repeat'); r['delta'][f'{z} vs {x}'] = d
    cov = {}
    for b in list(BLOCKS) + ['any_history']:
        h = X.ft8x_any_history.values > 0 if b == 'any_history' else block_has(X, b)
        cov[b] = dict(n=int(h.sum()), conv=int(h[y == 1].sum()), conv_share=float(h[y == 1].mean()),
                      nonconv=int(h[y == 0].sum()), nonconv_share=float(h[y == 0].mean()))
    r['coverage'] = cov
    r['oof'] = {'episode_id': list(map(str, Dz.ids)), 'y': y.tolist(), 'cluster': list(map(str, g)),
                'by_model_repeat': {m: o.round(6).tolist() for m, o in oof.items()}}
    os.makedirs(a.out, exist_ok=True); p = f'{a.out}/blocks_{a.lab}.json'
    with open(p, 'w') as fh: json.dump(r, fh, default=float)
    print('wrote', p, f'{round(time.time() - t0)}s', flush=True)


if __name__ == '__main__':
    main()
