#!/bin/zsh
export PATH=/opt/homebrew/bin:$PATH
O=/Users/vinaybhardwaj/dev/_fable/scratch/d36.out
: > $O
which herdr >> $O 2>&1
/bin/zsh /Users/vinaybhardwaj/dev/_fable/hsend.sh "Fable ping: reply with the word ack only." lx >> $O 2>&1
echo "rc=$?" >> $O
cat /Users/vinaybhardwaj/dev/_fable/scratch/hsend.log >> $O 2>&1
