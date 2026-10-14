#!/bin/zsh
REPO=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
F=/Users/vinaybhardwaj/dev/_fable
cd $REPO || exit 9
{
echo "--- branch pointers BEFORE:"
git rev-parse vinay/s1-auto-drain vinay/fuse-jev-reachable
for W in fix pre mut; do
  git worktree remove --force $F/wt3-$W 2>/dev/null
  rm -rf $F/wt3-$W
done
git worktree add --detach $F/wt3-fix 38a7dac
git worktree add --detach $F/wt3-pre 5c0ceb3
git worktree add --detach $F/wt3-mut 38a7dac
for W in fix pre mut; do ln -s $REPO/node_modules $F/wt3-$W/node_modules; done
echo "--- branch pointers AFTER (must be identical):"
git rev-parse vinay/s1-auto-drain vinay/fuse-jev-reachable
echo "--- unit test file counts:"
echo "wt3-fix: $(ls $F/wt3-fix/tests/unit/*.test.ts | wc -l)"
echo "wt3-pre: $(ls $F/wt3-pre/tests/unit/*.test.ts | wc -l)"
echo "--- test files differing between pre and fix:"
diff -rq $F/wt3-pre/tests $F/wt3-fix/tests || true
echo "--- SESSIONS_DEFAULT_LIMIT:"
grep -rn "SESSIONS_DEFAULT_LIMIT" $F/wt3-fix/lib/bench.ts | head -5
echo "--- kinds/index.ts registry:"
grep -n "jev_english\|jev_window\|jev_role\|export const" $F/wt3-fix/lib/jobs/kinds/index.ts | head -30
echo "--- JOB_KIND_NAMES derivation:"
grep -n "JOB_KIND_NAMES" -B 3 -A 6 $F/wt3-fix/lib/jobs/submit.ts | head -30
} 2>&1
