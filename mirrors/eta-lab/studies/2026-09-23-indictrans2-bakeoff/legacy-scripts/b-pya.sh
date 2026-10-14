#!/bin/zsh
export PATH=/opt/homebrew/bin:$PATH
cd ~/dev/_fable/scratch/pyabake || exit 1
LOG=fetch.log
touch "$LOG"
for m in manifests/*.json; do
  wid=$(basename "$m" .json)
  out="audio/${wid}.wav"
  if [ -f "$out" ]; then
    echo "SKIP $wid (exists)" >> "$LOG"
    continue
  fi
  echo "FETCHING $wid" >> "$LOG"
  python3 ~/dev/_fable/fetch_audio.py "$m" "$out" >> "$LOG" 2>&1
done
chmod 600 audio/*.wav 2>/dev/null
echo "FETCH_DONE" >> "$LOG"
