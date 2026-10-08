#!/bin/bash
# usage: h.sh user@ip 'remote cmd'
exec ssh -i ~/.ssh/id_ecdsa -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$1" "$2"
