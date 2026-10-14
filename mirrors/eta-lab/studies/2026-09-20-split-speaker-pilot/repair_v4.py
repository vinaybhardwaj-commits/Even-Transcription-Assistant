#!/usr/bin/env python3
"""Repair clips blocked by room_recording. Reuses the cutter's PROVEN fetch_span rather than
re-implementing it. The refusal blocks the JOIN path only, so a span inside one chunk succeeds;
each missing clip is re-sourced to another window from its TRUE doctor's own solo slot, keeping the
clip id, presented name and kind. Counts and clock times only."""
import datetime, json, os, tempfile, wave
from q import q
import roster_check as R
import cut_clips_v4 as C

D='/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot-v4'
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
hh=lambda ms: datetime.datetime.fromtimestamp(int(ms)/1000,IST).strftime('%H:%M:%S')
man=json.load(open(os.path.join(D,'manifest.json')))
used={(c['session_id'],c['start_ms']) for c in man['clips']}
missing=[c for c in man['clips'] if not os.path.isfile(os.path.join(D,'clips',c['id']+'.wav'))]
rooms,slots,_=R.load_roster()
print('repairing %d clip(s)' % len(missing))

def candidates(room_label, date, lo, hi):
    r=q("""select split_part(t.source_ref,'|',1) sess, split_part(t.source_ref,'|',2)::bigint s,
                  split_part(t.source_ref,'|',3)::bigint e
           from room_turn_speaker t join room_day rd on rd.id=t.room_day_id join room rm on rm.id=rd.room_id
           where rm.name like $1 and rd.ist_date=$2::date
             and split_part(t.source_ref,'|',3)::bigint - split_part(t.source_ref,'|',2)::bigint >= 10000
           order by split_part(t.source_ref,'|',2)::bigint""",[room_label+'%',date])
    out=[]
    for x in (r['rows'] if isinstance(r,dict) and 'rows' in r else r):
        s=int(x['s']); e=min(int(x['e']), s+20000)
        dt=datetime.datetime.fromtimestamp(s/1000,IST)
        if not (lo <= dt.hour*60+dt.minute < hi): continue
        if (x['sess'],s) in used: continue
        out.append((x['sess'],s,e))
    return out

ok=0
with tempfile.TemporaryDirectory() as tmp:
    for i,c in enumerate(missing,1):
        got=False
        for s in [s for s in slots if len(s['doctors'])==1 and c['true_doctor'] in s['doctors']]:
            for (sess,a,b) in candidates(s['room'].replace('ROOM ','OPD '), c['date'], s['start_min'], s['end_min']):
                pcm, meta = C.fetch_span({'session_id':sess,'start_ms':a,'end_ms':b}, tmp, i)
                if pcm is None: continue
                with wave.open(pcm,'rb') as w:
                    nch,sw,fr,nf=w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getnframes(); body=w.readframes(nf)
                bpf=nch*sw; x0=max(0,int(meta['base_ms']*fr/1000))*bpf
                x1=min(len(body), x0+int((b-a)*fr/1000)*bpf); body=body[x0:x1]
                got_ms=int(len(body)/bpf*1000/fr)
                if abs(got_ms-(b-a))>500: continue
                with wave.open(os.path.join(D,'clips',c['id']+'.wav'),'wb') as o:
                    o.setnchannels(nch); o.setsampwidth(sw); o.setframerate(fr); o.writeframes(body)
                c['session_id'],c['start_ms'],c['end_ms'],c['dur_ms']=sess,a,b,b-a
                used.add((sess,a)); ok+=1; got=True
                print('  %-16s %-8s -> %s  %.1fs asked, %.1fs got' % (c['present_as'],c['kind'],hh(a),(b-a)/1000,got_ms/1000))
                break
            if got: break
        if not got: print('  %-16s %-8s -> NO REPLACEMENT' % (c['present_as'],c['kind']))
fd=os.open(os.path.join(D,'manifest.json'), os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
with os.fdopen(fd,'w') as f: json.dump(man,f)
miss=[c for c in man['clips'] if not os.path.isfile(os.path.join(D,'clips',c['id']+'.wav'))]
print('repaired %d; readiness %d/%d' % (ok, len(man['clips'])-len(miss), len(man['clips'])))
