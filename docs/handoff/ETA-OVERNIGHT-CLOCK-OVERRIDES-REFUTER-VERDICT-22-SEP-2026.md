# ETA — overnight clock overrides. REFUTER VERDICT. 22 Sep 2026

`vinay/overnight-translate` **`b5eeda6` → `c3f20dc`** (builder scribe3): `9c55db8` open-early + `c3f20dc` allow-daytime. `lib/overnight-translate/hours.ts` is the **only source file changed**; the rest of the range is tests. Own detached worktrees `/tmp/refute-oe` and `/tmp/refute-oe-mut`; builder's worktree never written to, nothing pushed, the driver never started.

`b5eeda6` (the Q5/Q6 statement-text assertions) is in my path but is Fable's to check; I did not refute it, and it is green in my run.

## PASS — one finding, one noted divergence

**Mutations: 8 of 9 killed; the 9th hangs rather than fails** (below). Gate fully green: `typecheck` 0, **`Test Files 152 passed (152)`, `Tests 3521 passed | 1 skipped (3522)`**, 220 s, `build ✓ 9.2s`.

### The invariants hold

- **The 07:10 stop does not move under open-early.** C9 (swap `STOP_SUBMIT_MIN` for `CLOSED_END_MIN`) dies. Between 07:10 and 19:00 the override does nothing.
- **Open-early moves the start for `isClosed`/`closedHoursOver` too**, so the driver does not walk away from its first job at 19:01. C6 (override has no effect) and C7 (override always on) both die, as does C8 (`msUntilMaySubmit` waiting on the wrong start).
- **Allow-daytime lifts the clock and nothing else.** C4 (`isClosed` returns false) dies. `gate.ts` is **byte-identical** and is still called before every submit (`driver.ts:162`, `:194`), so the pressure/disk brake remains fully in force — which is the entire safety argument for this override, and it checks out.
- **Strict `"1"` parsing** on both flags: C1 and C2 (accept any truthy) die.
- **Every call site inherits the overrides.** All driver call sites pass only `nowMs`, so both flags reach `maySubmit`, `isClosed`, `msUntilMaySubmit` and `closedHoursOver` through the default parameters — no site hardcodes `false` or bypasses them. Defaults are evaluated per call, so nothing is captured at module load.

### C5 — killed by hang, not by failure (mutant-only)

Making `maySubmit` return `false` under allow-daytime does not redden the suite: it **spins**. `driver.ts:152-156` waits, sleeps and re-checks, and when `nightBegun` is false that loop has no upper bound — it relies on the clock opening, which in production it always does, and under allow-daytime `maySubmit` is unconditionally true. So the real code cannot reach it. I record it as killed-by-hang rather than claiming a clean kill: a CI would time out rather than report a failure. Verified by bounding one run at 90 s — vitest produced no result at all.

### FINDING — an override-driven run is not auditable from its own log

`ETA_OVERNIGHT_OPEN_EARLY` and `ETA_OVERNIGHT_ALLOW_DAYTIME` appear **nowhere outside `hours.ts` and its tests** — not in `main.ts`, not in `scripts/overnight-translate.ts`, not in any doc. `night_start` (`driver.ts:109`) logs `mode`, `limit` and the selector summary, and **not** which overrides were in force.

**Failure scenario:** a night runs with `ALLOW_DAYTIME=1`, something contends with live clinic recording, and the run's own log cannot answer whether the clock was lifted — that fact exists only in the launching shell's environment, which is gone. Every other decision this driver makes is logged, including each gate refusal with its reason; this one is not. The flags are read via `process.env` defaults inside `hours.ts`, which is exactly why `main.ts` never sees them to log them.

**Fix:** two fields on the existing `night_start` line. Not a blocker — it changes no behaviour — but for a per-run override of a safety clock it is the cheapest thing that makes the night explainable afterwards.

### Noted divergence — strict `"1"` vs the repo's `parseFlag`

`lib/flags.ts` `parseFlag` accepts `1|true|yes|on`, and **throws** `FlagValueError` on anything else — "Refusing to guess." These two flags instead accept only the literal `"1"` and read everything else as off. The builder states this in the comment, so it is a decision, not an oversight, and the direction is **safe**: `ALLOW_DAYTIME=true` leaves the clock enforced.

It compounds with the finding above, though: a typo'd flag is silently off **and** the log does not say which overrides applied, so "I set allow-daytime and it behaved as though I hadn't" is not diagnosable from the artefacts. Fixing the logging removes most of the sting.

## Jev (V's standing rule) — run after my own read, rerun and mutations

Scores clustered **6.2–7.0**, every issue `low` severity, confidence **0.09–0.45**, and the summaries were generic — Jev named no specific defect. Two dimensions were worth chasing:

- **documentation, 6.2 — its lowest** ("required configuration or operational use is insufficiently documented"). **Chased and CONFIRMED**, and it is the FINDING above: the overrides are undocumented outside the module *and* absent from the run log. Jev pointed at the area; the auditability argument and the failure scenario are mine.
- **consistency, 6.8** ("diverges from an established repository pattern without clear benefit"). **CONFIRMED as real** — it is the `parseFlag` divergence — but I **reject the "without clear benefit" framing**: the benefit is stated in the comment and the failure direction is safe. Recorded as a noted divergence, not a defect.
- **security (6.6, its top priority), correctness (7.0, confidence 0.15), reliability and testQuality (6.7)** — **rejected as non-actionable**: no issue was named, and I have stronger direct evidence. The security-adjacent question that does matter — what brake survives allow-daytime — I answered by verifying `gate.ts` is unchanged and still consulted before every submit. The reliability-adjacent one is C5, which I had already found by reading.

**Verdict: PASS.** Both overrides do what they claim and nothing more; the 07:10 stop, the per-submit pressure/disk gate and the timezone-free arithmetic are all intact under them. The one finding is a missing log line, not a behaviour.

---

**Correction to the Jev section (added after the fact).** My `repositoryContext` for that call named the `parseFlag` divergence and listed my mutation results, so Jev's **consistency 6.8** was an **echo of what I told it, not independent corroboration** — the divergence stands on my own read of `lib/flags.ts`, not on Jev. The **documentation 6.2** lead *was* independent (I gave it nothing about logging or auditability), so the FINDING it pointed toward stands as stated. Nothing in the verdict changes; only the weight of the Jev citations does.
