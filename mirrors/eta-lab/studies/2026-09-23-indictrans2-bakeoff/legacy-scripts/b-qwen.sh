#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd /Users/vinaybhardwaj/dev/eta-qwen-out-wt || exit 1
LOG=/Users/vinaybhardwaj/dev/_fable/full-test-out.log
: > "$LOG"
echo "=== which docker/node ===" >> "$LOG"
which docker node npm npx >> "$LOG" 2>&1
echo "=== typecheck:tests ===" >> "$LOG"
npm run typecheck:tests >> "$LOG" 2>&1
echo "TYPECHECK_EXIT:$?" >> "$LOG"
echo "=== vitest run ===" >> "$LOG"
npx vitest run >> "$LOG" 2>&1
echo "FULL_SUITE_EXIT:$?" >> "$LOG"
echo "DONE" >> "$LOG"
