#!/usr/bin/env bash
# Checks the eta.freescript.v1.0 bundle: examples valid, mutants match tests/expected.tsv, builders byte-identical.
# Needs python3 with jsonschema. Exit 0 only when every check passes.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
cd "$(dirname "$0")"
no_pycache() { if [ -n "$(find . -name __pycache__ -print -quit)" ]; then echo "FAIL: __pycache__ present in the bundle ($1)"; exit 1; fi; }
no_pycache "before checks"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== 1. examples validate"
python3 validate_artifact.py examples/*.json
n=$(ls examples/*.json | wc -l)
[ "$n" -eq 7 ] || { echo "expected 7 examples, found $n"; exit 1; }

echo "== 2. mutants match tests/expected.tsv"
python3 tests/run_mutants.py tests/mutants

echo "== 3. build_examples.py reproduces the examples byte-for-byte"
python3 examples/build_examples.py "$TMP/examples" >/dev/null
for f in examples/*.json; do cmp "$f" "$TMP/examples/$(basename "$f")"; done
[ "$(ls "$TMP/examples" | wc -l)" -eq "$n" ]
echo "identical: $n files"

echo "== 4. build_mutants.py reproduces the mutants and expected.tsv byte-for-byte"
mkdir -p "$TMP/t"
python3 tests/build_mutants.py "$TMP/t/mutants" >/dev/null
cmp tests/expected.tsv "$TMP/t/expected.tsv"
for f in tests/mutants/*.json; do cmp "$f" "$TMP/t/mutants/$(basename "$f")"; done
[ "$(ls "$TMP/t/mutants" | wc -l)" -eq "$(ls tests/mutants | wc -l)" ]
echo "identical: $(ls tests/mutants | wc -l) mutants + expected.tsv"

no_pycache "after checks"
echo "ALL CHECKS PASSED"
