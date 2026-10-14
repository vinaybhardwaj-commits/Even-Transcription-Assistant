#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
LOG=~/dev/_fable/scratch/jev-targeted.log
cd ~/dev/qo-wt
{
  echo "=== npx vitest run (targeted) ==="
  npx vitest run tests/unit/jev-translate.test.ts tests/unit/jev-english.test.ts tests/unit/routed-chat-fallback.test.ts tests/unit/llm-provider-truth.test.ts 2>&1
  echo "EXIT=$?"
} > $LOG 2>&1
echo done
