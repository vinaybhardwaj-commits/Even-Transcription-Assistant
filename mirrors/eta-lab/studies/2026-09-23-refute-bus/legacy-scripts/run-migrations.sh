#!/bin/zsh
set -u
S=/Users/vinaybhardwaj/dev/_fable/secrets/prod.env
echo "=== applied BEFORE (max + presence of 109/111) ==="
curl -s https://www.evenscribe.app/api/run-migrations | python3 -c "
import sys,json
d=json.load(sys.stdin); a=d.get('applied',[])
v=[r['version'] for r in a]
print('count',len(v),'max',max(v) if v else None)
print('109 applied:',109 in v,' 110 applied:',110 in v,' 111 applied:',111 in v)
ms=[x for x in range(1,max(v)+1) if x not in v] if v else []
print('gaps:',ms)
" 2>&1 | head -6
echo
echo "=== POST (secret via curl config on stdin, never on the command line) ==="
MS=$(grep '^MIGRATION_SECRET=' $S | head -1 | sed -E 's/^MIGRATION_SECRET=//; s/^"//; s/"$//')
printf 'url = "https://www.evenscribe.app/api/run-migrations"\nrequest = "POST"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\ndata = "{}"\nsilent\n' "$MS" | curl -K - 2>&1 | head -c 1200
unset MS
echo
echo
echo "=== applied AFTER ==="
curl -s https://www.evenscribe.app/api/run-migrations | python3 -c "
import sys,json
d=json.load(sys.stdin); a=d.get('applied',[])
v=[r['version'] for r in a]
print('count',len(v),'max',max(v) if v else None)
print('109 applied:',109 in v,' 110 applied:',110 in v,' 111 applied:',111 in v)
" 2>&1 | head -4
