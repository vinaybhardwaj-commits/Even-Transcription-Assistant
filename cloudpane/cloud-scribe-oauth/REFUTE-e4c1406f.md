# Refute: Scribe MCP per-person OAuth, commit e4c1406f (handle cloud-scribe-oauth)
Serving model: claude-opus-5-5. Base origin/main ba51564b. Probes: tests/unit/mcp-oauth-refute-probes.test.ts on this branch.

## Verdict: PASS-WITH-FIXES
One gate MUST (F1) and one design SHOULD (F2) need resolving before SCRIBE_MCP_OAUTH=on. Nothing found lets an esp_ token reach a static map or a path-key door, and nothing lets a person past the V ruling.

## Gate (this container, Node 22.22, vitest 3.2.4 installed --no-save; the repo has no lockfile and no vitest devDependency)
- npx tsc --noEmit: 0. npm run typecheck:tests: 0. npm run build: 0.
- Full vitest (4 threads): 8222 passed, 53 failed. 52 are "REQUIRED PROOF / needs Docker" guards (Docker was down for that run). 1 is the assembled-collapse.test.ts 6,000-line timing test (11.8 s), which the diff does not touch. It fails alone too, likely because the container is slow. Not checked on main.
- The OAuth pg tests (after starting dockerd): mcp-oauth-o2-pg 9/9 and mcp-oauth-o3-pg 13/13 passed. That includes R1 and R2 (x12 concurrent: 0 live tokens).
- The OAuth unit tests: o1 16, o2 76, o3 41, o3-audit-order 14, all passed.
- npm run check:silent: FAILS, 13 findings against the accepted baseline of 9. See F1.
- swift build/test: not run (no Swift toolchain; the diff touches no Swift).

## Findings
F1 - MUST (gate). check:silent goes from 9 to 13. The four new findings are bare `.catch(() => {})` calls at lib/mcp/oauth/clients.ts:43,81,87,91.
  Repro: `npm run check:silent` lists them.
  Fix: add an explicit `/* intentional */` comment, or a count-only log, to each.
F2 - SHOULD (item 6, RFC 9700 4.5 / the MCP security best practices on consent). There is no consent or interstitial step. /api/oauth/authorize sends the browser straight to Google (prompt=select_account), and the callback mints a code with no screen that names the client.
  Attack: an attacker starts Connect on their own claude.ai account, copies the authorize URL (it carries the attacker's state and PKCE), and sends it to an allowlisted person. One account pick later, the code lands at claude.ai/api/mcp/auth_callback in the victim's browser. If claude.ai does not bind the state to the browser that started the flow (UNVERIFIED), the attacker's connector holds the victim's tokens, and the audit rows say person:<victim>.
  Repro: probe "R-CONSENT". A DCR client with the claude.ai callback gets a 302 to accounts.google.com with no HTML step.
  Fix: after the Google callback, show a same-origin page naming the client (the CIMD host or DCR client_name, plus the redirect host) with a POST "Allow" that is bound to the pending cookie. Mint the code only on that POST. Also add client_id (as a hash or host) to a success audit row.
F3 - LOW (doc plus policy). A refresh token is bound only to a PUBLIC client_id, so the spec §7 claim "a stolen one used elsewhere fails the client binding" is false. Rotation with reuse detection is the only theft control, and it trips only when the real client refreshes after the thief. The refresh lifetime slides (30 d from every rotation), so a thief keeps access indefinitely if the owner stops using the connector, until revoke_person.
  Repro: probe "R-REFRESH". A copied esr_ plus the public client_id from another IP gets 200 and a new esp_.
  Fix: correct spec §7 and §10 Live-3. Add an absolute family lifetime (for example, refuse refresh when the family's first token is older than N days; mcp_oauth_token.created_at has the data). V picks N.
F4 - LOW (item 2, CIMD SSRF). isForbiddenAddress lets these through: IPv4-compatible ::a.b.c.d and ::7f00:1, 6to4 2002::/16, local-use NAT64 64:ff9b:1::/48, SIIT ::ffff:0:0:0/96, site-local fec0::/10 and discard 100::/64.
  Exploitability depends on IPv6 egress from Vercel functions (UNVERIFIED, likely none), and TLS still pins the hostname.
  Repro: probe "R-SSRF" (7 cases).
  Fix: deny IPv6 by default. Allow only 2000::/3 and, within it, refuse 2002::/16, 2001::/32 (Teredo) and 64:ff9b:1::/48. Judge every ::/96 form by its embedded IPv4.
F5 - LOW (latency). The CIMD 5 s AbortSignal covers only the https request. dns.lookup in ssrf.ts defaultResolver has no timeout, so a slow authoritative server can push /authorize past Claude's 10 s limit.
  Fix: race the resolver against the same signal.
F6 - LOW (item 4). In the Google callback the pending_missing refusal is `void auditOauthRefused(...)` (app/api/oauth/google/callback/route.ts:32). It is the only refusal row that is not awaited, so on serverless it can be lost. The actor is unknown, so this is not a person row under FIX1 MUST-2.
  Fix: await it.

## Verified (no finding)
1. Flag off:
   - /api/mcp goes through checkMcpBearer unchanged, and the challenge header is added only when oauthEnabled().
   - For static principals the handler takes the old paths (auditItem returns true at once, and the per-call audit is still `void`).
   - The 3 /.well-known routes and the 5 /api/oauth routes return 404. The O1 tests check bytes and headers.
2. Authorization server:
   - PKCE is S256 only and checked after the atomic claim. The verifier regex is per RFC 7636.
   - A replayed code is burned and tombstones the family.
   - Redirects: claude.ai is matched exactly; loopback is http with host localhost, 127.0.0.1 or [::1], any port, path exactly /callback, no query or fragment. A wrong redirect gets an HTML page and never a redirect.
   - iss is on every redirect back to the client.
   - The pending cookie is HMAC-signed with a key derived from the pepper, and its state is compared in constant time. The nonce is checked, and the Google exchange uses PKCE.
   - CIMD: the host is resolved and refused if ANY address is bad, then fetched pinned with servername set, with redirects refused and the 64 KB cap enforced.
   - Refresh: rotation and reuse revoke the family, and a race revokes it too (pg x12 passed). predates_grant and LOW-7 pass on pg.
   - Identity: hd is lowercased and compared exactly, email_verified must be true, and the allowlist is an exact lowercase match on an active row. Grant accepts only ASCII; Google emails carry no plus or unicode variants.
3. Resource server:
   - The denylist runs first. An esp_ token never falls through to the static maps.
   - Expiry, revocation, the family tombstone, resource, inactive person and an empty scope intersection all give 401 plus a rate-limited mcp.denied row.
   - A database error gives 503.
   - /api/mcp/lab and both path-key doors use checkMcpBearer or checkPathKey only, so esp_ is refused there.
4. Audit:
   - Exactly one row per item, including batches, parse errors, notifications and refusals, awaited before the response.
   - An insert failure gives -32003; a single call or an all-failed batch gives 503.
   - client_ip goes through net.isIP. arg_keys are sanitised. The target is the registered tool name or a known method name.
   - No token, text or URL appears in rows (o3 tests plus a code read).
5. V ruling:
   - The actor gate runs before any room lookup for all 9 actions and the V GO path, and writes one admin.<action>.refused row. The o3 test covers all 9.
   - scribe_catalog include_identity also requires an admin: actor.
   - Persons still reach write tools.

## Adjacent (not actioned)
A1 - scribe_audit_recent (read scope) returns metadata_json as stored, so any person with read scope can see every other person's client_ip and session_id. For Claude Code users that IP is their own, which may well be a home IP. This is V's call.
A2 - The repo has no package-lock.json and no vitest devDependency, so `npm ci` fails on a fresh checkout.
