"""Independent FT2 label recompute (ft-refute-labels, Opus 5.5). Rules from p3a_counts.py (imported regexes would run module code, so copied verbatim and sha-checked)."""
import sys,glob,re,hashlib,datetime as dt,collections
sys.path.insert(0,'~/oc/forest-lead/ft'); sys.path.insert(0,'~/wt/forest-rd0/studies/2026-10-16-runo-linkage/split')
from ftio import read_export
import split_guard
import pandas as pd, numpy as np
src=open('~/oc/convert-lead/p3a_counts.py').read()
assert hashlib.sha256(src.encode()).hexdigest().startswith('490f5dc17bd3')
R1=re.compile(r'LSCS|caesarean|cesarean|vaginal delivery|\bNVD\b|delivery|cerclage|evacuation|ERPC|RPOC|abortion|products of conception|MTP',re.I)
R2=re.compile(r'dressing|injection|suture removal|I ?& ?D under LA|wart|foreign body',re.I)
R4=re.compile(r'stent removal|removal of .*stent|DJ stent|check URS|re-?look|implant removal|second stage',re.I)
for name,rx in (('R1',R1),('R2',R2),('R4',R4)):
    assert f"{name}=re.compile(r'{rx.pattern}',re.I)" in src, name
nz=lambda v: v not in ('',None,'None','NULL')
READ=dt.date(2026,10,19)
recs=[]
for f in sorted(glob.glob('~/eta-data/forest/funnel/s5-clean/f1-s5-*.tsv')):
    e=read_export(f); assert e.bad==0; recs+=e
s5={}
for r in recs: s5.setdefault(r['prescription_uid'],r)
co=pd.read_csv('~/eta-data/forest/split-input/10.tsv',sep='\t',dtype=str)
cl=dict(pd.read_csv('~/eta-data/forest/split/clusters-2026-10-18.tsv',sep='\t',dtype=str).values)
g=split_guard.load('~/eta-data/forest/split',pinned_list_sha256='52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65')
assert g.seed_sha256=='3b10cbf1f278ba072bded2e2bf0293a59035bc940f71ed5407b1a07509fbe750'
rows=[]; splitdis=0
for _,c in co.iterrows():
    r=s5[c.prescription_uid]; d=dt.date.fromisoformat(c.consult_ist[:10])
    ds=[r[k] for k in ('first_ot_date','first_bill_date') if nz(r[k])]
    ev=min(ds)[:10] if ds else None
    name=(r['first_surgery_name'] or '')+' | '+(r['first_bill_items'] or '')
    excl=None
    if ev:
        if R1.search(name) or r['first_adm_type']=='Maternity': excl='R1'
        elif R4.search(name): excl='R4'
        elif R2.search(r['first_surgery_name'] or '') or (r['first_bill_date'][:10]==r['consult_ist'][:10] if nz(r['first_bill_date']) else False) and not nz(r['first_ot_date']) and (r['first_adm_date'] or '')[:10]!=r['consult_ist'][:10]: excl='R2'
    ck=cl[c.patient_key]; sp=g.set_of(c.patient_key)
    if g.set_of(ck)!=sp: splitdis+=1
    rows.append(dict(prescription_uid=c.prescription_uid,consult_uid=c.consult_uid,consult_uid_s5=r['consult_uid'],cluster_key=ck,patient_key=c.patient_key,
        consult_ist=c.consult_ist,rx_date=d,split=sp,age_days=(READ-d).days,ev=ev,excl=excl,doctor_uid=r['doctor_uid']))
rx=pd.DataFrame(rows).sort_values(['consult_ist','prescription_uid']).reset_index(drop=True)
print('Rx',len(rx),'from 2025-12-01',(rx.rx_date>=dt.date(2025,12,1)).sum(),'split dis (patient vs cluster key)',splitdis)
print('Rx per split',rx.split.value_counts().to_dict(),'cluster straddle',(rx.groupby('cluster_key').split.nunique()>1).sum())
print('excl',rx.excl.value_counts(dropna=False).to_dict(),'ev before rx',(rx.ev.notna()&(rx.ev<rx.rx_date.astype(str))).sum())
# episodes
eps={}
for o in rx.itertuples():
    if o.ev and not o.excl:
        k=(o.cluster_key,o.ev)
        if k not in eps: eps[k]=o
pos_clusters={k[0] for k in eps}
out=[]
for k,o in eps.items(): out.append(dict(o._asdict(),event_date=o.ev,anchor_excl=None))
for ck,gr in rx.groupby('cluster_key'):
    if ck in pos_clusters: continue
    o=gr.iloc[0]; out.append(dict(o.to_dict(),event_date=None,anchor_excl=o.excl))
E=pd.DataFrame(out)
nrx=rx.groupby('cluster_key').size(); E['n_rx_cluster']=E.cluster_key.map(nrx)
E['days_to_surgery']=[(dt.date.fromisoformat(e)-d).days if e else np.nan for e,d in zip(E.event_date,E.rx_date)]
lag=E.days_to_surgery
E['h14']=np.where(E.age_days<14,np.nan,(lag<=14).astype(float))
E['h90']=np.where(E.age_days<94,np.nan,(lag<=90).astype(float))
E.to_pickle('work/mine.pkl'); rx.to_pickle('work/rx.pkl')
print('episodes',len(E),E.split.value_counts().to_dict(),'attributable',E.event_date.notna().sum(),'max lag',lag.max(),'min lag',lag.min())
mat=E[E.age_days>=94]; print('matured eps',len(mat),'h90 pos',int(mat.h90.sum()),'h14 pos among those',int(((mat.h90==1)&(mat.days_to_surgery<=14)).sum()),'later',int(((mat.h90==1)&(mat.days_to_surgery>14)).sum()))
print('matured Rx',(rx.age_days>=94).sum())
for s in 'DH':
    x=E[E.split==s]; print(s,'h14 n/pos',x.h14.notna().sum(),int(x.h14.sum()),'h90 n/pos',x.h90.notna().sum(),int(x.h90.sum()))
print('neg eps with anchor_excl',E.anchor_excl.value_counts().to_dict())
print('clusters with >1 episode',(E.groupby('cluster_key').size()>1).sum(), 'positive eps per cluster max',E[E.event_date.notna()].groupby('cluster_key').size().max())
print('h14 pos lag in [0,14]; exact 14',(lag==14).sum(),'lag 15..18',((lag>14)&(lag<=18)).sum(), 'age 14..17 with pos',((E.age_days>=14)&(E.age_days<18)).sum())
