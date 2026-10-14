#!/usr/bin/env bash
# Ruling 168: only vj-refuter runs the scorer, as `sudo -u vjscore`. The builders' home dirs are not readable by vjscore, so the scorer is copied to a
# vjscore-readable place. score.py + common.py + combine.py use the python3 standard library only (no venv needed).
# usage: make_scorer_bundle.sh /srv/vj-score      then:  sudo -u vjscore python3 /srv/vj-score/score.py --arm1 ... --truth /srv/vj-truth/turn_labels.jsonl ... --rule /srv/vj-score/COMBINE_RULE.md --rule-sha <posted sha>
set -euo pipefail
D=${1:?target dir}; H="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$D"; for f in score.py common.py combine.py freeze.txt addendum.txt addendum166.txt COMBINE_RULE.md prices.json; do cp "$H/$f" "$D/$f"; done
chmod -R a+rX "$D"; (cd "$D" && sha256sum score.py common.py combine.py freeze.txt addendum.txt addendum166.txt COMBINE_RULE.md prices.json)
