# SURGICAL-CHAIN-LINKER P1: pre-registration v1 (linker, 24 Sep 2026, written BEFORE any P1 scoring)

Status: **frozen at commit time.** No P1 score, margin outcome or label has been computed when this file is committed; the git timestamp is the evidence. A change to any rule below is a new dated version (`P1-PREREG-v2.md`) with the reason, and results already produced under v1 are kept and reported under v1. Inputs: `SCHEMA.md` (P0, eta-refuter-2 PASS #446), Fable rulings 123, 150, 151, refuter guidance #355. Nothing here uses transcript text; the recording step (section 5) is specified but not run.

Data handling: chain rows, ids and any text stay in `~/eta-data/surgical-chain/p1/` (0700). Git carries this file, code, and aggregates only.

## 1. Universe and unit

- **Visit** = a queue `CONSULTATION` step with `status = COMPLETE`, `called_at` in 1 Aug 00:00 to 24 Sep 24:00 IST, and `completed_at - called_at` >= 1 minute. Visits under 1 minute are dropped and counted (SCHEMA.md: p05 of duration is 0.28 min).
- **Route** is set per visit by what resolves, not by date: `KEY` if `SERVICE_REQUEST_UID` resolves in `chart_service_request` and its `service_metadata__consult_uid` finds at least one Rx; otherwise `HEUR` (patient + doctor + IST date). Every result in P1 is reported split by route.
- **Mature** = the Rx IST date is on or before **22 Aug** for a 30-day follow-up (30 days plus 2 days of OT-note sync lag inside the data that ends 24 Sep). A 14-day sensitivity uses a cutoff of **7 Sep**. Labels and the negative class use mature Rx only; immature Rx are counted and reported, never labelled.

## 2. Link 1, visit to Rx: tiers

| Tier | Rule | Use |
|---|---|---|
| A | `KEY`, the consult id maps to exactly one Rx, and the Rx patient and doctor equal the step's | labels allowed |
| B | `KEY` with two or more Rx (choose the non-draft Rx with the latest `updated_at`; if all are drafts, the latest), or `HEUR` with exactly one Rx and one visit for that patient-doctor-day | labels allowed, tier carried on every row |
| C | `HEUR` with several candidate Rx or several visits for that patient-doctor-day | counted only; never labelled |
| X | `KEY` where the Rx patient or doctor disagrees with the step | counted as a defect; never labelled |

Reported per tier: n visits, n candidate Rx. `n_cand` (candidate Rx per visit) is stored on every row.

## 3. Advised class (Rx level; both flags always kept apart)

- `S` = doctor-entered structured `requires_surgery_or_procedure = true` (dpipe plan of management). `P` = model-read PSR `surgery_recommended = 'yes'`.
- Class per Rx: `BOTH`, `S_ONLY`, `P_ONLY`, or `NEITHER`. **The primary "advised" is `S`**; `P_ONLY` is its own stratum and is never merged into `S` silently. Every negative and every positive names the flag that defined it.
- CT angiography and other imaging-tied interventions follow ruling 150: **advised-only**, a separate category `ADV_CTA` (matched on `investigation__uid`), never in the done-labelled set. Imaging-only items stay out (ruling 84).
- `NEITHER` does not mean "doctor advised nothing": PSR reads only hospital-OPD Rx types and the structured entry is optional. A **no-procedure negative** therefore requires an explicit read: a PSR row with `surgery_recommended = 'no'` and no structured `S`.

## 4. Link 2, Rx to outcome (done evidence), 30 days after the Rx `timestamp`

Same patient (`individuals.uid`, hospital ids via `kx_uhid`). Window: from the Rx `timestamp` to +30 days (an admission may start up to 1 day before).

| Evidence | Definition | Counts as done? |
|---|---|---|
| `NOTE` | a final OT note (`kx_clinical_template_ot_notes`) with `created_at` in the window; de-duplicated by `encounter_id` | yes (strong) |
| `BILL` | a `kx_billing_records` line on an admission in the window with `service_type = 'IP Package'`, or `Surgery` whose item name is not overhead (excluded: names matching theatre, OT charges, anaesthetist, assistant surgeon, and `Procedure` lines, which are bedside nursing) | yes (strong) |
| `ADM` | a `kx_ip_admissions` row (uhid, `admission_date_time` in the window) with neither `NOTE` nor `BILL` | weak: "admitted only", separate class, never a positive label |
| `MANUAL_CASE` | a non-cancelled `surgery_cases` row with `source = MANUAL` in [Rx - 1 day, Rx + 30 days] | booking evidence only; not done |
| `PRESCRIBED_CASE` | `source = PRESCRIBED` (auto-created lead, from 14 Sep) | **ignored entirely** (ruling 151): never booked, never done, never in the negative filter |

- **Positive (done) chain:** Rx advised by `S` (or `BOTH`/`P_ONLY`, kept as strata) and `NOTE` or `BILL` within 30 days, mature Rx.
- **Negative class N1, advised-not-done:** Rx advised by `S` with none of `NOTE`, `BILL`, `ADM`, `MANUAL_CASE` within 30 days, mature Rx. (This is Fable's candidate-negative pool; its size is measured in the first 25 days of August in SCHEMA.md section 7 as 127 of 192.) `PRESCRIBED_CASE` does not exclude a flag from N1.
- **Negative class N2, no procedure advised:** a visit to a surgical-clinic doctor whose Rx has an explicit no (section 3). **Surgical-clinic doctor** = at least 10 Rx with `S` or `P` in the whole window (fixed now, from doctor totals only, not from any outcome).
- Procedure agreement between the advised name (structured array) and the done evidence names (note `surgery_name`, billing item, case `procedure_name`) is a **separate text step** stored as `proc_match`. It is never an input to link 1 or link 3 and never used to select or gate chains.

## 5. Link 3, visit to recording (specified now, run later)

**Circularity rule (refuter #355, ruling 123).** Two scores are stored for every candidate and kept apart:

- `link_score`: content match of transcript to Rx on **complaint + medications only**, plus the time and energy gates below. The procedure name is excluded from the question and from the prompt.
- `proc_score`: the procedure-name match, stored as its own column. It never enters `link_score`, the margin, or the accept decision. Per chain, a field `proc_used_in_link` is stored and must read `false` on every accepted link; a chain with any other value is dropped from labels.

**Candidates for a visit** = recordings from the hist-miner energy shortlist (top 3 rooms, `~/eta-data/hist-mining/shortlist.json` and `energy_shortlist.py` for other visits) in the window `[called_at - 10 min, completed_at + 10 min]`. A candidate must have recorded audio covering at least 50% of the consult duration. No weighted sum of time, energy and content is used (no free weights): time and energy gate the candidate set, content decides among the gated candidates.

**Margin rule, fixed now.** On the 0-1 content score, a link is `ACCEPTED` only if both hold:
1. **Best-candidate floor:** `link_score` of the best candidate >= **0.50**.
2. **Margin:** best minus second-best >= **0.15**, where **the second-best is always drawn from the same doctor's same IST day**: the same transcript scored against the Rx of the doctor's other visits that day (excluding this visit), taking the highest as the runner-up; in addition, the best room must beat the next shortlisted room by the same 0.15. Both margins must pass.

**Single-candidate visits.** A visit that is the doctor's only visit that day, or has only one gated room, has no meaningful margin. It is reported in its own class `SINGLE`, accepted only if the floor passes, and never counted as margin-passed. The count of `SINGLE` visits is reported next to every accept rate (P0: 3.7% of all visits are the doctor's only consult of the day).

**Scale check, no data.** If the scoring tool's output is not on a 0-1 scale, the two constants are restated in `P1-PREREG-v1.1.md` after a dry run on synthetic pairs only, before any P1 pair is scored. No constant is tuned on P1 results.

## 6. Negatives: matched sampling frame

- For every positive chain, draw up to **2 negatives from the same doctor and the same ISO week**: one from N1 and one from N2 where available. Seeded random draw (seed 24); order by uid before drawing.
- If a doctor-week has no eligible negative, take the same doctor from an adjacent week and flag `borrowed_week = true`. Never borrow across doctors. Report every shortfall; do not back-fill silently.
- Positives and negatives are both scored through link 3 identically and blind to class.
- The refuter's check that "advised" names its flag: every N1 row carries `flag_class` in {`S_ONLY`, `BOTH`, `P_ONLY`}; `P_ONLY` negatives are sampled and reported separately (SCHEMA.md: the two flags disagree on 214 Rx).

## 7. Reporting (every table)

Split by: route (`KEY` / `HEUR`), tier (A/B/C/X), flag class, mature flag, follow-up window (30 d primary, 14 d sensitivity). Always report: n visits, n with only one candidate, n dropped for duration under 1 minute, n Rx with drafts only, n of the doctor-only-visit class. Yield ceiling stated per encounter (P0: 42% of surgeries have a platform Rx in the prior 30 days; 83% of visits carry the key; tape exists on 24 of 51 days).

## 8. What this pre-registration does not decide

Rater questions and thresholds for the transcript-level "proposed in this conversation" label (P2, with surg-page), the Jev prompt wording beyond the exclusion in section 5, and any per-doctor weighting. Those come after the link is scored and are reported as separate analyses.

## 9. Build order

1. Chain builder for links 1 and 2 (deterministic, no transcripts, no scoring): counts by route, tier, flag class, maturity. This is what runs first.
2. Negatives frame (section 6) from the builder output.
3. Link 3 only after eta-refuter-2 has read this file and after the scale check.
