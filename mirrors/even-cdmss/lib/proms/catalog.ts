// lib/proms/catalog.ts — Care-Call 0.2 PROMs/PREMs FROZEN catalog as typed DATA (prom-catalog/0.1 +
// hs-sets/0.1). PURE data + trivial lookups; no logic (the compiler selects/schedules, never writes
// item text). HOUSE items are VERBATIM from CDMSS-PROMS-HOUSE-ITEM-SETS-v0 (hs-sets/0.1). VALIDATED
// instruments (WHODAS-12, KOOS-JR, …) are METADATA rows only (id · label · item count · response
// scale · scoring rule · licence) — their verbatim item text is entered at 0.2a-2 from the official
// source, NEVER paraphrased here. Windows/packs/regex-map/escalation/PREM are from the frozen docs.
//
// ⚠ FLAGGED DOC AMBIGUITIES (see build report): (1) the house-sets doc declares 5 "shared scales"
// but ~8 of its own items carry bespoke inline option lists — those option sets are encoded VERBATIM
// as extra Scale members (rather than guess a mapping to one of the 5). (2) PREM item text is
// "unchanged from v0" and NOT present in the provided frozen docs → PREM_MODULE items text=null.
// (3) validated item counts / scoring rules are not in the frozen docs (except WHODAS-12=12) → null.
// (4) the coarse regex-family → catalog-pack/archetype bridge is not given by the docs → REGEX_FAMILY_PACK.

export const PROM_CATALOG_VERSION = 'prom-catalog/0.1' as const;
export const HS_SETS_VERSION = 'hs-sets/0.2' as const;

// The 5 ratified shared scales + the bespoke house option-sets (flagged) needed to encode items verbatim.
export type Scale =
  | 'S5-SEV' | 'S5-FRQ' | 'S5-CMP' | 'NRS-11' | 'YN'
  | 'FUNC4' | 'NOCT5' | 'DIET4' | 'SUPPORT3' | 'WALK5' | 'SIT4' | 'ACT3'
  | 'WORK4' | 'EAT4' | 'OPEN4'    // hs-sets/0.2 (Phase 2a) bespoke house option-sets
  | 'WHODAS5' | 'EXP4'    // 0.2a-2 content encoding: WHODAS-12 response scale + house-PREM experience scale
  // 2b validated-instrument response scales:
  | 'KOOS5' | 'NOSE5' | 'IPSS6' | 'IPSS_NOCT' | 'IPSS_QOL' | 'NYHA4' | 'RMDQ_TICK'
  // NDI = 10 sections, each with its own bespoke 6-statement option list (per PRD §1: do NOT force a shared scale):
  | 'NDI_S1' | 'NDI_S2' | 'NDI_S3' | 'NDI_S4' | 'NDI_S5' | 'NDI_S6' | 'NDI_S7' | 'NDI_S8' | 'NDI_S9' | 'NDI_S10';
export type Archetype = 'SCOPE' | 'DAYCARE' | 'STANDARD' | 'LONG_ARC' | 'ONCO_MAJOR';
export type Window = 'baseline' | 'd72h' | 'w2' | 'w6' | 'm3' | 'm6' | 'm12';

// §catalog 3 — archetype instrument windows (verbatim). PREM points are separate (PREM_POINTS).
export const ARCHETYPE_WINDOWS: Record<Archetype, Window[]> = {
  SCOPE: ['baseline', 'd72h'],                                  // baseline-lite + PREM@72h
  DAYCARE: ['baseline', 'd72h', 'w2', 'w6'],
  STANDARD: ['baseline', 'd72h', 'w2', 'w6', 'm3'],
  LONG_ARC: ['baseline', 'w6', 'm3', 'm6', 'm12'],             // PREM 72h+3m (explicit)
  ONCO_MAJOR: ['baseline', 'w2', 'w6', 'm3', 'm6', 'm12'],
};
// PREM points (§5 "PREM-1 @72h, PREM-2 @close"; LONG_ARC overrides to 72h+3m; SCOPE = @72h only).
// FLAGGED: @close derived as the archetype's last window where the docs don't state it explicitly.
export const PREM_POINTS: Record<Archetype, Window[]> = {
  SCOPE: ['d72h'],
  DAYCARE: ['d72h', 'w6'],
  STANDARD: ['d72h', 'm3'],
  LONG_ARC: ['d72h', 'm3'],
  ONCO_MAJOR: ['d72h', 'm12'],
};

export interface Item { id: string; text: string | null; scale: Scale; escalation?: string | null }
export interface InstrumentDef {
  id: string;
  label: string; kind: 'validated' | 'house';
  scale: 'house' | string;          // scoring family / response-scale descriptor
  items: Item[];                    // HOUSE: verbatim; VALIDATED: [] (metadata only)
  itemCount?: number | null;        // VALIDATED metadata (docs give only WHODAS-12=12); house = items.length
  scoring: { method: 'sum' | 'ref'; range?: [number, number]; note?: string };
  licence: 'F' | 'Pv' | 'house';
}

// Response options per scale (the 5 ratified + the bespoke house sets, all verbatim).
export const SHARED_SCALES: Record<Scale, string[]> = {
  'S5-SEV': ['none', 'mild', 'moderate', 'severe', 'very severe'],
  'S5-FRQ': ['never', 'rarely', 'sometimes', 'often', 'always'],
  'S5-CMP': ['much better', 'better', 'same', 'worse', 'much worse'],
  'NRS-11': ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
  'YN': ['yes', 'no'],
  // bespoke house option-sets (verbatim from the items; flagged extension):
  'FUNC4': ['fully', 'mostly', 'partly', 'not yet'],
  'NOCT5': ['0', '1', '2', '3', '4+'],
  'DIET4': ['fully', 'soft diet only', 'liquids only', 'barely'],
  'SUPPORT3': ['yes', 'some difficulty', 'struggling'],
  'WALK5': ['unlimited', '~1km', '~500m', '~100m', 'room-only'],
  'SIT4': ['>1h', '~30min', '~10min', 'barely'],
  'ACT3': ['fully', 'avoiding heavy', 'avoiding all'],
  // hs-sets/0.2 (Phase 2a) bespoke house option-sets (verbatim):
  'WORK4': ['fully', 'avoiding some', 'avoiding most', 'not yet'],
  'EAT4': ['fully able', 'mostly', 'soft foods only', 'liquids only'],
  'OPEN4': ['fully', 'mildly limited', 'moderately limited', 'severely limited'],
  // 0.2a-2 content encoding (verbatim from the two source files):
  'WHODAS5': ['None', 'Mild', 'Moderate', 'Severe', 'Extreme or cannot do'],   // WHODAS-12 recode None=0…Extreme=4
  'EXP4': ['no', 'partly', 'mostly', 'yes, fully'],                            // house PREM experience, 0–3, higher = better
  // 2b validated-instrument scales (verbatim from the freeze record / encode PRD §1):
  'KOOS5': ['None', 'Mild', 'Moderate', 'Severe', 'Extreme'],                  // koos_jr, hoos_jr (0–4)
  'NOSE5': ['Not a Problem', 'Very Mild Problem', 'Moderate Problem', 'Fairly Bad Problem', 'Severe Problem'],   // nose (0–4)
  'IPSS6': ['Not at all', 'Less than 1 time in 5', 'Less than half the time', 'About half the time', 'More than half the time', 'Almost always'],   // IPSS Q1–Q6 (0–5)
  'IPSS_NOCT': ['None', '1 time', '2 times', '3 times', '4 times', '5 or more times'],   // IPSS Q7 nocturia (0–5)
  'IPSS_QOL': ['Delighted', 'Pleased', 'Mostly satisfied', 'Mixed (about equally satisfied and dissatisfied)', 'Mostly dissatisfied', 'Unhappy', 'Terrible'],   // IPSS QoL (0–6, scored separately)
  'NYHA4': ['Class I', 'Class II', 'Class III', 'Class IV'],                    // NYHA functional class (1–4)
  'RMDQ_TICK': ['Does not apply', 'Applies to me today'],                       // RMDQ per-sentence tick (index 1 = ticked)
  // NDI — 10 sections, each 6 statements VERBATIM (Vernon & Mior 1991; index 0 top → 5 bottom):
  'NDI_S1': ['I have no pain at the moment', 'The pain is very mild at the moment', 'The pain is moderate at the moment', 'The pain is fairly severe at the moment', 'The pain is very severe at the moment', 'The pain is the worst pain imaginable at the moment'],
  'NDI_S2': ['I can look after myself normally without causing extra pain', 'I can look after myself normally, but it causes extra pain', 'It is painful to look after myself and I am slow and careful', 'I need some help but manage most of my personal care', 'I need help every day in most aspects of self-care', 'I do not get dressed; I wash with difficulty and stay in bed'],
  'NDI_S3': ['I can lift heavy weights without extra pain', 'I can lift heavy weights, but it gives me extra pain', 'Pain prevents me from lifting heavy weights off the floor, but I can manage if they are conveniently positioned (like on a table)', 'Pain prevents me from lifting heavy weights, but I can manage light-to-medium weights if they are conveniently positioned', 'I can lift very light weights', 'I cannot lift or carry anything at all'],
  'NDI_S4': ['I can read as much as I want with no neck pain', 'I can read as much as I want with slight neck pain', 'I can read as much as I want with moderate neck pain', "I can't read as much as I want because of moderate neck pain", 'I can hardly read at all because of severe pain in my neck', 'I cannot read at all'],
  'NDI_S5': ['I have no headaches at all', 'I have slight headaches that come infrequently', 'I have moderate headaches that come infrequently', 'I have moderate headaches that come frequently', 'I have severe headaches that come frequently', 'I have headaches almost all of the time'],
  'NDI_S6': ['I can concentrate fully when I want with no difficulty', 'I can concentrate fully when I want to with slight difficulty', 'I have a fair degree of difficulty concentrating when I want to', 'I have a lot of difficulty concentrating when I want to', 'I have a great deal of difficulty concentrating when I want to', 'I cannot concentrate at all'],
  'NDI_S7': ['I can do as much work as I want', 'I can only do my usual work, but no more', 'I can do most of my usual work, but no more', 'I cannot do my usual work', 'I can hardly do any work at all', 'I cannot do any work at all'],
  'NDI_S8': ['I can drive my car without any neck pain', 'I can drive my car as long as I want with slight neck pain', 'I can drive my car as long as I want with moderate neck pain', "I can't drive my car as long as I want because of moderate neck pain", 'I can hardly drive at all because of severe neck pain', "I can't drive my car at all"],
  'NDI_S9': ['I have no trouble sleeping', 'My sleep is slightly disturbed (less than 1 hour sleepless)', 'My sleep is mildly disturbed (1 to 2 hours sleepless)', 'My sleep is moderately disturbed (2 to 3 hours sleepless)', 'My sleep is greatly disturbed (3 to 5 hours sleepless)', 'My sleep is completely disturbed (5 to 7 hours sleepless)'],
  'NDI_S10': ['I am able to engage in all my recreation activities with no neck pain', 'I am able to engage in all my recreation activities with some neck pain', 'I am able to engage in most, but not all, of my usual recreation activities because of neck pain', 'I am able to engage in a few of my usual recreation activities because of neck pain', 'I can hardly do any recreation activities because of neck pain', "I can't do any recreation activities at all because of neck pain"],
};

const houseItem = (id: string, text: string, scale: Scale, escalation: string | null = null): Item => ({ id, text, scale, escalation });
const houseSet = (id: string, label: string, items: Item[]): InstrumentDef => ({ id, label, kind: 'house', scale: 'house', items, itemCount: items.length, scoring: { method: 'sum', note: 'house simple sum; within-patient trends only; never benchmarked' }, licence: 'house' });

// ── Universal CORE stack (§catalog 2) ──
const RETURN_TO_FUNCTION = houseItem('rtf', 'Compared with before surgery, your ability to do daily activities is:', 'S5-CMP');
// WHODAS 2.0 © World Health Organization. Used with attribution; unmodified. 12-item interviewer-
// administered version. Item text below is VERBATIM from the official WHO PDF (encoded 0.2a-2). Stem
// (read once): "In the past 30 days, how much difficulty did you have in:" — every item on WHODAS5.
const WHODAS12_ITEMS: Item[] = [
  { id: 'whodas_s1', text: 'Standing for long periods such as 30 minutes?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s2', text: 'Taking care of your household responsibilities?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s3', text: 'Learning a new task, for example, learning how to get to a new place?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s4', text: 'How much of a problem did you have joining in community activities (for example, festivities, religious or other activities) in the same way as anyone else can?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s5', text: 'How much have you been emotionally affected by your health problems?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s6', text: 'Concentrating on doing something for ten minutes?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s7', text: 'Walking a long distance such as a kilometre [or equivalent]?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s8', text: 'Washing your whole body?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s9', text: 'Getting dressed?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s10', text: 'Dealing with people you do not know?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s11', text: 'Maintaining a friendship?', scale: 'WHODAS5', escalation: null },
  { id: 'whodas_s12', text: 'Your day-to-day work/school?', scale: 'WHODAS5', escalation: null },
];
export const CORE: InstrumentDef[] = [
  { id: 'whodas12', label: 'WHODAS 2.0 (12-item)', kind: 'validated', scale: 'WHODAS5', items: WHODAS12_ITEMS, itemCount: 12, scoring: { method: 'ref', note: 'WHODAS 2.0 © WHO; used with attribution, unmodified; 12-item interviewer version. Simple score = sum(0..4)→0–48.' }, licence: 'F' },
  { id: 'pain_nrs', label: 'Pain NRS', kind: 'validated', scale: 'NRS-11', items: [], itemCount: 1, scoring: { method: 'ref', range: [0, 10], note: 'public domain' }, licence: 'F' },
  houseSet('hs-return-to-function', 'Return-to-function (house)', [RETURN_TO_FUNCTION]),
];

// ── House sets — VERBATIM from hs-sets/0.1 (item text + shared scale + ⚠ escalation) ──
export const HOUSE_SETS: Record<string, InstrumentDef> = {
  'hs-wound': houseSet('hs-wound', 'HS-WOUND — universal wound check', [
    houseItem('w1', 'Is the wound area more red, swollen, or painful than the day before?', 'YN', 'E2-with-item-3'),
    houseItem('w2', 'Any discharge or bad smell from the wound?', 'YN', 'E2-with-item-3'),
    houseItem('w3', 'Fever since discharge?', 'YN'),
    houseItem('w4', 'Has the wound opened anywhere?', 'YN', 'always'),
  ]),
  'hs-recovery': houseSet('hs-recovery', 'HS-RECOVERY — generic day-care recovery', [
    houseItem('r1', 'Have you returned to your usual daily activities?', 'FUNC4'),
    houseItem('r2', 'Pain at the operation site today', 'NRS-11'),
    houseItem('r3', "Any problem after the procedure you didn't expect?", 'YN'),
  ]),
  'hs-procto': houseSet('hs-procto', 'HS-PROCTO — proctology symptom resolution', [
    houseItem('p1', 'Bleeding with motions', 'S5-FRQ', 'E4'),
    houseItem('p2', 'Pain during or after passing motion', 'NRS-11'),
    houseItem('p3', 'Swelling or something coming down while straining', 'S5-FRQ'),
    houseItem('p4', 'Any difficulty holding motion or wind since surgery?', 'YN', 'E5'),
  ]),
  'hs-gi': houseSet('hs-gi', 'HS-GI — post-cholecystectomy', [
    houseItem('g1', 'Pain after fatty meals', 'S5-FRQ'),
    houseItem('g2', 'Bloating or fullness after eating', 'S5-FRQ'),
    houseItem('g3', 'Loose motions since surgery', 'S5-FRQ'),
  ]),
  'hs-luts': houseSet('hs-luts', 'HS-LUTS — LUTS fallback', [
    houseItem('l1', 'How often do you have a weak urine stream?', 'S5-FRQ'),
    houseItem('l2', 'How many times do you get up at night to pass urine?', 'NOCT5'),
    houseItem('l3', 'How often do you have a sudden strong urge to pass urine?', 'S5-FRQ'),
    houseItem('l4', 'Burning while passing urine', 'S5-FRQ'),
  ]),
  'hs-stone': houseSet('hs-stone', 'HS-STONE — urinary stones', [
    houseItem('s1', 'Flank or lower-abdomen pain', 'NRS-11'),
    houseItem('s2', 'Blood in urine', 'S5-FRQ', 'E5'),
    houseItem('s3', '(If stented) stent discomfort interfering with daily activities', 'S5-SEV'),
  ]),
  'hs-gyn': houseSet('hs-gyn', 'HS-GYN — gynae symptom resolution', [
    houseItem('gy1', 'Bleeding compared with before surgery', 'S5-CMP', 'E4'),
    houseItem('gy2', 'Lower-abdomen or pelvic pain', 'NRS-11'),
    houseItem('gy3', 'The symptom that led to surgery — how is it now?', 'S5-CMP'),
  ]),
  'hs-sinus': houseSet('hs-sinus', 'HS-SINUS — sinus fallback', [
    houseItem('si1', 'Nose blockage', 'S5-SEV'),
    houseItem('si2', 'Discharge/post-nasal drip', 'S5-FRQ'),
    houseItem('si3', 'Sense of smell', 'S5-CMP'),
    houseItem('si4', 'Facial pressure or headache', 'S5-SEV'),
  ]),
  'hs-tonsil': houseSet('hs-tonsil', 'HS-TONSIL — tonsillectomy recovery', [
    houseItem('t1', 'Throat pain today', 'NRS-11'),
    houseItem('t2', 'Able to eat and drink normally?', 'DIET4', 'E5'),
    houseItem('t3', 'Any bleeding from the throat?', 'YN', 'always'),
  ]),
  'hs-thyroid': houseSet('hs-thyroid', 'HS-THYROID — thyroid surgery', [
    houseItem('th1', 'Voice change compared with before surgery', 'S5-CMP', 'E5'),
    houseItem('th2', 'Difficulty swallowing', 'S5-SEV'),
    houseItem('th3', 'Tingling around lips or fingertips?', 'YN', 'always'),
    houseItem('th4', 'Neck wound tightness or swelling', 'S5-SEV'),
  ]),
  'hs-csection': houseSet('hs-csection', 'HS-CSECTION — C-section recovery', [
    houseItem('cs1', 'Wound pain', 'NRS-11'),
    houseItem('cs2', 'Able to move about, climb stairs, care for the baby?', 'FUNC4'),
    houseItem('cs3', 'Bleeding heavier than a normal period?', 'YN', 'E4'),
    houseItem('cs4', 'Feeding going okay, and do you have help at home?', 'SUPPORT3', 'E5'),
  ]),
  'hs-visual': houseSet('hs-visual', 'HS-VISUAL — cataract fallback', [
    houseItem('v1', 'Distance vision (recognising faces across a room)', 'S5-CMP'),
    houseItem('v2', 'Glare or halos around lights at night', 'S5-SEV'),
    houseItem('v3', 'Reading or phone use', 'S5-CMP'),
    houseItem('v4', 'Eye pain or sudden drop in vision?', 'YN', 'always'),
  ]),
  'hs-shoulder': houseSet('hs-shoulder', 'HS-SHOULDER — shoulder fallback', [
    houseItem('sh1', 'Night pain lying on that side', 'S5-FRQ'),
    houseItem('sh2', 'Reaching overhead (shelf)', 'S5-SEV'),
    houseItem('sh3', 'Dressing yourself', 'S5-SEV'),
  ]),
  'hs-lumbar': houseSet('hs-lumbar', 'HS-LUMBAR — lumbar fallback', [
    houseItem('lu1', 'Back pain', 'NRS-11'),
    houseItem('lu2', 'Leg pain', 'NRS-11'),
    houseItem('lu3', 'Walking distance before stopping', 'WALK5'),
    houseItem('lu4', 'Sitting tolerance', 'SIT4'),
  ]),
  'hs-hernia': houseSet('hs-hernia', 'HS-HERNIA — hernia fallback', [
    houseItem('he1', 'Pain at repair site at rest / on coughing or lifting', 'NRS-11'),
    houseItem('he2', 'Any bulge reappeared?', 'YN', 'E5'),
    houseItem('he3', 'Back to lifting normal weights?', 'ACT3'),
  ]),
  // ── hs-sets/0.2 (Phase 2a) — 6 house fallback sets, VERBATIM from CDMSS-PROMS-HOUSE-ITEM-SETS-2A-v0 ──
  'hs-wrist': houseSet('hs-wrist', 'HS-WRIST — hand & wrist fallback', [
    houseItem('hw1', 'Wrist or hand pain at rest today', 'NRS-11'),
    houseItem('hw2', 'Wrist or hand pain when you use the hand — gripping, twisting a key or lid', 'NRS-11'),
    houseItem('hw3', 'Stiffness — how much does limited wrist/finger movement bother you?', 'S5-SEV'),
    houseItem('hw4', 'Grip strength for everyday tasks (opening a jar, carrying a bag) compared with before', 'S5-CMP'),
    houseItem('hw5', 'Fine tasks — buttons, holding a phone, writing', 'FUNC4'),
    houseItem('hw6', 'Back to your usual work or household tasks with that hand?', 'WORK4'),
    houseItem('hw7', 'New numbness or pins-and-needles, or the hand/fingers looking pale, blue, very swollen, or very tight?', 'YN', 'E5'),
  ]),
  'hs-fibroid': houseSet('hs-fibroid', 'HS-FIBROID — uterine fibroid / post-myomectomy fallback', [
    houseItem('hf1', 'Menstrual bleeding compared with before treatment', 'S5-CMP'),
    houseItem('hf2', 'Passing large clots or flooding (soaking through protection)', 'S5-FRQ', 'E4'),
    houseItem('hf3', 'Pelvic heaviness, fullness, or a feeling of pressure low down', 'S5-SEV'),
    houseItem('hf4', 'Passing urine more often or more urgently because of pelvic pressure', 'S5-FRQ'),
    houseItem('hf5', 'Lower-abdomen or period pain', 'NRS-11'),
    houseItem('hf6', 'Tiredness or low energy affecting your day', 'S5-SEV'),
    houseItem('hf7', 'The main symptom that led to treatment — how is it now?', 'S5-CMP'),
    houseItem('hf8', 'Very heavy bleeding (soaking a pad within an hour), fever, or severe worsening pain?', 'YN', 'E5'),
  ]),
  'hs-endo': houseSet('hs-endo', 'HS-ENDO — endometriosis fallback', [
    houseItem('en1', 'Pelvic or period pain over the past week', 'NRS-11'),
    houseItem('en2', 'Pain with periods compared with before treatment', 'S5-CMP'),
    houseItem('en3', 'Pain during or after sex', 'S5-FRQ'),
    houseItem('en4', 'Pain opening bowels or passing urine, especially around your period', 'S5-FRQ'),
    houseItem('en5', 'How often has the pain stopped you doing daily activities or work?', 'S5-FRQ'),
    houseItem('en6', 'How much has the condition worn you down or made you feel out of control of it?', 'S5-SEV'),
    houseItem('en7', 'The main symptom that led to treatment — how is it now?', 'S5-CMP'),
    houseItem('en8', 'Fever, worsening abdominal pain, wound discharge, or inability to pass urine?', 'YN', 'E5'),
  ]),
  'hs-prolapse': houseSet('hs-prolapse', 'HS-PROLAPSE — pelvic organ prolapse fallback', [
    houseItem('pl1', 'A sensation of a bulge or something coming down in the vagina', 'S5-FRQ'),
    houseItem('pl2', 'Heaviness or dragging in the pelvis, worse by the end of the day', 'S5-SEV'),
    houseItem('pl3', 'Needing to push the bulge up, or press, to start or finish passing urine or stool', 'S5-FRQ'),
    houseItem('pl4', "Bladder: leaking urine with a cough, laugh, or exercise, or a sudden urge you can't hold", 'S5-FRQ'),
    houseItem('pl5', "Bladder: a feeling that you don't empty fully", 'S5-FRQ'),
    houseItem('pl6', 'Bowel: straining, hard stools, or a feeling of incomplete emptying', 'S5-FRQ'),
    houseItem('pl7', "Bowel: leaking stool or wind you can't control", 'S5-FRQ', 'E5'),
    houseItem('pl8', 'The main symptom that led to treatment — how is it now?', 'S5-CMP'),
    houseItem('pl9', 'Inability to pass urine, heavy vaginal bleeding, fever, or new severe pain?', 'YN', 'E5'),
  ]),
  'hs-varicose': houseSet('hs-varicose', 'HS-VARICOSE — varicose veins fallback', [
    houseItem('vv1', 'Aching, heaviness, or throbbing in the leg', 'S5-FRQ'),
    houseItem('vv2', 'Ankle or leg swelling by the end of the day', 'S5-SEV'),
    houseItem('vv3', 'Itching, or changes in skin colour or texture over the veins', 'S5-FRQ'),
    houseItem('vv4', 'Any skin breakdown or ulcer near the ankle?', 'YN', 'E5'),
    houseItem('vv5', 'How much does the appearance of the veins bother you?', 'S5-SEV'),
    houseItem('vv6', 'Do the leg symptoms limit standing, walking, or work?', 'S5-SEV'),
    houseItem('vv7', 'The main symptom that led to treatment — how is it now?', 'S5-CMP'),
    houseItem('vv8', 'Calf pain, swelling, or redness; breathlessness; wound bleeding; or fever?', 'YN', 'always'),
  ]),
  'hs-dental': houseSet('hs-dental', 'HS-DENTAL — dental / oral & maxillofacial fallback', [
    houseItem('dn1', 'Pain in the mouth, teeth, or jaw', 'NRS-11'),
    houseItem('dn2', 'Difficulty chewing or eating the foods you want', 'EAT4'),
    houseItem('dn3', 'Trouble speaking clearly because of your mouth or jaw', 'S5-FRQ'),
    houseItem('dn4', 'Feeling self-conscious or bothered by the appearance of your mouth, teeth, or jaw', 'S5-SEV'),
    houseItem('dn5', 'Have mouth or jaw problems made you avoid certain foods or social situations?', 'S5-FRQ'),
    houseItem('dn6', 'Mouth opening — able to open your mouth normally?', 'OPEN4'),
    houseItem('dn7', 'The main problem that led to treatment — how is it now?', 'S5-CMP'),
    houseItem('dn8', "Bleeding that won't stop, spreading facial swelling, difficulty breathing or swallowing, or fever?", 'YN', 'always'),
  ]),
};

// ── Validated instruments referenced by the packs — METADATA rows only (text at 0.2a-2). ──
const validated = (id: string, label: string, licence: 'F' | 'Pv', itemCount: number | null = null): InstrumentDef =>
  ({ id, label, kind: 'validated', scale: 'validated', items: [], itemCount, scoring: { method: 'ref', note: 'item text + scoring rule from the official source at 0.2a-2' }, licence });
// Phase-2b filled validated instruments — verbatim items + explicit scoreInstrument branches (schedule-core).
const validatedFull = (id: string, label: string, licence: 'F' | 'Pv', scaleDesc: string, items: Item[], note: string): InstrumentDef =>
  ({ id, label, kind: 'validated', scale: scaleDesc, items, itemCount: items.length, scoring: { method: 'ref', note }, licence });
const vItem = (id: string, text: string, scale: Scale): Item => ({ id, text, scale, escalation: null });

// KOOS, JR. © Hospital for Special Surgery. Free w/ attribution. Items verbatim (printed codes S1/P1..A2),
// all on KOOS5 (None…Extreme). Src: hss.edu KOOS-JR scoring PDF (2017). Score = raw 0–28 → interval table.
const KOOS_JR_ITEMS: Item[] = [
  vItem('koos_jr_s1', 'How severe is your knee stiffness after first wakening in the morning?', 'KOOS5'),
  vItem('koos_jr_p1', 'Twisting/pivoting on your knee', 'KOOS5'),
  vItem('koos_jr_p2', 'Straightening knee fully', 'KOOS5'),
  vItem('koos_jr_p3', 'Going up or down stairs', 'KOOS5'),
  vItem('koos_jr_p4', 'Standing upright', 'KOOS5'),
  vItem('koos_jr_a1', 'Rising from sitting', 'KOOS5'),
  vItem('koos_jr_a2', 'Bending to the floor/pick up an object', 'KOOS5'),
];
// HOOS, JR. © Hospital for Special Surgery. Free w/ attribution. 6 items on KOOS5. Src: hss.edu HOOS-JR PDF (2017).
const HOOS_JR_ITEMS: Item[] = [
  vItem('hoos_jr_p1', 'Going up or down stairs', 'KOOS5'),
  vItem('hoos_jr_p2', 'Walking on an uneven surface', 'KOOS5'),
  vItem('hoos_jr_a1', 'Rising from sitting', 'KOOS5'),
  vItem('hoos_jr_a2', 'Bending to the floor/pick up an object', 'KOOS5'),
  vItem('hoos_jr_a3', 'Lying in bed (turning over, maintaining hip position)', 'KOOS5'),
  vItem('hoos_jr_a4', 'Sitting', 'KOOS5'),
];
// SPADI © Roach KE et al., Arthritis Care Res 1991;4(4):143–149. Free, cite authors. 5 pain + 8 disability
// on the 0–10 NRS. Pain stem: "How severe is your pain?" (0 no pain … 10 worst imaginable). Disability stem:
// "How much difficulty do you have?" (0 no difficulty … 10 so difficult it requires help).
const SPADI_ITEMS: Item[] = [
  vItem('spadi_p1', 'At its worst?', 'NRS-11'),
  vItem('spadi_p2', 'When lying on the involved side?', 'NRS-11'),
  vItem('spadi_p3', 'When reaching for something on a high shelf?', 'NRS-11'),
  vItem('spadi_p4', 'When attempting to touch the back of your neck?', 'NRS-11'),
  vItem('spadi_p5', 'When pushing with the involved arm?', 'NRS-11'),
  vItem('spadi_d1', 'Washing your hair?', 'NRS-11'),
  vItem('spadi_d2', 'Washing your back?', 'NRS-11'),
  vItem('spadi_d3', 'Putting on an undershirt or pullover sweater?', 'NRS-11'),
  vItem('spadi_d4', 'Putting on a shirt that buttons down the front?', 'NRS-11'),
  vItem('spadi_d5', 'Putting on your pants?', 'NRS-11'),
  vItem('spadi_d6', 'Placing an object on a high shelf?', 'NRS-11'),
  vItem('spadi_d7', 'Carrying a heavy object of 10 pounds?', 'NRS-11'),
  vItem('spadi_d8', 'Removing something from your back pocket?', 'NRS-11'),
];
// RMDQ — Roland & Morris, Spine 1983;8:141–144. PUBLIC DOMAIN ("No permission is required…"). 24 sentences,
// original 1983 order (item 9 "then" preserved as printed), each tick on RMDQ_TICK. Src: rmdq.org.
const RMDQ_ITEMS: Item[] = [
  vItem('rmdq_1', 'I stay at home most of the time because of my back.', 'RMDQ_TICK'),
  vItem('rmdq_2', 'I change position frequently to try and get my back comfortable.', 'RMDQ_TICK'),
  vItem('rmdq_3', 'I walk more slowly than usual because of my back.', 'RMDQ_TICK'),
  vItem('rmdq_4', 'Because of my back I am not doing any of the jobs that I usually do around the house.', 'RMDQ_TICK'),
  vItem('rmdq_5', 'Because of my back, I use a handrail to get upstairs.', 'RMDQ_TICK'),
  vItem('rmdq_6', 'Because of my back, I lie down to rest more often.', 'RMDQ_TICK'),
  vItem('rmdq_7', 'Because of my back, I have to hold on to something to get out of an easy chair.', 'RMDQ_TICK'),
  vItem('rmdq_8', 'Because of my back, I try to get other people to do things for me.', 'RMDQ_TICK'),
  vItem('rmdq_9', 'I get dressed more slowly then usual because of my back.', 'RMDQ_TICK'),
  vItem('rmdq_10', 'I only stand for short periods of time because of my back.', 'RMDQ_TICK'),
  vItem('rmdq_11', 'Because of my back, I try not to bend or kneel down.', 'RMDQ_TICK'),
  vItem('rmdq_12', 'I find it difficult to get out of a chair because of my back.', 'RMDQ_TICK'),
  vItem('rmdq_13', 'My back is painful almost all the time.', 'RMDQ_TICK'),
  vItem('rmdq_14', 'I find it difficult to turn over in bed because of my back.', 'RMDQ_TICK'),
  vItem('rmdq_15', 'My appetite is not very good because of my back pain.', 'RMDQ_TICK'),
  vItem('rmdq_16', 'I have trouble putting on my socks (or stockings) because of the pain in my back.', 'RMDQ_TICK'),
  vItem('rmdq_17', 'I only walk short distances because of my back.', 'RMDQ_TICK'),
  vItem('rmdq_18', 'I sleep less well because of my back.', 'RMDQ_TICK'),
  vItem('rmdq_19', 'Because of my back pain, I get dressed with help from someone else.', 'RMDQ_TICK'),
  vItem('rmdq_20', 'I sit down for most of the day because of my back.', 'RMDQ_TICK'),
  vItem('rmdq_21', 'I avoid heavy jobs around the house because of my back.', 'RMDQ_TICK'),
  vItem('rmdq_22', 'Because of my back pain, I am more irritable and bad tempered with people than usual.', 'RMDQ_TICK'),
  vItem('rmdq_23', 'Because of my back, I go upstairs more slowly than usual.', 'RMDQ_TICK'),
  vItem('rmdq_24', 'I stay in bed most of the time because of my back.', 'RMDQ_TICK'),
];
// NDI — Vernon & Mior, J Manipulative Physiol Ther 1991;14:409–415. Free clinical/research use w/ attribution.
// 10 sections; each item's 6 statements live in its bespoke NDI_Sx scale (options index 0–5). Src: WCB Saskatchewan.
const NDI_ITEMS: Item[] = [
  vItem('ndi_s1', 'Pain intensity', 'NDI_S1'),
  vItem('ndi_s2', 'Personal care (washing, dressing, etc.)', 'NDI_S2'),
  vItem('ndi_s3', 'Lifting', 'NDI_S3'),
  vItem('ndi_s4', 'Reading', 'NDI_S4'),
  vItem('ndi_s5', 'Headaches', 'NDI_S5'),
  vItem('ndi_s6', 'Concentration', 'NDI_S6'),
  vItem('ndi_s7', 'Work', 'NDI_S7'),
  vItem('ndi_s8', 'Driving', 'NDI_S8'),
  vItem('ndi_s9', 'Sleeping', 'NDI_S9'),
  vItem('ndi_s10', 'Recreation', 'NDI_S10'),
];
// IPSS / AUA-SI — Barry et al., J Urol 1992;148:1549–1557. Free, cite AUA. Original "Over the past month…"
// wording (V-ratified). Q1–Q6 on IPSS6, Q7 (nocturia) on IPSS_NOCT, QoL on IPSS_QOL (scored separately).
const IPSS_ITEMS: Item[] = [
  vItem('ipss_q1', 'Over the past month, how often have you had a sensation of not emptying your bladder completely after you finished urinating?', 'IPSS6'),
  vItem('ipss_q2', 'Over the past month, how often have you had to urinate again less than two hours after you finished urinating?', 'IPSS6'),
  vItem('ipss_q3', 'Over the past month, how often have you found you stopped and started again several times when you urinated?', 'IPSS6'),
  vItem('ipss_q4', 'Over the past month, how often have you found it difficult to postpone urination?', 'IPSS6'),
  vItem('ipss_q5', 'Over the past month, how often have you had a weak urinary stream?', 'IPSS6'),
  vItem('ipss_q6', 'Over the past month, how often have you had to push or strain to begin urination?', 'IPSS6'),
  vItem('ipss_q7', 'Over the past month, how many times did you most typically get up to urinate from the time you went to bed at night until the time you got up in the morning?', 'IPSS_NOCT'),
  vItem('ipss_qol', 'If you were to spend the rest of your life with your urinary condition just the way it is now, how would you feel about that?', 'IPSS_QOL'),
];
// NOSE — Stewart MG et al., Otolaryngol Head Neck Surg 2004;130(2):157–163. © AAO-HNS, free w/ attribution.
// Stem: "Over the past ONE month, how much of a problem were the following conditions for you?" 5 items on NOSE5.
const NOSE_ITEMS: Item[] = [
  vItem('nose_1', 'Nasal congestion or stuffiness', 'NOSE5'),
  vItem('nose_2', 'Nasal blockage or obstruction', 'NOSE5'),
  vItem('nose_3', 'Trouble breathing through my nose', 'NOSE5'),
  vItem('nose_4', 'Trouble sleeping', 'NOSE5'),
  vItem('nose_5', 'Unable to get enough air through my nose during exercise or exertion', 'NOSE5'),
];
// NYHA Functional Classification, per AHA. Public domain. Clinician-assigned single class I–IV on NYHA4.
const NYHA_ITEMS: Item[] = [
  vItem('nyha_class', 'NYHA functional class (clinician-assigned)', 'NYHA4'),
];

export const VALIDATED_INSTRUMENTS: Record<string, InstrumentDef> = {
  koos_jr: validatedFull('koos_jr', 'KOOS-JR', 'F', 'koos-jr', KOOS_JR_ITEMS, 'KOOS, JR. © HSS; free w/ attribution. Raw sum 0–28 → interval 0–100 (higher=better).'),
  hoos_jr: validatedFull('hoos_jr', 'HOOS-JR', 'F', 'hoos-jr', HOOS_JR_ITEMS, 'HOOS, JR. © HSS; free w/ attribution. Raw sum 0–24 → interval 0–100 (higher=better).'),
  koos: validated('koos', 'KOOS', 'F'),   // KOOS-full (ACL) NOT sourced this build — items null (follow-up)
  tegner: validated('tegner', 'Tegner', 'F'),
  spadi: validatedFull('spadi', 'SPADI', 'F', 'spadi', SPADI_ITEMS, 'SPADI (Roach 1991); free, cite authors. Total = (Σ13 / 130) × 100, 0–100 (higher=worse).'),
  prwe: validated('prwe', 'PRWE', 'Pv'),
  faam: validated('faam', 'FAAM', 'F'),
  rmdq: validatedFull('rmdq', 'RMDQ', 'F', 'rmdq', RMDQ_ITEMS, 'RMDQ (Roland & Morris 1983); public domain. Score = count of ticks 0–24 (higher=worse).'),
  odi: validated('odi', 'ODI', 'Pv'),
  ndi: validatedFull('ndi', 'NDI', 'F', 'ndi', NDI_ITEMS, 'NDI (Vernon & Mior 1991); free w/ attribution. Sum 10 sections 0–50 (higher=worse; ×2 = %).'),
  wexner: validated('wexner', 'Wexner', 'F'),
  eurahs: validated('eurahs', 'EuraHS-QoL', 'Pv'),
  ipss: validatedFull('ipss', 'IPSS', 'F', 'ipss', IPSS_ITEMS, 'IPSS / AUA-SI (Barry 1992); free, cite AUA. ΣQ1–Q7 0–35 (higher=worse); QoL stored separately.'),
  ufsqol: validated('ufsqol', 'UFS-QoL', 'Pv'),
  ehp5: validated('ehp5', 'EHP-5', 'Pv'),
  pfdi20: validated('pfdi20', 'PFDI-20', 'Pv'),
  nose: validatedFull('nose', 'NOSE', 'F', 'nose', NOSE_ITEMS, 'NOSE (Stewart 2004); © AAO-HNS, free w/ attribution. Sum 0–20 × 5 = 0–100 (higher=worse).'),
  snot22: validated('snot22', 'SNOT-22', 'Pv'),
  catquest9sf: validated('catquest9sf', 'Catquest-9SF', 'Pv'),
  avvq: validated('avvq', 'AVVQ', 'Pv'),
  nyha: validatedFull('nyha', 'NYHA (clinician-reported)', 'F', 'nyha', NYHA_ITEMS, 'NYHA class per AHA; public domain. Score = class index+1 (1–4, higher=worse).'),
  ohip14: validated('ohip14', 'OHIP-14', 'F', 14),   // licensed — stays null until a Phase-2a dental house set (lic corrected to 'house' on the pack)
  whodas_proxy: validated('whodas_proxy', 'WHODAS-proxy', 'Pv'),
};

/** Resolve an instrument id to its def (CORE ∪ HOUSE_SETS ∪ VALIDATED ∪ the PREM module). null if unknown. */
export function instrumentById(id: string): InstrumentDef | null {
  return CORE.find((i) => i.id === id) ?? HOUSE_SETS[id] ?? VALIDATED_INSTRUMENTS[id] ?? (id === PREM_MODULE.id ? PREM_MODULE : null);
}

export interface FamilyPack { family: string; archetype: Archetype; primary: string | null; fallback: string | null; lic: 'F' | 'Pv' | 'house' | null }
// §catalog 4.1–4.3 — packs (primary/fallback as instrument IDs).
export const FAMILY_PACKS: FamilyPack[] = [
  // 4.1 Orthopaedics & spine
  { family: 'knee_arthroplasty', archetype: 'LONG_ARC', primary: 'koos_jr', fallback: null, lic: 'F' },
  { family: 'hip_arthroplasty', archetype: 'LONG_ARC', primary: 'hoos_jr', fallback: null, lic: 'F' },
  { family: 'knee_arthroscopy_acl', archetype: 'LONG_ARC', primary: 'koos', fallback: null, lic: 'F' },
  { family: 'shoulder', archetype: 'LONG_ARC', primary: 'spadi', fallback: 'hs-shoulder', lic: 'F' },
  { family: 'hand_wrist', archetype: 'STANDARD', primary: 'prwe', fallback: 'hs-wrist', lic: 'Pv' },   // 2a: Pv-unconfirmed → hs-wrist
  { family: 'foot_ankle', archetype: 'STANDARD', primary: 'faam', fallback: null, lic: 'F' },
  { family: 'fracture_trauma', archetype: 'STANDARD', primary: null, fallback: null, lic: null },
  { family: 'lumbar_spine', archetype: 'LONG_ARC', primary: 'rmdq', fallback: 'hs-lumbar', lic: 'F' },
  { family: 'cervical_spine', archetype: 'LONG_ARC', primary: 'ndi', fallback: null, lic: 'F' },   // 2b: NDI is free/public-domain — corrected Pv→F
  // 4.2 High-volume observed families
  { family: 'proctology', archetype: 'DAYCARE', primary: 'hs-procto', fallback: 'wexner', lic: 'F' },
  { family: 'cholecystectomy', archetype: 'STANDARD', primary: 'hs-gi', fallback: null, lic: 'house' },
  { family: 'hernia', archetype: 'STANDARD', primary: 'eurahs', fallback: 'hs-hernia', lic: 'Pv' },
  { family: 'appendicectomy_emergency', archetype: 'STANDARD', primary: null, fallback: null, lic: null },
  { family: 'minor_excisions', archetype: 'DAYCARE', primary: null, fallback: null, lic: null },
  { family: 'circumcision_adult', archetype: 'DAYCARE', primary: 'hs-recovery', fallback: null, lic: 'house' },
  { family: 'bph_turp_laser', archetype: 'STANDARD', primary: 'ipss', fallback: 'hs-luts', lic: 'F' },
  { family: 'urinary_stones', archetype: 'STANDARD', primary: 'hs-stone', fallback: null, lic: 'house' },
  { family: 'scrotal', archetype: 'DAYCARE', primary: null, fallback: null, lic: null },
  { family: 'hysterectomy', archetype: 'STANDARD', primary: 'hs-gyn', fallback: null, lic: 'house' },
  { family: 'fibroids_myomectomy', archetype: 'STANDARD', primary: 'ufsqol', fallback: 'hs-fibroid', lic: 'Pv' },   // 2a: Pv-unconfirmed → hs-fibroid
  { family: 'endometriosis', archetype: 'STANDARD', primary: 'ehp5', fallback: 'hs-endo', lic: 'Pv' },   // 2a: Pv-unconfirmed → hs-endo
  { family: 'hysteroscopy_mirena', archetype: 'SCOPE', primary: null, fallback: null, lic: null },
  { family: 'prolapse', archetype: 'STANDARD', primary: 'pfdi20', fallback: 'hs-prolapse', lic: 'Pv' },   // 2a: Pv-unconfirmed → hs-prolapse
  { family: 'septoplasty_turbinoplasty', archetype: 'STANDARD', primary: 'nose', fallback: null, lic: 'F' },
  { family: 'fess_sinus', archetype: 'STANDARD', primary: 'snot22', fallback: 'hs-sinus', lic: 'Pv' },
  { family: 'tonsillectomy', archetype: 'DAYCARE', primary: 'hs-tonsil', fallback: null, lic: 'house' },
  // facial/ENT (UID-map rider 1, 12 Jul) — nasal-fracture & kin; no pack yet → CORE+PREM safe floor.
  { family: 'facial_ent', archetype: 'STANDARD', primary: null, fallback: null, lic: null },
  { family: 'diagnostic_endoscopy', archetype: 'SCOPE', primary: null, fallback: null, lic: null },
  // 4.3 Anticipated / dormant
  { family: 'cataract', archetype: 'DAYCARE', primary: 'catquest9sf', fallback: 'hs-visual', lic: 'Pv' },
  { family: 'breast', archetype: 'STANDARD', primary: null, fallback: null, lic: null },
  { family: 'thyroid', archetype: 'STANDARD', primary: 'hs-thyroid', fallback: null, lic: 'house' },
  { family: 'bariatric', archetype: 'LONG_ARC', primary: null, fallback: null, lic: null },
  { family: 'varicose_veins', archetype: 'STANDARD', primary: 'avvq', fallback: 'hs-varicose', lic: 'Pv' },   // 2a: Pv-unconfirmed → hs-varicose
  { family: 'cardiac', archetype: 'LONG_ARC', primary: 'nyha', fallback: null, lic: null },
  { family: 'thoracic', archetype: 'ONCO_MAJOR', primary: null, fallback: null, lic: null },
  { family: 'cranial_neuro', archetype: 'LONG_ARC', primary: null, fallback: null, lic: null },
  { family: 'paediatric_surgery', archetype: 'STANDARD', primary: 'whodas_proxy', fallback: null, lic: 'Pv' },
  { family: 'obstetric_csection', archetype: 'STANDARD', primary: 'hs-csection', fallback: null, lic: 'house' },
  { family: 'dental_maxillofacial', archetype: 'DAYCARE', primary: 'ohip14', fallback: 'hs-dental', lic: 'Pv' },   // 2a: fallback → hs-dental; lic corrected house→Pv so the Pv-fallback rule fires (OHIP-14 aspirational primary stays until ever licensed)
  { family: 'plastics_scars', archetype: 'STANDARD', primary: null, fallback: null, lic: null },
  { family: 'onco_resections', archetype: 'ONCO_MAJOR', primary: null, fallback: null, lic: null },
];

// feasibility §4b — family regex map. ORDER = first-match-wins (as listed). Coarse keys.
// v1.1 coverage extension (12 Jul): the specific-first block below is PREPENDED so the main
// surgical families reach their EXISTING FAMILY_PACKS packs (no measurement change, no bridge).
// It also fixes the cholecystectomy misroute (cholecyst wins before minor_excision_wound's `cyst`)
// and puts bph_turp_laser + urinary_stones before the coarse `urology` pattern.
export const FAMILY_REGEX: { family: string; re: RegExp }[] = [
  // ── regex-map v1.1 — main-family coverage (prepended; specific-first) ──
  { family: 'cholecystectomy',           re: /cholecyst|gall.?bladder/i },                                   // BEFORE minor_excision_wound (cyst)
  { family: 'proctology',                re: /h(a)?emorrhoid|\bpile|fissure|fistula|sphincterotomy|hemorrhoidopexy/i },
  { family: 'hernia',                    re: /hernia|hernioplasty|herniorrhaph/i },
  { family: 'appendicectomy_emergency',  re: /appendic|appendectomy/i },
  { family: 'hysterectomy',              re: /hysterectomy/i },
  { family: 'fibroids_myomectomy',       re: /myomectomy|fibroid/i },
  { family: 'tonsillectomy',             re: /tonsil|adenoid/i },
  { family: 'bph_turp_laser',            re: /\bturp\b|prostatectomy|\bbph\b|holep|thulep|greenlight/i },      // BEFORE urology
  { family: 'urinary_stones',            re: /ureteroscop|\burs\b|pcnl|lithotrip|renal stone|ureteric stone|urolith|dj stent/i }, // BEFORE urology
  { family: 'septoplasty_turbinoplasty', re: /septoplasty|turbinoplast/i },
  { family: 'fess_sinus',                re: /\bfess\b|functional endoscopic|sinus|nasal polyp/i },
  { family: 'cataract',                  re: /cataract|phaco/i },
  { family: 'circumcision_adult',        re: /circumcision/i },
  { family: 'scrotal',                   re: /varicocele|hydrocele|orchidopexy|orchidectomy|scrotal/i },
  // ── existing coarse "168 other" tail (v1) — unchanged, universal_core last ──
  { family: 'ortho_spine', re: /laminectomy|orif|open reduction|implant removal|mua|syndesmosis|rotat(or|er) cuff|megaprosthesis/i },
  { family: 'thyroid', re: /thyroidectomy|thyroid/i },
  { family: 'obstetric', re: /lscs|caesar|c-section|delivery|mtp|tubectomy/i },
  { family: 'vascular', re: /varicose|evlt|perforator|sclerotherapy|gsv|avulsion/i },
  { family: 'plastics', re: /liposuction|scar revision|reconstruction|abdominoplasty/i },
  { family: 'minor_excision_wound', re: /excision|cyst|mole|wart|ganglion|nail|debridement|suturing|cauteris|biopsy/i },
  { family: 'urology', re: /stent|holep|urethra|meatotomy/i },
  { family: 'ent', re: /grommet|myringotomy|tongue tie|frenulo/i },
  { family: 'breast', re: /mammary|breast|mastect/i },
  { family: 'rare_major', re: /transplant|pci|bypass|craniotomy/i },
  { family: 'universal_core', re: /.*/i },   // (fallback) — always matches last
];

// Coarse regex-family → catalog pack/archetype bridge (NOT given by the frozen docs — FLAGGED).
// Maps a regex-classified coarse family to a representative pack family (for archetype + primary/fallback).
export const REGEX_FAMILY_PACK: Record<string, string> = {
  ortho_spine: 'lumbar_spine',           // ortho super-family → LONG_ARC representative
  thyroid: 'thyroid',
  obstetric: 'obstetric_csection',
  vascular: 'varicose_veins',
  plastics: 'plastics_scars',
  minor_excision_wound: 'minor_excisions',
  urology: 'urinary_stones',
  ent: 'fess_sinus',
  breast: 'breast',
  rare_major: 'onco_resections',
  universal_core: 'unknown',
};

// §5 House PREM module — 8 items, PREM-1@72h/PREM-2@close. ⚠ item text is "unchanged from v0" and NOT
// present in the provided frozen docs → text=null (entered verbatim at 0.2a-2, like validated items).
// House PREM module (8 items) — VERBATIM from the ratified draft (CDMSS-PROMS-HOUSE-PREM-MODULE-DRAFT-v1,
// approved 12 Jul). Items 1–7 on EXP4 (0–3, higher = better); item 8 overall NRS-11. House measure —
// within-hospital trend only, never externally benchmarked. Experience score = sum(prem1..prem7)→0–21.
export const PREM_MODULE: InstrumentDef = {
  id: 'prem', label: 'House PREM module', kind: 'house', scale: 'house',
  items: [
    { id: 'prem1', text: 'Before your surgery, did the team explain clearly what would happen and what to expect?', scale: 'EXP4', escalation: null },
    { id: 'prem2', text: 'During your care, did the doctors and nurses listen to you and answer your questions?', scale: 'EXP4', escalation: null },
    { id: 'prem3', text: 'Were you treated with respect and dignity by the care team?', scale: 'EXP4', escalation: null },
    { id: 'prem4', text: 'Were you as involved as you wanted to be in decisions about your care?', scale: 'EXP4', escalation: null },
    { id: 'prem5', text: 'Was your pain and discomfort managed as well as you expected?', scale: 'EXP4', escalation: null },
    { id: 'prem6', text: 'When you left, did you clearly understand how to look after yourself at home — medicines, wound care, warning signs, and follow-up?', scale: 'EXP4', escalation: null },
    { id: 'prem7', text: 'Since your surgery, when you needed help or had a question, could you reach the care team easily?', scale: 'EXP4', escalation: null },
    { id: 'prem8', text: 'Overall, how would you rate your surgical care experience? (0 = very poor, 10 = excellent)', scale: 'NRS-11', escalation: null },
  ],
  itemCount: 8, scoring: { method: 'sum', note: 'PREM-1@72h, PREM-2@close; experience sum(prem1..prem7)→0–21 (higher=better); prem8 overall NRS surfaced separately' }, licence: 'house',
};

// Service-recovery soft flag (NOT a clinical E-code) — the wired layer routes it to the care-team
// feedback list, never the clinical daily list. Ratified as drafted (12 Jul). Data only.
export const PREM_SERVICE_FLAG = { rule: 'overall (prem8) ≤ 3 OR any of prem1..prem7 = "no"', kind: 'service_recovery' } as const;

// house-sets §escalation-map — E1–E5 (verbatim).
export const ESCALATION: { code: string; rule: string }[] = [
  { code: 'E1', rule: 'pain NRS ≥ 8 after post-op day 3' },
  { code: 'E2', rule: 'any wound YN-positive with fever' },
  { code: 'E3', rule: 'function worse/much worse at ≥6w' },
  { code: 'E4', rule: 'bleeding severe+ any time' },
  { code: 'E5', rule: 'set-specific triggers marked ⚠' },
];
