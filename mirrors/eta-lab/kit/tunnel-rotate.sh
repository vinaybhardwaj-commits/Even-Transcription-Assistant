#!/bin/bash
# Rotate the connector secret of a SWITCHED (token-mode) twin tunnel (ruling 286: eta-gcpl4 only; its credential was copied).
#
#   kit/tunnel-rotate.sh eta-gcpl4              DRY RUN (default): read-only, prints the plan and checks the preconditions
#   kit/tunnel-rotate.sh eta-gcpl4 --apply --probe-host air
#                                               rotate. Daylight, AFTER tunnel P1 has switched this tunnel and verified.
#                                               --probe-host is REQUIRED: a non-production host that runs the live "old credential is
#                                               rejected" probe (kit/tunnel-probe-old.sh; refuter-2 #1603, ruling 295). Default host: air.
#
# Order (each step checked; any failure after the PATCH rolls back to the OLD secret):
#   0 preconditions  tunnel switched (drop-in in place), remote-managed (config_src=cloudflare), verify(post) ALL PASS
#   1 snapshot       old connector token into a shell variable (memory only) and a 0600 copy <token file>.prev on the host
#   2 PATCH          fresh random tunnel secret. A connected connector is NOT dropped (measured), so no outage here; new
#                    registrations with the old secret (image, clone disks, any copy) are refused from now on
#   3 new token      API -> pipe -> <token file>.tmp (0600) -> mv over <token file>   (never argv, never printed)
#   4 restart        restart the connector; it reconnects with the new secret (a few seconds of hostname drop)
#   5 verify         verify(post): ONE connector from the expected host, statuses, canary; the secret in the token really DIFFERS
#                    from the old one and the connector id is NEW (refuter-2 #1544); then delete <token file>.prev
#   6 live probe     the OLD token is run for <=60 s on the probe host while the API connector count is watched; it must be
#                    REJECTED. If it registers (count rises) it is killed at once and the script exits 3: the rotation did NOT
#                    take, do not delete the old image. (Run only after 'rotated' said the secret changed.)
#   rollback (on failure after step 2): PATCH the OLD secret back (taken from the old token in memory), restore the old
#            token file, restart, verify(post). If even that fails the script says so plainly and exits non-zero.
# Not automated on purpose: the old <id>.json credentials file on the host is now DEAD (holds the leaked secret). Removing
# it is a separate, named step (P1 keeps it for the local-config rollback, which rotation ends).
# Only eta-gcpl4 is supported: that is the tunnel whose credential was copied (ruling 286).

set -uo pipefail
case "$-" in *x*) echo "REFUSED: run without xtrace (bash -x / set -x)."; exit 2 ;; esac
KITDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=kit/tunnel-p1-lib.sh
. "$KITDIR/tunnel-p1-lib.sh"
ROT="python3 $KITDIR/tunnel_rotate.py"

APPLY=0; TUN=""; PROBE_HOST=""; NEXT=""
for a in "$@"; do
  if [ "$NEXT" = probe ]; then PROBE_HOST="$a"; NEXT=""; continue; fi
  case "$a" in --apply) APPLY=1 ;; --dry-run) APPLY=0 ;; --probe-host) NEXT=probe ;; -*) say "unknown flag $a"; exit 2 ;; *) TUN="$a" ;; esac
done
[ "$TUN" = eta-gcpl4 ] || { say "usage: kit/tunnel-rotate.sh eta-gcpl4 [--apply]  (only the tunnel whose credential was copied, ruling 286)"; exit 2; }
load_tunnel "$TUN"
PREV="$TOKEN_FILE.prev"

precheck() {   # prints each precondition; returns the number that fail
  local bad=0 src drop
  src="$($CF state "$TID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["config_src"])')"
  drop="$(on_host "cat $DROPIN 2>/dev/null")"
  if [ "$src" = cloudflare ]; then say "  config_src        : $src OK"
  else say "  config_src        : $src <- FAIL: tunnel is not remote-managed; run P1 first"; bad=$((bad+1)); fi
  if printf '%s' "$drop" | grep -q -- "--token-file $TOKEN_FILE"; then say "  connector drop-in : in place (token mode) OK"
  else say "  connector drop-in : <- FAIL: not in token mode; run P1 first"; bad=$((bad+1)); fi
  if on_host "test -s $TOKEN_FILE && [ \$(stat -c %a $TOKEN_FILE) = 600 ]"; then say "  token file        : present, mode 600 OK"
  else say "  token file        : <- FAIL: missing or not 0600"; bad=$((bad+1)); fi
  return "$bad"
}

probe_ready() {   # the probe host: allowed, reachable, cloudflared + perl present, no tunnel already running there
  case "$1" in gcp-l4|box|hist-*|e2e-ci) say "  probe host $1      : <- FAIL: production or hist host"; return 1 ;; esac
  local r; r="$(timeout 25 ssh -o BatchMode=yes -o ConnectTimeout=8 "$1" 'CF=$(command -v cloudflared || ls /opt/homebrew/bin/cloudflared 2>/dev/null); echo "cf=${CF:-none} perl=$(command -v perl || echo none) procs=$(pgrep -x cloudflared | wc -l | tr -d " ")"' 2>&1 | head -1)"
  if printf '%s' "$r" | grep -q 'cf=none\|perl=none\|procs=[1-9]' || [ -z "$r" ]; then say "  probe host $1      : <- FAIL ($r)"; return 1; fi
  say "  probe host $1      : ready ($r) OK"; return 0
}

if [ "$APPLY" = 0 ]; then
  say "DRY RUN rotate $T ($TID) on ${HOST_SSH:-this host}. Nothing is changed, no token fetched, no PATCH sent."
  step "preconditions"; precheck; pc=$?
  probe_ready "${PROBE_HOST:-air}" || pc=$((pc+1))
  step "planned steps"
  say "  1 snapshot old token (memory) + $PREV (0600)"; say "  2 PATCH a fresh tunnel secret (no outage: a live connector stays up)"
  say "  3 new token -> $TOKEN_FILE (via .tmp, mode 600)"; say "  4 restart $UNIT ($SCOPE scope: $SC)"
  say "  5 verify(post) + secret changed + NEW connector id, then the live probe (6): the OLD token on ${PROBE_HOST:-air} must be REJECTED (60 s cap, killed on sight)"
  say "  then remove $PREV;  rollback = PATCH the old secret back + old token file + restart"
  if [ "$pc" = 0 ]; then verify post; rc=$?; else rc=$pc; fi
  [ "$rc" = 0 ] && say "DRY RUN OK: preconditions and verify(post) pass; --apply would proceed." || say "DRY RUN: $rc issue(s) above; --apply would refuse."
  exit "$rc"
fi

# ---- apply ----
[ -n "$PROBE_HOST" ] || { say "REFUSED: --apply requires --probe-host <non-production host> (ruling 295: the old credential must be shown rejected)."; exit 2; }
step "0 preconditions"; precheck || { say "REFUSED: preconditions failed, nothing changed."; exit 1; }
probe_ready "$PROBE_HOST" || { say "REFUSED: probe host not ready, nothing changed."; exit 1; }
verify post || { say "REFUSED: verify(post) baseline fails, nothing changed."; exit 1; }

step "1 snapshot"
OLD_TOKEN="$($CF token "$TID")" && [ -n "$OLD_TOKEN" ] || { say "could not read the current token, nothing changed."; exit 1; }
OLD_CID="$($ROT connector-id "$TID")" || { say "cannot identify the single current connector, nothing changed."; exit 1; }
on_host "umask 077; cp -p $TOKEN_FILE $PREV && chmod 600 $PREV" || { say "could not back up the token file, nothing changed."; exit 1; }
say "  old token held in memory; host copy $PREV (mode $(on_host "stat -c %a $PREV"))"

PATCHED=0
rollback() {
  say ""; say "!! $1 -> rolling back (secret patched: $PATCHED)"
  if [ "$PATCHED" = 1 ]; then
    printf '%s' "$OLD_TOKEN" | $ROT restore "$TID" || say "!! COULD NOT PATCH THE OLD SECRET BACK: the tunnel is on the NEW secret; fetch its token and reinstall by hand"
  fi
  printf '%s' "$OLD_TOKEN" | on_host "umask 077; cat > $TOKEN_FILE.tmp && chmod 600 $TOKEN_FILE.tmp && mv $TOKEN_FILE.tmp $TOKEN_FILE"
  on_host "$SC restart $UNIT"; wait_connected || say "!! connector not healthy after rollback"
  verify post || say "!! ROLLED-BACK STATE STILL FAILS VERIFY: manual attention needed on $T"
  exit 1
}

step "2 PATCH a fresh tunnel secret"
PATCHED=1     # set before the call: a failed-looking PATCH may still have taken effect
$ROT rotate "$TID" || rollback "PATCH failed"

step "3 new token -> host file"
$CF token "$TID" | on_host "umask 077; cat > $TOKEN_FILE.tmp && chmod 600 $TOKEN_FILE.tmp && mv $TOKEN_FILE.tmp $TOKEN_FILE" || rollback "could not install the new token"
[ "$(on_host "stat -c %a $TOKEN_FILE")" = 600 ] || rollback "new token file is not mode 600"

step "4 restart"
on_host "$SC restart $UNIT" || rollback "restart failed"
wait_connected || rollback "no healthy single connector from $EXPECT_IP within 60s on the new secret"

step "5 verify"
verify post || rollback "post-rotation verification failed"
# refuter-2 #1544: "verified" = new credential in use + old one dead. The API never shows the secret, so compare what the token embeds.
printf '%s' "$OLD_TOKEN" | $ROT rotated "$TID" > /dev/null || rollback "the tunnel secret did NOT change (the token still embeds the old secret)"
say "  PASS  tunnel secret changed (current token embeds a different secret than the old one)"
NEW_CID="$($ROT connector-id "$TID")" || rollback "not exactly one connector after the restart"
[ "$NEW_CID" != "$OLD_CID" ] || rollback "connector id is unchanged: the restart did not produce a new connector"
say "  PASS  one connector, a NEW connector id (old ${OLD_CID:0:8}, new ${NEW_CID:0:8}), from $EXPECT_IP"
step "6 live probe: the OLD credential must be rejected (from $PROBE_HOST)"
printf '%s' "$OLD_TOKEN" | "$KITDIR/tunnel-probe-old.sh" "$TID" "$PROBE_HOST"; prc=$?
if [ "$prc" = 3 ]; then say "!! STOP: the OLD credential STILL REGISTERS: the rotation did not take. Do NOT delete the old image. Investigate; nothing was rolled back."; exit 3
elif [ "$prc" != 0 ]; then say "!! live probe inconclusive (exit $prc): read the output above and the API by hand before any image delete."; exit 4; fi
on_host "rm -f $PREV"
say ""; say "DONE $T: secret rotated, connector on the new token, one connector from $EXPECT_IP. The old secret (image, clone disks, $HOME_DIR/.cloudflared/$TID.json) can no longer register (live probe from $PROBE_HOST: REJECTED). Next, separately named: remove the dead $TID.json on the host."
