# Matcher Fixes Stage 2 — §2.4 DRY RUN (HARD HALT)

**Date:** 23 July 2026 · **Engine under test:** `opd-note-audit/0.81.12` (working tree, **uncommitted**) · **HEAD:** `cee67d7` (Stage 1)
**Status:** Stage 2 code implemented in the working tree; dry run measured; **HALT for V.** Nothing committed, nothing pushed.

> **The dry run did its job: the dedup half of Stage 2, as specified, has a 16× blast radius and moves scores net-DOWN. Do not ship it as coded. The LASA delete is clean and should ship.**

---

## 1. Stage 1 (form plumbing) — shipped-ready, committed & held

`cee67d7` — engine 0.81.11, score-invariant, gate 1301/1301. `max_nqi_delta = 0` proven three ways (exhaustive static scan: zero read sites; permanent unit invariance test; corpus isolation over 500 real cases, 304 with `form` populated, 0 finding-set mismatches). `dosageForm` distribution over the formulary: tablet 42.4%, injection 20.7%, topical 9.2%, other 8.9%, capsule 8.3%, syrup 7.0%, drops 1.8%, inhaler 1.7% (all 2,174 rows parsed; "other" = powders/vaccines/sprays/pure-volumes). Held for your push approval.

## 2. Stage 2 dry run — the five §2.4 artefacts (clean 0.81.11 → 0.81.12, isolated from the 0.81.10 change)

Method: real engine per affected note via `auditOpdNote({reuse})`; the 0.81.11 baseline reconstructed by reverting **only** the prescribing-safety findings (re-add stored LASA, drop the new subset-dups). Recombination validated: **`sanityFails = 0`** (my reconstructed headline equals the real scorecard headline on all 151 affected notes).

### §2.4.5 Net finding count — **NOT −88 / +5 as estimated**
| | count | notes |
|---|---:|---:|
| `lasa_pair` deleted | **−88** | 87 |
| new molecule-subset `duplicate_prescription` | **+82** | 82 |

The subset rule fires **82 times, ~16× the kickoff's +5 estimate** (which was based only on the LASA overlap). Corpus-wide scan of all 7,163 cases.

### §2.4.1 Per-doctor NQI delta — mixed, net-DOWN
- **13 doctors up · 26 doctors down** (of 78). All moves are small in mean terms (max |Δ| ≈ 0.5) because the affected notes dilute across each doctor's volume.
- Ups are LASA-removal doctors; downs are subset-dup doctors. The split is clean (see §3).

### §2.4.2 Band migration — demotions dominate
| move | n | | move | n |
|---|---:|---|---|---:|
| B → C | 18 | | B → A | 5 |
| A → B | 5 | | C → B | 4 |
| C → D | 2 | | | |
| **demotions** | **25** | | **promotions** | **9** |

### §2.4.3 Distribution
Aggregate NQI shift **−0.025** per note (net slightly negative). Median unchanged (151/7,163 = 2.1% of notes move). All movement is in the prescribing-safety domain.

### §2.4.4 Largest mover in each direction, walked by hand
- **Biggest UP — `JpWae68v` · 63 → 65 (+2)**: `lostLasa=1, gainedDup=0`. Deleting one LASA finding (context-dependent, conf 0.45) lifts prescribing-safety 63 → 70; headline +2. Clean, correct — a spurious LASA penalty removed.
- **Biggest DOWN — `2qPT7IYO` · 93 → 85 (−8)**: `lostLasa=0, gainedDup=1`. An otherwise-clean prescription (prescribing-safety **100**) gains ONE subset-dup (low-value, conf 0.7 → penalty 31.5) → prescribing-safety **100 → 69**, headline −8. **Every down-mover follows this exact shape: `pOld=100 → pNew=69` on a single new duplication.**

## 3. The finding — the subset-dedup over-fires and conflicts with an existing check

**The +82 are paracetamol-dominated common combinations, not double-dosing errors.** Example molecules: **Paracetamol ×7**, Aceclofenac ×3, Vitamin D3 ×2, Thiocolchicoside, Clotrimazole, Ciprofloxacin, Cilnidipine, Finasteride, Sitagliptin+Metformin. These are the ubiquitous Indian "mono + FDC-containing-that-mono" pattern (paracetamol + an aceclofenac+paracetamol combo, etc.) — frequently intentional.

**Two problems, both structural, not tuning:**
1. **It duplicates the existing `duplicate_molecule` check.** Dose-aggregation ALREADY detects "same molecule in N products" (51 live findings) and **deliberately makes it informational when within the dose ceiling** — a within-ceiling duplication is worth awareness, not a penalty. My subset rule re-flags the same population as **scoring** (low-value 0.7), directly contradicting that design decision. Paracetamol is the sharpest case: dose-aggregation already governs paracetamol totals via `dose_ceiling_exceeded`; a within-ceiling paracetamol duplication is intentionally non-scoring.
2. **It penalises clean prescriptions hard.** 64 notes with a spotless prescribing-safety score (100) drop to 69 (−7/−8 NQI, band demotion) on a single common combination. That is the opposite of the kickoff's "removes 5 false labels, mostly up."

**The two halves of Stage 2 separate cleanly:**
- **LASA delete** → ~69 notes up (+1/+2), 0 down. Clean, matches the audit's finding. **Ship it.**
- **Subset dedup** → ~70 notes down (up to −8), 25 band demotions. **Do not ship as coded.**

## 4. Regression tests — all three pass (in the working tree, gate 1303/1303)
- ✅ Guideline-recommended **vaccine co-administration produces NO finding** (the canary — we must never re-penalise it).
- ✅ **Mono+FDC (metformin / glimepiride+metformin) → a `duplicate_prescription`** finding (the intended real signal is detectable).
- ✅ **Yesterday's canary holds** — three co-prescribed major interactions score prescribing-safety **26/100** (`8e2e997d` shape).

## 5. Recommended fix sequence (revised by the dry run — V decides)
1. **Ship the LASA delete now** (with Stage 1). It is clean, mostly-up, and resolves the worst live scoring defect. Score-affecting but strictly corrective; the dry-run + canary evidence above covers it.
2. **Re-scope the molecule-subset dedup before it ships** — this is the decision the dry run surfaces:
   - **(a) Gate on dose:** only fire `duplicate_prescription` when the aggregated molecule dose **exceeds the ceiling** — i.e., defer to dose-aggregation, and let within-ceiling duplication stay the existing informational `duplicate_molecule`. This aligns the two checks instead of contradicting them.
   - **(b) Exclude commonly-co-prescribed molecules** (paracetamol, caffeine, low-dose vitamins) from the scoring subset rule.
   - **(c) Narrow to the intended pattern** (the ~5 antidiabetic mono+FDC) — but note those are already surfaced informationally by `duplicate_molecule`, so "adding a penalty" is itself the policy question.
   - **(d) Ship LASA-delete only, drop the dedup** — the ~5 real duplications LASA was catching remain visible via the existing informational `duplicate_molecule`; no new penalty.

**My recommendation:** ship LASA-delete (option 1) + rework the dedup as **(a) dose-gated** — it makes the two duplication checks consistent (informational within ceiling, scoring over ceiling) and removes the 82→~handful over-fire. Re-dry-run the reworked dedup before it ships.

## 6. Provenance
- Stage 2 code is in the **working tree, uncommitted**. HEAD unchanged at `cee67d7` (Stage 1). No push.
- Dry-run harness + results: `scripts/corpus-eval/matcher-stage2-dryrun.mjs` → `.corpus-eval/matcher-stage2/dryrun.json` (gitignored). Read-only; wrote nothing to any table.
- Gate on the working tree: typecheck + architecture + governance + **test 1303/1303**.
- **HARD HALT.** Awaiting your call on §5 (ship LASA-delete; re-scope or drop the dedup) before anything commits or ships.
