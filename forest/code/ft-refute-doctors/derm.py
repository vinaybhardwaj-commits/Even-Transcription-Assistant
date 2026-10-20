import pandas as pd, numpy as np, collections, re
rx=pd.read_pickle('rxD.pkl'); E=pd.read_pickle('mineD.pkl')
sp=pd.read_csv('~/oc/forest-lead/ft/doctor_specialty.tsv',sep='\t',dtype=str); m=dict(sp.values)
rx['spec']=rx.doctor_uid.map(m); E['spec']=E.doctor_uid.map(m)
for h in ['h14','h90']:
    x=E[(E.spec=='Dermatology')&E[h].notna()]; print(h,'derm eps',len(x),'pos',int(x[h].sum()),'docs',x.doctor_uid.nunique(),'anchor_excl',x.anchor_excl.value_counts(dropna=False).to_dict())
r=rx[rx.spec=='Dermatology']
print('derm D Rx',len(r),'with any event',r.ev.notna().sum(),'excl among events',r.excl.value_counts(dropna=False).to_dict())
print('flag_proc_names top (counts):'); print(collections.Counter(r.flag_proc.str.lower().str.strip()).most_common(15))
# which raw S5 fields fire for derm Rx
import sys,glob; sys.path.insert(0,'~/oc/forest-lead/ft'); from ftio import read_export
s5={}
for f in sorted(glob.glob('~/eta-data/forest/funnel/s5-clean/f1-s5-*.tsv')):
    for q in read_export(f): s5.setdefault(q['prescription_uid'],q)
nz=lambda v: v not in ('',None,'None','NULL')
R=pd.DataFrame([s5[u] for u in r.prescription_uid])
for c in ['first_ot_date','first_bill_date','first_adm_date']: print(c,'nonempty',R[c].map(nz).sum())
sameday=(R.first_bill_date.str[:10]==R.consult_ist.str[:10]); print('bill same day as consult',int(sameday.sum()))
print('bill items among derm with bill (top):',collections.Counter(R.first_bill_items[R.first_bill_date.map(nz)].str.lower().str[:40]).most_common(10))
print('adm types',R.first_adm_type.value_counts().to_dict())
# compare other specialties: share with any event
for s in ['General Surgery','Gynaecology','Orthopaedics','Urology','Dermatology','ENT']:
    q=rx[rx.spec==s]; print(s,'Rx',len(q),'any event %.2f'%q.ev.notna().mean(),'excl R2 %d'%(q.excl=='R2').sum())
