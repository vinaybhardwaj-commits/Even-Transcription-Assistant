#!/bin/bash
cd /var/lib/orb3-lab/run1
U=orbox3; RD=/run/user/$(id -u $U)
for g in 21 31 41 51 62; do
  for c in Device_1 Device; do amixer -q -c $c sset Mic $g; done
  arecord -q -D hw:CARD=Device_1,DEV=0 -f S16_LE -r 48000 -c 1 -d 36 micA_g$g.wav &
  arecord -q -D hw:CARD=Device,DEV=0   -f S16_LE -r 48000 -c 1 -d 36 micB_g$g.wav &
  sleep 1.5
  sudo -u $U XDG_RUNTIME_DIR=$RD pw-play /var/lib/orb3-lab/testsig.wav
  wait
  echo "$(date +%T) gain $g done" >> ../capture.log
done
for c in Device_1 Device; do amixer -q -c $c sset Mic 51; done
echo "$(date +%T) ALL DONE" >> ../capture.log
