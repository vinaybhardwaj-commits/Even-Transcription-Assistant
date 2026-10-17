# SCRIBE-OAUTH-R2-VERDICT: refute of the Scribe OAuth R2 fix round (cloud-scribe-oauth-r2-refute, 17 Oct 2026)
Serving model: claude-opus-5-5. Target `origin/cloudpane/cloud-scribe-oauth-r2/r2` at 7ad33769 (e4c1406f, then 0171 e6504122, then R2 088c38a0). Branch `cloudpane/cloud-scribe-oauth-r2-refute/verdict`.
Probes: `tests/unit/mcp-oauth-r2-refute-probes.test.ts` (57 tests). Code only: no PHI, no secrets, no live Google, no deploy.

## Verdict: PASS-WITH-FIXES
Rulings 1 and 3-8 are met, and my own probes and mutants back them. Ruling 2 (consent) is correct server-side, but as shipped it **refuses every real browser** (finding 1). The fix is one line, and it must land before SCRIBE_MCP_OAUTH=on.
Nothing found weakens 0171, lets esp_ reach a static map or a path-key door, or lets a person past the V ruling.

## Gate (this container: Node 22.22, vitest 2.1.9 --no-save as gate.yml pins, dockerd up, postgres:16 = 16.15)
- `npx tsc --noEmit` rc 0. `npm run typecheck:tests` rc 0. `npm run build` rc 0.
- `npm run check:silent`: 9 findings, all pre-existing in app/[slug]/... (the accepted baseline). None in lib/mcp, none in my probe file.
- Full `npx vitest run --poolOptions.threads.maxThreads=4`, run ALONE with Docker up (so the pg suites ran for real): rc 0. 455 files passed, 1 skipped. 9549 tests passed, 6 skipped, 0 failed. Duration 1499 s.
  - My first attempt was invalid and was discarded: a parallel vitest run's no-leaked-containers teardown reaped the full run's containers. The numbers above come from the clean rerun.
- OAuth pg suites on PG16, inside that run: o2-pg 10/10, o3-pg 14/14, audit-append-only-0171-pg 9/9.
- OAuth unit suites: o1 16, o2 90, o3 41, o3-audit-order 14, refute-probes 11, r2-refute-probes 57. All passed.
- `GITLEAKS=<8.30.1, sha256 551f6fc8... verified> bash scripts/steward/scrub.sh origin/scribe/oauth-person..origin/cloudpane/cloud-scribe-oauth-r2/r2`: rc 0.
- ETA_ALLOW_SKIP_E2E: not used. With Docker up, no Docker guard fired.
- swift build/test: not run (no Swift toolchain; the diff touches no Swift).

## Findings
1. MUST, before flag-on (ruling 2 not met in a browser). The consent page sends `Referrer-Policy: no-referrer` (lib/mcp/oauth/consent.ts:374). Under the Fetch spec, a non-GET request whose referrer policy is no-referrer serialises its Origin as `null`. The POST check `origin !== null && origin !== req.nextUrl.origin` (callback/route.ts:98) compares that against the string "null", so Allow AND Deny both get the plain 400 `consent_csrf`. No code is minted and the client is never redirected: every sign-in dead-ends.
   Repro: probe "R2-P1". It serves the real page bytes and headers from the real callback GET to headless Chromium 141.0.7390.37 (/opt/pw-browsers) and clicks Allow over CDP. The POST carries `Origin: null`. Replayed into the real POST handler, that gives 400, no location, no code, and a consent_csrf row.
   Control (same probe file): the same page with only that header removed sends the page origin, and Allow then gives 303 with code, state and iss.
   The builder's tests always send `origin: https://www.evenscribe.app` (o2 :190), so they cannot see this.
   Fix: set `referrer-policy: same-origin` (or `strict-origin`) on the consent page. Keep the Origin check. Flip R2-P1 to expect a 303 with a code.
2. LOW. The consent cookie and CSRF pair is not single-use on the server. Within its 5 min, the same Allow POST replayed mints a second code, and Deny followed by Allow with the same cookie mints one. The browser drops the cookie on the 303 (`done()`), so exploiting this needs the HttpOnly cookie. Practically, a double-click on Allow mints 2 codes and writes 2 grant rows.
   Repro: "R2-P2 ... FINDING 2". Fix (optional): record a hash of the consent csrf as burned (as is done for codes), or accept the trade-off and note it.
3. LOW (test gaps; the code is right). Four of my mutants are killed ONLY by refuter probes, not by the builder's own tests. See the table below: M10 drop 2001::/32, M11 ::/96 no longer judged by its IPv4, M13 `void` the pending_missing refusal, and M9 allow fec0::/10 (killed only by the carried R-SSRF probe).
   The o2 "R2 F6" test cannot catch an un-awaited refusal because the fake sql resolves within the same microtask chain. R2-P6 delays the insert by one macrotask.
   Fix: keep tests/unit/mcp-oauth-r2-refute-probes.test.ts in the merge (R2-P2..P7), or port P4/P6 into o2.
4. NOTE, no action asked.
   - (a) Within 2000::/3, 3fff::/20 (RFC 9637 documentation) and the rest of 2001::/23 (for example 2001:2::/48 benchmarking) still pass. The ruling did not list them; R2-P4's controls pin today's behaviour.
   - (b) An aborted lookup returns at once, but the libuv dns.lookup thread keeps running (the pool has 4 threads), so many hanging CIMD hosts can still queue lookups inside one instance. The timeout ruling is met; this is about capacity.
   - (c) I agree with the builder's A4: the 1-per-minute-per-subject refusal limiter can suppress a consent_denied row that comes right after a consent_csrf row for the same person. Finding 1 makes exactly that sequence likely today.

## Rulings, verified independently
1. F1. The 4 catches now go through `countSwallow`, which logs the count only. check:silent is at 9. Mutant M14 (drop the log) is killed by o2 "R2 F1".
2. F2. The GET renders the page and never mints (M1 is killed by 19 tests). Purpose binding works both ways: a consent blob is refused at GET, and a pending blob at POST (R2-P2; M4 killed by 37).
   - CSRF is per flow: page A's token does not open page B's cookie (R2-P2; M2 killed).
   - A foreign Origin is refused (M3 killed by o2 and R2-P1).
   - Open redirect: extra redirect_uri, state or client_id fields are ignored on both Allow and Deny. The location stays CLAUDE_CALLBACK with the original state (R2-P2).
   - Deny gives 303 with error=access_denied, state and iss, plus one consent_denied row and no code (M5 killed).
   - Naming: client_name is already reduced to `[\w .-]` at register/CIMD, and the page also escapes it (M15 killed). CIMD clients are named by their URL host (punycode).
   - Clickjacking is covered by frame-ancestors 'none' and X-Frame-Options DENY. Not met in a browser: finding 1.
3. F3. Family age is min(created_at) over the family. In R2-P3, 30 d - 5 s rotates, while 30 d + 5 s is refused with invalid_grant, a tombstone and a family_expired row. Five rotations do not reset the clock.
   - SQL mutant M7 (max instead of min, so rotation resets the clock) survives every unit suite and is killed only by o2-pg "R2 F3". Keep that pg test in the gate.
   - The spec is not in the repo. The builder's corrected §7/§10 wording is accurate.
4. F4. R2-P4 covers 35 refused forms. Among them:
   - IPv4-compatible forms (hex, dotted, fully expanded, upper case)
   - the ::ffff mapped forms
   - SIIT ::ffff:0:0:0/96
   - 64:ff9b::/96 and 64:ff9b:1::/48
   - fec0::/10, fe80, fc00/fd, ff02, 100::, 1fff:...
   - 2002::/16, 2001::/32 and 2001:db8::
   - a zone id, brackets, a CIDR string and a non-IP
   The controls pass: 2606:4700:4700::1111, 2a00:1450::1, ::808:808, ::ffff:808:808, 2003::1. One bad address among several sinks the host. M9, M10 and M11 are killed.
5. F5. A resolver that never answers and a 30 ms signal give null in under 500 ms, and an answer that arrives before the abort still counts (R2-P5). M12 is killed by o2 "R2 F5" and R2-P5.
6. F6. The insert is awaited: with a 20 ms delayed insert, the row exists when the 400 returns (R2-P6). M13 is killed only by R2-P6.
7. C4 B1. 0171 is unchanged since e6504122. Using the e4c1406f version of o3-pg against the migrations with 0171 gave 12/13, failing MUST-1 with `ERROR: audit_append_only`. The R2 version gives 14/14, and the 0171 suite 9/9 (o3-pg + 0171 together 23/23).
   The cleanup still proves what it proved: the exact-count assertions (`toHaveLength(2)`, `toHaveLength(1)` per XFF case) are kept and scoped by a server-clock marker. Each pg suite has its own container (fresh schema per run). The new last test shows that a DELETE of person rows is refused.
8. A1 and A2 were not touched (diff scope: 9 source files, all under app/api/oauth and lib/mcp).

## Original "Verified (no finding)" list after R2
- R2 changes only callback/token routes, lib/mcp/audit.ts (adds `auditOauthGranted`; the per-call path is untouched), and the clients, config, consent, http, ssrf and store modules in lib/mcp/oauth.
- /api/mcp, the lab door, both path-key doors, the bearer/static maps, the admin actions, authorize, register, revoke and /.well-known are byte-identical to e4c1406f (`git diff e4c1406f..7ad33769` on them is empty). So these all still hold: esp_ never reaches a static map or a path-key door, one audit row per item, and admin actions refused for persons. o3 41/41 and o3-pg 14/14 still pass.
- Flag off: the new callback POST is a bare 404 with an empty body, no cookie, no audit row and nothing minted (R2-P7). Every other door is unchanged.
- Allow writes exactly one `mcp.oauth_granted` row, `person:<email>`, with `{ok, client_host, redirect_host}` only. The code, the csrf and the cookie appear in no audit value (R2-P7).

## Mutants (15, all run; each reverted after its run; the unit set is o1, o2, o3, o3-audit-order, refute-probes, r2-refute-probes; M6-M8 also ran on o2-pg and o3-pg)
| id | change | killed by |
|---|---|---|
| M1 | mint the code on GET (old behaviour) | o2 R2 F2 x6, o2 callback/loopback e2e, ... (19) |
| M2 | drop the CSRF compare | o2 "forged POST" + R2-P2 cross-flow csrf |
| M3 | drop the Origin check | o2 "forged POST" (foreign origin) + R2-P1 |
| M4 | POST verifies under PENDING_PURPOSE | 37 o2 tests (no flow completes) |
| M5 | Deny ignored (falls to 400) | o2 Deny + R2-P2 x3 |
| M6 | family max age 30 d + 120 s | o2 R2 F3, R2-P3 x2, o2-pg R2 F3 |
| M7 | SQL min(created_at) -> max | o2-pg R2 F3 only (unit: survives) |
| M8 | family_expired check off | o2 R2 F3 x2, R2-P3 x2, o2-pg R2 F3 |
| M9 | allow fec0::/10 | R2-P4 x2, carried R-SSRF |
| M10 | drop 2001::/32 (Teredo) | R2-P4 x2 only |
| M11 | ::/96 not judged by its IPv4 | R2-P4 control + carried R-SSRF control |
| M12 | drop the resolver abort | o2 R2 F5 x2 + R2-P5 |
| M13 | `void` the pending_missing refusal | R2-P6 only |
| M14 | countSwallow logs nothing | o2 R2 F1 |
| M15 | consent page does not escape the client label | o2 R2 F2 DCR naming |
