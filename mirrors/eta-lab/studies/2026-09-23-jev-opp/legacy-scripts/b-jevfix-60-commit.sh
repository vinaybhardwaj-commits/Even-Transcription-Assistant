#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
LOG=~/dev/_fable/scratch/jev-commit.log
cd ~/dev/qo-wt
{
  echo "=== git status before ==="
  git status
  echo "=== git diff --stat ==="
  git diff --stat
  echo "=== re-fetch origin/vinay/eta-qwen-out to confirm it hasn't moved ==="
  git fetch origin vinay/eta-qwen-out
  git log -1 --oneline origin/vinay/eta-qwen-out
  echo "=== add ==="
  git add lib/jev/translate.ts lib/openrouter.ts lib/llm/gemini.ts lib/jobs/kinds/jev-english.ts tests/unit/jev-translate.test.ts tests/unit/routed-chat-fallback.test.ts
  git status
} > $LOG 2>&1
echo done
