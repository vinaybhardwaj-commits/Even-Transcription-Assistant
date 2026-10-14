#!/bin/zsh
rm -f /Users/vinaybhardwaj/dev/_fable/migrate.log
nohup zsh /Users/vinaybhardwaj/dev/_fable/migrate.sh > /Users/vinaybhardwaj/dev/_fable/migrate.log 2>&1 &
echo started $!
