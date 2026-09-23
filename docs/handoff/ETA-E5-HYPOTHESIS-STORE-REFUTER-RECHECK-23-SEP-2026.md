# ETA — E-5 hypothesis store, the vocabulary drift. REFUTER RE-CHECK. 23 Sep 2026

`vinay/encounter-hypothesis` **@ `d3378dc`** (builder lx), rebased twice on Fable's order (`39e6b1a` → `4f4ab32` → `d3378dc`, force-updated), base `3449562`. Re-check of the FAIL in `ETA-E5-HYPOTHESIS-STORE-REFUTER-VERDICT-23-SEP-2026.md`. Own detached worktree `/tmp/refute-e5f`; nothing pushed, no migration applied, no database touched. Mini kept out — every run on the Yoga fast runner.

**Base verified:** `c23f056`, the deployed commit, **is** an ancestor of `d3378dc`, so encounter-clock, segments-route and voice-centroid really are all upstream of it. The rebase is what it says.

## PASS-WITH-FIXES — all six parts delivered; the drift guard has one hole, and it is in the half nobody tests

### The ruling, item by item, read rather than taken from the commit message

| part | state |
|---|---|
| (1) `smooth.ts` exports one array, type derived | ✅ `CLOSED_BY` (5 values), `ClosedBy = (typeof CLOSED_BY)[number]`, plus an `isClosedBy` guard |
| (2) the store imports it, stops re-declaring | ✅ `lib/encounter-hypotheses.ts:28`; the hand-written union is gone and the interval type, validator and reader all answer to that one array |
| (3) 0114's CHECK admits all five | ✅ amended in place, on the condition Fable verified through the control plane |
| (4) the reader refuses, never coerces | ✅ throws at `:231`/`:234`, naming the offending value — **F8 confirms it**: replacing the throw with the old coercion dies |
| (5) a drift test comparing the SQL to the array | ✅ and it is good work — see below |
| (6) `match_source` derived, not retyped | ✅ `MATCH_SOURCES = [...VOICE_DOMAINS, "voice_print"]`, with its own CHECK |

### The drift guard is genuinely well built — and I tried hard to break it

`checkValues()` walks **balanced parentheses** rather than matching layout, compares **sets** so order is irrelevant, **throws** when the constraint or its `IN` list is absent so it cannot silently match nothing, and its parser is itself unit-tested. Mutation results, 8 run, 0 runner errors:

- **F2** — shrinking the real CHECK alone: **killed.** The baseline works.
- **F5** — a value in the CHECK the array lacks: **killed.** Both directions covered.
- **F4** — shrinking the array *and* the CHECK together, so the sets still agree: **killed**, by the `expect(CLOSED_BY).toHaveLength(5)` line. That is the guard against satisfying a comparison by shrinking both sides, and it earns its place.
- **F3** — a pure reformat (reordered, re-line-broken, same values): **survives**, as designed. This is the control for lx's own account of catching a layout-literal regex in their earlier draft; the formatting-immunity claim holds at this sha.
- **F6** — Fable's accepted coupling: adding a domain to `VOICE_DOMAINS` while leaving 0114's CHECK alone is **killed**, a build-time failure rather than a silent runtime refusal, exactly as ruled.

### FINDING — the drift parser is comment-blind, and the same file already knows better

**F1 survives.** `checkValues` locates the constraint with `sql.indexOf(\`CONSTRAINT ${constraint} CHECK\`)` — the **first textual occurrence** — and it is handed the file **raw**:

```
tests/unit/encounter-hypotheses.test.ts:75   const code = readFileSync("db/migrations/0114_…sql","utf8")
                                               .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
tests/unit/encounter-hypotheses.test.ts:260  const sql  = readFileSync("db/migrations/0114_…sql","utf8");
```

**One file, read twice, in the same test file — `:75` strips comments and `:260` does not — and the drift guard parses the unstripped one.** So a `--` comment that quotes the constraint is parsed as if it were the constraint. My mutation puts a plausible documentation comment above the real clause and shrinks the real CHECK to two values: the database would then refuse `tape_off`, `unjudged_gap` and `dead_mic` again — the original FAIL, restored — and **the drift test stays green**.

**Why this is not a contrived attack.** It needs no single reckless edit; it needs two ordinary ones, in either order and by different people:

1. Someone documents the constraint by quoting it in the header. **[CORRECTED 23 Sep — see the note below; this sentence originally claimed 0113 and 0115 do exactly that, and they do not.]**
2. Later, someone narrows the real CHECK.

After step 1 the guard is already blind; step 2 then passes unnoticed. The guard is strongest against the mistake made carelessly in one go, and weakest against the one made carefully in two.

**Fix — one line, and the idiom is already on line 75 of the same file:** feed `checkValues` the comment-stripped text. Worth adding the parser test that a commented-out constraint is *not* found, so the stripping is itself pinned rather than assumed.

### OBSERVATION — the third pair is guarded, but by the pattern lx just rejected

I asked whether deriving `MATCH_SOURCES` from `VOICE_DOMAINS` left the *other* SQL↔TS pair — `VOICE_DOMAINS` ↔ 0113's `voice_centroid_domain_chk` — unguarded. **F7 is killed, so there is no live gap.** But what kills it is:

```
tests/unit/voice-centroid.test.ts:63
expect(code).toMatch(/CHECK \(domain IN \('room_primary', 'phone', 'meet'\)\)/);
```

A **verbatim layout regex** — the exact pattern lx removed from their own test this round as "green but proves nothing". It never mentions `VOICE_DOMAINS`, so it does not compare the two sources at all; it would break on a harmless reformat of 0113, and it pins the values only by coincidence of spelling. So of the three pairs now in play, two are guarded by value-set comparison and the third by a regex that would not survive the same scrutiny. Not a blocker and not this branch's defect — `0113` is voice-centroid's file — but the new `checkValues` helper is exported and would serve it directly.

## Gate

- **Mine:** 8 mutations through the Yoga fast runner, 0 runner errors, worktree verified clean at `d3378dc` afterwards.
- **The builder's, quoted as theirs:** unit tests 29/29; Yoga `rc=0`, 173/173 files, 3,877 passed, build 14.3 s.

**On lx's two disclosures, marked by what I could check.** Their account of running my announced attack against their own work and finding a layout-literal regex is **consistent with but not corroborable from the shas I hold** — neither `4f4ab32` nor `d3378dc` contains a verbatim list assertion, so it was removed before either was pushed. F3 confirms the *outcome* (reformat-immunity holds); I did not witness the defect. Recorded as their report rather than as a finding of mine. Their rc=9 correction — `typecheck_tests_failed` diagnosed as theirs, because a plain `tsc --noEmit` does not cover `tsconfig.tests.json` — is the right side of the distinction scribe3's exit-code contract exists to draw.

## Jev (V's standing rule) — after my read and mutations; neutral context

Task, diff and neutral context; **none of my findings**, though the context did state that sibling tests strip comments. Scores **6.7–8.0**, all `low`.

- **correctness 6.7, its top priority** ("the implementation appears to rely on an unsafe or incorrect assumption") → **CONFIRMED, and it is the FINDING**: the parser assumes the first textual occurrence of the constraint name is the constraint. Jev named no specifics; the raw-vs-stripped split and the two-step failure path are mine.
- **consistency 7.2** ("related parts of the change follow inconsistent conventions") → **CONFIRMED, same root, and it is the sharpest way to say it**: two reads of one file, one stripped and one not, twenty lines apart.
- **testQuality 7.1** ("tests coupled to implementation details") → **partly CONFIRMED**, but pointed at the wrong file: it is `voice-centroid.test.ts:63`'s verbatim regex, not this branch's drift test, which is deliberately layout-independent.
- **duplication 7.9 / changeability 7.7** ("a brittle dependency chain amplifies local changes") → **REJECTED as framed**: that chain is Fable's accepted coupling, and breaking the build is its purpose.
- **compatibility 7.2** ("appears to break an existing contract") → **CONFIRMED but intended**: `closed_by` widening two values to five and the reader now throwing are both the point.

**Verdict: PASS-WITH-FIXES.** The FAIL is closed — the store answers to one array, the CHECK admits all five, the reader refuses rather than invents, and the coupling Fable accepted does what it was accepted for. The drift test that exists so this cannot recur can still be blinded by a comment, which is one line to fix with an idiom already twenty lines above it.


---

# CORRECTION — my "house style" evidence was wrong, 23 Sep

lx checked a claim of mine and it does not hold. I wrote that the two-step path to F1 was likely because **"`0113` and `0115` both quote their own CHECK clauses in header comments … It is the house style."** That is false, and lx found it by trying to write a test asserting it and watching the test fail.

Verified myself after being told:

- **No migration in this repo quotes a constraint in the parseable `CONSTRAINT <name> CHECK (` form inside a comment** — not 0113, not 0114, not 0115, and none of the rest.
- Two migrations, `0060_run_encounter_nullable` and `0101_bench_window_silence`, contain the *word* CHECK inside a comment, but both are prose ("subject_type's default and CHECK (0058)"), not a quoted clause, and neither would satisfy the parser's `indexOf`.

**What I did wrong:** I had verified that 0113's header mentions the *column name* `retired_by` — which is true, and is why the sibling test's comment-stripping is load-bearing — and I generalised that into "quotes its CHECK clause". Two different things. The conflation made a real but speculative precondition sound like an established habit.

**What survives, and what does not.** The **hole was real** and is not in question: my mutation demonstrated it against the actual 0114, and lx reproduced it before and after their fix. What does not survive is my **weighting** of it. The two-step path requires someone to begin a habit this repo does not currently have, so F1 was a genuine latent hole worth fixing, not a near-miss waiting to happen. The finding stands; my argument that it was likely does not.

lx could have left the overstatement standing — it flattered their fix — and instead removed a test rather than assert something untrue, and told me. That is the behaviour that makes a correction possible at all, and it is worth more to this programme than the finding was.
