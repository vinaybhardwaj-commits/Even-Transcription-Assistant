#!/bin/zsh
S=/Users/vinaybhardwaj/dev/_fable/secrets/prod.env
echo "=== is JWT_SECRET_ADMIN a placeholder? (value never printed) ==="
for K in JWT_SECRET_ADMIN ADMIN_TOKEN BRAIN_DATABASE_URL ADMIN_BASE_PATH; do
  L=$(grep "^${K}=" $S | head -1)
  if echo "$L" | grep -q 'SENSITIVE'; then
    echo "$K : PLACEHOLDER (not usable)"
  elif [ -n "$L" ]; then
    echo "$K : real value present, length $(echo -n "${L#*=}" | tr -d '\"' | wc -c | tr -d ' ')"
  else
    echo "$K : absent"
  fi
done
echo
echo "=== total placeholders ==="
grep -c 'SENSITIVE' $S
echo
echo "=== what the route actually calls (so we can run it without HTTP) ==="
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant
sed -n '96,150p' app/api/admin/bench/windows/route.ts
