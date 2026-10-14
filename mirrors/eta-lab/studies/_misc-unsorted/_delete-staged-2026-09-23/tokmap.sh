#!/bin/zsh
# Adds the overnight-translate entry to production SCRIBE_MCP_TOKENS. Prints counts only.
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
W=$HOME/.claude/secrets/tokmap-work; umask 077; mkdir -p $W; cd $W
trap 'rm -f $W/prod.env $W/pull.log' EXIT
V=$(ls -d $HOME/.npm/_npx/*/node_modules/.bin/vercel 2>/dev/null | head -1)
[ -x "$V" ] || { echo "no vercel cli"; exit 1; }
P=(--project even-transcription-assistant --scope vinaybhardwaj-commits-projects)
MODE=${1:-dry}
$V env pull $W/prod.env --environment=production --yes $P > $W/pull.log 2>&1 || { echo "pull failed"; exit 1; }
NEWHASH=3a54d3bbda1299b6945bc5a82e60cdac5bdfec0e16eccc1c87c210b59292c9cf
/usr/bin/python3 - "$W" "$NEWHASH" <<'PY' || exit 1
import sys,json,re,os
w,newh=sys.argv[1],sys.argv[2]
raw=None
for line in open(os.path.join(w,'prod.env')):
    if line.startswith('SCRIBE_MCP_TOKENS='):
        v=line.split('=',1)[1].rstrip('\n')
        if len(v)>=2 and v[0]==v[-1] and v[0] in '"\'': v=v[1:-1]
        raw=v
if raw is None: print("SCRIBE_MCP_TOKENS absent in pull"); sys.exit(2)
try: m=json.loads(raw)
except Exception:
    try: m=json.loads(raw.encode().decode('unicode_escape'))
    except Exception as e: print("existing value not parseable as JSON; len",len(raw),"starts",raw[:2]); sys.exit(3)
assert isinstance(m,dict)
good=[k for k in m if re.fullmatch(r'[0-9a-f]{64}',k,re.I)]
print("existing entries:",len(m),"valid-hash keys:",len(good),"actors:",sorted({(e or {}).get('actor','?') for e in m.values()}))
if newh in m: print("new hash already present")
open(os.path.join(w,'orig.json'),'w').write(json.dumps(m,separators=(',',':')))
m[newh]={"actor":"overnight-translate","scopes":["read","invoke","write"]}
new=json.dumps(m,separators=(',',':'))
m2=json.loads(new); assert all(k in m2 for k in good) and newh in m2
open(os.path.join(w,'new.json'),'w').write(new)
print("new entries:",len(m2))
PY
if [ "$MODE" = "apply" ]; then
  $V env rm SCRIBE_MCP_TOKENS production --yes $P >/dev/null 2>&1 || { echo "rm failed"; exit 1; }
  if ! $V env add SCRIBE_MCP_TOKENS production --sensitive $P < $W/new.json >/dev/null 2>&1; then
    echo "ADD FAILED - restoring original"; $V env add SCRIBE_MCP_TOKENS production --sensitive $P < $W/orig.json >/dev/null 2>&1 && echo restored; exit 1
  fi
  echo applied
fi
