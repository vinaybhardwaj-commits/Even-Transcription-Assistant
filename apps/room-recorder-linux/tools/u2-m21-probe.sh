#!/bin/bash
# M2.1: can a non-login service account open the pinned mic's PCM with NO seat user logged in?
# Needs root. It stops the display manager (which on this Yoga also ends the gdm-autologin session), measures, and
# restores it. Measurement only: it creates a system account and no unit, no udev rule, no permission change.
# usage: sudo tools/u2-m21-probe.sh [DEVICE]
set -u
dev=${1:-hw:CARD=Device,DEV=0}
node=/dev/snd/pcmC1D0c
here=$(cd "$(dirname "$0")/.." && pwd)
acct=roomrec-probe
stage=/usr/local/lib/room-recorder-probe
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 2; }

# /home/vinay is mode 750, so a service account cannot traverse it: the binary is staged outside /home for the test.
# (Measured 16 Sep: running it in place failed with "Permission denied" (exit 126) before any audio call. U4 installs
# the real binary outside /home for the same reason.)
install -d -m 0755 "$stage"
install -m 0755 "$here/.build/release/room-recorder" "$stage/room-recorder"
bin="$stage/room-recorder"

echo "== BEFORE: a seat session exists"
loginctl list-sessions --no-legend | sed 's/^/  /'
echo "  node: $(ls -l $node)"
getfacl -p $node 2>/dev/null | sed 's/^/  /'

id -u $acct >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin -G audio $acct
echo "  probe account: $(id $acct)"

echo "== stopping the display manager (ends the seat session; SSH sessions survive)"
systemctl stop gdm 2>/dev/null || systemctl stop gdm3 2>/dev/null
sleep 3
echo "  sessions now:"; loginctl list-sessions --no-legend | sed 's/^/    /' || echo "    (none)"
echo "  node: $(ls -l $node)"
echo "  getfacl with no seat user:"; getfacl -p $node 2>/dev/null | sed 's/^/    /'

tape=/var/tmp/u2-m21-probe-tape
rm -rf $tape; install -d -o $acct -g $acct -m 0750 $tape
echo "== the service account opens the device with nobody logged in"
echo "  binary staged at $bin ($(stat -c %A $bin)); tape dir $tape owned by $acct"
sudo -u $acct env HOME=/var/tmp "$bin" record --device "$dev" --tape $tape/tape --seconds 5 > /tmp/u2-m21-probe.json 2>/tmp/u2-m21-probe.err
rc=$?
echo "  exit $rc"
[ -s /tmp/u2-m21-probe.err ] && echo "  stderr: $(head -3 /tmp/u2-m21-probe.err)"
[ $rc -eq 0 ] && python3 -c "
import json; s=json.load(open('/tmp/u2-m21-probe.json'))
print('  recorded', s['samples'], 'samples;', s['records'], 'records; device', s['device']['name'], s['negotiated'])" 2>/dev/null

echo "== also: the same account WITHOUT group audio (isolates the group from the ACL)"
gpasswd -d $acct audio >/dev/null 2>&1
sudo -u $acct env HOME=/var/tmp "$bin" record --device "$dev" --tape $tape/tape2 --seconds 3 >/dev/null 2>/tmp/u2-m21-nogroup.err
echo "  exit $? ; stderr: $(head -2 /tmp/u2-m21-nogroup.err)"
usermod -aG audio $acct

echo "== restoring the display manager"
systemctl start gdm 2>/dev/null || systemctl start gdm3 2>/dev/null
sleep 3
loginctl list-sessions --no-legend | sed 's/^/  /'
rm -rf "$stage"
echo "== done. Staged binary removed. Remove the probe account with: sudo userdel roomrec-probe"
