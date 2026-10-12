#!/bin/bash
# O16: install ORB3Sat follower v3 + sender on the Pi. Restarts the follower, starts the sender. No gain changes.
set -e
SRC=~/oc/orbox-builder/o16
scp -q "$SRC/follower.py" "$SRC/sender.py" "$SRC/orb3sat-follower.service" "$SRC/orb3sat-sender.service" sat@pi:/tmp/
ssh sat@pi 'set -e
sudo install -o root -g root -m 755 /tmp/follower.py /opt/orb3sat/follower.py
sudo install -o root -g root -m 755 /tmp/sender.py /opt/orb3sat/sender.py
sudo install -o root -g root -m 644 /tmp/orb3sat-follower.service /etc/systemd/system/orb3sat-follower.service
sudo install -o root -g root -m 644 /tmp/orb3sat-sender.service /etc/systemd/system/orb3sat-sender.service
sha256sum /opt/orb3sat/follower.py /opt/orb3sat/sender.py
sudo systemctl daemon-reload
sudo systemctl enable --now orb3sat-sender
sudo systemctl restart orb3sat-follower
sleep 4
echo "follower: $(systemctl is-active orb3sat-follower)  sender: $(systemctl is-active orb3sat-sender)"
tail -3 /var/lib/orb3sat/events.jsonl'
echo DONE
