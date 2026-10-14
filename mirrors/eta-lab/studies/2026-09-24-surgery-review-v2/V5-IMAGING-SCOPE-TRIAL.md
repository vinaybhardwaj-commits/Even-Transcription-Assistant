# V5 wording DRAFT: imaging scope (fleet, 24 Sep 2026, ruling 164)

V (via Fable): plain CT is a procedure proposal; MRI, X-ray, echo, treadmill, calcium score stay out. v4 (b2ebc86f5a74) stays frozen. v5.py = v4 + (a) an explicit procedure list and imaging scope in BOTH questions, (b) category option `imaging_plain_ct` (page label "imaging: plain CT"), (c) an imaging clause for "described" (for a CT: what it is for, what it will show, how it is done or prepared for). WORDING_VERSION `u9-v5.0-draft5`, UNFROZEN (check_frozen refuses). Stage (b) and detail questions are v4's, unchanged, so answers stay comparable with V's v3/v4 ratings.
SCOPE AS DRAFTED (pending Fable/V): IN = operations, interventions, minor outpatient procedures, PLAIN CT, CT ANGIOGRAPHY. OUT = CT WITH contrast of any other body part (e.g. abdomen, neck), MRI, X-ray, ultrasound, echo, ECG, treadmill, calcium score, blood tests. OPEN QUESTION: is a non-angiographic CONTRAST CT in or out? V said "plain CT"; eta-refuter-2 found a real consult (W03) whose proposal is a contrast CT, conditional (#573); hist-miner flags contrast_mentioned (#569). Flip = one sentence in each question and a new hash.

## Iterations (each measured on the invented fixtures; then real text)
draft 1 (scope clause only): fixtures 12/12 but a well-explained contrast abdomen CT still read 'described' 0.77. draft 3 (exclusions first): fixture fixed but real text regressed (V3-11 0.70 -> 0.28, V3-10 0.74 -> 0.42): too strict. draft 4 (explicit short list): same regression (V3-10 0.18, V3-11 0.10): the list dropped minor procedures / endoscopy. draft 5 (full procedure list incl. minor outpatient + endoscopy/biopsy/injection, then the exclusions): no regression.

## Invented fixtures (16; no patient text; D1a-cleared; expectations follow the scope; 2 runs each)
v5 draft 5 matches on 16 / 16; v4 on 10 / 16 (v4 counts echo 0.96/0.95, treadmill 0.77/0.95, blood tests 0.73/0.69, an optional MRI brain 0.94/0.93 and a contrast abdomen CT 0.93/0.95 as procedures). v5: plain CT chest / head, CT angiogram (heart): named and described >= 0.96; CT named only: 0.88 / 0.03; CT described without a name: 0.11 / 0.84; CT report reviewed, no new scan: 0.91 / 0.03 (a report read is named-only; proposal-ness is the status question); contrast abdomen CT: 0.08 / 0.24 (OUT); MRI brain optional, MRI knee, X-ray, echo, ultrasound, treadmill, blood tests: all <= 0.08 on both.
(The first version of the septoplasty control failed for both wordings because the fixture had its speakers swapped: a fixture bug.)

## Real de-identified text (deduplicated by text overlap; 12 shipped + 4 distinct imaging-mention consults + 10 negatives; 2 runs each)
| item | v4 named / described | v5 (draft 5) |
|---|---|---|
| V3-01 (CT angiogram) | 0.98 / 0.43 | 0.96 / **0.78** (v4's under-call fixed) |
| V3-12 (CT angiogram) | 0.97 / 0.52 | 0.95 / 0.78 |
| V3-02 (described, not named) | 0.06 / 0.97 | 0.07 / 0.96 |
| V3-03 (MRI brain + a repositioning manoeuvre) | 0.59 / 0.23 | **0.29** / 0.82 (MRI is OUT: not named; the manoeuvre is a described minor procedure) |
| V3-09, V3-10, V3-11 | 0.48 / 0.84, 0.97 / 0.73, 0.08 / 0.69 | 0.85 / 0.79, 0.97 / 0.60, 0.10 / 0.71 |
| W03 (ONE consult: plain CT = history, a CONTRAST CT proposed, conditional) | 0.96 / 0.28 | 0.92 / 0.42 (contrast CT out) |
| negatives (10) | max 0.22 / 0.20 | max 0.19 / 0.10 |
CORRECTION: an earlier note said "four CT-mention consults (W03 W36 W37 W38)". eta-refuter-2 showed they are ONE consult at different offsets (n = 1); the trial now deduplicates by text overlap.
NOT TESTED on real text: a real PLAIN-CT proposal with ground truth (none exists yet: W03's plain CT is history; hist-miner's 20-hit sample is with eta-refuter-2) and the MRI / X-ray / echo exclusion beyond V3-03 (the pool's other real MRI/X-ray consults are staff case talk). The invented fixtures cover both; real-text confirmation waits for labels.
Next: eta-refuter-2 trial-checks the four fixtures they named (V3-01, V3-03, one plain-CT positive, one CT-report-reviewed negative) and reports P(yes) per question; freeze only after that, the contrast decision and Fable's OK.

## Real CT fixtures from hist-miner's v2 sample (eta-refuter-2 #607; v5 draft 5; 2 runs; v5_fixtures.py)
Fixtures are +-90 s passages, de-identified by deid_gpu first; the sample has NO speaker labels (every turn = 'Other'), which hurts the status / raised_by answers.
| fixture (pool #) | label (eta-refuter-2) | named | described | status (P) | category |
|---|---|---|---|---|---|
| F02 (23 Sep, ENT) | CT advised now | 0.83 / 0.84 | 0.12 / 0.17 | proposed_now (0.93 / 0.92) | imaging_plain_ct |
| F11 (= V3-09 / W95) | CONDITIONAL plain CT | 0.79 / 0.82 | 0.26 / 0.21 | mentioned_only (0.67 / 0.66) | imaging_plain_ct |
| F06 | history (CT thorax done, report read) | 0.94 / 0.94 | 0.11 | **proposed_now (0.53 / 0.58)** | operation |
| F07 | history (CT neck) | 0.45 / 0.41 | 0.05 | history (0.58 / 0.52) | intervention |
| F10 | history (patient reports a done CT) | 0.17 / 0.19 | 0.02 | history (0.99) | imaging_plain_ct |
| F15 | history (CT done earlier) | 0.70 / 0.69 | 0.11 | mentioned_only (0.40 / 0.46) | imaging_plain_ct |
Against the bar (both positives named >= 0.5 with status proposed / conditional; 4 history negatives not proposed; 0 of 4 as proposed): NOT MET. (1) F06 is called proposed_now, but weakly (0.53-0.58; the passage has no speaker labels and only +-90 s of context). (2) v5's status question has no 'conditional' option: F11's conditional CT reads mentioned_only ("a possibility for later"), which is the v4 criterion working as written, not a v5 change; whether a conditional plain CT counts as a proposal is Fable's ruling-164 question (V3-09). (3) F02 passes; F07 / F10 / F15 pass (history or mentioned-only, never proposed).
Named on history CT passages is 0.4-0.94 by design (named includes history); the status question does the work, as eta-refuter-2 said.

## LEAKAGE RULE for any v5 accuracy claim (eta-refuter-2 #620; widened by fleet)
The v5 wording was developed against: the invented fixtures, the 12 SHIPPED consults (V3-01..12, the set V has rated), W03, 4 imaging-mention consults and 10 negatives. Drafts 3 and 4 were REJECTED because V3-10 and V3-11 (both in V's rated set) regressed (V3-11 0.70 -> 0.10), so the shipped 12 steered the final wording. Therefore:
- ALL 12 shipped items (V3-01..V3-12; ratings keyed by V3-NN) are "fixture / regression check only, EXCLUDED from any v5 accuracy claim against V's ratings". V3-09 (= W95 = pool #11) is one of them and is the specific case eta-refuter-2 raised: a scope fixture, never a scored item.
- A v5 accuracy check needs a FRESH set that played no part in the wording (not the shipped 12, not W03, not the 6 CT fixtures F02/F06/F07/F10/F11/F15 once they have been used to choose between wordings).
- v4 (b2ebc86f5a74) stays frozen for the current 12 (ruling 148), so nothing in V's ratings is contaminated today.

## CT02 (pool #6) and a CT-SPECIFIC status question (eta-refuter-2 #641; v5_ctstatus_trial.py; DEVELOPMENT trial)
CT02's wider window (25 min around the hit, 63 turns, production cues; the room has no voiceprint-confirmed doctor and diarization labels every turn 'Speaker A', so a speaker-labelled FULL encounter does not exist for it) reads status proposed_now 0.60 (history 0.02), category 'operation', named 0.95: v5's single status/category answer about the passage's most significant procedure, which is an OPERATION being proposed while the CT is history. So the 'history negative' label is about the CT and the status question is about the operation: ill-posed for a CT check, not a wording failure.
Trial of one extra question, CT_STATUS ("look ONLY at CT scans ... status of the CT for this patient": advised_now / conditional / history / mentioned_only / no_ct), 2 runs, on the six fixtures + the wide CT02 window:
| fixture (label) | ct_status (P) | generic status |
|---|---|---|
| CT05 (pool #2, CT advised now) | advised_now 0.99 | proposed_now |
| CT04 (pool #11, conditional) | conditional 1.00 | mentioned_only |
| CT01, CT02, CT03 (history) | history 0.93-1.00 | history / **proposed_now (CT02)** / history |
| CT06 (history/earlier CT) | mentioned_only 0.93-0.95 | mentioned_only |
| CT02 wide (63 turns) | history 1.00 | proposed_now |
The CT-specific status separates all six as labelled (incl. the conditional one). CAVEATS: development only; the six fixtures are the same set that showed the problem, so this is NOT an accuracy claim (leakage rule cc237d6); excerpts only. It suggests, for imaging: keep stage (b) unchanged (comparability with V's ratings) and ADD a CT-specific status question (a new value, 'conditional', comes with it: the V3-09 / ruling-164 question becomes measurable). That needs a new freeze and Fable's ruling on whether a conditional plain CT counts.

## Gate: is a doctor talking WITH a present patient? (eta-refuter-2 #652; v5_gate_trial.py; DEVELOPMENT trial)
CT02 (pool #6) is clinician-to-clinician case talk about an ABSENT patient (a pre-op case presentation), not a consult: neither the CT nor the operation is proposed TO a patient. v3 greyed such talk by hand; v5 / HIST need it as a gate BEFORE any status question. Trial of one noul question (stage a0: "a doctor talking WITH a patient or family who is present ... NO if clinicians talk among themselves about a patient who is not present: case presentation, pre-op / ward handover, theatre list, staff chat, even if it mentions operations, tests or scans"), 2 runs (noise <= 0.05):
- 12 shipped real consults (regression check only): P(yes) 0.65-0.96 (lowest V3-07 0.65, V3-05 0.77).
- known staff case talk (judged by eta-refuter-2): W90 0.38, W76 0.19, Q19 0.15; CT02 0.10, CT02 wide window 0.14.
- CT fixture excerpts (labels unknown): CT01 0.82, CT03 0.81, CT04 0.68, CT05 0.73, CT06 0.54.
A threshold near 0.5 separates them on this set (real consults >= 0.65, staff talk <= 0.38); CT06 (0.54) sits on the line. CAVEATS: development only; n = 5 staff-talk items; the shipped 12 were used before to steer the v5 wording, so they are a regression check, not an accuracy claim (leakage rule). It would be a new stage-a0 question (a new freeze) and a HIST cue for hist-miner (case-presentation phrases; no second speaker answering).

## CORRECTION on CT04 (surg-deid #654)
An earlier note (and fleet #637) said CT04's named-procedure word was REDACTED so it was 'unfair to Jev'. What de-id redacted was a garbled capitalised word plus 'management'; the words 'CT scan' in that turn survived and Jev names CT04's procedure (named 0.84 / 0.85). So CT04 is SCOREABLE: under v5's generic status it reads mentioned_only (0.69 / 0.65) = a miss for a conditional positive; under the CT-specific status it reads conditional (1.00) = a hit. It was reported apart in the bar for the reason that the CONDITIONAL question awaits Fable's ruling, not because the signal was destroyed.

## DRAFT 6 (Fable rulings 171, 172 at 18:35): contrast CT IN, status `conditional`, category `imaging_ct`
- 171: contrast CT (non-angio) is IN (V's intent = imaging done in-house; V can overrule). Scope now: operations, interventions, minor outpatient procedures, CT (plain or contrast, angiography included). OUT: MRI, X-ray, ultrasound, echo, ECG, treadmill, calcium score, blood tests. Category option renamed `imaging_plain_ct` -> `imaging_ct` (page label suggestion "imaging: CT"; surg-page to confirm).
- 172: new status value `conditional` in the status question (v5.B): "advised or done ONLY IF something happens or does not improve"; a proposal type of its own, never a positive, never a negative; `mentioned_only` now says a conditional plan is not this. V3-09 moves to `conditional`. STATUS ANSWER strings stay as v4's (history -> already_done at the block), `conditional` passes through (surg-page needs the new option).
- v5.py WORDING_VERSION u9-v5.0-draft6, STILL UNFROZEN (Fable: no freeze tonight; frozen after 172 lands, scored on a FRESH set). The CT-specific status question and the patient-present gate (sections above) are NOT in the draft: they are proposals awaiting a ruling.
Invented fixtures: scope 16/16 (contrast abdomen CT now expected IN: named/described 0.97/0.96). Status on 8 invented cases: conditional CT / operation / injection -> conditional 3/3; proposed CT / operation -> proposed_now 2/2; mentioned CT -> mentioned_only; history CT / operation -> history 2/2. Real CT fixtures (development only): CT04 (= V3-09's passage, conditional plain CT) -> conditional 1.00 / 1.00 (agrees with ruling 172); CT05 -> proposed_now 0.98; CT01 / CT03 history, CT06 mentioned_only; CT02 still proposed_now 0.52-0.54 (staff case talk about a different operation: the gate / CT-specific status question address this).

## Ruling 181 (V confirms V3-03 turn 426 = MRI)
MRI is not done at EHRC and is not in Metabase, so it is REFERRED OUT like CT angiography (ruling 163): out of proposal scope, NEVER a negative, never a done label, offered_in_house = false (hard-coded). Consequences for this work:
- V3-03 (working item Q28): its proposal label rests on the BPPV repositioning manoeuvre (minor); the MRI brain is excluded imaging. The shipped v3 / v4 docs are unchanged; v5 draft 6 already reads it that way (named 0.29 = the MRI does not count; described 0.82 = the manoeuvre). Re-judge by eta-refuter-2 on that basis.
- In THIS trial the MRI fixtures (invented 'mri_knee_advised', 'mri_brain_optional', and V3-03) expect named/described LOW because the wording says MRI does not count as a procedure. That is a wording check, not a label: in any accuracy study an MRI-only consult is EXCLUDED (neither positive nor negative), not a negative.

## DRAFT 7 = draft 6 + stage a0 patient-present GATE (eta-refuter-2 #677 recommendation), still UNFROZEN
v5.py `scan()` now asks the gate (A0 'present', GATE_CUT 0.5) in the SAME call as named / described; a passage the gate refuses is HELD as `not_a_consult` before any status question (staff case talk, pre-op handovers: CT02 = 0.10-0.14), whatever named / described say; when both the gate and the recall fail the gate reason wins. The gate is NOT a rater-facing question (only its score and the hold reason are recorded), so the page is unaffected. The gate wording and cut are in the canonical hash. Selftest: gate hold, gate at exactly 0.5 passes / 0.49 held, changed gate wording or cut refused by the freeze, reason order; 8 gate mutants killed. Draft 7 against eta-refuter-2's bar (CT04 back in: 2 positives incl. CT04 = conditional, 4 history negatives): scope + status pass 5/6 on the 6 fixtures (CT02 fails the status, but the gate holds it as not_a_consult, 0.10 / 0.14); this is a DEVELOPMENT result on the same fixtures (leakage rule): scoring waits for a fresh set. NOT in the draft: the CT-specific status question (a new page row would be needed).
VALUE STRINGS for the page (draft; final at the freeze): status: proposed_now | already_done | referred | mentioned_only | conditional; category: operation | intervention | minor | imaging_ct; no other option changes.
