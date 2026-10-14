#!/bin/zsh
T=/opt/homebrew/bin/tmux
send() { $T send-keys -t $1 C-u; sleep 1; $T send-keys -t $1 "$2"; sleep 2; $T send-keys -t $1 Enter; sleep 2; $T send-keys -t $1 Enter; sleep 1; echo "sent -> $1"; }
O=/Users/vinaybhardwaj/dev/_fable/orders
send split-speaker:1.1 "Read $O/split-speaker-J0-go.md and act on it."
send lx:1.1 "Good report. Rulings on your points are at the end of $O/RULING-durable-centroids.md (erratum for 0.908, Ruling 4: new voice_centroid table later, do not reshape 0108). Carry on with the recurrence measurement. When you compute recurrence from encounter.speakers, EXCLUDE any encounter whose speaker was named by the matcher (the process/route.ts:621 path) as the evidence for that same doctor - that is the circularity you flagged. Report the recurrence figures when your agent returns."
