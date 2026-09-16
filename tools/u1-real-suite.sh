#!/bin/bash
# The COMPLETE suite root: every repository fixture plus the recorded tapes (real room audio, outside the repository).
# Each recorded tape is adopted into ROOT; every repository fixture is symlinked beside them, so the coverage guard and
# spec/required-fixtures.json apply to the whole root.
# usage: tools/u1-real-suite.sh ROOT TAPEDIR:NAME[:SUMMARY.json] ...
#   complete root (U1 step 5): tools/u1-real-suite.sh ROOT /home/vinay/tapes/u1-step4-real:u1-real-faults \
#       /home/vinay/tapes/u1-step5-midnight:u1-real-midnight:/home/vinay/tapes/u1-step5-midnight.summary.json
set -eu
root=$1; shift
here=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$root"; mkdir -p "$root/good"
for f in "$here"/fixtures/good/*; do ln -s "$f" "$root/good/$(basename "$f")"; done
ln -s "$here/fixtures/negative" "$root/negative"
for spec in "$@"; do
    IFS=: read -r tape name summary <<< "$spec"
    "$here/.build/release/conformance" adopt-tape --tape "$tape" --fixtures "$root" --name "$name" ${summary:+--recorder-summary "$summary"}
done
"$here/.build/release/conformance" run --fixtures "$root" --required "$here/spec/required-fixtures.json"
