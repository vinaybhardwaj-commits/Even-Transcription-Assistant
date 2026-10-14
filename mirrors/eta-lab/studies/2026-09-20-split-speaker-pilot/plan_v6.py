#!/usr/bin/env python3
"""v6: SAME-or-DIFFERENT pairs. Nobody is named anywhere.

WHY PAIRS. v5 showed segment-building worked (2.8x confirmed audio) while the instrument did not
move (49% can't-tell, 40% of decided controls falsely confirmed). Identification asks a listener to
match a voice against a MEMORY; discrimination asks him to compare two things in front of him. The
second is the judgement we actually need: we do not need a name, we need to know which clips belong
together so they can be pooled. Naming happens once per pile, later.

CLIP RULE COMES FROM v5's OWN DATA, not taste: clips <=17.1 s were 68% can't-tell and clips >17.1 s
were 21% (p=0.008); clips of >3 segments were 62% vs 14% for <=3 (p=0.006). So every clip here is
>=18 s, at most 3 segments, gaps <=3 s. Pairing a saturating clip would reproduce v5's ceiling.

FOUR PAIR KINDS. identity (a clip against itself - a floor check; answering "different" means the
listener is not attending), same (one diarizer speaker, two different moments), different (two
doctors' slots), and open (same slot, DIFFERENT speaker indices - does the diarizer over-split?).
The open pairs are the prize: over-splitting is the mirror of the gluing already found.
"""
import collections, datetime, json, os, random, re, secrets
from q import q
import roster_check as R

OUT='/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot-v6'
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
MIN,MAXS,SPAN,GAP=18000,20000,60000,3000
N_ID,N_SAME,N_DIFF,N_OPEN=3,8,9,8
rnd=random.Random(20260921)

rooms,slots,_=R.load_roster()
rm={}
for r in R.rows("select id,name from room"):
    m=re.match(r'^\s*OPD\s*(\d+)',str(r['name'] or ''),re.I)
    if m and ('ROOM %s'%m.group(1)) in rooms.values(): rm[r['id']]='ROOM %s'%m.group(1)
def owner(rn,ws):
    dt=datetime.datetime.fromtimestamp(ws/1000,IST); m0=dt.hour*60+dt.minute
    s=[s for s in slots if s['room']==rn and s['day']==R.DAYS[dt.weekday()] and not s['free']
       and s['start_min']<=m0<s['end_min'] and len(s['doctors'])==1]
    return s[0]['doctors'][0] if s else None

pool=collections.defaultdict(lambda: collections.defaultdict(list))
for x in R.rows("""select w.id wid, w.session_id, w.start_ms ws, rd.room_id, dw.segments_json
                   from room_diarize_window dw join bench_window w on w.id=dw.window_id
                   join room_day rd on rd.id=w.room_day_id
                   where dw.state='ok' and dw.segments_json is not null"""):
    rn=rm.get(x['room_id'])
    if not rn: continue
    ws=int(x['ws']); doc=owner(rn,ws)
    if not doc: continue
    segs=x['segments_json'] if isinstance(x['segments_json'],list) else json.loads(x['segments_json'])
    by=collections.defaultdict(list)
    for s in segs: by[s['speaker_idx']].append((s['start_ms'],s['end_ms']))
    for idx,ss in sorted(by.items()):
        ss.sort(); i=0
        while i<len(ss):
            j=i; own=0; run=[]
            while j<len(ss) and ss[j][1]-ss[i][0]<=SPAN and own<MAXS and len(run)<3:
                if run and ss[j][0]-run[-1][1]>GAP: break
                a,b=ss[j]
                if own+(b-a)>MAXS: b=a+(MAXS-own)
                if b>a: run.append((a,b)); own+=b-a
                j+=1
            if own>=MIN and len(run)<=3:
                pool[doc][(x['wid'],idx)].append(dict(session_id=x['session_id'],wid=x['wid'],spk=idx,
                    doctor=doc, span_start_ms=ws+run[0][0], span_end_ms=ws+run[-1][1],
                    segs=[[ws+a,ws+b] for a,b in run], own_ms=own, n_segs=len(run)))
                i=j
            else: i+=1

clips={}; used=set()
def take(c):
    key=(c['session_id'],c['span_start_ms'])
    if key in clips: return clips[key]
    cid='k'+secrets.token_hex(4); c=dict(c, id=cid); clips[key]=c; return c

pairs=[]
def add(kind,a,b,note=''):
    pairs.append(dict(id='p'+secrets.token_hex(4), a=a['id'], b=b['id'], kind=kind,
                      truth=('same' if kind in ('identity','same') else
                             'different' if kind=='different' else 'unknown'), note=note))

docs=[d for d in pool if sum(len(v) for v in pool[d].values())>=2]
# SAME: one speaker key, two different moments
multi=[(d,k) for d in docs for k,v in pool[d].items() if len(v)>=2]
rnd.shuffle(multi)
for d,k in multi[:N_SAME]:
    v=sorted(pool[d][k], key=lambda c:c['span_start_ms'])
    a,b=take(v[0]),take(v[-1]); add('same',a,b,'%s spk%d'%(d,k[1]))
# OPEN: same window, different speaker indices
opens=[]
for d in docs:
    bywin=collections.defaultdict(list)
    for (wid,idx),v in pool[d].items(): bywin[wid].append((idx,v))
    for wid,lst in bywin.items():
        if len(lst)>=2:
            for i in range(len(lst)-1): opens.append((d,wid,lst[i],lst[i+1]))
rnd.shuffle(opens)
for d,wid,(i1,v1),(i2,v2) in opens[:N_OPEN]:
    add('open',take(v1[0]),take(v2[0]),'%s spk%d vs spk%d'%(d,i1,i2))
# DIFFERENT: two doctors
pd=[(d,k,v) for d in docs for k,v in pool[d].items()]
rnd.shuffle(pd)
seen=set()
for i in range(len(pd)):
    if len([p for p in pairs if p['kind']=='different'])>=N_DIFF: break
    for j in range(i+1,len(pd)):
        if pd[i][0]!=pd[j][0] and (pd[i][0],pd[j][0]) not in seen:
            seen.add((pd[i][0],pd[j][0])); add('different',take(pd[i][2][0]),take(pd[j][2][0]),
                                               '%s vs %s'%(pd[i][0],pd[j][0])); break
# IDENTITY: a clip against itself
for c in rnd.sample(list(clips.values()), N_ID):
    add('identity',c,c,'floor check')

order=[p['id'] for p in pairs]; rnd.shuffle(order)
os.makedirs(OUT,exist_ok=True)
man=dict(kind='pairs_v6', clips=list(clips.values()), pairs=pairs, order=order,
         pairmap={p['id']:[p['a'],p['b']] for p in pairs})
fd=os.open(os.path.join(OUT,'manifest.json'), os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
with os.fdopen(fd,'w') as f: json.dump(man,f)
cnt=collections.Counter(p['kind'] for p in pairs)
listen=sum((clips[k]['own_ms'] for k in clips))/1000.0
pair_ms=sum(next(c for c in clips.values() if c['id']==p['a'])['own_ms']+
            next(c for c in clips.values() if c['id']==p['b'])['own_ms'] for p in pairs)
print('pairs %d  %s'%(len(pairs), dict(cnt)))
print('distinct clips %d | clip length %.1f-%.1fs, segments %d-%d'
      %(len(clips), min(c['own_ms'] for c in clips.values())/1000,
        max(c['own_ms'] for c in clips.values())/1000,
        min(c['n_segs'] for c in clips.values()), max(c['n_segs'] for c in clips.values())))
print('distinct speakers represented: %d across %d doctors'
      %(len({(c['wid'],c['spk']) for c in clips.values()}), len({c['doctor'] for c in clips.values()})))
print('listening: %.1f min of pair playback (%.1f min distinct audio)'%(pair_ms/60000, listen/60))
