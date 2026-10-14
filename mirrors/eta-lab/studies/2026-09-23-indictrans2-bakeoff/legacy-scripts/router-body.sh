#!/bin/zsh
# Capture the SHAPE of a real router job reply. Keys only — no text values printed.
echo "=== health ==="
curl -s -m 10 http://127.0.0.1:8083/healthz | head -c 400; echo
echo "=== recent jobs ==="
curl -s -m 10 http://127.0.0.1:8083/route/jobs 2>/dev/null | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception as e: print('no /route/jobs:',e); sys.exit(0)
ids=[]
if isinstance(d,dict):
    for k in ('jobs','items','results'):
        if k in d and isinstance(d[k],list): ids=[j.get('id') or j.get('job_id') for j in d[k]]; break
elif isinstance(d,list): ids=[j.get('id') or j.get('job_id') for j in d]
print('job ids found:',len([i for i in ids if i]))
open('/Users/vinaybhardwaj/dev/_fable/jobids.txt','w').write('\n'.join([str(i) for i in ids if i][:5]))
"
echo "=== job body shape ==="
JID=$(head -1 /Users/vinaybhardwaj/dev/_fable/jobids.txt 2>/dev/null)
if [ -n "$JID" ]; then
  curl -s -m 15 "http://127.0.0.1:8083/route/job/$JID" | python3 -c "
import sys,json
d=json.load(sys.stdin)
def shape(o,p='',depth=0):
    if depth>3: return
    if isinstance(o,dict):
        for k,v in o.items():
            t=type(v).__name__
            if isinstance(v,(dict,list)):
                print(f'{p}{k}: {t}')
                shape(v[0] if isinstance(v,list) and v else v, p+'  ', depth+1)
            else:
                print(f'{p}{k}: {t}')
    elif isinstance(o,list) and o:
        shape(o[0],p+'  ',depth+1)
shape(d)
print('--- TOP-LEVEL outcome present? ---', 'outcome' in d)
seg=d.get('segmentation')
print('--- segmentation.outcome present? ---', isinstance(seg,dict) and 'outcome' in seg)
"
else
  echo "no job id available"
fi
echo "=== grep router source for outcome placement ==="
grep -n '"outcome"' /Users/vinaybhardwaj/eta-router/router_server.py | head -20
