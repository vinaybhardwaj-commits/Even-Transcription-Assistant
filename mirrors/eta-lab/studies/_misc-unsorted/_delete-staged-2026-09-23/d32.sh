#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t split-speaker:1.1 C-u; sleep 1
$TMUX send-keys -t split-speaker:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/split-speaker-jev-trial.md. V suggested Jev. Jev reads TEXT not audio, so it cannot compare voices - but it is built to judge whether a transcript is garbage, which gives a second independent noise signal: Silero judges the sound, Jev judges the words. Step zero first: check that the closed-hours segments and V's affirmed clips actually HAVE transcript text, and stop if they do not. If they do, run a small prompt trial with free labels - closed-hours text is noise by construction, V-affirmed text is real speech. English only, translate or exclude and count exclusions, strip state to the text alone, log ids and probabilities never text. Trial only, wire nothing."; sleep 2
$TMUX send-keys -t split-speaker:1.1 Enter; sleep 2
$TMUX send-keys -t split-speaker:1.1 Enter; sleep 1
echo sent
