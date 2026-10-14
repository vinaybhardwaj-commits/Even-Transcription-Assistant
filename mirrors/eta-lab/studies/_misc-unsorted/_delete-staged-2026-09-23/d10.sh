#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t yoga-drain:1.1 C-u; sleep 1
$TMUX send-keys -t yoga-drain:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/yoga-split.md alongside the drain - complete order. V asked whether Yoga can speed this up and I will not answer him from the old verdict, because that verdict was about DIARIZATION only and the drain is fetch plus diarize plus transcribe plus write. Measure where the per-window time actually goes, then run the engine comparison that was never run - a clip that ORIGINATED ON THE MINI, sent to both engines, text compared - because the 0.0000 edit distance was Yoga's engines on Yoga's own clips and your own pane called that unfalsified rather than vindicated. Drain keeps priority; queue this if it would disturb it."; sleep 2
$TMUX send-keys -t yoga-drain:1.1 Enter; sleep 2
$TMUX send-keys -t yoga-drain:1.1 Enter; sleep 1
echo sent
