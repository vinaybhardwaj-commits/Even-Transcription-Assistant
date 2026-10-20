"""Random-intercept logistic GLMM by adaptive Gauss-Hermite ML (own code), specialty + case mix fixed; latent ICC."""
import sys; sys.path.insert(0,"~/wt/ft-refute-doctors/work")
import numpy as np, pandas as pd
from scipy import optimize, stats, special
from feats import load, CASEMIX
import statsmodels.api as sm
gh_x,gh_w=np.polynomial.hermite.hermgauss(30)
def nll(theta,X,y,g,G):
    beta=theta[:-1]; s=np.exp(theta[-1]); eta=X@beta
    e=eta[:,None]+np.sqrt(2)*s*gh_x[None,:]
    ll=y[:,None]*e-np.logaddexp(0,e)
    LL=np.zeros((G,len(gh_x))); np.add.at(LL,g,ll)
    return -special.logsumexp(LL,b=gh_w[None,:]/np.sqrt(np.pi),axis=1).sum()
def fit(X,y,g,G,s0=0.3):
    b0=sm.GLM(y,X,family=sm.families.Binomial()).fit().params
    r=optimize.minimize(nll,np.r_[b0,np.log(s0)],args=(X,y,g,G),method='L-BFGS-B',bounds=[(None,None)]*X.shape[1]+[(-8,3)])
    return r
def design(coh,h,adj=True,extra=()):
    F=load(); d=coh.merge(F,on='prescription_uid',how='left'); assert d[CASEMIX].notna().all().all()
    S=pd.get_dummies(d.spec,drop_first=True).astype(float)
    cols=[c for c in CASEMIX+list(extra) if d[c].std()>0] if adj else []
    X=np.c_[np.ones(len(d)),S.values,d[cols].values]
    g=pd.factorize(d.doctor_uid)[0]; return X,d[h].values.astype(float),g,g.max()+1,d
icc=lambda s: s**2/(s**2+np.pi**2/3)
if __name__=='__main__':
    import sys
    out={}
    for h in ['h14','h90']:
        coh=pd.read_pickle(f'coh{h[1:]}.pkl')
        for adj in [False,True]:
            X,y,g,G,d=design(coh,h,adj)
            r=fit(X,y,g,G); s=np.exp(r.x[-1]); L1=-r.fun
            L0=sm.GLM(y,X,family=sm.families.Binomial()).fit().llf
            lr=2*(L1-L0); p=0.5*stats.chi2.sf(max(lr,0),1)
            # profile-likelihood 95% CI for sigma
            def prof(ls):
                rr=optimize.minimize(lambda b: nll(np.r_[b,ls],X,y,g,G),r.x[:-1],method='L-BFGS-B'); return -rr.fun
            crit=L1-stats.chi2.ppf(.95,1)/2
            lo_f=lambda ls: prof(ls)-crit
            try: lo=np.exp(optimize.brentq(lo_f,-6,r.x[-1]))
            except ValueError: lo=0.0
            hi=np.exp(optimize.brentq(lo_f,r.x[-1],np.log(4)))
            mor=np.exp(np.sqrt(2)*s*stats.norm.ppf(.75))
            print(h,'adj' if adj else 'unadj','n',len(y),'pos',int(y.sum()),'docs',G,'sigma %.3f ICC %.1f%% (PL95 %.1f-%.1f) MOR %.2f (%.2f-%.2f) LR-RE %.2f p_mix %.3f'%(s,100*icc(s),100*icc(lo),100*icc(hi),mor,np.exp(np.sqrt(2)*lo*.6745),np.exp(np.sqrt(2)*hi*.6745),lr,p),flush=True)
