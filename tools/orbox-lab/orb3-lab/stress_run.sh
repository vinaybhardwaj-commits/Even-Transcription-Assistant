#!/bin/bash
cd /var/lib/orb3-lab; U=orbox3; RD=/run/user/$(id -u $U)
for c in Device_1 Device; do amixer -q -c $c sset Mic 41; done
for snr in 20 10 5 0 -5; do
  arecord -q -D hw:CARD=Device_1,DEV=0 -f S16_LE -r 48000 -c 1 -d 48 run3/micA_snr$snr.wav &
  arecord -q -D hw:CARD=Device,DEV=0   -f S16_LE -r 48000 -c 1 -d 48 run3/micB_snr$snr.wav &
  sleep 1.5; sudo -u $U XDG_RUNTIME_DIR=$RD pw-play run3/mix_snr$snr.wav; wait
  echo "$(date +%T) stress snr $snr done" >> capture.log
done
echo "$(date +%T) STRESS CAPTURE DONE" >> capture.log
