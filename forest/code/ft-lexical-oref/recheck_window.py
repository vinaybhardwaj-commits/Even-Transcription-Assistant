import json,sys,collections,numpy as np,pandas as pd
sys.path.insert(0,'~/oc/forest-lead/ft/out/ft-lexical/code'); import common as C
its={i['item_id']:i for i in C.items()}; U=C.units(); L=C.label_map(U,'ale','episode')
dts=U[U.kind=='episode'].set_index('unit_id').days_to_surgery
th={}
for l in open(f'{C.W}/themes.jsonl'):
    r=json.loads(l); th[r['item_id']]=r
TH=['second_opinion','going_elsewhere','timing_later','doctor_named','reassurance','insurance_cashless','recovery_stay_explained']
rng=np.random.default_rng(20)
def run(design,T=None):
    out=[]
    for corpus in 'RS':
        rows=[r for r in th.values() if r['corpus']==corpus and r['unit_id'] in L]
        if design=='landmark':
            ok_u={u for u in L if not (dts.get(u)<=T)}
            rows=[r for r in rows if r['unit_id'] in ok_u and its[r['item_id']]['day_from_rx']<T]
        if design=='matched':
            pos_d=dts[[u for u in L if L[u]==1]].dropna().values
            cut={u:(dts[u] if L[u]==1 else rng.choice(pos_d)) for u in L}
            rows=[r for r in rows if its[r['item_id']]['day_from_rx']<cut[r['unit_id']]]
        has=collections.defaultdict(set); us=set()
        for r in rows:
            us.add(r['unit_id'])
            for k,v in r['themes'].items():
                if v: has[k].add(r['unit_id'])
        n1=sum(L[u] for u in us); n0=len(us)-n1
        for k in TH:
            a=sum(1 for u in has[k] if L[u]==1); b=len(has[k])-a
            out.append((design,T,corpus,k,f'{a}/{n1} {100*a/max(n1,1):.0f}%',f'{b}/{n0} {100*b/max(n0,1):.0f}%',round(C.fisher(a,n1,b,n0),4)))
    return out
res=run('all')+run('landmark',3)+run('landmark',7)+run('matched')
print(pd.DataFrame(res,columns=['design','T','corpus','theme','conv','non','p']).to_string())
