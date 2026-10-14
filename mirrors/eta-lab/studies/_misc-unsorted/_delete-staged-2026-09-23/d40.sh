#!/bin/zsh
T=/opt/homebrew/bin/tmux
$T send-keys -t scribe3:1.1 C-u; sleep 1
$T send-keys -t scribe3:1.1 "Read /Users/vinaybhardwaj/dev/_fable/orders/scribe3-jev-english-path.md and act on it."; sleep 2
$T send-keys -t scribe3:1.1 Enter; sleep 2; $T send-keys -t scribe3:1.1 Enter; echo sent
