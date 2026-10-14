#!/bin/bash
cd /var/lib/orb3-lab; U=orbox3; RD=/run/user/$(id -u $U)
rec(){ arecord -q -D hw:CARD=Device_1,DEV=0 -f S16_LE -r 48000 -c 1 -d $2 run4/micA_$1.wav & arecord -q -D hw:CARD=Device,DEV=0 -f S16_LE -r 48000 -c 1 -d $2 run4/micB_$1.wav & }
for c in Device_1 Device; do amixer -q -c $c sset Mic 41; done
rec chanid 13; sleep 1.5; sudo -u $U XDG_RUNTIME_DIR=$RD pw-play run4/chanid.wav; wait; echo "chanid $(date +%T)"
for t in $(./venv/bin/python -c 'import json;print(" ".join(f"{n}:{g}" for n,g in json.load(open("run4/takes.json"))))'); do
  n=${t%:*}; g=${t#*:}
  for c in Device_1 Device; do amixer -q -c $c sset Mic $g; done; sleep 1
  rec $n 53; sleep 1.5; sudo -u $U XDG_RUNTIME_DIR=$RD pw-play run4/$n.wav; wait; echo "$n g$g $(date +%T)"
done
for c in Device_1 Device; do amixer -q -c $c sset Mic 41; done
echo RUN4_REC_DONE
./venv/bin/python run4_score.py > run4_score.log 2>&1
