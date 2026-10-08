#!/bin/bash
# usage: p.sh user@ip key svc
U="$1"; K="$2"; S="$3"
SSH="ssh -i $K -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 $U"
READ="pmset -g | egrep -i 'sleep|standby|autorestart|SleepDisabled' | tr -s ' ' | tr '\n' ';'; echo; uptime"
echo "== $U"
echo "BEFORE:"; $SSH "$READ" || { echo "UNREACHABLE rc=$?"; exit 1; }
if ! security find-generic-password -a eta-deploy -s "$S" -w >/dev/null 2>&1; then echo "NO KEYCHAIN ITEM $S"; exit 2; fi
security find-generic-password -a eta-deploy -s "$S" -w | $SSH "sudo -S -k -p '' pmset -a sleep 0 disksleep 0 displaysleep 0 disablesleep 1 autorestart 1 womp 1" 2>&1 | grep -v -i password
echo "APPLY rc=${PIPESTATUS[1]}"
echo "AFTER:"; $SSH "$READ"
