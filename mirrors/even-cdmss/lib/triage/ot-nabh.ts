/**
 * lib/triage/ot-nabh.ts — deterministic NABH OT-note completeness (engine ot-nabh/0.1).
 *
 * Line-for-line port of the ot-nabh pack heuristic (scripts/score_ot_nabh.py):
 * 24 criteria, each 0 / 1 / 2, N/A only on implants_devices and specimens_collected.
 * score_pct = 100 × score_sum / score_max, rounded to 2 decimal places.
 *
 * This module is the only scorer. Admin React reads the persisted columns; it does
 * not import this function. Lander findings (ot-note-audit/0.1) are a different screen.
 */

export const OT_NABH_ENGINE_VERSION = 'ot-nabh/0.1';

export const OT_NABH_CRITERIA = [
  ['procedure_named', 'Procedure / surgery name documented'],
  ['surgeon_named', 'Operating surgeon named'],
  ['anaesthetist_named', 'Anaesthetist named'],
  ['nursing_ot_assistant', 'OT nursing / OT assistant named'],
  ['assistant_surgeon', 'Assistant surgeon named'],
  ['surgery_date', 'Surgery / OT date documented'],
  ['ot_start_end_time', 'OT start and end time documented'],
  ['laterality_side', 'Laterality / side documented when relevant'],
  ['patient_position', 'Patient position documented'],
  ['prep_scrub_drape', 'Prep / scrubbing / draping documented'],
  ['incision_described', 'Incision / approach described'],
  ['salient_operative_steps', 'Salient operative steps described'],
  ['key_intraop_findings', 'Key intraoperative findings documented'],
  ['implants_devices', 'Implants / special equipment / devices documented (or N/A)'],
  ['specimens_collected', 'Specimens / tissue sent documented (or N/A)'],
  ['estimated_blood_loss', 'Estimated blood loss documented'],
  ['postoperative_diagnosis', 'Postoperative diagnosis documented'],
  ['patient_status_before_shift', 'Patient status before shift-out documented'],
  ['postop_iv_fluids', 'Post-op IV fluids ordered / documented'],
  ['postop_medications', 'Post-op medications ordered / documented'],
  ['postop_wound_care', 'Post-op wound / dressing care documented'],
  ['postop_nursing_monitoring', 'Post-op nursing monitoring instructions'],
  ['postop_complications_watch', 'Complications to watch / inform SOS documented'],
  ['attributability_name_date_time', 'Attributability: author name + date/time'],
] as const;

export type OtNabhCriterionId = (typeof OT_NABH_CRITERIA)[number][0];

const NA_CRITERIA = new Set<OtNabhCriterionId>(['implants_devices', 'specimens_collected']);

const FALSEY = new Set([
  '', 'false', 'null', 'none', 'n/a', 'na', 'nil', '-', '--', '.', 'n.a.',
  'n.a', 'not applicable', 'nil.',
]);

const IMPLANT_RE = /\b(implant|mesh|screw|plate|prosthes|nail|wire|clip|stent|cage|anchor|iol\b|lens|k[\s-]?wire|external fix|dhs|pfn|tbw|tension band|ethilon|vicryl|prolene|stapler|harmonic|ligasure|laser|diode|catheter|drain|foley|dj\s*stent|double[\s-]?j)\b/i;
const SPECIMEN_RE = /\b(specimen|histopath|hpe|biopsy|for\s*hpe|sent\s*for|culture|cytology|frozen\s*section|tissue\s*sent)\b/i;
const IVF_RE = /\b(ivf|i\.?v\.?\s*fluids?|dns|r\.?l\.?\b|normal saline|\bns\b|rl\s*@|dns\s*@|ivf\s*|fluids?\s*@|ml\s*\/\s*hr|ml\/hr)\b/i;
const MED_RE = /\b(inj\.?|inj\b|tab\.?|tab\b|capsule|syrup|antibiotic|analgesic|augmentin|pan\b|pantop|emset|emeset|pcm|paracetamol|tramadol|diclofenac|dynapar|ondansetron|cefuroxime|dolo|nexpro|medications?)\b/i;
const WOUND_RE = /\b(dressing|wound\s*care|betadine|bandage|sterile\s*dressing|suture\s*care|keep\s*wound|wound\s*dry)\b/i;
const MONITOR_RE = /\b(monitor|vitals?|bp\b|spo2|pulse|nursing\s*care|spirometr|dvt\s*stock|incentive\s*spirom|strict\s*i[\/\s]?o|input\s*output)\b/i;
const WATCH_RE = /\b(inform\s*sos|inform\s*if|watch\s*for|w\/f|w\.f\.|report\s*if|complications?|bleeding|soakage|fever|urinary\s*retention|inform\s*duty|call\s*sos)\b/i;
const INCISION_RE = /\b(incision|pfannenstiel|midline|elliptical|port\s*placement|supraumbilical|laparoscop|open\s*approach|keratome|stab\s*incision|crease\s*incision|bikini)\b/i;
const POSITION_RE = /\b(supine|prone|lithotomy|trendelenburg|lateral|sitting|beach\s*chair|jack[\s-]?knife|frog[\s-]?leg|position)\b/i;
const PREP_RE = /\b(scrub|painted|draped|aseptic|betadine|prep(aration)?|parts\s*painted|under\s*aseptic)\b/i;
const DIAG_RE = /(post[\s-]*op(erative)?\s*diagnosis|final\s*diagnosis|diagnosis\s*:|post\s*op\s*dx|podx)/i;
const NAME_RE = /[A-Za-z]{2,}/;
const SIDE_IN_TEXT = /\b(left|right|bilateral|b\/l|b\/l|unilateral|on-left|on-right)\b/i;
const STATUS_RE = /\b(stable|shifted|extubat|conscious|vitals\s*stable)\b/i;
const EBL_RE = /minimal|mild|moderate|ml|cc|nil|less/i;

const IST = 'Asia/Kolkata';

export interface OtNabhInput {
  note?: string | null;
  component_json?: unknown;
  surgery_name?: string | null;
  surgeon?: string | null;
  created_at?: string | Date | null;
  finalized_by_username?: string | null;
}

export interface OtNabhCriterion {
  score: 0 | 1 | 2 | null;
  na?: boolean;
  evidence?: string;
}

export interface OtNabhScore {
  score_sum: number;
  score_max: number;
  score_pct: number;
  criteria: Record<OtNabhCriterionId, OtNabhCriterion>;
  engine_version: typeof OT_NABH_ENGINE_VERSION;
}

function norm(v: string | null | undefined): string {
  return (v ?? '').trim();
}

function isFalsey(v: string | null | undefined): boolean {
  return FALSEY.has(norm(v).toLowerCase());
}

function meaningful(v: string | null | undefined, minLen = 2): boolean {
  const s = norm(v);
  if (isFalsey(s)) return false;
  return s.length >= minLen && NAME_RE.test(s);
}

function isPlaceholderEquipment(v: string | null | undefined): boolean {
  const s = norm(v);
  if (isFalsey(s)) return true;
  const stripped = s.replace(/^\s*\d+\s*[.)]?\s*$/gm, '');
  const cleaned = stripped.replace(/[\s\n\r.,;:\-_/\\|]+/g, '');
  return cleaned.length < 3;
}

function decodeMs(v: string | null | undefined): Date | null {
  const s = norm(v);
  if (!/^\d{10,16}$/.test(s)) return null;
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n > 10_000_000_000) n = n / 1000;
  const dt = new Date(n * 1000);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseCreated(v: string | Date | null | undefined): Date | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const iso = (zoned ? s : `${s}+05:30`).replace(' ', 'T');
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function scorePresence(v: string | null | undefined, goodLen = 3, partialLen = 1): 0 | 1 | 2 {
  const s = norm(v);
  if (isFalsey(s)) return 0;
  if (s.length >= goodLen && NAME_RE.test(s)) return 2;
  if (s.length >= partialLen) return 1;
  return 0;
}

function scoreTextLen(v: string | null | undefined, full = 120, partial = 30): 0 | 1 | 2 {
  const s = norm(v);
  if (isFalsey(s)) return 0;
  const n = s.length;
  if (n >= full) return 2;
  if (n >= partial) return 1;
  if (n >= 5) return 1;
  return 0;
}

function lateralityScore(c: Record<string, string>, note: string, surgery: string): 0 | 1 | 2 {
  const v = norm(c['right-left']);
  const low = v.toLowerCase();
  if (low.includes('on-left') || low.includes('on-right') || low.includes('left') || low.includes('right')) return 2;
  if (low.includes('bilateral') || low.includes('b/l')) return 2;
  const blob = `${surgery}\n${note}\n${c.ot_no || ''}\n${c.opfinf || ''}`;
  if (SIDE_IN_TEXT.test(blob)) return 1;
  return 0;
}

function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** component_json → name → string. Accepts the Metabase array, a JSON string, or a parsed array. */
export function otComponents(raw: unknown): Record<string, string> {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return {};
    try { arr = JSON.parse(s); } catch { return {}; }
  }
  if (!Array.isArray(arr)) return {};
  const out: Record<string, string> = {};
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const n = e.name ?? e.key;
    if (!n) continue;
    const v = e.valueString == null ? e.value : e.valueString;
    out[String(n)] = asText(v);
  }
  return out;
}

function clip(s: string, max = 180): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtIst(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

function cell(score: 0 | 1 | 2 | null, evidence: string, na = false): OtNabhCriterion {
  const ev = clip(evidence);
  const out: OtNabhCriterion = { score: na ? null : score };
  if (na) out.na = true;
  if (ev) out.evidence = ev;
  return out;
}

/**
 * Score one OT note. `note` is the stored body (the pack used a truncation of the same text).
 * `surgeon` is the free-text surgeon column (`surgeon_raw` on ot_note_audits).
 */
export function scoreOtNabh(input: OtNabhInput): OtNabhScore {
  const c = otComponents(input.component_json);
  const note = input.note ?? '';
  const surgeryCol = norm(input.surgery_name);
  const surgeonCol = norm(input.surgeon);
  const created = parseCreated(input.created_at ?? null);

  const surgName = norm(c['surgery-name']) || surgeryCol;
  const surgeon = norm(c.surgeaon_ot_notes) || surgeonCol;
  const assist = norm(c.assist_notes);
  const otAsst = norm(c.ot_asst);
  const ans = norm(c.ans);
  const dateV = norm(c.date_ot_thearter);
  const otFrom = norm(c['ot-from']);
  const otTo = norm(c['ot-to']);
  const position = norm(c.ptnt_position);
  const scrub = norm(c.scrubbing);
  const drape = norm(c['pat-a-drap']);
  const incision = norm(c['incision-plan']);
  const steps = norm(c.ot_no);
  const findings = norm(c.opfinf);
  const equip = norm(c['special-equpiments']);
  const ksnc = norm(c.KSNC);
  const ebl = norm(c.cksnc) || norm(c.cknck);
  const postop = norm(c.JHBSC);
  const status = norm(c.CSJBCJS);
  const finalized = norm(input.finalized_by_username);

  const blobSteps = steps || note;
  const blobPost = `${postop}\n${note}`;
  const blobAll = `${surgName}\n${steps}\n${findings}\n${equip}\n${note}\n${postop}`;

  const scores: Record<OtNabhCriterionId, 0 | 1 | 2 | null> = {
    procedure_named: 0,
    surgeon_named: 0,
    anaesthetist_named: 0,
    nursing_ot_assistant: 0,
    assistant_surgeon: 0,
    surgery_date: 0,
    ot_start_end_time: 0,
    laterality_side: 0,
    patient_position: 0,
    prep_scrub_drape: 0,
    incision_described: 0,
    salient_operative_steps: 0,
    key_intraop_findings: 0,
    implants_devices: 0,
    specimens_collected: 0,
    estimated_blood_loss: 0,
    postoperative_diagnosis: 0,
    patient_status_before_shift: 0,
    postop_iv_fluids: 0,
    postop_medications: 0,
    postop_wound_care: 0,
    postop_nursing_monitoring: 0,
    postop_complications_watch: 0,
    attributability_name_date_time: 0,
  };
  const evidence: Record<OtNabhCriterionId, string> = {
    procedure_named: '',
    surgeon_named: '',
    anaesthetist_named: '',
    nursing_ot_assistant: '',
    assistant_surgeon: '',
    surgery_date: '',
    ot_start_end_time: '',
    laterality_side: '',
    patient_position: '',
    prep_scrub_drape: '',
    incision_described: '',
    salient_operative_steps: '',
    key_intraop_findings: '',
    implants_devices: '',
    specimens_collected: '',
    estimated_blood_loss: '',
    postoperative_diagnosis: '',
    patient_status_before_shift: '',
    postop_iv_fluids: '',
    postop_medications: '',
    postop_wound_care: '',
    postop_nursing_monitoring: '',
    postop_complications_watch: '',
    attributability_name_date_time: '',
  };

  scores.procedure_named = scorePresence(surgName, 3, 2);
  evidence.procedure_named = surgName ? `surgery-name: ${surgName}` : 'surgery name absent';
  scores.surgeon_named = scorePresence(surgeon, 3, 2);
  evidence.surgeon_named = surgeon ? `surgeon: ${surgeon}` : 'surgeon absent';
  scores.anaesthetist_named = scorePresence(ans, 3, 2);
  evidence.anaesthetist_named = ans ? `ans: ${ans}` : 'anaesthetist absent';
  scores.nursing_ot_assistant = scorePresence(otAsst, 3, 2);
  evidence.nursing_ot_assistant = otAsst ? `ot_asst: ${otAsst}` : 'OT assistant absent';
  scores.assistant_surgeon = scorePresence(assist, 3, 2);
  evidence.assistant_surgeon = assist ? `assist_notes: ${assist}` : 'assistant surgeon absent';

  const dt = decodeMs(dateV);
  if (dt) {
    scores.surgery_date = 2;
    evidence.surgery_date = `date_ot_thearter: ${fmtIst(dt)} IST`;
  } else if (created) {
    scores.surgery_date = 1;
    evidence.surgery_date = `note created ${fmtIst(created)} IST (no OT date field)`;
  } else {
    scores.surgery_date = 0;
    evidence.surgery_date = 'surgery date absent';
  }

  const t0 = decodeMs(otFrom);
  const t1 = decodeMs(otTo);
  if (t0 && t1 && t1.getTime() >= t0.getTime()) {
    scores.ot_start_end_time = 2;
    evidence.ot_start_end_time = `${fmtIst(t0)} → ${fmtIst(t1)} IST`;
  } else if (t0 || t1) {
    scores.ot_start_end_time = 1;
    evidence.ot_start_end_time = t0 ? `start ${fmtIst(t0)} IST, end missing or earlier` : `end ${fmtIst(t1!)} IST, start missing`;
  } else {
    scores.ot_start_end_time = 0;
    evidence.ot_start_end_time = 'OT start/end absent';
  }

  scores.laterality_side = lateralityScore(c, note, surgName);
  evidence.laterality_side = norm(c['right-left'])
    ? `right-left: ${norm(c['right-left'])}`
    : (scores.laterality_side === 1 ? 'side mentioned in narrative only' : 'laterality absent');

  if (meaningful(position, 3)) {
    scores.patient_position = 2;
    evidence.patient_position = `ptnt_position: ${position}`;
  } else if (POSITION_RE.test(blobSteps)) {
    scores.patient_position = 1;
    evidence.patient_position = 'position mentioned in operative narrative';
  } else {
    scores.patient_position = 0;
    evidence.patient_position = 'patient position absent';
  }

  const scrubOk = meaningful(scrub, 2) || (!isFalsey(scrub) && scrub.length >= 2);
  const drapeOk = meaningful(drape, 2) || (!isFalsey(drape) && drape.length >= 2);
  if (scrubOk && drapeOk) {
    scores.prep_scrub_drape = 2;
    evidence.prep_scrub_drape = `scrubbing: ${scrub}; draping: ${drape}`;
  } else if (scrubOk || drapeOk || PREP_RE.test(blobSteps)) {
    scores.prep_scrub_drape = 1;
    evidence.prep_scrub_drape = scrubOk || drapeOk
      ? `partial prep (scrubbing: ${scrub || '—'}; draping: ${drape || '—'})`
      : 'prep mentioned in operative narrative';
  } else {
    scores.prep_scrub_drape = 0;
    evidence.prep_scrub_drape = 'prep / scrub / drape absent';
  }

  if (meaningful(incision, 3)) {
    scores.incision_described = 2;
    evidence.incision_described = `incision-plan: ${incision}`;
  } else if (INCISION_RE.test(blobSteps)) {
    scores.incision_described = 1;
    evidence.incision_described = 'incision mentioned in operative narrative';
  } else {
    scores.incision_described = 0;
    evidence.incision_described = 'incision absent';
  }

  scores.salient_operative_steps = scoreTextLen(steps, 150, 40);
  const noteSteps = scoreTextLen(note, 200, 60);
  if (scores.salient_operative_steps === 0 && noteSteps) {
    scores.salient_operative_steps = Math.min(2, noteSteps) as 0 | 1 | 2;
  }
  evidence.salient_operative_steps = steps
    ? `ot_no (${steps.length} chars): ${steps}`
    : (note ? `note fallback (${note.length} chars)` : 'operative steps absent');

  scores.key_intraop_findings = scoreTextLen(findings, 40, 15);
  evidence.key_intraop_findings = findings ? `opfinf (${findings.length} chars): ${findings}` : 'intraoperative findings absent';

  let implantsNa = false;
  if (!isPlaceholderEquipment(equip) && IMPLANT_RE.test(equip)) {
    scores.implants_devices = 2;
    evidence.implants_devices = `special-equpiments: ${equip}`;
  } else if (!isPlaceholderEquipment(equip) && equip.length >= 4) {
    scores.implants_devices = 1;
    evidence.implants_devices = `special-equpiments: ${equip}`;
  } else if (IMPLANT_RE.test(blobAll)) {
    scores.implants_devices = 1;
    evidence.implants_devices = 'implant or device mentioned in the note';
  } else {
    implantsNa = true;
    scores.implants_devices = null;
    evidence.implants_devices = 'no implant or device documented';
  }

  let specimensNa = false;
  const klow = ksnc.toLowerCase();
  if (klow === 'yes' || klow === 'y' || klow === 'true' || klow === '1') {
    scores.specimens_collected = 2;
    evidence.specimens_collected = `KSNC: ${ksnc}`;
  } else if (SPECIMEN_RE.test(blobAll)) {
    // Pack heuristic: substring "sent", not a word boundary (score_ot_nabh.py).
    scores.specimens_collected = blobAll.toLowerCase().includes('sent') ? 2 : 1;
    evidence.specimens_collected = 'specimen language in the note';
  } else if (klow === 'no' || klow === 'n' || klow === 'false' || klow === '0' || isFalsey(ksnc)) {
    specimensNa = true;
    scores.specimens_collected = null;
    evidence.specimens_collected = ksnc ? `KSNC: ${ksnc}` : 'no specimen documented';
  } else {
    specimensNa = true;
    scores.specimens_collected = null;
    evidence.specimens_collected = `KSNC: ${ksnc}`;
  }

  if (meaningful(ebl, 1) && (/\d/.test(ebl) || EBL_RE.test(ebl))) {
    scores.estimated_blood_loss = 2;
    evidence.estimated_blood_loss = `cksnc: ${ebl}`;
  } else if (meaningful(ebl, 2)) {
    scores.estimated_blood_loss = 1;
    evidence.estimated_blood_loss = `cksnc: ${ebl}`;
  } else {
    scores.estimated_blood_loss = 0;
    evidence.estimated_blood_loss = 'estimated blood loss absent';
  }

  if (DIAG_RE.test(note) || DIAG_RE.test(postop) || DIAG_RE.test(findings)) {
    scores.postoperative_diagnosis = 2;
    evidence.postoperative_diagnosis = 'post-operative diagnosis phrase present';
  } else if (meaningful(findings, 20)) {
    scores.postoperative_diagnosis = 1;
    evidence.postoperative_diagnosis = 'findings used as diagnosis proxy';
  } else {
    scores.postoperative_diagnosis = 0;
    evidence.postoperative_diagnosis = 'post-operative diagnosis absent';
  }

  if (meaningful(status, 3)) {
    scores.patient_status_before_shift = 2;
    evidence.patient_status_before_shift = `CSJBCJS: ${status}`;
  } else if (STATUS_RE.test(note)) {
    scores.patient_status_before_shift = 1;
    evidence.patient_status_before_shift = 'shift-out status mentioned in the note';
  } else {
    scores.patient_status_before_shift = 0;
    evidence.patient_status_before_shift = 'status before shift absent';
  }

  if (IVF_RE.test(blobPost)) {
    scores.postop_iv_fluids = 2;
    evidence.postop_iv_fluids = 'IV fluid order in post-op text';
  } else if (/\biv\b/i.test(blobPost) && /fluid/i.test(blobPost)) {
    scores.postop_iv_fluids = 1;
    evidence.postop_iv_fluids = 'IV and fluid mentioned separately';
  } else {
    scores.postop_iv_fluids = 0;
    evidence.postop_iv_fluids = 'post-op IV fluids absent';
  }

  scores.postop_medications = MED_RE.test(blobPost) ? 2 : 0;
  evidence.postop_medications = scores.postop_medications === 2 ? 'post-op medication order present' : 'post-op medications absent';
  scores.postop_wound_care = WOUND_RE.test(blobPost) ? 2 : 0;
  evidence.postop_wound_care = scores.postop_wound_care === 2 ? 'wound / dressing care present' : 'wound care absent';
  scores.postop_nursing_monitoring = MONITOR_RE.test(blobPost) ? 2 : 0;
  evidence.postop_nursing_monitoring = scores.postop_nursing_monitoring === 2 ? 'nursing monitoring instruction present' : 'nursing monitoring absent';
  scores.postop_complications_watch = WATCH_RE.test(blobPost) ? 2 : 0;
  evidence.postop_complications_watch = scores.postop_complications_watch === 2 ? 'complications watch / inform SOS present' : 'complications watch absent';

  const hasName = meaningful(finalized, 3) || meaningful(surgeon, 3);
  const hasDt = Boolean(created) || Boolean(dt) || Boolean(t0);
  if (hasName && hasDt) {
    scores.attributability_name_date_time = 2;
    evidence.attributability_name_date_time = `author ${finalized || surgeon}`;
  } else if (hasName || hasDt) {
    scores.attributability_name_date_time = 1;
    evidence.attributability_name_date_time = hasName ? `name only: ${finalized || surgeon}` : 'timestamp only';
  } else {
    scores.attributability_name_date_time = 0;
    evidence.attributability_name_date_time = 'author and time absent';
  }

  let scoreSum = 0;
  let applicable = 0;
  for (const [key] of OT_NABH_CRITERIA) {
    const val = scores[key];
    if (val == null && NA_CRITERIA.has(key)) continue;
    applicable += 1;
    scoreSum += val ?? 0;
  }
  const scoreMax = 2 * applicable;
  const scorePct = scoreMax ? round2((100 * scoreSum) / scoreMax) : 0;

  const criteria = {} as Record<OtNabhCriterionId, OtNabhCriterion>;
  for (const [key] of OT_NABH_CRITERIA) {
    const na = key === 'implants_devices' ? implantsNa : key === 'specimens_collected' ? specimensNa : false;
    criteria[key] = cell(scores[key], evidence[key], na);
  }

  return {
    score_sum: scoreSum,
    score_max: scoreMax,
    score_pct: scorePct,
    criteria,
    engine_version: OT_NABH_ENGINE_VERSION,
  };
}

/** Score a persisted ot_note_audits row. Uses stored note + component_json (+ column fallbacks). */
export function scoreOtNabhFromStored(row: {
  note?: unknown;
  component_json?: unknown;
  surgery_name?: unknown;
  surgeon_raw?: unknown;
  note_created_at?: unknown;
  finalized_by_username?: unknown;
}): OtNabhScore {
  const created = row.note_created_at instanceof Date
    ? row.note_created_at
    : row.note_created_at == null || row.note_created_at === ''
      ? null
      : String(row.note_created_at);
  return scoreOtNabh({
    note: row.note == null ? null : String(row.note),
    component_json: row.component_json,
    surgery_name: row.surgery_name == null ? null : String(row.surgery_name),
    surgeon: row.surgeon_raw == null ? null : String(row.surgeon_raw),
    created_at: created,
    finalized_by_username: row.finalized_by_username == null ? null : String(row.finalized_by_username),
  });
}
