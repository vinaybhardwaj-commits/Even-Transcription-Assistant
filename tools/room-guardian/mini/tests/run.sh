#!/usr/bin/env bash
# FR-1 C4 suite: shellcheck on every .sh, then both unittest files. Run from anywhere.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
shellcheck "$HERE"/../pipe/*.sh "$HERE"/../ops/*.sh "$HERE"/run.sh
PYTHONDONTWRITEBYTECODE=1 python3 -W ignore -I -m unittest discover -s "$HERE" -p 'test_*.py' -v 2>&1 | tail -n 40
