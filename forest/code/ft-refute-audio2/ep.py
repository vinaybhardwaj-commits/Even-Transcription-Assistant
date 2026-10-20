"""ft-refute-audio2: episodes from raw (s5-clean + 10.tsv), split_guard, recorded anchors. Opus 5.5."""
import sys,glob,re,datetime as dt,collections,json,os
sys.path.insert(0,'~/oc/forest-lead/ft'); sys.path.insert(0,'~/wt/forest-rd0/studies/2026-10-16-runo-linkage/split')
from ftio import read_export
import split_guard, pandas as pd, numpy as np
R1=re.compile(r'LSCS|caesarean|cesarean|vaginal delivery|\bNVD\b|delivery|cerclage|evacuation|ERPC|RPOC|abortion|products of conception|MTP',re.I)
R2=re.compile(r'dressing|injection|suture removal|I ?& ?D under LA|wart|foreign body',re.I)
R4=re.compile(r'stent removal|removal of .*stent|DJ stent|check URS|re-?look|implant removal|second stage',re.I)
nz=lambda v: v not in ('',None,'None','NULL')
READ=dt.date(2026,10,19)
recs=[]
for f in sorted(glob.glob('~/eta-data/forest/funnel/s5-clean/f1-s5-*.tsv')):
    e=read_export(f); assert e.bad==0; recs+=e
s5={}
for r in recs: s5.setdefault(r['prescription_uid'],r)
co=pd.read_csv('~/eta-data/forest/split-input/10.tsv',sep='\t',dtype=str)
print('10.tsv',len(co),co.flagged.value_counts().to_dict(),'in s5',co.prescription_uid.isin(s5).sum(),'s5',len(s5))
cl=dict(pd.read_csv('~/eta-data/forest/split/clusters-2026-10-18.tsv',sep='\t',dtype=str).values)
g=split_guard.load('~/eta-data/forest/split',pinned_list_sha256='52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65')
assert g.seed_sha256=='3b10cbf1f278ba072bded2e2bf0293a59035bc940f71ed5407b1a07509fbe750'
rows=[]
for _,c in co.iterrows():
    r=s5.get(c.prescription_uid)
    if r is None: continue
    d=dt.date.fromisoformat(c.consult_ist[:10])
    ds=[r[k] for k in ('first_ot_date','first_bill_date') if nz(r[k])]
    ev=min(ds)[:10] if ds else None
    name=(r['first_surgery_name'] or '')+' | '+(r['first_bill_items'] or '')
    excl=None
    if ev:
        if R1.search(name) or r['first_adm_type']=='Maternity': excl='R1'
        elif R4.search(name): excl='R4'
        elif R2.search(r['first_surgery_name'] or '') or (r['first_bill_date'][:10]==r['consult_ist'][:10] if nz(r['first_bill_date']) else False) and not nz(r['first_ot_date']) and (r['first_adm_date'] or '')[:10]!=r['consult_ist'][:10]: excl='R2'
    ck=cl.get(c.patient_key,c.patient_key)
    rows.append(dict(rxu=c.prescription_uid,cu=c.consult_uid,ck=ck,pk=c.patient_key,ts=c.consult_ist,d=d,split=g.set_of(ck),age=(READ-d).days,ev=ev,excl=excl,doc=r['doctor_uid']))
rx=pd.DataFrame(rows).sort_values(['ts','rxu']).reset_index(drop=True)
print('Rx',len(rx),rx.split.value_counts().to_dict())
eps={}
for o in rx.itertuples():
    if o.ev and not o.excl and o.ev>=str(o.d):
        eps.setdefault((o.ck,o.ev),o)
poscl={k[0] for k in eps}
out=[dict(o._asdict(),event=o.ev) for o in eps.values()]
for ck,gr in rx.groupby('ck'):
    if ck in poscl: continue
    out.append(dict(gr.iloc[0].to_dict(),event=None))
E=pd.DataFrame(out).drop(columns=['Index'],errors='ignore')
E['lag']=[(dt.date.fromisoformat(e)-d).days if e else np.nan for e,d in zip(E.event,E.d)]
E['ale']=np.where(E.event.notna(),1.0,np.where(E.age>=14,0.0,np.nan))
E['h14']=np.where(E.age<14,np.nan,(E.lag<=14).astype(float))  # placeholder; final h14 at >=18 below
E['h14f']=np.where(E.age<18,np.nan,(E.lag<=14).astype(float))
tx=set(l.strip() for l in open('~/eta-data/forest/funnel/transcripts-2026-10-19.txt') if l.strip())
E['rec']=E.cu.isin(tx)
S=E[(E.split=='D')&(E.d>=dt.date(2026,9,9))]
print('D eps since 9 Sep',len(S),'h14f n/pos',S.h14f.notna().sum(),int(S.h14f.sum()),'ale n/pos',S.ale.notna().sum(),int(S.ale.sum()),'recorded',S.rec.sum())
R=S[S.rec]; print('recorded anchors',len(R),'h14f>=18 n/pos',R.h14f.notna().sum(),int(R.h14f.sum()),'ale n/pos',R.ale.notna().sum(),int(R.ale.sum()),'docs',R.doc.nunique())
print('H eps since 9 Sep (count only)',((E.split=='H')&(E.d>=dt.date(2026,9,9))).sum())
E[E.split=='D'].to_pickle('epsD.pkl'); rx[rx.split=='D'].to_pickle('rxD.pkl'); os.chmod('epsD.pkl',0o600); os.chmod('rxD.pkl',0o600)
