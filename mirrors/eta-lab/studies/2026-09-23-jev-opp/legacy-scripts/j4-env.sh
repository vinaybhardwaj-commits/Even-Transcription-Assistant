#!/bin/zsh
# J4 production env: link project, then set the four Jev vars.
# The TypeSafe key is piped from ~/.config/even-jev/key and is never echoed.
set -u
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
cd "$R" || exit 1
SCOPE=vinaybhardwaj-commits-projects
PROJ=even-transcription-assistant

echo "=== link ==="
npx -y vercel link --yes --project "$PROJ" --scope "$SCOPE" 2>&1 | tail -3

echo "=== env ls (names only) ==="
npx -y vercel env ls production --scope "$SCOPE" 2>&1 | tail -40

echo "=== set flags ==="
set_flag () {
  local k="$1" v="$2"
  npx -y vercel env rm "$k" production --yes --scope "$SCOPE" >/dev/null 2>&1
  printf '%s' "$v" | npx -y vercel env add "$k" production --scope "$SCOPE" 2>&1 | tail -2
  echo "  -> $k set (len ${#v})"
}
set_flag ETA_JEV_ENABLED 1
set_flag ETA_JEV_MODEL jev-latest
set_flag ETA_JEV_ROLE_ALLOW_NON_ENGLISH 1

echo "=== set TYPESAFE_API_KEY (value never printed) ==="
KEYFILE=/Users/vinaybhardwaj/.config/even-jev/key
if [ ! -s "$KEYFILE" ]; then echo "FATAL: key file missing/empty"; exit 2; fi
npx -y vercel env rm TYPESAFE_API_KEY production --yes --scope "$SCOPE" >/dev/null 2>&1
tr -d '\r\n' < "$KEYFILE" | npx -y vercel env add TYPESAFE_API_KEY production --sensitive --scope "$SCOPE" 2>&1 | tail -2
echo "  -> TYPESAFE_API_KEY set (len $(tr -d '\r\n' < "$KEYFILE" | wc -c | tr -d ' '))"

echo "=== verify (names only) ==="
npx -y vercel env ls production --scope "$SCOPE" 2>&1 | grep -i "ETA_JEV\|TYPESAFE" 
echo "=== done ==="
