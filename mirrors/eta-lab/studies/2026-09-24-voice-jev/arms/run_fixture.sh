#!/usr/bin/env bash
# End-to-end on the synthetic fixture. BACKEND=mock (offline) or live (real Jev + Vertex calls on synthetic cards / tone audio).
# usage: BACKEND=mock ./run_fixture.sh [outdir]
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-python3}; B=${BACKEND:-mock}; O=${1:-out/fixture-$B}
$PY make_fixture.py fixture >/dev/null
RSHA=$(sha256sum COMBINE_RULE.md | cut -d' ' -f1)
JB=$([ "$B" = live ] && echo jev || echo mock); GB=$([ "$B" = live ] && echo vertex || echo mock)
mkdir -p "$O"; rm -f "$O"/arm[234].jsonl
$PY arm1.py --in fixture/arm1_in.jsonl --out "$O/arm1.jsonl"
$PY arm_jev.py --arm 3 --in fixture/cards.jsonl --out "$O/arm3.jsonl" --backend "$JB" --arm1 "$O/arm1.jsonl" --select doubtful+sample
$PY arm_jev.py --arm 2 --in fixture/cards.jsonl --out "$O/arm2.jsonl" --backend "$JB" --arm1 "$O/arm1.jsonl" --select doubtful+sample
$PY arm4_gemini.py --in fixture/clips.jsonl --out "$O/arm4.jsonl" --backend "$GB" --clip-dir "$O/clips" --arm1 "$O/arm1.jsonl" --select doubtful+sample --model "${GEMINI_MODEL:-gemini-3.8-flash}"
$PY score.py --arm1 "$O/arm1.jsonl" --truth fixture/truth_turns.jsonl --arm2 "$O/arm2.jsonl" --arm3 "$O/arm3.jsonl" --arm4 "$O/arm4.jsonl" \
  --rule COMBINE_RULE.md --rule-sha "$RSHA" --windows fixture/windows.jsonl --human-counts fixture/human-counts.json --prices prices.json --outdir "$O"
