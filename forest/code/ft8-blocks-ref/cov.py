import json, os, numpy as np, pandas as pd, sys
sys.dont_write_bytecode=True; sys.path.insert(0, os.path.expanduser('~/oc/forest-lead/ft/out/ft8-blocks/code'))
D = os.path.expanduser('~/oc/forest-lead/ft/out')
F8 = pd.read_parquet(f'{D}/ft8-clinical/features_ft8.parquet').set_index('episode_id')
for l in ['h14','h90','ale']:
    r = json.load(open(f'{D}/ft8-blocks/blocks_{l}.json')); ids = r['oof']['episode_id']; y = np.array(r['oof']['y'])
    X = F8.loc[ids]; BL = r['blocks']; c8 = [c for b in BL.values() for c in b]
    hb = {}
    for b, cs in BL.items():
        hb[b] = (X.ft8_n_ip_events_pre.fillna(0) > 0).values if b == 'admissions' else (X[[c for c in cs if c.startswith('ft8_has_')]].fillna(0) > 0).any(axis=1).values
    hb['any_history'] = np.column_stack(list(hb.values())).any(axis=1)
    bad = [b for b in hb if (int(hb[b][y==1].sum()), int(hb[b][y==0].sum())) != (r['coverage'][b]['conv'], r['coverage'][b]['nonconv'])]
    nonflag = [c for c in c8 if not c.startswith('ft8_has_')]
    na = X[nonflag].isna().mean()
    print(l, 'coverage mismatches', bad, '| L1 has_ any', int((X[[c for c in c8 if c.startswith('ft8_has_')]] > 0).any(axis=1).sum()),
          '| NaN share non-flag cols: median %.2f min %.2f max %.2f; cols >50%% NaN: %d/%d' % (na.median(), na.min(), na.max(), (na > .5).sum(), len(nonflag)),
          '| any NaN in 42 (cell share) %.2f' % X[c8].isna().values.mean(), '| has_prior_rx conv/non %.2f/%.2f' % (X.ft8_has_prior_rx[y==1].mean(), X.ft8_has_prior_rx[y==0].mean()))
