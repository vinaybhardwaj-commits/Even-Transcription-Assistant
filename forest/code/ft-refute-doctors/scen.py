import sys; sys.path.insert(0,"~/wt/ft-refute-doctors/work")
import numpy as np, pandas as pd, warnings; warnings.filterwarnings('ignore')
import statsmodels.api as sm
import glmm
from glmm import design
from feats import CASEMIX
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
for h in ['h14','h90']:
    coh=pd.read_pickle(f'coh{h[1:]}.pkl')
    X,y,g,G,d=design(coh,h,adj=True)
    p=sm.GLM(y,X,family=sm.families.Binomial()).fit().predict(X)
    d=d.assign(p=p)
    t=d.groupby(['spec','doctor_uid']).agg(n=(h,'size'),O=(h,'sum'),E=('p','sum')); t['oe']=t.O/t.E
    med=t.groupby('spec').oe.transform('median'); best=t.groupby('spec').oe.transform('max')
    s1=((med-t.oe).clip(lower=0)*t.E).sum(); s3=((best-t.oe).clip(lower=0)*t.E).sum()
    print(h,'cohort O',int(t.O.sum()),'to-median gain %.1f'%s1,'+20%% of O %.1f'%(0.2*t.O.sum()),'best-doctor ceiling %.1f'%s3)
    # CV AUC gain
    D=pd.get_dummies(d.doctor_uid).astype(float).values
    rs=RepeatedStratifiedKFold(n_splits=5,n_repeats=20,random_state=1); gains=[];a0s=[];a1s=[]
    for r in range(20):
        idx=list(rs.split(X,y))[r*5:(r+1)*5]; P0=np.zeros(len(y));P1=np.zeros(len(y))
        for tr,te in idx:
            for XX,PP in ((X,P0),(np.c_[X,D],P1)):
                m=LogisticRegression(C=1.0,max_iter=5000).fit(XX[tr][:,1:],y[tr]); PP[te]=m.predict_proba(XX[te][:,1:])[:,1]
        a0,a1=roc_auc_score(y,P0),roc_auc_score(y,P1); a0s.append(a0);a1s.append(a1); gains.append(a1-a0)
    gains=np.array(gains)
    # bootstrap CI of gain on a fixed repeat's OOF predictions
    rng=np.random.default_rng(3); bs=[]
    for _ in range(1000):
        i=rng.integers(0,len(y),len(y))
        if y[i].min()==y[i].max(): continue
        bs.append(roc_auc_score(y[i],P1[i])-roc_auc_score(y[i],P0[i]))
    print(h,'CV AUC base %.3f +doctor %.3f gain mean %.3f (repeat range %.3f..%.3f; bootstrap 95%% %.3f..%.3f)'%(np.mean(a0s),np.mean(a1s),gains.mean(),gains.min(),gains.max(),*np.percentile(bs,[2.5,97.5])))
# top-4 all episodes (not only analysis cohort), H14
E=pd.read_pickle('mineD.pkl'); sp=pd.read_csv('~/oc/forest-lead/ft/doctor_specialty.tsv',sep='\t',dtype=str); E['spec']=E.doctor_uid.map(dict(sp.values))
x=E[E.h14.notna()&E.spec.isin(['General Surgery','Gynaecology','Orthopaedics','Urology'])]; print('top4 H14 n',len(x),'pos',int(x.h14.sum()),'0.2*pos %.1f'%(0.2*x.h14.sum()))
