import json,glob,numpy as np,pandas as pd,sys
sys.path.insert(0,'~/wt/ft-refute-ftr/work')
from sklearn.metrics import roc_auc_score
L='~/oc/forest-lead/ft/out/ft-calltext/'
A=pd.read_parquet('~/oc/forest-lead/ft/out/ft-rl-feat/call_audio_feats.parquet').set_index('episode_id')
W='~/wt/ft-refute-calltext/work/'; D=pd.read_pickle(W+'epsD2.pkl'); ds=dict(zip(D.episode_id,D.days_to_surgery)); sp=dict(zip(D.episode_id,D.split))
B=4000; rows=[]
for lab in ('h14','h90','ale'):
  rs=json.load(open(glob.glob(L+f'model_final2_{lab}-P-lm3_{lab}-P-lm7.json')[0])); rs=rs if isinstance(rs,list) else list(rs.values())
  for r in rs:
    T=int(r['design'][2:]); o=r['oof']; e=np.array(o['episode_id']); y=np.array(o['y']); g=np.array(o['cluster'])
    M={k:np.array(v) for k,v in o['by_model_repeat'].items()}
    # F1 + split on actual rows
    sd=np.array([ds.get(x,np.nan) for x in e]); assert not (sd<=T).any(); assert all(sp.get(x)=='D' for x in e)
    cov=(A.reindex(e)[f'n_calls_t{T}'].fillna(0)>0).values
    m={k:v.mean(0) for k,v in M.items()}
    uc=np.unique(g); idx={c:np.where(g==c)[0] for c in uc}; rng=np.random.default_rng(11)
    P=[('text','base'),('text_audio','base'),('audio','base')]; Dl={p:[] for p in P}
    for _ in range(B):
        ii=np.concatenate([idx[c] for c in rng.choice(uc,len(uc))])
        if y[ii].min()==y[ii].max(): continue
        a={k:roc_auc_score(y[ii],v[ii]) for k,v in m.items()}
        for p in P: Dl[p].append(a[p[0]]-a[p[1]])
    for p in P:
        d=np.array(Dl[p]); pt=roc_auc_score(y,m[p[0]])-roc_auc_score(y,m[p[1]]); p2=max(1/B,min(1,2*min(np.mean(d<=0),np.mean(d>=0))))
        rows.append((lab,T,p[0],len(y),int(y.sum()),int(cov.sum()),int(y[cov].sum()),pt,*np.percentile(d,[2.5,97.5]),p2))
ps=np.array([r[-1] for r in rows]); o=np.argsort(ps); adj=np.empty(len(ps)); run=0
for i,j in enumerate(o): run=max(run,(len(ps)-i)*ps[j]); adj[j]=min(1,run)
for r,a in zip(rows,adj): print('%s T%d %-10s n%d/%d cov %d/%d  %+.3f [%+.3f,%+.3f] p2 %.3f holm %.3f'%(*r,a))
print('min holm18',adj.min().round(3))
