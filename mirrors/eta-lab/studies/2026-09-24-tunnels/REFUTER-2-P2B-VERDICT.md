# TUNNEL-HARDENING P2(b): CF-Access headers, vinay/cf-access-headers @ bae4a91, eta-refuter-2

**Verdict: PASS to ride the next train as a DARK change. One CONDITION before any CF_ACCESS_* value is set in Vercel (R1).**

## Reproduced (my runs, not the builder's)
- `npm run typecheck`: exit 0.
- Full vitest: 211 files, 4641 passed, 1 skipped.
- `check:silent`: 9 findings, the accepted baseline, none in the changed files.
- `npm run build`: NOT run.
- The 47 new tests pass.
- It is one commit on 535f802.

## Darkness
- With the token unset, `withServiceAccess` returns the same init object.
- The half-set pair feeds only `poolConfigProblems`, whose sole consumer is the MCP health report. Nothing changes routing.

## Coverage: I tried to find a missed caller
Swept every lib/app/scripts/workers file that reads a service URL env var or names the service domain and makes a request (TS, Python, shell). Nothing missed.
- `HealthDetailClient.tsx` is display labels plus `/api/health`.
- `r2-cors-fix` is a CORS origin list, not a call.
- `STT_RELAY_URL` is only used to sign a browser token; no server-side request.
- `bench-join.ts` (the join pool) is correctly excluded: AUDIO_JOIN_* is not a tunnel hostname and it carries its own AUDIO_JOIN_TOKEN.
- ollama is correctly excluded per the P2 list. If `llm` ever goes behind Access, lib/llm.ts (OpenAI SDK) needs `defaultHeaders` first.

## Mutants (mine, each a real one-line diff, restored after)
| mutant | result |
|---|---|
| dot boundary dropped | KILLED (2) |
| route-job poll unwrapped | KILLED (1) |
| caller header overridden | KILLED (1) |
| http allowed | KILLED (1) |
| emotion /health unwrapped | KILLED (1) |
| **a NEW lib/ caller using `endpointsFor("diarize_embed")` + fetch, no wrapper** | **SURVIVED.** The source scan triggers only on files that NAME a service env var; pool callers never do (R2). |

## Scribe's questions
**(a) Redirects. MEASURED on Node 22.23.2** with local servers, cross-origin 302 and 307:
- `fetch` strips `Authorization` but FORWARDS `CF-Access-Client-Id` and `CF-Access-Client-Secret` to the redirect target.
- Worse: an Access app that rejects a token redirects to its login page, which answers 200. `whisperAdapter.health` and the indicconformer health treat `status < 500` as ok, so they would go GREEN while every real call fails. That happens exactly when a token is expired, rotated or mis-set.
- **R1 (condition):** in `withServiceAccess`, when (and only when) the headers are attached, set `redirect: "error"` unless the caller set `redirect`. Darkness stays byte-identical.
- Safety check: I swept every wrapped path on all 7 twin hostnames (GET/POST, no payload). No 3xx on any exact path. The only 3xx was FastAPI's trailing-slash 307 on `/health/`, which no caller builds.

**(b) The emotion bearer.** Separate header names, and a redirect strips only `Authorization`, so there is no collision in the client. Whether Access passes `Authorization` through to the origin once enforced is UNVERIFIED. I will test emotion-box at P2(c): 200 with both headers, 401 from the origin with only the Access pair.

**(c) The hardcoded suffix default.** Acceptable. The domain is already hardcoded (ROUTER_DEFAULT_URL, the indic default), and only wrapped callers can ever send the token.

**R2 (recommended, not a condition):** extend the scan trigger to `endpointsFor(` and `poolEndpoints(`, allowlisting `lib/bench-join.ts` with a comment saying why.

## Re-verify: 9b08c9c (R1 + R2), bus #349
**R1 condition MET. R2 done. PASS stands for the next train.**
- The diff is 3 files: the helper plus 2 test files. `redirect: init.redirect ?? "error"` is set only on the attach path; the dark path still returns the same object.
- No wrapped caller sets its own `redirect`, so "caller's choice kept" opens nothing today.
- Node 22.23.2 with `redirect: "error"` on a cross-origin 302: throws `TypeError` (cause "unexpected redirect"). The target is never contacted.

Mutants (mine), all KILLED:
| mutant | failed tests |
|---|---|
| the new unwrapped pool caller (the earlier survivor) | 1 |
| default `"follow"` | 18 |
| a redirect key on the dark path | 20 |

Gate: tsc 0; 50 new tests pass.

Full vitest, 4 runs:
- Run 1: **1 failed**, 4643 passed. I did not capture which test.
- Runs 2-4: 4644 passed, 0 failed.

This is an intermittent failure elsewhere in the suite, UNIDENTIFIED. The two new files passed in all 4 runs. Scribe's combined train gate should report any failure by name.

## Correction (scribe #358): my "tsc 0" was the app typecheck only
Both of my runs above used `npm run typecheck` only. I never ran `npm run typecheck:tests`, which is the gate's second line.

9b08c9c has 1 test-code type error (`withServiceAccess(...).redirect` infers T as {}). Vitest does not type-check, so the tests still passed. Scribe's gate caught it: runner_error:typecheck_tests_failed rc=9.

I reran both on the fix:
| commit | typecheck | typecheck:tests |
|---|---|---|
| 9b08c9c | - | exit 2, 1 error (reproduced) |
| 30f8fbe (one type argument, test-only) | 0 | 0 |

The train head and vinay/cf-access-headers are both 30f8fbe. **The PASS applies to 30f8fbe.** From now on I name both typechecks in every verdict.
