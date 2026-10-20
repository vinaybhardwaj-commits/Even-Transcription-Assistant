import json, math, collections, pandas as pd, numpy as np
O='~/oc/forest-lead/ft/out/ft-text2'
OBJ=['cost','insurance','fear','second_opinion','going_elsewhere','timing','family_decision','unreachable']
INT=['wants_surgery','undecided','declines']; NX=['visit_or_consult_scheduled','callback_agreed','details_to_be_sent']
TAGS=['outcome_revealed']+['obj_'+o for o in OBJ]+['intent_'+i for i in INT]+['next_'+n for n in NX]+['price_quoted']
def last(p):
    d={}
    for l in open(p):
        j=json.loads(l); d[j['call_id']]=j
    return d
def hb(r):
    ob=r.get('objections') or []
    b={'outcome_revealed':int(r.get('outcome_revealed') is True),'price_quoted':int(r.get('price_quoted') is True)}
    for o in OBJ: b['obj_'+o]=int(o in ob)
    for i in INT: b['intent_'+i]=int(r.get('intent')==i)
    for n in NX: b['next_'+n]=int(r.get('next_step')==n)
    return b
H={'S1':last('~/oc/forest-lead/ft/out/ft-calltext/tags_D.jsonl'),'S2':last('~/eta-data/forest/rl/feat/tags.jsonl'),'S3':last(f'{O}/tags_bolna.jsonl')}
print('haiku calls', {s:len(v) for s,v in H.items()})
# texts availability (ids only)
c=pd.read_parquet('~/oc/forest-lead/ft/out/ft-calltext/calls_D.parquet',columns=['call_id','summary'])
s1=set(c[c.summary.notna()].call_id)
s2=set(json.loads(l)['call_id'] for l in open('~/eta-data/forest/rl/feat/texts.jsonl'))
s3=set(pd.read_parquet(f'{O}/bolna_calls.parquet',columns=['bolna_id']).bolna_id)
TX={'S1':s1,'S2':s2,'S3':s3}
print('haiku with text', {s:len(set(H[s])&TX[s]) for s in H}, 'total', sum(len(set(H[s])&TX[s]) for s in H))
J={}; nerr=0; dup=0; jrows=0
for l in open(f'{O}/jev.jsonl'):
    r=json.loads(l); jrows+=1
    if 'p' in r:
        if (r['src'],r['call_id']) in J: dup+=1
        J[(r['src'],r['call_id'])]=r['p']
    else: nerr+=1
print('jev rows',jrows,'ok unique',len(J),'err rows',nerr,'dup ok',dup, 'models', collections.Counter(json.loads(l).get('model') for l in open(f'{O}/jev.jsonl')))
U=[(s,c) for s in H for c in H[s] if c in TX[s]]
miss=[x for x in U if x not in J]; print('universe',len(U),'missing jev',len(miss))
def kappa(a,b):
    a=np.array(a);b=np.array(b);po=(a==b).mean();pe=a.mean()*b.mean()+(1-a.mean())*(1-b.mean())
    return float('nan') if pe==1 else (po-pe)/(1-pe)
rows=[]
for t in TAGS:
    for src in ('S1','S2','S3','all'):
        xs=[x for x in U if x in J and (src=='all' or x[0]==src)]
        h=[hb(H[s][c])[t] for s,c in xs]; p=[J[(s,c)][t] for s,c in xs]
        hpos=sum(h); hpc=sum(1 for a,q in zip(h,p) if a==1 and q<0.2); hnc=sum(1 for a,q in zip(h,p) if a==0 and q>=0.8)
        rows.append(dict(tag=t,src=src,n=len(xs),hpos=hpos,jpos=sum(q>=0.5 for q in p),kappa=round(kappa(h,[int(q>=0.5) for q in p]),3),hpos_contra=hpc,hneg_contra=hnc,hpc_share=round(hpc/hpos,3) if hpos else None))
B=pd.DataFrame(rows); pd.set_option('display.width',250); pd.set_option('display.max_rows',100)
print(B.to_string(index=False))
# reference
R={}
for l in open(f'{O}/ref.jsonl'):
    r=json.loads(l)
    if 'lab' in r: R[(r['src'],r['call_id'])]=r
A=[(x['src'],x['call_id']) for x in json.load(open(f'{O}/sample_A.json'))]
print('A', collections.Counter(s for s,_ in A), 'A with ref', sum(x in R for x in A), 'A with jev', sum(x in J for x in A))
def wil(k,n,z=1.96):
    if n==0: return (None,None)
    ph=k/n; d=1+z*z/n; c=ph+z*z/(2*n); m=z*math.sqrt(ph*(1-ph)/n+z*z/(4*n*n)); return ((c-m)/d,(c+m)/d)
def auc(y,p):
    y=np.array(y);p=np.array(p)
    if y.sum()==0 or y.sum()==len(y): return float('nan')
    from scipy.stats import rankdata
    r=rankdata(p); n1=y.sum(); n0=len(y)-n1; return (r[y==1].sum()-n1*(n1+1)/2)/(n1*n0)
def ece(y,p):
    y=np.array(y);p=np.array(p); bi=np.minimum((p*10).astype(int),9); e=0
    for k in range(10):
        m=bi==k
        if m.any(): e+=m.sum()/len(y)*abs(p[m].mean()-y[m].mean())
    return e
arows=[]
for t in TAGS:
    xs=[x for x in A if x in R and x in J and t not in R[x]['unverified']]
    y=[R[x]['lab'][t] for x in xs]; h=[hb(H[x[0]][x[1]])[t] for x in xs]; p=[J[x][t] for x in xs]
    tp=sum(1 for a,b in zip(h,y) if a and b); hp=sum(h); rp=sum(y)
    jtp=sum(1 for q,b in zip(p,y) if q>=0.5 and b); jp=sum(q>=0.5 for q in p)
    lb=wil(tp,hp)[0]
    arows.append(dict(tag=t,n=len(xs),refpos=rp,hpos=hp,h_prec=round(tp/hp,3) if hp else None,h_prec_lb=round(lb,3) if lb is not None else None,h_rec=round(tp/rp,3) if rp else None,
        j_prec=round(jtp/jp,3) if jp else None,j_rec=round(jtp/rp,3) if rp else None,auc=round(auc(y,p),3),brier=round(float(np.mean((np.array(p)-np.array(y))**2)),3),ece=round(ece(y,p),3)))
AA=pd.DataFrame(arows); print(AA.to_string(index=False))
# arbitration
D=json.load(open(f'{O}/sample_C_draw.json'))
C=collections.defaultdict(lambda:[0,0,0])  # n_drawn, n_arbitrated, jev_right
for x in D:
    k=(x['src'],x['call_id']); C[(x['tag'],x['dir'])][0]+=1
    if k in R and x['tag'] not in R[k]['unverified']:
        C[(x['tag'],x['dir'])][1]+=1; y=R[k]['lab'][x['tag']]
        C[(x['tag'],x['dir'])][2]+= (y==0) if x['dir']=='hpos_jlow' else (y==1)
    # sanity: draw consistent with haiku/jev
    hv=hb(H[k[0]][k[1]])[x['tag']]; pv=J[k][x['tag']]
    assert (hv==1 and pv<0.2) if x['dir']=='hpos_jlow' else (hv==0 and pv>=0.8), x['tag']
    assert k not in set(A)
print('C draws',len(D),'unique',len({(x['src'],x['call_id']) for x in D}),'with ref',sum((x['src'],x['call_id']) in R for x in D))
V={}
for t in TAGS:
    b=B[(B.tag==t)&(B.src=='all')].iloc[0]; a=AA[AA.tag==t].iloc[0]
    hp=C[(t,'hpos_jlow')]; hn=C[(t,'hneg_jhigh')]
    drop= hp[1]>=5 and hp[2]>hp[1]/2 and b.hpos and b.hpos_contra/b.hpos>=0.2
    fl=[]
    if not (b.kappa>=0.4): fl.append(f'kappa{b.kappa}')
    if a.hpos>=5 and a.h_prec_lb is not None and a.h_prec_lb<0.5: fl.append(f'precLB{a.h_prec_lb}'+('(refpos<5)' if a.refpos<5 else ''))
    if hn[1]>=5 and hn[2]>hn[1]/2: fl.append(f'hneg_arb{hn[2]}/{hn[1]}')
    if a.ece>0.15: fl.append(f'ece{a.ece}')
    V[t]=('DROP' if drop else 'FLAG' if fl else 'KEEP', fl, 'hpos_arb', hp, 'hneg_arb', hn)
    print(t, V[t])
print(collections.Counter(v[0] for v in V.values()))
# union leak share
xs=[x for x in U if x in J]; h=[hb(H[s][c])['outcome_revealed'] or H[s][c].get('outcome_revealed_unverified') is True for s,c in xs]; j=[J[x]['outcome_revealed']>=0.8 for x in xs]
for src in ('S1','S2','S3','all'):
    m=[i for i,x in enumerate(xs) if src=='all' or x[0]==src]
    print('leak',src,'haiku(incl unverified)',sum(h[i] for i in m),'union',sum(h[i] or j[i] for i in m),'added',sum((not h[i]) and j[i] for i in m),'of',len(m))
B.to_csv('own_B.csv',index=False); AA.to_csv('own_A.csv',index=False)
