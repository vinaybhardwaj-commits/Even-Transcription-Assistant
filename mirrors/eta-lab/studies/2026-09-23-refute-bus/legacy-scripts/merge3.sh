#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
cd /Users/vinaybhardwaj/dev/_fable/wt-merge || exit 1
git merge --no-ff -q -m "Merge vinay/overnight-translate: overnight transcription driver, write-scoped override, fail-closed canary, bounded retry" vinay/overnight-translate && echo merged || { git merge --abort; echo CONFLICT; exit 1; }
git log --oneline -4
( npm run typecheck > /tmp/rel0921-tc.log 2>&1; echo "tc=$?" >> /tmp/rel0921-tc.log
  npm test > /tmp/rel0921-test.log 2>&1; echo "test=$?" >> /tmp/rel0921-test.log ) > /dev/null 2>&1 &!
echo started
