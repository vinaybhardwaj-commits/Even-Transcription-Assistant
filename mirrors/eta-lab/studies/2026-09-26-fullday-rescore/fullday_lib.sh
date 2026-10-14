#!/usr/bin/env bash
# fullday_lib.sh — shared pieces of the W28.2 fullday re-score harness, sourced by
# fullday-rescore.sh (runner) and selftest.sh (offline tests). No state, no globals beyond these.
#
# fullday-rescore.sh 2026-09-23 --transcript X --allow-undeclared  — order W28.2, refuter-2 fixes
# for 5addfb47 in this file's history.

# A pipeline stage name, or die (refuter B3: only REAL stage names validate; the --from/--to flag
# tokens are consumed by the caller before reaching here).
stage_ok() {
  case "$1" in
    rooms|pqm|truth|replay|score) return 0 ;;
    *) echo "FAIL unknown stage '$1' (wanted: rooms|pqm|truth|replay|score)" >&2; exit 2 ;;
  esac
}

# Hyp-*.json files written AFTER the marker was touched: this run's only. Prints one path per line;
# empty output = none. Why: an out-<date>/ can hold hyp-fused / hyp-fused-e61 / hyp-arm-d from
# different runs (refuter B2) — scoring a stale arm under a new version name would mis-label it.
pick_fresh_hyps() {
  local out="$1" mark="$2" f
  shopt -s nullglob
  for f in "$out"/hyp-*.json; do
    # `-nt` compares mtime exactly like the runner's own loop; a file the marker predates is stale.
    if [ "$f" -nt "$mark" ]; then
      printf '%s\n' "$f"
    fi
  done
  shopt -u nullglob
}
