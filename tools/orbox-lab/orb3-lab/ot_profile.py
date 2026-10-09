import json,os,datetime as dt
IST=dt.timezone(dt.timedelta(hours=5,minutes=30))
f="/var/lib/room-recorder/tape/tape.idx"; sz=os.path.getsize(f)
day=dt.datetime(2026,10,5,tzinfo=IST)
recs=[]
with open(f,"rb") as fh:
    fh.seek(max(0,sz-80_000_000)); fh.readline()
    for line in fh:
        try:r=json.loads(line)
        except:continue
        if "peak" in r and r["wall_ns"]>=day.timestamp()*1e9: recs.append(r)
json.dump([[r["wall_ns"],r["byte_offset"],r["peak"],r["rms"],r.get("zero_ratio",0)] for r in recs],open("ot_idx_today.json","w"))
from collections import defaultdict
b=defaultdict(list)
for r in recs:
    t=dt.datetime.fromtimestamp(r["wall_ns"]/1e9,IST); k=t.replace(minute=(t.minute//15)*15,second=0,microsecond=0); b[k].append(r)
print("15-min bins: start  n  rms_med  %loud(rms>0.05)  %clip")
for k in sorted(b):
    v=b[k]; rm=sorted(x["rms"] for x in v); n=len(v)
    print(k.strftime("%H:%M"), n, "%.3f"%rm[n//2], "%5.1f"%(100*sum(x["rms"]>0.05 for x in v)/n), "%5.2f"%(100*sum(x["peak"]>=0.999 for x in v)/n))
