/**
 * lib/case-ask/stewardship-material.ts — the stewardship room's half of the shared case-Ask shell
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A2 / A3 / A6; spec §6.1–§6.2).
 *
 * A2 says it in one line: "One new material builder in one new file … for the physician and dept
 * cases." Everything else the box does — the citation gate, the caps, the IST daily ceiling, the
 * de-identification fence, the withheld-turn discipline, the Opus pin with no ladder — already
 * exists once in lib/case-ask-core.ts and lib/case-ask/{ask,serve,store}.ts and is NOT re-specified,
 * re-implemented or forked here. This file answers exactly one question: given a physician or a
 * department, what has the system already stored about them that an answer may cite?
 *
 * WHAT IS DIFFERENT ABOUT THESE TWO CASES, and why it is worth saying out loud: `opd` and `ipd` are
 * ONE audited artefact. `physician` and `dept` are a 90-DAY AGGREGATE over many. The fence is
 * unchanged in kind but stricter in effect — an aggregate crosses many patients, so nothing
 * patient-level may enter it at all. What the model sees here is counts, means, rates and finding
 * SUBJECTS. It never sees a note, a stay, a uid, a date of service, or one patient's anything.
 *
 * THE ONE THING THIS FILE MAY NOT DO. It reads. It never writes. No score, no band, no verdict, no
 * pill, no `physician_standing` — S4 owns the overlay and it is not built here. The turns are stored
 * by the route through lib/case-ask/store.ts, as on every other surface.
 *
 * ⚠️ THE IPD LEG IS ABSENT FROM THE PHYSICIAN CASE, BY DECISION, NOT BY OMISSION (A1 / D-identity).
 * `opd_note_audits.doctor_uid` and the IPD treating consultant are not the same key on this spine.
 * S3 will join what a practitioner id resolves; until it lands, the physician material says so in
 * its own words rather than presenting an OPD-only record as a whole one. The DEPARTMENT case can
 * carry an inpatient reading today, because a department needs no doctor hop — `ipd_speciality` is
 * its own vocabulary and its own case key (A3), never merged with the OPD one.
 *
 * ⚠️ INFERRED SQL THROUGHOUT: this sandbox has no live Neon. Every query below is listed verbatim in
 * the S1 slice report for validation. Every read is fail-safe — a fault degrades that part of the
 * material to nothing with an honest gap line, never a 500 and never a guessed number.
 */
import { sql } from '../db';
import { deidentify, type CaseAskItem, type CaseAskMaterial, type CaseAskType } from '../case-ask-core';
import { STANDING_PROMPT_CLAUSE, STANDING_REPLY_SCHEMA } from '../physician-standing-core';
import {
  IPD_DEPT_LABEL_SQL, IPD_DEPT_UNASSIGNED, OPD_DEPT_LABEL_SQL, OPD_DEPT_UNSPECIFIED,
  STEWARDSHIP_WINDOW_DAYS, ipdCanonParams, ipdCanonical90d, opdCanonParams, opdCanonical90d,
} from '../stewardship-canonical';
import type { CaseAskLoad } from './serve';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
/** Fail-safe read: any fault is an empty contribution, never a throw (the discipline store.ts sets). */
async function rowsOf(text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  try { return await run(text, params); } catch { return []; }
}

/**
 * S4 — the overlay clause, on BOTH stewardship materials and on no others. It is the only surface
 * whose reviewer is a medical superintendent adjudicating a clinician, which is the only thing the
 * standing overlay records. OPD and IPD keep O5's "no overlay this ship" by simply never setting
 * this field, and a test pins that their prompts do not move a byte.
 */
const OVERLAY = Object.freeze({ clause: STANDING_PROMPT_CLAUSE, schema: STANDING_REPLY_SCHEMA });

const num = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? '' : String(v));
/** Trim for the prompt, and scrub identifier SHAPES on the way in. The per-case builders do not do
 *  this (their text is one de-identified audit row); an aggregate crosses many patients, so a
 *  free-text subject that ever carried an id must not become the one that leaks. */
const clip = (v: unknown, n = 200): string => deidentify(String(v ?? '').replace(/\s+/g, ' ').trim()).slice(0, n);

// ── A3 — the thread keys, verbatim. Do not invent, do not reformat. ────────────────────────

/**
 * A3: `engine_version = 'opd-0.81.x+ipd-0.2|90d'` for BOTH stewardship case types.
 *
 * This deliberately changes the "new engine version = new thread" semantics for these two case
 * types only, and the reason is worth stating where the string lives: an OPD patch bump happens
 * every few weeks and does not change what an MS is arguing about. On a per-note case a new version
 * genuinely IS a new set of numbers, so R9's rule is right there; on a 90-day aggregate over a
 * whole engine family it would throw away the adjudication thread for a rounding change. The string
 * bumps only when V ratifies a material change in what the board reads.
 */
export const STEWARDSHIP_THREAD_ENGINE = 'opd-0.81.x+ipd-0.2|90d';

/** A3 — the department key's vocabulary tag. Two vocabularies, never merged (D-identity / §4). */
export const DEPT_VOCABS = ['opd_speciality', 'ipd_speciality'] as const;
export type DeptVocab = (typeof DEPT_VOCABS)[number];

/** A3 — `case_key = '<vocab>:<label>'`. The label may contain anything a speciality string does. */
export function deptCaseKey(vocab: DeptVocab, label: string): string {
  return `${vocab}:${label}`;
}

/** The inverse. Splits on the FIRST colon only, so a label containing one survives the round trip. */
export function parseDeptCaseKey(key: string): { vocab: DeptVocab; label: string } | null {
  const raw = typeof key === 'string' ? key : '';
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  const vocab = raw.slice(0, i);
  const label = raw.slice(i + 1).trim();
  if (!label) return null;
  return (DEPT_VOCABS as readonly string[]).includes(vocab) ? { vocab: vocab as DeptVocab, label } : null;
}

/** The two stewardship case types, as a value — the room's own half of the CaseAskType union. */
export const STEWARDSHIP_CASE_TYPES = ['physician', 'dept'] as const;
export type StewardshipCaseType = (typeof STEWARDSHIP_CASE_TYPES)[number];
export function isStewardshipCaseType(v: unknown): v is StewardshipCaseType {
  return typeof v === 'string' && (STEWARDSHIP_CASE_TYPES as readonly string[]).includes(v);
}

// ── the shapes the loaders return and the builders consume (PURE seam) ─────────────────────

export interface OpdAggregate {
  n_notes: number; avg_nqi: number; pct_ab: number;
  avg_appr: number; avg_presc: number; avg_doc: number; avg_complete: number;
  pct_low: number; sum_low: number; sum_interactions: number;
}
export interface PhysicianFacts {
  doctorName: string; speciality: string;
  own: OpdAggregate;
  /** The department the directory puts this clinician in, aggregated the same way. */
  peers: { dept: string; n_doctors: number; n_notes: number; avg_nqi: number; pct_low: number } | null;
  findings: { subject: string; signal_type: string; n: number }[];
}
export interface DeptOpdFacts {
  label: string;
  agg: OpdAggregate;
  clinicians: { doctor_name: string; n_notes: number; avg_nqi: number; pct_low: number }[];
  findings: { subject: string; signal_type: string; n: number }[];
}
export interface DeptIpdFacts {
  label: string;
  n_stays: number; avg_cvi: number; pct_ab: number; avg_safety: number; avg_complete: number;
  findings: { subject: string; domain: string; n: number }[];
}

const EMPTY_OPD_AGG: OpdAggregate = {
  n_notes: 0, avg_nqi: 0, pct_ab: 0, avg_appr: 0, avg_presc: 0, avg_doc: 0,
  avg_complete: 0, pct_low: 0, sum_low: 0, sum_interactions: 0,
};

function opdAggOf(r: Record<string, unknown> | undefined): OpdAggregate {
  if (!r) return { ...EMPTY_OPD_AGG };
  return {
    n_notes: num(r.n_notes), avg_nqi: num(r.avg_nqi), pct_ab: num(r.pct_ab),
    avg_appr: num(r.avg_appr), avg_presc: num(r.avg_presc), avg_doc: num(r.avg_doc),
    avg_complete: num(r.avg_complete), pct_low: num(r.pct_low),
    sum_low: num(r.sum_low), sum_interactions: num(r.sum_interactions),
  };
}

// ── the builders (PURE — no DB, no clock, no model) ───────────────────────────────────────

/** The already-scored numbers, as C-items, in the order the board shows them. */
function opdScoreItems(agg: OpdAggregate, noun: string): CaseAskItem[] {
  const items: CaseAskItem[] = [];
  let c = 0;
  const add = (label: string, text: string) => { if (text) items.push({ id: `C${++c}`, kind: 'stored number', label, text }); };
  add('Audited volume', `${agg.n_notes} audited ${noun} in the last ${STEWARDSHIP_WINDOW_DAYS} days, counted one row per note`);
  if (agg.n_notes > 0) {
    add('Average note-quality index', `${agg.avg_nqi} out of 100 · ${agg.pct_ab}% of those notes are in band A or B`);
    add('Appropriateness', `${agg.avg_appr} out of 100, averaged over those notes`);
    add('Prescribing safety', `${agg.avg_presc} out of 100, averaged over those notes`);
    add('Documentation', `${agg.avg_doc} out of 100, averaged over those notes`);
    add('Documentation completeness', `${agg.avg_complete}%, averaged over those notes`);
    add('Low-value care', `${agg.pct_low}% of those notes carry at least one low-value finding · ${agg.sum_low} such findings in total`);
    add('Interaction alerts', `${agg.sum_interactions} across those notes`);
  }
  return items;
}

/** Recurring findings, as F-items. `n` is how many times the subject fired in the window. */
function findingItems(rows: readonly { subject: string; signal_type?: string; domain?: string; n: number }[]): CaseAskItem[] {
  return rows.map((f, i) => ({
    id: `F${i + 1}`,
    kind: 'finding that recurs in the window',
    label: clip(f.subject, 160) || `finding ${i + 1}`,
    text: [
      clip(f.signal_type ?? f.domain ?? '', 60),
      `fired ${f.n} time${f.n === 1 ? '' : 's'} in the window`,
    ].filter(Boolean).join(' · '),
  }));
}

/**
 * PURE — the physician case's material.
 *
 * The honest hole is load-bearing and comes FIRST in `gaps`: this record is the clinician's OPD
 * notes only. A1 says the IPD leg is joined at read time through a practitioner id in S3; until
 * then, an answer that talked about "this clinician's inpatients" would be describing stays nobody
 * has attributed to them. The sentence below is the split banner, said to the model.
 */
export function physicianAskMaterial(f: PhysicianFacts): CaseAskMaterial {
  const items = [...opdScoreItems(f.own, 'OPD consultation note(s)'), ...findingItems(f.findings)];
  if (f.peers && f.peers.n_notes > 0) {
    items.push({
      id: 'P1',
      kind: 'the department this clinician sits in, for comparison',
      label: f.peers.dept,
      text: `${f.peers.n_doctors} clinician(s) · ${f.peers.n_notes} audited notes · average note-quality ${f.peers.avg_nqi} · ${f.peers.pct_low}% of notes carry a low-value finding`,
    });
  }

  const gaps: string[] = [
    'this record is the clinician\'s OPD consultation notes only — the OPD note key and the inpatient treating-consultant key are not the same physician key on this spine, so no inpatient stay is attributed here and nothing in this material describes their inpatient work',
  ];
  if (f.own.n_notes === 0) {
    gaps.push(`no audited notes for this clinician in the last ${STEWARDSHIP_WINDOW_DAYS} days — that is an absence of audited work, not an absence of findings and not clean work`);
  }
  if (!f.findings.length && f.own.n_notes > 0) {
    gaps.push('no finding recurred often enough in the window to be listed — that is an absence of a repeated pattern, not an absence of findings');
  }
  if (!f.peers || f.peers.n_notes === 0) {
    gaps.push('no department peer group could be read for this clinician, so nothing here says how they compare with anyone');
  }

  return {
    caseType: 'physician',
    engineVersion: STEWARDSHIP_THREAD_ENGINE,
    items,
    gaps,
    overlay: OVERLAY,
    readingNote: aggregateReadingNote(
      `This record is ONE named clinician's own audited OPD work over the last ${STEWARDSHIP_WINDOW_DAYS} days${f.doctorName ? `: ${clip(f.doctorName, 80)}` : ''}${f.speciality ? `, ${clip(f.speciality, 80)}` : ''}.`,
    ),
  };
}

/** PURE — the department case, OPD vocabulary. */
export function deptOpdAskMaterial(f: DeptOpdFacts): CaseAskMaterial {
  const items = [...opdScoreItems(f.agg, 'OPD consultation note(s)'), ...findingItems(f.findings)];
  f.clinicians.forEach((c, i) => {
    items.push({
      id: `P${i + 1}`,
      kind: 'a clinician in this department',
      label: clip(c.doctor_name, 80) || `clinician ${i + 1}`,
      text: `${c.n_notes} audited notes · average note-quality ${c.avg_nqi} · ${c.pct_low}% of notes carry a low-value finding`,
    });
  });

  const gaps: string[] = [
    'this department label comes from the OPD speciality vocabulary; the inpatient speciality vocabulary is a different list of strings and the two are never merged, so nothing here is an inpatient department number',
  ];
  if (f.agg.n_notes === 0) gaps.push(`no audited notes for this department in the last ${STEWARDSHIP_WINDOW_DAYS} days — an absence of audited work, not clean work`);
  if (!f.clinicians.length && f.agg.n_notes > 0) gaps.push('no clinician could be named for this department, so nothing here attributes any of these numbers to a person');

  return {
    caseType: 'dept',
    engineVersion: STEWARDSHIP_THREAD_ENGINE,
    items,
    gaps,
    overlay: OVERLAY,
    readingNote: aggregateReadingNote(
      `This record is ONE department's audited OPD work over the last ${STEWARDSHIP_WINDOW_DAYS} days: ${clip(f.label, 80)}, as the OPD speciality vocabulary names it.`,
    ),
  };
}

/** PURE — the department case, inpatient vocabulary. A6's recipe, and A6's exclusion, said aloud. */
export function deptIpdAskMaterial(f: DeptIpdFacts): CaseAskMaterial {
  const items: CaseAskItem[] = [];
  let c = 0;
  const add = (label: string, text: string) => { if (text) items.push({ id: `C${++c}`, kind: 'stored number', label, text }); };
  add('Audited volume', `${f.n_stays} audited inpatient stay(s) in the last ${STEWARDSHIP_WINDOW_DAYS} days, counted one row per stay`);
  if (f.n_stays > 0) {
    add('Care-Value Index', `${f.avg_cvi} out of 100, averaged over those stays · ${f.pct_ab}% of them are in band A or B — a single-run estimate carrying about one band of noise`);
    add('Safety domain', `${f.avg_safety} out of 100, averaged over those stays`);
    add('Documentation completeness', `${f.avg_complete}%, averaged over those stays`);
  }
  items.push(...findingItems(f.findings));

  const gaps: string[] = [
    'this department label comes from the inpatient speciality vocabulary; the OPD speciality vocabulary is a different list of strings and the two are never merged, so nothing here is an OPD department number',
    'only the discharge-summary audit is counted in these numbers — the stay-level reading of the same stays is drill context on the case page and is deliberately not in this aggregate',
    'no clinician is attributed here: the inpatient treating consultant is a name on this spine, not the physician key the OPD side uses, so these numbers belong to the department and to no named person',
  ];
  if (f.n_stays === 0) gaps.push(`no audited stays for this department in the last ${STEWARDSHIP_WINDOW_DAYS} days — an absence of audited work, not clean work`);

  return {
    caseType: 'dept',
    engineVersion: STEWARDSHIP_THREAD_ENGINE,
    items,
    gaps,
    overlay: OVERLAY,
    readingNote: aggregateReadingNote(
      `This record is ONE department's audited inpatient work over the last ${STEWARDSHIP_WINDOW_DAYS} days: ${clip(f.label, 80)}, as the inpatient speciality vocabulary names it.`,
    ),
  };
}

/**
 * The sentence that travels with every stewardship material, and the reason the shell's optional
 * `readingNote` field is the right place for it: the model's whole prompt is written for ONE case,
 * and these two case types are not one. Without this it would read "no findings" as "a clean note"
 * at aggregate scale — the exact misreading the shell already refuses at case scale.
 */
function aggregateReadingNote(lead: string): string {
  return `${lead} It is an AGGREGATE of many audited artefacts, not a single case: every number here is a count, a mean or a rate over that window, and no sentence in it describes one patient, one note or one stay. A rate is not a verdict on any individual encounter, and an absence in this material is an absence of a RECORDED pattern, never evidence that the care was right.`;
}

// ── the loaders (IMPURE — Neon reads, all fail-safe, all INFERRED) ─────────────────────────

const isDoctorUid = (s: string) => /^[A-Za-z0-9_-]{6,64}$/.test(s);

/** Q0 — does this clinician exist in the synced directory? Keeps a real clinician with zero audited
 *  notes reachable, and keeps a made-up uid from opening a thread against nothing. */
const DIRECTORY_SQL =
  `SELECT COALESCE(NULLIF(doctor_name, ''), '') AS doctor_name,
          COALESCE(NULLIF(speciality, ''), '${OPD_DEPT_UNSPECIFIED}') AS speciality
     FROM doctor_directory WHERE doctor_uid = $1 LIMIT 1`;

/** The aggregate projection, shared by the physician read and the department read. */
const OPD_AGG_SELECT = `
  count(*)::int AS n_notes,
  round(avg(t.note_quality_index))::int AS avg_nqi,
  round(100.0 * avg(CASE WHEN t.band IN ('A','B') THEN 1 ELSE 0 END))::int AS pct_ab,
  round(avg(t.score_appropriateness))::int AS avg_appr,
  round(avg(t.score_prescribing_safety))::int AS avg_presc,
  round(avg(t.score_documentation))::int AS avg_doc,
  round(avg(t.completeness_pct))::int AS avg_complete,
  round(100.0 * avg(CASE WHEN t.n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low,
  sum(t.n_low_value)::int AS sum_low,
  sum(t.n_interaction_alerts)::int AS sum_interactions`;

const OPD_AGG_COLS = `doctor_uid, note_quality_index, band,
    score_appropriateness, score_prescribing_safety, score_documentation,
    completeness_pct, n_low_value, n_interaction_alerts`;

/** Q1 — one clinician's 90-day aggregate on the board's own canonical basis. */
const PHYSICIAN_AGG_SQL = `
  SELECT ${OPD_AGG_SELECT}
  FROM ( ${opdCanonical90d(OPD_AGG_COLS)} ) t
  WHERE t.doctor_uid = $3`;

/** Q2 — the department that clinician sits in, aggregated the same way. */
const PEER_AGG_SQL = `
  SELECT ${OPD_DEPT_LABEL_SQL} AS dept,
         count(DISTINCT t.doctor_uid)::int AS n_doctors,
         count(*)::int AS n_notes,
         round(avg(t.note_quality_index))::int AS avg_nqi,
         round(100.0 * avg(CASE WHEN t.n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low
  FROM ( ${opdCanonical90d('doctor_uid, note_quality_index, n_low_value')} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  WHERE ${OPD_DEPT_LABEL_SQL} = $3
  GROUP BY 1`;

/** Q3 — what recurs in one clinician's notes. Informational findings are excluded: they do not move
 *  the score and listing them as a pattern would overstate what the engine actually asserted. */
const PHYSICIAN_FINDINGS_SQL = `
  SELECT f->>'subject' AS subject, COALESCE(f->>'signal_type', '') AS signal_type, count(*)::int AS n
  FROM ( ${opdCanonical90d('doctor_uid, findings')} ) t
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.findings) = 'array' THEN t.findings ELSE '[]'::jsonb END) f
  WHERE t.doctor_uid = $3
    AND COALESCE((f->>'informational')::boolean, false) = false
    AND COALESCE(f->>'subject', '') <> ''
  GROUP BY 1, 2 HAVING count(*) >= 2 ORDER BY n DESC, 1 LIMIT 12`;

/** Q4 — one OPD department's 90-day aggregate. */
const DEPT_AGG_SQL = `
  SELECT ${OPD_AGG_SELECT}
  FROM ( ${opdCanonical90d(OPD_AGG_COLS)} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  WHERE ${OPD_DEPT_LABEL_SQL} = $3`;

/** Q5 — the named clinicians inside that department. */
const DEPT_CLINICIANS_SQL = `
  SELECT COALESCE(NULLIF(dd.doctor_name, ''), '(unknown)') AS doctor_name,
         count(*)::int AS n_notes,
         round(avg(t.note_quality_index))::int AS avg_nqi,
         round(100.0 * avg(CASE WHEN t.n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low
  FROM ( ${opdCanonical90d('doctor_uid, note_quality_index, n_low_value')} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  WHERE ${OPD_DEPT_LABEL_SQL} = $3
  GROUP BY t.doctor_uid, dd.doctor_name
  ORDER BY n_notes DESC, 1 LIMIT 25`;

/** Q6 — what recurs across that department. */
const DEPT_FINDINGS_SQL = `
  SELECT f->>'subject' AS subject, COALESCE(f->>'signal_type', '') AS signal_type, count(*)::int AS n
  FROM ( ${opdCanonical90d('doctor_uid, findings')} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.findings) = 'array' THEN t.findings ELSE '[]'::jsonb END) f
  WHERE ${OPD_DEPT_LABEL_SQL} = $3
    AND COALESCE((f->>'informational')::boolean, false) = false
    AND COALESCE(f->>'subject', '') <> ''
  GROUP BY 1, 2 HAVING count(*) >= 3 ORDER BY n DESC, 1 LIMIT 12`;

/** Q7 — one inpatient department's 90-day aggregate, on A6's canonical recipe. */
const DEPT_IPD_AGG_SQL = `
  SELECT count(*)::int AS n_stays,
         round(avg(t.care_value_index))::int AS avg_cvi,
         round(100.0 * avg(CASE WHEN t.band IN ('A','B') THEN 1 ELSE 0 END))::int AS pct_ab,
         round(avg(t.score_safety))::int AS avg_safety,
         round(avg(t.completeness_pct))::int AS avg_complete
  FROM ( ${ipdCanonical90d('speciality, care_value_index, band, score_safety, completeness_pct')} ) t
  WHERE ${IPD_DEPT_LABEL_SQL} = $2`;

/** Q8 — what recurs across that inpatient department. IPD findings carry no `informational` flag of
 *  their own on this table, so none is invented: every subject the audit wrote is counted. */
const DEPT_IPD_FINDINGS_SQL = `
  SELECT f->>'subject' AS subject, COALESCE(f->>'domain', '') AS domain, count(*)::int AS n
  FROM ( ${ipdCanonical90d('speciality, findings')} ) t
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.findings) = 'array' THEN t.findings ELSE '[]'::jsonb END) f
  WHERE ${IPD_DEPT_LABEL_SQL} = $2
    AND COALESCE(f->>'subject', '') <> ''
  GROUP BY 1, 2 HAVING count(*) >= 2 ORDER BY n DESC, 1 LIMIT 12`;

/**
 * Load ONE physician case. A uid that is neither in the directory nor carries an audited note is a
 * 404 that never reaches the model or the store; a DB fault on the primary read is a 503 rather
 * than a thread opened against an empty record that looks like a clean one.
 */
export async function loadPhysicianCase(doctorUid: string): Promise<CaseAskLoad> {
  const uid = String(doctorUid ?? '').trim();
  if (!uid || !isDoctorUid(uid)) return { ok: false, status: 400, error: 'bad doctor id' };
  const p = opdCanonParams();

  let aggRows: Record<string, unknown>[];
  try { aggRows = await run(PHYSICIAN_AGG_SQL, [...p, uid]); }
  catch { return { ok: false, status: 503, error: 'the stewardship record could not be read' }; }

  const dirRows = await rowsOf(DIRECTORY_SQL, [uid]);
  const own = opdAggOf(aggRows[0]);
  if (!dirRows.length && own.n_notes === 0) return { ok: false, status: 404, error: 'not found' };

  const speciality = str(dirRows[0]?.speciality) || OPD_DEPT_UNSPECIFIED;
  const [peerRows, findingRows] = await Promise.all([
    rowsOf(PEER_AGG_SQL, [...p, speciality]),
    rowsOf(PHYSICIAN_FINDINGS_SQL, [...p, uid]),
  ]);

  const material = physicianAskMaterial({
    doctorName: str(dirRows[0]?.doctor_name),
    speciality,
    own,
    peers: peerRows[0]
      ? {
        dept: str(peerRows[0].dept) || speciality,
        n_doctors: num(peerRows[0].n_doctors), n_notes: num(peerRows[0].n_notes),
        avg_nqi: num(peerRows[0].avg_nqi), pct_low: num(peerRows[0].pct_low),
      }
      : null,
    findings: findingRows.map((r) => ({ subject: str(r.subject), signal_type: str(r.signal_type), n: num(r.n) })),
  });
  return { ok: true, engineVersion: STEWARDSHIP_THREAD_ENGINE, material };
}

/** Load ONE department case, in whichever vocabulary the key names (A3). */
export async function loadDeptCase(caseKey: string): Promise<CaseAskLoad> {
  const parsed = parseDeptCaseKey(caseKey);
  if (!parsed) return { ok: false, status: 400, error: 'bad department key' };
  return parsed.vocab === 'ipd_speciality' ? loadIpdDept(parsed.label) : loadOpdDept(parsed.label);
}

async function loadOpdDept(label: string): Promise<CaseAskLoad> {
  const p = opdCanonParams();
  let aggRows: Record<string, unknown>[];
  try { aggRows = await run(DEPT_AGG_SQL, [...p, label]); }
  catch { return { ok: false, status: 503, error: 'the stewardship record could not be read' }; }

  const agg = opdAggOf(aggRows[0]);
  // A department exists BECAUSE audited notes carry its label; an empty one is a string nobody has
  // audited under, and opening a thread on it would key an argument to nothing.
  if (agg.n_notes === 0) return { ok: false, status: 404, error: 'not found' };

  const [clinRows, findingRows] = await Promise.all([
    rowsOf(DEPT_CLINICIANS_SQL, [...p, label]),
    rowsOf(DEPT_FINDINGS_SQL, [...p, label]),
  ]);
  const material = deptOpdAskMaterial({
    label,
    agg,
    clinicians: clinRows.map((r) => ({
      doctor_name: str(r.doctor_name), n_notes: num(r.n_notes), avg_nqi: num(r.avg_nqi), pct_low: num(r.pct_low),
    })),
    findings: findingRows.map((r) => ({ subject: str(r.subject), signal_type: str(r.signal_type), n: num(r.n) })),
  });
  return { ok: true, engineVersion: STEWARDSHIP_THREAD_ENGINE, material };
}

async function loadIpdDept(label: string): Promise<CaseAskLoad> {
  const p = ipdCanonParams();
  let aggRows: Record<string, unknown>[];
  try { aggRows = await run(DEPT_IPD_AGG_SQL, [...p, label]); }
  catch { return { ok: false, status: 503, error: 'the stewardship record could not be read' }; }

  const r = aggRows[0];
  const n_stays = num(r?.n_stays);
  if (n_stays === 0) return { ok: false, status: 404, error: 'not found' };

  const findingRows = await rowsOf(DEPT_IPD_FINDINGS_SQL, [...p, label]);
  const material = deptIpdAskMaterial({
    label: label || IPD_DEPT_UNASSIGNED,
    n_stays,
    avg_cvi: num(r?.avg_cvi), pct_ab: num(r?.pct_ab),
    avg_safety: num(r?.avg_safety), avg_complete: num(r?.avg_complete),
    findings: findingRows.map((x) => ({ subject: str(x.subject), domain: str(x.domain), n: num(x.n) })),
  });
  return { ok: true, engineVersion: STEWARDSHIP_THREAD_ENGINE, material };
}

/** The one entry point the route uses: a stewardship case type and its key → a loader. */
export function loadStewardshipCase(caseType: CaseAskType, caseKey: string): () => Promise<CaseAskLoad> {
  return async () => (caseType === 'physician' ? loadPhysicianCase(caseKey) : loadDeptCase(caseKey));
}

/** Every INFERRED query this file runs, for the slice report and for a live-validation pass. */
export const STEWARDSHIP_INFERRED_SQL: Readonly<Record<string, string>> = Object.freeze({
  directory: DIRECTORY_SQL,
  physician_aggregate: PHYSICIAN_AGG_SQL,
  physician_peers: PEER_AGG_SQL,
  physician_findings: PHYSICIAN_FINDINGS_SQL,
  dept_opd_aggregate: DEPT_AGG_SQL,
  dept_opd_clinicians: DEPT_CLINICIANS_SQL,
  dept_opd_findings: DEPT_FINDINGS_SQL,
  dept_ipd_aggregate: DEPT_IPD_AGG_SQL,
  dept_ipd_findings: DEPT_IPD_FINDINGS_SQL,
});
