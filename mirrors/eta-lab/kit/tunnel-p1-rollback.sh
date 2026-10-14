#!/bin/bash
# Roll one twin tunnel back from token mode to its local config.yml connector (TUNNEL-HARDENING P1, ruling 120).
#
#   kit/tunnel-p1-rollback.sh <eta-box|eta-c3|eta-gcpl4>                 DRY RUN (default): shows what it would do
#   kit/tunnel-p1-rollback.sh <tunnel> --apply [--keep-ingress]
#
# --apply: remove the p1-token.conf drop-in (the original unit file was never edited), daemon-reload, restart so the
#          connector runs `--config <host>/.cloudflared/config.yml tunnel run` again, then PUT the ORIGINAL ingress
#          (so emotion /docs and /openapi.json are public again, exactly as before). --keep-ingress leaves the new
#          ingress (with the emotion path filter) in the remote config.
#          Verified afterwards in mode "rolled-back": one connector from the expected host, local --config mode,
#          before-P1 statuses (or, with --keep-ingress, this is NOT checked against the before-values).
# Not removed: the token file (0600, harmless, kept for a retry), the backup dir, config.yml, credentials.
# No window guard: a rollback is always allowed. It also works if tunnel-p1.sh died halfway (removes a stray token .tmp,
# a drop-in if present, and tolerates a missing backup); it never deletes the tunnel, config.yml or credentials.
# T2 (refuter #395, UNVERIFIED, matters for P4): if cloudflared uses the remote config whenever a tunnel is remote-managed,
#   even with --config, then "rollback to local" really runs the remote ingress. The rollback prints the connector's
#   configuration log lines after the restart as evidence; the decisive test is `--keep-ingress` on a twin with an emotion
#   filter (emotion /docs staying 404 under --config means the remote config governs). NOT run: needs Fable's word.
# Caveat: config_src stays "cloudflare" after a rollback; the API cannot flip it back to local (see tunnel-p1.sh).

set -uo pipefail
case "$-" in *x*) echo "REFUSED: run without xtrace (bash -x / set -x)."; exit 2 ;; esac
# shellcheck source=kit/tunnel-p1-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/tunnel-p1-lib.sh"

APPLY=0; KEEP=0; TUN=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;; --dry-run) APPLY=0 ;; --keep-ingress) KEEP=1 ;;
    -*) say "unknown flag $a"; exit 2 ;;
    *) TUN="$a" ;;
  esac
done
[ -z "$TUN" ] && { sed -n '2,5p' "$0"; exit 2; }
load_tunnel "$TUN"

if [ "$APPLY" = 0 ]; then
  say "DRY RUN rollback for $T on ${HOST_SSH:-this host}. Nothing is changed."
  say "  drop-in now: $(on_host "test -e $DROPIN && echo present || echo absent")   ($DROPIN)"
  say "  would: remove drop-in -> daemon-reload -> restart $UNIT ($SCOPE scope: $SC)"
  say "  would: $([ "$KEEP" = 1 ] && echo 'keep the new remote ingress' || echo 'PUT the original ingress back')"
  say "  local config.yml present: $(on_host "test -s $CFG_FILE && echo yes || echo NO")   credentials present: $(on_host "test -s $CRED_FILE && echo yes || echo NO")"
  say "  exact commands (run by --apply):"
  say "    $([ "$SCOPE" = system ] && echo 'sudo -n ')rm -f $DROPIN && $SC daemon-reload && $SC restart $UNIT"
  exit 0
fi

on_host "test -s $CFG_FILE && test -s $CRED_FILE" || { say "REFUSED: local config.yml or credentials missing on the host; a local-mode rollback is impossible."; exit 1; }
do_rollback 1 "$([ "$KEEP" = 1 ] && echo 0 || echo 1)"
if [ "$KEEP" = 1 ]; then say "(--keep-ingress: status check below compares with before-P1 values, so emotion /docs lines are expected to FAIL)"; fi
verify rolled-back; rc=$?
if unit_matches_backup; then say "  PASS  live unit == pre-edit backup, byte for byte (the unit file was never edited)"
else say "  FAIL  live unit differs from the pre-edit backup"; rc=$((rc+1)); fi
[ "$rc" = 0 ] && say "ROLLED BACK $T." || say "ROLLBACK of $T finished with $rc failing check(s): read above."
exit "$rc"
