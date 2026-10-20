# FT2 labels (ft-labels-base, 19 Oct 2026). Episode logic = forest-lead f1_recompute.py / ft1_timing.py (p3a rules R1/R2/R4), READ 2026-10-19.
# Episode: positive = (cluster, first event date) anchored at the earliest flagged Rx leading to it; negative = cluster with no positive
# episode anywhere, anchored at its first flagged Rx. h14 NaN if Rx < 18 d old (14 d + 4 d billing lag, forest-lead ruling 19 Oct); h90 NaN if Rx < 94 d old (FT1 maturity rule).
# H rows are labelled only (split column); no features are read for them here.
import csv,datetime as dt,os,sys,glob,collections,hashlib
import pandas as pd, numpy as np
H=os.path.expanduser; sys.path.insert(0,H('~/oc/forest-lead/ft')); import ftio
READ=dt.date(2026,10,19)
exec(open(H('~/oc/forest-lead/ft/ft1_timing.py')).read().split("rows={}")[0])  # R1 R2 R4 nz pk cl spec
rows={}
for f in sorted(glob.glob(H('~/wt/forest-funnel-join/.bc/out/f1-s5-*.tsv'))):
    for r in ftio.read_export(f): rows.setdefault(r['prescription_uid'],r)
lock={}
for r in csv.reader(open(H('~/eta-data/forest/split/lock-2026-10-18.tsv')),delimiter='\t'):
    if len(r)>=2 and r[1] in ('H','D'): lock[r[0]]=r[1]
out=[]
for r in rows.values():
    d=dt.date.fromisoformat(r['consult_ist'][:10])
    if d<dt.date(2025,12,1): continue
    k=pk[r['prescription_uid']]; c=cl.get(k,k)
    ds=[r[x] for x in ('first_ot_date','first_bill_date') if nz(r[x])]; ev=min(ds)[:10] if ds else None
    name=(r['first_surgery_name'] or '')+' | '+(r['first_bill_items'] or ''); ex=None
    if ev:
        if R1.search(name) or r['first_adm_type']=='Maternity': ex='R1'
        elif R4.search(name): ex='R4'
        elif R2.search(r['first_surgery_name'] or '') or (r['first_bill_date'][:10]==r['consult_ist'][:10] if nz(r['first_bill_date']) else False) and not nz(r['first_ot_date']) and (r['first_adm_date'] or '')[:10]!=r['consult_ist'][:10]: ex='R2'
    out.append(dict(r=r,d=d,ev=ev,ex=ex,c=c))
out.sort(key=lambda o:(o['d'],o['r']['consult_ist'],o['r']['prescription_uid']))
pos={}
for o in out:
    if o['ev'] and not o['ex']: pos.setdefault((o['c'],o['ev']),o)
poscl={k[0] for k in pos}
neg={}
for o in out:
    if o['c'] not in poscl: neg.setdefault(o['c'],o)
nrx=collections.Counter(o['c'] for o in out)
cu={r['prescription_uid']:r['consult_uid'] for r in csv.DictReader(open(H('~/eta-data/forest/split-input/10.tsv')),delimiter='\t')}  # consult_uid source per forest-lead ruling
recs=[]
for kind,dd in (('pos',pos),('neg',neg)):
    for key,o in dd.items():
        r=o['r']; el=(READ-o['d']).days
        lag=(dt.date.fromisoformat(o['ev'])-o['d']).days if kind=='pos' else np.nan
        h90=np.nan if el<94 else float(kind=='pos' and lag<=90)
        h14=np.nan if el<18 else float(kind=='pos' and lag<=14)
        eid=hashlib.sha256(f"{o['c']}|{o['ev'] or 'neg'}".encode()).hexdigest()[:16]
        recs.append(dict(episode_id=eid,prescription_uid=r['prescription_uid'],consult_uid=cu.get(r['prescription_uid']) or None,cluster_key=o['c'],
            rx_date=pd.Timestamp(o['d']),consult_ist=r['consult_ist'],doctor_id=r['doctor_uid'],specialty=spec.get(r['doctor_uid'],'unknown'),
            split=lock.get(o['c'],'?'),age_days=el,h14=h14,h90=h90,days_to_surgery=lag,event_date=o['ev'] if kind=='pos' else None,
            anchor_excl=o['ex'],n_rx_cluster=nrx[o['c']]))
print('consult_uid differs 10.tsv vs s5 (all flagged Rx since Dec):',sum(cu.get(o['r']['prescription_uid'])!=o['r']['consult_uid'] for o in out),'| among episode anchors:',sum(cu.get(x['prescription_uid'])!=s5c for x,s5c in [(x,rows[x['prescription_uid']]['consult_uid']) for x in recs]))
df=pd.DataFrame(recs).sort_values(['rx_date','prescription_uid']).reset_index(drop=True)
od=H('~/oc/forest-lead/ft/out/ft-labels-base'); df.to_parquet(f'{od}/labels.parquet',index=False)
# reconciliation (counts only)
m=df[df.age_days>=94]
print('rx_since_dec',len(out),'episodes',len(df),'pos',int((df.event_date.notna()).sum()),'split',df.split.value_counts().to_dict())
print('matured_rx(FT1)',sum((READ-o['d']).days>=94 for o in out),'matured_episodes',len(m),'h90_pos',int(m.h90.sum()),'max_lag',df.days_to_surgery.max())
print('h14 labelled',int(df.h14.notna().sum()),'h14_pos',int(df.h14.sum()),'| among matured: h14_pos',int(m.h14.sum()),'h90_pos_lag>14',int(((m.h90==1)&(m.days_to_surgery>14)).sum()))
for s in ('D','H'):
    x=df[df.split==s]; xm=x[x.age_days>=94]
    print(s,'episodes',len(x),'h14_n',int(x.h14.notna().sum()),'h14_pos',int(x.h14.sum()),'h90_n',int(x.h90.notna().sum()),'h90_pos',int(x.h90.sum()))
