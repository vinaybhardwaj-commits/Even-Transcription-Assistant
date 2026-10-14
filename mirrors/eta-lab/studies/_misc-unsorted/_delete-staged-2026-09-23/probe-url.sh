#!/bin/zsh
for U in https://evenscribe.app/api/run-migrations https://www.evenscribe.app/api/run-migrations; do
  echo "--- $U"
  curl -s -o /dev/null -w "status %{http_code}  redirect: %{redirect_url}\n" "$U"
done
echo
echo "--- following redirects, GET body head"
curl -sL https://evenscribe.app/api/run-migrations | head -c 400
echo
echo
echo "--- production aliases"
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant && npx -y vercel alias ls --scope vinaybhardwaj-commits-projects 2>&1 | head -14
