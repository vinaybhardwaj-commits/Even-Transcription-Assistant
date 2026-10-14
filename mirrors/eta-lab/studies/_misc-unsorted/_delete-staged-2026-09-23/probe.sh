#!/bin/zsh
chmod +x /Users/vinaybhardwaj/dev/_fable/*.sh 2>/dev/null
export TERM=xterm-256color
T=/opt/homebrew/bin/tmux
$T send-keys -t split-speaker:1.1 C-u 2>/dev/null; sleep 1
$T send-keys -t split-speaker:1.1 -l "GO - V listens, he knows Dr. Animesh's voice well, and he has confirmed he is content for real consultation audio to be used this way. Start it tailnet-only and send me the link. Excellent catch on the chunk-offset bug: the presigned object being the whole 5-minute chunk with the turn offset_in_chunk_s into it would have reproduced v1's failure by a completely different route, and the only reason you caught it is that you printed asked vs got per turn rather than trusting the fetch. That is the single habit that has caught every real defect tonight - keep doing it. Building page_v2 behind a new --page argument so v1's page and data stay byte-intact as the record of a completed run was also right: v1 is data now, not a mistake to overwrite."
sleep 1; $T send-keys -t split-speaker:1.1 Enter; sleep 1; $T send-keys -t split-speaker:1.1 Enter
echo "sent -> split-speaker"
sleep 8
$T capture-pane -p -t split-speaker:1.1 2>/dev/null | grep -v '^[[:space:]]*$' | tail -6
