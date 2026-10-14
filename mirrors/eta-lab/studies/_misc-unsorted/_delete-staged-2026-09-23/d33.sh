#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t lx:1.1 C-u; sleep 1
$TMUX send-keys -t lx:1.1 "Update to your multi-centroid survey, read RULING 2 appended to /Users/vinaybhardwaj/dev/_fable/orders/RULING-durable-centroids.md. V has ruled the login IS allowed for narrowing: a doctor's own login may decide which phone sessions to look in, and within those the doctor is identified by voice as the one speaker recurring across their sessions while patients change. The login is never the label on its own, and this covers phone sessions only - rosters and room bindings stay out for room audio. So question 5 in your order is now the load-bearing one: measure whether a doctor's phone sessions really do share one recurring speaker across different patients, with numbers, because that is now the whole mechanism for phone voiceprints."; sleep 2
$TMUX send-keys -t lx:1.1 Enter; sleep 2
$TMUX send-keys -t lx:1.1 Enter; sleep 1
echo sent
