#!/bin/zsh
# Apply unapplied migrations on production.
# The secret never appears on a command line (ps would expose it) and is never echoed:
# it goes into a 0600 curl config file that is shredded on exit.
set -u
ENVF=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/.env.local
BASE=https://www.evenscribe.app
CFG=$(mktemp /tmp/.mcfg.XXXXXX)
chmod 600 "$CFG"
trap 'rm -f "$CFG"' EXIT
SEC=$(grep -m1 '^MIGRATION_SECRET=' "$ENVF" | cut -d= -f2- | tr -d '"'"'"'\r\n')
[ -z "$SEC" ] && { echo "FATAL: no MIGRATION_SECRET"; exit 2; }
printf 'header = "Authorization: Bearer %s"\n' "$SEC" > "$CFG"
unset SEC

show () {
  python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception as e: print('non-json:', sys.stdin.read()[:200] if False else e); sys.exit(0)
ap=d.get('applied')
if isinstance(ap,list):
    vs=sorted(x['version'] for x in ap if isinstance(x,dict) and isinstance(x.get('version'),int))
    print('applied:',len(vs),'max:',vs[-1] if vs else None,'last6:',vs[-6:])
else:
    print(json.dumps(d)[:600])
"
}
echo "=== before ==="
curl -s -m 30 "$BASE/api/run-migrations" | show
echo "=== POST ==="
curl -s -m 180 --config "$CFG" -X POST "$BASE/api/run-migrations" | head -c 2500
echo
echo "=== after ==="
curl -s -m 30 "$BASE/api/run-migrations" | show
