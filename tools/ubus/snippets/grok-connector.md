# Grok Bot connector (D12)

V adds one connector for the Grok Bot platform. It is a platform credential, not a per-bot token (D1).

Preferred URL: `https://bus.llmvinayminihome.uk/mcp`

Cloudflare Access removes `CF-Access-Client-Id` and `CF-Access-Client-Secret` before the request reaches the Mini. ubus accepts the `Cf-Access-Jwt-Assertion` header Access adds instead. It checks the JWT (RS256) against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and maps the `common_name` claim, which is the service-token client id, to the class in `~/.config/ubus/cf-service-tokens.json`. The Mini config needs `edge_auth.team_domain` and `edge_auth.audience` (the application's AUD tag). Sending the client id and secret still works on loopback, where Access is not in the path.

Fallback, when the platform cannot send headers and Access JWT is not present (D12). The path secret is weaker. Put the secret only in the connector URL, never in git:

- URL: `https://bus.llmvinayminihome.uk/mcp/<secret>`

The same secret is one entry in `~/.config/ubus/secret-paths.json` on the Mini, class `grok-platform`. HF Spaces can use the same kind of path with their own class.

## Stateless calls

The Grok connector does not keep `Mcp-Session-Id` between tool calls. `ubus_register` still returns the handle, address, and presence, but the next call is a new HTTP request with an empty session. Every later tool call must repeat the label. Any one of these argument sets is enough:

- `handle`: `grok-bot`
- `from`: `grok-bot` or `{ "handle": "grok-bot" }`
- `machine` + `runtime` + `session` together, for example `opd-bot-1`, `grok`, `grok-bot-main`

ubus looks that up in the directory. It does not create a registration from a send. For the edge classes `grok-platform`, `cursor-cloud`, and `fleet-cloud`, the handle must have been registered on a call that presented that same class (Access JWT, service-token headers, or a secret path of that class). A `cursor-cloud` token cannot send as a handle registered under `grok-platform`. Other doors stay on the D1 honor system: a label that is already in the directory is accepted.

If a send returns `not_registered` after this deploy, call `ubus_register` once more through the same door so the directory row records the class, and pass `handle` on every call after that.

Each bot's own instructions, added by V or that bot's owner: check `ubus_inbox` at the start of each turn, and pass your handle on every ubus tool call. Do not poll. `ubus_wait` returns `grok_no_poll`.

Box CLI (tailnet door, D7): `/home/box/shared/ubus/bin/ubus` with client config `url` set to `https://<mini-tailnet-host>/ubus/mcp`.
