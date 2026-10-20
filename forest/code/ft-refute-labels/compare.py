import pandas as pd, numpy as np, datetime as dt
P='~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'
LAB=['prescription_uid','episode_id','cluster_key','split','h14','h90','days_to_surgery','event_date','anchor_excl']
L=pd.read_parquet(P,columns=LAB)
E=pd.read_pickle('work/mine.pkl'); rx=pd.read_pickle('work/rx.pkl')
print('parquet rows',len(L),'uniq rx',L.prescription_uid.nunique(),'uniq episode_id',L.episode_id.nunique())
j=E.merge(L,on='prescription_uid',how='outer',suffixes=('_m','_t'),indicator=True)
print('join',j._merge.value_counts().to_dict())
b=j[j._merge=='both']
def eq(a,c): 
    a=a.where(a.notna(),None).astype(object); c=c.where(c.notna(),None).astype(object)
    return [(x==y) or (x is None and y is None) for x,y in zip(a,c)]
mm={}
for col in ['cluster_key','split','h14','h90','days_to_surgery','event_date','anchor_excl']:
    a=b[col+'_m']; t=b[col+'_t']
    if col=='event_date': t=t.where(t.notna(),None).map(lambda v: None if v in (None,'','NaT','None') else str(v)[:10])
    mm[col]=int(len(b)-sum(eq(a,t)))
print('label mismatches (all rows)',mm)
# D-only extra columns
D=pd.read_parquet(P,filters=[('split','==','D')])
assert set(D.split)=={'D'}
jd=E[E.split=='D'].merge(D,on='prescription_uid',suffixes=('_m','_t'))
md={}
md['consult_uid(10.tsv)']=int((jd.consult_uid_m!=jd.consult_uid_t).sum()); md['consult_uid(s5)']=int((jd.consult_uid_s5!=jd.consult_uid_t).sum())
md['consult_ist']=int((jd.consult_ist_m!=jd.consult_ist_t).sum())
md['rx_date']=int((pd.to_datetime(jd.rx_date_m).dt.date!=pd.to_datetime(jd.rx_date_t).dt.date).sum())
md['age_days']=int((jd.age_days_m!=jd.age_days_t).sum()); md['n_rx_cluster']=int((jd.n_rx_cluster_m!=jd.n_rx_cluster_t).sum())
md['doctor_id vs s5 doctor_uid']=int((jd.doctor_uid!=jd.doctor_id).sum())
print('D rows',len(jd),'D-only col mismatches',md, 'specialty null',int(D.specialty.isna().sum()))
print('dtypes h14',L.h14.dtype, 'h14 values',L.h14.value_counts(dropna=False).to_dict())
