#!/bin/bash
# Run every tests/t_*.sh. Each test function runs in its own subshell and sandbox.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 2
# shellcheck source=lib.sh
. ./lib.sh
total_fail=0; total_pass=0; ntests=0
for f in t_*.sh; do
  echo "== $f"
  # shellcheck disable=SC1090
  . "./$f"
  for fn in $(grep -o '^test_[a-z0-9_]*' "$f"); do
    ntests=$((ntests + 1))
    out="$( ( mk_sandbox; PASS=0; FAILS=0; "$fn"; echo "__RESULT $PASS $FAILS"; reap_tracked "$T"; rm -rf "$T" ) 2>&1 )"
    res="$(printf '%s\n' "$out" | grep '^__RESULT' | tail -n1)"
    p="$(echo "$res" | awk '{print $2}')"; fl="$(echo "$res" | awk '{print $3}')"
    if [ -z "$res" ]; then echo "  CRASH $fn"; printf '%s\n' "$out" | tail -n 8; total_fail=$((total_fail + 1)); continue; fi
    total_pass=$((total_pass + p)); total_fail=$((total_fail + fl))
    if [ "$fl" -gt 0 ]; then echo " not ok $fn"; printf '%s\n' "$out" | grep -v '^__RESULT'; else echo " ok $fn ($p)"; fi
  done
done
echo "tests: $ntests functions, $total_pass assertions passed, $total_fail failed"
[ "$total_fail" -eq 0 ]
