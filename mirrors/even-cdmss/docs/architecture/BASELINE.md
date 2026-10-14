# Architecture Governance — baseline snapshot (the 6-month yardstick)

*Recorded at introduction, 13 Jul 2026 (Slice 1). Revisit ≈ 13 Jan 2027. Standing agreement:
if these numbers don't move, governance gets **simplified**, not expanded.*

## Starting point (objective, cheap to re-measure)

- **Boundary rules encoded:** 4 (import rules in `scripts/architecture-check.mjs`)
  + 5 clinical-semantics tests (`lib/__tests__/architecture-*.test.ts`).
- **Violations at introduction:** **1** — `lib/member-state/member-state.ts` value-imported
  `applyAsOfCut` from `lib/opd-longitudinal-core` (spine → advisory crossing). Fixed in
  Slice 1 Part A by relocating the pure function to `lib/as-of-core.ts`.
- **Standing violations after Part A:** **0** (all 4 rules green; teeth demo confirmed the
  checker fails loudly when the crossing is reintroduced).
- **tsc baseline at introduction:** 5 whole-repo errors, greened type-only in Part 0 so CI
  hard-gates `tsc --noEmit` from day one.
- **CI enforcement:** `.github/workflows/ci.yml` — the repo's first general gate
  (architecture:check + typecheck + full test suite, all hard, on every push/PR to main).

> **Quarantine resolution (13 Jul 2026, V ruling):** the 3 calculator quarantines shipped with
> Slice 1 are resolved — ABG Berlin P/F boundary fixed in the *implementation* (inclusive-high);
> Cockcroft-Gault and SIADH fixed in the *tests* (wrong fixtures). Suite runs 0-skipped.

## The two motivating incidents (the "before" examples)

1. **The `applyAsOfCut` smudge** — the longitudinal spine quietly took a value import from the
   advisory core. Harmless today (the function is pure), but exactly the class of coupling that
   ends with score logic inside the patient record. Rule 3 now fails the build on it.
2. **The scorecard-footer regression** — a "How the audit works" rebuild reintroduced the
   "posture / never a clinician scorecard" refrain the approved design had deliberately removed;
   it reached prod and needed a follow-up fix. Semantics test #5 (advisory never wears the
   scored-band visual language) is the same failure class made mechanical where it CAN be —
   copy-level regressions stay a human-review concern (see honesty notes below).

## Questions to re-ask at ~6 months

| Question | Instrumentable? | How |
|---|---|---|
| Have boundary violations gone down (or stayed 0)? | **Yes** | `architecture:check` history; count of CI failures on rules 1–4 (each one is a catch) |
| Has CI caught real crossings before review? | **Yes** | GitHub Actions: failed `ci` runs whose failing step is `architecture boundaries` |
| Have regression defects (shipped-then-reverted) gone down? | **Partly** | `git log` for revert/fix-of-fix commits touching guarded modules; imperfect proxy — count honestly, don't launder |
| Has review time gone down? | **No — qualitative** | V's judgement; no honest repo metric exists — do not fabricate one |
| Has onboarding gotten easier? | **No — qualitative** | Ask the next person who onboards; one line of their words beats an invented score |
| Did any rule produce false positives / friction? | **Yes** | count of legitimate changes that needed a rule amendment or an `import type` restructure |

## What this deliberately does NOT measure

Copy/tone regressions (incident 2's root), design-contract drift, and clinical correctness —
those stay human-reviewed. No metric is recorded for them because none can be measured honestly
from the repo today. If Slice 2+ adds one, it starts by recording ITS baseline here first.
