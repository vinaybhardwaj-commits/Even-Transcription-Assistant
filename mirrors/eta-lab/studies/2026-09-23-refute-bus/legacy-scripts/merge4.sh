#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
cd /Users/vinaybhardwaj/dev/_fable/wt-merge || exit 1
git fetch -q origin
echo "origin s1-auto-drain: $(git rev-parse --short origin/vinay/s1-auto-drain)"
echo "is 45eedda ancestor of origin s1: $(git merge-base --is-ancestor 45eedda origin/vinay/s1-auto-drain && echo yes || echo no)"
echo "is origin s1 ancestor of release: $(git merge-base --is-ancestor origin/vinay/s1-auto-drain HEAD && echo yes || echo no)"
git merge --no-ff -q -m "Merge vinay/join-only-clips: join-only clip path, compensated clip-key write" vinay/join-only-clips && echo merged-join || { git merge --abort; echo CONFLICT; exit 1; }
git log --oneline -1
( npm run typecheck > /tmp/rel0921-tc.log 2>&1; echo "tc=$?" >> /tmp/rel0921-tc.log
  npm test > /tmp/rel0921-test.log 2>&1; echo "test=$?" >> /tmp/rel0921-test.log ) > /dev/null 2>&1 &!
echo started
