#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
nohup zsh -lc 'cd /Users/vinaybhardwaj/dev/_fable/wt-pre && npm test > /Users/vinaybhardwaj/dev/_fable/r2-wt-pre.log 2>&1; echo "rc=$?" >> /Users/vinaybhardwaj/dev/_fable/r2-wt-pre.log' > /dev/null 2>&1 &
echo "started wt-pre pid $!"
