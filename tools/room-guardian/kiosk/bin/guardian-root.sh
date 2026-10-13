#!/bin/bash
# Kiosk Guardian: the ONE root helper. Installed root:wheel 0755, run only as `<kiosk-sudo path> eta-guardian-root <verb> ...`.
# Fixed verbs, no free-form commands. Every SQL string the Guardian runs is in this file.
#   tcc-row <user>                 print "auth_value|auth_reason|last_modified", "none", or "error:<why>"
#   tcc-heal <user> <stamp>        backup, schema guard, guarded UPDATE, changes()=1 else restore; prints a result token
#   tcc-prune <user> <keep>        delete our own TCC.db.bak-guardian-<stamp> copies except the newest <keep> (0 or 1)
#   coreaudiod-kill                killall coreaudiod
#   pmset-baseline                 pmset -a sleep 0 autorestart 1
#   log-grab <minutes>             bounded audit lines around a grant flip
# Root is never trusted with the caller's environment. The test seam below only works when NOT root.

SVC="kTCCServiceMicrophone"
CLIENT="com.evenscribe.room-recorder"
SQL_PRAGMA="PRAGMA table_info(access);"
SQL_COUNT="SELECT count(*) FROM access WHERE service='$SVC' AND client='$CLIENT';"
SQL_ROW="SELECT auth_value||'|'||auth_reason||'|'||last_modified FROM access WHERE service='$SVC' AND client='$CLIENT';"
SQL_UPDATE="UPDATE access SET auth_value=2, auth_reason=2, last_modified=strftime('%s','now') WHERE service='$SVC' AND client='$CLIENT'; SELECT changes();"

db_for() { # user -> path, or fail
  local u="$1"
  if [ "$(id -u)" != "0" ] && [ "${GUARDIAN_ROOT_TESTMODE:-}" = "1" ] && [ -n "${GUARDIAN_ROOT_TEST_DB:-}" ]; then
    printf '%s' "$GUARDIAN_ROOT_TEST_DB"; return 0
  fi
  case "$u" in ''|*[!A-Za-z0-9._-]*|root) return 1 ;; esac
  [ "$u" = "$(stat -f %Su /dev/console 2>/dev/null)" ] || return 1
  printf '/Users/%s/Library/Application Support/com.apple.TCC/TCC.db' "$u"
}

sq() { sqlite3 -cmd ".timeout 5000" "$@"; }

# Delete our own backups (name = TCC.db.bak-guardian-<digits>) except the newest $2. Nothing else is ever deleted.
prune_backups() { # db keep
  local f i=0
  printf '%s\n' "$1".bak-guardian-* | sort -r | while IFS= read -r f; do
    case "${f##*.bak-guardian-}" in ''|*[!0-9]*) continue ;; esac
    [ -f "$f" ] || continue
    i=$((i + 1))
    [ "$i" -gt "$2" ] && rm -f -- "$f"
  done
}

verb="$1"; shift
case "$verb" in
  tcc-row)
    db="$(db_for "$1")" || { echo "error:bad_user"; exit 0; }
    out="$(sq -readonly "$db" "$SQL_ROW" 2>&1)" || { echo "error:read"; exit 0; }
    [ -n "$out" ] && echo "$out" || echo "none"
    ;;
  tcc-heal)
    db="$(db_for "$1")" || { echo "bad_user"; exit 0; }
    stamp="$2"; case "$stamp" in ''|*[!0-9]*) echo "bad_stamp"; exit 0 ;; esac
    bak="$db.bak-guardian-$stamp"
    cols="$(sq -readonly "$db" "$SQL_PRAGMA" 2>/dev/null)" || { echo "no_access"; exit 0; }
    for c in service client auth_value auth_reason last_modified; do
      printf '%s\n' "$cols" | awk -F'|' -v c="$c" '$2 == c { f = 1 } END { exit f ? 0 : 1 }' || { echo "schema_drift"; exit 0; }
    done
    n="$(sq -readonly "$db" "$SQL_COUNT" 2>/dev/null)"
    [ "$n" = "1" ] || { [ "$n" = "0" ] && echo "no_row" || echo "row_count_${n:-unknown}"; exit 0; }
    cur="$(sq -readonly "$db" "$SQL_ROW" 2>/dev/null | cut -d'|' -f1)"
    [ "$cur" = "2" ] && { echo "already_authorized"; exit 0; }
    sq "$db" ".backup '$bak'" >/dev/null 2>&1 && [ -s "$bak" ] || { echo "backup_failed"; exit 0; }
    prune_backups "$db" 1
    ch="$(sq "$db" "$SQL_UPDATE" 2>/dev/null | tail -n1)"
    if [ "$ch" = "1" ]; then echo "ok"; else
      sq "$db" ".restore '$bak'" >/dev/null 2>&1
      echo "changes_${ch:-none}_restored"
    fi
    ;;
  tcc-prune)
    db="$(db_for "$1")" || { echo "bad_user"; exit 0; }
    keep="$2"; case "$keep" in 0|1) ;; *) echo "bad_keep"; exit 0 ;; esac
    prune_backups "$db" "$keep"
    echo "pruned"
    ;;
  coreaudiod-kill) killall coreaudiod ;;
  pmset-baseline) pmset -a sleep 0 autorestart 1 ;;
  log-grab)
    m="$1"; case "$m" in ''|*[!0-9]*) m=2 ;; esac
    { log show --last "${m}m" --info --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS[c] "kTCCServiceMicrophone"'
      log show --last "${m}m" --info --predicate 'eventMessage CONTAINS[c] "Update Access Record"'
      log show --last "${m}m" --predicate 'process == "System Settings"'
      log show --last "${m}m" --predicate 'process == "screensharingd" OR process == "ARDAgent"'
    } 2>/dev/null | head -n 200
    ;;
  *) echo "unknown_verb" >&2; exit 2 ;;
esac
