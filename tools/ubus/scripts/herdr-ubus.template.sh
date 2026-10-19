#!/bin/zsh
# herdr presence + fixed nudge for the MVP.
# ubus calls:
#   herdr-ubus.sh status
#   herdr-ubus.sh nudge <machine> <name> <text>
#
# status must print a JSON array:
#   [{"name":"eta-refuter","machine":"mini","runtime":"claude-code","state":"idle","busy":false,"owner":"consult-lead","herdrSession":"default"}]
# The machine hex ids in the fleet map are prefixes only. Pass the label
# ubus already has; remote herdr needs the full hex id, which MiniBot fills in.
#
# nudge must send only the text ubus passes. That text is always:
#   [ubus] You have unread messages. Call ubus_inbox.
# Do not forward the caller's message body into the pane.
#
# Suggested wiring (MiniBot, after checking herdr-ctl flags):
#   status -> herdr-ctl.sh list, mapped into the JSON above
#   nudge  -> herdr-ctl.sh send <name> with the fixed text, only when idle
#
# This template returns an empty fleet so the server can boot before wiring.
if [[ "${1:-}" == "status" ]]; then
  print -r -- '[]'
  exit 0
fi
if [[ "${1:-}" == "nudge" ]]; then
  exit 0
fi
echo "usage: herdr-ubus.sh status | nudge <machine> <name> <text>" >&2
exit 2
