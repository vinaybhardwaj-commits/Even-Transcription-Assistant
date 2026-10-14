#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
echo "=== panes ==="
$TMUX list-panes -a -F "#{session_name}:#{window_index}.#{pane_index} #{pane_current_command}"
echo
for P in $($TMUX list-panes -a -F "#{session_name}:#{window_index}.#{pane_index}"); do
  echo "----- $P -----"
  $TMUX capture-pane -p -S -14 -t "$P" 2>/dev/null | grep -v '^\s*$' | tail -n 10
  echo
done
