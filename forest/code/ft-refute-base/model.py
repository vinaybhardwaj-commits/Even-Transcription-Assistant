"""Own FT3 models (ft-refute-base, Opus 5.5). D only. Doctor rate computed in-fold (inner OOF on train rows). No hyper-parameter search: fixed RF."""
import pandas as pd, numpy as np, json, sys, datetime as dt
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
from sklearn.calibration import CalibratedClassifierCV
F=pd.read_pickle('work/feat_D.pkl')
WITHPAY='--withpay' in sys.argv
NUM=['n_procs','n_icd','n_inv','n_inv_uids','n_further_inv','inv_missing','days_prior_appt','age','n_prior_rx','dow','hour']
CAT=['spec','proc','icd_ch','doc_gender','payer_prior','sex']+(['payer_sameday'] if WITHPAY else [])
X0=pd.get_dummies(F[CAT].astype(str),prefix=CAT,dtype=float).join(F[NUM].fillna(-1))
GROUPS={c:[k for k in X0 if k.startswith(c+'_')] for c in CAT}; GROUPS.update({c:[c] for c in NUM}); GROUPS['doctor']=['doc_rate']
M=10
def rate_map(doc,y):
    p=y.mean(); g=pd.DataFrame({'d':doc,'y':y}).groupby('d').y.agg(['sum','size'])
    return ((g['sum']+M*p)/(g['size']+M)).to_dict(), p
def doc_rate(tr,te,y,seed):
    """train rows: inner 5-fold OOF rate; test rows: rate from all train rows."""
    doc=F.doctor_uid
    out_tr=pd.Series(np.nan,index=tr)
    for a,b in StratifiedGroupKFold(5,shuffle=True,random_state=seed).split(tr,y.loc[tr],F.cluster_key.loc[tr]):
        m,p=rate_map(doc.loc[tr[a]],y.loc[tr[a]]); out_tr.iloc[b]=doc.loc[tr[b]].map(m).fillna(p).values
    m,p=rate_map(doc.loc[tr],y.loc[tr]); out_te=doc.loc[te].map(m).fillna(p)
    return out_tr.values,out_te.values
def fit_pred(tr,te,y,seed,cal=False,perm=None,nperm=0):
    Xtr=X0.loc[tr].copy(); Xte=X0.loc[te].copy()
    Xtr['doc_rate'],Xte['doc_rate']=doc_rate(tr,te,y,seed)
    rf=RandomForestClassifier(n_estimators=500,min_samples_leaf=5,max_features='sqrt',n_jobs=12,random_state=seed)
    if cal:
        sp=list(StratifiedGroupKFold(5,shuffle=True,random_state=seed).split(Xtr,y.loc[tr].values,F.cluster_key.loc[tr].values))
        mdl=CalibratedClassifierCV(rf,method='sigmoid',cv=sp)
    else: mdl=rf
    mdl.fit(Xtr,y.loc[tr])
    pr=mdl.predict_proba(Xte)[:,1]; imp={}
    if perm:
        rng=np.random.default_rng(seed); base=roc_auc_score(y.loc[te],pr)
        for g,cols in perm.items():
            drops=[]
            for _ in range(nperm):
                Xp=Xte.copy(); idx=rng.permutation(len(Xp)); Xp[cols]=Xte[cols].values[idx]
                drops.append(base-roc_auc_score(y.loc[te],mdl.predict_proba(Xp)[:,1]))
            imp[g]=float(np.mean(drops))
    return pr,Xte['doc_rate'].values,imp
def cboot(y,p,cl,fn,B=2000,seed=0):
    rng=np.random.default_rng(seed); u=np.unique(cl); idx={k:np.where(cl==k)[0] for k in u}; v=[]
    for _ in range(B):
        s=np.concatenate([idx[k] for k in rng.choice(u,len(u))])
        if 0<y[s].sum()<len(s): v.append(fn(y[s],p[s]))
    return [float(np.percentile(v,2.5)),float(np.percentile(v,97.5))]
def metrics(y,p,cl,prior):
    y=np.asarray(y); p=np.asarray(p); cl=np.asarray(cl)
    return dict(n=int(len(y)),pos=int(y.sum()),auc=float(roc_auc_score(y,p)),auc_ci=cboot(y,p,cl,roc_auc_score),
        prauc=float(average_precision_score(y,p)),prauc_ci=cboot(y,p,cl,average_precision_score,B=1000),
        brier=float(brier_score_loss(y,p)),brier_noskill_trainprev=float(np.mean((y-prior)**2)),brier_noskill_testprev=float(y.mean()*(1-y.mean())))
R={}
for lab in ['h14','h90']:
    y=F[lab].dropna().astype(int); idx=y.index; rd=pd.to_datetime(F.rx_date.loc[idx])
    tr=idx[rd<'2026-06-01']; te=idx[(rd>='2026-06-01')&(rd<'2026-10-01')]
    r=R[lab]={}
    res=[];
    for cal in (False,True):
        ps=[];dr=None
        for s in range(5):
            p,d,_=fit_pred(tr,te,y,s,cal=cal); ps.append(p); dr=d
        p=np.mean(ps,0); r['temporal_cal' if cal else 'temporal_raw']=metrics(y.loc[te],p,F.cluster_key.loc[te],y.loc[tr].mean())
    r['temporal_doc_rate_alone']=metrics(y.loc[te],dr,F.cluster_key.loc[te],y.loc[tr].mean())
    r['train_n_pos']=[int(len(tr)),int(y.loc[tr].sum())]; r['test_window']=[str(rd.loc[te].min().date()),str(rd.loc[te].max().date())]
    if lab=='h14':  # Jun-Jul only test (free of the Aug-Sep reserved months)
        te2=idx[(rd>='2026-06-01')&(rd<'2026-08-01')]
        p=np.mean([fit_pred(tr,te2,y,s)[0] for s in range(5)],0); r['temporal_JunJul_raw']=metrics(y.loc[te2],p,F.cluster_key.loc[te2],y.loc[tr].mean())
    # 5x5 grouped CV
    oof=np.zeros((5,len(idx))); oofd=np.zeros((5,len(idx))); imps=[]; aucs=[]
    for rep in range(5):
        for k,(a,b) in enumerate(StratifiedGroupKFold(5,shuffle=True,random_state=100+rep).split(idx,y,F.cluster_key.loc[idx])):
            p,d,imp=fit_pred(idx[a],idx[b],y,rep*10+k,perm=GROUPS,nperm=5); oof[rep,b]=p; oofd[rep,b]=d; imps.append(imp)
        aucs.append(roc_auc_score(y,oof[rep]))
    po=oof.mean(0)
    r['cv']=metrics(y,po,F.cluster_key.loc[idx].values,y.mean()); r['cv']['auc_per_repeat']=[round(a,4) for a in aucs]
    r['cv_doc_rate_alone_auc']=float(roc_auc_score(y,oofd.mean(0)))
    I=pd.DataFrame(imps); r['perm']={g:dict(mean=float(I[g].mean()),ci=[float(I[g].quantile(.025)),float(I[g].quantile(.975))],
        boot=[float(np.percentile([I[g].sample(len(I),replace=True,random_state=s).mean() for s in range(1000)],q)) for q in (2.5,97.5)]) for g in I}
    sp=F.spec.loc[idx].values; r['within_spec_cv']={}
    for s in ['GS','Gyn','Ortho','Uro','Other','ENT']:
        mk=sp==s; yy=y.values[mk]
        if yy.sum()>=3: r['within_spec_cv'][s]=dict(n=int(mk.sum()),pos=int(yy.sum()),auc=float(roc_auc_score(yy,po[mk])),ci=cboot(yy,po[mk],F.cluster_key.loc[idx].values[mk],roc_auc_score))
    # within-specialty on temporal test too
    p=np.mean([fit_pred(tr,te,y,s)[0] for s in range(3)],0); spt=F.spec.loc[te].values; r['within_spec_temporal']={}
    for s in ['GS','Gyn','Ortho','Uro']:
        mk=spt==s; yy=y.loc[te].values[mk]
        if yy.sum()>=3: r['within_spec_temporal'][s]=dict(n=int(mk.sum()),pos=int(yy.sum()),auc=float(roc_auc_score(yy,p[mk])),ci=cboot(yy,p[mk],F.cluster_key.loc[te].values[mk],roc_auc_score))
    print(lab,'done',flush=True)
out='work/mine_withpay.json' if WITHPAY else 'work/mine.json'
json.dump(R,open(out,'w'),indent=1)
def short(m): return f"n {m['n']}/{m['pos']} AUC {m['auc']:.3f} ({m['auc_ci'][0]:.2f}-{m['auc_ci'][1]:.2f}) PR {m['prauc']:.3f} Brier {m['brier']:.4f} ns(tr) {m['brier_noskill_trainprev']:.4f} ns(te) {m['brier_noskill_testprev']:.4f}"
for lab,r in R.items():
    print('==',lab,'train',r['train_n_pos'],'test',r['test_window'])
    for k in ['temporal_raw','temporal_cal','temporal_doc_rate_alone','temporal_JunJul_raw','cv']:
        if k in r: print(k,short(r[k]))
    print('cv per repeat',r['cv']['auc_per_repeat'],'cv doc alone',round(r['cv_doc_rate_alone_auc'],3))
    for g,v in sorted(r['perm'].items(),key=lambda kv:-kv[1]['mean']): print(f"  perm {g:16s} {v['mean']:+.4f} boot({v['boot'][0]:+.4f},{v['boot'][1]:+.4f})")
    for k in ['within_spec_cv','within_spec_temporal']:
        print(k,{s:f"{v['n']}/{v['pos']} {v['auc']:.2f} ({v['ci'][0]:.2f}-{v['ci'][1]:.2f})" for s,v in r[k].items()})
