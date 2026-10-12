#!/bin/bash
# Installs the ORB3Sat follower on the Pi (V approved, 9 Oct 2026). Sets the Pi mic gain to 41.
# Source files: ~/oc/orbox-builder/o13/ (reviewed by orbox-lead).
set -e
SRC=~/oc/orbox-builder/o13
scp -q "$SRC/follower.py" "$SRC/orb3sat-follower.service" sat@pi:/tmp/
ssh sat@pi 'set -e
echo "gain before: $(amixer -c Device sget Mic | grep -m1 -o "Capture [0-9]*")"
sudo mkdir -p /opt/orb3sat /var/lib/orb3sat
sudo chown sat:sat /var/lib/orb3sat
sudo install -o root -g root -m 755 /tmp/follower.py /opt/orb3sat/follower.py
sudo install -o root -g root -m 644 /tmp/orb3sat-follower.service /etc/systemd/system/orb3sat-follower.service
amixer -q -c Device sset Mic 41
sudo alsactl store
echo "gain after: $(amixer -c Device sget Mic | grep -m1 -o "Capture [0-9]*")"
sudo systemctl daemon-reload
sudo systemctl enable --now orb3sat-follower
sleep 4
echo "service: $(systemctl is-active orb3sat-follower)"
tail -3 /var/lib/orb3sat/events.jsonl'
echo DONE
