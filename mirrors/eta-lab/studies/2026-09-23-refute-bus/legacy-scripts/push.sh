#!/bin/zsh
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
cd "$R" || exit 1
echo "head: $(git rev-parse --short HEAD)"
git push origin vinay/s1-auto-drain 2>&1 | tail -6
echo "rc=$?"
git log --oneline -1
