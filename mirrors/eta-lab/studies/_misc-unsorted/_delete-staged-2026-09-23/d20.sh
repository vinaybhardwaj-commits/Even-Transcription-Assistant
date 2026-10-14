#!/bin/zsh
TMUX=/opt/homebrew/bin/tmux
[ -x "$TMUX" ] || TMUX=/usr/local/bin/tmux
$TMUX send-keys -t scribe3:1.1 C-u; sleep 1
$TMUX send-keys -t scribe3:1.1 "V has authorised the token - his words were that I have Vercel access through the browser and can put any token I like. Read and execute /Users/vinaybhardwaj/dev/_fable/orders/scribe3-door-token.md. Use the vercel CLI from the Mini rather than a browser, it is faster. Re-verify the hash scheme in lib/mcp/auth.ts before computing anything, add a night-drain actor with READ SCOPE ONLY to SCRIBE_MCP_TOKENS without clobbering any existing entry, count entries before and after, install the matching token on the Mini at 0600, promote a new production deployment because env bakes at build time here, prove the door goes from 401 to 200, then start the drain and give me the first real per-window breakdown. Never print any token value and never put one on a command line."; sleep 2
$TMUX send-keys -t scribe3:1.1 Enter; sleep 2
$TMUX send-keys -t scribe3:1.1 Enter; sleep 1
echo "sent -> scribe3"
$TMUX capture-pane -p -S -34 -t split-speaker:1.1 | grep -v '^\s*$' | tail -n 30
