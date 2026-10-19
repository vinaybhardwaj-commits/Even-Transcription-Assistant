#!/bin/zsh
# ETA outbound adapter. ubus writes one JSON object on stdin and expects
# one JSON object on stdout: {"id":"<eta id>","thread_id":"<eta thread>"}.
#
# stdin fields: as, to, subject, body, thread_id, reply_to, wake.
# ubus sets ETA_BUS_AS to the identity and unsets HERDR_* before spawn.
# wake is always false. Do not put keys, tokens, or connection strings here.
#
# ASSUMED: the real poster is ~/dev/eta-bus-mcp/run.sh (or the guest post
# path it already uses). MiniBot replaces the body of scripts/eta-post.sh
# with a call that posts as $ETA_BUS_AS and prints {id, thread_id}.
# Grok-origin traffic uses as=ext-evenscribe-kiosk-bot.
# Other traffic uses as=ubus-bridge. Fable must register ubus-bridge first.
#
# This template refuses to post so a copied example cannot write to bus.db.
echo "eta-post.sh is not wired. See scripts/eta-post.template.sh." >&2
exit 1
