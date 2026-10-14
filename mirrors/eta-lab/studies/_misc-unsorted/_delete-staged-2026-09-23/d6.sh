#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t lx:1.1 C-u; sleep 1
$TMUX send-keys -t lx:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/lx-reenrol-check.md - complete order. Short version: your section 4 inversion just reversed my plan and is now load-bearing, so it has to stop being INFERRED. Verify it, get me the 0.535 comparison numbers for thin versus fat prints, tell me whether room-audio re-enrol is actually built, and cost the three defects without fixing them. Also note that the S2B kickoff's never-fired claim is stale - 957 of 12,471 turns are named."; sleep 2
$TMUX send-keys -t lx:1.1 Enter; sleep 2
$TMUX send-keys -t lx:1.1 Enter; sleep 1
echo sent
