import json,collections,unicodedata,numpy as np,pandas as pd
from scipy.stats import fisher_exact
W='~/eta-data/forest/ft-lexical'
its=[json.loads(l) for l in open(f'{W}/items.jsonl')]; U=pd.read_parquet(f'{W}/units.parquet')
def lab(kind):
    u=U[U.kind==kind]; u=u[~u.amb_hash.fillna(False).astype(bool)] if kind=='episode' else u; u=u[u.ale.notna()]; return dict(zip(u.unit_id,u.ale.astype(int)))
def tok(t):
    s=''.join(c if unicodedata.category(c)[0] in 'LM' or c=="'" else ' ' for c in t.lower()); return [w.strip("'") for w in s.split() if w.strip("'")]
def grams(t): return t+[' '.join(t[i:i+2]) for i in range(len(t)-1)]+[' '.join(t[i:i+3]) for i in range(len(t)-2)]
def build(corpus,spk,okset):
    D=collections.defaultdict(collections.Counter)
    for it in its:
        if it['corpus']!=corpus: continue
        if okset and (it.get('role_src') or it.get('role_src_k')) not in okset: continue
        for s in it['segs']:
            if spk and s[0]!=spk: continue
            D[it['unit_id']].update(grams(tok(s[2])))
        D[it['unit_id']]
    return D
for corpus,spk,ok,kind,terms in (('R','counsellor',{'lexicon','lexicon_weak'},'episode',['insurance','card','calling from']),('S',None,None,'episode',['card','pan','dr','up']),
                                  ('K','doctor',{'llm-roles','text-judge','caa-labels','sarvam-doctor-map'},'consult',['day','and if you'])):
    L=lab(kind); D=build(corpus,spk,ok); ids=[u for u in D if u in L]; P=[u for u in ids if L[u]]; N=[u for u in ids if not L[u]]
    c1=sum((D[u] for u in P),collections.Counter()); c0=sum((D[u] for u in N),collections.Counter())
    full=c1+c0; a0=(sum(c1.values())+sum(c0.values()))/2; tot=sum(full.values()); n1=sum(c1.values()); n0=sum(c0.values())
    for w in terms:
        e1=sum(1 for u in P if D[u][w]); e0=sum(1 for u in N if D[u][w]); p=fisher_exact([[e1,len(P)-e1],[e0,len(N)-e0]])[1]
        a=a0*full[w]/tot; d=np.log((c1[w]+a)/(n1+a0-c1[w]-a))-np.log((c0[w]+a)/(n0+a0-c0[w]-a)); z=d/np.sqrt(1/(c1[w]+a)+1/(c0[w]+a))
        print(corpus,spk,w,f'{e1}/{len(P)} vs {e0}/{len(N)} p={p:.2g} z_fullvocab_prior={z:.2f}')
