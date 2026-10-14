#!/bin/zsh
# Scope probe. Prints only the actor label, HTTP code and error code — never a token.
U=https://www.evenscribe.app/api/mcp
probe() {
  local label=$1 file=$2 tool=$3 args=$4
  local H=$(mktemp); chmod 600 $H
  printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < $file)" > $H
  local out=$(curl -s -m 40 -w '\nHTTP=%{http_code}' -X POST $U -H @$H -H 'content-type: application/json' -H 'accept: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}")
  rm -f $H
  echo "$label $tool: $(echo "$out" | tail -1) $(echo "$out" | grep -oE '"(code|error)":"?[a-z_0-9-]+' | head -3 | tr '\n' ' ')$(echo "$out" | grep -oE 'unknown_job|scope_or_tool_unavailable|mcp_scope_refused|unauthorized' | sort -u | tr '\n' ' ')"
}
probe night-drain $HOME/.claude/secrets/scribe_mcp_token scribe_health '{}'
probe overnight   $HOME/.claude/secrets/overnight_translate_mcp_token scribe_health '{}'
probe overnight   $HOME/.claude/secrets/overnight_translate_mcp_token scribe_job_cancel '{"job_id":"job_probe_does_not_exist"}'
