import json, os, numpy as np, sys
sys.path.insert(0, os.path.expanduser('~/wt/ft-forest/code')); sys.dont_write_bytecode=True
import forest_lib as FL
D = os.path.expanduser('~/oc/forest-lead/ft/out/ft8-blocks')
for l in ['h14','h90','ale']:
    r = json.load(open(f'{D}/blocks_{l}.json')); v = json.load(open(f'{D}/v1/blocks_{l}.json'))
    shared = set(r['delta']) & set(v['delta']); diff = [k for k in shared if r['delta'][k] != {kk: vv for kk, vv in v['delta'][k].items()}]
    om = r['oof']['by_model_repeat']; ov = v['oof']['by_model_repeat']
    od = max(np.abs(np.array(om[m]) - np.array(ov[m])).max() for m in ov)
    print(l, 'v1 delta keys', len(v['delta']), 'shared', len(shared), 'differ', diff, 'max oof diff', od, 'v1 models', len(ov))
    # independent recompute of 3 deltas
    y = np.array(r['y'] if 'y' in r else r['oof']['y']); g = np.array(r['oof']['cluster'])
    for k in ['M1 vs M0', 'M0+labs vs M0', 'M1 vs M0+ft8_shuffled']:
        z, x = k.split(' vs ')
        d = FL.boot_delta(y, np.array(om[x]).mean(0), np.array(om[z]).mean(0), g, 1000)
        j = r['delta'][k]; print('  ', k, round(d['delta'],4), [round(c,4) for c in d['ci']], round(d['p_boot_le0'],3), '| json', round(j['delta'],4), [round(c,4) for c in j['ci']], j['draws'])
    print('  models', r['models'], 'reps', r['reps'], 'clusters', r['clusters'])
