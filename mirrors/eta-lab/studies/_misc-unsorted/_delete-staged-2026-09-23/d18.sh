#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
for P in split-speaker:1.1 scribe:1.1 ETA-Refuter:1.1 scribe3:1.1; do
  $TMUX send-keys -t $P C-u; sleep 1
  $TMUX send-keys -t $P "RULING FROM V, read /Users/vinaybhardwaj/dev/_fable/orders/RULING-durable-centroids.md before your next step - it changes the spine of the programme. His words: we have to develop durable centroids for doctors voices and not use any other proxies. So the roster, room_day.doctor_id which is NULL in all 106 room-days, the patient queue system and room slugs are all OUT as ground truth. V's ear is the label. The roster survives only as a hint for FINDING candidate audio, never as the label itself. Durable means rebuildable, room-domain, long enough, versioned and multi-sample - and today six of seven prints keep no audio, which is the opposite of durable. Finish your current task, do not restart it; this is framing for what comes next."; sleep 2
  $TMUX send-keys -t $P Enter; sleep 2
  $TMUX send-keys -t $P Enter; sleep 1
  echo "sent -> $P"
done
