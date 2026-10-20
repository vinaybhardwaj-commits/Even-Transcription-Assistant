import pandas as pd,numpy as np,json,os
from scipy.stats import fisher_exact,mannwhitneyu
from statsmodels.stats.multitest import multipletests
import statsmodels.formula.api as smf
from statsmodels.stats.contingency_tables import StratifiedTable
from sklearn.metrics import roc_auc_score
X=pd.read_pickle('X_loose.pkl'); out={}
def tab(D,lab,name):
    D=D[D[lab].notna()]; y=D[lab]; rows=[]
    for f in ['jev_f02','jev_f03','jev_f05','jev_f06','jev_f07','jev_f18']:
        d=D[D[f].notna()]; b=d[f]>=0.5; a=[[int((b&(d[lab]==1)).sum()),int((~b&(d[lab]==1)).sum())],[int((b&(d[lab]==0)).sum()),int((~b&(d[lab]==0)).sum())]]
        p=fisher_exact(a)[1]; rows.append((f,f'{a[0][0]}/{a[0][0]+a[0][1]} ({100*a[0][0]/max(1,a[0][0]+a[0][1]):.0f}%) vs {a[1][0]}/{a[1][0]+a[1][1]} ({100*a[1][0]/max(1,a[1][0]+a[1][1]):.0f}%)',p))
    for f in ['doc_talk_share','patient_talk_share','turns_per_min','doc_interrupt_per_min','pat_interrupt_per_min','pat_valence','pat_arousal','val_change','aro_change','lang_en_share']:
        d=D[D[f].notna()]; p=mannwhitneyu(d[f][d[lab]==1],d[f][d[lab]==0])[1] if d[lab].nunique()==2 else np.nan; rows.append((f,f'n{len(d)}/{int(d[lab].sum())}',p))
    d=D[D.consult_lang.notna()]; en=d.consult_lang=='en-IN'; a=[[int((en&(d[lab]==1)).sum()),int((en&(d[lab]==0)).sum())],[int((~en&(d[lab]==1)).sum()),int((~en&(d[lab]==0)).sum())]]
    rows.append(('lang_en',f'{a[0][0]}/{sum(a[0])} vs {a[1][0]}/{sum(a[1])}',fisher_exact(a)[1]))
    ps=[r[2] for r in rows]; bh=multipletests(ps,method='fdr_bh')[1]; bo=multipletests(ps,method='bonferroni')[1]
    out[name]=dict(n=int(len(D)),pos=int(y.sum()),ntests=len(rows),rows=[(r[0],r[1],round(r[2],4),round(q,3),round(b,3)) for r,q,b in zip(rows,bh,bo)])
tab(X,'ale','ale'); tab(X[X.spec=='General Surgery'],'ale','ale_GS'); tab(X,'ale14','ale14'); tab(X,'h14','h14')
tab(X[X.age>=14],'ale','ale_age>=14')
L=X[X.ale.notna()].copy(); L['young']=(L.age<14).astype(int)
out['age_bias']=dict(recency_auc=round(roc_auc_score(L.ale,-L.age),3),young_pos=int(L.young.sum()),pos=int(L.ale.sum()),young_lags=sorted(L[L.young==1].lag.astype(int).tolist()))
# Jev items vs youth among positives; young pos vs older pos
for f in ['jev_f02','jev_f03','jev_f06','jev_f18','jev_f07']:
    P=L[(L.ale==1)&L[f].notna()]; out['age_bias'][f+'_pos_young_vs_old']=f'{int(((P[f]>=.5)&(P.young==1)).sum())}/{int(P.young.sum())} vs {int(((P[f]>=.5)&(P.young==0)).sum())}/{int((P.young==0).sum())}'
    N=L[(L.ale==0)&L[f].notna()]; out['age_bias'][f+'_neg_rate']=round(float((N[f]>=.5).mean()),2)
    out['age_bias'][f+'_auc_vs_age_among_labelled']=round(roc_auc_score((L[f]>=.5).astype(int)[L[f].notna()],-L.age[L[f].notna()]),3)
# adjusted: logit ale ~ item + GS + log age ; and CMH stratified by doctor
L['GS']=(L.spec=='General Surgery').astype(int); L['top2']=L.doc.isin(L[L.ale==1].doc.value_counts().index[:2]).astype(int)
adj={}
for f in ['jev_f02','jev_f03','jev_f06','jev_f18']:
    d=L[L[f].notna()].copy(); d['it']=(d[f]>=.5).astype(int)
    r={}
    for nm,fm in (('GS+age','ale ~ it + GS + np.log(age+1)'),('GS','ale ~ it + GS'),('top2doc+age','ale ~ it + top2 + np.log(age+1)')):
        try: m=smf.logit(fm,d).fit(disp=0); r[nm]=(round(float(np.exp(m.params['it'])),2),round(float(m.pvalues['it']),4))
        except Exception as e: r[nm]=str(e)[:40]
    tabs=[]
    for _,g in d.groupby('doc'):
        t=np.array([[((g.it==1)&(g.ale==1)).sum(),((g.it==1)&(g.ale==0)).sum()],[((g.it==0)&(g.ale==1)).sum(),((g.it==0)&(g.ale==0)).sum()]])
        if t.sum(0).min()>0 and t.sum(1).min()>0: tabs.append(t)
    st=StratifiedTable(tabs); r['CMH_by_doctor']=(round(float(st.oddsratio_pooled),2),round(float(st.test_null_odds().pvalue),4),len(tabs))
    adj[f]=r
out['adjusted']=adj
out['top2']=f"{int(L[L.top2==1].ale.sum())}/{int(L.ale.sum())} pos from 2 doctors; GS {int(L[L.GS==1].ale.sum())}/{int(L.GS.sum())}"
json.dump(out,open('desc.json','w'),indent=1,default=str); os.chmod('desc.json',0o600)
for k,v in out.items():
    print('==',k); 
    if isinstance(v,dict) and 'rows' in v:
        print(v['n'],v['pos'],'tests',v['ntests'])
        for r in v['rows']: print('  ',r)
    else: print(json.dumps(v,default=str,indent=0))
