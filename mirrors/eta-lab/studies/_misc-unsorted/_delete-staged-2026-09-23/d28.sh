#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t yoga-drain:1.1 C-u; sleep 1
$TMUX send-keys -t yoga-drain:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/yoga-drain-supervise-nightdrain.md. Short version: the night-drain did 620 windows last night but it is running as a background shell owned by the scribe3 pane, so if that pane closes the drain dies, and it will not survive a reboot. Put it under launchd with the same bootout-then-bootstrap pattern you used for the watchdog, token read from file never from the plist or command line, closed-hours gate unchanged, cut over while it is idle so two drains never run at once, and prove exactly one process afterwards that is not a child of any tmux pane."; sleep 2
$TMUX send-keys -t yoga-drain:1.1 Enter; sleep 2
$TMUX send-keys -t yoga-drain:1.1 Enter; sleep 1
echo sent
