#!/bin/zsh
export TERM=xterm-256color
T=/opt/homebrew/bin/tmux
M=/Users/vinaybhardwaj/dev/_fable/msgs
send () {
  local sess="$1" file="$2"
  if [ ! -f "$file" ]; then echo "MISSING $file"; return; fi
  $T load-buffer -b fb "$file" 2>&1 || { echo "load failed $sess"; return; }
  $T paste-buffer -b fb -t "$sess:1.1" 2>&1 || { echo "paste failed $sess"; return; }
  sleep 1
  $T send-keys -t "$sess:1.1" Enter 2>&1
  echo "sent -> $sess ($(wc -c < "$file" | tr -d ' ') bytes)"
}
send yoga-drain "$M/yoga-drain.txt"
send fleet      "$M/fleet.txt"
