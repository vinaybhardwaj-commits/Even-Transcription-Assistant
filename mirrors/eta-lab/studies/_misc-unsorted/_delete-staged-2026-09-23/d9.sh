#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t split-speaker:1.1 C-u; sleep 1
$TMUX send-keys -t split-speaker:1.1 "PART 2 follows the cross-check, read it now because it changes what you keep: /Users/vinaybhardwaj/dev/_fable/orders/split-speaker-rollcall.md. V's point is that the roster lets us find many more doctors and clips. He is right, and the bigger prize is not more verification - it is ENROLMENT HARVEST. Clips cut from a doctor's own rostered slot in their own room, identified by V, are labelled room-domain audio for doctors who have never enrolled and cannot be reached on a Sunday. That is exactly the acoustic domain our close-mic voiceprints are missing. Inventory first, build nothing. Exclude every shared slot - enrolling one doctor on another's voice would poison the centroid permanently and six of seven prints keep no audio to undo it with. If there is not enough diarized material today, say wait for the drain rather than padding the table."; sleep 2
$TMUX send-keys -t split-speaker:1.1 Enter; sleep 2
$TMUX send-keys -t split-speaker:1.1 Enter; sleep 1
echo sent
