#!/bin/zsh
S=/Users/vinaybhardwaj/dev/_fable/secrets
echo "=== before ==="
ls -la $S 2>&1 | tail -n +2
echo
for f in prod.env .env.local; do
  if [ -f "$S/$f" ]; then rm -f "$S/$f" && echo "deleted $f"; fi
done
echo
echo "=== after ==="
ls -la $S 2>&1 | tail -n +2
echo
echo "=== any other pulled env files anywhere in _fable ==="
find /Users/vinaybhardwaj/dev/_fable -name "*.env*" -o -name "prod.env" 2>/dev/null | head
