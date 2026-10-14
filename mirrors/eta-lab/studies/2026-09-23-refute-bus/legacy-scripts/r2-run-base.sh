#!/bin/zsh
cd /Users/vinaybhardwaj/dev/_fable/r2base || exit 9
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
nohup zsh -lc 'cd /Users/vinaybhardwaj/dev/_fable/r2base && npm test > /Users/vinaybhardwaj/dev/_fable/r2-base.log 2>&1; echo "rc=$?" >> /Users/vinaybhardwaj/dev/_fable/r2-base.log' > /dev/null 2>&1 &
echo "started r2base pid $!"
