#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t scribe:1.1 C-u; sleep 1
$TMUX send-keys -t scribe:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/scribe-joiner.md - BUILDER task. scribe3 established tonight that clips are written only by roomWindowPrepare, phase 1 of the room_window job at lib/stt/room-drain.ts:647, and there is no join-only path - so making one clip today costs a full join plus probe plus Whisper, about 105 Mini-hours for the backlog, where a join-only path would be roughly 3.5 to 10 hours and 9.5 GB. Ten times cheaper, so I am calling it. Reuse the existing join step rather than reimplementing it, and if phase 1 cannot be invoked without phases 2 and 3 show me the seam instead of copying logic. Idempotent, interruptible, one window at a time, NO bulk run, and it must not disturb the night-drain which is finally working at 63 windows an hour. Tests first. Also tell me what you think about the 211 clipless windows sitting in rooms with transcript_enabled false - my instinct is a join-only path should leave them alone because that flag is someone's explicit choice, but I want your read."; sleep 2
$TMUX send-keys -t scribe:1.1 Enter; sleep 2
$TMUX send-keys -t scribe:1.1 Enter; sleep 1
echo sent
