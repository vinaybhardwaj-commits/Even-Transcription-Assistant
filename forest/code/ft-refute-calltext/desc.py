exec(open('work/model.py').read().split('def docprior')[0])
from statsmodels.stats.proportion import proportion_confint
for H in ('h14','h90'):
    E=P[P[H].notna()]; ds=dict(zip(E.episode_id,E.days_to_surgery))
    w=C[C.episode_id.isin(E.episode_id)]; w=w[(w.day>=0)&(w.day<=14)&~(w.day>=w.episode_id.map(ds))]
    revE=set(w[w.rev].episode_id); y=dict(zip(E.episode_id,E[H]))
    print(H,'n',len(E),'pos',int(E[H].sum()),'rev eps conv',sum(y[e]==1 for e in revE),'notconv',sum(y[e]==0 for e in revE))
    t=w[w.tagged&~w.rev]; eps=sorted(set(t.episode_id)); yy=np.array([y[e] for e in eps])
    print(' tagged-nonrev eps',len(eps),'conv',int(yy.sum()))
    def share(fn):
        v=np.array([fn([T[c] for c in t[t.episode_id==e].call_id]) for e in eps]); return int(v[yy==1].sum()),int(v[yy==0].sum())
    res={}
    for o in OBJ: res[o]=share(lambda tg,o=o:any(o in x['objections'] for x in tg))
    res['wants_surgery']=share(lambda tg:any(x['intent']=='wants_surgery' for x in tg)); res['declines']=share(lambda tg:any(x['intent']=='declines' for x in tg))
    res['price']=share(lambda tg:any(x['price_quoted'] for x in tg)); res['any_obj']=share(lambda tg:any(x['objections'] for x in tg))
    n1,n0=int(yy.sum()),int((yy==0).sum())
    for k,(a,b) in res.items(): print(f'  {k:16s} {a}/{n1} ({100*a/n1:.0f}%) vs {b}/{n0} ({100*b/n0:.0f}%)')
    # parse-fail episodes in this table
    fe=[e for e in FAILEP if e in y]; print(' failed-parse eps in cohort',len(fe),'labels',[y[e] for e in fe],'of which in table',sum(e in eps for e in fe))
    if H=='h14':
        # worst/best: failed eps get going_elsewhere/timing = all present vs none
        for o in ('going_elsewhere','timing','insurance','cost','second_opinion'):
            a,b=res[o]; inn=[e for e in fe if e in eps]; out=[e for e in fe if e not in eps]
            # bound: for each failed episode, flag could flip to 1 (or stay as-is: tags from remaining calls only can be 0->1 only)
            add1=sum(y[e]==1 for e in fe); add0=sum(y[e]==0 for e in fe); n1b=n1+sum(y[e]==1 for e in out); n0b=n0+sum(y[e]==0 for e in out)
            print(f'   {o}: as-is {100*a/n1:.0f} vs {100*b/n0:.0f}; failed eps all-present {100*(a+add1)/n1b:.0f} vs {100*(b+add0)/n0b:.0f} (max shift conv +{add1}, not +{add0})')
        sp=dict(zip(E.episode_id,E.spec5))
        for s in ('GS','Gyn','Ortho','Uro','Other'):
            m=np.array([sp[e]==s for e in eps]); print('  ',s,m.sum(),int(yy[m].sum()),{o:(f"{100*np.mean([any(o in x['objections'] for x in [T[c] for c in t[t.episode_id==e].call_id]) for e in np.array(eps)[m&(yy==1)]]) if (m&(yy==1)).any() else float('nan'):.0f}/"+f"{100*np.mean([any(o in x['objections'] for x in [T[c] for c in t[t.episode_id==e].call_id]) for e in np.array(eps)[m&(yy==0)]]):.0f}") for o in ('going_elsewhere','timing','family_decision')})
