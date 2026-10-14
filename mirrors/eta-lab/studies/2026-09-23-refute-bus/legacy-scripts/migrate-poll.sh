#!/bin/zsh
pgrep -q -f "_fable/migrate.sh" && echo RUNNING || echo FINISHED
cat /Users/vinaybhardwaj/dev/_fable/migrate.log 2>/dev/null | head -60
