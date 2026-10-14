#!/bin/bash
# Nightly dump of the pipe database (launchd: com.eta.guardian.pgdump, 01:30). Also an online copy of the alert case store (cases.sqlite).
# The internal-drive folder $GH/backup is the backup of record. Air Drive copy: DEFERRED (R2 ruling: no Full Disk Access for anything in Phase 0).
# Rotation: keeps the newest 14 of OUR files (pipe-*.dump, cases-*.sqlite); older ones are MOVED to backup/_to_delete/, never removed.
# Failure (pg_dump, pg_restore -l readback, sqlite copy): moves this run's files to backup/_to_delete/*.bad (never counted toward keep-14), opens a `backup_failed` case in the router store (it pages within one tick) and exits 1.
# Success: closes that case if open, exits 0.
set -euo pipefail
GH="${GUARDIAN_HOME:-$HOME/oc/fleet-access/guardian}"
LOCAL="$GH/backup"
KEEP=14
umask 077
mkdir -p "$LOCAL/_to_delete"
export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH
PY=/opt/homebrew/bin/python3
fail() {
  echo "pgdump: FAILED near line $1" >&2
  # A failed run must never count toward keep-14 and must leave no half file: move (never delete) its files aside, a dump as .bad.
  for f in "${OUT:-}.part" "${OUT:-}" "$LOCAL/cases-${STAMP:-none}.sqlite"; do
    if [ -f "$f" ] && [ "$f" != ".part" ]; then mv "$f" "$LOCAL/_to_delete/$(basename "$f").bad" || true; fi
  done
  GUARDIAN_HOME="$GH" "$PY" -I "$GH/scripts/backup-case.py" open || echo "pgdump: could not open the backup_failed case" >&2
  exit 1
}
trap 'fail $LINENO' ERR
set -a
# shellcheck disable=SC1091
. "$GH/etc/pg.env"
set +a
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$LOCAL/pipe-$STAMP.dump"
pg_dump -Fc -f "$OUT.part"
mv "$OUT.part" "$OUT"
pg_restore -l "$OUT" >/dev/null                      # the dump must be readable back
if [ -f "$GH/data/cases.sqlite" ]; then
  "$PY" -I - "$GH/data/cases.sqlite" "$LOCAL/cases-$STAMP.sqlite" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1], timeout=10); dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()
PY
fi
for pat in 'pipe-*.dump' 'cases-*.sqlite'; do
  find "$LOCAL" -maxdepth 1 -type f -name "$pat" | sort | awk -v k="$KEEP" '{a[NR]=$0} END{for(i=1;i<=NR-k;i++)print a[i]}' | while IFS= read -r f; do mv "$f" "$LOCAL/_to_delete/"; done
done
trap - ERR
GUARDIAN_HOME="$GH" "$PY" -I "$GH/scripts/backup-case.py" close || echo "pgdump: could not close the backup_failed case" >&2
echo "pgdump: ok $(basename "$OUT") $(stat -f %z "$OUT") bytes (local only; Air Drive copy deferred)"
