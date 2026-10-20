# ref check: shuffled-FT8 control across extra permutation seeds (D only). Writes to ~/wt/ft8-blocks-ref/scratch only.
import os, sys, json
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.expanduser('~/wt/ft-forest/code'))
import warnings; warnings.simplefilter('ignore')
import numpy as np
import forest_lib as FL, forest_build as FB, forest_run as FR
lab = sys.argv[1]; seeds = [int(s) for s in sys.argv[2].split(',')]
B = json.load(open(os.path.expanduser(f'~/oc/forest-lead/ft/out/ft8-blocks/blocks_{lab}.json')))
Dz = FB.build('rx', lab, include_l8=False); X = Dz.DX; c8 = Dz.layers['L1']; L0 = Dz.layers['L0']
sets = {'M0': L0, 'M1': L0 + c8}
for s in seeds:
    pi = np.random.default_rng(s).permutation(len(X)); sh = [f'sh{s}_' + c[4:] for c in c8]
    X[sh] = X[c8].values[pi]; sets[f'S{s}'] = L0 + sh
Dz.layers = sets; R = FR.Runner(Dz, 1000)
R.cache[('M0',)] = np.array(B['oof']['by_model_repeat']['M0']); R.cache[('M1',)] = np.array(B['oof']['by_model_repeat']['M1'])
out = {}
for s in seeds:
    a = R.delta(['M0'], [f'S{s}']); b = R.delta([f'S{s}'], ['M1'])
    out[s] = dict(sh_vs_M0=[a['delta']] + a['ci'], M1_vs_sh=[b['delta']] + b['ci'])
    print(lab, s, out[s], flush=True)
json.dump(out, open(os.path.expanduser(f'~/wt/ft8-blocks-ref/scratch/shuf_{lab}.json'), 'w'))
