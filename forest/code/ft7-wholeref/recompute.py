import json, sys, glob, os
import numpy as np
from scipy.stats import rankdata
def auc(y, s):
    y=np.asarray(y); s=np.asarray(s); r=rankdata(s); n1=y.sum(); n0=len(y)-n1
    return (r[y==1].sum()-n1*(n1+1)/2)/(n1*n0)
rng=np.random.default_rng(7)
base=os.path.expanduser('~/oc/forest-lead/ft/out/ft-forest/')
pairs={'rx':[('M1','M0'),('M2','M1')], 'lm3':[('FULL','L0'),('L1','L0')], 'lm7':[('FULL','L0'),('L1','L0'),('L2','L1'),('L3','L2'),('L5','L4')], 'consult':[('FULL','C0'),('C1','C0')]}
out=[]
for f in sorted(glob.glob(base+'model_frozen_*.json')):
    d=json.load(open(f)); d=d[0] if isinstance(d,list) else d
    o=d['oof']; y=np.array(o['y']); cl=np.array(o['cluster'])
    S={m:np.mean(np.array(v,dtype=float),axis=0) for m,v in o['by_model_repeat'].items()}
    des=os.path.basename(f).split('_')[2]
    line=[os.path.basename(f), f"n={len(y)} pos={int(y.sum())}"]
    line+= [f"{m}={auc(y,s):.3f}" for m,s in S.items() if m in ('M0','M1','M2','L0','L1','L2','L3','L8','FULL','C0','C1','C8','SELECTED')]
    print(' '.join(line))
    uc,inv=np.unique(cl,return_inverse=True); idx_by=[np.where(inv==k)[0] for k in range(len(uc))]
    for a,b in pairs[des]:
        if a not in S or b not in S: continue
        dl=auc(y,S[a])-auc(y,S[b]); bs=[]
        for _ in range(1000):
            pick=rng.integers(0,len(uc),len(uc)); ii=np.concatenate([idx_by[k] for k in pick])
            if y[ii].min()==y[ii].max(): continue
            bs.append(auc(y[ii],S[a][ii])-auc(y[ii],S[b][ii]))
        bs=np.array(bs); p=min(1,2*min((bs<=0).mean(),(bs>=0).mean())); p=max(p,1/1000)
        js=d.get('delta',{}).get(f'{a}-{b}',{})
        print(f"   {a}-{b}: mine {dl:+.4f} CI[{np.percentile(bs,2.5):+.3f},{np.percentile(bs,97.5):+.3f}] p2={p:.3f} | file {js.get('delta',float('nan')):+.4f} {js.get('ci')} p2={js.get('p_two')}")
