#!/bin/zsh
export PATH=/opt/homebrew/bin:$PATH
O=/Users/vinaybhardwaj/dev/_fable/scratch/q.out
D=/Users/vinaybhardwaj/dev/_fable/e3kit/out/listen_clips
M=$(find /Users/vinaybhardwaj/dev/_fable/e3kit -name 'clips_manifest.json' | head -1)
python3 - "$M" "$D" > $O 2>&1 <<'PY'
import json,sys,subprocess,os,hashlib,collections
m=json.load(open(sys.argv[1])); D=sys.argv[2]
items = m if isinstance(m,list) else m.get('clips', m.get('order', []))
print("manifest path", sys.argv[1], "items", len(items), "keys", sorted(items[0].keys()))
def dur(p):
    r=subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",p],capture_output=True,text=True)
    try: return float(r.stdout.strip())
    except: return None
ok=bad=missing=0; hashes=collections.defaultdict(list); rows=[]
for x in items:
    cid=x.get('clip_id') or x.get('id'); p=os.path.join(D,cid+".m4a")
    if not os.path.exists(p): missing+=1; continue
    seg=(x['end_ms']-x['start_ms'])/1000
    exp=min(seg,8.0)
    d=dur(p)
    h=hashlib.sha1(open(p,'rb').read()).hexdigest()[:10]; hashes[h].append(cid)
    match = d is not None and abs(d-exp) < 0.35
    ok+=match; bad+=(not match)
    rows.append((cid,round(seg,2),round(exp,2),d))
print("duration matches manifest:",ok,"mismatch:",bad,"missing file:",missing)
print("files sharing identical bytes:",[v for v in hashes.values() if len(v)>1][:12])
print("first 12 rows (id, seg_s, expected_s, file_s):")
for r in rows[:12]: print(" ",r)
# do repeats in manifest point to same segment as their originals?
seg_ids=collections.defaultdict(list)
for x in items: seg_ids[(x.get('window_id'),x['start_ms'],x['end_ms'])].append(x.get('clip_id') or x.get('id'))
print("segments listed twice in manifest:",sum(1 for v in seg_ids.values() if len(v)>1))
PY
ls /Users/vinaybhardwaj/dev/_fable/e3kit/out/listen_clips | wc -l >> $O
ls -la --time-style=+%H:%M /Users/vinaybhardwaj/dev/_fable/e3kit/out/listen_clips 2>/dev/null | head -3 >> $O
stat -f '%Sm %N' -t '%H:%M:%S' $M /Users/vinaybhardwaj/dev/_fable/e3kit/out/listen_clips/c0000.m4a /Users/vinaybhardwaj/dev/_fable/e3kit/out/listen_clips/r0009.m4a >> $O
