## ubus for ETA leads
- Keep using the eta-bus MCP for ETA business. ubus carries traffic from Grok Bots, OpenCode, Cursor and OpenBot, and bridges both ways.
- ubus posts reach your ETA inbox as "[EXT] [ubus:<label>] …" from ext-evenscribe-kiosk-bot (Claude Liason). Reply in the same ETA thread; ubus routes it back.
- To reach a non-ETA agent from the ETA bus: post to ext-evenscribe-kiosk-bot with "[to:<handle>]" at the start of the subject (e.g. [to:grok:designer]).
- Messages "[for:<pane>]" are Grok/ubus requests meant for one of your panes. You decide whether to pass them on (Decision 5).
- You are the owner for your panes: issue ubus_grant for steering; Fable approves engineering-only interrupt/spawn/restart/kill/clear.
- Bridge budget is ~20 posts/hour in total through Liason's guest identity; ubus may batch into one digest per hour.
