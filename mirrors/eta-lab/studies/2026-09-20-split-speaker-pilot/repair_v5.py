#!/usr/bin/env python3
"""Re-source v5 clips blocked by room_recording. The refusal blocks the JOIN path only, so a span
inside one chunk succeeds; each missing clip is replaced by another run of the SAME true doctor's
own diarizer segments. Clip id, presented name and kind are kept. Counts and clock times only."""
import collections, datetime, json, os, re, tempfile, wave
from q import q
import roster_check as R
import cut_clips_v5 as C

D='/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot-v5'
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
hh=lambda ms: datetime.datetime.fromtimestamp(int(ms)/1000,IST).strftime('%H:%M:%S')
MIN_MS,MAX_MS,SPAN_MAX,GAP_MAX,SEAM=10000,20000,120000,5000,150
man=json.load(open(os.path.join(D,'manifest.json')))
missing=[c for c in man['clips'] if not os.path.isfile(os.path.join(D,'clips',c['id']+'.wav'))]
used={(c['session_id'],c['span_start_ms']) for c in man['clips']}
print('repairing %d' % len(missing))

rooms,slots,_=R.load_roster()
room_map={}
for r in R.rows("select id,name from room"):
    m=re.match(r'^\s*OPD\s*(\d+)',str(r['name'] or ''),re.I)
    if m and ('ROOM %s'%m.group(1)) in rooms.values(): room_map[r['id']]='ROOM %s'%m.group(1)
def owner(rn,ws):
    dt=datetime.datetime.fromtimestamp(ws/1000,IST); m0=dt.hour*60+dt.minute
    s=[s for s in slots if s['room']==rn and s['day']==R.DAYS[dt.weekday()] and not s['free']
       and s['start_min']<=m0<s['end_min'] and len(s['doctors'])==1]
    return s[0]['doctors'][0] if s else None
pool=collections.defaultdict(list)
for x in R.rows("""select w.id wid, w.session_id, w.start_ms wstart, rd.room_id, dw.segments_json
                   from room_diarize_window dw join bench_window w on w.id=dw.window_id
                   join room_day rd on rd.id=w.room_day_id
                   where dw.state='ok' and dw.segments_json is not null"""):
    rn=room_map.get(x['room_id'])
    if not rn: continue
    ws=int(x['wstart']); doc=owner(rn,ws)
    if not doc: continue
    segs=x['segments_json'] if isinstance(x['segments_json'],list) else json.loads(x['segments_json'])
    by=collections.defaultdict(list)
    for s in segs: by[s['speaker_idx']].append((s['start_ms'],s['end_ms']))
    for idx,ss in sorted(by.items()):
        ss.sort(); i=0
        while i<len(ss):
            j=i; own=0; run=[]
            while j<len(ss) and ss[j][1]-ss[i][0]<=SPAN_MAX and own<MAX_MS:
                if run and ss[j][0]-run[-1][1]>GAP_MAX: break
                a,b=ss[j]
                if own+(b-a)>MAX_MS: b=a+(MAX_MS-own)
                if b>a: run.append((a,b)); own+=b-a
                j+=1
                if own>=MIN_MS: break
            if own>=MIN_MS:
                pool[doc].append(dict(session_id=x['session_id'], wid=x['wid'], spk=idx,
                    span_start_ms=ws+run[0][0], span_end_ms=ws+run[-1][1],
                    segs=[[ws+a,ws+b] for a,b in run], own_ms=own, n_segs=len(run),
                    gaps=[run[k+1][0]-run[k][1] for k in range(len(run)-1)]))
                i=j
            else: i+=1

ok=0
with tempfile.TemporaryDirectory() as tmp:
    for n,c in enumerate(missing,1):
        for cand in pool.get(c['true_doctor'],[]):
            if (cand['session_id'],cand['span_start_ms']) in used: continue
            got,err=C.fetch(cand['session_id'],cand['span_start_ms'],cand['span_end_ms'],tmp,n)
            if got is None: continue
            pcm,base=got
            with wave.open(pcm,'rb') as w:
                nch,sw,fr,nf=w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getnframes(); body=w.readframes(nf)
            bpf=nch*sw; a=cand['span_start_ms']
            sil=b'\x00'*(int(fr*SEAM/1000)*bpf); pieces=[]
            for (s0,e0) in cand['segs']:
                x0=max(0,int((base+s0-a)*fr/1000))*bpf; x1=min(len(body),int((base+e0-a)*fr/1000)*bpf)
                if x1>x0: pieces.append(body[x0:x1])
            if not pieces: continue
            blob=sil.join(pieces); got_ms=int(len(blob)/bpf*1000/fr)
            want=cand['own_ms']+SEAM*(len(pieces)-1)
            if abs(got_ms-want)>500: continue
            with wave.open(os.path.join(D,'clips',c['id']+'.wav'),'wb') as o:
                o.setnchannels(nch); o.setsampwidth(sw); o.setframerate(fr); o.writeframes(blob)
            c.update({k:cand[k] for k in ('session_id','wid','spk','span_start_ms','span_end_ms','segs','own_ms','n_segs','gaps')})
            used.add((cand['session_id'],cand['span_start_ms'])); ok+=1
            print('  %-14s %-9s -> %s  %d seg  %.1fs' % (c['present_as'],c['kind'],hh(a),len(pieces),got_ms/1000))
            break
        else:
            print('  %-14s %-9s -> NO REPLACEMENT' % (c['present_as'],c['kind']))
fd=os.open(os.path.join(D,'manifest.json'), os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
with os.fdopen(fd,'w') as f: json.dump(man,f)
miss=[c for c in man['clips'] if not os.path.isfile(os.path.join(D,'clips',c['id']+'.wav'))]
print('repaired %d; readiness %d/%d'%(ok,len(man['clips'])-len(miss),len(man['clips'])))
