#!/bin/zsh
pgrep -q -f promote2.sh && echo RUNNING || echo FINISHED
tail -30 /Users/vinaybhardwaj/dev/_fable/promote2.log 2>/dev/null
