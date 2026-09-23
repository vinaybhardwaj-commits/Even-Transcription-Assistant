# ETA Jev translate → OpenRouter: Refuter notes (22 Sep 2026)

Target: branch `vinay/jev-translate-openrouter`, commit `7e54307` ("Jev English off qwen: OpenRouter on the router's contract").
Worked in a detached worktree at `/tmp/refute-jev`. No commits, pushes, deploys or restarts. OpenRouter was never called: the key env vars were unset, `OPENROUTER_API_URL` pointed at `127.0.0.1:9`, and every probe used an injected fetch.

## Verdict: FAIL as it stands. It becomes PASS once D1 and D2 below are fixed. D3 to D5 are small follow-ups.

## Check-by-check

| # | Check | Result |
|---|-------|--------|
| 1 | Key never in logs, errors, results or argv | PASS. The key is read at call time and sent only in the `Authorization` header. Errors are closed codes built from a status or an exception `.name`, never its `.message` (`lib/openrouter.ts:93-95`). `translate.ts` does not log anything. The kind stores only `outcome.reason`. Mutation M5 (putting `e.message` into the code) turned the tests red. |
| 2 | ZDR on every path, including the fallback | PASS. There is one body builder (`lib/openrouter.ts:~82`) and every model in the chain goes through it. A test checks both the primary and the fallback bodies. Mutation M1 turned the tests red. |
| 3 | Total failure gives English null plus an error; source never passed off as English | PASS for the failure path: `failed` → `failedRow`, which writes english=null, source=failed, error=code. Mutation M3 turned 6 tests red. **But see D1**: the *skip* path stores the source text verbatim as English, and the TS skip rule lets romanised Hindi through. |
| 4 | Label comes from the response `model` | PASS (`lib/openrouter.ts:117`). The requested id is used only when the response has no `model` field, which is the same rule as the router. Mutation M2 turned 3 tests red. The skip label `skip:english` is a constant, which is intended. |
| 5 | Skip rule matches the router's D4 rule | **FAIL: yes, the TS side lacks the blocklist.** See D1. |
| 6 | Timeout bounded by wall-clock time | **FAIL.** See D2. |
| 7 | Non-string or missing `message.content` falls through to the fallback | PASS in the code (`lib/openrouter.ts:111` throws `openrouter_bad_response` → coded → next model). My probe with `content: null` and then an array ended as `failed/openrouter_bad_response` with no throw. **But no test guards it** (D3). |
| 8 | Tests rerun, mutations | Targeted run: `tests/unit/jev-translate.test.ts` + `tests/unit/jev-english.test.ts`: 2 files, 68/68 passed. Mutations: M1 (no ZDR) red, M2 (label from the request) red, M3 (source returned as English on total failure) red, M5 (exception message in the code) red, M6 (no fallback) red, **M4 (coerce non-string content with `String()`) SURVIVED: 68/68 green**. Full suite NOT run: another agent's vitest was already running on the Mini (overnight-translate mutation run in `-ot`), so per the brief I ran targeted tests only. The worktree was left clean after the mutations (`git status` empty). |

## Defects

**D1 (blocker): the verified-English skip has no romanised-Indic veto.** `lib/jev/translate.ts:73-81` (`verifiedEnglish`) implements ≥90% ASCII letters and ≥20% function words only. The router's `verified_english` (`~/eta-router-translate-hardening/router_server.py:364-398`) also rejects any token in `ROMANISED_INDIC_VETO` (D4: hai, nahi, kya, aapko, kitne, din, se, bukhar, dawai, goli, dard, vo, kal, subah, …). The commit message claims "its verified-English skip … same word list", but it copied the pre-D4 rule. Concrete failures, run against the real TS function:
- `"aapko kitne din se bukhar hai to take the goli morning and night"` → `verifiedEnglish` = **true**. `translateToEnglish` returns `{status:"ok", english:<the Hindi verbatim>, model:"skip:english"}` with 0 model calls. The kind then writes it as `source='translated'` with that text in `english`. The router vetoes it (aapko, kitne, din, se, bukhar, hai, goli).
- `"vo kal the two days morning"` → true (router: vetoed by vo, kal).
- `"dard is there for two days, take the dawai after food"` → true (router: vetoed by dard, dawai).
The existing test's `ROMANISED` sample ("aapko kitne din se bukhar hai") passes only because it contains no function words. Fix: port `ROMANISED_INDIC_VETO` exactly and check it before the ratio. Add the three cases above as tests, and add a mutation that removes the veto.

**D2 (blocker): the timeout is not bounded by wall-clock time.** `lib/openrouter.ts:69` arms the timer, but `:98` clears it in the `finally` block of the `fetch` call, which returns as soon as the *headers* arrive. `await res.json()` at `:105` then runs with no deadline. Probe: headers 200 with a body that sends one chunk and never closes, `timeoutMs: 300` → **still pending after 3,000 ms** (it would hang until the platform kills the step). Fix: keep the timer armed until the body has been read (clear it after `res.json()`), or race the body read against the same controller. The router's own docstring (`router_server.py:~439`) makes the same point about per-socket timeouts.

**D3 (test gap): nothing guards non-string content.** Mutation M4 (`String(content)`) survived. Under it, `content: null` would record the literal English "null" as a translation. Add a test: first model returns `content: null` (or an array), fallback returns text → ok from the fallback. If both are non-string → failed/openrouter_bad_response.

**D4 (budget): the fallback doubles the worst case past the step budget.** `lib/jev/translate.ts:121` gives a 60 s timeout *per model*, with no total deadline across the chain. With `JEV_TRANSLATE_BATCH = 3` (`lib/jobs/kinds/jev-english.ts:35`, whose comment is sized for 3×60 s) that is 3 × 2 × 60 = 360 s, against `MAX_STEP_MS = 200_000` (`lib/jobs/types.ts:62`). Fix: pass one chain deadline (for example 60 s shared across models), or cut the batch to 1–2, or the per-call timeout to ~30 s.

**D5 (spec drift, confirm with V): the defaults differ from the brief.** The brief says primary `google/gemini-2.5-flash` with `meta-llama/llama-4-scout` as fallback. The code defaults are `google/gemini-2.5-flash-lite` / `openai/gpt-5-nano` (`lib/jev/translate.ts:36-37`), and the tests pin those defaults. The env vars can override them, but whatever is set on Vercel decides the actual models. Either set the env vars or change the defaults.

Minor: the `abort` listener added to `args.signal` (`lib/openrouter.ts:72`) is never removed. That is harmless per call but builds up on a long-lived runner signal (up to 6 listeners per step). Also, the skip path labels rows `source='translated'`. `model='skip:english'` keeps them countable, which is fine.

## Reproduce
- Diff: `git show 7e54307`.
- Mutation script: `~/dev/_fable/r-jev-mut.sh` → log `~/dev/_fable/scratch/jev-mut.log`.
- Probes (D1/D2/D3): a temporary test file `tests/unit/zz-refute-probe.test.ts` in the worktree, deleted after the run. The output lines P1 to P3 are quoted above.
