import json, glob, os, numpy as np
from scipy.stats import rankdata
def auc(y,s):
    r=rankdata(s); n1=y.sum(); n0=len(y)-n1; return (r[y==1].sum()-n1*(n1+1)/2)/(n1*n0)
base=os.path.expanduser('~/oc/forest-lead/ft/out/ft-forest/')
nA=nD=0; maxdA=maxdD=0
for f in sorted(glob.glob(base+'model_frozen_*.json')):
    d=json.load(open(f)); d=d[0] if isinstance(d,list) else d
    o=d['oof']; y=np.array(o['y'])
    S={m:np.mean(np.array(v,float),axis=0) for m,v in o['by_model_repeat'].items()}
    A={m:auc(y,s) for m,s in S.items()}
    for m,a in A.items():
        fa=d['auc'][m]['auc'][0] if m in d['auc'] else None
        if fa is not None: nA+=1; maxdA=max(maxdA,abs(a-fa))
    for k,v in d['delta'].items():
        a,b=k.split('-')
        if a in A and b in A:
            nD+=1; maxdD=max(maxdD,abs((A[a]-A[b])-v['delta']))
    print(os.path.basename(f), ' '.join(f"{m}={a:.3f}" for m,a in A.items()))
print('AUCs checked',nA,'max abs diff',maxdA,'; deltas checked',nD,'max abs diff',maxdD)
