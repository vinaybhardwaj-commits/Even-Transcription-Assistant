#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
LOG=~/dev/_fable/scratch/pgrep-check.log
{
  echo "=== pgrep -f vitest ==="
  pgrep -fl vitest
  echo "exit=$?"
  echo "=== docker info (quick check, may fail if not running) ==="
  docker info > /dev/null 2>&1
  echo "docker_info_exit=$?"
} > $LOG 2>&1
echo done
