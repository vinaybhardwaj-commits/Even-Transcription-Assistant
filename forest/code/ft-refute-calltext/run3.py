import sys,os,json; exec(open('work/model.py').read())
assert set(D.split)=={'D'}
for df in (P,):
    pass
P=P.copy(); P['ale']=np.where(P.days_to_surgery<=14,1.0,np.where(P.age_days>=14,0.0,np.nan))
out=[]
for Tl in (3,7):
    E=P[P.ale.notna()&~(P.days_to_surgery<=Tl)]
    F,w=callfeats(E,0,lambda E:pd.Series(Tl,index=E.episode_id))
    ds=dict(zip(E.episode_id,E.days_to_surgery)); assert not (w.day>=w.episode_id.map(ds)).any(); assert (w.day<Tl).all(); assert not w.rev.any()
    out.append(run(E,E.ale.values,F,tag=f'ale-P-lm{Tl} payer=0 seed=0'))
json.dump(out,open('work/res3_ale.json','w'),indent=1); os.chmod('work/res3_ale.json',0o600)
