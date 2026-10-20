import sys; sys.argv=['x']
exec(open('work/model.py').read().split('R={}')[0])
from sklearn.model_selection import StratifiedGroupKFold
for lab in ['h14','h90']:
    y=F[lab].dropna().astype(int); idx=y.index; oof=np.zeros((5,len(idx)))
    for rep in range(5):
        for k,(a,b) in enumerate(StratifiedGroupKFold(5,shuffle=True,random_state=100+rep).split(idx,y,F.cluster_key.loc[idx])):
            oof[rep,b]=fit_pred(idx[a],idx[b],y,rep*10+k)[0]
    po=oof.mean(0); s=F.spec_raw.loc[idx].values; cl=F.cluster_key.loc[idx].values
    print(lab,'pooled cv auc %.3f'%roc_auc_score(y,po))
    for sp in ['General Surgery','Gynaecology','Orthopaedics','Urology']:
        m=s==sp; yy=y.values[m]; print(' ',lab,sp,m.sum(),yy.sum(),'%.3f'%roc_auc_score(yy,po[m]),[round(x,2) for x in cboot(yy,po[m],cl[m],roc_auc_score)])
    m=~np.isin(s,['General Surgery','Gynaecology','Orthopaedics','Urology']); print('  other',m.sum(),y.values[m].sum(),'%.3f'%roc_auc_score(y.values[m],po[m]))
    # within-specialty mean AUC vs pooled: how much pooled AUC is between-specialty
