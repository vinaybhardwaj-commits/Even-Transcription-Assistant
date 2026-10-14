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
