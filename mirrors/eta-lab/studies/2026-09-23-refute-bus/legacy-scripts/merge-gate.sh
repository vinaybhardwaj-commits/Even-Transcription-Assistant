#!/bin/zsh
set -u
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant
WT=/Users/vinaybhardwaj/dev/_fable/wt-merge
cd $R || exit 1
echo "=== 1. push the branch ==="
git push -u origin vinay/gate-and-volumes 2>&1 | tail -4
echo
echo "=== 2. fetch + worktree at origin/vinay/s1-auto-drain ==="
git fetch origin 2>&1 | tail -2
rm -rf $WT 2>/dev/null; git worktree prune
git worktree add --detach $WT origin/vinay/s1-auto-drain 2>&1 | tail -2
cd $WT || exit 1
echo "base: $(git rev-parse --short HEAD)"
echo
echo "=== 3. merge ==="
git merge --no-ff -m "Merge vinay/gate-and-volumes: admin-gate fails closed when ADMIN_TOKEN unset; docker rm -fv stops the volume leak

Refuted independently by ETA-Refuter, not the builder. Both fixes mutation-proven
load-bearing: reverting admin-gate to fail-open fails 49 of 55; reverting -fv to -f
fails docker-rm-volumes-guard, which scans the real harness files not its own fixtures.
Full suite 3226 passed / 0 failed / 1 skipped, typecheck 0 errors, volumes 29 before
and 29 after.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PdUpQZUtoniiquFdLfiVtP" vinay/gate-and-volumes 2>&1 | tail -12
echo "merge rc=$?"
echo "head: $(git rev-parse --short HEAD)"
echo
echo "=== 4. push to s1-auto-drain ==="
git push origin HEAD:vinay/s1-auto-drain 2>&1 | tail -4
echo
echo "=== 5. verify the four call sites carry -v ==="
grep -rn "docker rm" tests/support/pg-harness.ts tests/support/s1-pg.ts 2>/dev/null | head
