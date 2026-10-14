#!/bin/zsh
cd /Users/vinaybhardwaj/dev/_fable/r2mut || exit 9
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
{ which node; node -v; which npx;
  npx vitest run tests/unit/route-metrics-truth.test.ts ; echo "RC=$?"; } > /Users/vinaybhardwaj/dev/_fable/r2-mut-probe.log 2>&1
tail -40 /Users/vinaybhardwaj/dev/_fable/r2-mut-probe.log
