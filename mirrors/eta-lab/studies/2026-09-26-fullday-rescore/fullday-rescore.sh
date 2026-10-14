#!/usr/bin/env bash
# fullday-rescore.sh — the W28.2 full-day re-score harness, one command (lx, 26 Sep; refuter-2 fixes
# for 5addfb47 landed here and in e7-rescore.sh / stage_db.ts / arm_d.py).
#
#   fullday-rescore.sh <YYYY-MM-DD> --transcript <name> [--from <stage> --to <stage>]
#                      [--allow-undeclared] [--plan] [--select-only]
#
# Wraps studies/2026-09-24-e7-fullday/e7-rescore.sh UNCHANGED for the pipeline (rooms, pqm, truth,
# replay — credentials, the 81cec3a pin, Jev cost tracking and the lock stay exactly its stages) and
# replaces only the score stage with fullday_score.py.
#
#   --transcript <name>  REQUIRED (W28.2: the version is named on the command line). Passed to
#                        e7-rescore.sh, which exports E7_TRANSCRIPT_VERSION into the replay child so
#                        freshly written hyp-*.json carry transcript_version, and to the scorer,
#                        which records the name verbatim and refuses files that do not account for
#                        it: a declared mismatch fails; an undeclared (pre-26 Sep) file fails unless
#                        --allow-undeclared, and then prints UNDECLARED in the card.
#   --allow-undeclared   forwarded to the scorer (see above; refuter B1).
#   --from/--to          optional stage slice for e7-rescore.sh; only REAL stage names get through
#                        (refuter B3), and a slice past --to replay runs the wrapper's default that
#                        stage list. Passing nothing = the full rooms..replay run here, without
#                        re-running that script's own score stage (see SELFSCORE note below).
#   --plan               print the exact command lines, run nothing.
#   --select-only        build the run's marker and print exactly which hyp-*.json in out-<DATE>/
#                        this run would score (mtime after the marker), then exit; nothing else
#                        runs. selftest.sh uses this to test the selection with controlled mtimes.
#
# Out: out-<DATE>/fullday-score.md (+ .json). Regression: none touching the E-7 metric (the scoring
# code loads e7_score.py's pure functions verbatim and re-checking is in selftest.sh).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=fullday_lib.sh
source "$HERE/fullday_lib.sh"

DATE="${1:?usage: fullday-rescore.sh YYYY-MM-DD --transcript <name> [--from <stage> --to <stage>] [--allow-undeclared] [--plan] [--select-only]}"; shift
TRANSCRIPT=""
SLICE=()
ALLOW=()
PLAN=0
SELECT_ONLY=0
while [ $# -gt 0 ]; do case "$1" in
  --transcript)       TRANSCRIPT="${2:?--transcript needs a name}"; shift 2 ;;
  --allow-undeclared) ALLOW+=(--allow-undeclared); shift ;;
  --plan)             PLAN=1; shift ;;
  --select-only)      SELECT_ONLY=1; shift ;;
  --from)             v="${2:?--from needs a stage}"; stage_ok "$v"; SLICE+=(--from "$v"); shift 2 ;;
  --to)               v="${2:?--to needs a stage}"; stage_ok "$v"; SLICE+=(--to "$v"); shift 2 ;;
  *) echo "FAIL unknown arg '$1'" >&2; exit 2 ;;
esac; done
[ -n "$TRANSCRIPT" ] || { echo "FAIL --transcript is required (W28.2: the version must be named)" >&2; exit 2; }
[ ${#SLICE[@]} -le 4 ] || { echo "FAIL at most one --from/--to slice pair" >&2; exit 2; }

ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
RES="$ROOT/studies/2026-09-24-e7-fullday/e7-rescore.sh"
[ -f "$RES" ] || { echo "FAIL e7-rescore.sh not found at $RES" >&2; exit 2; }
OUT="$ROOT/studies/2026-09-24-e7-fullday/out-$DATE"; mkdir -p "$OUT"

# B2: the run's epoch. Details in fullday_lib.sh pick_fresh_hyps.
MARK="$(mktemp /tmp/fullday-rescore-mark-XXXXXXXX)"
touch "$MARK"
# refuter-2 N2: the marker is per-run housekeeping, not an artifact — gone when the run ends.
trap 'rm -f "$MARK"' EXIT

if [ "$PLAN" = 1 ]; then
  echo "PLAN pipeline: bash $RES $DATE --transcript '$TRANSCRIPT'" ${SLICE[@]+"${SLICE[@]}"}
  echo "PLAN scorer:   fullday_score.py --truth $OUT/e7-truth-$DATE.csv [fresh hyps from mark $MARK] --transcript '$TRANSCRIPT'" ${ALLOW[@]+"${ALLOW[@]}"}
  echo "PLAN out:      $OUT/fullday-score.md (+ .json)"
  echo "PLAN nothing executed"
  exit 0
fi

if [ "$SELECT_ONLY" = 1 ]; then
  mapfile -t FRESH < <(pick_fresh_hyps "$OUT" "$MARK")
  echo "SELECTED ${#FRESH[@]}"
  for f in ${FRESH[@]+"${FRESH[@]}"}; do echo "$f"; done
  exit 0
fi

echo "=== pipeline: e7-rescore.sh $DATE --transcript '$TRANSCRIPT'" ${SLICE[@]+"${SLICE[@]}"}
if [ ${#SLICE[@]} -gt 0 ]; then
  bash "$RES" "$DATE" --transcript "$TRANSCRIPT" "${SLICE[@]}"
else
  bash "$RES" "$DATE" --transcript "$TRANSCRIPT" --to replay
fi

mapfile -t FRESH < <(pick_fresh_hyps "$OUT" "$MARK")
[ ${#FRESH[@]} -gt 0 ] || {
  echo "FAIL no hyp-*.json written by THIS run in $OUT (replay must have run; see --plan)" >&2; exit 5; }

echo "=== re-score: fullday_score.py --transcript '$TRANSCRIPT' on ${#FRESH[@]} fresh hyp file(s)"
ARGS=()
for f in "${FRESH[@]}"; do ARGS+=(--hyp "$f"); done
python3 "$HERE/fullday_score.py" --truth "$OUT/e7-truth-$DATE.csv" "${ARGS[@]}" ${ALLOW[@]+"${ALLOW[@]}"} \
  --transcript "$TRANSCRIPT" --out "$OUT/fullday-score.md" --json "$OUT/fullday-score.json"
echo "FULLDAY_RESCORE_DONE date=$DATE transcript=$TRANSCRIPT out=$OUT"
