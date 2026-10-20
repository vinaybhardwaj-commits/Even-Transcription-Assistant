import pandas as pd, numpy as np, json, os, random, re, hashlib
from collections import Counter
H=os.path.expanduser
out=[]
def p(*a):
    s=' '.join(str(x) for x in a); print(s); out.append(s)
X={json.loads(l)['call_id']:json.loads(l)['text'] for l in open(H('~/eta-data/forest/rl/feat/texts.jsonl'))}
T=[json.loads(l) for l in open(H('~/eta-data/forest/rl/feat/tags.jsonl'))]
last={}
for t in T: last[t['call_id']]=t
c=Counter(); keys=Counter()
for scope,tags in (('all_lines',T),('last_per_call',list(last.values()))):
    c=Counter()
    for t in tags:
        tx=X.get(t['call_id'])
        for k,q in t['quotes'].items():
            c['quotes']+=1
            s=q.get('quote') or ''
            if not s: c['empty']+=1; continue
            sub = tx is not None and s in tx
            off = tx is not None and q.get('start') is not None and tx[q['start']:q['end']]==s
            c['substr_ok' if sub else 'NOT_SUBSTR']+=1
            if not off: c['offset_mismatch']+=1
            if sub and len(s)<8: c['short_lt8']+=1
            keys[k.split(':')[0]]+=1
    p(scope,dict(c))
# do tagged fields without a quote exist? (claims kept without evidence)
nq=Counter()
for t in last.values():
    for o in t['objections']:
        if f'obj:{o}' not in t['quotes']: nq['objection_without_quote']+=1
    if t['next_step'] not in (None,'none','not_stated') and 'next_step' not in t['quotes']: nq['next_step_without_quote']+=1
    if t['intent'] not in (None,'not_stated') and not any(k.startswith('intent') for k in t['quotes']): nq['intent_without_quote']+=1
    if t['price_quoted'] and not any(k.startswith('price') for k in t['quotes']): nq['price_without_quote']+=1
    if t['outcome_revealed'] and not any(k.startswith('outcome') for k in t['quotes']): nq['OR_without_quote']+=1
p('fields w/o quote (last tags):',dict(nq),' quote key types',dict(keys))
p('intent vals',Counter(t['intent'] for t in last.values()),'next',Counter(t['next_step'] for t in last.values()))
# ---- (3) talk-time from STT json, 50 random calls
C=pd.read_parquet(H('~/eta-data/forest/rl/feat/calls_basic.parquet')).set_index('call_id')
random.seed(20261020); ks=random.sample(sorted(C.index),50)
rows=[]
for k in ks:
    d=json.load(open(H(f'~/eta-data/forest/rl/stt/{k}.json')))
    r=d['result']['0.json']; E=(r.get('diarized_transcript') or {}).get('entries') or []
    sp={}; w={}; turns=0; prev=None
    for e in E:
        s=e['speaker_id']; du=e['end_time_seconds']-e['start_time_seconds']
        sp[s]=sp.get(s,0)+du; w[s]=w.get(s,0)+len(e['transcript'].split())
        if s!=prev: turns+=1; prev=s
    span=(E[-1]['end_time_seconds']-E[0]['start_time_seconds']) if E else 0
    secs=sorted(sp.values(),reverse=True); ws=sorted(w.values(),reverse=True)
    b=C.loc[k]
    rows.append(dict(k=k,nsp=len(sp),b_nsp=b.n_speakers,nseg=len(E),b_nseg=b.n_segs,speech=sum(sp.values()),b_speech=b.speech_s,
        words=sum(w.values()),b_words=b.words_total,span=span,b_span=b.call_span_s,turns=turns,
        tpm_span=turns/(span/60) if span else np.nan, tpm_dur=turns/(d['duration_s']/60), b_tpm=b.turns_per_min,
        top_s=secs[0] if secs else 0, second_s=sum(secs[1:]), b_c=b.counsellor_s, b_p=b.patient_s,
        role=b.role_src, mostwords_is_c=(len(ws)>1 and ws[0]==(b.counsellor_words)), b_pshare=b.patient_talk_share))
R=pd.DataFrame(rows); R.to_parquet('talk50.parquet')
def agree(a,b,tol): return int((np.isclose(R[a],R[b],atol=tol,rtol=0.01)|(R[a].isna()&R[b].isna())).sum())
for a,b,tol in [('nsp','b_nsp',0),('nseg','b_nseg',0),('speech','b_speech',0.05),('words','b_words',0),('span','b_span',0.05),('tpm_span','b_tpm',0.05),('tpm_dur','b_tpm',0.05)]:
    p(f'talk50 {a} vs {b}: agree {agree(a,b,tol)}/50  max_abs_diff {np.nanmax(np.abs(R[a]-R[b])):.3f}')
two=R[R.nsp>=2]
pair_ok=((np.isclose(two.top_s,np.maximum(two.b_c,two.b_p),atol=.05))&(np.isclose(two.second_s,np.minimum(two.b_c,two.b_p),atol=.05))).sum()
p('talk50 >=2-speaker calls',len(two),' speaker-seconds {top, rest} match {counsellor_s,patient_s}:',int(pair_ok))
p('talk50 n_speakers dist',R.nsp.value_counts().to_dict())
# ---- (4) roles over all 933
p('role_src',C.role_src.value_counts().to_dict(), 'n_speakers dist',C.n_speakers.value_counts().to_dict())
lex=C[C.role_src=='lexicon']
p('lexicon calls where lexicon-counsellor also has more words:',int((lex.counsellor_words>lex.patient_words).sum()),'/',len(lex))
fb=C[C.role_src=='talk_fallback']
p('fallback calls: |c_words-p_words|/total median',round(float(((fb.counsellor_words-fb.patient_words).abs()/(fb.counsellor_words+fb.patient_words)).median()),3),
  ' share near-tie (<20% gap):',round(float((((fb.counsellor_words-fb.patient_words).abs()/(fb.counsellor_words+fb.patient_words))<0.2).mean()),3))
p('patient_talk_share mean lexicon',round(lex.patient_talk_share.mean(),3),'fallback',round(fb.patient_talk_share.mean(),3))
p('patient windows from fallback calls:',int(fb.n_windows_patient.sum()),'of',int(C.n_windows_patient.sum()))
S=pd.read_parquet('S.parquet'); keep=set(S[S.keep].key_id)
for Tw in (3,7,14):
    w=C[C.index.isin(keep)&(C.day_from_rx<Tw)]
    pw=w.groupby('episode_id').apply(lambda g:(g.role_src=='talk_fallback').mean())
    pwin=w.groupby('episode_id').apply(lambda g:g[g.role_src=='talk_fallback'].n_windows_patient.sum()/max(g.n_windows_patient.sum(),1))
    P=pd.read_parquet(H('~/oc/forest-lead/ft/out/ft-rl-feat/call_audio_feats.parquet')).set_index('episode_id')
    rf=P[f'role_fallback_share_t{Tw}'].dropna()
    p(f'T={Tw}: eps all-fallback {int((pw==1).sum())}/{len(pw)}; any-lexicon {int((pw<1).sum())}; patient-window share from fallback (median ep) {pwin.median():.2f}; parquet role_fallback_share mean {rf.mean():.3f} vs mine {pw.mean():.3f}')
open('recompute2.out','w').write('\n'.join(out)+'\n')
