#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
T=split-speaker:1.1
$TMUX send-keys -t $T C-u
sleep 1
$TMUX send-keys -t $T "V has finished all 25 clips. Score it now against the server-side key. Report, counts only, no transcript text and no clip content: (1) of the 14 CLAIMED, how many he said were the clinician / not him / cant tell - that is the false-positive rate over that 80-minute band; (2) the same three counts for the 8 CONTROL clips, which tell us whether to believe (1); (3) the 3 repeats - did he answer each repeat the same way as its first presentation, yes or no per pair; (4) his answer to the opening question about whether anyone else consulted in the room that day; (5) your own reading of what this does and does not license us to conclude, in under 150 words, including whether the control result invalidates the claimed number. Leave both servers up. Do not draw a conclusion the counts do not support, and say plainly if the sample is too small to carry one."
sleep 1
$TMUX send-keys -t $T Enter
sleep 2
$TMUX send-keys -t $T Enter
sleep 1
echo "sent -> split-speaker"
