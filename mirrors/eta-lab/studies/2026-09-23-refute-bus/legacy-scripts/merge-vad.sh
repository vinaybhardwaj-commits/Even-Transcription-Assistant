#!/bin/zsh
# Integrate vinay/vad-starvation (contains vinay/route-metrics-truth) into vinay/s1-auto-drain.
# LOCAL MERGE ONLY — no push. Reversible with: git reset --hard ORIG_HEAD
set -u
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
LOG=/Users/vinaybhardwaj/dev/_fable/merge-vad.log
cd "$R" || exit 1
{
  echo "=== pre ==="
  git rev-parse --short HEAD
  git status --porcelain
  echo "=== safety tag ==="
  git tag -f fable-premerge-vad HEAD
  echo "=== merge ==="
  git merge --no-ff -m "merge: VAD starvation + route-metrics truth (8d6b6e8) — route_outcome carries windows_total/windows_skipped so partial starvation is on the row" vinay/vad-starvation 2>&1
  echo "rc=$?"
  echo "=== post ==="
  git rev-parse --short HEAD
  git log --oneline -1
  echo "=== diff vs premerge ==="
  git diff --stat fable-premerge-vad HEAD
} > "$LOG" 2>&1
cat "$LOG"
