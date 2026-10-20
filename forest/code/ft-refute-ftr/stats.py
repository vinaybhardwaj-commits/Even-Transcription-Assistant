import numpy as np,glob,json,sys,os
from sklearn.metrics import roc_auc_score
seed=int(sys.argv[1]) if len(sys.argv)>1 else 0; B=4000
SUF=sys.argv[2] if len(sys.argv)>2 else ''
PAIRS=[('text','base'),('ta','base'),('audio','base'),('ta','text'),('ta_np','base'),('audio_np','base'),('ta_np','text')]
rows=[]
for lab in ('h14','h90','ale'):
  for Tl in (3,7):
    z=np.load(f'oof_{lab}_lm{Tl}_s{seed}{SUF}.npz',allow_pickle=True); y=z['y']; g=z['grp']
    m={k:z[k].mean(0) for k in z.files if k not in('y','grp')}
    uc=np.unique(g); idx={c:np.where(g==c)[0] for c in uc}; rng=np.random.default_rng(7)
    D={p:[] for p in PAIRS}
    for _ in range(B):
        ii=np.concatenate([idx[c] for c in rng.choice(uc,len(uc))])
        if y[ii].min()==y[ii].max(): continue
        a={k:roc_auc_score(y[ii],v[ii]) for k,v in m.items()}
        for p in PAIRS: D[p].append(a[p[0]]-a[p[1]])
    for p in PAIRS:
        d=np.array(D[p]); rep=[roc_auc_score(y,z[p[0]][r])-roc_auc_score(y,z[p[1]][r]) for r in range(z['base'].shape[0])]
        pt=np.mean(rep); ple=float(np.mean(d<=0)); p2=min(1,2*min(ple,float(np.mean(d>=0))))
        rows.append(dict(d=f'{lab}-lm{Tl}',pair=f'{p[0]}-{p[1]}',n=len(y),pos=int(y.sum()),delta=round(pt,3),ci=[round(x,3) for x in np.percentile(d,[2.5,97.5])],
          ci_bonf18=[round(x,3) for x in np.percentile(d,[100*0.025/18,100-100*0.025/18])],p_le0=round(ple,3),rep_le0=float(np.mean(np.array(rep)<=0)),p2=round(p2,4)))
def holm(ps):
    o=np.argsort(ps); k=len(ps); adj=np.empty(k); run=0
    for i,j in enumerate(o): run=max(run,(k-i)*ps[j]); adj[j]=min(1,run)
    return adj
fam18=[r for r in rows if r['pair'] in('text-base','ta-base','audio-base')]
fam24=fam18+[r for r in rows if r['pair']=='ta-text']
for fam,name in((fam18,'holm18'),(fam24,'holm24')):
    for r,a in zip(fam,holm(np.array([r['p2'] for r in fam]))): r[name]=round(float(a),3)
for r in rows: print(json.dumps(r))
json.dump(rows,open(f'stats_s{seed}{SUF}.json','w'),indent=0); os.chmod(f'stats_s{seed}.json',0o600)
