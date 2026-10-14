#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
T=split-speaker:1.1
$TMUX send-keys -t $T C-u; sleep 1
$TMUX send-keys -t $T "V has finished all 65 clips. Score v3 against the server-side key now. Counts only, no transcript text, no clip content. Report: (1) of the 40 CLAIMED - clinician / not him / cant tell, with the exact 95 percent interval on the not-him rate; (2) the same three for the 20 CONTROL; (3) the 5 repeat pairs - same answer as first presentation, yes or no per pair; (4) his answer to the opening question; (5) THE COMPARISON, which is the point of this run - put v2 and v3 side by side and say whether v3 replicates v2. State plainly whether the two intervals overlap, and whether anything here suggests v2's 13 of 14 was a property of that one voice or room rather than the matcher. (6) Your own reading in under 150 words, including whether the control result invalidates the claimed number, and whether the two runs pooled carry a tighter conclusion than either alone - if you pool them say explicitly what assumption pooling requires and whether it holds, because two different clinicians on the same day is not two independent draws from the same process unless you argue it is. Do not draw a conclusion the counts do not support and say plainly where the sample is still too small. Leave all three servers up."; sleep 2
$TMUX send-keys -t $T Enter; sleep 2
$TMUX send-keys -t $T Enter; sleep 1
echo sent
