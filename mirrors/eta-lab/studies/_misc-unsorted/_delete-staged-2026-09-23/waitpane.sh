#!/bin/zsh
T=/opt/homebrew/bin/tmux
for i in {1..25}; do
  $T capture-pane -p -t scribe3:1.1 | grep -qE "(Brewed|Churned|Cooked|Baked|Cogitated|Sautéed|Crunched) for .* done" && break
  sleep 10
done
date
$T capture-pane -p -S -40 -t scribe3:1.1 | grep -v '^\s*$' | tail -12 | cut -c1-160
