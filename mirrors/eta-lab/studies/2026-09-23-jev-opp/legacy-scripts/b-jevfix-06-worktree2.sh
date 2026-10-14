#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
LOG=~/dev/_fable/scratch/wt-setup2.log
cd ~/dev/Even-Transcription-Assistant
{
  echo "=== worktree add detached ==="
  git worktree add --detach ~/dev/qo-wt 51357fc
  echo "exit=$?"
  echo "=== node_modules symlink ==="
  if [ ! -e ~/dev/qo-wt/node_modules ]; then
    ln -s ~/dev/Even-Transcription-Assistant/node_modules ~/dev/qo-wt/node_modules
  fi
  ls -la ~/dev/qo-wt/node_modules | head -3
  echo "=== verify ==="
  cd ~/dev/qo-wt
  git log -1 --oneline
  git status
  ls lib/jev/translate.ts lib/openrouter.ts lib/llm/gemini.ts lib/jobs/kinds/jev-english.ts lib/jobs/types.ts
} > $LOG 2>&1
echo done
