#!/usr/bin/env bash
# RULING 248: the stability re-query is vj-refuter's job ALONE. vj-arms must not run this script; it refuses unless the caller sets VJ_REFUTER=1 (vj-refuter reads it first).
# Stability re-query (ruling 165 G / rule S5), for vj-refuter: re-ask arms 2, 3, 4 (temperature 0) on a chosen subset of turns, into FRESH output files.
# usage: run_requery.sh IDS_FILE OUTDIR    IDS_FILE = one turn_id per line (the refuter's random 20% of the scored doubtful turns; the refuter knows the truth, I do not)
# then:  score.py ... --requery2 OUTDIR/arm2.jsonl --requery3 OUTDIR/arm3.jsonl --requery4 OUTDIR/arm4.jsonl
# env: BACKEND=live (default) | mock ;  INPUTS=inputs (dir with cards.jsonl, clips.jsonl, confident_labelled_ids.txt) ; ARM1=out/real/arm1.jsonl ; GEMINI_MODEL
set -euo pipefail
[ "${VJ_REFUTER:-}" = 1 ] || { echo "run_requery.sh: ruling 248 - only vj-refuter runs the stability re-query (set VJ_REFUTER=1 after reading the script)"; exit 2; }
cd "$(dirname "$0")"; PY=${PY:-$PWD/.venv/bin/python}; [ -x "$PY" ] || PY=python3
IDS=${1:?ids file}; O=${2:?outdir}; B=${BACKEND:-live}; IN=${INPUTS:-inputs}; A1=${ARM1:-out/real/arm1.jsonl}
JB=$([ "$B" = live ] && echo jev || echo mock); GB=$([ "$B" = live ] && echo vertex || echo mock)
mkdir -p "$O"; rm -f "$O"/arm[234].jsonl
COMMON="--arm1 $A1 --confident-ids $IN/confident_labelled_ids.txt --turn-ids $IDS"
for A in 3 2; do $PY arm_jev.py --arm $A --in $IN/cards.jsonl --out "$O/arm$A.jsonl" --backend "$JB" $COMMON --workers 6; done
$PY arm4_gemini.py --in $IN/clips.jsonl --out "$O/arm4.jsonl" --backend "$GB" $COMMON --clip-dir "$O/clips" --workers 8 --tasks l1 --model "${GEMINI_MODEL:-gemini-3.8-flash}"
