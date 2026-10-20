# ft-refute-whoconverts: compare own h14 recompute (r1_desc.json) with target desc.json on the rows the brief names.
import os, json, numpy as np
H = os.path.expanduser; O = H('~/oc/forest-lead/ft/out')
me = json.load(open(f'{O}/ft-refute-whoconverts/r1_desc.json')); tg = json.load(open(f'{O}/ft-whoconverts/desc.json'))['res']
for lab in ('h14', 'h90', 'ale'):
    m = me[lab]; t = tg[lab]
    print(lab, 'n', m['n'], t['n'], 'tests', m['n_tests'], t['n_tests'], 'flags', m['n_flag'], t['n_flag'])
    # sorted q-vectors (BH set equivalence)
    qm = sorted(r['q'] for r in m['rows'] if r['q'] == r['q']); qt = sorted(r['q'] for r in t['rows'] if r['q'] == r['q'])
    d = np.abs(np.array(qm) - np.array(qt)) if len(qm) == len(qt) else None
    print('  sorted-q max abs diff', None if d is None else round(float(d.max()), 4), '(doctor test is a permutation: small diffs expected)')
pick = {'specialty': None, 'proc': None, 'docgender': None, 'zone': None, 'newret': None, 'hist:ft8_obesity': None, 'hist:ft8_has_egfr': None,
        'histret:ft8_obesity': None, 'histret:ft8_has_egfr': None, 'histret:ft8_has_creat': None, 'calls:ncalls': None, 'doctor': None}
for r in me['h14']['rows']:
    if r['fam'] in pick and (r['n'] >= 10):
        print(f"{r['fam']:22s} {str(r['level'])[:22]:22s} n={r['n']:4d} k={r['k']:3d} rate={r.get('rate', 0):.3f} q={r['q']:.3f} mh={r.get('mh')}")
for r in tg['h14']['rows']:
    if r['char'] in ('Doctor (within specialty)',): print('target doctor p', r['p'], 'q', r['q'])
