import sys,json,os,numpy as np,pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedKFold,StratifiedGroupKFold
from sklearn.metrics import roc_auc_score
lab=sys.argv[1]; var=sys.argv[2]; grp=sys.argv[3]; R=int(sys.argv[4]) if len(sys.argv)>4 else 20
X=pd.read_pickle(f'X_{var}.pkl'); X=X[X[lab].notna()].reset_index(drop=True); y=X[lab].values.astype(int)
for s in ('General Surgery','Orthopaedics','Urology'): X['sp_'+s[:4]]=(X.spec==s).astype(float)
X['sex_m']=(X.sex.astype(str).str.upper().str[0]=='M').astype(float); X['dg_m']=(X.doctor_gender.astype(str).str.upper().str[0]=='M').astype(float)
SP=['sp_Gene','sp_Orth','sp_Urol']
SETS={'pulse':SP+['prior','age_y','sex_m','dg_m','n_prior_rx'],
 'audio':SP+['prior','age_y','sex_m','dg_m','n_prior_rx','lang_en_share','doc_talk_share','pat_valence','jev_f03','jev_f18'],
 'audio_f07':SP+['prior','age_y','sex_m','dg_m','n_prior_rx','lang_en_share','doc_talk_share','pat_valence','jev_f03','jev_f18','jev_f07'],
 'audio_all':SP+['prior','age_y','sex_m','dg_m','n_prior_rx','lang_en_share','doc_talk_share','pat_valence','jev_f02','jev_f03','jev_f06','jev_f18'],
 'audio_only':['lang_en_share','doc_talk_share','pat_valence','jev_f02','jev_f03','jev_f06','jev_f18'],
 'spec':SP,'prior':['prior'],'f07':['jev_f07'],'recency':['age_days_neg']}
X['age_days_neg']=-X.age
def oof(cols,seed):
    M=X[cols].astype(float); M=M.fillna(M.median()) if False else M
    p=np.zeros(len(X)); 
    cv=StratifiedKFold(5,shuffle=True,random_state=seed) if grp=='patient' else StratifiedGroupKFold(5,shuffle=True,random_state=seed)
    sp=cv.split(M,y) if grp=='patient' else cv.split(M,y,groups=X.doc)
    for tr,te in sp:
        Mt=M.iloc[tr]; med=Mt.median()
        rf=RandomForestClassifier(300,max_depth=4,min_samples_leaf=5,class_weight='balanced',random_state=seed,n_jobs=-1).fit(Mt.fillna(med),y[tr])
        p[te]=rf.predict_proba(M.iloc[te].fillna(med))[:,1]
    return p
res={'lab':lab,'var':var,'grp':grp,'n':int(len(y)),'pos':int(y.sum()),'docs':int(X.doc.nunique())}
P={}; rng=np.random.default_rng(7); B=[rng.integers(0,len(y),len(y)) for _ in range(1000)]
for k,c in SETS.items():
    ps=[oof(c,s) for s in range(R)] if k not in ('f07','recency') else [X[c[0]].astype(float).fillna(X[c[0]].median()).values]
    rep=[roc_auc_score(y,p) for p in ps]; m=np.mean(ps,0); P[k]=m
    bs=[roc_auc_score(y[b],m[b]) for b in B if y[b].min()!=y[b].max()]
    res[k]=dict(auc_repmean=round(float(np.mean(rep)),3),auc_pooled=round(roc_auc_score(y,m),3),ci=[round(float(np.percentile(bs,2.5)),3),round(float(np.percentile(bs,97.5)),3)],rep_range=[round(min(rep),3),round(max(rep),3)])
for a,b in (('audio','pulse'),('audio_all','pulse'),('audio_f07','pulse')):
    d=[roc_auc_score(y[i],P[a][i])-roc_auc_score(y[i],P[b][i]) for i in B if y[i].min()!=y[i].max()]
    res[f'delta_{a}-{b}']=dict(d=round(res[a]['auc_repmean']-res[b]['auc_repmean'],3),ci=[round(float(np.percentile(d,2.5)),3),round(float(np.percentile(d,97.5)),3)])
# permutation importance (audio set, OOF permute in test fold, 5 repeats) 
if grp=='patient':
    c=SETS['audio']; M=X[c].astype(float); imp={f:[] for f in c}
    for s in range(5):
        for tr,te in StratifiedKFold(5,shuffle=True,random_state=100+s).split(M,y):
            med=M.iloc[tr].median(); rf=RandomForestClassifier(300,max_depth=4,min_samples_leaf=5,class_weight='balanced',random_state=s,n_jobs=-1).fit(M.iloc[tr].fillna(med),y[tr])
            Te=M.iloc[te].fillna(med)
            if y[te].min()==y[te].max(): continue
            base=roc_auc_score(y[te],rf.predict_proba(Te)[:,1]); r=np.random.default_rng(s)
            for f in c:
                T2=Te.copy(); T2[f]=r.permutation(T2[f].values); imp[f].append(base-roc_auc_score(y[te],rf.predict_proba(T2)[:,1]))
    res['perm_audio']={f:[round(float(np.mean(v)),3),round(float(np.percentile(v,2.5)),3),round(float(np.percentile(v,97.5)),3)] for f,v in imp.items()}
out=f'res_{lab}_{var}_{grp}.json'; json.dump(res,open(out,'w'),indent=0); os.chmod(out,0o600); print(json.dumps(res))
