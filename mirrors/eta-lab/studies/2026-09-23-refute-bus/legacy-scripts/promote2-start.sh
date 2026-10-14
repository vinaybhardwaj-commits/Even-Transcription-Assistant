#!/bin/zsh
pkill -f promote.sh 2>/dev/null
rm -f /Users/vinaybhardwaj/dev/_fable/promote2.log
nohup zsh /Users/vinaybhardwaj/dev/_fable/promote2.sh > /Users/vinaybhardwaj/dev/_fable/promote2.log 2>&1 &
echo started $!
