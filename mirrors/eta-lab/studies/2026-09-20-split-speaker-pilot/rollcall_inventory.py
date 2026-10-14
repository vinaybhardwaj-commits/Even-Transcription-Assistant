#!/usr/bin/env python3
"""PART 2 inventory: how much labelled ROOM-DOMAIN audio each rostered doctor could yield.
Inventory only — cuts nothing, enrols nobody. Shared slots are excluded entirely: a slot with two
rostered doctors cannot yield clean labelled audio for either, and enrolling one on the other's
voice would poison a centroid that six of seven prints keep no audio to undo."""
import datetime, json, re, collections
from q import q
import roster_check as R   # reuse the proven parser/matcher

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
DAYS = R.DAYS
MIN_MS = 6000

rooms, slots, unparsed = R.load_roster()
clin = R.rows("select id, full_name from clinician")
vp = {x['doctor_id'] for x in R.rows("select distinct doctor_id from voice_print")}
def norm(x):
    x = re.sub(r'\bdrs?\b',' ',str(x or '').lower()); x = re.sub(r'[^a-z ]',' ',x)
    return re.sub(r'\s+',' ',x).strip()
def match(name):
    n=norm(name); nt=set(n.split())
    if not nt: return None
    ex=[c for c in clin if norm(c['full_name'])==n]
    if len(ex)==1: return ex[0]['id']
    sub=[c for c in clin if nt<=set(norm(c['full_name']).split())]
    return sub[0]['id'] if len(sub)==1 else None

droom = R.rows("select id, name from room")
room_map={}
for r in droom:
    m=re.match(r'^\s*OPD\s*(\d+)', str(r['name'] or ''), re.I)
    if m and ('ROOM %s'%m.group(1)) in rooms.values(): room_map[r['id']]='ROOM %s'%m.group(1)

turns = R.rows("""select rd.room_id, rd.ist_date::text d,
                         split_part(t.source_ref,'|',2)::bigint s,
                         split_part(t.source_ref,'|',3)::bigint - split_part(t.source_ref,'|',2)::bigint dur
                  from room_turn_speaker t join room_day rd on rd.id=t.room_day_id""")
# bucket turns by (schedule room, date, minute-of-day)
byroom=collections.defaultdict(list)
for t in turns:
    rn=room_map.get(t['room_id'])
    if not rn: continue
    dt=datetime.datetime.fromtimestamp(int(t['s'])/1000, IST)
    byroom[(rn, t['d'])].append((DAYS[dt.weekday()], dt.hour*60+dt.minute, int(t['dur'])))

per=collections.defaultdict(lambda: dict(turns=0, long=0, secs=0.0, slots=set(), dates=set()))
shared_excluded=[]
rows_out=[]
for (rn, date), tl in sorted(byroom.items()):
    wd = tl[0][0]
    for s in slots:
        if s['room']!=rn or s['day']!=wd or s['free']: continue
        inside=[(m,d) for (w,m,d) in tl if s['start_min']<=m<s['end_min']]
        if not inside: continue
        n=len(inside); ln=[d for _,d in inside if d>=MIN_MS]; secs=sum(ln)/1000.0
        names=s['doctors']
        if len(names)>1:
            shared_excluded.append(dict(room=rn, date=date, slot='%s-%s'%(s['start_min'],s['end_min']),
                                        doctors=names, turns=n, long=len(ln), secs=round(secs,1)))
            continue
        nm=names[0]; cid=match(nm)
        rows_out.append(dict(doctor=nm, cid=cid, has_vp=(cid in vp), room=rn, date=date,
                             slot='%02d:%02d-%02d:%02d'%(s['start_min']//60,s['start_min']%60,
                                                          s['end_min']//60,s['end_min']%60),
                             turns=n, long=len(ln), secs=round(secs,1)))
        p=per[nm]; p['turns']+=n; p['long']+=len(ln); p['secs']+=secs
        p['slots'].add((rn,date)); p['cid']=cid; p['has_vp']=(cid in vp)

print('%-20s %-14s %3s %5s %7s %7s  %s' % ('doctor','clinician_id','vp','slots','turns','>=6s','usable_sec'))
for nm,p in sorted(per.items(), key=lambda kv:-kv[1]['secs']):
    print('%-20s %-14s %3s %5d %7d %7d  %8.1f' % (nm, p.get('cid') or '-', 'Y' if p.get('has_vp') else 'n',
          len(p['slots']), p['turns'], p['long'], p['secs']))
print('\nPER SLOT (solo only)')
for r in sorted(rows_out, key=lambda x:-x['secs']):
    print('  %-20s %-7s %s %s  turns=%-5d >=6s=%-4d %6.1fs' % (r['doctor'],r['room'],r['date'],r['slot'],r['turns'],r['long'],r['secs']))
print('\nSHARED SLOTS EXCLUDED (%d)' % len(shared_excluded))
for x in shared_excluded:
    print('  %-7s %s  %s  turns=%d >=6s=%d %.1fs  -> EXCLUDED' % (x['room'],x['date'],' / '.join(x['doctors']),x['turns'],x['long'],x['secs']))
json.dump(dict(per={k:{kk:(sorted(vv) if isinstance(vv,set) else vv) for kk,vv in v.items()} for k,v in per.items()},
               slots=rows_out, shared_excluded=shared_excluded),
          open('/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/docs/handoff/scratch/rollcall-inventory-20-SEP-2026.json','w'),
          indent=1, default=str)
