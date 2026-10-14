#!/bin/zsh
F=/Users/vinaybhardwaj/dev/_fable
REPO=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
O=$F/r3-exact.txt
{
echo "=== fuse-arms.test.ts test count AT 5c0ceb3 (pre) ==="
cd $F/wt3-pre && npx vitest run tests/unit/fuse-arms.test.ts 2>&1 | grep -E "Test Files|Tests  |FAIL" | head -6
echo "=== fuse-arms.test.ts test count AT 38a7dac (fix) ==="
cd $F/wt3-fix && npx vitest run tests/unit/fuse-arms.test.ts 2>&1 | grep -E "Test Files|Tests  |FAIL" | head -6
echo "=== static it() counts ==="
echo "pre: $(grep -c '  it(' $F/wt3-pre/tests/unit/fuse-arms.test.ts)"
echo "fix: $(grep -c '  it(' $F/wt3-fix/tests/unit/fuse-arms.test.ts)"
echo "=== freeing disk: drop the mutation worktree ==="
cd $REPO && git worktree remove --force $F/wt3-mut 2>&1
rm -rf $F/wt3-mut
docker system prune -f --filter "until=24h" 2>&1 | tail -3
df -h / | tail -1
} 2>&1
cat $O 2>/dev/null
