#!/bin/bash
: "${ORB3_LAB_ROOT:?set ORB3_LAB_ROOT to the lab directory on ORB3}"
# usage: beacon_rec.sh D   (seconds of track, default 360). Run as the lab user from anywhere.
D=${1:-360}
cd $ORB3_LAB_ROOT/o9-run6 || exit 1
export XDG_RUNTIME_DIR=/run/user/$(id -u)
S=$(date +%Y%m%d-%H%M%S); R=$(( D + 10 ))
mkdir -p "$S"; : > "$S/start_times.log"
T0=$(date '+%Y-%m-%d %H:%M:%S')
echo "run $S, track $D s, record $R s"
echo "mic1 start $(date +%s.%N)" >> "$S/start_times.log"
arecord -q -D hw:CARD=Device_1,DEV=0 -f S16_LE -r 48000 -c 1 -d $R "$S/mic1.wav" &
P1=$!
echo "mic2 start $(date +%s.%N)" >> "$S/start_times.log"
arecord -q -D hw:CARD=Device,DEV=0   -f S16_LE -r 48000 -c 1 -d $R "$S/mic2.wav" &
P2=$!
sleep 3
echo "play start $(date +%s.%N)" >> "$S/start_times.log"
pw-play beacon_track.wav
echo "play end $(date +%s.%N)" >> "$S/start_times.log"
wait $P1 $P2
if journalctl -k --since "$T0" --no-pager 2>/dev/null | grep -E 'usb .* disconnect' > "$S/usb_events.txt"; then :; fi
if ! journalctl -k --since "$T0" --no-pager >/dev/null 2>&1; then
  echo "journalctl -k not readable as $(id -un); usb events NOT checked" | tee "$S/usb_events_unreadable.txt"
fi
echo "usb events: $(wc -l < "$S/usb_events.txt")"
echo "BEACON_REC_DONE $S"
