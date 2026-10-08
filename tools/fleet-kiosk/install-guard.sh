#!/bin/bash
# install-guard.sh <machine_id> <ssh_target> [ssh_key]  — installs presence-guard from ~/eta-deploy/pg
set -euo pipefail
ID="$1"; H="$2"; KEY="${3:-$HOME/.ssh/id_ecdsa}"
SVC="eta-sudo-$(echo "$ID" | tr 'A-Z' 'a-z')"
O=(-o BatchMode=yes -o ConnectTimeout=8 -o IdentitiesOnly=yes -i "$KEY")
security find-generic-password -a eta-deploy -s "$SVC" >/dev/null 2>&1 || { echo "$ID: no keychain item $SVC"; exit 8; }
ssh "${O[@]}" "$H" 'mkdir -p /tmp/eta-presence-guard'
scp -q "${O[@]}" ~/eta-deploy/pg/eta-presence-guard.sh ~/eta-deploy/pg/com.eta.presence-guard.plist ~/eta-deploy/pg/install.sh "$H":/tmp/eta-presence-guard/
{ security find-generic-password -a eta-deploy -s "$SVC" -w; ssh mini 'cat ~/oc/eta-presence-ingest/.ingest-token'; } | ssh "${O[@]}" "$H" "sudo -S -k -p '' bash /tmp/eta-presence-guard/install.sh --machine-id $ID 2>&1 | tail -1"
sleep 4
security find-generic-password -a eta-deploy -s "$SVC" -w | ssh "${O[@]}" "$H" "sudo -S -k -p '' sh -c 'launchctl print system/com.eta.presence-guard | grep -E \"runs|last exit\"; tail -2 /var/log/eta-presence-guard.log; /usr/libexec/PlistBuddy -c \"Print :ExtensionInstallForcelist\" \"/Library/Managed Preferences/com.google.Chrome.plist\" 2>&1 | grep -c evenscribe'"
