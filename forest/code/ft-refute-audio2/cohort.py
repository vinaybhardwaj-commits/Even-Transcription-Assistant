import sys,json,re,datetime as dt,os,collections
sys.path.insert(0,'~/oc/forest-lead/ft'); sys.path.insert(0,'~/wt/forest-rd0/studies/2026-10-16-runo-linkage/split')
from ftio import read_export
import split_guard,pandas as pd,numpy as np
g=split_guard.load('~/eta-data/forest/split',pinned_list_sha256='52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65')
assert g.seed_sha256=='3b10cbf1f278ba072bded2e2bf0293a59035bc940f71ed5407b1a07509fbe750'
R1=re.compile(r'LSCS|caesarean|cesarean|vaginal delivery|\bNVD\b|delivery|cerclage|evacuation|ERPC|RPOC|abortion|products of conception|MTP',re.I)
R2=re.compile(r'dressing|injection|suture removal|I ?& ?D under LA|wart|foreign body',re.I)
R4=re.compile(r'stent removal|removal of .*stent|DJ stent|check URS|re-?look|implant removal|second stage',re.I)
nz=lambda v: v not in ('',None,'None','NULL'); READ=dt.date(2026,10,19)
E=pd.read_pickle('epsD.pkl'); rx=pd.read_pickle('rxD.pkl')
FA=pd.read_parquet('~/oc/forest-lead/ft/out/ft-cohortb-expand/features_all.parquet')
anc=E[E.d>=dt.date(2026,9,9)].set_index('cu')
A=set(FA.consult_uid); print('features_all',len(A),'all are my D anchors since 9 Sep',len(A&set(anc.index)))
# ft-audio 125 from v1 refuter's own cohort.json (D after split_guard)
C=json.load(open('~/wt/ft-refute-audio/work/cohort.json')); D125=set(C['D'])
print('ft-audio D',len(D125),'overlap anchors',len(D125&A))
NA=D125-A; print('non-anchors',len(NA))
# patient keys / clusters
pk={}
for f in ('10b','10'):
    for r in pd.read_csv(f'~/eta-data/forest/split-input/{f}.tsv',sep='\t',dtype=str).itertuples(): pk.setdefault(r.consult_uid,set()).add(r.patient_key)
cl=dict(pd.read_csv('~/eta-data/forest/split/clusters-2026-10-18.tsv',sep='\t',dtype=str).values)
X=read_export('~/oc/forest-lead/data/ft4a.tsv')
ft4={}
for r in X: ft4.setdefault(r['consult_uid'],[]).append(r)
rows=[]
for cu in A|NA:
    if cu in A:
        o=anc.loc[cu]; ck=o.ck; d=o.d; ev=o.event; src='anchor'; doc=o.doc
    else:
        k=sorted(pk[cu])[0]; ck=cl.get(k,k); rs=ft4[cu]; d=dt.date.fromisoformat(rs[0]['consult_ist'][:10]); doc=rs[0]['doctor_uid']
        evs=[]
        for r in rs:
            ds=[r[x] for x in ('first_ot_date','first_bill_date') if nz(r[x])]
            if not ds: continue
            e=min(ds)[:10]; name=(r['first_surgery_name'] or '')+' | '+(r['first_bill_items'] or '')
            if R1.search(name) or r['first_adm_type']=='Maternity' or R4.search(name): continue
            if R2.search(r['first_surgery_name'] or '') or (r['first_bill_date'][:10]==r['consult_ist'][:10] if nz(r['first_bill_date']) else False) and not nz(r['first_ot_date']) and (r['first_adm_date'] or '')[:10]!=r['consult_ist'][:10]: continue
            if e>=str(d): evs.append(e)
        ev=min(evs) if evs else None; src='nonanchor'
        # strict credit: event already credited to a D flagged-Rx episode anchored on an EARLIER Rx of same cluster -> not this consult's
        if ev is not None:
            m=E[(E.ck==ck)&(E.event==ev)]
            if len(m) and m.d.iloc[0]<d and not os.environ.get("LOOSE"): ev=None; src='nonanchor_credited_elsewhere'
    assert g.set_of(ck)=='D'
    rows.append(dict(cu=cu,ck=ck,d=d,age=(READ-d).days,ev=ev,src=src,doc=doc))
K=pd.DataFrame(rows); print(K.src.value_counts().to_dict(), 'split rows all D: ok', 'consults',len(K),'patients',K.ck.nunique())
# one row per patient: prefer anchor, then earliest
K['pr']=(K.src!='anchor').astype(int); K['noev']=K.ev.isna().astype(int); K=K.sort_values(['ck','pr','d','noev','cu']).drop_duplicates('ck').drop(columns='pr')
K['lag']=[(dt.date.fromisoformat(e)-d).days if e else np.nan for e,d in zip(K.ev,K.d)]
K['ale']=np.where(K.ev.notna(),1.0,np.where(K.age>=14,0.0,np.nan))
K['ale14']=np.where(K.age>=14,K.ale,np.nan)
K['h14']=np.where(K.age>=18,(K.lag<=14).astype(float),np.nan)
for c in ('ale','ale14','h14'):
    s=K[K[c].notna()]; print(c,'n',len(s),'pos',int(s[c].sum()),'docs',s.doc.nunique())
s=K[(K.src=='anchor')&K.ale.notna()]; print('anchors ale n/pos',len(s),int(s.ale.sum()),'patients',s.ck.nunique(),'docs',s.doc.nunique())
s=K[(K.src!='anchor')]; print('nonanchor rows',len(s),'ale n/pos',s.ale.notna().sum(),int(s.ale.sum()))
K.to_pickle('cohort.pkl'); os.chmod('cohort.pkl',0o600)
