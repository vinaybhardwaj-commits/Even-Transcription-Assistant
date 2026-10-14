#!/usr/bin/env python3
"""Roll call v4: labelled ROOM-DOMAIN enrolment audio for doctors who have never enrolled.

NOT a verification test. V's ear is the labeller. Each clip is presented UNDER A DOCTOR'S NAME
because this is identification, not a blind test.

THE CONTROL IS THE POINT. ~20% of clips come from a DIFFERENT doctor's solo slot and are presented
under the first doctor's name. If V confirms one of those, roster-based labelling is not
trustworthy and the enrolment-harvest idea fails. Controls are shuffled inside each doctor's group
so they cannot be predicted.

Shared slots are excluded entirely: enrolling one doctor on another's voice would poison a centroid
that six of seven prints keep no audio to undo. Nobody is enrolled here and no centroid is touched.
"""
import datetime, json, os, random, re, secrets, collections
from q import q
import roster_check as R

OUT='/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot-v4'
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
DAYS=R.DAYS
PER_DOCTOR, CLIP_MIN, CLIP_MAX = 8, 10000, 20000
CONTROLS = {0:2, 1:2, 2:2, 3:2, 4:1, 5:1}     # 10 of 48 = 21%
hhmm=lambda ms: datetime.datetime.fromtimestamp(int(ms)/1000,IST).strftime('%H:%M:%S')

rooms, slots, _ = R.load_roster()
clin=R.rows("select id, full_name from clinician")
vp={x['doctor_id'] for x in R.rows("select distinct doctor_id from voice_print")}
def norm(x):
    x=re.sub(r'\bdrs?\b',' ',str(x or '').lower()); x=re.sub(r'[^a-z ]',' ',x)
    return re.sub(r'\s+',' ',x).strip()
def match(n):
    nn=norm(n); nt=set(nn.split())
    ex=[c for c in clin if norm(c['full_name'])==nn]
    if len(ex)==1: return ex[0]['id']
    sub=[c for c in clin if nt and nt<=set(norm(c['full_name']).split())]
    return sub[0]['id'] if len(sub)==1 else None
room_map={}
for r in R.rows("select id,name from room"):
    m=re.match(r'^\s*OPD\s*(\d+)',str(r['name'] or ''),re.I)
    if m and ('ROOM %s'%m.group(1)) in rooms.values(): room_map[r['id']]='ROOM %s'%m.group(1)

turns=R.rows("""select rd.room_id, rd.ist_date::text d,
                       split_part(t.source_ref,'|',1) sess,
                       split_part(t.source_ref,'|',2)::bigint s,
                       split_part(t.source_ref,'|',3)::bigint e
                from room_turn_speaker t join room_day rd on rd.id=t.room_day_id""")

# every turn -> the SOLO rostered doctor whose slot contains it (shared slots dropped outright)
owned=collections.defaultdict(list)
for t in turns:
    rn=room_map.get(t['room_id'])
    if not rn: continue
    dt=datetime.datetime.fromtimestamp(int(t['s'])/1000,IST); mins=dt.hour*60+dt.minute
    for s in slots:
        if s['room']!=rn or s['day']!=DAYS[dt.weekday()] or s['free']: continue
        if not (s['start_min']<=mins<s['end_min']): continue
        if len(s['doctors'])!=1: break            # shared -> excluded entirely
        owned[s['doctors'][0]].append(dict(room=rn, date=t['d'], sess=t['sess'],
                                           s=int(t['s']), e=int(t['e']), dur=int(t['e'])-int(t['s'])))
        break

def windows_from(turn, want):
    """10-20 s windows. A turn longer than CLIP_MAX is SAMPLED from inside, spaced apart, because a
    200 s 'turn' is very likely a glued block and we want different moments of it."""
    out=[]
    if turn['dur']<CLIP_MIN: return out
    if turn['dur']<=CLIP_MAX:
        out.append((turn['s'], turn['e']))
    else:
        n=min(want, max(1, turn['dur']//45000))
        for i in range(n):
            off=int(turn['dur']*(i+1)/(n+1))-CLIP_MAX//2
            off=max(0,min(off,turn['dur']-CLIP_MAX))
            out.append((turn['s']+off, turn['s']+off+CLIP_MAX))
    return out

DOCS=[d for d,_ in sorted(((d,sum(x['dur'] for x in v if x['dur']>=6000)) for d,v in owned.items()),
                          key=lambda kv:-kv[1]) if match(d) not in vp][:6]
rnd=random.Random(20260920)
pool={}
for d in DOCS:
    cands=[]
    for t in sorted(owned[d], key=lambda x:x['s']):
        for (a,b) in windows_from(t, 4): cands.append(dict(t, s=a, e=b, dur=b-a))
    # spread across the doctor's own timeline
    cands.sort(key=lambda x:x['s'])
    pool[d]=cands

clips=[]
for i,d in enumerate(DOCS):
    n_ctl=CONTROLS[i]; n_gen=PER_DOCTOR-n_ctl
    c=pool[d]
    pick=[c[round(k*(len(c)-1)/max(1,n_gen-1))] for k in range(n_gen)] if len(c)>=n_gen else c[:]
    seen=set(); genuine=[]
    for x in pick:
        if x['s'] in seen: continue
        seen.add(x['s']); genuine.append(x)
    while len(genuine)<n_gen and len(genuine)<len(c):
        for x in c:
            if x['s'] not in seen: seen.add(x['s']); genuine.append(x); break
    for x in genuine:
        clips.append(dict(id='k'+secrets.token_hex(4), present_as=d, true_doctor=d, kind='genuine',
                          room=x['room'], date=x['date'], session_id=x['sess'],
                          start_ms=x['s'], end_ms=x['e'], dur_ms=x['dur']))
    # controls: another doctor's solo slot, same room+day preferred
    others=[o for o in DOCS if o!=d and pool[o]]
    same=[o for o in others if any(y['room']==genuine[0]['room'] and y['date']==genuine[0]['date'] for y in pool[o])] if genuine else []
    for k in range(n_ctl):
        src=(same or others)[k%len(same or others)]
        cand=[y for y in pool[src] if not same or (y['room']==genuine[0]['room'] and y['date']==genuine[0]['date'])] or pool[src]
        y=rnd.choice(cand)
        clips.append(dict(id='k'+secrets.token_hex(4), present_as=d, true_doctor=src, kind='control',
                          room=y['room'], date=y['date'], session_id=y['sess'],
                          start_ms=y['s'], end_ms=y['e'], dur_ms=y['dur']))

# grouped by doctor (ear settles on one voice), controls shuffled INSIDE each group
order=[]
for d in DOCS:
    g=[c['id'] for c in clips if c['present_as']==d]; rnd.shuffle(g); order+=g
os.makedirs(OUT,exist_ok=True)
man=dict(kind='rollcall', doctors=DOCS, clips=clips, order=order,
         names={c['id']: c['present_as'] for c in clips})
fd=os.open(os.path.join(OUT,'manifest.json'), os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
with os.fdopen(fd,'w') as f: json.dump(man,f)

print('doctors: %d | clips: %d | controls: %d (%.0f%%)' % (len(DOCS), len(clips),
      sum(1 for c in clips if c['kind']=='control'), 100*sum(1 for c in clips if c['kind']=='control')/len(clips)))
for d in DOCS:
    g=[c for c in clips if c['present_as']==d]
    print('  %-18s clips=%d  genuine=%d control=%d  %.0f-%.0fs  %s'
          % (d, len(g), sum(1 for x in g if x['kind']=='genuine'), sum(1 for x in g if x['kind']=='control'),
             min(x['dur_ms'] for x in g)/1000, max(x['dur_ms'] for x in g)/1000,
             ' '.join(sorted({x['room'] for x in g}))))
print('CONTROLS (true source -> presented as):')
for c in clips:
    if c['kind']=='control': print('  %-18s -> %-18s %s %s %s' % (c['true_doctor'], c['present_as'], c['room'], c['date'], hhmm(c['start_ms'])))
print('total listening: %.1f min' % (sum(c['dur_ms'] for c in clips)/60000.0))
