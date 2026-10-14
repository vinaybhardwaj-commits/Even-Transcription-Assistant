# Signal-Type Collapse Fix — §6 DRY RUN under **DECISION S3** (measurement only)

**Date:** 22 Jul 2026 · **Engine:** `opd-note-audit/0.81.9` · **HEAD:** `0b27c94` (unchanged)
**Status:** READ-ONLY. Nothing written to any table; no engine bump; no `stampFindingIdentity`/data edit; no LLM call. **HARD HALT for V.**
**Harness:** `scripts/corpus-eval/signal-type-collapse-dryrun.mjs` → `.corpus-eval/signal-type-collapse/dryrun-s3-0818.json` (gitignored).

> **This supersedes the earlier "stop-penalising" numbers, which are VOID** — they described a build V ruled against. V's ruling is correct: the "double-counted" premise was false. Live measurement (orchestrator): of 53 notes with a mislabelled major-interaction finding, **only 4 also carry a properly-labelled `drug_interaction`; 49 have no other interaction signal at all** — so "stop penalising" would have *deleted* the safety penalty on 49 notes, not removed a duplicate.

## 0. Decision S3 (what this run models)

The 129 safety findings **re-home and KEEP penalising** under their true type; only the 351 muscle-relaxant documentation prompts leave scoring.

| Cluster | n | Under S3 | Scoring effect |
|---|---:|---|---|
| `Interaction (major): …` | 59 | → `drug_interaction`, **prescribing safety** | **keeps penalising** (score-neutral relabel) |
| `Daily dose exceeds ceiling: …` | 27 | → `dose_ceiling_exceeded`, **prescribing safety** | **keeps penalising** |
| `Duplicate prescription: …` | 43 | → `duplicate_prescription`, its proper domain | **keeps penalising** |
| `Muscle relaxant prescribed — …` | 351 | → `deterministic_completeness` (S1) | **leaves scoring** (documentation prompt) |

Mechanically the 129 already score in `prescribing_safety` at `low-value`/severity 1.0; re-homing the **label + tier** does not touch `domain`/`verdict`/`confidence`, so it is **score-neutral by construction**. The only scoring change is the removal of the muscle-relaxant appropriateness penalty. The dry run simulates exactly that and recomputes NQI through the engine's own `computeOpdScore`.

## 1. Method & faithfulness (unchanged — the method was sound)

Per note: reproduce the stored appr/presc sub-scores **and** the stored NQI from stored findings + stored domain scores; then remove only the muscle-relaxant finding and recompute. **0 mismatches across all 7,163 notes** (`baselineApprMiss/PrescMiss/NqiMiss = 0`). Frame: **stored `0.81.8` only** (7,163 notes, 78 doctors, `app_source=standalone`, `excluded_reason IS NULL`); family view in §7.

## 2. S3 guardrails — both PASS (this is the headline result)

| Guardrail | Requirement | Result |
|---|---|---|
| **129 retained** | all 129 stay in scoring | `retained129 = 129` ✓ |
| **No fall-through** | a note with a 129 finding & no muscle-relaxant must NOT move | `notes129NoMrMoved = **0**` ✓ |
| **Canary — triple-QT note `8e2e997d…`** | prescribing safety must NOT reach 100 | **presc 26 → 26**, NQI **63 → 63**, 3 interactions retained, `prescStaysPenalised = true` ✓ |

The canary is the decision's proof-of-life: the domperidone + fluconazole + ofloxacin torsades cluster **stays at 26/100 prescribing safety** and the note's NQI does not move. The re-home works; the safety signal is preserved.

## 3. §6.1 Per-doctor delta — 8 doctors move, all +1 mean, none down

| doctor_uid (deid) | notes | affected | old mean | new mean | Δ |
|---|---:|---:|---:|---:|---:|
| hXe94boack | 195 | 105 | 85 | 86 | +1 |
| QJPPFgQomM | 87 | 12 | 78 | 79 | +1 |
| c56a2cQNCS | 69 | 18 | 79 | 80 | +1 |
| Tbvyk1V5ij | 61 | 8 | 83 | 84 | +1 |
| osXJkk6P3M | 52 | 10 | 65 | 66 | +1 |
| 7rVmpeIBY6 | 27 | 12 | 68 | 69 | +1 |
| QZNaYTFUxd | 18 | 4 | 66 | 67 | +1 |
| b8uerqB7pA | 2 | 1 | 74 | 75 | +1 |

(Three doctors that moved in the void run — apU4veKLTp, 7XHjSUo9jV, uNYS9ajeKl — no longer move: their movement was purely from removing the 129, which S3 keeps.)

## 4. §6.2 Band migration — 33 notes up one band, none down

| Move | Notes |
|---|---:|
| B → A | 22 |
| C → B | 10 |
| D → C | 1 |
| **Total** | **33** |

(Was 80 under the void run; the 47 promotions that depended on removing a safety penalty correctly no longer occur.)

## 5. §6.3 Distribution before/after

| Metric | Before | After |
|---|---:|---:|
| NQI mean | 80.1 | 80.2 |
| NQI median | 81 | 81 |
| Appropriateness domain mean | 69.5 | 69.9 |
| Appropriateness domain median | 64 | 64 |

341 of 7,163 notes move (4.8%); all via the appropriateness domain (the muscle-relaxant removal). The NQI aggregate lift is smaller than the void run because prescribing safety no longer changes at all.

## 6. §6.4 Largest mover + the canary, walked by hand

**Largest mover — note `091ee52e…` · NQI 78 → 81 (+3) · band B → B.** One scoring finding: `Muscle relaxant prescribed — document the indication` (appropriateness, context-dependent, c 0.5). Penalty = 45 × 0.5 × 0.5 = 11.25 → appropriateness 89 → 100; headline +3 (0.20 weight, ¾ active weight → no PDQI). The largest NQI move in the whole corpus is now **+3** — the ceiling of removing a single soft appropriateness prompt.

**The canary — note `8e2e997d…` (the void run's +15 poster child) · NQI 63 → 63 (0).** Five scoring findings: the 3 major interactions (Domperidone+Pantoprazole / Ofloxacin+Ornidazole / Fluconazole — the QT cluster) **all stay**, prescribing safety **holds at 100 × 0.64³ = 26**; the 2 appropriateness findings stay. Nothing is removed (no muscle-relaxant present), so **the note does not move**. Under the void build this note jumped to 78 (100/100 prescribing safety); under S3 it is correctly unchanged. This is the difference between the rejected build and the approved one, in one note.

## 7. Why still "all up, none down" — and why that is NOT the suspicious case

V flagged: *"if everything still moves up, that's suspicious — check the 129 land in prescribing safety."* The result is up-or-flat with **0 down**, and that is correct here, proven two independent ways: (a) `notes129NoMrMoved = 0` — every note whose only removable-looking finding was a 129 kept its exact NQI; (b) the canary holds at 26/26. The reason there is no *downward* movement is structural: under S3 **no finding changes domain** — the muscle-relaxant simply leaves (a strict penalty removal → up), and the 129 stay exactly where they were. "Mixed/down" movement would require a cross-domain re-home; S3 has none. The suspicious signal V warned about would be a *large* all-up move (the void run's +15s); that is gone — the biggest move is now +3, and the canary is flat.

## 8. Family view (context, not the PRD frame)

Across the full engine family (0.81.3–0.81.9, 12,038 notes) the same S3 rule removes **579** muscle-relaxant findings, retains 129-equivalents, still up-or-flat, same +3 ceiling. Reported only to label the frame: **351 is the 0.81.8 population the PRD specifies; 579 is the family the doctor-facing mean is drawn from.**

## 9. Direction verdict, gate & provenance
- **Direction:** up-or-flat — 8/78 doctors +1, **0 down**; 341 notes up, **0 down**; 33 band promotions, **0 demotions**. Movement is small and bounded (max +3 NQI) and comes entirely from retiring the muscle-relaxant documentation prompt; **every safety penalty is preserved** (129 retained, canary green).
- **Green gate:** typecheck clean · architecture green · governance green · **test 1293/1293** (harness adds no tests).
- **Nothing written.** HEAD still `0b27c94`. No engine bump, no `stampFindingIdentity`/data edit, no table write, no LLM call.
- **HARD HALT.** Awaiting V's approval of these S3 numbers before the fix kickoff.
