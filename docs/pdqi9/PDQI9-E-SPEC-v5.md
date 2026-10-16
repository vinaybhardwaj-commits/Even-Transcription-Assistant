# PDQI-9 adaptation spec v5: CDMSS note, newcat encounter, ETA/FreeScript draft
cloud-pdqi9-v5 (spec writer), 16 Oct 2026. Supersedes v4, v3, v2, v1 (all kept). Answers REFUTE-R4 on top of R1-R3 and applies the six lead rulings of the v5 brief. Changes from v4 are marked **[v5]**; earlier [v3]/[v4] tags stand unless a [v5] note overrides them. Paper design only: no model calls, no DB, no PHI, no consult uids, no names. Anything not read in the v4 inputs, REFUTE-R4 or the v5 brief is UNVERIFIED.
Status: Section A (SHARED DECISIONS) is final and binding on the EVIDENCE-PLAN v5. Sections B-G complete.

**[v5] Summary of what changed.** (1) Doctor span v2 = the 3/3 role-voter rule UNION a gated "arm (c)" (the logged-in doctor's enrolled voiceprint, independently confirmed by Clef-omni and Jev), every span tagged with its source `3of3 | armc | both` (A4.1, A4.1a). (2) The voiceprint ban is amended, not removed (A4.1b). (3) Fluid rooms: no assumed speaker count; non-treating voices never yield orders; a translator can support but never create a doctor item (A4.1c). (4) Speaker gate becomes `speaker_gate@2` on the union, taus 0.6 / 45 s / 5 stay as floors, raise-only (A6). (5) New T28 (arm (c) segment precision >= 0.99 on known speakers) and a Fable gate on arm (c) before S3 (A3, F). (6) Pool sizing is a preregistered pilot-then-size procedure, working estimate about 350-600 candidates for 120 survivors (A2.4). (7) Every result is reported per source and re-run 3/3-only as a check (A2.6). (8) New P-SYN stratum S-V for voiceprint and fluid-room traps (A2.1).

# A. SHARED DECISIONS (binding on SPEC v5 and EVIDENCE-PLAN v5)

## A1. The single judge-panel rule
**Two roles, never mixed.**
- *Scorer J\**: the one pinned model that runs a rubric in production or shadow (rubric JSON field `judge_pin`). J\* = Gemini 2.5 Pro for `pdqi9-note` (CDMSS continuity), `pdqi9-rx-draft` and `pdqi9-encounter` (A1.5).
- *Reference panel*: independent voters used only to make reference labels. J\* never votes on its own bench.

**A1.1 Voters and the per-item eligibility table.**
| Voter | What it reads | Eligible items | Output to code |
|---|---|---|---|
| Opus 5.5 (Bedrock) | full transcript, native + English, roles, the artefact | all 9 | rating 1-5 + evidence ids |
| Gemini 2.5 Pro (Vertex) | same text | all 9 | rating 1-5 + evidence ids |
| Jev | English text; fixed presence/choice questions only | accurate, thorough, up_to_date | yes/no or choice; **code** maps to a band by a fixed table. No Jev 1-5 rating |
| Clef-omni | audio window per claim | accurate, thorough, up_to_date | said/speaker/exact_match per claim; code maps to a band. Never raises `[uid]` |
The other six items (useful, organized, comprehensible, succinct, synthesized, internally_consistent) are note/transcript-only: **Opus + Gemini only**.
**[v5]** Jev's and Clef-omni's *role/speaker* outputs used to define doctor spans (A4.1) are measurement inputs, not panel votes; A1.3b still removes them as *scorers* for arms fed their layers.

**A1.2 Agreement rule.** Bands are low (1-2), mid (3), high (4-5). An item gets a reference label only if the eligible voters, after removals (A1.3), reach: n=4 -> at least 3 in the same band; n=3 -> all 3; n=2 -> both. n<2 -> no label. Otherwise the item **abstains**. A unit gets a reference total only if >= 7 of 9 items are labelled. Abstention is reported, never filled.

**A1.3 Removals.**
a. The scorer J\* is removed from the panel for its own bench.
b. For any artefact whose input included the Jev or Clef/Clef-omni layer (Encounter Brief arms 2-4, any fused arm), **Jev and Clef-omni are removed** as scorers. The panel is then Opus + Gemini, n=2, both must agree, on all 9 items.
c. A voter-item pair is *earned*: on the synthetic set (A2) its band accuracy against planted truth must be >= 0.7, else it does not vote on that item.
d. Items that cannot reach n>=2 after a-c are **synthetic-only**: benched on planted truth, no silver, flagged in the report.

**A1.4 Four-arm proof uses a fixed rule.** All four arms are scored by Opus and Gemini, each blind to the arm, one unit per call. Primary statistic per item/total = mean of the two; a band reference label exists only under the 2/2 rule. J\* is not involved, so removal (a) does not apply.

**A1.5 Generator-family rule (UNVERIFIED fact, must be read before S1).** Read the FreeScript generator model id from the artefact metadata. If the family is Claude, Opus is never the sole or deciding text judge on any draft (the 2/2 rule guarantees this) and Gemini is required in every draft label. J\* stays Gemini in all cases. There is no Sonnet substitution anywhere in the panel (Sonnet 5.5 is the same family as Opus and is not an A1.1 voter). If a rubric's J\* were ever Opus, Opus is removed from its own bench and the text-only items become **synthetic-only** (A1.3d).

**A1.6 Drift check.** Weekly, 10% of scored units are re-judged by Sonnet 5.5 for text (a monitor, **not a panel voter**, never used to make labels); per-item weighted kappa is stored; < 0.6 on an item raises an alert and holds promotion.

**A1.7 Evidence discipline.** Every rating carries valid evidence ids (turn_id or field_id, verified by code, speaker role checked against A4.1); invalid or missing evidence on accurate, thorough, internally_consistent -> null with reason. < 7 of 9 rated -> unit unscored (null, never 0). Panel/judge model ids are served-model verified and recorded with prompt sha.

## A2. The single preregistered bench population
One population, one threshold table (A3), one 4-arm proof set (A2.3).

**A2.1 P-SYN: [v5] 204 synthetic scripted consults** (voiced in ElevenLabs: Indian English and Hindi/Kannada code-switch; run through the real recorder and pipeline on the diagnostics rig; flagged `synthetic=true`; vendor sign-off pending). Each script has a truth sheet (A4.4) and a code-built twin artefact. **[v5]** Every script declares its speaker roster (any number of speakers, A4.1c) and which voice is the treating doctor; every synthetic doctor voice is a *pseudo-doctor* with its own enrolment set (A4.1a), recorded through the same rig from utterances that never appear in any consult.
| Stratum | n | What is planted | Used for |
|---|---|---|---|
| S-E | 54 | 9 items x 3 levels (1/3/5) x 2 language modes: defect in the consult | `pdqi9-encounter` |
| S-N | 54 | same grid, defect in the code-built note twin; consult clean | `pdqi9-note@2` |
| S-C | 12 | clean consult + clean twin | false-low rate, baseline |
| S-R | 30 | Rx floor traps: drug said then retracted, dose corrected, drug only by attender or patient, drug never said, clip-bleed phrase, placeholder-prone field | `pdqi9-rx-draft` floors (exact) |
| S-D | 20 | doctor's-words: every instruction category, firm/hedged pairs, reversals (final wins), repeated emphasis, doctor priority order | recall metrics (A4.3) |
| S-A | 10 | affect-only: patient worried/confused/hesitant with identical doctor words as a flat control | arm 4 no-add gate |
| **S-V [v5]** | **24** | **voiceprint and fluid-room traps** (A4.1a, A4.1c): 6 covering/junior clinician speaks orders while another pseudo-doctor is logged in; 6 translator relays the doctor (incl. 2 where the relay changes a dose and 2 where the translator adds an item the doctor never said); 4 nurse/staff gives instructions; 4 three-plus attenders, overlapping; 4 voice-alike pseudo-doctor pairs (cosine to each other near 0.65) | T28, A4.1c rules, `doctor_conflict` |
**[v5] Metadata variants (no new audio).** Arm (c) inputs are login and enrolment metadata, so every P-SYN script is also run under: (v1) correct login + enrolled (default); (v2) wrong pseudo-doctor logged in; (v3) treating pseudo-doctor not enrolled; (v4) no login for the slot; (v5) login covering only part of the window. Expected: v2 arm (c) must not fire on the treating voice (a fire is a T28 false accept); v3-v5 fall back to 3/3 (A4.1a). Variants are scored for T28 and the fallback check only, never double-counted in T1-T22.
Split by script (twins and metadata variants stay together): **[v5]** dev 68 (prompt tuning and gate fits only) / test 136, seed fixed in the prereg. Decoys: 25% of claims given to Jev/Clef-omni are planted-absent. Oracle ablation: every script is scored on the true script text and on the pipeline transcript.

**A2.2 P-REAL: 300 real consults** drawn once, hash of the uid list frozen before scoring. Stratified by room, language, specialty, duration, **[v5] span-source tier (3/3-only pass, union-only pass, both) and enrolled vs unenrolled treating doctor**; blind/held-out room-days excluded; windows complete; **STT gate = pass (A5) and `speaker_gate@2` = pass (A6)**. Pool size is set by the pilot (A2.4), not fixed; strata that pass the gates at < 20% are dropped from stratification and named as excluded (results then generalise only to "attributable consults"). Dev 100 / test 200. Layer availability (role layer, Nemotron, Jev, Clef, emotion2vec, WavLM, Odyssey, **[v5] enrolled centroid, Pulse login**) is recorded per unit and is a stratum, not an exclusion.

**A2.3 The 4-arm proof set P-4ARM.** **N = 120 consults** (10 dev, 110 test) with: STT gate pass, `speaker_gate@2` pass, role layer and Nemotron present, transcript >= 2 min, a signed (non-draft) posted Pulse Rx, FreeScript layer settled. The 74 test encounters of the 12 Oct study are included first if they still pass, then fill from newer consults. **Survivor rule:** walk a frozen, seeded order across **all eligible room-days** until 120 survive, or the order is exhausted; no pool cap. If < 60 survive, A2.5 applies. Affect-layer analysis (arm 4 vs 3) is on the subset where >= 2 of the 4 affect models produced output. **[v5]** Survivors are stratified by span-source tier and enrolled vs unenrolled doctor (A2.6); the walk does not re-weight to balance them, it reports the mix.
Arms: A1 current input (STT + translation only) -> FreeScript; A2 Encounter Brief; A3 brief + doctor's-words layer; A4 + patient-affect layer. Same consult list, generator, prompt shell; only the input changes. Each arm output is rendered to the same neutral template, one artefact per call, arm hidden, call order shuffled.
Comparison vs the posted Pulse Rx (A_pulse) as in v4: both references (*transcript-reference*, *no-transcript*) reported; "arm >= Pulse" needs both to agree in direction; recall vs Pulse is descriptive only; recall is measured against the doctor-span truth (A4.3). Real-consult truth lists are machine-extracted (Opus + Gemini intersection over doctor spans only, A4.1) and labelled *silver recall*; **exact** recall exists only on P-SYN.

**A2.4 Pilot-then-size pool, preregistered procedure [v5, ruling 4, R4 MUST 4, SHOULD 1].** The procedure is fixed now; only its outputs are unknown.
1. **Order.** Before any real-audio step, freeze a seeded order of all eligible room-days and consults (hash recorded).
2. **Shadow week first [v5, R4 SHOULD].** The real-audio shadow week (A5, A6) runs **before** the pilot. It may raise the taus (never lower them); taus are then frozen, so "taus as frozen" in step 3 means the post-shadow values.
3. **Pilot.** The first 100 consults of the frozen order. Passing pilot units count toward the walk (no selection). Measured with 95% CIs, per room and recording condition: `p_stt`; `p_spk` **reported twice: 3/3-only and union (`speaker_gate@2`)**; `p_other` (signed Pulse Rx, transcript >= 2 min, FreeScript settled, window complete); **[v5]** `p_armc_inputs` (enrolled centroid and full-window Pulse login present), `p_armc_fire` (arm (c) accepted given inputs), the `doctor_conflict` rate (A4.1a), enrolment coverage of candidate consults (doctors with and without a voiceprint, R4 SHOULD 3); Clef-omni and Jev cost per consult.
4. **Size.** Required pool = N_target / (p_stt x p_spk x p_other) for N_target = 120 (P-4ARM) and 300 (P-REAL), at the point rates and at the lower-CI rates, computed separately with union p_spk and with 3/3-only p_spk. The union figure at lower-CI rates is the number written down before S3; if arm (c) fails its Fable gate (F, S2c), the 3/3-only figure replaces it.
5. **Decide.** If the required pool exceeds the eligible consults or V's spend cap, A2.5 applies.
**Working estimate (not measured).** Union p_spk about 0.4-0.6 against about 0.15-0.25 for 3/3-only, with p_stt x p_other about 0.5-0.6, gives about **350-600 candidates for 120 survivors** and about 900-1,500 for 300 under the union; under 3/3-only the v4 estimate of about 800-1,500 for 120 and 1,500-2,000 for 300 stands. Reference points reported by others, not re-measured here: on 60 real consults, 3/3 covers 21% of segments pooled and 37 of 60 (62%, 95% CI 48-74%) have zero confident-doctor segments, one room 9 of 10; with arm (c), record-only, 15 of 60 (25%, 95% CI 15-38%); on 24 synthetic consults, 3/3 covers 72% of segments.

**A2.5 Pre-registered fallback for the 4-arm primary endpoints.** Decided at S2b, before any arm runs: if survivors reachable < 60, **T19-T21 are run on P-SYN** (T19 on S-E + S-D + S-A test units that pass both gates; T20 recall on S-D; T21 and T10/T11 on S-A and S-D) with the same thresholds, and the real P-4ARM is reported **descriptively only**. No threshold is loosened in either branch. Optional split design (default unified; decision for newcat-orch/Fable before S2b) as in v4: T19 on the larger STT-gated set, T20 recall and T22 floors on the speaker-gated subset only; needs research-mode drafts for gate-failed units (non-releasable, every item without doctor-span support is `h_unattrib`), labelled "role-layer evidence in the judge's view is not a doctor span".

**A2.6 Reporting per source and 3/3-only check [v5, ruling 1, R4 MUST 4-5].** Every reported result that depends on doctor spans (speaker gate pass rates, T5, T7-T11, T15, T19-T22, T24, T25, T28, h_* counters, `h_unattrib_rate`, `attribution_loss`, recall, the cohort hallucination gate) is reported:
(i) **union** (primary once arm (c) passes its Fable gate), broken down by `span_source` (3of3, armc, both) at the item and segment level, and by enrolled vs unenrolled treating doctor;
(ii) **3/3-only**, recomputed from scratch with arm (c) switched off (gate, spans, support, counters), as a sensitivity check. Units that pass only under the union drop out of (ii); items they supported only with `armc` spans become `h_unattrib` in (ii).
A primary claim stands only if (i) meets its threshold; a direction reversal between (i) and (ii) is flagged in the report beside the claim. If arm (c) does not pass its gate, (ii) is primary and (i) is not run on real audio.

## A3. The single threshold table (pre-registered with frozen prompt shas before the test split is scored)
| # | Metric | Population | Threshold | Role |
|---|---|---|---|---|
| T1 | Planted-item band accuracy; within-1 | S-E (encounter), S-N (note), test split | >= 0.8; >= 0.9 | gate, per rubric, per language mode |
| T2 | Spearman of planted level vs rating; median gap level 1 vs 5 | same | >= 0.8; >= 2 | gate |
| T3 | Off-target items within-1 of clean baseline (mapped secondaries exempt) | same | >= 0.9 | gate |
| T4 | Clean controls: median total; share with any item <= 2 | S-C | >= 36/45; <= 0.1 | gate |
| T5 | Invariance across voice and accent: change <= 1, on units passing both gates; noise/babble/reverb/far-field variants reported as excluded with exclusion rate | S-E, S-N variants | >= 0.9 | gate |
| T6 | Null path returned where evidence absent | planted silence/absent role | >= 0.8 | gate |
| T7 | Floors, exact: recall of planted violations; false passes. **[v5]** Includes S-V translator-added and translator-changed-dose traps | S-R, **S-V** | recall 1.0; 0 | gate (`rx-draft`) |
| T8 | instruction_recall; counselling_recall | S-D, arm 3 | >= 0.85; >= 0.80 | gate (arm 3) |
| T9 | final_position_fidelity; hedged-rendered-as-firm rate | S-D | >= 0.95; <= 0.05 | gate (arm 3) |
| T10 | Arm 4 adds any new item vs arm 3 (reorder/emphasis only) | S-A, all P-4ARM units | 0 per unit | hard gate (code) |
| T11 | Affect used only when >= 2 of 4 models agree; arm 4 effect = reorder/emphasis only | P-4ARM affect subset | 100% by code | hard gate |
| T12 | Silver coverage; band accuracy; within-1; kappa_w; total Spearman; offset | P-REAL test | >= 30%; >= 0.8; >= 0.9; >= 0.6 on >= 7 items, none < 0.4; >= 0.75; <= 0.5 | secondary |
| T13 | Silver precision on synthetic (consensus vs planted) | P-SYN test | >= 0.9 | prerequisite for silver |
| T14 | Voter-item eligibility accuracy vs planted | P-SYN dev | >= 0.7 | membership |
| T15 | STT gate: pass units' pipeline-vs-oracle within-1; false exclusion on clean TTS; on units also passing `speaker_gate@2` | P-SYN | >= 0.9; <= 0.1 | gate |
| T16 | Jev presence: detection; false alarm | P-SYN | >= 0.8; <= 0.15 | record-only until met |
| T17 | Clef-omni: decoy yes-rate; per-language `said` accuracy | P-SYN | <= 0.10; >= 0.8 (else language dropped) | membership |
| T18 | Fusion (bounded +/-1, never raises `[uid]`): detection gain; false-alarm change. E and N rubrics only, never Rx drafts | P-SYN S-E, S-N | >= +10 pts; <= +5 pts | else fused arm not shipped |
| T19 | 4-arm: A2 vs A1 total PDQI, median paired diff; Holm p over 3 contrasts | P-4ARM test | >= +2; < 0.05 | primary |
| T20 | 4-arm: A3 vs A2 instruction_recall gain; PDQI change | P-4ARM test | >= +0.10 abs, p < 0.05; PDQI diff lower bound >= -1 | primary |
| T21 | 4-arm: A4 vs A3 PDQI non-inferiority (lower 95% bound) | P-4ARM affect subset | >= -1 | primary |
| T22 | Floors in every arm | P-4ARM, P-SYN | per A4.2 | hard gate |
| T23 | Weekly drift kappa | live shadow | >= 0.6 per item | alert |
| T24 | Speaker gate precision, **3of3 source**: share of 3/3-doctor segments in passing units that are truly the treating doctor (truth sheet). **[v5]** Also reported for the union and per source | P-SYN dev+test, incl. S-V | >= 0.99 (3of3) | gate |
| T25 | `speaker_gate@2` recall on clean audio: share of clean units that pass; share of noise/far-field units correctly failed when truth attribution is < the frozen share. **[v5]** Reported per source and 3/3-only | P-SYN | >= 0.8; >= 0.95 | gate (else taus raised on dev) |
| T26 | Judge override (B.7): share of scored units with a logged +/-1 override | all scored | <= 10% | gate |
| T27 | Pilot report before S3 (A2.4): p_stt, p_spk (3/3-only and union), p_other, **[v5]** p_armc_inputs, p_armc_fire, doctor_conflict rate, enrolment coverage, Clef-omni/Jev cost; required pool for 120 and 300 at point and lower-CI rates | pilot (100) | stated, not thresholded | process gate (no S3 without it) |
| **T28a [v5]** | **Arm (c) segment precision**: share of `armc`-source segments (armc and both) that are truly the logged-in treating doctor, by truth sheet; metadata variants v1-v5 included; 95% CI reported | P-SYN dev+test with enrolled pseudo-doctors, S-V weighted in | **>= 0.99** | gate; without it `armc` spans count for nothing (3/3-only) |
| **T28b [v5]** | Arm (c) label false-accept rate on real impostor trials (enrolled doctor A's centroid vs consults of other doctors), at the frozen 0.65 / 0.05 and the independent-ranking rule; exact 95% CI reported | real enrolled doctors, record-only | point <= 0.2% | gate input to Fable (F, S2c) |
| **T28c [v5]** | Arm (c) miss rate (treating doctor enrolled and logged in, arm (c) not accepted) and independent-ranking agreement rate | P-SYN; real pilot | reported | record |
| **T28d [v5]** | Fallback correctness: share of units with missing arm (c) inputs (variants v3-v5, real units without centroid or full-window login) whose doctor spans equal the 3/3-only spans | P-SYN; pilot | 1.0 (code) | hard gate |
Registry bar: S7 `threshold` 0.8 maps to T1; all other rows are additional pass conditions. Synthetic (T1-T11, T13-T22, T24, T25, T28a, T28d) is the **primary endpoint** for promotion; silver (T12) is secondary and cannot promote or block by itself.
**[v5] Arithmetic note on T28b.** The record-only figure is 3 false accepts in 2,736 impostor trials = 0.11%, exact 95% CI 0.02-0.32%. The upper bound is above 0.2%; to bound the upper limit below 0.2% with <= 3 false accepts needs roughly 4,400 or more trials. T28b is therefore set on the point estimate, and the upper bound is printed beside it for the Fable gate and V's risk acceptance. These trials are label-versus-centroid trials, not segment precision against truth; T28a is the segment-precision proof.

## A4. Doctor-speaker, tape support and hallucination

**A4.1 Definitions.**
- *Draft item*: any atomic content item in any section of the Rx draft: medicine (and each of strength, dose, route, frequency, duration, instruction), investigation, referral, procedure, diagnosis, advice, counselling, warning, lifestyle, follow-up, contingency. System fields (header, date, doctor, patient identifiers) are not draft items.
- *Doctor span v2* **[v5, ruling 1, R4 MUST 1]**: a segment (turn_ids plus audio interval) is a doctor span **iff** it qualifies by (a) the **3/3 rule** or (c) **arm (c)** (A4.1a), or both, and no fail-closed condition in A4.1a or A4.1c applies.
  - (a) *3/3 rule (unchanged from v3)*: all three role voters agree the segment is the treating doctor: (1) the LLM role layer, (2) the Jev role cues, (3) the Clef-omni speaker check. 2/3, a missing voter output, an abstention, unknown, patient, attendant, translator, staff or other-clinician is non-doctor under (a).
  - (c) *arm (c)*: the segment lies on the diarisation label accepted by A4.1a.
  - **Source tag.** Every doctor span carries `span_source = 3of3 | armc | both`. Every draft item's support carries the set of sources of its cited spans, and the item's `support_source` is `both` if any cited span is `both`, else `3of3` if any is 3of3, else `armc`. Logged per item (R4 MUST 5) so a later arm (c) error can be traced to individual drafts.
  - The role layer remains the binding source of the *role vocabulary*; raw Nemotron slots never define a doctor span.
- *Tape support*: a draft order (drug, dose attribute, investigation, referral, procedure) is supported only if it cites at least one doctor span where the doctor states or affirms it; each dose attribute needs its own supporting doctor span (may be the same turn). **[v5]** Items supported only by `armc` spans are supported, and the release floors apply as normal (R4 MUST 5). A patient, attendant, staff, other-clinician or translator span, alone, is **unsupported** (A4.1c). A doctor affirmation of a patient-raised item is supported by the doctor's turn; the patient turn is context only.
- *Precedence*: where doctor spans conflict on an attribute, the **last firm doctor span** wins; hedged and since-reversed statements lose. A patient-, attender- or **[v5] translator**-sourced value never overrides. Draft value != final doctor value = dose-precedence error.
- *Alignment step `[uid]`*: (1) each draft item carries `cited_spans`; (2) code checks the span exists in this consult, is a doctor span (A4.1 v2), and the item's normalised attributes occur in the span in native or English text -> `aligned_code`; (3) only if code fails, a pinned check model may judge semantic match for free-text advice -> `aligned_llm` (counted, logged, bench-validated on S-R, S-D **[v5] and S-V**); (4) otherwise `unaligned`.
- *Hallucination*: any draft item, in any section, that is `unaligned`. Typed counters `h_drug`, `h_dose`, `h_order`, `h_other`. `clip_leak` = a cited span outside this unit's clip. `placeholder` = validator/regex hit in a printable field.

**A4.1a Arm (c): identity-verified doctor label [v5, ruling 1, R4 MUST 1, 3].**
Arm (c) works at the diarisation-label level, then tags that label's segments. **All** of the following must hold, else arm (c) is not used for the unit (fallback below):
1. **Enrolment.** The logged-in doctor has an enrolled voiceprint centroid (enrolment scorer: the Timbre voiceprint service per the D2/Timbre report; model id UNVERIFIED).
2. **Presence.** Pulse shows that doctor logged in for the consult's room slot for the **whole** consult window (R4 MUST 1). Partial coverage = missing input.
3. **Match.** Exactly one diarisation label L_c has cosine >= **0.65** to the logged-in doctor's centroid, with margin >= **0.05** over (i) the runner-up label in this consult against the same centroid and (ii) the runner-up *other enrolled* centroid for L_c (L_c must rank the logged-in doctor first among all enrolled voiceprints by that margin; R4 MUST 1). Whether the measured 0.65/0.05 figures used (i), (ii) or both is UNVERIFIED; T28 is run with both, as frozen here.
4. **Independent ranking.** L_c is ranked the most doctor-like label in the consult by **both** Clef-omni's own speaker probabilities and Jev's own role-cue probabilities (each ranking computed without the voiceprint).
5. **No contradiction.** No segment of L_c that is to be tagged `armc` is labelled patient, attender, translator, staff or other-clinician by any of the three role voters. Contradicted segments are dropped from arm (c) (they stay non-doctor unless they pass 3/3, which a contradiction rules out); if contradicted seconds exceed 20% of L_c's seconds, arm (c) is not used for the unit (threshold may only be lowered, i.e. made stricter, at the dev fit).
6. **Outputs present.** Presence, the voiceprint scorer, Clef-omni and Jev all produced output for the unit.
7. **T28 gate.** T28a is met on P-SYN and Fable has passed arm (c) (F, S2c). Before that, arm (c) runs record-only and `armc` spans count for nothing.
**Fallback (fail closed).** If any of 1-6 is missing or fails, doctor spans for the unit are exactly the 3/3 spans; arm (c) never turns a missing input into a pass (T28d). The reason is logged: `armc_no_centroid | armc_no_login | armc_partial_login | armc_no_match | armc_margin | armc_rank | armc_contradiction | armc_no_output`.
**Doctor conflict.** If any 3/3 segment lies on a label other than L_c (so two different voices are each called the treating doctor; the margin rule in 3 means L_x is not a split of L_c), the unit fails `speaker_gate@2` with reason `doctor_conflict` (unscored, excluded, counted). Rate reported in the pilot (T27); policy is an open decision (G11).
**Measured, record-only (reported by the lead, not re-measured here).** On 60 real consults arm (c) cut consults with zero confident doctor speech from 37 to 15; voiceprint false accepts were 3 in 2,736 impostor trials at 0.65/0.05 (149 consults, 20 doctors); the independent-ranking check held in 48 of 51 (94%, 95% CI 84-99%). Arm (c) is identity verification of one named, logged-in doctor, which is a different claim from voiceprint role attribution (VP-ACC-01 failed the latter).

**A4.1b Banned shortcuts [v3, amended v5, R4 MUST 1].** By name, none of these may define a doctor span anywhere in this spec, the plan or the code: *role-layer-only*, *two-of-three majority*, *role layer plus one cue*, *Jev-plus-Clef without the role layer*, *Nemotron slot*, *any-voter-says-doctor*, and **[v5] *voiceprint for role attribution, or voiceprint identity without every A4.1a condition*** (the v4 bare ban on "voiceprint" is replaced by this wording; nothing else is loosened). Both the 3/3 rule and arm (c) are measurement-side rules applied identically to all four arms, so they do not favour arms fed the Jev/Clef layers (A1.3b still removes Jev/Clef-omni as scorers for those arms).

**A4.1c Fluid rooms [v5, ruling 5].**
- **No assumed speaker count.** Diarisation is never constrained to two (or any fixed number of) speakers; a consult may hold the doctor, a covering or junior clinician, nurses or staff, a translator, the patient and any number of attenders, arriving and leaving. Nothing in the gate or the counters assumes "the other speaker is the patient".
- **Role vocabulary** (role layer, Jev, Clef-omni mapped by a fixed table): `treating_doctor`, `other_clinician`, `staff`, `translator`, `patient`, `attender`, `unknown`. Only `treating_doctor` can qualify under (a); arm (c) defines the treating doctor as the logged-in doctor.
- **Non-treating voices never yield orders.** A draft item whose only supporting spans are `other_clinician`, `staff`, `translator`, `patient`, `attender` or `unknown` is `unaligned` (a hallucination by type), never supported, in any arm.
- **Translator rule.** A translator span restating the doctor may be cited as `relay` support *beside* a doctor span for the same item (it helps alignment when the doctor span is in another language), but never alone: no doctor span, no item. If the relayed value differs from the doctor's final firm value, the doctor's value wins and the event is logged `relay_conflict`; a draft carrying the translator's value is a precedence error. A translator-only item counts as `unaligned` (h_*), not `h_unattrib`.
- Other clinicians: if a covering/junior clinician is the one logged in, arm (c) names that clinician as the treating doctor; if they are not logged in and pass 3/3 while another label passes arm (c), the unit is `doctor_conflict` (A4.1a).

**A4.2 Floors, bound to the definitions.** Per unit, hard (any breach -> `releasable=false`; PDQI never offsets): `h_drug`=0; `h_dose`=0; precedence errors=0; `clip_leak`=0; validator pass; `placeholder`=0. **Per-unit flag** `halluc_flag` (any of h_drug/h_dose/h_order/h_other > 0) and **cohort gate**: mean(h_total) <= 0.2 on the point estimate **and** bootstrap 95% upper bound <= 0.3 when N >= 100 (below that: "underpowered").
**`h_unattrib` [v4, amended v5].** In a unit that passes both gates, a draft item whose attributes are found only in a span the role layer labels `treating_doctor` but that is **not a doctor span under A4.1 v2** (fails 3/3 and is not on an accepted arm (c) label) is `unattributed`. It sets `releasable=false` but is excluded from h_drug/h_dose/h_order/h_other, `halluc_flag` and the 0.2 cohort mean, and is reported as `h_unattrib_rate` beside `attribution_loss`. **[v5]** Both are reported per source (A2.6): under the union, and under 3/3-only (where `armc`-only items move into `h_unattrib`). Items supported only by non-treating roles (A4.1c) or by no span stay `unaligned` and count as hallucinations. Exact on S-R and S-V.

**A4.3 Doctor's-words recall (code, beside the PDQI mean, never inside it).** `instruction_recall`, `counselling_recall`, `final_position_fidelity`, `strength_fidelity`, `priority_fidelity` as in v4. Recall is split three ways: `recall_oracle` (draft vs the true script), `recall_pipeline` (draft vs the doctor spans under A4.1 v2), and `attribution_loss` (truth instructions whose true span is not a doctor span). **[v5]** `recall_pipeline` and `attribution_loss` are reported per source and under 3/3-only (A2.6). Matching is "LLM matches against canonical keys, code counts"; precision of the draft = 1 - h_total share.

**A4.4 Truth sheet (synthetic).** Every doctor instruction: id, category, canonical key, span (turn_ids), strength, reversal chain, emphasis count, priority rank; every patient concern and every prescription attribute. **[v5]** Plus the speaker roster with per-segment true role (A4.1c vocabulary) and true identity (pseudo-doctor id), the logged-in and enrolled pseudo-doctor per metadata variant, and every translator relay with the doctor turn it restates. Written by code from the planted plan, independent of any judge. On real consults the list is the machine-extracted silver version (A2.3).

**A4.5 Patient-affect rule (arm 4).** Affect may only **reorder or emphasise** items that already exist in arm 3, and only when >= 2 of emotion2vec, WavLM, Odyssey, Clef agree on the state. Code check per unit: arm 4 items minus arm 3 items must be empty on normalised content, including follow-up and counselling lines; any new item is a breach (T10). Affect never creates an order. **[v5]** Affect windows are taken from `patient` segments only (A4.1c); affect on attender, translator or staff speech is ignored.

## A5. STT gate
See section E (unchanged).

## A6. Speaker gate `speaker_gate@2` [v3, amended v5, ruling 3, R4 MUST 3]
Beside the STT gate (A5). Without attributable doctor speech no draft item can be tape-supported, so the unit cannot be judged. **[v5]** This is a new gate version: `speaker_gate@1` (3/3-only, v4) is kept as the sensitivity gate for A2.6(ii).
- **Definition.** Per unit, on doctor spans per A4.1 v2: `doctor_conf_seconds` = seconds of doctor spans (union); `doctor_conf_segments` = their count; **[v5]** `doctor_conf_share` = `doctor_conf_seconds` / seconds of the union of (segments the LLM role layer labels `treating_doctor`) and (segments of the accepted arm (c) label), so the share cannot exceed 1. `speaker_gate@2 = pass` iff `doctor_conf_share >= tau_share` AND `doctor_conf_seconds >= tau_sec` AND `doctor_conf_segments >= tau_n` AND the three role voters produced output AND no `doctor_conflict`. **[v5]** If arm (c) is used for the unit, Presence and the voiceprint scorer must also have produced output (A4.1a.6); if arm (c) inputs are missing, the gate is computed on 3/3 spans only (fallback, never a pass by default).
- **Taus [v5, ruling 3].** tau_share 0.6, tau_sec 45, tau_n 5 are **floors**: the P-SYN dev re-fit for gate@2 and the real shadow week may only **raise** them; frozen in the prereg before test; never lowered, never loosened to reach P-4ARM or P-REAL counts. Fit targets: T24, T25, T28a.
- **On fail.** Unit unscored with reason `speaker_unattributable` or **[v5]** `doctor_conflict`. FreeScript output is "no attributable doctor speech, not releasable". The unit is excluded from the hallucination counters (numerator and denominator), from every bench, from P-4ARM and from the drift sample.
- **Real-audio shadow week.** The gate runs one week in shadow on real consults (log only) and reports pass rate by room, recording condition **and [v5] span-source tier and enrolled vs unenrolled doctor** before the taus are frozen. It runs **before** the pilot (A2.4 step 2). T24 and T28a on real audio are **unmeasured** (no labels) and stated as such in every report; they are proven on synthetic audio only. Real-audio arm (c) evidence is T28b/T28c only.
- **Reporting.** Exclusion rate by room, recording condition, span-source tier and enrolment, beside the STT-gate exclusion rate; scores are never read as covering excluded units.
- **Consequences on the benches.** T5 and T15 are computed on passing units; noise variants are reported as excluded (only the gate's behaviour on them is scored, T25). P-4ARM requires a passing `speaker_gate@2`; survivors are counted before S3.
- **Bias note [v5, R4].** Consults of unenrolled doctors and of doctors not logged in can pass only under 3/3, so union survivors over-represent enrolled, logged-in doctors. Survivors are stratified by enrolment (A2.2, A2.3) and the 3/3-only sensitivity (A2.6ii) is always reported.

---
# B0. What the R target is now
`pdqi9-rx-draft` scores the ETA-to-FreeScript Rx draft, whichever arm produced it (A2.3). The judge sees the consult transcript (native + English), roles, and the printed draft; it never sees the Encounter Brief, the arm label **[v5] or any span-source tag**. The doctor's-words and affect layers are inputs to the generator, not to the judge. Recall metrics and floors (A4) are computed by code and printed beside the PDQI mean. E (encounter) and N (CDMSS note) are unchanged in scope. In the anchors below "doctor span" has the A4.1 v2 meaning.

# B. Item by item
Targets: **N** = CDMSS note, **E** = newcat encounter, **R** = ETA-to-FreeScript Rx draft. Evidence key: T transcript (native + English), Ro roles/diarised turns, Au audio-only signal, Rx Pulse prescription, F draft fields.

### B.1 Up-to-date
(a) Today: care consistent with current standards and latest results; the judge has only the note, so it is mostly knowledge recall.
(b) Anchors. N: 1 = obsolete or withdrawn practice; 3 = standard but no recent result referenced; 5 = current practice, relevant results cited. E: 1 = doctor gives advice contradicting current guidance or ignores results the patient brought up; 3 = advice standard; 5 = advice current and uses reported results. R: 1 = draft adds, substitutes or modernises anything beyond what the doctor said (tape-unsupported content); 3 = draft as said, nothing added; 5 = as said, with any result the doctor discussed reflected.
(c) Evidence: N note fields; E T+Ro+Rx; R F+T. A guideline-version table is UNVERIFIED and not available, so the judge may return null `not_assessable`.
(d) For R rate only "does not add or modernise beyond the tape"; null path expected.
(e) Failure modes: stale model recall; penalising the draft for the doctor's choice. Guard: rate against the transcript for R; require a cited statement for any rating below 3.

### B.2 Accurate
(a) Today: true, free of incorrect information.
(b) Anchors. N: 1 = clear factual or dosing error; 3 = minor slips; 5 = no errors (ETA-origin notes also checked against the tape). E: 1 = doctor states wrong facts, a patient misunderstanding is left uncorrected, or the Rx contradicts what was said; 3 = small imprecision; 5 = correct and misunderstandings corrected. R: 1 = several items imprecise against the doctor spans though each is tape-supported; 3 = traceable with some missing detail; 5 = every item traceable and exact. Floors are not folded in.
(c) N: note + (ETA origin) T. E: T+Ro+Rx. R: F+T with turn-level alignment, floors (deterministic).
(d) For R the floors (A4.2) and the judge are two separate fields: `floor_result` (code) and `accurate_residual` (judge, 1-5, precision only). Tape support per A4.1 v2 (doctor span = 3/3 or arm (c); non-treating roles unsupported, A4.1c).
(e) Failure modes: weakest agreement item; ASR/translation errors scored as draft errors. Guard: cite the tape turn; show the native turn for any drug or dose; English vs native disagreement on a cited span -> null `source_conflict`. Role guard: a dose attributed to the patient, attender **[v5] or translator alone** is not a doctor instruction.

### B.3 Thorough
(a) Today: complete, all issues of importance to the patient; CDMSS rates against risk.
(b) Anchors. N: 1 = higher-risk presentation left without red-flag screen; 3 = covers what the presentation needs; 5 = with relevant negatives and safety-net. E: 1 = patient-raised problems mostly unaddressed; 3 = main complaint addressed; 5 = every patient-raised concern answered or deferred explicitly. R: 1 = most things said in the room missing from the draft; 3 = main regimen captured; 5 = everything the doctor said to do is in the draft, nothing the doctor did not say.
(c) E: patient turns and doctor turns by role. R: T versus F coverage.
(d) R adds code metrics beside the mean: instruction_recall, counselling_recall, final_position_fidelity (A4.3). "Thorough" means coverage of what was said, not of exam, records or history. **[v5]** In fluid rooms, concerns raised by attenders count as patient-side concerns for E; instructions from non-treating voices are not in the R coverage denominator.
(e) Failure modes: thin evidence mistaken for thin care (absence claims UNVERIFIED; cap at 3 with `absence_unverified`); incomplete audio window. Guard: abstain on incomplete window.

### B.4 Useful
(a) Today: relevant, valuable information for a downstream reader; CDMSS: gives what is needed for this problem, including safety-net.
(b) Anchors. N: 1 = reader cannot act on it; 3 = enough for continuity; 5 = reader knows diagnosis, plan, follow-up and what to watch for. E: 1 = patient leaves without diagnosis or plan; 3 = plan and follow-up stated; 5 = diagnosis in plain words, plan, follow-up and when to return are all stated. R: 1 = unusable as a printed prescription (ambiguous, unfinished); 3 = usable after small edits; 5 = printable as is, a pharmacist or the patient can follow it.
(c) N note fields. E T+Ro (doctor safety-net statements). R F, and printable-field check (placeholders deterministic).
(d) For R, "no placeholder text in printable fields" is a deterministic floor; usefulness rates the rest. E uses the audio only to know language match.
(e) Failure modes: rewarding length; auto-generated leaflets credited. Guard: keep the CDMSS leaflet exclusion; rate on clinician-authored or said content only.

### B.5 Organized
(a) Today: well-formed, structured to follow the clinical course.
(b) Anchors. N: 1 = jumbled; 3 = standard sections; 5 = course reads in order. E: 1 = no discernible flow, topics repeatedly reopened; 3 = history, assessment, plan identifiable; 5 = clear sequence, explicit summary before the plan. R: 1 = items in the wrong fields or unreadable grouping; 3 = fields filled correctly; 5 = grouped logically (diagnosis, medicines by schedule, tests, advice, follow-up) with items in the doctor's priority order within each group.
(c) N/R fields (render from the native print, not our template: in the 12 Oct study organization reflected the render template). E: role-tagged turn order, segment labels (judge), deterministic count of topic reopenings.
(d) R reports `priority_fidelity` (A4.3) beside the mean. E is partly deterministic. Audio signals such as overlap are not rated here.
(e) Failure modes: render-template effect; ASR segmentation. Guard: render all arms identically; for E judge only the English with role tags.

### B.6 Comprehensible
(a) Today: clear, no ambiguity.
(b) Anchors. N: 1 = unreadable or ambiguous; 3 = understandable with effort; 5 = clear. E: 1 = patient clearly confused (asks again, says not understood) and not resolved; 3 = clear to a clinician; 5 = plain language in the patient's language, confirms understanding. R: 1 = ambiguous dose or schedule; 3 = clear to a clinician; 5 = clear to the patient.
(c) E: T native script + English, Ro; language match is a deterministic count; Au only to explain, not to rate.
(d) New for E: patient comprehension evidence (re-asking, teach-back). ASR confidence measures recording quality, not doctor clarity; recorded as `evidence_quality`. **[v5]** A translator relaying is evidence of language accommodation, not of confusion; comprehension cues are read from patient and attender turns.
(e) Failure modes: code-switching scored as unclear; poor audio scored as poor explanation. Guard: judge reads native text; `evidence_quality=poor` makes the item null.

### B.7 Succinct
(a) Today: brief, no redundancy. CDMSS: terse is not a defect; length is neither virtue nor fault.
(b) Anchors. N: 1 = padded or duplicated; 3 = some redundancy; 5 = brief, no repetition. E: 1 = long digressions or repeated explanations carrying no information; 3 = some repetition; 5 = focused (duration alone never lowers it). R: 1 = narrative padding or duplicate items; 3 = some narrative where a field would do; 5 = field-level, no duplication.
(c) N/R fields; E turn texts with repetition measured in code, plus talk-time share.
(d) **Does not transfer to E as written.** Replaced by *efficiency of talk*: doctor talk share, patient uninterrupted speaking, repetition ratio, digression share. Doctor talk share comes from **doctor-span seconds under A4.1 v2 [v5]**, reported per source and 3/3-only (A2.6); voiceprint for role attribution stays barred (A4.1b). **[v5]** "Patient" talk excludes attender, translator and staff seconds. Code computes the numbers and applies the fixed bands (frozen at preregistration) and writes the 1-5 value; the judge only adds a null/override flag with a cited reason, bounded to +/-1, every override logged and capped at 10% of scored units (T26; above the cap the rubric version is held). Interim: null `role_source_pending`. For R expect long narrative; printable fields are field format.
(e) Failure modes: length bias; a short unsafe consult called efficient. Guard: succinct never offsets a floor failure; sub-metrics, not a verdict on the doctor.

### B.8 Synthesized
(a) Today: reflects the author's understanding and ability to plan; CDMSS: a short correct assessment counts.
(b) Anchors. N: 1 = no assessment or ignores documented findings; 3 = assessment present, loosely tied; 5 = findings drive diagnosis and plan. E: 1 = no verbalised assessment, plan unrelated to findings; 3 = diagnosis stated and plan fits; 5 = doctor links history/exam to diagnosis and plan and involves the patient. R: 1 = items unrelated to stated diagnosis; 3 = diagnosis and regimen coherent; 5 = regimen and investigations clearly follow from the diagnosis said.
(c) E T+Ro; R F+T. (d) For R the item is "coherence of draft with diagnosis said" (shown label "Coherent with consult"; key unchanged).
(e) Failure mode: eloquence rewarded. Guard: require a cited doctor turn naming the link; style-blind judging.

### B.9 Internally consistent
(a) Today: no part contradicts another; within the note only (v2 blank-note rule).
(b) Anchors. N: 1 = direct contradiction (dx vs drug); 3 = minor mismatch; 5 = none. E: 1 = doctor contradicts self, or spoken plan vs Rx disagree on a drug, dose or follow-up; 3 = minor wobble corrected later; 5 = consistent, spoken plan = Rx. R: 1 = draft contradicts itself (duplicate drug with different dose, dx vs regimen); 3 = minor; 5 = none.
(c) E: reuse the encounter_vs_record rubric output (draft, threshold 0.5), do not rebuild. R: F only, validators.
(d) Cross-artefact checks (draft vs tape) belong to accurate, so one error is not counted twice. Deterministic duplicate/contradiction checks first; the judge adds only what code cannot.
(e) Failure modes: blank sections as contradictions (fixed in v2); double counting with accurate. Guard: "one issue, one item".

# C. CDMSS gaps when the note came from ETA/FreeScript
Unchanged from v4: (1) add `note_origin` (UNVERIFIED whether the row carries one); (2) pass the masked transcript for ETA-origin notes (Bedrock only); (3) placeholder floor upstream; (4) attribute draft defects to the draft, edits to the clinician; (5) leaflet exclusion extends to FreeScript narrative blocks; (6) bench @2 against @1 if the judge model changes.

# D. Rubric ids, versions, and the S7 registry fit
| id | status | unit | scorer J\* | notes |
|---|---|---|---|---|
| `pdqi9-note@1` | production (retro-label) | OPD note | frozen `OPD_AUDIT_SYSTEM` sha12 0af0e136a699, Gemini | label what runs today; no behaviour change |
| `pdqi9-note@2` | draft | OPD note | Gemini 2.5 Pro | Stetson-delta anchors; `note_origin`, optional transcript, evidence ids, null path; doctor-origin notes stay on @1 until @2 passes T1-T6 and the lab regression |
| `pdqi9-encounter@0` | draft | consult | Gemini 2.5 Pro + code metrics | item 7 code-banded on A4.1 v2 doctor seconds |
| `pdqi9-rx-draft@0` | draft | FreeScript draft | Gemini 2.5 Pro + code floors and recall | `releasable`, recall and **[v5] `support_source`** are code outputs, never in the mean |

**S7 schema check.** The Scribe `rubric_result` schema and registry JSON schema were not in the v4 inputs, so the field mapping is **UNVERIFIED**; confirmed facts are as listed in v4 (versioned JSON, draft/production status, per-rubric threshold, engines `llm` and `code`, bench set kinds, `lab:true` drafts, `rubric_run` jobs, promotion by repo change with a bench report).
**Existing-row safety (CDMSS).** Unchanged: `@2` writes a parallel row tagged `pdqi9_rubric`; no re-score of existing notes (count UNVERIFIED).

**Concrete rubric file (proposal; field names beyond the confirmed facts are UNVERIFIED).**
```json
{
  "id": "pdqi9-rx-draft",
  "version": "0.0.2",
  "status": "draft",
  "unit": "consult",
  "engines": ["llm", "code"],
  "judge_pin": {"model": "gemini-2.5-pro", "temperature": 0, "served_verified": true, "prompt_sha": "<set at freeze>"},
  "inputs": ["transcript_native", "transcript_en", "role_layer", "rx_draft_printed"],
  "items": ["up_to_date","accurate","thorough","useful","organized","comprehensible","succinct","synthesized","internally_consistent"],
  "scale": {"min": 1, "max": 5, "null_allowed": true, "null_reasons": ["not_assessable","no_source","source_conflict","stt_quality","speaker_unattributable","doctor_conflict"], "min_rated": 7},
  "evidence_required": ["accurate","thorough","internally_consistent"],
  "doctor_span": {
    "rule": "3of3 OR armc (A4.1 v2)",
    "armc": {"cosine_min": 0.65, "margin_min": 0.05, "margin_over": ["runner_up_label","runner_up_enrolled"], "independent_rank": ["clef_omni","jev"], "presence": "full_window", "contradiction_max_share": 0.2, "enabled": "<false until T28a + Fable gate>"},
    "fallback": "3of3",
    "span_source": ["3of3","armc","both"]
  },
  "code_outputs": {
    "floors": ["h_drug","h_dose","precedence_error","clip_leak","placeholder","validator","halluc_flag"],
    "cohort_gates": {"halluc_mean_max": 0.2, "halluc_upper95_max": 0.3},
    "attribution": ["h_unattrib","h_unattrib_rate","attribution_loss","support_source","relay_conflict","armc_fallback_reason"],
    "recall": ["instruction_recall","counselling_recall","final_position_fidelity","strength_fidelity","priority_fidelity"],
    "report_views": ["union_by_source","3of3_only"],
    "releasable": "all floors pass and h_unattrib = 0"
  },
  "arithmetic": "code: mean of rated items, (mean-1)/4*100, same as pdqi9Score",
  "bench": {
    "set_name": "automated reference (synthetic + silver + STT gate + speaker_gate@2)",
    "components": ["P-SYN strata S-R,S-D,S-A,S-C,S-V (primary)", "P-REAL silver per A1 (secondary)", "stt_gate=pass", "speaker_gate@2=pass"],
    "primary_metric": "T1 band accuracy on planted truth",
    "threshold": 0.8,
    "also_required": ["T2","T3","T4","T5","T6","T7","T8","T9","T10","T11","T13","T14","T15","T24","T25","T26","T28a","T28d"],
    "prereg_sha": "<set at freeze>"
  },
  "lab_only": true
}
```
`pdqi9-note@2` and `pdqi9-encounter@0` use the same shape with their own strata and without the recall block. Registry rulings needed (UNVERIFIED): (1) automated bench sets count toward S7 promotion; (2) where `code_outputs` lives in a `rubric_result`; (3) whether "draft" is a unit or a layer of the consult.

# E. A5 STT quality gate (the speaker gate is A6)
Unchanged from v4. Unintelligible transcripts are **excluded, never scored low**. `stt_gate = pass | marginal | fail` with reason codes; `fail` -> unscored `stt_quality`, removed from all benches, counted by room/doctor/language. Signals: empty/unintelligible/low-confidence share (Sarvam confidence UNVERIFIED), language-ID flips inside a turn, speaking-rate plausibility, speech-activity share, diarisation sanity (**[v5]** role layer present and at least one `treating_doctor` and one patient-side voice above minimum turns/seconds; no cap on speaker count), second-STT agreement (UNVERIFIED), native-vs-English length outliers, `window_incomplete`. Thresholds fitted on P-SYN, frozen, then one shadow week on real consults. Limit: a fluent but wrong translation can pass.

# F. Bench staging (single plan)
| Step | What | Needs |
|---|---|---|
| S0 | Build script generator, truth sheets (incl. **[v5]** speaker rosters, relays, metadata variants), code twins; text-only oracle run of the three rubrics and A4 counters | no audio |
| S1 | Voice P-SYN (204) **[v5] and the pseudo-doctor enrolment sets**; run through the diagnostics-rig pipeline (never a hospital kiosk, ehrc-*, the ICU Mac or ORB2); flag `synthetic=true` | ElevenLabs sign-off (synthetic text only); rig slot |
| S2 | Fit and freeze the STT gate (E), `speaker_gate@2` and `@1` (A6, taus raise-only), the arm (c) contradiction share (A4.1a.5, stricter only) and voter-item eligibility (A1.3c) on dev; **[v5]** compute T28a, T28c, T28d on P-SYN | none |
| S2b | **[v5 order]** (1) real-audio shadow week (A5, A6; may raise taus; arm (c) record-only); (2) taus frozen; (3) 100-consult pilot (A2.4) with both p_spk figures, arm (c) rates, conflict rate, enrolment coverage, cost (T27); (4) T28b/T28c on real impostor trials; (5) required pool numbers; (6) A2.5 fallback decision | Fable gate for the Clef-omni step on real audio |
| **S2c [v5]** | **Fable ship gate on arm (c)** (ruling 2, R4 MUST 6): inputs T28a (>= 0.99), T28b with CI, T28c, T28d, pilot union vs 3/3-only rates, enrolment bias. Pass -> union primary, 3/3-only as check. Fail -> 3/3-only primary, arm (c) stays record-only. **V** separately accepts or rejects the clinical risk of a ~0.11%-class false-accept rate | Fable 5.1; V |
| S3 | Draw P-REAL (300) and P-4ARM (120) under the S2c outcome; freeze the uid list hash; silver panel per A1 | Fable 5.1 gate for real audio into Clef-omni and real transcripts to Jev; Gemini approval |
| S4 | Pre-register A3 and prompt shas; run test once; bench each rubric; run the four arms; report per A2.6 | scribe-mcp-lead ruling on automated benches |
| S5 | Shadow with weekly drift check (A1.6) | gating-lead merge |
Limit stated on every report: agreement with planted truth and machine consensus, not clinical validity.

# G. Open decisions for V / Fable
1. Keep CDMSS risk-relative anchors (`@1`) and bench `@2` against both (recommended).
2. Accept null / 7-of-9 unscored rule.
3. Automated benches count for S7 promotion, with the claim limit.
4. One-line approvals: ElevenLabs (synthetic text only), Gemini on consult transcripts, Fable gate for real audio to Clef-omni.
5. Read the FreeScript generator model family from artefact metadata before S1 (A1.5).
6. Freeze tau_share / tau_sec / tau_n (A6, floors 0.6 / 45 s / 5, raise-only) and the far-field room list after S2b step 1.
7. **[v5] Operational consequence for V.** Today about 62% of real consults (37 of 60, CI 48-74%) have no confident doctor segment under 3/3-only; with arm (c), record-only, about 25% (15 of 60, CI 15-38%). Those consults cannot yield a releasable draft; the remaining fix is upstream (room microphones, far-field capture, enrolment coverage). The room at 9 of 10 zero under 3/3 is **still not named** in any input read (UNVERIFIED); newcat-orch to fill it from consult-audit-lead's breakdown.
8. Split vs unified 4-arm design before S2b (A2.5; default unified). Spend cap for the pilot and pool walk.
9. **[v5] Fable ship gate on arm (c)** at S2c, before S3 (T28).
10. **[v5] V's clinical-risk acceptance** of the arm (c) false-accept class (0.11% measured, exact upper 95% bound 0.32%).
11. **[v5] `doctor_conflict` policy.** Default: fail the unit (A4.1a). Revisit only with the pilot conflict rate in hand; any change is a new gate version and re-runs S2-S2b.
12. **[v5] Enrolment drive.** Doctors without a voiceprint (7 of 20 per the D2/Timbre report, as relayed in R4; not re-read) can pass only under 3/3; enrolling them is the cheapest lever on p_spk. Owner: V.
Literature: Stetson et al., Appl Clin Inform 2012;3:164-174 (UNVERIFIED reliability figures); Palm et al. 2025 (PMC12586549) and PDSQI-9 (arXiv 2501.08977), supporting separate floors.
