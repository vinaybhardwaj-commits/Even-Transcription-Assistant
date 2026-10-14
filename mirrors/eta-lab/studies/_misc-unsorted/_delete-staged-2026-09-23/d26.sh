#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t split-speaker:1.1 C-u; sleep 1
$TMUX send-keys -t split-speaker:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/split-speaker-novoice.md - V found a flaw in every test since v1 and he is right. Many clips are ambient room noise with NO VOICE, and our three buttons assumed every clip had one, so voiceless clips landed in different on some pairs and cant tell on others, inconsistently. That contaminates every cant-tell rate and every different or not-him answer we have reported, including the controls. What survives is the same-person and yes-thats-him answers, because V only gave those when a voice was present AND he could identify it. Three tasks: score v6 on same-person answers only; measure voicelessness automatically across every clip served in v1 to v6 using whatever speech-presence measure is already on the Mini, because if a large share are voiceless the diarizer is labelling room noise as speech and that poisons enrolment just like the gluing does; and design v7 to filter voiceless clips out before V ever hears them. Build nothing yet."; sleep 2
$TMUX send-keys -t split-speaker:1.1 Enter; sleep 2
$TMUX send-keys -t split-speaker:1.1 Enter; sleep 1
echo sent
