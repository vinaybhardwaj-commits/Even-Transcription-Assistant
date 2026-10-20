import json,os,sys,datetime as dt,pandas as pd,numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.metrics import roc_auc_score
D=pd.read_pickle('work/epsD2.pkl'); X=pd.read_pickle('work/baseX.pkl'); C=pd.read_pickle('work/callsD.pkl')
T={}
for l in open('~/oc/forest-lead/ft/out/ft-calltext/tags_D.jsonl'):
    r=json.loads(l); T[r['call_id']]=r
f1=pd.read_csv('~/eta-data/forest/funnel/hash-only/f1-2026-10-19.tsv',sep='\t',dtype=str)
amb=set(f1[(f1.ambiguous=='true')&(f1.split=='D')].cluster_key)
k10=set(pd.read_csv('~/oc/forest-lead/funnel/in/f1-10e2-keys.tsv',sep='\t',dtype=str).patient_key)
rx=pd.read_pickle('work/rx.pkl'); s_cl={c for c,k in zip(rx.cluster_key,rx.patient_key) if k in k10}|{c for c in rx.cluster_key if c in k10}
base=D[(pd.to_datetime(D.rx_date)>=pd.Timestamp('2026-01-01'))]
P=base[~base.cluster_key.isin(amb)]; S=P[~P.cluster_key.isin(s_cl)]
print('amb D clusters',len(amb),'eps dropped',base.cluster_key.isin(amb).sum(),'S drop',P.cluster_key.isin(s_cl).sum(), 'all-D eps in 10e2 set',D.cluster_key.isin(s_cl).sum())
OBJ=['cost','insurance','fear','second_opinion','going_elsewhere','timing','family_decision','unreachable']
C['rev']=C.call_id.map(lambda c:bool(T.get(c,{}).get('outcome_revealed') or T.get(c,{}).get('outcome_revealed_unverified')))
C['tagged']=C.call_id.isin(T)
FAILEP=set(C[C.summary.notna()&~C.tagged&(C.day>=0)&(C.day<=14)&~(C.day>=C.episode_id.map(dict(zip(D.episode_id,D.days_to_surgery))))].episode_id)
def callfeats(E,lo,hi_fn,drop_rev=True):
    hi=E.episode_id.map(hi_fn(E)); h=dict(zip(E.episode_id,hi))
    w=C[C.episode_id.isin(E.episode_id)]; w=w[(w.day>=0)&(w.day<w.episode_id.map(h))]
    if drop_rev: w=w[~w.rev]
    rows={}
    for e,g in w.groupby('episode_id'):
        f=dict(n_calls=len(g),n_conn=(g.dur>0).sum(),n_rec=g.rec.sum(),talk_s=g.dur.sum(),max_s=g.dur.max(),first_day=g.day.min(),n_summ=g.summary.notna().sum())
        tg=[T[c] for c in g.call_id if c in T]
        for o in OBJ: f['obj_'+o]=float(any(o in t['objections'] for t in tg))
        for i in ('wants_surgery','undecided','declines'): f['int_'+i]=float(any(t['intent']==i for t in tg))
        f['next_any']=float(any(t['next_step']!='none' for t in tg)); f['next_visit']=float(any(t['next_step']=='visit_or_consult_scheduled' for t in tg))
        f['price']=float(any(t['price_quoted'] for t in tg)); f['n_tagged']=len(tg)
        rows[e]=f
    F=pd.DataFrame.from_dict(rows,orient='index').reindex(E.episode_id).fillna(0); F['first_day']=np.where(F.n_calls==0,-1,F.first_day)
    F['no_call']=(F.n_calls==0).astype(float); F.index=E.index; return F,w
def docprior(tr_doc,tr_y,te_doc,m=10):
    g=tr_y.mean(); s=pd.DataFrame({'d':tr_doc,'y':tr_y}).groupby('d').y.agg(['sum','count'])
    r=(s['sum']+m*g)/(s['count']+m); return te_doc.map(r).fillna(g).values, te_doc.map(s['count']).fillna(0).values
def run(E,y,F,reps=5,seed=0,tag=''):
    grp=E.cluster_key.values; doc=E.doctor_uid.reset_index(drop=True); y=np.asarray(y)
    XB=X.loc[E.index].reset_index(drop=True); XC=pd.concat([XB,F.reset_index(drop=True)],axis=1)
    oof={'b':np.zeros((reps,len(y))),'c':np.zeros((reps,len(y)))}
    for r in range(reps):
        for tr,te in StratifiedGroupKFold(5,shuffle=True,random_state=seed+r).split(XB,y,grp):
            # doctor prior: test rows from full train; train rows inner OOF
            ptr=np.zeros(len(tr)); ntr=np.zeros(len(tr))
            for itr,ite in StratifiedGroupKFold(5,shuffle=True,random_state=99).split(tr,y[tr],grp[tr]):
                a,b=docprior(doc.iloc[tr[itr]],y[tr[itr]],doc.iloc[tr[ite]]); ptr[ite]=a; ntr[ite]=b
            pte,nte=docprior(doc.iloc[tr],y[tr],doc.iloc[te])
            for k,M in (('b',XB),('c',XC)):
                A=M.values; Atr=np.column_stack([A[tr],ptr,ntr]); Ate=np.column_stack([A[te],pte,nte])
                rf=RandomForestClassifier(400,min_samples_leaf=5,n_jobs=-1,random_state=r,class_weight=None).fit(Atr,y[tr])
                oof[k][r,te]=rf.predict_proba(Ate)[:,1]
    ab=np.mean([roc_auc_score(y,o) for o in oof['b']]); ac=np.mean([roc_auc_score(y,o) for o in oof['c']])
    pb,pc=oof['b'].mean(0),oof['c'].mean(0); rng=np.random.default_rng(1); uc=np.unique(grp); idx={c:np.where(grp==c)[0] for c in uc}; ds=[]; bs=[]
    for _ in range(1000):
        ii=np.concatenate([idx[c] for c in rng.choice(uc,len(uc))])
        if y[ii].min()==y[ii].max(): continue
        b0=roc_auc_score(y[ii],pb[ii]); bs.append(b0); ds.append(roc_auc_score(y[ii],pc[ii])-b0)
    res=dict(design=tag,n=len(y),pos=int(y.sum()),base=round(ab,3),base_ci=[round(x,3) for x in np.percentile(bs,[2.5,97.5])],call=round(ac,3),
      d=round(ac-ab,3),d_ci=[round(x,3) for x in np.percentile(ds,[2.5,97.5])],p_le0=round(float(np.mean(np.array(ds)<=0)),2),eps_w_call=int((F.n_calls>0).sum()),eps_w_summ=int((F.n_summ>0).sum()))
    print(json.dumps(res),flush=True); return res
