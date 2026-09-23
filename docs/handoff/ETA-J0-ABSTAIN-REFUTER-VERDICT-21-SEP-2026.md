# ETA — J0 abstain. REFUTER VERDICT. 21 Sep 2026

`vinay/j0-abstain` @ **`23db224`** (builder split-speaker), base `45eedda`, 3 files, no migration. Refuted from my own detached worktrees `/tmp/refute-j0`, `/tmp/refute-j0-mut`, control at `/tmp/refute-base`; the builder's worktree was never written to, nothing pushed. The ledger cites `59395f3`; HEAD has since advanced by one commit (the empty-`{}` rule and the vote record), and I took HEAD as ordered.

## PASS — with two test-coverage findings, neither a defect in the code

All four rule claims hold, and the dry run reproduces **exactly** from live data.

**Mutations: 15 of 17 killed.** Every claim in the order is fully defended: absent abstains (N1-N3 red), the ≥2-present condition (N4 `>=1` and N5 `>=3` both red), a present non-English signal vetoes (N6-N9 red), an empty `{}` abstains (N10-N11 red), a present-but-malformed signal vetoes (N12 red), votes ride in the result (N14-N16 red).

**Claim 6 — the dry run — reproduced from live data, not taken on trust.** Read-only over the 5 fixture room-days (`docs/handoff/scratch/ro_query.py`, `BEGIN READ ONLY`, language labels and booleans only, no transcript text): 139 windows, 40 with a run, 39 with `transcript_original`, 0 with `transcript_english`. Applying the old three-way rule and the new majority-of-present rule to the same rows:

| | windows | with a run | native_en OLD → NEW |
|---|---|---|---|
| all fixtures | 139 | 40 | **3 → 13** |
| noise room-days | 38 | 10 | **0 → 10** |
| speech room-days | 101 | 30 | **3 → 3** |

All ten noise windows vote `full=english,sarvam=english,mix=absent` — identical to the builder's ledger line. The order's "3/29" for the speech class counts windows *with text*; there are **30** with a run, and the extra one is the window in G1 below.

**Claim 5 — not persisted — verified three ways:** no migration in the diff (0 files under `db/`); live `jev_window_text` has columns `window_id, room_day_id, english, source, char_count, model, error, input_chars, latency_ms, created_at` and nothing vote-shaped; and the tally is a `Record<string, number>` of vote names only, bounded at 27 combinations, carried in `progress`/`doneWith` (`lib/jobs/kinds/jev-english.ts:129,168,206`). No overloading of `model` or `error`, as ruled.

### G1 — the `native_en` text guard is untested, and a live window needs it today

`lib/jev/english.ts` `classifyWindow`: `if (isNativeEnglish(input.metrics) && nonEmpty(input.transcript_original))`. Dropping the `nonEmpty` half (**N13**) leaves the suite green.

It is not an unobservable guard. With it removed I measured the mutant directly:

- `transcript_original = null` → **`TypeError: Cannot read properties of null (reading 'trim')`**, which fails the whole room-day's J0 job;
- `transcript_original = ""` or `"   "` → a row with `source: "native_en"`, `english: ""`, `char_count: 0` — a window recorded as "already English, nothing to translate" while holding no text, the same "empty reads as done" defect the file's own header exists to prevent.

**Failure scenario, with the live input that reaches it:** window `bw_wwq9p6eb_1789821900000_primary` (room-day `rd_jqj96amk`, speech class) votes `full=english,sarvam=english,mix=english` — all three signals English — and has **no `transcript_original`**. Today the guard routes it to `emptyRow` and it is recorded `empty`, correctly. One guard, no test, and the input already exists in production. Fleet-wide the exposure is larger: the ledger records 179 room windows with a run against 150 with text.

**Fix:** one test — native-English metrics with `transcript_original` null and `""`, asserting `needsTranslation` / `empty`, never `native_en`.

### G2 — the vote tally's counting is unverified

**N17** (`v[k] = (v[k] ?? 0) + 1` → `v[k] = 1`) survives. The only test of the tally uses two windows with two *different* vote records, so counts of 1 and 1 pass either way. Nothing asserts that two windows sharing a vote record produce a count of 2 — and the headline dry-run claim ("`mix=absent` ×10") is exactly such a count. **Fix:** a third window duplicating an existing vote record, asserting `2`.

### G3 — comment contradicts code and test (minor)

`voteFull` and `voteSarvam` are documented "absent when the key is missing **or not a string**", but the code returns `"other"` for a non-string, and the test *a present-but-malformed signal is a disagreement, not an abstention* locks that in. The behaviour is the conservative one and should stay; the comment is wrong.

### Observation — the empty-`{}` rule changes nothing on this data

V's second afternoon ruling is implemented and tested, but **0 of the 40 windows with a run carry an empty mix**. The entire 3 → 13 gain comes from the *absent*-mix rule (the 10 noise windows). Correct to build, and forward-looking; it should not be cited as part of the measured improvement.

### Gate, my run

`typecheck` exit 0. `npm test`: `Tests 1 failed | 3261 passed | 1 skipped (3263)` in 221 s — the failure is `tests/unit/e31b-atomicity.test.ts > R58`, the same PIN-limiter assertion that failed on `vinay/speech-gate`. **Control:** base `45eedda` passed it 2 of 2 in isolation; this branch failed it 1 of 5 in isolation and passed 4 of 5. The diff touches only `lib/jev/english.ts`, `lib/jobs/kinds/jev-english.ts` and their test, none of which is reachable from a PIN rate limiter. **Flaky, not branch-caused** — and this corrects my own earlier ledger line, which said it passes in isolation; it does not always. `build` and `check:silent` results appended to the evidence file.

**Verdict: PASS.** The rule is right, the dry run is real, nothing is persisted. G1 and G2 are missing tests, not wrong code; G3 is a comment. None blocks the merge — but G1 guards a path a live window reaches today, so it is worth the one test before this goes near the overnight run.
