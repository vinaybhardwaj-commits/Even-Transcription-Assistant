# Deterministic Matcher Scoping Audit — Report

**Date:** 23 July 2026 · **Engine:** `opd-note-audit/0.81.10` · **HEAD:** `d098917` (unchanged) · **Gate:** 1299/1299
**Status:** AUDIT ONLY — read-only. No code/data/engine changes. Live counts over engines 0.81.8 + 0.81.9 + 0.81.10 (`app_source=standalone`, `excluded_reason IS NULL`). **HARD HALT** — V approves a fix sequence; fixes are separate kickoffs.

> **Method note on live counts:** stored rows pre-date the 0.81.10 relabel, so `signal_type` under-reports the checks that used to collapse into `low_value_care` (interaction-major, duplicate, dose-ceiling). All per-check counts below are by **subject prefix**, which is stable across the collapse — the honest live count of what each check actually emitted.

---

## 0. Headline

- **17 checks** audited across **9 files**. **2 load-bearing files were NOT in the §2 starting list** — `lib/formulary.ts` and `lib/formulary-match-core.ts`, the data-enrichment/matcher layer where **both the worst (semantic LASA) and the highest-leverage (structural form-drop) defects live.** Reviewing only the named emitter files would have missed both.
- **The LASA redundancy number (§4): 33% overlap / 67% unique — LASA is NOT largely redundant.** But the 67% "unique" content is dominated by clinically-legitimate co-prescription being penalised and by real duplication that belongs to a fixed dedup check; **none of the 88 are actual name confusables.** Evidence in §5; the (a)/(b)/(c) decision is teed up for V, not chosen.
- **One worst live scoring defect:** `lasa_pair`, 88 scoring findings, semantic + mechanical. It **cannot be fixed by tightening its comparison** — the data doesn't mean what the check claims.

---

## 1. Full per-check table (§3)

CLAIM = what the finding asserts · DATA = source + what it actually encodes · UNIT = comparison mechanic · live = subject-based count over 0.81.8/9/10.

| # | check / signal_type | CLAIM | DATA source + what it encodes | UNIT compared | route/form needed? available? | mismatch axis | live (findings/notes) | scoring? |
|---|---|---|---|---|---|---|---|---|
| 1 | **`lasa_pair`** | look-alike/sound-alike **name-confusion** risk | formulary `lasa` col — actually **same-class therapeutic alternatives** (1,752/2,174 rows; Minoxidil→Finasteride, Succinylcholine→Rocuronium) | **bidirectional substring** `nm.includes(la)‖la.includes(nm)` (core:560) | route needed (exclude topical+systemic); **unavailable** | **SEMANTIC** + mechanical | **88 / 87** | **YES** |
| 2 | **`drug_interaction`** | DDI between two co-prescribed drugs | 18 class-pair TAG_RULES + 14 curated molecule pairs (ddi-tags/ddi) | tag *firing* = clean **set membership**; tag *assignment* + curated leg = **unanchored `.includes`** (ddi.ts:40, ddi-tags:20; truncated keys `colist`,`thiopent`) | route used **post-match** (topical de-escalation only); form no | mechanical (substring in assign/curated) — **low measured live false-fire** | **348 / 321** | **YES** (major/contra → low-value) |
| 3 | **`dose_ceiling_exceeded`** | daily mg > adult ceiling | `dose-limits/1.1` (10 molecules, cited 0.81.9) | aggregate mg vs ceiling; molecule via `canonicalMolecule`; `medMolecules` splits `[+/,]` only | no (mg model) | mechanical-minor (multi-word molecule tokens) | **27 / 27** | **YES** |
| 4 | **`dose_ceiling_sos`** | may exceed ceiling if all SOS taken | same as #3 + SOS cap | same + SOS cap arithmetic | no | same-minor | **80 / 78** | **YES** |
| 5 | `duplicate_molecule` ("Same molecule in N products, within ceiling") | same molecule in ≥2 products, within ceiling | dose-aggregation | molecule equality via `canonicalMolecule` | no | **matching GAP** — misses metformin mono + FDC (see §5) | 51 / 49 | informational |
| 6 | **`duplicate_prescription`** | same generic on ≥2 lines | resolvedGeneric strings | **exact lowercased string equality** on `resolvedGeneric` | no | mechanical — exact-string misses **mono vs same-molecule FDC** | **43 / 43** | **YES** |
| 7 | `incomplete_dosing` | missing dose/freq/route/duration | note fields + name/form inference | field-presence + `resolveMedRoute` inference | route **inferred from name**, not formulary `form` | none — well-guarded (exemptions for cosmetic/nutraceutical/unresolved) | 740 / 563 | YES |
| 8 | `muscle_relaxant_indication` | document the indication | `MUSCLE_RELAXANT_MOLECULES` set | `medHasMoleculeFrom` (molecule membership) | no | none (0.81.10: now informational) | 352 stored (→ info fwd) | info @0.81.10 |
| 9 | `unverified_brand` | brand not formulary-resolvable | formulary miss | `resolveMed` → null | no | none (informational, our coverage limit) | 1,491 / 974 | info |
| 10 | `high_alert_medication` | ISMP high-alert present | formulary **`high_risk` bool** — **includes non-ISMP items** (glucosamine+KCl, oral MgSO4) | `m.highAlert` bool | route needed (oral vs IV MgSO4); **unavailable** | **SEMANTIC** (data ≠ ISMP) + mechanical (KCl substring) | 139 / 139 | info |
| 11 | `schedule_x` | Schedule X narcotic/psychotropic present | formulary `schedule_dc==='X'` | bool equality | no | **ZERO live findings** — check present, never fires (data gap or dead) | **0** | info |
| 12 | `off_formulary` | items outside the formulary | formulary miss classifier | count | no | none | 1,122 / 1,122 | info |
| 13 | `banned_fdc` | CDSCO-banned FDC | `cdsco-banned-fdc/0.0` — **0 entries (dormant)** | exact molecule-set equality (no subset/fuzzy) | route needed (cdsco-441 injection-scoped); unavailable | dormant — comparison is clean, awaits data | **0** | scoring (when populated) |
| 14 | `resp_xanthine` (→ `low_value_care`) | xanthine bronchodilator not indicated for acute URTI | `XANTHINE_MOLECULES` + URTI/chronic-resp context | molecule membership + anchored context regex + ICD guard | no | none — context-guarded | 41 / 41 | YES |
| 15 | `antihist_montelukast` (→ `low_value_care`) | montelukast+antihistamine not indicated for viral URTI | molecule sets + URTI guard | membership + context guard | no | none — context-guarded | 281 / 281 | YES |
| 16 | `decongestant_duration` (→ `low_value_care`) | nasal decongestant > 5 days (rebound) | `NASAL_DECONGESTANT_MOLECULES` + parsed duration | membership + duration regex | no | none | 25 / 25 | YES |
| 17 | `longitudinal_*` (repeat_test / med_recon / missed_followup / continuity / contradiction) | cross-visit continuity signals | longitudinal store | — | — | **dark** (`OPD_LONGITUDINAL_ENABLED` off) — 0 live | 0 | info |

---

## 2. Ranked defect list — by LIVE SCORING IMPACT

| rank | check | axis | live | scoring | remedy class |
|---|---|---|---:|---|---|
| **1** | **`lasa_pair`** | **SEMANTIC** (data = same-class alternatives, not confusables) + mechanical (bidirectional substring) | **88** | **YES** | **re-label / re-source / delete — V's call (§5).** Cannot be repaired by tightening the comparison; the claim and the data disagree at the source. |
| **2** | **`drug_interaction`** | mechanical (unanchored `.includes` in tag-assignment + curated leg; truncated keys) | **348** | **YES** | **tighten comparison** (word-boundary/exact on the curated leg + tag keywords). **Measured live false-fire appears low** — the tag-rule *firing* is clean set-membership; the risk is upstream in assignment. Sample before spending. |
| **3** | **`duplicate_prescription`** | mechanical (exact-string; misses mono vs same-molecule FDC) | **43** | **YES** | **broaden comparison to molecule-level.** Would also absorb the 5 antidiabetic mono+FDC pairs currently mislabelled by LASA. |
| **4** | `dose_ceiling_exceeded` / `dose_ceiling_sos` | mechanical-minor (`medMolecules` multi-word tokens) | 27 + 80 | YES | tighten `medMolecules` tokenisation. Low impact — the checks are cited and mostly sound. |
| **5** | `high_alert_medication` | **SEMANTIC** (`high_risk` ≠ ISMP list) + structural (oral vs IV) | 139 | **no (info)** | **re-source** `high_risk` to ISMP + **plumb `form`/route**. Visible-wrong (§11.2 glucosamine ×14, oral MgSO4 ×10) but **informational → zero scoring impact**, so ranked below scoring defects. |
| — | `schedule_x` | data/coverage (0 fires) | 0 | info | investigate: dead check or formulary `schedule_dc` never carries `X`. |

**Structural (form-drop) is cross-cutting, not a single row:** `data/formulary-2026.json` carries `form`, but the enrichment (`lib/formulary.ts:45-63`) and `FormularyMatch` (`formulary-match-core.ts:160-172`) drop it, so **no matcher can be form-aware.** This is the single highest-leverage fix — it unblocks form-awareness for `lasa_pair`, `duplicate_*`, `high_alert`, and `banned_fdc` (cdsco-441) simultaneously. It is enabling plumbing; each consumer then changes separately.

## 3. Clean list — checks confirmed correctly scoped

- **`incomplete_dosing`** — well-guarded; exemptions for cosmetic/nutraceutical/unresolved lines; route inferred from the drug name (not the dropped formulary `form`, but adequate).
- **`resp_xanthine`, `antihist_montelukast`, `decongestant_duration`** — molecule-set membership with anchored context guards (acute-URTI required, chronic-airways/ICD excluded). Correctly scoped.
- **`off_formulary`, `unverified_brand`** — informational coverage roll-ups; claim matches data.
- **`duplicate_molecule` (dose-aggregation)** — comparison is clean molecule-equality (one gap: misses mono+FDC, see §5), informational.
- **`banned_fdc`** — comparison is exact molecule-set equality with fail-safe-to-silence; correctly scoped, awaiting real data (route-scoping is the one open structural need).
- **The DDI tag-rule *firing* leg** — clean set-membership over a 18-tag universe; the defect is only in tag *assignment* and the curated leg.

## 4. The LASA redundancy measurement (§6c) — plainly

**Over the 87 notes carrying a `lasa_pair` finding (88 findings):**

| overlap test | result |
|---|---|
| same drug pair also caught by `duplicate_molecule` / `duplicate_prescription` | 15 / 88 (**17.0%**) |
| same drug pair also caught by `drug_interaction` (same-class → a DDI rule) | 20 / 88 (**22.7%**) |
| same drug pair caught by **any** of {dup_molecule, dup_prescription, DDI, LVC therapeutic_duplication} | **29 / 88 (33.0%)** |

**LASA is NOT largely redundant — 67% (59/88) is unique.** So deletion does not win on redundancy grounds alone. **But the unique 67%, categorised, is the real story:**

| category of the 59 unique | n | nature |
|---|---:|---|
| azole antifungals (keto/fluco/itraconazole) | 23 | usually **topical + systemic for different sites** (skin vs oral/nail) — legitimate; the dropped `form`/route would clear most |
| paracetamol + ibuprofen | 7 | **standard multimodal analgesia** — legitimate co-prescription |
| antidiabetic mono + FDC (e.g. metformin & glimepiride+metformin) | 5 | **real molecule duplication** that `duplicate_molecule` MISSED — belongs to a fixed dedup, not LASA |
| progestogens (dydrogesterone & progesterone) | 4 | same-class overlap — a genuine signal, mislabelled |
| **vaccine co-administration** (pneumococcal + influenza) | 4 | **guideline-RECOMMENDED** — penalising correct care (a false flag, not a mislabel) |
| antihistamines (fexofenadine & desloratadine) | 4 | same-class overlap — genuine signal, mislabelled |
| other same-class / alternative | 12 | mixed |

**Zero of the 88 are actual look-alike/sound-alike name confusables.** The 67% "unique" volume is dominated by (i) clinically legitimate combinations penalised as errors (≥11: para+ibuprofen, vaccines, most topical+systemic azoles) and (ii) real duplication owned by a fixed dedup (5). The genuinely-novel-and-valid signal (same-class therapeutic overlap actually worth flagging — antihistamines, progestogens, some azoles) is a **minority**.

**Evidence for each of V's three futures (not choosing):**
- **(a) Re-label** to "same-class / therapeutic-alternative overlap": the data supports the label, but the check would **still over-fire** on para+ibuprofen, co-administered vaccines, and topical+systemic azoles. Viable **only with route/form-awareness (the §2 structural fix) + a legitimacy allow-list** — otherwise it trades a mislabelled penalty for a correctly-labelled wrong penalty.
- **(b) Re-source** with ISMP Confused Drug Names (~150 pairs): makes it a real LASA check, but **fires ≈0 in this OPD population** (none of the current 88 are confusables). High effort, near-zero yield here.
- **(c) Delete**: loses 67% of *volume* but little *validated* signal — the unique content is mostly false positives + duplication that belongs elsewhere. **Cheapest; resolves the worst live scoring defect with no data to source.** Caveat: first re-home the 5 antidiabetic mono+FDC real-duplications into a fixed `duplicate_prescription` (they are true positives LASA is accidentally covering).

## 5. Recommended fix sequence (V approves; score-affecting flagged)

1. **LASA decision (a/b/c)** — *score-affecting (88).* Highest live scoring impact and it gates all LASA spend. **Needs the Signal-Type-Collapse dry-run + canary gate.** If (a) or a partial (c), sequence the structural fix (2) first so it can be route/form-aware.
2. **Structural: plumb `form` through enrichment** — *enabling; not score-affecting by itself.* One change (`FormularyRow` + `enrichOpdMeds` + `FormularyMatch` carry `form`/normalised route). Unblocks form-awareness for LASA, duplicate_*, high_alert, banned_fdc. Each *consumer* that then starts gating on form is its own score-affecting fix with a dry run.
3. **`duplicate_prescription` → molecule-level** — *score-affecting (43).* Catches mono+FDC; absorbs the 5 LASA antidiabetic cases. Dry-run + canary.
4. **`drug_interaction` comparison tightening** — *score-affecting (348), but sample the live false-fire rate first* — the firing leg is clean, so the true defect volume may be small. Word-boundary the curated leg (ddi.ts:40) and tag keywords (ddi-tags:20); review truncated keys. Dry-run + canary.
5. **`high_alert_medication` re-source + form-plumb** — *NOT score-affecting (informational).* Fixes the visible §11.2 defects (glucosamine+KCl, oral MgSO4) — no citations per the citations-PRD §11.2. Can ship without a scoring dry run.
6. **`dose` `medMolecules` tokenisation + `schedule_x` zero-fire investigation** — minor/diagnostic.

Score-affecting fixes (1, 3, 4, and any form-gating consumer of 2) inherit the dry-run + permanent-canary discipline from the Signal-Type-Collapse build (PRD §6/§5.5).

## 6. Things that escaped the claim/data/unit frame (§7.3)

The frame is a per-check hypothesis; these are real findings it does not capture:
1. **A false-negative in one check surfacing as a false-positive label in another.** `duplicate_molecule`/`duplicate_prescription` MISS metformin mono+FDC (exact-string/molecule gap); LASA then "catches" those 5 pairs under the wrong label. No single-check row shows this — it is a cross-check interaction. Fixing dedup both removes 5 LASA false labels *and* adds 5 correct duplication findings.
2. **A check that penalises guideline-recommended care.** LASA fires on pneumococcal + influenza vaccine co-administration (4 notes) — not a mislabel, an actively wrong penalty on correct practice. Severity beyond "mismatch."
3. **A check with zero live findings** (`schedule_x`) — the frame assumes a check fires. A check that never fires is either dead code or a silent data gap (formulary `schedule_dc` may never carry `X`); either way it is an audit finding.
4. **A visibly-wrong check that the scoring-impact ranking hides.** `high_alert_medication` is semantically broken (`high_risk` ≠ ISMP) but *informational*, so it ranks last by scoring impact despite being the most-cited "obviously wrong" cluster. Ranking by live scoring impact is correct for prioritisation but must not be read as "least wrong."
5. **A new scoring check can silently COLLIDE with an existing check's deliberate policy** (added 23 Jul, from the Stage 2 dry run — a NEW failure class, not claim/data/unit). This is not one check being internally wrong; it is **two checks disagreeing about what deserves a penalty.** Concretely: `duplicate_molecule` (dose-aggregation) deliberately keeps within-ceiling same-molecule duplication *informational* (worth awareness, not a penalty). The Stage 2 remedy for the dedup gap, taken literally as "molecule-subset → scoring `duplicate_prescription`", OVERRODE that policy for 82 notes — re-scoring as penalties the exact population dose-aggregation chose not to penalise (paracetamol-dominated). The per-check table structurally cannot surface this: every row characterises ONE check in isolation, so a policy contradiction that only exists *between* two checks is invisible to it. **Lesson: before adding a scoring check, enumerate what already fires on the same clinical event and whether it deliberately chose NOT to penalise — a "gap" may be a policy, not an omission.** (This is why Stage 2's dedup was rejected at dry run and reworked dose-gated; see CDMSS-MATCHER-STAGE2-DRYRUN-REPORT.)
   - **Evidence the measure-before-build gate earns its cost (recorded 23 Jul):** the dose-gate rework was killed by MEASUREMENT *before any code was written* (0/5 antidiabetic retained; 100% redundant with `dose_ceiling_exceeded`; `CDMSS-MATCHER-STAGE2B-DOSEGATE-MEASUREMENT`). That is the **second time in a single day** a mandated measure-before-build step prevented a wrong build — the first was the Signal-Type-Collapse "129 re-home" (the dry run showed "stop penalising" would have deleted the QT-prolongation safety penalty on 49 notes). Two averted wrong-builds in one day is the case for the gate: a dry run / feasibility measurement is cheaper than shipping-then-reverting a scoring change, and both here would have shipped without it.

## 6b. Future work — logged, NOT opened (dependency-gated)

- **Curated "duplication-sensitive class" duplication check — PHARMACY-GATED, do not open until pharmacy supplies the classes.** The Stage 2 dry run + 2b measurement established that the discriminator between *intentional* duplication (paracetamol + FDC, common multimodal analgesia) and *unintentional* duplication (metformin + a glimepiride/metformin FDC, double oral-hypoglycaemic dosing) is **clinical, not computational** — it is not separable by dose (antidiabetics have no ceiling), by molecule-set structure, or by anything the current enrichment exposes. A scoring check for it would require a **pharmacist-curated list of duplication-sensitive therapeutic classes** (antidiabetics, anticoagulants, and similar narrow-therapeutic-index molecules), sourced and reviewed the same way as `dose-limits.json` and the CDSCO seed. **Explicit dependency: pharmacy must supply the class list first — we do not improvise it.** Until then the ~5 real antidiabetic duplications remain visible (not penalised) via the existing informational `duplicate_molecule` roll-up, which is operationally sufficient. This is a data-sourced build with its own §6-style dry run when it is opened; it is deliberately NOT a matcher-scoping follow-up.
- **Later kickoffs (from §2, unchanged):** `drug_interaction` comparison tightening (348, sample false-fire first), `dose` `medMolecules` tokenisation + `schedule_x` zero-fire diagnosis (107 / 0), `high_alert_medication` re-source to ISMP + form-plumb (139, informational). Each its own kickoff.

## 7. Provenance
- **Checks audited:** 17, across 9 files. **Not in the §2 starting list:** `lib/formulary.ts` + `lib/formulary-match-core.ts` (the data-enrichment/matcher layer — the LASA semantic defect and the `form`-drop both live here). Confirmed the §2 list was incomplete exactly where the worst defects are.
- **Data opened, not assumed:** `data/formulary-2026.json` (`lasa` = same-class alternatives, `form` present-but-dropped, `high_risk` ⊋ ISMP), `data/dose-limits.json` (10 cited molecules), `data/cdsco-banned-fdc.json` (0 entries).
- Read-only. Nothing written to any table or file. **HEAD unchanged at `d098917`.** Green gate 1299/1299. Measurement harnesses live in the session scratchpad (gitignored, write nothing).
- **HARD HALT.** V approves the fix sequence; each fix is a separate kickoff.
