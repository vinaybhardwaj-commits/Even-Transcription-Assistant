# ETA — J0 abstain, G1–G3 fixes. REFUTER RE-CHECK. 21 Sep 2026

`vinay/j0-abstain` **`23db224` → `70c2969`** (builder split-speaker), one commit, 2 files, +42/−2. Own detached worktrees `/tmp/refute-j0b` and `/tmp/refute-j0-mut`; the builder's worktree was never written to, nothing pushed. Re-checked only G1–G3, as ordered.

## ALL THREE FIXED — PASS

**Mutations: 17 of 17 killed** (was 15 of 17). Both survivors are dead and nothing regressed — I re-ran the whole original set, not just the two.

| finding | status | how I checked |
|---|---|---|
| **G1** the `native_en` text guard was untested | **FIXED** | N13 (drop `nonEmpty(transcript_original)`) now **RED**. |
| **G2** the vote tally's counting was unverified | **FIXED** | N17 (`v[k] = 1`) now **RED**. |
| **G3** comment contradicted code | **FIXED** | `lib/jev/english.ts:61-67, 74` now say absent means *missing or null*, and that a present-but-unreadable value votes `other` and vetoes. |

### G1 — covered at both levels, and not vacuously

Two tests, and they go past the brief:

- **Pure** (`classifyWindow`): all four empty shapes — `null`, `undefined`, `""`, `"   "` — each asserted to return `needsTranslation` with `original: null`, never `done`. The loop also proves it **does not throw**, which was the half of the order that depended on what the code did.
- **Job level**: a window with `ENGLISH_METRICS` and `transcript_original: null` is recorded `source: "empty", english: null, char_count: 0`, with `native_en: 0` and `QWEN.calls: 0`.

The guard against a vacuous test is there too: the same metrics **with** text are asserted to pass as `native_en`. So the test cannot go green by making everything fail.

Both fixtures carry **all three** signals English (`full_window_language: "english"`, `sarvam_language: "en"`, a mix of `{en:1}` / `{en:2,und:1}`), which is the shape of the live window the order named — `bw_wwq9p6eb_1789821900000_primary` in `rd_jqj96amk`, which votes `full=english,sarvam=english,mix=english` with no `transcript_original`. That window's production outcome is `empty`, terminal and honest, and the test now pins it.

**No code fix was needed** and none was made: the shipped `classifyWindow` already had the guard. The order's "fix the code if it throws" was conditional, and the condition did not hold — only the mutant throws.

### G2 — the count is now pinned

Three windows: two sharing `full=english,sarvam=english,mix=absent` and one at `mix=other`. The tally is asserted as `{"…mix=absent": 2, "…mix=other": 1}`, so `v[k] = 1` can no longer pass. This is the shape the headline dry-run figure takes (`mix=absent` ×10), which is what made it worth pinning.

### The decision rule is unchanged

`lib/jev/english.ts` changed **comments only** — I checked by filtering the diff to non-comment lines and it is empty. So the rule is byte-identical to `23db224`, and the live recompute in my first verdict carries over without re-querying: **139 fixture windows, 40 with a run, `native_en` 3 → 13, noise 0 → 10, speech 3 → 3**, and the empty-`{}` rule still has 0 instances in that data.

The conservative reading was kept, as ordered: a present-but-unreadable signal still votes `other` and vetoes (N12 still red).

## Gate, my run

`typecheck` exit 0. `npm test`: **`Test Files 144 passed (144)`, `Tests 3265 passed | 1 skipped (3266)`**, 161 s — **zero failures**, including `e31b-atomicity R58`. `build` `✓ Compiled successfully in 7.9s`. `check:silent` at the accepted 9, **0** in any `jev` file.

**Verdict: PASS.** G1, G2 and G3 are closed, the two mutations that survived my first pass are dead, the other fifteen stayed dead, and the rule itself did not move.
