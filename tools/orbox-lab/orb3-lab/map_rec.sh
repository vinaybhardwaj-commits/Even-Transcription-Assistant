#!/bin/bash
cd /var/lib/orb3-lab; U=orbox3; RD=/run/user/$(id -u $U); D=${1:-2700}
for c in Device_1 Device; do amixer -q -c $c sset Mic 41; done
arecord -q -D hw:CARD=Device_1,DEV=0 -f S16_LE -r 48000 -c 1 -d $D run5/micA_map.wav &
arecord -q -D hw:CARD=Device,DEV=0   -f S16_LE -r 48000 -c 1 -d $D run5/micB_map.wav &
echo "rec start $(date +%T)"; sleep 5
sudo -u $U XDG_RUNTIME_DIR=$RD pw-play run5/probe.wav; echo "speaker probe done $(date +%T)"
wait; echo "MAP_REC_DONE $(date +%T)"
