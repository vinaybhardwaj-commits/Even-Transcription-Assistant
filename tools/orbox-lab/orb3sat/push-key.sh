#!/bin/bash
: "${ORB3_SSH_TARGET:?set ORB3_SSH_TARGET, e.g. user@orb3-host}"; : "${ORB3_LAB_ROOT:?set ORB3_LAB_ROOT to the lab user home on ORB3}"
# O16: make the Pi's write-only push key and authorise it on ORB3 (rrsync -wo into $ORB3_LAB_ROOT/sat-in). Idempotent.
set -e
K='$HOME/.ssh/orb3sat_push'
ssh sat@pi "test -f $K || ssh-keygen -q -t ed25519 -N '' -C orb3sat_push -f $K"
PUB=$(ssh sat@pi "cat $K.pub")
LINE="restrict,command=\"/usr/bin/rrsync -wo $ORB3_LAB_ROOT/sat-in\" $PUB"
ssh orbox3 "set -e
mkdir -p $ORB3_LAB_ROOT/sat-in
test -f ~/.ssh/authorized_keys.bak-o16 || cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-o16
grep -qxF '$LINE' ~/.ssh/authorized_keys || echo '$LINE' >> ~/.ssh/authorized_keys
grep -c orb3sat_push ~/.ssh/authorized_keys"
ssh sat@pi "set -e; K=$K
O='-i '\$K' -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5'
echo o16-test > /tmp/o16-test.txt
rsync -t -e \"ssh \$O\" /tmp/o16-test.txt $ORB3_SSH_TARGET: && echo 'PASS rsync write'
if OUT=\$(ssh \$O $ORB3_SSH_TARGET id 2>&1); then echo \"FAIL id ran: \$OUT\"; else echo \"PASS id refused: \$OUT\" | head -2; fi"
echo DONE
