# ft-refute-whoconverts: day-7 call table, h14, with and without the outcome-revealing calls (call made = an event, whatever was said). D only.
import os, sys, json
sys.dont_write_bytecode = True; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import warnings; warnings.simplefilter('ignore')
import numpy as np, pandas as pd
from r1_desc import lm7_calls, family, OUT, O
from statsmodels.stats.multitest import multipletests

R = {}
for keep in ('0', '1'):
    os.environ['KEEP_LEAK'] = keep
    X, y, cc, li = lm7_calls('h14'); out = []
    sb = X.specialty.value_counts(); sg = X.specialty.where(X.specialty.isin(sb[sb >= 20].index), 'other').values
    for k, v in cc.items(): family(v, y, k, out, sg)
    R['with_leak_calls' if keep == '1' else 'as_target'] = out
# rows whose pre-day-7 calls were all outcome-revealing (counted as "no call" by the target)
os.environ['KEEP_LEAK'] = '0'; X, y, cc0, _ = lm7_calls('h14'); os.environ['KEEP_LEAK'] = '1'; _, _, cc1, _ = lm7_calls('h14')
m = (cc0['ncalls'] == '0') & (cc1['ncalls'] != '0')
R['nocall_rows_that_had_only_leak_calls'] = dict(rows=int(m.sum()), pos=int(y[m].sum()))
R['nocall_target'] = dict(rows=int((cc0['ncalls'] == '0').sum()), pos=int(y[cc0['ncalls'] == '0'].sum()))
R['nocall_with_leak'] = dict(rows=int((cc1['ncalls'] == '0').sum()), pos=int(y[cc1['ncalls'] == '0'].sum()))
os.umask(0o077); json.dump(R, open(f'{OUT}/r3_calls.json', 'w'), default=float, indent=0)
for k, v in R.items(): print(k, v if isinstance(v, dict) else '\n' + '\n'.join(f"  {r['fam']:10s} {r['level']:5s} n={r['n']} k={r['k']} rate={r['rate']} p={r['p']:.3g} mh={r.get('mh')}" for r in v))
