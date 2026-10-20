import pandas as pd, numpy as np, json, os, sys, random, re
from collections import Counter
H=os.path.expanduser
out=[]
def p(*a):
    s=' '.join(str(x) for x in a); print(s); out.append(s)
# ---- (1) split guard
sys.path.insert(0,H('~/wt/forest-rd0/studies/2026-10-16-runo-linkage/split'))
import split_guard as sg
sg.PINNED_SEED_SHA256='3b10cbf1f278ba072bded2e2bf0293a59035bc940f71ed5407b1a07509fbe750'
G=sg.load(H('~/eta-data/forest/split'),pinned_list_sha256='52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65')
p('guard ok lock',G.lock_id,'n_pairs',len(G.pairs),'seed_verified',G.seed is not None,'nH',G.n_held_out())
L=pd.read_parquet(H('~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'))
P=pd.read_parquet(H('~/oc/forest-lead/ft/out/ft-rl-feat/call_audio_feats.parquet'))
M=pd.read_csv(H('~/eta-data/forest/rl/manifest.tsv'),sep='\t',dtype=str); S=M[M.in_shard.notna()].copy()
p('parquet rows',len(P),'uniq ep',P.episode_id.nunique(),'split col',P.split.value_counts().to_dict())
Lp=L.set_index('episode_id')
miss=set(P.episode_id)-set(L.episode_id); p('parquet eps not in labels',len(miss))
p('labels split of parquet eps',Lp.loc[P.episode_id,'split'].value_counts().to_dict())
def gs(k):
    try: return G.set_of(k)
    except sg.UnknownKeyError: return 'UNK'
p('guard set of labels.cluster_key for parquet eps',Counter(gs(k) for k in Lp.loc[P.episode_id,'cluster_key']))
p('guard set of manifest patient_key (933 shard rows)',Counter(gs(k) for k in S.patient_key))
p('guard set of manifest patient_key (all 1407 rows)',Counter(gs(k) for k in M.patient_key))
p('manifest(all) eps by labels split',Counter(Lp.split.get(e,'NOTINLABELS') for e in M.episode_id))
p('shard eps by labels split',Counter(Lp.split.get(e,'NOTINLABELS') for e in S.episode_id.unique()))
# STT jsons: any H?
stt=os.listdir(H('~/eta-data/forest/rl/stt')); sk={f[:-5] for f in stt if f.endswith('.json')}
p('stt files',len(stt),'match shard keys',len(sk&set(S.key_id)),'stt not in shard',len(sk-set(S.key_id)))
ep_of={}
for f in stt:
    d=json.load(open(H('~/eta-data/forest/rl/stt/'+f))); ep_of[d['key_id']]=d['episode_id']
p('stt json eps by labels split',Counter(Lp.split.get(e,'NOTINLABELS') for e in set(ep_of.values())))
for fn in ['calls_basic.parquet']:
    C=pd.read_parquet(H('~/eta-data/forest/rl/feat/'+fn))
p('calls_basic eps split',Counter(Lp.split.get(e,'NOTINLABELS') for e in C.episode_id.unique()))
# ---- (2) windows
S['d']=S.day_from_rx.astype(int)
S=S.merge(L[['episode_id','rx_date','event_date','h14','h90','consult_ist']],on='episode_id',how='left')
S['cd']=pd.to_datetime(S.call_date); S['rx']=pd.to_datetime(S.rx_date).dt.normalize()
p('day_from_rx == call_date-rx_date:',((S.cd-S.rx).dt.days==S.d).sum(),'of',len(S),' d<0:',(S.d<0).sum(),' d>=14:',(S.d>=14).sum())
S['ev']=pd.to_datetime(S.event_date)
pe=S.ev.notna()&(S.cd>=S.ev); p('calls on/after event_date',int(pe.sum()),' eps with event',S[S.ev.notna()].episode_id.nunique())
T=[json.loads(l) for l in open(H('~/eta-data/forest/rl/feat/tags.jsonl'))]
last={}; anyor={}
for t in T: last[t['call_id']]=t; anyor[t['call_id']]=anyor.get(t['call_id'],False) or t['outcome_revealed']
S['tagged']=S.key_id.isin(last)
S['orv']=S.key_id.map(lambda k: last[k]['outcome_revealed'] if k in last else False)
S['orv_any']=S.key_id.map(lambda k: anyor.get(k,False))
S['oru']=S.key_id.map(lambda k: last[k].get('outcome_revealed_unverified',False) if k in last else False)
p('tagged calls',S.tagged.sum(),'untagged',(~S.tagged).sum(),'outcome_revealed(last tag)',S.orv.sum(),'(any rerun)',S.orv_any.sum(),'unverified-OR flag',S.oru.sum())
S['keep']=S.tagged & ~S.orv & ~pe
res={}
for Tw in (3,7,14):
    w=S[S.keep & (S.d<Tw)]
    eps=w.episode_id.unique(); e=L[L.episode_id.isin(eps)]
    h14=e.h14.dropna(); h90=e.h90.dropna()
    p(f'T={Tw}: eps {len(eps)} calls {len(w)}  h14 {int(h14.sum())}/{len(h14)}  h90 {int(h90.sum())}/{len(h90)}')
    # compare with parquet n_calls_tX
    pc=P.set_index('episode_id')[f'n_calls_t{Tw}']
    mine=w.groupby('episode_id').size().reindex(P.episode_id).fillna(0).astype(int)
    p(f'  parquet n_calls_t{Tw}>0 eps',(pc>0).sum(),'sum',int(pc.sum()),' mismatched eps vs mine',int((pc.values!=mine.values).sum()))
    # alternative: any-rerun OR
    w2=S[S.tagged & ~S.orv_any & ~pe & (S.d<Tw)]; p(f'  (if any-rerun OR dropped) eps {w2.episode_id.nunique()} calls {len(w2)}')
    # landmark for h14 positives: event before T?
    ev_in=e[(e.days_to_surgery.notna())&(e.days_to_surgery<Tw)]
    p(f'  eps whose event day < T (outcome already happened before landmark): {len(ev_in)}')
# day0 calls before consult time?
S['cts']=pd.to_datetime(S.call_ts,errors='coerce'); S['cst']=pd.to_datetime(S.consult_ist,errors='coerce')
z=S[S.d==0]; p('day0 calls',len(z),' call_ts < consult_ist:',int((z.cts<z.cst).sum()),' consult_ist null',int(z.cst.isna().sum()))
S.to_parquet('S.parquet')
open('recompute.out','w').write('\n'.join(out)+'\n')
