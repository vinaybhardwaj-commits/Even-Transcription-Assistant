#!/bin/zsh
F=$HOME/.claude/secrets/overnight_translate_mcp_token
umask 077
if [ ! -s $F ]; then /usr/bin/openssl rand -hex 32 | tr -d '\n' > $F; fi
chmod 600 $F
printf 'sha256=%s\n' "$(/usr/bin/shasum -a 256 < $F | cut -d' ' -f1)"
ls -l $F | awk '{print $1, $5}'
