# Matcher Fixes Stage 2b — dose-gate feasibility MEASUREMENT (HARD HALT)

**Date:** 23 July 2026 · **Engine:** `opd-note-audit/0.81.12` (Stage 2a shipped-ready, `e144b62`, push held)
**Status:** MEASURE-FIRST per V's kickoff. **No dedup was coded** — the measurement decides whether a dose gate is even viable, and it is not. Read-only; nothing written. **HALT.**

> **Verdict: dose-gating is not viable. It catches 0 of the 5 motivating antidiabetic cases (no ceiling exists for them) and the only 7 notes it *would* fire on already carry a `dose_ceiling_exceeded` penalty (100% double-count). Recommend: DROP the scoring dedup — the ~5 real duplications stay visible via the existing informational `duplicate_molecule`. A genuine antidiabetic-duplication check needs a curated clinical class list, not dose, and not an improvised rule.**

---

## 1. The two questions V mandated — answered over the full 7,163-note corpus

Method: replicate the rejected molecule-subset detection, and for every one of its 82 hits classify the dose situation (is the duplicated molecule ceiling-governed? is it over ceiling? does `dose_ceiling_exceeded` already fire?). Read-only.

### Q1 — Does a dose gate retain the motivating antidiabetic case? **NO — 0 / 5.**
| | n |
|---|---:|
| antidiabetic mono+FDC subset-duplications (the cases the fix was FOR) | **5** |
| …that a dose gate would catch | **0** |

**Root cause (decisive, structural):** `data/dose-limits.json` contains **10 molecules only** — paracetamol, ibuprofen, aceclofenac, diclofenac, naproxen, etoricoxib, mefenamic acid, caffeine, pseudoephedrine, phenylephrine. **Metformin — and every antidiabetic — has no ceiling entry**, so there is nothing for a dose gate to compare against. It is not that metformin 500+500 = 1000 mg sits under the ceiling (as anticipated in the kickoff); it is that **no ceiling exists**, so the gate can never fire. Dose is categorically the wrong discriminator for this class.

### Q2 — Does a dose-gated duplicate fire where `dose_ceiling_exceeded` already fires? **YES — 100%.**
| of the 82 subset-dups | n |
|---|---:|
| a dose gate would fire on (ceiling molecule, over ceiling) | **7** (all Aceclofenac) |
| …that ALSO already carry a `dose_ceiling_exceeded` finding | **7 / 7 (100%)** |

A dose-gated `duplicate_prescription` is, by construction, "fire when the duplicated molecule's aggregate exceeds its ceiling" — which is the *exact* definition of `dose_ceiling_exceeded`. It adds a second penalty for one clinical event and nothing else.

### Full dose breakdown of the 82
| bucket | n | dose gate |
|---|---:|---|
| no-ceiling molecule (metformin, finasteride, vitamin D3, clotrimazole, folic acid, PPIs, topicals…) | **39 (47.6%)** | never fires |
| ceiling molecule, **within** ceiling | **36 (43.9%)** | correctly silent → stays informational `duplicate_molecule` |
| ceiling molecule, **over** ceiling (all aceclofenac) | **7 (8.5%)** | fires — but 100% redundant with `dose_ceiling_exceeded` |

Top duplicated molecules: Paracetamol 31, Aceclofenac 12, Vitamin D3 5, Finasteride 3, Clotrimazole 3, Folic Acid 3, Sitagliptin+Metformin 3, … — the common "mono + FDC-containing-that-mono" pattern, overwhelmingly intentional or benign.

## 2. What this means

- **Dose-gating adds nothing and harms:** 0 of the intended (antidiabetic) catches, 7 pure double-penalties on aceclofenac notes already flagged. It fails both tests.
- **The ~5 antidiabetic duplications are real** (metformin from two sources = double oral-hypoglycaemic dosing, a genuine hypoglycaemia risk) — but they are **not separable from the 77 benign ones by any signal in the current data**: not by dose (no ceiling), not by molecule-set structure (identical subset shape to paracetamol+FDC), not by anything the enrichment exposes.

## 3. What WOULD separate intentional from unintentional (reported, not improvised — per V)

The discriminator is **clinical, not computational**: a curated list of molecule/therapeutic classes where mono + same-molecule-FDC co-prescription is **rarely intentional and carries real risk** — antidiabetics (hypoglycaemia), anticoagulants (bleeding), and similar narrow-therapeutic-index duplications. Paracetamol/NSAID/vitamin/topical duplication is common and usually deliberate; it should stay informational.

That list is a **pharmacist-curated data artifact**, sourced and reviewed the same way as `dose-limits.json` and the CDSCO seed — **not a heuristic to improvise here.** It is a separate PRD (seed + review + dry run), not a Stage 2b one-liner.

## 4. Recommendation (V decides)
- **DROP the scoring molecule-subset dedup** (V's dry-run option (d)). It cannot be made to work with dose, and the alternative (curated class list) is a distinct, data-sourced build. The ~5 real antidiabetic duplications remain **visible** via the existing informational `duplicate_molecule` roll-up — surfaced, not penalised — which is exactly dose-aggregation's deliberate posture for within-ceiling duplication.
- **If** a scoring antidiabetic-duplication check is wanted: open it as its own PRD with a pharmacist-reviewed "duplication-sensitive class" seed + a §6-style dry run. Do not bolt it onto the dose path.
- **Stage 2a (LASA delete) is unaffected** and shipped-ready (`e144b62`, held) — it does not depend on any dedup.

## 5. Provenance
- Read-only. No engine/data change for Stage 2b (dose-gating was measured, not built). Stage 2a commit `e144b62` unchanged; HEAD there.
- Harness: `scripts/corpus-eval/matcher-stage2b-dosegate.mjs` → `.corpus-eval/matcher-stage2/dosegate.json` (gitignored). Wrote nothing to any table.
- **HARD HALT.** Awaiting your call on §4 (drop the dedup, or open a curated-class PRD).
