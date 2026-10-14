#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
nohup zsh -lc 'cd /Users/vinaybhardwaj/dev/_fable/wt3-fix && npm test > /Users/vinaybhardwaj/dev/_fable/r3-fix.log 2>&1; echo "rc=$?" >> /Users/vinaybhardwaj/dev/_fable/r3-fix.log' > /dev/null 2>&1 &
echo "started wt3-fix pid $!"
