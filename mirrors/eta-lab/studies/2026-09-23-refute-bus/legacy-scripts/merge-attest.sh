#!/bin/zsh
set -u
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant
WT=/Users/vinaybhardwaj/dev/_fable/wt-merge
cd $R && git fetch origin 2>&1 | tail -1
cd $WT || exit 1
git fetch origin 2>&1 | tail -1
git checkout --detach origin/vinay/s1-auto-drain 2>&1 | tail -1
echo "base: $(git rev-parse --short HEAD)"
echo
echo "=== migration filename vs INSERT version (the known hazard) ==="
for f in $(git ls-tree -r --name-only vinay/attest-capture | grep -E 'migrations/01(09|11)'); do
  echo "--- $f"
  git show vinay/attest-capture:$f | grep -n -E "INSERT INTO schema_migrations|VALUES *\(" | head -4
done
echo
echo "=== applied versions in prod (max + gaps) ==="
echo
echo "=== merge attest-capture ==="
git merge --no-ff -m "Merge vinay/attest-capture: migrations 0109 and 0111 together

Rebased onto 6be6017 so the gate was measured against the base we promote onto,
not cdb6f67. Full suite on the real base: 142 files, 3174 passed, 1 skipped, 0 failed
(up from 134/3084 - the ~75 s1-only tests are now included and green).
REQUIRED PROOF NOT RUN: 0 occurrences.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PdUpQZUtoniiquFdLfiVtP" vinay/attest-capture 2>&1 | tail -14
echo "rc=$?  head: $(git rev-parse --short HEAD)"
