#!/bin/bash
# usage: s.sh user@ip keychain-svc 'sudo-cmd'   (password via stdin only)
security find-generic-password -a eta-deploy -s "$2" -w | ssh -i ~/.ssh/id_ecdsa -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 "$1" "sudo -S -k -p '' $3"
