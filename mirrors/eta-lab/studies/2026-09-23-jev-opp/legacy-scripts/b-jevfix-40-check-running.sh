#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
LOG=~/dev/_fable/scratch/check-running.log
{
  echo "=== pgrep vitest/npm ==="
  pgrep -fl "vitest|npm run test"
  echo "=== tail of fullsuite log ==="
  tail -c 3000 ~/dev/_fable/scratch/jev-fullsuite.log
} > $LOG 2>&1
echo done
