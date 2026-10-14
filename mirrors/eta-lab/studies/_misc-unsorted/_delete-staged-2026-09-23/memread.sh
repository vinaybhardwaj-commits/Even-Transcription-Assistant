#!/bin/zsh
pgrep -qf memcheck.sh && echo RUNNING || echo DONE
cat /Users/vinaybhardwaj/dev/_fable/mem.log 2>/dev/null
