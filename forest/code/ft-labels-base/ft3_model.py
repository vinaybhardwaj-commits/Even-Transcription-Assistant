# FT3 Pulse-only baseline (ft-labels-base, 19 Oct 2026). D split only. RF; temporal split (train Dec-May, test Jun-Sep) + repeated
# stratified group CV (5 folds x 5 repeats, groups = RD-0 cluster). Doctor enters as an out-of-fold smoothed prior rate (+ volume),
# fitted on training rows only (inner 5-fold OOF for the training rows themselves). Bootstrap CIs resample clusters.
import os,json,sys,time
T0=time.time()
import pandas as pd, numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedGroupKFold, GroupKFold
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
OD=os.path.expanduser('~/oc/forest-lead/ft/out/ft-labels-base'); RS=20261019
F=pd.read_parquet(f'{OD}/features_D.parquet'); COLS=json.load(open(f'{OD}/features_D.cols.json'))
# payer is OFF by default: same-day appt/bill payer encodes same-day hospital activity and UHID linkability (leaky). PAYER=1 = sensitivity run.
TAG=os.environ.get('TAG','')
if os.environ.get('PAYER')!='1': COLS=[c for c in COLS if c!='payer']
COLS=[c for c in COLS if c not in os.environ.get('DROPF','').split(',')]
assert set(F.split)=={'D'}
CAT=[c for c in COLS if F[c].dtype==object and c!='doctor_id']; NUM=[c for c in COLS if c not in CAT+['doctor_id']]
GROUPS={'specialty':['specialty'],'doctor':['doctor_id'],'procedure':['proc_class','n_procs'],'month':['month_idx'],
  'prior_flagged_rx':['n_prior_flagged'],'age':['age_y'],'patient_sex':['sex'],'payer':['payer'],'prior_rx_any':['n_prior_rx'],
  'icd':[c for c in COLS if c.startswith('ch_')]+['n_icd','icd_missing'],'investigations':['n_inv','inv_missing'],'doctor_gender':['doctor_gender'],'payer_prior':['payer_prior','days_since_prior_appt']}
GROUPS={k:v for k,v in GROUPS.items() if all(c in COLS for c in v)}
BIG4=['General Surgery','Gynaecology','Orthopaedics','Urology']
NB=int(os.environ.get('NB',1000))

def doc_rate(tr_doc,tr_y,ap_doc,m=10):
    g=pd.DataFrame({'d':tr_doc,'y':tr_y}).groupby('d').y.agg(['sum','count']); p=tr_y.mean()
    r=((g['sum']+m*p)/(g['count']+m)).to_dict(); v=g['count'].to_dict()
    return np.array([r.get(d,p) for d in ap_doc]),np.array([v.get(d,0) for d in ap_doc])

class Enc:
    def fit(self,X):
        self.levels={c:[l for l,n in X[c].value_counts().items() if n>=10] for c in CAT}; return self
    def tf(self,X,dr,dv):
        out=[X[NUM].astype(float).fillna(-1).values]; names=list(NUM)
        for c in CAT:
            for l in self.levels[c]: out.append((X[c]==l).values[:,None].astype(float)); names.append(f'{c}={l}')
        out+= [dr[:,None],dv[:,None]]; names+=['doctor_rate','doctor_vol']
        return np.hstack(out),names

def fit_predict(Xtr,ytr,gtr,Xte,seed=RS):
    # training rows get inner-OOF doctor rate; test rows get the rate from all training rows
    drt=np.zeros(len(Xtr)); dvt=np.zeros(len(Xtr))
    for a,b in GroupKFold(5).split(Xtr,ytr,gtr):
        drt[b],dvt[b]=doc_rate(Xtr.doctor_id.values[a],ytr[a],Xtr.doctor_id.values[b])
    dre,dve=doc_rate(Xtr.doctor_id.values,ytr,Xte.doctor_id.values)
    enc=Enc().fit(Xtr); A,names=enc.tf(Xtr,drt,dvt)
    rf=RandomForestClassifier(n_estimators=400,min_samples_leaf=5,max_features='sqrt',n_jobs=10,random_state=seed).fit(A,ytr); rf.n_jobs=1
    g=pd.DataFrame({'d':Xtr.doctor_id.values,'y':ytr}).groupby('d').y.agg(['sum','count']); p0=ytr.mean()
    rm=((g['sum']+10*p0)/(g['count']+10)).to_dict(); vm=g['count'].to_dict()
    score=lambda X: rf.predict_proba(enc.tf(X,np.array([rm.get(d,p0) for d in X.doctor_id]),np.array([vm.get(d,0) for d in X.doctor_id]))[0])[:,1]
    return rf.predict_proba(enc.tf(Xte,dre,dve)[0])[:,1],score,dre

def metrics(y,p): return dict(auc=roc_auc_score(y,p),prauc=average_precision_score(y,p),brier=brier_score_loss(y,p))
def boot(y,p,g,nb=NB,seed=RS):
    rng=np.random.default_rng(seed); ug=np.unique(g); idx={k:np.where(g==k)[0] for k in ug}; res=[]
    for _ in range(nb):
        s=np.concatenate([idx[k] for k in rng.choice(ug,len(ug))])
        if 0<y[s].sum()<len(s): res.append(list(metrics(y[s],p[s]).values()))
    lo,hi=np.percentile(res,[2.5,97.5],axis=0); pt=metrics(y,p)
    return {k:(pt[k],lo[i],hi[i]) for i,k in enumerate(pt)}

def perm_imp(score,X,y,g,nb=200,seed=RS):
    # AUC drop when one raw feature is permuted; each draw = cluster bootstrap of the eval rows + a fresh permutation -> 95% interval
    rng=np.random.default_rng(seed); ug=np.unique(g); idx={k:np.where(g==k)[0] for k in ug}; out={f:[] for f in GROUPS}
    for _ in range(nb):
        s=np.concatenate([idx[k] for k in rng.choice(ug,len(ug))]); Xs=X.iloc[s].reset_index(drop=True); ys=y[s]
        if not 0<ys.sum()<len(s): continue
        base=roc_auc_score(ys,score(Xs))
        for f,cs in GROUPS.items():
            Xp=Xs.copy(); pi_=rng.permutation(len(Xp)); Xp[cs]=Xp[cs].values[pi_]; out[f].append(base-roc_auc_score(ys,score(Xp)))
    return {f:(np.mean(v),*np.percentile(v,[2.5,97.5])) for f,v in out.items()}

R={}; fmt=lambda t:f'{t[0]:.3f} [{t[1]:.3f}-{t[2]:.3f}]'
for lab in ('h14','h90'):
    D=F[F[lab].notna()].reset_index(drop=True); y=D[lab].values.astype(int); g=D.cluster_key.values
    r=R[lab]={'n':len(D),'pos':int(y.sum())}
    # temporal
    tr=(D.rx_date<'2026-06-01').values; te=((D.rx_date>='2026-06-01')&(D.rx_date<'2026-10-01')).values
    Xtr,Xte=D[tr].reset_index(drop=True),D[te].reset_index(drop=True)
    p,score,dre=fit_predict(Xtr,y[tr],g[tr],Xte)
    r['temporal']=dict(n_train=int(tr.sum()),pos_train=int(y[tr].sum()),n_test=int(te.sum()),pos_test=int(y[te].sum()),
        test_window=f"{Xte.rx_date.min().date()}..{Xte.rx_date.max().date()}",model=boot(y[te],p,g[te]),
        doctor_rate_only=boot(y[te],dre,g[te]),base_rate_brier=brier_score_loss(y[te],np.full(te.sum(),y[tr].mean())))
    print(lab,'temporal fit',round(time.time()-T0),flush=True)
    r['temporal']['perm']=perm_imp(score,Xte,y[te],g[te])
    # repeated stratified group CV
    oof=np.zeros((5,len(D))); per_rep=[]; fold_imp={f:[] for f in GROUPS}
    for rep in range(5):
        for a,b in StratifiedGroupKFold(5,shuffle=True,random_state=RS+rep).split(D,y,g):
            oof[rep,b],_,_=fit_predict(D.iloc[a].reset_index(drop=True),y[a],g[a],D.iloc[b].reset_index(drop=True),seed=RS+rep)
        per_rep.append(metrics(y,oof[rep]))
    pm=oof.mean(0)
    r['cv']=dict(per_repeat={k:(float(np.mean([m[k] for m in per_rep])),float(np.min([m[k] for m in per_rep])),float(np.max([m[k] for m in per_rep]))) for k in per_rep[0]},
                 pooled=boot(y,pm,g),base_rate_brier=brier_score_loss(y,np.full(len(y),y.mean())))
    # CV permutation importance: one full-data fit is NOT used; refit on 4/5 and permute the held-out 1/5, repeat 0
    for a,b in StratifiedGroupKFold(5,shuffle=True,random_state=RS).split(D,y,g):
        _,sc,_=fit_predict(D.iloc[a].reset_index(drop=True),y[a],g[a],D.iloc[b].reset_index(drop=True))
        pi=perm_imp(sc,D.iloc[b].reset_index(drop=True),y[b],g[b],nb=30,seed=RS+len(b))
        for f in GROUPS: fold_imp[f].append(pi[f][0])
    rng=np.random.default_rng(RS)
    r['cv_perm']={f:(float(np.mean(v)),*np.percentile([np.mean(rng.choice(v,len(v))) for _ in range(2000)],[2.5,97.5])) for f,v in fold_imp.items()}
    # per specialty (pooled CV OOF score)
    r['spec']={}
    for s in BIG4+['other']:
        m=(~D.specialty.isin(BIG4)).values if s=='other' else (D.specialty==s).values
        e=dict(n=int(m.sum()),pos=int(y[m].sum()),rate=float(y[m].mean()))
        if 0<y[m].sum()<m.sum() and y[m].sum()>=5: e['cv_auc_within']=boot(y[m],pm[m],g[m])['auc']
        mt=m&te
        e['test_n']=int(mt.sum()); e['test_pos']=int(y[mt].sum())
        if y[mt].sum()>=5 and y[mt].sum()<mt.sum():
            pt=p[np.where(te)[0].searchsorted(np.where(mt)[0])]; e['test_auc']=boot(y[mt],pt,g[mt])['auc']
        r['spec'][s]=e
    print(lab,json.dumps({k:v for k,v in r.items() if k not in('spec',)},default=float)[:3000]); sys.stdout.flush()
json.dump(R,open(f'{OD}/ft3_results{TAG}.json','w'),indent=1,default=float)
print('features:',COLS)
