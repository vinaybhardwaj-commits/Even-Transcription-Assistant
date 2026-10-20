import pandas as pd,numpy as np,os,sys,json
W='~/wt/ft-refute-calltext/'; OUT='~/wt/ft-refute-ftr/work/'
lab,seed=sys.argv[1],int(sys.argv[2]); NJ=int(sys.argv[3]) if len(sys.argv)>3 else 8
os.chdir(W); src=open(W+'work/model.py').read().replace('n_jobs=-1',f'n_jobs={NJ}')
exec(src.split('def run(')[0])   # D,X,C,T,P, callfeats, docprior (read-only)
assert set(D.split)=={'D'}
A=pd.read_parquet('~/oc/forest-lead/ft/out/ft-rl-feat/call_audio_feats.parquet').set_index('episode_id')
assert set(A.split)=={'D'}
P=P.copy(); P['ale']=np.where(P.days_to_surgery<=14,1.0,np.where(P.age_days>=14,0.0,np.nan))
ROLE=('patient_','counsellor_','valence_gap','mean_patient_turn_s')
def audiofeats(E,Tl,nopat):
    s=f'_t{Tl}'; cols=[c for c in A.columns if c.endswith(s) and not c.startswith(('n_calls_dropped_outcome','role_fallback_share','intent_last'))]
    if nopat: cols=[c for c in cols if not c.startswith(ROLE)]
    a=A.reindex(E.episode_id).copy()
    if os.environ.get('MASK')=='1': a.loc[~(a['n_calls'+s].fillna(0)>0),[c for c in a.columns if c!='split']]=np.nan
    F=a[cols].astype(float)
    for v in ('wants_surgery','undecided','declines'):
        if not nopat or True: F['ilast_'+v]=(a['intent_last'+s]==v).astype(float)
    F['has_audio']=(a['n_calls'+s].fillna(0)>0).astype(float)
    F=F.fillna(-1); F.columns=['A_'+c for c in F.columns]; F.index=E.index; return F
def fit(XB,Fs,y,grp,doc,reps=5):
    mats={k:pd.concat([XB]+[f.reset_index(drop=True) for f in fs],axis=1).values for k,fs in Fs.items()}
    oof={k:np.zeros((reps,len(y))) for k in mats}
    for r in range(reps):
        for tr,te in StratifiedGroupKFold(5,shuffle=True,random_state=seed+r).split(XB,y,grp):
            ptr=np.zeros(len(tr)); ntr=np.zeros(len(tr))
            for itr,ite in StratifiedGroupKFold(5,shuffle=True,random_state=99).split(tr,y[tr],grp[tr]):
                a,b=docprior(doc.iloc[tr[itr]],y[tr[itr]],doc.iloc[tr[ite]]); ptr[ite]=a; ntr[ite]=b
            pte,nte=docprior(doc.iloc[tr],y[tr],doc.iloc[te])
            for k,M in mats.items():
                rf=RandomForestClassifier(400,min_samples_leaf=5,n_jobs=NJ,random_state=r).fit(np.column_stack([M[tr],ptr,ntr]),y[tr])
                oof[k][r,te]=rf.predict_proba(np.column_stack([M[te],pte,nte]))[:,1]
    return oof
res=[]
for Tl in (3,7):
    E=P[P[lab].notna()&~(P.days_to_surgery<=Tl)]
    assert not (E.days_to_surgery<=Tl).any()
    F,w=callfeats(E,0,lambda E:pd.Series(Tl,index=E.episode_id))
    ds=dict(zip(E.episode_id,E.days_to_surgery)); assert not (w.day>=w.episode_id.map(ds)).any(); assert (w.day<Tl).all(); assert not w.rev.any()
    AF=audiofeats(E,Tl,False); AN=audiofeats(E,Tl,True)
    y=E[lab].values.astype(int); grp=E.cluster_key.values; doc=E.doctor_uid.reset_index(drop=True); XB=X.loc[E.index].reset_index(drop=True)
    oof=fit(XB,{'base':[],'text':[F],'ta':[F,AF],'audio':[AF],'ta_np':[F,AN],'audio_np':[AN]},y,grp,doc)
    np.savez(OUT+f'oof_{lab}_lm{Tl}_s{seed}{os.environ.get("MASK","")}.npz',y=y,grp=grp,**oof); os.chmod(OUT+f'oof_{lab}_lm{Tl}_s{seed}{os.environ.get("MASK","")}.npz',0o600)
    cov=AF.A_has_audio.values>0
    r=dict(design=f'{lab}-lm{Tl}',seed=seed,n=len(y),pos=int(y.sum()),cov_n=int(cov.sum()),cov_pos=int(y[cov].sum()),
           auc={k:round(float(np.mean([roc_auc_score(y,o) for o in v])),3) for k,v in oof.items()})
    print(json.dumps(r),flush=True); res.append(r)
json.dump(res,open(OUT+f'res_{lab}_s{seed}{os.environ.get("MASK","")}.json','w')); os.chmod(OUT+f'res_{lab}_s{seed}{os.environ.get("MASK","")}.json',0o600)
