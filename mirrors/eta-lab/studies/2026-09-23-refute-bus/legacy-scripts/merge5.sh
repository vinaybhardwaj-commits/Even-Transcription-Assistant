#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
W=/Users/vinaybhardwaj/dev/_fable/wt-merge
for p in $(pgrep -f vitest) $(pgrep -f "npm run typecheck") $(pgrep -f "npm test"); do
  cwd=$(lsof -a -p $p -d cwd -Fn 2>/dev/null | grep ^n | cut -c2-)
  [ "$cwd" = "$W" ] && kill $p 2>/dev/null
done
sleep 3
cd $W || exit 1
git status --porcelain | grep -v '^??' | head -3
git merge --no-ff -q -m "Merge origin/vinay/s1-auto-drain (a56a446): keep production's room-login retirement" origin/vinay/s1-auto-drain && echo merged-prod || { git merge --abort; echo CONFLICT; exit 1; }
echo "prod is ancestor now: $(git merge-base --is-ancestor origin/vinay/s1-auto-drain HEAD && echo yes)"
git log --oneline -1
( npm run typecheck > /tmp/rel0921-tc.log 2>&1; echo "tc=$?" >> /tmp/rel0921-tc.log
  npm test > /tmp/rel0921-test.log 2>&1; echo "test=$?" >> /tmp/rel0921-test.log ) > /dev/null 2>&1 &!
echo started
