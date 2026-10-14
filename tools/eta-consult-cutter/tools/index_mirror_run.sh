#!/usr/bin/env bash
# index-mirror run wrapper (index-mirror.service): runs tools/index_mirror.py from the pinned deploy worktree with the cutter venv, under its own flock, and appends ONE counts-only line to the log.
# Exit code = the tool's (0 ok, 2 config, 3 zero rows, 4 upload failed, 5 slug match, 6 leak guard); a run that finds the previous one still holding the lock exits 0 ("skip").
# Overrides exist for tests only (the unit sets none): INDEX_MIRROR_DEPLOY_DIR, INDEX_MIRROR_PY, INDEX_MIRROR_LOG, INDEX_MIRROR_LOCK, INDEX_MIRROR_ARGS (default --live).
set -uo pipefail
D="${INDEX_MIRROR_DEPLOY_DIR:-$HOME/oc/consult/cutter-deploy}"
PY="${INDEX_MIRROR_PY:-$HOME/oc/consult/cutter-venv/bin/python}"
LOG="${INDEX_MIRROR_LOG:-$HOME/oc/consult/index-mirror.log}"
LOCK="${INDEX_MIRROR_LOCK:-$HOME/eta-data/consult/index-mirror.lock}"
read -r -a ARGS <<< "${INDEX_MIRROR_ARGS:---live}"
log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }
mkdir -p "$(dirname "$LOCK")" "$(dirname "$LOG")"
exec 9>"$LOCK"
if ! flock -n 9; then log "skip: the previous run still holds the lock"; exit 0; fi
if [ ! -f "$D/tools/index_mirror.py" ]; then log "rc=2 the deploy worktree has no tools/index_mirror.py (deploy.sh from index-mirror/01 not done?)"; echo "no tools/index_mirror.py in $D" >&2; exit 2; fi
deploy="$(git -C "$D" rev-parse --short HEAD 2>/dev/null || echo unknown)"
out="$("$PY" "$D/tools/index_mirror.py" "${ARGS[@]}" 2>&1)"; rc=$?
printf '%s\n' "$out"
counts="$(printf '%s\n' "$out" | grep -m1 '^counts ' | cut -c1-400)"
msg="$(printf '%s\n' "$out" | grep -m1 -E '^(CONFIG ERROR|REFUSED|UPLOAD FAILED|LEAK)' | cut -c1-200)"
log "rc=$rc deploy=$deploy ${counts:-no-counts} ${msg:-}"
exit $rc
