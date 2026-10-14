#!/usr/bin/env zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd /Users/vinaybhardwaj/eta-router-pools
OUT=/Users/vinaybhardwaj/dev/_fable/scratch/pools-tests.log
rm -f "$OUT" /Users/vinaybhardwaj/dev/_fable/scratch/pools-tests.done
{
  echo "=== test_translate ==="
  /Users/vinaybhardwaj/eta-router/.venv/bin/python -m unittest test_translate -v
  echo "=== test_job_verdict ==="
  /Users/vinaybhardwaj/eta-router/.venv/bin/python -m unittest test_job_verdict -v
  echo "EXIT_STATUS=$?"
} > "$OUT" 2>&1
touch /Users/vinaybhardwaj/dev/_fable/scratch/pools-tests.done
