#!/bin/bash
# Nightly dump of the pipe database (launchd: com.eta.guardian.pgdump, 01:30). Also an online copy of the alert case store (cases.sqlite).
# The internal-drive folder $GH/backup is the backup of record. Air Drive copy: DEFERRED (R2 ruling: no Full Disk Access for anything in Phase 0).
# Rotation: keeps the newest 14 of OUR files (pipe-*.dump, cases-*.sqlite); older ones are MOVED to backup/_to_delete/, never removed.
# Failure (pg_dump, pg_restore -l readback, sqlite copy): moves this run's files to backup/_to_delete/*.bad (never counted toward keep-14), opens a `backup_failed` case in the router store (it pages within one tick) and exits 1.
# Killed (TERM or INT) before the run finished: same clean-up as a failure (no .part left; files moved to backup/_to_delete/*.bad), opens the same case, exits 143 / 130.
# Success: closes that case if open, exits 0.
set -euo pipefail
GH="${GUARDIAN_HOME:-$HOME/oc/fleet-access/guardian}"
LOCAL="$GH/backup"
KEEP=14
umask 077
mkdir -p "$LOCAL/_to_delete"
export PATH="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}:$PATH"      # PG_BIN: tests only
PY=/opt/homebrew/bin/python3
IN_FAIL=""
aside() {                                   # aside <file> [suffix]: move to _to_delete/<name><suffix>; a name clash gets .1, .2 ... (never overwrites, never deletes)
  local base dst n=0
  base="$LOCAL/_to_delete/$(basename "$1")${2:-}"; dst="$base"
  while [ -e "$dst" ]; do n=$((n + 1)); dst="$base.$n"; done
  mv "$1" "$dst"
}
fail() {
  [ -z "$IN_FAIL" ] || return 0           # re-entry guard: a second signal or error during the clean-up must not start it again
  IN_FAIL=1
  trap - ERR
  trap '' TERM INT                        # and a second TERM / INT while files are being moved is ignored, so the clean-up finishes
  echo "pgdump: FAILED near line $1" >&2
  # A failed run must never count toward keep-14 and must leave no half file: move (never delete) its files aside, a dump as .bad.
  for f in "${OUT:-}.part" "${OUT:-}" "$LOCAL/cases-${STAMP:-none}.sqlite"; do
    if [ -f "$f" ] && [ "$f" != ".part" ]; then aside "$f" .bad || true; fi
  done
  GUARDIAN_HOME="$GH" "$PY" -I "$GH/scripts/backup-case.py" open || echo "pgdump: could not open the backup_failed case" >&2
  exit "${2:-1}"
}
trap 'fail $LINENO' ERR
trap 'fail "signal TERM" 143' TERM
trap 'fail "signal INT" 130' INT
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
  find "$LOCAL" -maxdepth 1 -type f -name "$pat" | sort | awk -v k="$KEEP" '{a[NR]=$0} END{for(i=1;i<=NR-k;i++)print a[i]}' | while IFS= read -r f; do aside "$f"; done
done
trap - ERR TERM INT
GUARDIAN_HOME="$GH" "$PY" -I "$GH/scripts/backup-case.py" close || echo "pgdump: could not close the backup_failed case" >&2
echo "pgdump: ok $(basename "$OUT") $(stat -f %z "$OUT") bytes (local only; Air Drive copy deferred)"
