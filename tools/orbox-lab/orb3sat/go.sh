#!/bin/bash
# Adds the Pi's locked-down status key to ORB3. Backup first. Idempotent.
set -e
K=$(cat "$(dirname "$0")/orb3sat_status.pub")
ssh orb3 "cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-o13; grep -q orb3sat-status ~/.ssh/authorized_keys || echo 'restrict,command=\"cat /proc/asound/cards; grep -H . /proc/asound/card*/pcm*c/sub*/status\" $K' >> ~/.ssh/authorized_keys; grep orb3sat-status ~/.ssh/authorized_keys | cut -c1-110"
ssh sat@pi 'ssh-keyscan -q -t ed25519 orbox3 >> ~/.ssh/known_hosts; ssh -i ~/.ssh/orb3sat_status -o BatchMode=yes lab@orbox3 id | head -3'
echo DONE
