import json,re,collections,hashlib,pandas as pd
L=[json.loads(x) for x in open('~/oc/forest-lead/ft/out/ft-calltext/tags_D.jsonl')]
C=pd.read_pickle('work/callsD.pkl'); txt=C.dropna(subset=['summary']).drop_duplicates('call_id').set_index('call_id').summary
ep_of=C.groupby('call_id').episode_id.apply(set)
norm=lambda t:re.sub(r'\s+',' ',t).strip()
st=collections.Counter(); keys=collections.Counter(); ex=[]
for r in L:
    t=txt.get(r['call_id'])
    if t is None: st['no_source']+=1; continue
    if r['episode_id'] not in ep_of[r['call_id']]: st['episode_mismatch']+=1
    n=norm(t); q=r['quotes']
    want=set(r['objections'])|({'intent'} if r['intent']!='not_stated' else set())|({'next_step'} if r['next_step']!='none' else set())|({'price_quoted'} if r['price_quoted'] else set())|({'outcome_revealed'} if r['outcome_revealed'] else set())
    for k in q: keys[k]+=1
    for k in want-set(q): st['set_tag_without_quote:'+k]+=1
    for k in set(q)-want: st['quote_without_set_tag:'+k]+=1
    if r['outcome_revealed_unverified']: st['or_unverified']+=1
    for k,v in q.items():
        s=v['quote']; st['quotes']+=1
        if len(s)<6: st['short']+=1
        if n[v['start']:v['end']]==s: st['exact_offset']+=1
        elif s in n: st['exact_elsewhere']+=1
        elif s in t: st['raw_only']+=1
        elif s.lower() in n.lower(): st['case_only']+=1
        else: st['FAIL']+=1; ex.append((r['call_id'][:6],k))
        if hashlib.sha256(s.encode()).hexdigest()[:12]!=v['sha']: st['sha_mismatch']+=1
print(dict(st)); print('quote keys',dict(keys)); print('fails',ex)
print('calls tagged',len(L),'unique',len({r['call_id'] for r in L}))
