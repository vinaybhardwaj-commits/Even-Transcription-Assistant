#!/bin/zsh
export TERM=xterm-256color
/opt/homebrew/bin/tmux list-sessions 2>&1
echo "=== panes ==="
/opt/homebrew/bin/tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} title=#{pane_title} cmd=#{pane_current_command}' 2>&1
