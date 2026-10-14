#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
MSG="NEW STANDING RULE from V: there is now a shared findings ledger at docs/handoff/ETA-FINDINGS-LEDGER.md in the Even-Transcription-Assistant repo. Read it before every task and search it for your topic. When you establish a finding, append ONE line under the right heading - what was measured, the number, the evidence path - in the format shown at the top. Never edit or delete another pane's line; if you disprove one, append a new line marked SUPERSEDES. It holds findings only: no orders, no reasoning chains, no verdicts. Orders still come only from me as files in _fable/orders. Read the rules at the top of the file now."
for P in split-speaker:1.1 scribe3:1.1 fleet:1.1 yoga-drain:1.1 lx:1.1 ETA-Refuter:1.1; do
  $TMUX send-keys -t $P C-u; sleep 1
  $TMUX send-keys -t $P "$MSG"; sleep 2
  $TMUX send-keys -t $P Enter; sleep 2
  $TMUX send-keys -t $P Enter; sleep 1
  echo "sent -> $P"
done
$TMUX send-keys -t scribe:1.1 C-u; sleep 1
$TMUX send-keys -t scribe:1.1 "$MSG Then read and execute /Users/vinaybhardwaj/dev/_fable/orders/scribe-SPEECH-GATE.md - BUILDER task, top priority from V. Root cause is established: the diarization path has no speech gate at all, the Silero VAD we need already exists on the Mini but only on the transcription router, and roomEnergyFloor ignores its room argument. Put the existing Silero in front of segment storage behind a flag defaulting off, prefer flagging over dropping so nothing is destroyed, fix the room floor, and prove it on the 7,548 segments that fall between 21:00 and 07:00 when no consultation can happen - free ground truth, but hold part of it back and report on the held-out part."; sleep 2
$TMUX send-keys -t scribe:1.1 Enter; sleep 2
$TMUX send-keys -t scribe:1.1 Enter; sleep 1
echo "sent -> scribe"
