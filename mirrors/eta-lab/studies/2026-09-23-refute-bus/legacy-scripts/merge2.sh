#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
W=/Users/vinaybhardwaj/dev/_fable/wt-merge
cd $W || exit 1
echo "pkg diff vs 45eedda: $(git diff --stat 45eedda -- package.json | tail -1)"
[ -e node_modules ] || ln -s /Users/vinaybhardwaj/dev/Even-Transcription-Assistant/node_modules node_modules
( npm run typecheck > /tmp/rel0921-tc.log 2>&1; echo "tc=$?" >> /tmp/rel0921-tc.log
  npm test > /tmp/rel0921-test.log 2>&1; echo "test=$?" >> /tmp/rel0921-test.log ) > /dev/null 2>&1 &!
echo started
