#!/bin/zsh
set -u
WT=/Users/vinaybhardwaj/dev/_fable/wt-merge
echo "=== verify -fv landed on s1-auto-drain (array form) ==="
grep -n -E '"-fv"|-fv' $WT/tests/support/pg-harness.ts $WT/tests/support/s1-pg.ts 2>&1 | head -8
echo
echo "=== secrets dir ==="
S=/Users/vinaybhardwaj/dev/_fable/secrets
mkdir -p $S && chmod 700 $S
cd $S || exit 1
umask 077
if [ ! -f "$S/.vercel/project.json" ]; then
  npx -y vercel link --yes --project even-transcription-assistant --scope vinaybhardwaj-commits-projects 2>&1 | tail -4
fi
npx -y vercel env pull "$S/prod.env" --environment=production --yes --scope vinaybhardwaj-commits-projects 2>&1 | tail -4
chmod 600 "$S/prod.env" 2>/dev/null
echo
echo "=== result (no values printed) ==="
if [ -f "$S/prod.env" ]; then
  echo "prod.env bytes: $(wc -c < "$S/prod.env" | tr -d ' ')  mode: $(stat -f '%Lp' "$S/prod.env")"
  echo "JWT_SECRET_ADMIN present: $(grep -c '^JWT_SECRET_ADMIN=' "$S/prod.env")"
  echo "keys: $(grep -c '=' "$S/prod.env")"
else
  echo "prod.env NOT created"
fi
