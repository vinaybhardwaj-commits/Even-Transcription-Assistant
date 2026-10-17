# SCRIBE-OAUTH-R3 — refuter verdict

**Verdict: PASS-WITH-FIXES.** No security defect found. Two small product fixes and two test gaps; none blocks a merge decision.
Branch under test: `scribe/oauth-person` @ `9a936598` (code `41b55843`), merge-base with main `ba51564b`.
Refuter: OpenCode served by `amazon-bedrock/global.anthropic.claude-opus-5-5`, on t4. Refuter did not build.
Probes: `tests/unit/mcp-oauth-r3-refute-probes.test.ts` (this branch, 12 tests: E1–E4 real Chromium, U1–U5 handler level).

## Gate (all re-run by the refuter)
| step | result |
|---|---|
| `npx tsc --noEmit` / `npm run typecheck:tests` / `npm run build` | 0 / 0 / 0 |
| `npm run check:silent` | rc 1, exactly the 9 accepted-baseline findings; F1 stays closed |
| full vitest, 4 threads, Docker pg | 455 files pass, 1 skipped; 9552 tests pass, 8 skipped; rc 0 (590 s) |
| `scripts/steward/scrub.sh origin/main..HEAD` | rc 0 (gitleaks 8.30.1) |
| migrations on postgres 16.15 (`/tmp/opencode/r3-migr.sh`) | fail=0 (details in item 4) |

## Verify items
1. **R2 findings closed.**
   - The consent page sends `referrer-policy: same-origin` (`lib/mcp/oauth/consent.ts:38`).
   - The Origin check refuses both the string `null` and foreign origins (U1).
   - The POST is single-use: `burnConsent` is an atomic insert on the 0172 table and runs before any mint.
     - A replay gets 400 `consent_replay` (E3, U5).
     - A forged POST or an invalid one burns nothing (E4, U1, U2).
     - A burn error fails closed (U3).
     - A person revoked between the page and Allow gets no code (U4).
   - **Real Chromium was run:** Chrome for Testing 153.0.8010.12, with the missing system libs supplied through `LD_LIBRARY_PATH` from Ubuntu 22.04 debs.
     - E1: the browser's own Origin passes the check and exactly one code is minted.
     - The R2-P1 probes pass.
2. **Consent step.**
   - The page names the client (the metadata host, or `client_name`) and the redirect host.
   - `insertCode` has one call site (callback `route.ts:127`), and it runs only after the cookie-bound CSRF check, the Origin check, the burn and `decision=allow`.
   - Deny gives a 303 with `access_denied` and mints nothing (E3).
   - The page cannot be skipped: there is no code path to `insertCode` without the POST.
3. **No regressions.**
   - R3 changes only `consent.ts` (1 line), `store.ts` (+8), the callback, and migration 0172 with its rollback.
   - `/api/mcp/lab` and `/api/mcp/[key]` are unchanged against main. Lab uses `checkMcpBearer` only.
   - `esp_` tokens are handled only in `person-auth.ts` and `token/route.ts`, and only when the flag is on.
   - Flag-off 404s, per-item audit, the `scribe_admin` refusal, the tombstone and `predates_grant` are held by the o1/o2/o3/o3-pg/o3-audit-order suites, which all pass (o2 92, o3 41, o3-pg 14, o3-audit-order 14).
4. **Migrations.**
   - All 162 apply in order, up to version 172, and re-applying twice is idempotent.
   - The 0172 columns are `csrf_hash text` and `burned_at timestamptz`, so hashes only. N6 confirms the raw value is never passed to the store.
   - The 0171 trigger refuses UPDATE, DELETE and TRUNCATE on `person` and `mcp.%` rows, including rows mutated into those types, and allows other rows.
   - The rollbacks run in reverse order, are clean and re-runnable, and re-forward works. Rolling back 0172 alone leaves 0170 and 0171 intact.

## Mutation check (`/tmp/opencode/r3-mutants.sh`)
Each mutant was applied in turn and the builder's six OAuth unit files were run, with and without Chromium, then the R3 probes.
- N1 (`no-referrer` again), N3 (burn always wins), N4 (burn before the CSRF check), N5 (Deny does not burn) and N6 (burn the raw csrf) are all killed by the builder set without Chromium.
- **N2 (accept `Origin: null`) and N7 (a burn error falls through to minting) SURVIVE the builder set without Chromium.** That is the CI configuration. See F3.

## Findings
**F1 (product, low): a human double-click on Allow ends on an error page, although consent succeeded.**
- Repro: E2, run with real CDP mouse events and 400 ms of server latency, at click gaps of 40, 120, 300 and 700 ms.
- At gaps of 40–300 ms the browser sends two POSTs, which get 303 and then 400 `consent_replay`. The browser follows the second response and shows the error page, so the client never receives the code.
- At 700 ms only one POST is sent.
- Security holds: exactly one code is minted in every case. But the doctor sees "error" and the connector setup fails.
- Fix: disable the buttons on submit (a small inline script with a CSP hash), or make a replay from the same cookie return the original 303 instead of 400.

**F2 (hardening, informational): an absent `Origin` header is accepted on the consent POST.**
- Repro: U1, a POST with no Origin header plus a valid cookie and CSRF gives 303 with a code.
- This is not exploitable cross-site: the cookie is SameSite=Lax and the CSRF is bound to it, and E4 shows a forged cross-site auto-submit carries no cookie and gets 400.
- Modern browsers always send Origin on a form POST. Refusing an absent Origin would make the check match its own comment ("strict"). The builder should decide; if it stays as is, document it.

**F3 (tests): two R3 guarantees have no Chromium-free test, so CI does not hold them.**
- N2 (accepting `null`) is caught only by the R2-P1 Chromium probe, which is skipped when `CHROME_PATH` is unset.
- N7 (burn error, then mint) is caught by no builder test.
- Fix: adopt R3-U1 and R3-U3 from the probe file into `mcp-oauth-o2.test.ts`, or keep the probe file in the suite. Both run without Chromium.

**F4 (tests, harness flake): R2-P1 in `mcp-oauth-r2-refute-probes.test.ts` intermittently fails with "Cannot read properties of undefined (reading 'webSocketDebuggerUrl')".**
- Repro: run it together with the R3 probes under load (load average about 40); it failed in 1 of 3 runs.
- Cause: the harness reads `/json/list` once, before the about:blank page target exists. This is a harness race, not product.
- The R3 probe file now polls for the page target. Apply the same poll in the R2 file.

## Not checked
- No live Google, no deploy and no production database, as the brief requires.
- Firefox and Safari were not exercised; Origin and referrer behaviour was proven on Chromium only.
