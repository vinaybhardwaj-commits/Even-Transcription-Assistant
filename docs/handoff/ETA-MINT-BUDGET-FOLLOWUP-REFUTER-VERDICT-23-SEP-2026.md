# ETA — mint budget follow-up. REFUTER VERDICT. 23 Sep 2026

`vinay/mint-budget-followup` **@ `1686171`** (builder fleet), one commit on `3a7ca76`: `lib/gcp-auth.ts`, `lib/llm/gemini.ts` and three tests. Closes two round-4 items — the `clearTimeout` survivor (W7) and the calibration note on two uncoordinated mint budgets. Own detached worktree `/tmp/refute-mint`; nothing pushed, no real provider called. Mini kept out — every run on the Yoga fast runner.

**Base:** `3a7ca76` (r4) is already merged into `origin/vinay/s1-auto-drain`, and this branches off r4 directly rather than off the deploy branch, so it merges normally — no rebase question.

## PASS-WITH-FIXES — both items are done in the source, and almost none of it is pinned

**Mutations: 8 run, 0 runner errors, 2 killed.** A low kill rate needs its survivors argued rather than counted, so each is below. The short version: the *code* does what the ruling asked; the *tests* protect almost none of it, and one thing that r4 had pinned is no longer pinned.

### What is closed

- **W7 — `clearTimeout(tid)` in `lib/gcp-auth.ts`. P1 dies.** My round-4 survivor is genuinely covered now. That was the commit's first purpose and it is achieved.
- **The re-export works and is covered. P8 dies.** Removing `export { MINT_TIMEOUT_MS }` from `gemini.ts` breaks importers, and a test notices.
- **One budget, in the source.** The uncoordinated `MINT_DEFAULT_TIMEOUT_MS = 30_000` is gone; the constant is defined in `lib/gcp-auth.ts` — correctly, since that is the file that mints — and re-exported. The `PROVISIONAL` comment is honest about the value being a guess and says where the replacement data will come from. That is the right shape for my round-4 note.
- **The log is correctly placed.** `mintStart` is captured **after** the cache return, so a cached call logs nothing, and the `console.log` sits in `finally` beside `clearTimeout`, so it fires on success, HTTP failure and abort alike. Both claims in its comment are true — I checked the placement rather than the comment. It is a bare number under a greppable key: no token, no URL, nothing sensitive.

### FINDING 1 — moving the constant un-pinned its value, and the mock is why

**P6 survives: `MINT_TIMEOUT_MS = 10_000 → 100_000` leaves the suite green.** At round 4 the identical mutation (**W4**) was **killed**. Coverage went backwards in a commit whose purpose was to tidy this constant.

The cause is four lines added to the mock in the same commit:

```
tests/unit/routed-chat-deadline.test.ts:34-41
vi.mock("@/lib/gcp-auth", () => ({
  getVertexAccessToken: (signal?, timeoutMs?) => { …record… },
  MINT_TIMEOUT_MS: 10_000,
}));
```

The builder's own comment explains why it is there — a mock that omits it breaks every call site in `gemini.ts` that reads it — and that reasoning is correct for making the suite run. The side effect is that the file's exact-value assertions (`toBe(253_000)`, `toBe(407_000)`) are now computed against **the mock's** `10_000`, not the source's. The real constant can be anything.

**This is the third instance of one pattern on this branch**, and worth naming as a class rather than three incidents:

| round | the stand-in | what it hid |
|---|---|---|
| r2 | a zero-arity `getVertexAccessToken` mock | whether the caller ever passed a signal |
| r4 → now | the same mock, now also supplying the constant | the constant's value |
| (encounter clock) | `k = Math.round(ENERGY_ACTIVE_MIN * n)` | the threshold's value |

Each time, a test artefact stands in for the thing under test, so changing the source moves nothing. **Moving a constant behind a mock boundary silently un-pins it**, and it is invisible precisely because the re-export keeps everything compiling and green.

**Fix, and the better of the two options is worth taking:** assert `expect(MINT_TIMEOUT_MS).toBe(10_000)` in `gcp-auth-abort.test.ts`, which exercises the real module. Better still, have the mock take the real value rather than restate it — `vi.mock("@/lib/gcp-auth", async (importOriginal) => ({ ...(await importOriginal()), getVertexAccessToken: … }))`. That closes the whole class for **every** export of that module, not just this one, and it would have prevented the r2 instance too.

### FINDING 2 — the calibration log, the commit's stated purpose, is untested

**P3 survives** (the log never fires) and **P4 survives** (its key and payload change to something useless). Nothing asserts that a mint logs, or what it logs.

That matters more than a usual missing test, because this log is not a debug aid — it is the **entire mechanism** by which `PROVISIONAL` becomes calibrated. If it silently stops emitting, or the key drifts, nothing fails, no one notices, and the calibration simply never happens; the 10 s guess then stays a guess indefinitely while appearing to be on its way to being measured. One assertion in `gcp-auth-abort.test.ts` — which already drives the real module with a fake `fetch` — closes it.

### FINDING 3 — "one budget, not two" is itself unpinned

**P7 survives:** changing `timeoutMs ?? MINT_TIMEOUT_MS` back to `timeoutMs ?? 30_000` leaves the suite green. The precise regression this commit exists to prevent — a second uncoordinated literal for the same operation — is not caught. One test that calls the real `getVertexAccessToken()` with no `timeoutMs` and asserts the timer's budget would pin it.

### FINDING 4 — the sibling `clearTimeout` was left behind

**P2 survives:** `lib/llm/gemini.ts:89` has its own structurally identical `clearTimeout(tid)`, and removing it is not caught. The commit closed the instance I happened to name in round 4 and not its twin in the file it was already editing. Same class, same one-line fix.

### The calibration data is not yet fit for the decision it is collected for

Not a defect in what was written — an observation about what it will yield. The log records **elapsed time without outcome**, so one number stream mixes three populations:

| outcome | contribution |
|---|---|
| success at ~400 ms | the signal actually wanted |
| HTTP 401 at ~30 ms | pulls the distribution down; not a real mint |
| abort at 10 000 ms | the cap, indistinguishable from a hypothetical 10 s success |

The constant is a **timeout**, so what informs it is the distribution of *successful* mint latencies plus a *count* of aborts. The builder's own comment argues an abort near the cap "is itself useful signal about whether the cap is right" — which is true, and is exactly the argument for labelling it, since that signal is only usable if it can be separated. One word alongside the number (`ok` / `fail` / `abort`) makes the data answer the question it is being gathered for. Cheap now, and not recoverable later from numbers already logged.

### P5 — near-equivalent, no action

`mintStart = Date.now()` → `mintStart = now` survives. `now` is captured a few statements earlier, before the cache check, so on a non-cached call the two differ only by the RSA signing time. Worth noting that the mutant arguably measures the *documented* thing more closely — the comment says the budget covers "RSA-sign plus the fetch" — but the difference is microseconds and unobservable. No test, no change.

## Jev (V's standing rule) — after my read and mutations; neutral context

Task, diff and neutral context; none of my findings. Scores **5.4–7.5** — the lowest on this branch across four rounds, which is itself the signal, since the source changes are small and sound.

- **testQuality 5.4, its top priority** ("tests are coupled to implementation details or excessive mocking") → **CONFIRMED, and it is FINDINGS 1–4 together.** Jev named no file; the mock at `:40`, the un-pinned constant and the three uncovered behaviours are mine.
- **observability 5.6** ("operational signals lack the context needed to act on them") → **CONFIRMED, and it is the calibration-fitness point above**, which I had written before seeing this score. A bare elapsed number without an outcome is precisely a signal lacking the context needed to act on it.
- **correctness 6.0** ("relies on an unsafe or incorrect assumption") → **CONFIRMED in substance**: the assumption that the mock's constant tracks the source's.
- **performance 5.7** ("memory, network, database or filesystem use is disproportionate") → **REJECTED**: the log is one line per non-cached mint, and the token caches for about an hour, so it is at most a handful per instance per hour.
- **security 6.5** → **REJECTED on inspection**: the log carries a bare integer under a fixed key — no token, no endpoint, no identity.

## Gate

- **Mine:** 8 mutations through the Yoga fast runner, 0 runner errors, worktree verified clean at `1686171` afterwards.
- **The builder's:** not quoted in the commit message beyond the change itself; I did not re-run the full suite for a diff of this size.

**Verdict: PASS-WITH-FIXES.** Both round-4 items are genuinely done in the source, and the `PROVISIONAL` framing with a calibration path is the right answer to my note rather than a defence of the number. What is missing is protection: the constant lost the pin it had at r4 to a mock added in the same commit, and the log, the single-budget property and the sibling timer are each one assertion away from being real. Nothing here is a merge blocker; all four are small, and the `importOriginal` fix is worth more than the sum of them because it closes the class.
