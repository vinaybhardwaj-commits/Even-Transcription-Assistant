#!/bin/bash
# W49 nightly pqm_truth backfill (Fable 27 Sep 13:52/14:22 orders). Runs the CAP-1/CAP-2 day
# pipeline (Metabase pull -> extract -> content-match link) for a small ROLLING WINDOW of recent
# days, then writes each day's pqm_truth files. Box only: needs ~/.claude/secrets/metabase_api_key
# and local hist-bulk audio.
#
# Usage: nightly_pqm.sh [YYYY-MM-DD] [N_DAYS]   (default: today back through N_DAYS-1, IST; N_DAYS default 3)
# A window, not a single day, because hist-bulk's audio processing can lag by DAYS (a tier-B
# backlog drain can land a day's windows under a run_id dated well after the day itself - see
# cap_link.py's load_windows() fix, linker/w33-4 #4666). Every step here is idempotent (each day's
# output files are fully overwritten on every run), so re-processing a day that already has data
# just refreshes it with whatever hist-bulk has finished since the last pass - cheap and safe.
# Exit code is 0 even when a day has 0 hist-bulk audio yet (cap_link legitimately finds nothing to
# link; pqm_timeline.py then writes 0 files, which is correct "not processed yet" behavior, not an
# error) - this script's job is to run the pipeline, not to judge whether audio has arrived.
set -euo pipefail
END="${1:-$(TZ=Asia/Kolkata date +%Y-%m-%d)}"
N="${2:-3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S2DAY="$HERE/../2026-09-27-clarity-scorecard/s2day"

for i in $(seq 0 $((N - 1))); do
  DAY="$(TZ=Asia/Kolkata date -d "$END - $i days" +%Y-%m-%d)"
  if [ -f "$HOME/eta-data/cap/$DAY/MANIFEST.sha256" ]; then    # eta-refuter-2 #4680: generic (25 Sep AND 26 Sep are both frozen bundles; a hardcoded date list would go stale the next time a day gets bundled)
    echo "=== $DAY: SKIPPED (already has MANIFEST.sha256 - a frozen bundle; the day-pull/extract/link scripts refuse this too, this check just avoids aborting the whole rolling window on set -e) ==="
    continue
  fi
  echo "=== $DAY: cap_day_pull ==="; CAP_DAY="$DAY" python3 "$S2DAY/cap_day_pull.py"
  echo "=== $DAY: cap_extract ===";  CAP_DAY="$DAY" python3 "$S2DAY/cap_extract.py"
  echo "=== $DAY: cap_link ===";     CAP_DAY="$DAY" python3 "$S2DAY/cap_link.py"
  echo "=== $DAY: pqm_timeline ==="
  python3 "$HERE/pqm_timeline.py" --day "$DAY" \
    --links "$HOME/eta-data/cap/$DAY/links.jsonl" \
    --rows-csv "$HOME/eta-data/cap/$DAY/rows.csv" \
    --out "$HOME/eta-data/linker/timeline"
done
