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
send scribe3:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/scribe3-direct.md - complete order. Short version: the JWT route is dead, Vercel will not export Secret values and JWT_SECRET_ADMIN came back as a placeholder. Call evaluateAndWriteWindows directly with the real BRAIN_DATABASE_URL, then delete the secrets file."
send fleet:1.1 "Read and execute /Users/vinaybhardwaj/dev/_fable/orders/fleet-next.md - complete order. Short version: your branch is merged at 4c0d689 and pushed, refutation passed, kill your two stale shells and prune the 29 old orphan volumes."
send scribe:1.1 "Done and merged - 0109 and 0111 went in together as 45eedda on vinay/s1-auto-drain, on top of the gate-and-volumes merge at 4c0d689, and both are pushed. I checked the known hazard myself before pushing: filenames and INSERT versions agree, 0109 to 109 and 0111 to 111. I also checked the 0110 gap, since that slice is parked - app/api/run-migrations/route.ts sorts by version and skips via appliedVersions.includes, with no contiguity requirement, so the gap is safe and 0110 can land later out of numeric order. Your rebase call was the right one and the number that matters is that it went from 134 files / 3084 tests to 142 / 3174 with the 75 s1-only tests now included and green - a gate measured against the wrong base would have hidden all of them. Promoting to production shortly. NEXT TASK: nothing yet - stand by, I will come back to you after the promote lands. Do not push or promote anything."
