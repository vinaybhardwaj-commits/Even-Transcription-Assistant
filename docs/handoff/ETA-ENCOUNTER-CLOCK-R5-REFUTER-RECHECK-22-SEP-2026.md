# ETA — encounter clock round 5. REFUTER RE-CHECK. 22 Sep 2026

`vinay/encounter-clock` **@ `11de0b4`** (builder split-speaker), the round-5 commit on top of the E-4 smoother `55436c0`. Re-check of the three clock findings in `ETA-ENCOUNTER-CLOCK-REFUTER-22-SEP-2026.md`, as ruled in `weekA-2230b.md`. The E-4 smoother is not in scope here. Own detached worktree `/tmp/refute-clk5`; builder's worktree never written to, nothing pushed. Production reads were read-only and returned **level numbers and counts only**.

## PASS-WITH-FIXES — two of three fixed outright; the third is safe but does not achieve its purpose on real data

**Gate, on the Yoga runner (per the 22:50 standing change):** `Test Files 165 passed (165)`, `Tests 3709 passed | 1 skipped (3710)`, **0 failed**; `build ✓ Compiled successfully in 15.0s`; 604 s wall, 11.0 GB peak.

### 1. Quiet room + transcript text → unjudged — FIXED

`gateProbe` now returns `unjudged` / `halves_disagree` where it used to return `non_speech` / `text_on_quiet_audio`, exactly as recommended. The old reason code is gone from the `GateReason` union and has **no remaining reference** anywhere in `lib`, `app`, `scripts` or `tests`; nothing outside the module calls the gate (flag off).

### 3. Overlapping chunks → each stretch of clock time taken once — FIXED

`mapProbeToChunks` sweeps a single `reached` cursor: each stretch comes from the earliest-starting chunk that covers it (ties by `idx`), a later chunk contributes only new time, and `overlap_dropped_ms` is reported. Piece lengths now come from the probe's own sample grid, so contiguous pieces sum to the expected count exactly. I traced the contained, partial-overlap and gap cases by hand; the tests pin the production maximum (**82.6 s** overlap → mapped exactly 180 s, coverage 1, 50,000 ms dropped inside the probe), a wholly-contained chunk (contributes nothing), and the end-to-end extracted audio (`total_samples == expected_samples`). Gaps still lower coverage honestly.

### 2. The level half reads `peak` — SAFE, but INERT on the data that exists

**The safety argument holds.** `peak ≥ RMS`, so reading `peak` can only raise the active fraction: it can call a quiet room active (the probe is then fetched), never an active room quiet. Scales are never mixed within a probe, and `level_basis` is reported.

**The purpose does not hold.** The order asked for `peak` *"so the pre-selector works on real data"*. The floor it is compared against is `DEFAULT_ROOM_ENERGY_FLOOR = 0.00398` (≈ −48 dBFS) — an **RMS** floor, reused unchanged for peak values. Production `bench_level_sample`, read-only:

| | samples | below 0.00398 | min peak | median peak |
|---|---|---|---|---|
| all | 4,738 | **0** | 0.0428 | — |
| closed hours (21:00–06:59 IST, no consults) | 3,574 | **0** | 0.0436 | 0.0732 |
| clinic hours | 1,165 | **0** | 0.0428 | 0.0671 |

`avg` is populated on 0 rows; `zero_ratio` averages 0.000, so the dead-mic path never fires either. **The quietest peak ever recorded is eleven times the floor, and that includes the empty room at night.** With `ENERGY_ACTIVE_MIN = 0.05`, every 180 s probe reads `active`, `skip_quiet` can never fire, and every probe is still fetched and decoded — the same end state my original Finding 1 described, reached by a different route.

**The test does not show this, because its quiet case uses a value production never produces.** The "production-shaped rows" fixture has the right *fields* (`avg` null, `peak` and `zero_ratio` set), but its skip case uses **peak = 0.002** — 21× below the lowest real peak. Its typical case, peak 0.071 → `extract`, is almost exactly the real closed-hours median (0.0732): the builder's own fixture encodes that a typical room, empty or not, is never skipped.

**Scope caveat, stated plainly:** the production level log is **one room, one day** (22 Sep), all with `session_open = false`. Thin — but the gap is an order of magnitude, not a margin, so another room is unlikely to bring peaks down tenfold.

**Fix (Fable's call):** a peak-based "quiet" needs its **own floor**, measured on peak — for example from closed-hours peaks across several rooms and days, checked against frame-decoded probes — rather than the RMS floor. Until then the honest description is that the level half on production data does dead-mic detection only, and the pre-selector does not skip.

### Mutations — RUN on 23 Sep (see the addendum at the foot: 8 of 15 killed; 4 survivors are provable equivalent mutants, 2 are real gaps on Finding 2)

Per the ruling, mutations wait for scribe3's fast `yoga-test.sh` mode rather than spending ~70 minutes of the Yoga's CI lock. Not run on this re-check.

## Jev (V's standing rule) — after my read and rerun; neutral context

Task, source diff and neutral context (the floor value and the 5% rule, which are contract facts); none of my findings, and nothing about the fixture values or the production peak distribution. Scores **6.5–7.6**, all `low`.

- **testQuality 6.8** ("important changed behaviour lacks meaningful regression coverage") → **CONFIRMED independently**: it is the 0.002 fixture — the skip path is tested on a value that never occurs, and the real behaviour (never skip) is not represented.
- **documentation 6.5** ("a non-obvious decision lacks an explanation of why") → **CONFIRMED**: the comment argues the *direction* of reading peak is safe, but never says the RMS floor is the wrong scale for peak values — the non-obvious decision is undocumented.
- **correctness 7.3** ("an important edge case appears insufficiently handled") → **CONFIRMED in substance**: the floor/scale mismatch above.
- **compatibility 7.4** ("appears to break an existing contract") → **REJECTED**: the removed `text_on_quiet_audio` code has no consumer (flag off, no caller, no remaining reference).

**Verdict: PASS-WITH-FIXES.** Findings 1 and 3 are closed and well tested. Finding 2 is closed on safety and open on purpose: reading `peak` against an RMS floor makes every production probe `active`, empty rooms at night included, so the pre-selector still never skips.

---

# Addendum — mutations, 23 Sep (fast runner)

15 mutations against `11de0b4` through `yoga-test.sh --mutate`, 0 runner errors. **8 killed, 7 survived.** A raw 8/15 reads badly, so the survivors are separated below: **four are provably equivalent mutants** — unreachable code paths I can prove from the source, not gaps — **one is real and minor**, and **two are real gaps, both on Finding 2's half of the module.**

### Killed — findings 1 and 3 are pinned where it counts

All three reason-code mutants die (C1 quiet+text → `halves_disagree`, C2 `dead_mic`, C3 `no_energy_evidence`): the suite notices if an `unjudged` is quietly downgraded to a verdict, which was the whole point of finding 1. The `avg`-basis rule dies (C4: `every` → `some`). The pre-selector's `skip_quiet` mapping dies (C14). On the sweep, the fix itself dies — **C7** (`Math.max(lo, reached)` → `lo`, i.e. double-counting overlap), **C8** (`overlap_dropped_ms` stops being counted) and **C12** (the piece offset computed against the probe instead of the chunk — the subtle one that yields the right sample *count* from the wrong sample *range*). Finding 3's fix is genuinely covered.

### Four equivalent mutants — defensive code, not missing tests

Each is unobservable by construction; no test could kill them and none should be written.

- **C9** `reached = Math.max(reached, hi)` → `reached = hi`. At that line `hi > a = Math.max(lo, reached) ≥ reached` (the `if (hi <= a) continue` on the line above), so the `max` is always `hi`.
- **C13** `if (hi <= lo)` → `if (hi < lo)`. With `hi === lo`, `a = Math.max(lo, reached) ≥ lo = hi`, so the *second* guard `if (hi <= a) continue` catches it anyway.
- **C11** the `Math.min(1, …)` clamp on `coverage`. Pieces are disjoint (`a ≥ reached`, `reached` advances to `hi`) and lie inside `[probe.start, probe.end]`, and `toSample` is monotonic, so `mapped ≤ expected` always. The clamp can never bind.
- **C15** `Math.min(p.sample_end, pcm.length)` in the extractor. `Int16Array.prototype.subarray` clamps out-of-range indices itself, so a short decode yields the identical slice either way.

### C10 — real, minor, untested: the tie-break

`sort((a,b) => a.start_ms - b.start_ms || a.idx - b.idx)` → dropping the `|| a.idx - b.idx` survives. Two chunks sharing a `start_ms` and arriving out of `idx` order would then be taken in input order. Sample counts and coverage are unchanged; what changes is **which `chunk_idx`/`r2_key` the extract contract cites** for that stretch. Provenance in a contract meant to be reproducible, so worth one test, but not a correctness fault.

### C5 and C6 — two real gaps, and both sit on Finding 2

**C6 — `ENERGY_ACTIVE_MIN = 0.05` → `0.5` survives, and the reason is a self-referential test.**

```
tests/unit/encounter-clock-gate.test.ts:87-92
it(`active at exactly ${ENERGY_ACTIVE_MIN} of frames at or above the floor; quiet just below`, () => {
  const n = 100, k = Math.round(ENERGY_ACTIVE_MIN * n);
  …
  expect(energyHalf(mk(k)).state).toBe("active");
  expect(energyHalf(mk(k - 1)).state).toBe("quiet");
});
```

The fixture is **computed from the constant**, so the test moves with it: at `0.5` it builds 50 hot frames and still passes. It pins the *comparison* (`>=`, not `>`) and can never pin the *value*. That constant is the one that decides skip-versus-extract — the exact subject of Finding 2 — and no test in the suite holds it at 5%. A one-line fix: assert `ENERGY_ACTIVE_MIN` equals `0.05` outright, or hard-code `k = 5`.

**C5 — the scale-mixing guard is asserted on its label, not its values.** Changing `basis === "avg" ? s.avg : s.peak` to `fin(s.avg) ? s.avg : s.peak` survives. The test that exists for this —

```
it("scales are never mixed: if any sample lacks avg, every sample in the probe is read by peak", …)
  expect(r.level_basis).toBe("peak");
  expect(r.n).toBe(3);
```

— checks `level_basis` and `n`, both of which the mutant leaves untouched, while the *numbers* silently become a mix of one `peak` (0.5) and two `avg` (0.02). Since `peak ≥ RMS`, mixing inflates the median and can flip a quiet room to active or mask a dead mic. **Inert today** — 0 of 2,160 production rows carry `avg`, so every real probe is all-peak and cannot mix — which is the same shape as Finding 2 itself: the guard is right, and nothing proves it stays right. Assert the median or `active_frac`, not just the basis label.

### What this does not change

The verdict stands at **PASS-WITH-FIXES**. Findings 1 and 3 are closed *and* mutation-pinned. Finding 2 remains closed-on-safety and open-on-purpose, and the mutations sharpen it: not only does reading `peak` against an RMS floor make every production probe `active`, but the threshold that would have to change to fix it is not held by any test, and the scale discipline the fix relies on is asserted only by name.

**Not re-run:** Jev. The diff is unchanged from the one scored above, and the server's guidance is not to repeat an identical call; the mutation evidence here is independent of it.
