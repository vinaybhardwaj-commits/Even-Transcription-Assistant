#!/bin/zsh
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
cd "$R" || exit 1
LOG=/Users/vinaybhardwaj/dev/_fable/test-vad.log
rm -f "$LOG" /Users/vinaybhardwaj/dev/_fable/test-vad.done
nohup zsh -c 'cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow && npm test > /Users/vinaybhardwaj/dev/_fable/test-vad.log 2>&1; echo $? > /Users/vinaybhardwaj/dev/_fable/test-vad.done' > /dev/null 2>&1 &
echo "started pid $!"
