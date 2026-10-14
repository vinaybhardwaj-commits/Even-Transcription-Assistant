#!/bin/zsh
W=/Users/vinaybhardwaj/dev/_fable/wt-merge
cd $W || exit 1
git status --porcelain | head -3
git checkout -q -B vinay/release-0921 45eedda
git merge --no-ff -q -m "Merge vinay/speech-gate: Silero gate on diarizer segments, flag default OFF" vinay/speech-gate && echo "merged speech-gate"
git merge --no-ff -q -m "Merge vinay/j0-abstain: absent language signal abstains" vinay/j0-abstain && echo "merged j0-abstain"
git log --oneline -3
(npm run typecheck >/tmp/rel0921-tc.log 2>&1; echo "tc=$?" >> /tmp/rel0921-tc.log; npm test >/tmp/rel0921-test.log 2>&1; echo "test=$?" >> /tmp/rel0921-test.log) &!
echo started
