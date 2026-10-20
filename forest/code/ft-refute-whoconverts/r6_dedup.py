# ft-refute-whoconverts: BH with the duplicate tests removed (identical masks: proc none = n_procs 0; calls 0 = first call none; connected no = talk 0).
import os, json, numpy as np
from statsmodels.stats.multitest import multipletests
O = os.path.expanduser('~/oc/forest-lead/ft/out'); me = json.load(open(f'{O}/ft-refute-whoconverts/r1_desc.json'))
DUP = {('nprocs', '0'), ('calls:first', 'none'), ('calls:talk', '0')}
for lab in ('h14', 'h90', 'ale'):
    R = [r for r in me[lab]['rows'] if r['p'] == r['p']]
    keep = [r for r in R if (r['fam'], str(r['level'])) not in DUP]
    q = multipletests([r['p'] for r in keep], method='fdr_bh')[1]
    fl = [(r['fam'], r['level'], round(qq, 3)) for r, qq in zip(keep, q) if qq < 0.10]
    calls0 = [round(qq, 3) for r, qq in zip(keep, q) if r['fam'] == 'calls:ncalls' and str(r['level']) == '0']
    print(lab, 'tests', len(R), '->', len(keep), 'flags', me[lab]['n_flag'], '->', len(fl), 'calls0 q', calls0)
