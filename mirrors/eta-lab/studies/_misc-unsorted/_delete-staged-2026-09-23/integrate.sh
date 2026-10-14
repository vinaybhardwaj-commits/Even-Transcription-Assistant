#!/bin/zsh
# Integrate vad-starvation (135d33e, Refuter PASS) + s2b-reenrol (1072421, fleet verified)
# into vinay/s1-auto-drain. Local merge only; push is a separate script.
set -u
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
cd "$R" || exit 1
echo "=== pre ==="; git rev-parse --short HEAD; git status --porcelain | head
git tag -f fable-preintegrate HEAD
echo "=== merge 1: vad-starvation ==="
git merge --no-ff -m "merge: VAD starvation + route-metrics truth (135d33e) — route_outcome now reads segmentation.outcome, windows_total/windows_skipped reach the tape; Refuter PASS with mutation proof on F1-F5,F7" vinay/vad-starvation 2>&1 | tail -20
echo "rc1=$?"
echo "=== merge 2: s2b-reenrol ==="
git merge --no-ff -m "merge: S2B re-enrolment (1072421) — voice_print_generation at migration 0108, renumbered clear of 0106/0107" vinay/s2b-reenrol 2>&1 | tail -20
echo "rc2=$?"
echo "=== head ==="; git rev-parse --short HEAD; git log --oneline -3
echo "=== migration files present ==="
ls db/migrations | tail -8
echo "=== migration version/filename agreement (last 8) ==="
for f in $(ls db/migrations | tail -8); do
  v=$(grep -o "VALUES ([0-9]*" "db/migrations/$f" | head -1 | tr -dc '0-9')
  printf '%-48s file=%s insert=%s\n' "$f" "${f%%_*}" "$v"
done
