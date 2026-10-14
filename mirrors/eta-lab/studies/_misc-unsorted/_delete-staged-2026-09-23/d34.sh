#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t lx:1.1 C-u; sleep 1
$TMUX send-keys -t lx:1.1 "One more addition, point 4 of RULING 2: V wants the Jev route as well where it works. Phone voiceprints will use two independent signals - the recurring voice across login-narrowed sessions, and Jev judging from the transcript which speaker is the clinician. Where they agree, high confidence; where they disagree, hold out. So in your survey also report: does the existing jev_role_signal from migration 0107 run on phone sessions today, how many phone sessions have transcript text it could read, and what share of that text is non-English and would need translating first."; sleep 2
$TMUX send-keys -t lx:1.1 Enter; sleep 2
$TMUX send-keys -t lx:1.1 Enter; sleep 1
echo sent
