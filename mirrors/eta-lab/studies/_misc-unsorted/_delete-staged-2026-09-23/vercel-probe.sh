#!/bin/zsh
echo "=== vercel cli auth ==="
for p in ~/.local/share/com.vercel.cli/auth.json ~/Library/Application\ Support/com.vercel.cli/auth.json ~/.vercel/auth.json; do
  [ -f "$p" ] && echo "AUTH PRESENT: $p"
done
echo "VERCEL_TOKEN set? ${VERCEL_TOKEN:+yes}${VERCEL_TOKEN:-no}"
echo "=== linked projects ==="
for d in /Users/vinaybhardwaj/dev/Even-Transcription-Assistant /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow; do
  echo "$d -> $( [ -f "$d/.vercel/project.json" ] && cat "$d/.vercel/project.json" || echo 'not linked')"
done
echo "=== whoami ==="
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow && timeout 60 npx -y vercel whoami 2>&1 | tail -5
echo "=== env ls prod ==="
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow && timeout 90 npx -y vercel env ls production 2>&1 | tail -40
