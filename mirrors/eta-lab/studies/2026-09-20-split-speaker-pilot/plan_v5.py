#!/usr/bin/env python3
"""Roll call v5: harvest by DIARIZER SEGMENT, not turn span.

CONFIRMED BEFORE BUILDING: across 146 long turns the named speaker owns a median 15% of the turn
span; for the NAMED long turns, 0.9-5.5 s inside 46-204 s spans (0-11%). Diarizer segments are clean
and short (median 1.1 s, p90 6.3 s). So the diarizer is not broken; turn assembly is. v4 cut by span
and was therefore playing V ~85-95% the wrong person, which is why 71% of long-block clips came back
"can't tell".

A clip is ONE diarizer speaker inside ONE window. speaker_idx is window-local, so segments are never
concatenated across windows, and never across speakers. Adjacent same-speaker segments are joined to
reach 10-20 s with a short audible seam.

DIAGNOSTIC ARM: a few clips are cut the OLD way (turn span), unmarked, so V's same ear in the same
sitting shows whether the fix works. Nobody is enrolled and no centroid is touched.
"""
import collections, datetime, json, os, random, re, secrets
from q import q
import roster_check as R

OUT='/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot-v5'
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
DOCS=['Shankar','Manoj','Prerana','Sajeet Nayar','Soujanya','Prashanth']
PER,MIN_MS,MAX_MS,SPAN_MAX,GAP_MAX=8,10000,20000,120000,5000
CONTROLS={0:2,1:2,2:2,3:2,4:1,5:1}
DIAG=['Shankar','Soujanya','Prashanth']          # the three that yielded 0 s in v4
rnd=random.Random(20260920)

rooms,slots,_=R.load_roster()
room_map={}
for r in R.rows("select id,name from room"):
    m=re.match(r'^\s*OPD\s*(\d+)',str(r['name'] or ''),re.I)
    if m and ('ROOM %s'%m.group(1)) in rooms.values(): room_map[r['id']]='ROOM %s'%m.group(1)

wins=R.rows("""select w.id wid, w.session_id, w.start_ms wstart, rd.room_id, rd.ist_date::text dt,
                      dw.segments_json
               from room_diarize_window dw join bench_window w on w.id=dw.window_id
               join room_day rd on rd.id=w.room_day_id
               where dw.state='ok' and dw.segments_json is not null""")

def owner(rn, ws):
    dt=datetime.datetime.fromtimestamp(ws/1000,IST); m0=dt.hour*60+dt.minute
    s=[s for s in slots if s['room']==rn and s['day']==R.DAYS[dt.weekday()] and not s['free']
       and s['start_min']<=m0<s['end_min'] and len(s['doctors'])==1]
    return s[0]['doctors'][0] if s else None

pool=collections.defaultdict(list)
for x in wins:
    rn=room_map.get(x['room_id'])
    if not rn: continue
    ws=int(x['wstart']); doc=owner(rn,ws)
    if doc not in DOCS: continue
    segs=x['segments_json'] if isinstance(x['segments_json'],list) else json.loads(x['segments_json'])
    by=collections.defaultdict(list)
    for s in segs: by[s['speaker_idx']].append((s['start_ms'],s['end_ms']))
    for idx,ss in sorted(by.items()):
        ss.sort(); i=0
        while i<len(ss):
            j=i; own=0; run=[]
            while j<len(ss) and ss[j][1]-ss[i][0]<=SPAN_MAX and own<MAX_MS:
                if run and ss[j][0]-run[-1][1] > GAP_MAX: break     # keep a clip continuous
                a,b=ss[j]
                if own+(b-a) > MAX_MS: b=a+(MAX_MS-own)             # truncate to the cap, never exceed
                if b>a: run.append((a,b)); own+=b-a
                j+=1
                if own>=MIN_MS: break
            if own>=MIN_MS:
                gaps=[run[k+1][0]-run[k][1] for k in range(len(run)-1)]
                pool[doc].append(dict(session_id=x['session_id'], wid=x['wid'], spk=idx,
                    span_start_ms=ws+run[0][0], span_end_ms=ws+run[-1][1],
                    segs=[[ws+a,ws+b] for a,b in run], own_ms=own, n_segs=len(run),
                    gaps=gaps, date=x['dt'], room=rn))
                i=j
            else: i+=1

# old-style turn-span candidates for the diagnostic arm
tspan=collections.defaultdict(list)
for t in R.rows("""select split_part(source_ref,'|',1) sess, split_part(source_ref,'|',2)::bigint s,
                          split_part(source_ref,'|',3)::bigint e, rd.room_id, rd.ist_date::text dt
                   from room_turn_speaker t join room_day rd on rd.id=t.room_day_id
                   where split_part(source_ref,'|',3)::bigint-split_part(source_ref,'|',2)::bigint>=40000"""):
    rn=room_map.get(t['room_id'])
    if not rn: continue
    doc=owner(rn,int(t['s']))
    if doc in DIAG:
        a=int(t['s'])+20000; b=a+MAX_MS
        tspan[doc].append(dict(session_id=t['sess'], wid=None, spk=None, span_start_ms=a, span_end_ms=b,
                               segs=[[a,b]], own_ms=MAX_MS, n_segs=1, gaps=[], date=t['dt'], room=rn))

clips=[]
for i,d in enumerate(DOCS):
    nc=CONTROLS[i]; ng=PER-nc
    cand=pool[d]
    seen=set(); pick=[]
    for c in sorted(cand, key=lambda c:(-c['own_ms'])):          # prefer the most speech
        k=(c['wid'],c['spk'])
        if k in seen and len(seen)>=3: continue                   # spread across window/speaker
        seen.add(k); pick.append(c)
        if len(pick)>=ng: break
    for c in pick:
        clips.append(dict(c, id='k'+secrets.token_hex(4), present_as=d, true_doctor=d,
                          kind='genuine', mode='segment'))
    others=[o for o in DOCS if o!=d and pool[o]]
    for k in range(nc):
        src=others[k%len(others)]; y=rnd.choice(pool[src])
        clips.append(dict(y, id='k'+secrets.token_hex(4), present_as=d, true_doctor=src,
                          kind='control', mode='segment'))
    if d in DIAG and tspan[d]:
        y=rnd.choice(tspan[d])
        clips.append(dict(y, id='k'+secrets.token_hex(4), present_as=d, true_doctor=d,
                          kind='diagnostic', mode='turnspan'))

order=[]
for d in DOCS:
    g=[c['id'] for c in clips if c['present_as']==d]; rnd.shuffle(g); order+=g
os.makedirs(OUT,exist_ok=True)
man=dict(kind='rollcall_v5', doctors=DOCS, clips=clips, order=order,
         names={c['id']:c['present_as'] for c in clips})
fd=os.open(os.path.join(OUT,'manifest.json'), os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
with os.fdopen(fd,'w') as f: json.dump(man,f)

seg=[c for c in clips if c['mode']=='segment']
allg=[g for c in seg for g in c['gaps']]
print('clips %d = %d segment-built + %d turn-span diagnostic | controls %d'
      % (len(clips), len(seg), sum(1 for c in clips if c['mode']=='turnspan'),
         sum(1 for c in clips if c['kind']=='control')))
print('segments per clip: min %d median %d max %d' % (min(c['n_segs'] for c in seg),
      sorted(c['n_segs'] for c in seg)[len(seg)//2], max(c['n_segs'] for c in seg)))
if allg:
    allg.sort(); print('gaps between joined segments (ms): median %d p90 %d max %d'
                       % (allg[len(allg)//2], allg[int(len(allg)*.9)], allg[-1]))
print('own audio per clip: %.1f-%.1fs | total listening %.1f min'
      % (min(c['own_ms'] for c in seg)/1000, max(c['own_ms'] for c in seg)/1000,
         sum(c['own_ms'] for c in clips)/60000))
for d in DOCS:
    g=[c for c in clips if c['present_as']==d]
    print('  %-14s %d clips (%d genuine, %d control, %d diagnostic)' % (d,len(g),
          sum(1 for x in g if x['kind']=='genuine'), sum(1 for x in g if x['kind']=='control'),
          sum(1 for x in g if x['kind']=='diagnostic')))
