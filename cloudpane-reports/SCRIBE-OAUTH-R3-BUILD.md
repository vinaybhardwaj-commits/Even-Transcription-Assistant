# SCRIBE-OAUTH-R3-BUILD: R2 refute fixes (cloud-scribe-oauth-r2, 17 Oct 2026)
Serving model: claude-opus-5-5. Branch `cloudpane/cloud-scribe-oauth-r2/r3` from r2 7ad33769. Code in 41b55843. Refute: SCRIBE-OAUTH-R2-VERDICT (PASS-WITH-FIXES).

## Order items
1. Finding 1 (MUST). `lib/mcp/oauth/consent.ts:38` now sends `referrer-policy: same-origin`, not no-referrer. The Origin check at `callback/route.ts:98` is unchanged.
   - The refuter's `tests/unit/mcp-oauth-r2-refute-probes.test.ts` is carried with R2-P1 flipped. It ran against real headless Chromium (/opt/pw-browsers/chromium), not skipped.
   - The browser now sends the page's own origin, not `null`. Allow gives 303 with code, state `st-9` and iss, and one code is minted.
   - An added P1 case keeps the Origin check honest: `Origin: null` is still a 400 `consent_csrf` with no code.
   - o2 "R2 F2" now also asserts the header.
2. Finding 2. The consent step is single-use.
   - New migration `db/migrations/0172_mcp_oauth_consent_burn.sql` (rollback in `db/rollbacks/`) adds one table, `mcp_oauth_consent_burn(csrf_hash PK, burned_at)`.
   - `store.ts:49-55` `burnConsent` is `INSERT ... ON CONFLICT DO NOTHING RETURNING`: one winner, the same atomic claim pattern as codes. The fake store mirrors it.
   - `callback/route.ts:102-115`: after the cookie, Origin and CSRF checks pass and the decision is allow or deny, the POST burns `hashSecret("consent:" + csrf)`. That is sha256 of pepper plus csrf; the csrf itself is never stored.
   - A replay gets a 400 `consent_replay` with no redirect and no code. A burn error gives a server_error redirect.
   - A forged POST (wrong CSRF, no decision) does not burn the page, so the real Allow still works.
   - The R2-P2 FINDING 2 probe is flipped: replayed Allow gives [303, 400] and 1 code. Deny then Allow gives 303 then 400 and no code, plus a `consent_replay` row.
   - New o2 "R3" tests (2): two concurrent Allows give 303 and 400, with 1 code and 1 grant row, and the burn set does not contain the csrf. A forged POST does not burn.
   - New o2-pg "R3 on real postgres": 12 iterations x3 concurrent burns, one winner each; 0172 applied twice, one schema_migrations row.
3. R2-P2..P7 are all kept and pass (58 tests in that file).

Migration numbering: main tops at 0169, and this line carries 0170 and 0171, so 0172 is next here. Not checked against other live branches from this sandbox. UNVERIFIED for collisions.

## Gate (Node 22.22, vitest 2.1.9 --no-save, dockerd up, postgres:16 = mirror.gcr.io/library/postgres:16 because Docker Hub returned 429 last round)
- `npx tsc --noEmit` rc 0. `npm run typecheck:tests` rc 0. `npm run build` rc 0.
- `npm run check:silent`: 9 findings, all pre-existing in app/[slug]/... (the accepted baseline). None in lib/mcp.
- Full `npx vitest run --poolOptions.threads.maxThreads=4`, alone, Docker up: 452 files passed, 1 skipped. 9488 tests passed, 6 skipped, 0 failed.
  - rc was 1 because of 6 vitest "Timeout calling onTaskUpdate" worker-RPC errors under load. They were attributed to s1-emotion-zero-scored, consult-index-pg and nemo-sweeper-pg, all untouched.
  - Those 3 files run alone: 85/85 passed, rc 0.
- OAuth pg suites on PG16: o2-pg 11/11, o3-pg 14/14 (it applies every migration, 0172 included), audit-append-only-0171-pg 9/9.
- OAuth unit suites: o1 16, o2 92, o3 41, o3-audit-order 14, refute-probes 11, r2-refute-probes 58. All passed.
- `bash scripts/steward/scrub.sh origin/scribe/oauth-person..HEAD` (gitleaks 8.30.1, checksum verified): rc 0.

## Adjacent (not actioned)
- A5: nothing prunes `mcp_oauth_consent_burn`. Rows are 2 short columns and useless after 5 min; a periodic `DELETE ... WHERE burned_at < now() - interval '1 day'` would bound the table.
- A4 still stands: the 1-per-minute refusal limiter can drop a consent_replay or consent_denied row after another refusal for the same person.
