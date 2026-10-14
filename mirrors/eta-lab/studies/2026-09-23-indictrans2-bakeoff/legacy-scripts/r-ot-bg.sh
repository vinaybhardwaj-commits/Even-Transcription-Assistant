export PATH=/opt/homebrew/bin:$PATH
set -x
R=~/dev/Even-Transcription-Assistant-ot
W=/tmp/refute-ot
B=/tmp/refute-build
mkdir -p $B
cd $R
git worktree add --detach $W a125814
cd $W
ln -s /Users/vinaybhardwaj/dev/Even-Transcription-Assistant/node_modules node_modules
BAN="import {createRequire} from 'module'; const require = createRequire(import.meta.url);"
node_modules/.bin/esbuild scripts/overnight-translate.ts --bundle --platform=node --format=esm --banner:js="$BAN" --outfile=$B/a125814.mjs --log-level=warning
git checkout --detach bbf74e9
node_modules/.bin/esbuild scripts/overnight-translate.ts --bundle --platform=node --format=esm --banner:js="$BAN" --outfile=$B/head.mjs --log-level=warning
cd $R
node_modules/.bin/esbuild scripts/overnight-translate.ts --bundle --platform=node --format=esm --banner:js="$BAN" --outfile=$B/head-from-ot.mjs --log-level=warning
set +x
echo "=== live vs a125814 (from /tmp)"; diff ~/overnight-translate/overnight-translate.mjs $B/a125814.mjs | head -20; diff ~/overnight-translate/overnight-translate.mjs $B/a125814.mjs | wc -l
echo "=== head(tmp) vs head(ot)"; diff $B/head.mjs $B/head-from-ot.mjs | wc -l
echo "=== live vs head(ot)"; diff ~/overnight-translate/overnight-translate.mjs $B/head-from-ot.mjs | wc -l
diff ~/overnight-translate/overnight-translate.mjs $B/head-from-ot.mjs | grep '^[<>]' | grep -v 'joinRetries\|join\|JOIN' | head -30
cd $W
echo "=== TESTS HEAD"
npx vitest run tests/unit/overnight-translate- 2>&1 | tail -15
echo "=== M1 join counts as failure"
sed -i '' 's/terminal.joinContended \&\& a.joinRetries < JOIN_RETRY_LIMIT/terminal.joinContended \&\& a.joinRetries < 0/' lib/overnight-translate/driver.ts
git diff --stat
npx vitest run tests/unit/overnight-translate-driver 2>&1 | grep -E 'Tests |FAIL|✗|×' | head -15
git checkout -- lib/overnight-translate/driver.ts
echo "=== M2 no retry bound"
sed -i '' 's/terminal.joinContended \&\& a.joinRetries < JOIN_RETRY_LIMIT/terminal.joinContended/' lib/overnight-translate/driver.ts
git diff --stat
npx vitest run tests/unit/overnight-translate-driver --testTimeout=10000 2>&1 | grep -E 'Tests |FAIL|×|timed out' | head -15
git checkout -- lib/overnight-translate/driver.ts
echo "=== M3 door never flags contention"
sed -i '' 's/sc.error.includes("join_already_running")/false/' lib/overnight-translate/door.ts
git diff --stat
npx vitest run tests/unit/overnight-translate- 2>&1 | grep -E 'Tests |FAIL' | head -15
git checkout -- lib/overnight-translate/door.ts
echo "=== M4 concurrency default 3"
sed -i '' 's/export const DEFAULT_CONCURRENCY = 1;/export const DEFAULT_CONCURRENCY = 3;/' lib/overnight-translate/driver.ts
git diff --stat
npx vitest run tests/unit/overnight-translate- 2>&1 | grep -E 'Tests |FAIL' | head -15
git checkout -- lib/overnight-translate/driver.ts
cd $R
git worktree remove --force $W
git worktree prune
git worktree list
echo ALLDONE
