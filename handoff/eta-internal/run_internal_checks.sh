#!/usr/bin/env bash
# ETA-internal: the Pulse bundle's own checks, then the privacy sweep and the README/placement checks (S7, S8).
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
cd "$(dirname "$0")"
../eta-freescript-v1.0/run_checks.sh | grep -v '^MATCH '
python3 privacy_sweep.py ../eta-freescript-v1.0
python3 check_pulse_docs.py
# negative self-tests: each planted S7/S8 violation must be caught
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
plant() { rm -rf "$TMP/b"; cp -r ../eta-freescript-v1.0 "$TMP/b"; }
expect_fail() { if "$@" >/dev/null 2>&1; then echo "NOT CAUGHT: $*"; exit 1; else echo "caught: $1 $(basename "$2")"; fi; }
plant; echo "Reviewed by fable." >> "$TMP/b/README-FOR-PULSE.md"; expect_fail python3 privacy_sweep.py "$TMP/b"
plant; echo "Branch cloudpane/x/y." >> "$TMP/b/data/salt_drugs.json"; expect_fail python3 privacy_sweep.py "$TMP/b"
plant; touch "$TMP/b/DESIGN-RATIONALE.md"; expect_fail python3 check_pulse_docs.py "$TMP/b"
plant; echo "The role_track voter decides." >> "$TMP/b/README-FOR-PULSE.md"; expect_fail python3 check_pulse_docs.py "$TMP/b"
plant; echo "Model ids are read back from the calls." >> "$TMP/b/README-FOR-PULSE.md"; expect_fail python3 check_pulse_docs.py "$TMP/b"
plant; mkdir -p "$TMP/b/tests/__pycache__"; expect_fail bash "$TMP/b/run_checks.sh"
echo "ALL INTERNAL CHECKS PASSED"
