#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
LOG=~/dev/_fable/scratch/jev-fullsuite.log
cd ~/dev/qo-wt
{
  echo "=== npm run test (typecheck:tests && vitest run) START $(date) ==="
  npm run test 2>&1
  echo "EXIT=$?"
  echo "=== DONE $(date) ==="
} > $LOG 2>&1
echo done
