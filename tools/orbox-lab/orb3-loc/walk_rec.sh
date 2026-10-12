#!/bin/bash
# O17 ruling 5. Run as the lab user on ORB3. NOT run by the builder (it plays sound).
# usage: walk_rec.sh [MAX_WALK_S]   one recording: 120 s of beacons, the phone walk (beacons silent), 120 s of beacons.
# The walk ends when the file ~/loc/walk_done appears (touch it) or after MAX_WALK_S (default 900).
MAX=${1:-900}
cd /home/lab/loc || exit 1
export XDG_RUNTIME_DIR=/run/user/$(id -u)
[ -f walk_block.wav ] || /var/lib/orb3-lab/venv/bin/python walk_track.py walk_block.wav
S=walk-$(date +%Y%m%d-%H%M%S); mkdir -p "$S"; rm -f walk_done
echo "mic1 start $(date +%s.%N)" >> "$S/start_times.log"
arecord -q -D hw:CARD=Device_1,DEV=0 -f S16_LE -r 48000 -c 1 -d $((MAX + 300)) "$S/mic1.wav" &
P1=$!
echo "mic2 start $(date +%s.%N)" >> "$S/start_times.log"
arecord -q -D hw:CARD=Device,DEV=0 -f S16_LE -r 48000 -c 1 -d $((MAX + 300)) "$S/mic2.wav" &
P2=$!
sleep 3
echo "pre start $(date +%s.%N)" >> "$S/start_times.log"; pw-play walk_block.wav
echo "WALK NOW: start the phone track; touch ~/loc/walk_done when it ends (max ${MAX} s)"
i=0; while [ $i -lt $MAX ] && [ ! -f walk_done ]; do sleep 1; i=$((i + 1)); done
echo "post start $(date +%s.%N)" >> "$S/start_times.log"; pw-play walk_block.wav
echo "post end $(date +%s.%N)" >> "$S/start_times.log"
sleep 2; kill -INT $P1 $P2; wait $P1 $P2
echo "WALK_REC_DONE $S"
