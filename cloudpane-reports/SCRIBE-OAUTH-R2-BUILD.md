# SCRIBE-OAUTH-R2-BUILD — refute fixes F1-F6 and C4 B1 (cloud-scribe-oauth-r2, 17 Oct 2026)
Serving model: claude-opus-5-5. Branch `cloudpane/cloud-scribe-oauth-r2/r2` from `origin/cloudpane/cloud-scribe-oauth-c4/0171` (48d5df7a). No PHI, no secrets, no live Google, no deploy. Probe file carried over from the refute branch.

## Per ruling
1. F1 (MUST). `lib/mcp/oauth/clients.ts:15-20` adds `countSwallow` (count-only `console.warn`, no URL/token/body). It replaces the 4 bare catches at :53, :93, :99, :103. Test: o2 "R2 F1 ... touchClient throwing is logged count-only". check:silent is back to the 9 baseline findings, none in lib/mcp.
2. F2 (consent). `app/api/oauth/google/callback/route.ts:65-71`: after the Google checks and the allowlist, GET no longer mints. It re-signs the cookie under purpose `consent` (`config.ts:87-89`, 5 min, same name, path-scoped, HttpOnly, SameSite=Lax) and adds a 24-byte CSRF token. It then renders `lib/mcp/oauth/consent.ts` `consentPage`, which names the CIMD host, or the DCR client_name "(self-registered)", plus the redirect host. Every value is escaped. Headers: CSP frame-ancestors 'none', X-Frame-Options DENY, no-store.
   The new `POST` (route.ts:78-130) refuses with a plain HTML 400 that never redirects when the consent cookie is missing, expired or under the wrong purpose (`consent_missing`). It does the same for a missing or wrong CSRF token, a non-form body, or a foreign Origin (`consent_csrf`, and the cookie is kept). Deny gives 303 with error=access_denied, state and iss, plus an mcp.oauth_refused row `consent_denied`. Allow re-checks the person, mints the code and gives 303 with code, state and iss. It writes one `mcp.oauth_granted` row (`lib/mcp/audit.ts:203-217`) with `client_host` (CIMD) or `client_sha256` (DCR) and `redirect_host`, and never the code. `redirectError` takes an optional 303 (`http.ts`).
   Tests (o2 "R2 F2", 8): the page names client and redirect host with no code minted; DCR naming is escaped; no code without POST Allow (page only, a POST with no decision, a GET replay of the consent cookie); a forged POST is refused in 7 variants and the real page still works after one; Deny; the Allow audit row for CIMD and DCR; revoked between page and Allow; a pending-purpose blob at POST. The probe "R-CONSENT" now runs authorize, then Google, then the callback and asserts the HTML step with no code.
3. F3. `config.ts:91` sets `REFRESH_FAMILY_MAX_AGE_S` = 30 d. `store.ts:93-106` getToken adds `family_expired` = min(created_at) over the family <= now() - 30 d (it uses mcp_oauth_token_family_idx). `token/route.ts:105-109` then revokes the family (`family_expired`), awaits an `mcp.oauth_refused` row `family_expired` and returns invalid_grant. The fake store mirrors this (`familyBorn`). Tests: o2 "R2 F3" (2) and o2-pg "R2 F3 on real postgres". The pg test backdates only the first token of a rotated chain and gets a refusal plus a tombstone; a family 29 d 23 h old passes.
   The spec is not in the repo (no §7 or Live-3 text anywhere), so the corrected wording is below.
4. F4. `lib/mcp/oauth/ssrf.ts:18-60`: IPv6 is denied by default and only 2000::/3 is allowed. Within it 2002::/16, 2001::/32, 2001:db8::/32 and 64:ff9b:1::/48 are refused. Every address is first canonicalised through the WHATWG URL parser (a zone id is refused). Every ::/96 and ::ffff:0:0/96 form is judged by its IPv4.
   The R-SSRF probe now expects all 7 cases refused, and all 7 pass; a control shows 2606:4700:4700::1111 and ::808:808 allowed. One o2 assertion changed: 64:ff9b::808:808 (NAT64) is now refused, as the ruling requires.
5. F5. `ssrf.ts:78-99` adds `abortable` and `resolvePublic(host, signal)`. `clients.ts:64-67` uses one `AbortSignal.timeout(5000)` for both the lookup and the fetch. Tests (o2 "R2 F5"): a hanging fake resolver with a 20 ms abort returns null in under 1 s, and resolveClient against a hanging resolver gives invalid_client_metadata in 4.9-6.5 s with no fetch.
6. F6. `callback/route.ts:38` now uses `await auditOauthRefused(null, "pending_missing")`. Test: o2 "R2 F6" checks the row exists when the 400 returns.
7. C4 B1. `tests/unit/mcp-oauth-o3-pg.test.ts:35-36` adds `mark()` (server clock_timestamp). The 2 DELETEs (old :75, :152) are replaced by `created_at > mark` scoping at :78 and :155. A new last test checks that person rows survive the suite and that a DELETE of them is refused by 0171. 0171 is untouched.
   Proof on PG16 (postgres:16 image via mirror.gcr.io, Docker Hub was 429): the OLD o3-pg file fails 1/13 at MUST-1 with `ERROR: audit_append_only`, and the new one passes 14/14.
8. A1 and A2 were not touched. No lockfile was committed.

## Spec correction (F3; the text lives outside the repo)
- §7, replacing "a stolen one used elsewhere fails the client binding": "A refresh token is bound to a PUBLIC client_id, so the binding does not stop a thief who also presents that id. The theft controls are rotation with reuse detection (a rotated token coming back revokes the family) and an absolute family lifetime: a refresh family is refused 30 days after its first token, however often it rotates. revoke_person ends every family at once."
- §10 Live-3: "A copied refresh token works until the real client refreshes after it (reuse then revokes the family), and never beyond 30 days from the family's first token."

## Gate (Node 22.22, vitest 2.1.9 --no-save as gate.yml pins, dockerd running)
- `npx tsc --noEmit` rc 0. `npm run typecheck:tests` rc 0. `npm run build` rc 0.
- `npm run check:silent`: 9 findings, all pre-existing in app/[slug]/..., which is the accepted baseline.
- Full `npx vitest run --poolOptions.threads.maxThreads=4` with Docker up (pg suites ran for real): 453 files passed, 1 skipped, 9467 tests passed, 6 skipped, 0 failed. rc was 1 only because of 3 vitest "Timeout calling onTaskUpdate" worker-RPC errors attributed to tests/unit/s7-rubric-pg.test.ts (untouched) under load. That file alone: 52/52 passed.
- ETA_ALLOW_SKIP_E2E=1 run: not needed. With Docker up, no Docker guard failed, which is stronger proof than skipping them.
- OAuth pg suites on PG16: o2-pg 10/10, o3-pg 14/14, audit-append-only-0171-pg 9/9.
- OAuth unit suites: o2 90, o1, o3, o3-audit-order (147 together with o2), and refute-probes 11, all passed.
- `bash scripts/steward/scrub.sh origin/scribe/oauth-person..HEAD` (gitleaks 8.30.1, checksum from steward-scrub.yml): see OUTBOX.

## Adjacent (not actioned)
- A3: `mcp.oauth_granted` is not in `READABLE_ACTIONS` (`lib/jobs/audit-read.ts:13`), so scribe_audit_recent cannot list grants yet. One line if Fable wants it.
- A4: the refusal rate limit (1 row per subject per minute) also covers consent_denied and family_expired, so a second refusal for the same person inside a minute is not written.
