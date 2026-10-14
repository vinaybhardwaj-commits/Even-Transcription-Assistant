#!/bin/zsh
S=/Users/vinaybhardwaj/dev/_fable/secrets/prod.env
if [ ! -f $S ]; then echo "prod.env gone"; exit 0; fi
for K in APP_DATABASE_URL DATABASE_URL BRAIN_DATABASE_URL; do
  L=$(grep "^${K}=" $S | head -1)
  if [ -z "$L" ]; then echo "$K : absent"
  elif echo "$L" | grep -q 'SENSITIVE'; then echo "$K : PLACEHOLDER"
  else
    H=$(echo "${L#*=}" | tr -d '"' | sed -E 's|^postgres(ql)?://[^@]*@||; s|/([^?]*).*|  db=\1|')
    echo "$K : REAL  host+db = $H"
  fi
done
