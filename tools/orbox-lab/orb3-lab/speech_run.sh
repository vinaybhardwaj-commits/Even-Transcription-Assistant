#!/bin/bash
set -e
cd /var/lib/orb3-lab
./venv/bin/piper --model voices/en_US-lessac-medium.onnx --output_file speech_raw.wav < speech_text.txt
ffmpeg -loglevel error -y -i speech_raw.wav -af "apad=pad_dur=1,adelay=1000|1000" -ar 48000 -ac 2 speech.wav
chmod 644 speech.wav
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 speech.wav); REC=$(python3 -c "print(int(float('$D'))+4)")
mkdir -p run2; U=orbox3; RD=/run/user/$(id -u $U)
for g in 31 41 51; do
  for c in Device_1 Device; do amixer -q -c $c sset Mic $g; done
  arecord -q -D hw:CARD=Device_1,DEV=0 -f S16_LE -r 48000 -c 1 -d $REC run2/micA_g$g.wav &
  arecord -q -D hw:CARD=Device,DEV=0   -f S16_LE -r 48000 -c 1 -d $REC run2/micB_g$g.wav &
  sleep 1.5; sudo -u $U XDG_RUNTIME_DIR=$RD pw-play speech.wav; wait
  echo "$(date +%T) speech gain $g done" >> capture.log
done
for c in Device_1 Device; do amixer -q -c $c sset Mic 41; done
echo "$(date +%T) SPEECH CAPTURE DONE (dur $D)" >> capture.log
