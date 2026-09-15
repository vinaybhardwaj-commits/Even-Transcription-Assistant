#!/bin/bash
# U1 step 3 acceptance: run the whole conformance suite with a REAL recorded tape added to the repository fixtures.
# The real tape is adopted into ROOT (outside the repository); every repository fixture is symlinked beside it, so the
# coverage guard and every existing case still apply.
# usage: tools/u1-real-suite.sh TAPEDIR ROOT NAME
set -eu
tape=$1; root=$2; name=$3
here=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$root"; mkdir -p "$root/good"
for f in "$here"/fixtures/good/*; do ln -s "$f" "$root/good/$(basename "$f")"; done
ln -s "$here/fixtures/negative" "$root/negative"
"$here/.build/release/conformance" adopt-tape --tape "$tape" --fixtures "$root" --name "$name"
"$here/.build/release/conformance" run --fixtures "$root"
