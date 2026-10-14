#!/bin/zsh
# Push vinay/s1-auto-drain and promote the resulting preview to production.
set -u
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
cd "$R" || exit 1
SCOPE=vinaybhardwaj-commits-projects
echo "=== head ==="; git rev-parse --short HEAD
echo "=== push ==="
git push origin vinay/s1-auto-drain 2>&1 | tail -5
SHA=$(git rev-parse HEAD)
echo "pushed $SHA"
echo "=== wait for the preview build ==="
DPL=""
for i in $(seq 1 60); do
  sleep 20
  LINE=$(npx -y vercel ls --scope "$SCOPE" 2>/dev/null | grep -i "$(git rev-parse --short HEAD)" | head -1)
  OUT=$(npx -y vercel ls --scope "$SCOPE" 2>/dev/null | head -8)
  echo "[$i] $(echo "$OUT" | sed -n '3p')"
  READY=$(echo "$OUT" | grep -c "Ready")
  if [ "$READY" -ge 1 ]; then break; fi
done
echo "=== latest deployments ==="
npx -y vercel ls --scope "$SCOPE" 2>&1 | head -10
