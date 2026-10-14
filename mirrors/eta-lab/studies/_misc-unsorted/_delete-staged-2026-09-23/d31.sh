#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t lx:1.1 C-u; sleep 1
$TMUX send-keys -t lx:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/lx-multicentroid-survey.md - RESEARCHER, facts only, build nothing. V has decided two things: voiceprints come only from HARVESTED audio, no special recordings; and each doctor gets a MULTI-CENTROID profile, one centroid per acoustic domain, so they can use ETA on their phones as well as in the room. Before anyone designs, tell me what already exists: the 14 Sep multi-centroid plan in docs/handoff, whether migration 0108 can hold one centroid per domain per clinician, whether the matcher knows which domain audio came from at match time given it already uses different thresholds for room and phone, how much phone-session audio we already hold per doctor, and whether a doctor's own phone sessions share one recurring voice across many patients. Your corrections on the 0.908 figure were exactly right and are now in the ledger."; sleep 2
$TMUX send-keys -t lx:1.1 Enter; sleep 2
$TMUX send-keys -t lx:1.1 Enter; sleep 1
echo sent
