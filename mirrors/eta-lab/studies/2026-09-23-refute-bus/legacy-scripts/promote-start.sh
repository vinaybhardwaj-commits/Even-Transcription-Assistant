#!/bin/zsh
rm -f /Users/vinaybhardwaj/dev/_fable/promote.log /Users/vinaybhardwaj/dev/_fable/promote.done
nohup zsh /Users/vinaybhardwaj/dev/_fable/promote.sh > /Users/vinaybhardwaj/dev/_fable/promote.log 2>&1 &
echo "started $!"
