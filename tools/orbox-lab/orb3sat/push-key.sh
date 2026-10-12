#!/bin/bash
# O16: make the Pi's write-only push key and authorise it on ORB3 (rrsync -wo into /home/lab/sat-in). Idempotent.
set -e
K='$HOME/.ssh/orb3sat_push'
ssh sat@pi "test -f $K || ssh-keygen -q -t ed25519 -N '' -C orb3sat_push -f $K"
PUB=$(ssh sat@pi "cat $K.pub")
LINE="restrict,command=\"/usr/bin/rrsync -wo /home/lab/sat-in\" $PUB"
ssh orbox3 "set -e
mkdir -p /home/lab/sat-in
test -f ~/.ssh/authorized_keys.bak-o16 || cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-o16
grep -qxF '$LINE' ~/.ssh/authorized_keys || echo '$LINE' >> ~/.ssh/authorized_keys
grep -c orb3sat_push ~/.ssh/authorized_keys"
ssh sat@pi "set -e; K=$K
O='-i '\$K' -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5'
echo o16-test > /tmp/o16-test.txt
rsync -t -e \"ssh \$O\" /tmp/o16-test.txt lab@orbox3: && echo 'PASS rsync write'
if OUT=\$(ssh \$O lab@orbox3 id 2>&1); then echo \"FAIL id ran: \$OUT\"; else echo \"PASS id refused: \$OUT\" | head -2; fi"
echo DONE
