#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
T=split-speaker:1.1
$TMUX send-keys -t $T C-u; sleep 1
$TMUX send-keys -t $T "GO. V has the time now and has confirmed by name that he knows Dr. Prabhudev Salanki's voice - he answered on the id first, I gave him the name, he confirmed. Serve it tailnet-only on 8793 and send me the link. Verify the serving path end-to-end before you call it live, the same way you did for v2 - asked vs got on the first clip in the listener's order, page 200, Range 206, binds loopback plus tailnet only. 149 minutes against v2's 80 and 40 claimed against 14 is the whole point of this run, so say in one line what interval 40 clips can actually carry if the result comes back at a similar rate - I want to know before he listens whether this run can settle the question or only narrow it. Leave v1 and v2 up."; sleep 2
$TMUX send-keys -t $T Enter; sleep 2
$TMUX send-keys -t $T Enter; sleep 1
echo "sent"
$TMUX send-keys -t lx:1.1 C-u; sleep 1
$TMUX send-keys -t lx:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/lx-enrolment-survey.md - complete order, RESEARCHER role, report facts and build nothing. Short version: V wants voice enrolment fixed next; five of seven clinicians have a single sample; tell me what enrolment surface already exists before anyone builds, including whether we are matching far-field room audio against near-field centroids."; sleep 2
$TMUX send-keys -t lx:1.1 Enter; sleep 2
$TMUX send-keys -t lx:1.1 Enter; sleep 1
echo "sent -> lx"
