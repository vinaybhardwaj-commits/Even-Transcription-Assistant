#!/usr/bin/env bash
# selftest.sh — W44 Jev encounter-loop offline tests (lx). Nothing here touches a database, the Mini,
# or a real Jev call: chunker/candidates/state_machine/jev_client(mock)/run_loop are exercised on
# synthetic fixtures, and the end-to-end check scores the real, unmodified fullday_score.py/e7_score.py
# against a fixture this test builds itself. Run from this directory: bash selftest.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
python3 "$HERE/selftest_checks.py"
rc=$?
exit $rc
