import pandas as pd,numpy as np,os,sys
W='~/wt/ft-refute-calltext/'
os.chdir(W)
exec(open(W+'work/model.py').read().split('OBJ=')[0])  # loads D,X,C,T,P,S (no writes)
A=pd.read_parquet('~/oc/forest-lead/ft/out/ft-rl-feat/call_audio_feats.parquet')
L=pd.read_parquet('~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet')
print('labels cols',list(L.columns))
print('A eps in D epsD2',A.episode_id.isin(D.episode_id).sum(),'/',len(A),' in P',A.episode_id.isin(P.episode_id).sum())
LD=L.set_index('episode_id') if 'episode_id' in L else None
print('A split from labels', L[L.episode_id.isin(A.episode_id)].split.value_counts().to_dict())
m=A.merge(D[['episode_id','h14','h90']],on='episode_id',how='left',suffixes=('','_m'))
for c in ('h14','h90'): print(c,'label mismatch vs mine',((m[c].fillna(-1))!=(m[c+'_m'].fillna(-1))).sum())
P=P.copy(); P['ale']=np.where(P.days_to_surgery<=14,1.0,np.where(P.age_days>=14,0.0,np.nan))
Aset=dict(zip(A.episode_id,A.index))
for lab in ('h14','h90','ale'):
  for Tl in (3,7):
    E=P[P[lab].notna()&~(P.days_to_surgery<=Tl)]
    a=A.set_index('episode_id').reindex(E.episode_id)
    cov=a[f'n_calls_t{Tl}'].fillna(0)>0
    inA=a.n_calls_stt.notna()
    y=E[lab].values
    # pre-landmark converters in A
    EA=P[P[lab].notna()&P.episode_id.isin(A.episode_id)]
    pre=(EA.days_to_surgery<=Tl).sum()
    eqT=((EA.days_to_surgery==Tl)).sum()
    print(lab,Tl,'n',len(E),'pos',int(y.sum()),'| inA',int(inA.sum()),int(y[inA.values].sum()),'| covT(n_calls_tT>0)',int(cov.sum()),int(y[cov.values].sum()),'| A eps dropped pre-LM',pre,'(event==T',eqT,')','| kept eps event<=T',int((E.days_to_surgery<=Tl).sum()))
# monotone windows
print('t3<=t7<=t14',bool(((A.n_calls_t3<=A.n_calls_t7)&(A.n_calls_t7<=A.n_calls_t14)).all()))
