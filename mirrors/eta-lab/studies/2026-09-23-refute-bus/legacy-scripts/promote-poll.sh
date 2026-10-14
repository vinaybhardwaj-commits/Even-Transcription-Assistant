#!/bin/zsh
pgrep -q -f promote.sh && echo RUNNING || echo FINISHED
tail -25 /Users/vinaybhardwaj/dev/_fable/promote.log 2>/dev/null
