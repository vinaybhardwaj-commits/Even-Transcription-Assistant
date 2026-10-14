#!/bin/zsh
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow || exit 1
npx -y vercel ls --scope vinaybhardwaj-commits-projects --prod 2>&1 | sed -n '5,8p'
echo "=== live ==="
for u in https://evenscribe.app https://www.evenscribe.app; do
  curl -sL -m 25 -o /tmp/mig.json -w "$u -> %{http_code}\n" "$u/api/run-migrations"
done
head -c 400 /tmp/mig.json; echo
