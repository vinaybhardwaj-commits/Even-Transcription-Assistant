#!/bin/bash
# Installs ORB3Sat follower v2 on the Pi (O14, 9 Oct 2026). Restarts the service. No gain changes.
# Source files: ~/oc/orbox-builder/o14/
set -e
SRC=~/oc/orbox-builder/o14
scp -q "$SRC/follower.py" "$SRC/orb3sat-follower.service" sat@pi:/tmp/
ssh sat@pi 'set -e
sudo install -o root -g root -m 755 /tmp/follower.py /opt/orb3sat/follower.py
sudo install -o root -g root -m 644 /tmp/orb3sat-follower.service /etc/systemd/system/orb3sat-follower.service
sha256sum /opt/orb3sat/follower.py
sudo systemctl daemon-reload
sudo systemctl restart orb3sat-follower
sleep 4
echo "service: $(systemctl is-active orb3sat-follower)"
tail -3 /var/lib/orb3sat/events.jsonl'
echo DONE
