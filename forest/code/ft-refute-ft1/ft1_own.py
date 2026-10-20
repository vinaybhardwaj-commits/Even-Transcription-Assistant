"""Independent FT1 timing recompute (ft-refute-ft1). Own code; lane ft1_timing.py not read.
Inputs read-only. Prints counts only (no ids)."""
import csv, glob, re, sys, hashlib, math, collections, datetime as dt
import pandas as pd

H = '~'
assert hashlib.sha256(open(f'{H}/oc/convert-lead/p3a_counts.py','rb').read()).hexdigest().startswith('490f5dc17bd3')
R1=re.compile(r'LSCS|caesarean|cesarean|vaginal delivery|\bNVD\b|delivery|cerclage|evacuation|ERPC|RPOC|abortion|products of conception|MTP',re.I)
R2=re.compile(r'dressing|injection|suture removal|I ?& ?D under LA|wart|foreign body',re.I)
R4=re.compile(r'stent removal|removal of .*stent|DJ stent|check URS|re-?look|implant removal|second stage',re.I)
READ = dt.date(2026,10,19)
nz = lambda v: v not in ('', None, 'None', 'NULL')

def tsv(p):
    with open(p, newline='') as f:
        return list(csv.DictReader(f, delimiter='\t', quoting=csv.QUOTE_NONE))

k10 = {r['prescription_uid']: r for r in tsv(f'{H}/eta-data/forest/split-input/10.tsv')}
s5raw = [r for p in sorted(glob.glob(f'{H}/eta-data/forest/funnel/s5-clean/f1-s5-*.tsv')) for r in tsv(p)]
s5 = {}
for r in s5raw:
    t = tuple((a,b) for a,b in r.items() if a!='flag_proc_names')
    if r['prescription_uid'] in s5: assert tuple((a,b) for a,b in s5[r['prescription_uid']].items() if a!='flag_proc_names') == t
    s5[r['prescription_uid']] = r
clus = {r['patient_key']: r['cluster_key'] for r in tsv(f'{H}/eta-data/forest/split/clusters-2026-10-18.tsv')}
split = dict(l.rstrip('\n').split('\t') for l in open(f'{H}/eta-data/forest/split/lock-2026-10-18.tsv'))
spec = {r['doctor_uid']: r['specialty'] for r in tsv(f'{H}/oc/forest-lead/ft/doctor_specialty.tsv')}
print('10.tsv', len(k10), 'flagged', sum(r['flagged']=='true' for r in k10.values()), '| s5 raw', len(s5raw), 'dedup', len(s5),
      '| joined', len(set(k10)&set(s5)), '| consult_ist agree', sum(k10[u]['consult_ist']==s5[u]['consult_ist'] for u in k10 if u in s5))

rx = []
for u, k in k10.items():
    r = s5[u]
    d = dt.date.fromisoformat(r['consult_ist'][:10])
    ds = [r[c][:10] for c in ('first_ot_date','first_bill_date') if nz(r[c])]
    ev = min(ds) if ds else None
    name = (r['first_surgery_name'] or '') + ' | ' + (r['first_bill_items'] or '')
    excl = None
    if ev:
        if R1.search(name) or r['first_adm_type']=='Maternity': excl='R1'
        elif R4.search(name): excl='R4'
        elif R2.search(r['first_surgery_name'] or '') or ((r['first_bill_date'][:10]==r['consult_ist'][:10]) if nz(r['first_bill_date']) else False) and not nz(r['first_ot_date']) and (r['first_adm_date'] or '')[:10]!=r['consult_ist'][:10]: excl='R2'
    ck = clus[k['patient_key']]
    rx.append(dict(u=u, ist=r['consult_ist'], d=d, ev=ev, excl=excl, ck=ck, split=split[ck],
                   doc=r['doctor_uid'], spec=spec.get(r['doctor_uid'], 'UNMAPPED'), age=(READ-d).days,
                   pgrp_eq=(r['patient_grp']==k['patient_key'])))
print('Rx', len(rx), 'patient_grp==patient_key', sum(o['pgrp_eq'] for o in rx), 'unmapped specialty', sum(o['spec']=='UNMAPPED' for o in rx))

rx.sort(key=lambda o: (o['ist'], o['u']))
eps = {}          # (ck, ev) -> anchor rx
for o in rx:
    if o['ev'] and not o['excl']:
        eps.setdefault((o['ck'], o['ev']), o)
pos_ck = {k[0] for k in eps}
neg = {}
for o in rx:
    if o['ck'] not in pos_ck: neg.setdefault(o['ck'], o)
print('episodes', len(eps)+len(neg), 'pos', len(eps), 'neg', len(neg))

mat = lambda o: o['age'] >= 94
M_rx = [o for o in rx if mat(o)]
M_pos = [(k, o) for k, o in eps.items() if mat(o)]
M_neg = [o for o in neg.values() if mat(o)]
lag = lambda k, o: (dt.date.fromisoformat(k[1]) - o['d']).days
print('matured cutoff rx_date <=', READ - dt.timedelta(days=94), '| date range', min(o['d'] for o in M_rx), max(o['d'] for o in M_rx))
print('MATURED Rx', len(M_rx), 'episodes', len(M_pos)+len(M_neg), 'pos', len(M_pos), 'neg', len(M_neg),
      '| min/max lag', min(lag(*p) for p in M_pos), max(lag(*p) for p in M_pos), '| lag>90', sum(lag(*p)>90 for p in M_pos))

# reconcile 978 Rx -> 883 episodes
anch = {id(o) for _, o in M_pos} | {id(o) for o in M_neg}
na = [o for o in M_rx if id(o) not in anch]
pos_anchor_ids = {id(o) for o in eps.values()}
c = collections.Counter()
for o in na:
    if o['ck'] in pos_ck:
        if o['ev'] and o['excl']: c['nonanchor_in_pos_cluster_excluded_event']+=1
        elif o['ev']: c['nonanchor_in_pos_cluster_same_episode_as_earlier_rx']+=1
        else: c['nonanchor_in_pos_cluster_no_event']+=1
    else: c['nonanchor_later_rx_in_neg_cluster']+=1
print('non-anchor matured Rx', len(na), dict(c))
# anchors of positive episodes counted once per anchor Rx? one Rx anchoring >1 episode?
ac = collections.Counter(id(o) for _, o in M_pos); print('Rx anchoring >1 matured pos episode', sum(v>1 for v in ac.values()))
# positive matured episodes whose anchor Rx is matured but a later Rx (non-matured) is the one with event? n/a by construction
# immature Rx contributing events to matured-anchor episodes:
late = sum(1 for o in rx if o['ev'] and not o['excl'] and not mat(o) and (o['ck'],o['ev']) in eps and mat(eps[(o['ck'],o['ev'])]))
print('immature Rx whose event credited to matured anchor', late)

def wilson(x, n, z=1.959964):
    if n == 0: return (float('nan'),)*2
    p = x/n; den = 1+z*z/n; ctr = (p+z*z/(2*n))/den; h = z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return ctr-h, ctr+h

DAYS = (7, 14, 21, 30, 60, 90)
def table(title, sel):
    print(f'\n## {title}')
    print('group | matured Rx | matured episodes | pos eps | pos/Rx | pos/eps | median lag | ' + ' | '.join(f'd{d}' for d in DAYS) + ' | d14 Wilson95')
    groups = ['All', 'General Surgery', 'Orthopaedics', 'Gynaecology', 'Urology', 'Other']
    big = set(groups[1:5])
    g = lambda s: s if s in big else 'Other'
    for G in groups:
        f = (lambda o: True) if G=='All' else (lambda o, G=G: g(o['spec'])==G)
        nrx = sum(1 for o in M_rx if sel(o) and f(o))
        L = sorted(lag(k,o) for k,o in M_pos if sel(o) and f(o))
        ne = len(L) + sum(1 for o in M_neg if sel(o) and f(o))
        if not L: continue
        med = pd.Series(L).median()
        sh = [sum(x<=d for x in L) for d in DAYS]
        lo, hi = wilson(sh[1], len(L))
        print(f'{G} | {nrx} | {ne} | {len(L)} | {len(L)/nrx:.1%} | {len(L)/ne:.1%} | {med:g} | ' +
              ' | '.join(f'{s}={s/len(L):.1%}' for s in sh) + f' | {lo:.1%}-{hi:.1%}')
table('D+H combined (counts only)', lambda o: True)
table('D only', lambda o: o['split']=='D')
L = [lag(k,o) for k,o in M_pos]
print('\nafter d14:', sum(x>14 for x in L), 'of', len(L), '| lag==14:', sum(x==14 for x in L), '| lag==0:', sum(x==0 for x in L))
print('median lag all-pos (all ages, n=%d):' % len(eps), pd.Series([lag(k,o) for k,o in eps.items()]).median())
# Rx-level alternative: matured Rx with own non-excluded event within 90d
rxlvl = [o for o in M_rx if o['ev'] and not o['excl']]
print('Rx-level: matured Rx with own non-excl event', len(rxlvl), 'median', pd.Series([(dt.date.fromisoformat(o['ev'])-o['d']).days for o in rxlvl]).median(),
      'd14 share', f"{sum((dt.date.fromisoformat(o['ev'])-o['d']).days<=14 for o in rxlvl)/len(rxlvl):.1%}")
# specialty: per-month doctor->specialty is static; check doctors with >1 specialty impossible; check anchor specialty vs other Rx in same episode
mix = 0
for k, o in M_pos:
    ss = {x['spec'] for x in rx if x['ck']==k[0] and x['ev']==k[1] and not x['excl']}
    mix += len(ss) > 1
print('matured pos episodes whose contributing Rx span >1 specialty', mix)
print('specialty counts matured Rx:', collections.Counter(o['spec'] for o in M_rx).most_common(8))

# write episode list for comparison (local, 0600)
import os
rows = [dict(u=o['u'], ck=k[0], ev=k[1], lag=lag(k,o), spec=o['spec'], split=o['split']) for k,o in eps.items()] + \
       [dict(u=o['u'], ck=o['ck'], ev=None, lag=None, spec=o['spec'], split=o['split']) for o in neg.values()]
pd.DataFrame(rows).to_parquet('own_episodes.parquet'); os.chmod('own_episodes.parquet', 0o600)
