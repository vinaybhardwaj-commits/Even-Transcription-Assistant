#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t split-speaker:1.1 C-u; sleep 1
$TMUX send-keys -t split-speaker:1.1 "BUILD IT - V is ready now and this does not depend on scribe or scribe3. Read and execute /Users/vinaybhardwaj/dev/_fable/orders/split-speaker-rollcall-build.md. Short version: six unenrolled doctors, 8 clips each at 10-20 seconds, doctor named on every clip because this is identification not a blind test, and about 20 percent controls drawn from a DIFFERENT doctor's slot presented under the first doctor's name. That control is the whole point - if V confirms a clip that came from someone else's slot, roster-based labelling is untrustworthy and the enrolment-harvest idea fails. Include the doctor whose 3247 seconds came from 16 turns of 200 seconds each, sampling windows from inside those blocks, and tell me whether what you hear is one voice or a mis-segmented block of several, because if our segmenter is gluing a whole consultation into one turn that matters well beyond enrolment. All the v2/v3 invariants. Do not enrol anyone, do not touch a centroid, do not create clinician records."; sleep 2
$TMUX send-keys -t split-speaker:1.1 Enter; sleep 2
$TMUX send-keys -t split-speaker:1.1 Enter; sleep 1
echo sent
