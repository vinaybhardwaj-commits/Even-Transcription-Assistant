#!/bin/zsh
# Release: OPENROUTER_API_KEY on Vercel prod (stdin, never argv/echo), then ff vinay/s1-auto-drain -> de3e5ab and push.
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
V=$HOME/.npm/_npx/67eb4586ca667318/node_modules/.bin/vercel
cd ~/dev/_fable/wt-merge || exit 1
echo "== env"
$V env rm OPENROUTER_API_KEY production --yes --project even-transcription-assistant --scope vinaybhardwaj-commits-projects >/dev/null 2>&1
tr -d '\n' < ~/.claude/secrets/openrouter_api_key | $V env add OPENROUTER_API_KEY production --sensitive --project even-transcription-assistant --scope vinaybhardwaj-commits-projects 2>&1 | grep -viE "key|token" | tail -2
$V env ls production --project even-transcription-assistant --scope vinaybhardwaj-commits-projects 2>/dev/null | grep -c OPENROUTER_API_KEY
echo "== git"
git fetch -q origin
git checkout -q -B rel-qwen-out origin/vinay/s1-auto-drain
git merge -q --ff-only origin/vinay/eta-qwen-out && git log --oneline -1
git push -q origin HEAD:vinay/s1-auto-drain 2>&1 | tail -2
git ls-remote origin vinay/s1-auto-drain | cut -c1-7
