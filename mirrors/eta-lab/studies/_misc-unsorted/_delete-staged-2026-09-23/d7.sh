#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
send() {
  $TMUX send-keys -t $1 C-u; sleep 1
  $TMUX send-keys -t $1 "$2"; sleep 2
  $TMUX send-keys -t $1 Enter; sleep 2
  $TMUX send-keys -t $1 Enter; sleep 1
  echo "sent -> $1"
}
send yoga-drain:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/yoga-drain-START.md - complete order. Short version: the watchdog gate is passed, START THE DRAIN. Report the mechanism in three lines before you start it, then give me a real rate. 4.9 percent of windows have ever been diarized and that is now the critical path for everything."
send scribe3:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/scribe3-db.md - complete order, it answers your question. Short version: you were right again. APP_DATABASE_URL is a placeholder and DATABASE_URL is absent entirely, so BRAIN_DATABASE_URL is the only real one I have and I cannot tell from outside whether it is the app database either. Compare it against the URL in V's Neon RTF, print only SAME or DIFFERENT, and use the app one. Worktree at 45eedda, not eda31b0 - that is production now."
send fleet:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/fleet-worktrees.md - complete order. Short version: your 47-not-29 count was the better measurement, but six worktrees still carry the bare rm -f harness, so the leak is fixed in production and still live on the machine where it actually cost us. Fix the idle ones, list the ones a pane is using, do not prune while yoga-drain is running a diarization job."
