#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
LOG=~/dev/_fable/scratch/jev-typecheck.log
cd ~/dev/qo-wt
{
  echo "=== npm run typecheck:tests ==="
  npm run typecheck:tests 2>&1
  echo "EXIT=$?"
} > $LOG 2>&1
echo done
