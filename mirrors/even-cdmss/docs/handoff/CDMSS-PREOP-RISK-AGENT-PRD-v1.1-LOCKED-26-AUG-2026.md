# CDMSS Pre-operative Risk Agent — PRD v1.1-LOCKED

**Date:** 26 Aug 2026 · **Owner:** V · **Status: LOCKED — zero open decisions (D1–D4 all ratified).**
**Supersedes:** v1.0-OPEN (16 Jul 2026), which was authored in-session and never committed to the handoff folder; that file was lost with a container recycle ~20 Aug. This v1.1 is the reconstruction plus everything measured and decided since. **It is the canonical document.**

Per the standing rules: no kickoff leaves this thread with open issues (all forks adjudicated below); a **visual mockup must be approved by V before the UI build kickoff**; the module ships **born-instrumented** per the model-flywheel rules.

---

## 1 · Why

Surgical patients at Even accumulate risk-relevant data across weeks — booking form, OPD visits, hospital investigations, and finally the pre-anaesthesia check (PAC) — but nothing assembles it into a risk picture that *evolves* as data lands. The prior art (SREWS in EHRC Daily Dash) proved the appetite for a surgical-risk board but scored cases with an opaque LLM whose tiers don't discriminate (the 92-AMBER flood; calibration deferred indefinitely). This module is the corrective: **validated clinical instruments, deterministic arithmetic, explicit confidence, visible provenance — computed as evolving snapshots per surgical episode.**

It is also the **first consumer of the endorsed EpisodeState** from the IPD → Patient Twin roadmap (build-at-first-consumer), reusing ClinicalState/MemberState rather than inventing a parallel substrate.

## 2 · Identity & positioning (D1 — RESOLVED)

**A new CDMSS-native agent, independent of all prior art.**

- Lives in Even-CDMSS (`cat.evenos.app`), first consumer of EpisodeState; reuses ClinicalState/MemberState extraction and the longitudinal spine.
- **Cannibalise SREWS freely as design reference, never as dependency:** its triage-first vocabulary (tier bands CRITICAL/RED/AMBER/GREEN, "needs review" band, enriched cards with *why* / top-action / dominant-dimension, Risk/Schedule/Calendar views, the deterministic `derive.ts` pattern) informs our mockup. **No coupling** to SREWS code, its LLM `assessment_json` model, or the EHRC Daily Dash repo.
- Positioned to **supersede SREWS's Gemini engine** once proven; whether Daily Dash's `/surgical-risk` is then retired is a product call outside this PRD.

## 3 · Slice-1 instruments (D2 — RESOLVED)

**RCRI + mFI-5 + Charlson** — three complementary lenses (cardiac risk, frailty, comorbidity burden), chosen because every instrument computes *something* from booking data alone and every instrument has at least one input that **ripens at PAC**, which is precisely the evolving-snapshot demonstration.

| Instrument | Inputs | Booking-time coverage (measured) | The ripening input |
|---|---|---|---|
| **RCRI** (cardiac) | high-risk surgery; IHD; CHF; cerebrovascular disease; insulin-treated DM; creatinine >2.0 mg/dL | 5/6 factors from booking comorbidities + OPD history | creatinine — structured for only 18/105 at booking; arrives via PAC bloodwork / HCU digitization |
| **mFI-5** (frailty) | functional status; DM; COPD; CHF; HTN | 4/5 items from booking comorbidities (~90%) | dependent functional status — not captured at booking; a PAC-completable item |
| **Charlson** (burden) | comorbidity categories + age | near-100% from booking + OPD | refinements from PAC history sections |

Rules: an instrument with missing inputs computes as a **range with an explicit missing-input list** (§8), never as a silent point score. **mFI-5 and Charlson share comorbidity inputs — the UI presents them as two correlated lenses, not independent confirmation.**

**Deferred to S2:** ARISCAT (needs SpO2 ~47% / Hb ~20% coverage today), Caprini (the PAC template's existing "VTE risk score" section feeds this), STOP-BANG (blocked on BMI + OSA items until PAC capture improves).

## 4 · Data source registry (all figures MEASURED)

| Source | What it gives | Status (16 Jul / 26 Aug measurements) |
|---|---|---|
| `surgery_cases` (db13) | the episode anchor: cohort, procedure, dates, `individual_uid` | 105 patients at 16 Jul; growing. **No UHID column** — see bridge row. |
| Booking form comorbidities | RCRI history factors, 4/5 mFI-5, Charlson base | ~100% of cohort; the floor every snapshot stands on |
| OPD visits / ClinicalState | history corroboration, diagnoses | 77/105 have ≥1 modality beyond booking; 28/105 are booking-form-only → §8 is mandatory, not optional |
| `parameter_digital_values` (Eka-extracted labs) | LOINC-coded structured labs | ~30% of cohort; creatinine 18/105 |
| `individuals-hcu_bookings` `booking_type='EVEN_HOSPITAL'` | the hospital's own investigations — as PDFs | 2,996 bookings (2 hospitals, from 10 Apr), **0/2,996 digitized** vs API path 66,110/102,637; **1,071 consolidated PDFs**; surgical overlap 23 pts / 116 bookings / 22 reports → dep 2 (§9): latent, closeable lab ceiling with no new capture |
| **`kx_clinical_template_pac_reports` (db13) — LIVE since 13 Jul, fetched daily** | the anaesthetist's PAC evaluation | 95 reports / 94 patients (13 Jul–25 Aug), all status `final`, one template ("Doctor Preoperative Anesthesia evaluation (PAC)"). Metabase card 8575 reads it; the card is permission-blocked to the MCP key — **query the table directly.** |
| **UHID bridge: `individuals.kx_uhid`** (+ `old_kx_uhids`) | PAC ↔ Even identity | **PROVEN: 91/94 PAC UHIDs map to `individual_uid`; 52 land in the surgical cohort.** No fuzzy matching needed. |

**PAC payload shape (verified):** `component_json` is KareXpert's form key/value array — **semi-structured, scrape-not-OCR, with opaque template-specific keys** (`iu87`=diagnosis, `za`=planned procedure, `yudo`=sex; vitals as clean nested JSON with values + reference ranges). `note` is a flattened text render ending in the fitness conclusion ("PATIENT CAN BE TAKEN FOR SURGERY"). Because it is a single template, a **one-time key→semantic mapping table** makes it structured input (§9 dep 1). Text-scan of payloads (mentions, not fields — exact numbers come from the mapping exercise): airway section 95/95, weight ~24, height ~16, creatinine ~12, Hb ~9, fitness language ~13, **ASA only 5/95, Mallampati 0/95, METs ~1, OSA ~4** → the capture-quality ask (§9 dep 3).

## 5 · Snapshot model

One **episode** per `surgery_cases` row. The agent computes an **assessment snapshot** whenever its inputs change; snapshots are **versioned, append-only, and every one is explainable**:

- `snapshot = { episode_key, PREOP_ENGINE_VERSION, computed_at, inputs[] (each with value, source, provenance ref, confidence, extracted_by?), per-instrument {score|range, missing_inputs[], factor table}, tier, capture_reason }`.
- **Versions rail = the readmissions R8.1 pattern verbatim:** snapshot-on-overwrite with a closed capture-reason set, idempotent saves (same trace ⇒ no duplicate snapshot), bounded manual replay as a research tool, live row never touched by replay. This existing rail **is** the "evolving snapshot" architecture — we adopt it, we don't reinvent it.
- The case page renders the version history as a timeline: *booking-only range → labs land → PAC lands → score tightens*. That timeline is the module's core demo.

## 6 · Agent architecture (D3 — RESOLVED)

**A clinician-facing agent under Managed Care, sibling to the readmissions agent.** `/care` chooser gains a third tile: **Care Conversation Briefs · OPD Audit Triage · Pre-op Risk**.

Mirror the readmission agent's ratified posture, byte-for-byte where it applies:

- **Routes:** `/care/preop` (board) + `/care/preop/case/[key]` + `GET /api/care/preop/list|case|rates` + `POST /api/care/preop/ask` (ask-the-agent, S2 if time-boxed out of Slice 1); worker at `/api/preop/worker`; migrate routes under `/api/admin/migrate-preop-*`.
- **Worker:** Vercel cron; **every tick runs the deterministic ₹0 sweep** (SQL + pure cores: detect episodes, assemble inputs, recompute snapshots idempotently on `(dedup_key, PREOP_ENGINE_VERSION)`); **sweep-is-the-retry**; LLM stages run only behind their flags (§7) — flag off ⇒ safe no-op, never a fabricated value. Auth guard = the readmission worker's exactly (`x-vercel-cron` / Bearer `CRON_SECRET` / admin session). Cadence: pre-op data lands in the daytime (PAC visits, lab results), so a day-window sweep (e.g. hourly 06–22 IST) rather than the readmit night window — builder tunes, **with the readmit covenant: the cron interval must clear `maxDuration`, and any change to one moves the other in the same commit.**
- **Code layout:** pure `lib/preop-*-core.ts` (no DB, no fetch, no clock — the derivations, instrument arithmetic, degradation logic, version decisions) + `lib/preop-*-store.ts` (DDL + CRUD) + thin routes. Engine constant `PREOP_ENGINE_VERSION = 'preop-risk/0.1'`; version bumps are the A/B boundary, forward-only.
- **UI (mockup-gated):** board = SREWS-cannibalised triage-first view — tier bands, needs-review band (unreviewed high-tier within N days of surgery), per-case card with the three instrument scores/ranges, confidence state, *why* (top factor), and the missing-input list ("creatinine pending — confirm at PAC"). Case page = factor tables + snapshot timeline + provenance per input.
- **Instrumentation:** born-instrumented — every snapshot carries engine version, input provenance, and trace id from day one; the flywheel gets gold labels for free.

## 7 · LLM boundary (D4 — RESOLVED: extraction + narrative, both flag-dark)

**Inviolable invariant: a model may propose an *input* (with provenance and confidence) or write *prose about* a computed result. It may never contribute a point of score.** Scores are instrument arithmetic in pure cores, provable by test.

- **Extraction rail (`PREOP_EXTRACT_ENABLED`, ships dark):** turns messy text into instrument inputs — booking comorbidity strings, OPD notes, and PAC `component_json` values (e.g. "CHRONIC HEP B, PORTAL THROMBOSIS…" → Charlson categories; functional-status and airway text → mFI-5/flags). Reuses the ClinicalState B2 extraction rail (already prod-default). Every extracted input is displayed with source text and confidence; **low-confidence extraction feeds the same §8 degradation machinery as a missing input** — the instrument widens to a range. No new uncertainty concept.
- **Narrative rail (`PREOP_NARRATIVE_ENABLED`, ships dark):** readmissions-style `NARRATIVE_MODEL` writes the case prose *from the computed factor table* (it summarises, it never scores). Same posture as the readmit narrative core: model label **derived from the call, never typed** (house rule — two silent incidents prove it), stored on the snapshot.
- **Flag-off behaviour:** with both flags off the module is fully functional on structured fields + deterministic parsing — degraded coverage, correct behaviour. This is the shipped state until V validates (§11).

## 8 · Graceful degradation (S5 — mandatory)

28/105 patients are booking-form-only; the module must be honest, not empty, for them:

- Every instrument renders one of: **point score** (all inputs present) · **range** (missing/low-confidence inputs, with the missing list and what would tighten it) · **not computable** (only when even the floor is absent — should be ~never given booking coverage).
- The board never hides a thin patient; thin data *is* the finding ("no PAC on file, surgery in 4 days").
- Acceptance: a synthetic booking-only patient renders all three instruments as ranges with correct missing-input lists; feeding creatinine collapses RCRI's range to a point and mints a new snapshot version.

## 9 · Dependencies (all non-blocking; Slice 1 does not gate on any)

1. **PAC key→semantic mapping** (internal, small): one-time mapping table for the single KareXpert PAC template's opaque keys → semantic fields, then the worker consumes `kx_clinical_template_pac_reports` directly. The scrape itself is **DONE** (teammate delivered; daily fetch verified). Card 8575 stays the human-browsable view.
2. **EVEN_HOSPITAL HCU report digitization** (pipeline-owned): point the existing Eka digital-values extractor at `consolidated_report_url WHERE booking_type='EVEN_HOSPITAL'` (1,071 PDFs; 0/2,996 currently digitized). Results land in `parameter_digital_values`, which the assembler already reads — no new extractor. Lifts structured-lab coverage for exactly this cohort.
3. **Capture-quality ask to anaesthesia** (governance, via V): ASA 5/95, Mallampati 0/95, METs ~1 — the template largely isn't capturing the fields the instruments (and the S2 set) want. Raise as a documentation-quality request, advisory tone; the module degrades gracefully meanwhile (§8), so this is an enrichment, not a blocker.

## 10 · Slice plan

- **Slice 1 (this kickoff, after mockup approval):** migrations (episode/snapshot/version tables) · deterministic sweep + three instruments in pure cores · UHID bridge join · `/care/preop` board + case page per approved mockup · versions rail · extraction + narrative rails built **dark** behind their flags · born-instrumented.
- **Slice 2:** flag flips after §11 validation · PAC mapping table consumption · ARISCAT/Caprini/STOP-BANG (Caprini seeded by the PAC VTE section) · HCU-digitized labs as they land · `ask` route if deferred · review/acknowledge workflow if clinicians ask for it.
- **Later:** supersession conversation with SREWS; API surface for Pulse (One Surface is parked; not before the engine has earned trust).

## 11 · Verification & acceptance

- **Determinism:** pure-core tests prove same inputs ⇒ identical scores; full-suite green + tsc clean; live-verify every slice on production data (type-checks pass but data-shape bugs only show at runtime — SREWS `surgeryDateKey` lesson).
- **Zero-LLM-influence proof:** flag-off and flag-on runs produce **identical scores** on the golden set (narratives/extractions differ; arithmetic cannot).
- **Golden set:** drawn from the 52 PAC-covered cohort patients + synthetic booking-only cases; V validates board counts and a hand-checked sample of instrument scores **before either flag flips** (mirrors the readmit lane-count validation posture).
- **Worker:** idempotency proven by double-tick (second tick writes nothing new); snapshot-on-change proven by feeding one new input.
- **Mockup:** approved by V before UI build kickoff — the SREWS-vocabulary board and the case-page timeline are the two screens.

## 12 · Decisions log

- **D1 (V, 16 Jul):** New CDMSS-native module, independent; cannibalise SREWS UI vocabulary as reference only; positioned to supersede its Gemini engine. No coupling to EHRC Daily Dash.
- **D2 (V, 26 Aug):** Slice-1 instruments = RCRI + mFI-5 + Charlson; broader set deferred to S2; mFI-5/Charlson presented as correlated lenses.
- **D3 (V, 26 Aug):** Clinician-facing page in Even-CDMSS built as an **independent agent like the readmissions agent**, housed under Managed Care at `cat.evenos.app/care/` (third chooser tile); mirrors the readmit worker/cores/versions posture.
- **D4 (V, 26 Aug):** LLM at **two boundaries — extraction and narrative — both shipped dark behind env flags**; scores permanently deterministic; extraction reuses ClinicalState B2; narrative reuses the readmit `NARRATIVE_MODEL` posture; labels derived, never typed.

*Advisory module: outputs are decision support for clinicians and governance; nothing raw reaches a patient; nothing here overrides the anaesthetist's fitness conclusion — the PAC verdict is displayed alongside, never replaced.*

---

## 13 · Amendment A1

*Ratified by V's orchestrator, 26 Aug 2026, on the evidence of the B0–B2 build report. Appended verbatim.*

- **A1-1 Booking enum.** `clinical__comorbidities` is a closed 5-value enum array. Scoring: DIABETES ⇒ DM present (mFI-5, Charlson) but RCRI insulin-factor **unknown** (range) until PAC meds or extraction resolve it; HEART_DISEASE ⇒ IHD and CHF both **unknown** (opens both ranges); HYPOTHYROID ⇒ no instrument (display-only); HYPERTENSION ⇒ mFI on-medication item present (B5 settles the medication half). Widening the form is a product ask on V's governance list — not build work.
- **A1-2 Fifth provenance source `OPD`** — structured ICD-10 from `individuals-prescriptions`, deterministic, ranked beside BOOKING, never labelled EXTRACTED, never hidden by the extraction flag.
- **A1-3 PAC dual-fact rule.** `pac__status` (booking workflow) and a bridged KareXpert report are two different facts; the UI shows both, neither stands in for the other (chip states in B4 below). Measured 26 Aug: the 1-vs-8 gap is mostly ≤1-day scrape lag; a >48h "complete but no report" case is a data-quality signal.
- **A1-4 Identity fallback.** `individuals.display_name` is empty cohort-wide; the first/last-name fallback added in B2 is ratified; final fallback = UHID · age/sex — never an anonymous card.
- **A1-5 B0–B2 deviations ratified:** `preop_sweeps` heartbeat table · fingerprint-keyed versions rail · one why-line shape · booking HYPERTENSION = on-medication · 72h as ≤3 whole days · cron-count test edits · no GRANTs. **Keeper pattern (module-wide):** db13 fetchers return `{rows, error}`; the sweep carries `degradedSources`; non-empty ⇒ coverage numbers are floors.
- **A1-6 Weak form-negatives.** *(Ratified in situ, 27 Aug 2026, with the B5–B7 kickoff.)* A completed closed booking form's unchosen options render ABSENT with the visible note "(not listed on the booking form)" — a weak form-negative with its basis on display; HEART_DISEASE when chosen still opens IHD/CHF as unknown-which; insulin status stays UNKNOWN until PAC/extraction resolves it.
