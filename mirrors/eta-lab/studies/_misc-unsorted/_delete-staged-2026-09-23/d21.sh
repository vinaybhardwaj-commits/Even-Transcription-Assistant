#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t split-speaker:1.1 C-u; sleep 1
$TMUX send-keys -t split-speaker:1.1 "Excellent scoring, and the 40 percent control false-confirmation is the number that decides the next move. Read and execute /Users/vinaybhardwaj/dev/_fable/orders/split-speaker-v6-pairs.md. Short version: your fix worked - 2.8 times the confirmed audio - but the instrument did not move at all, 49 versus 48 percent can't tell, and controls got WORSE. That means no amount of extra clips will make ear-labelling safe enough for a permanent centroid. So stop asking V to NAME voices and ask him to MATCH them: pairs, same person or different people or can't tell, with no doctor names anywhere on the page. Discrimination is a far easier task than identification and it is also what we actually need, since pooling clips by speaker does not require a name. Include same-slot-different-diarizer-speaker pairs - that tests whether the diarizer OVER-splits, the mirror image of the gluing you found. And push back before building if you think pairs will saturate the same way, because if 49 percent can't tell is about audio quality rather than task design then this change helps nobody and I want to hear that now."; sleep 2
$TMUX send-keys -t split-speaker:1.1 Enter; sleep 2
$TMUX send-keys -t split-speaker:1.1 Enter; sleep 1
echo sent
