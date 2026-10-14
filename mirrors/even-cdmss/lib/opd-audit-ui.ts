/**
 * lib/opd-audit-ui.ts — pure presentation helpers for the OPD Audit dashboard (M3).
 * Server-safe (no 'use client', no deps). Band/score colours + period date math + parse.
 */

export type Period = 'day' | 'week' | 'month';

export function bandColor(band: string): string {
  switch ((band || '').toUpperCase()) {
    case 'A': return '#0d9488';
    case 'B': return '#16a34a';
    case 'C': return '#d97706';
    case 'D': return '#ea580c';
    default:  return '#dc2626'; // E
  }
}

// Score → colour (matches the band thresholds in opd-note-score-core bandFor()).
export function scoreColor(s: number): string {
  if (s >= 70) return '#16a34a';
  if (s >= 55) return '#d97706';
  if (s >= 40) return '#ea580c';
  return '#dc2626';
}

/** Inclusive IST date window [from, to] for a period ending at `day` (YYYY-MM-DD). */
export function istDateRange(day: string, period: Period): { from: string; to: string } {
  const d = new Date(day + 'T00:00:00Z');
  const back = period === 'week' ? 6 : period === 'month' ? 29 : 0;
  d.setUTCDate(d.getUTCDate() - back);
  return { from: d.toISOString().slice(0, 10), to: day };
}

export const DOMAIN_ROWS: { col: string; label: string }[] = [
  { col: 'score_documentation', label: 'Documentation' },
  { col: 'score_note_quality', label: 'Note quality (PDQI-9)' },
  { col: 'score_appropriateness', label: 'Appropriateness' },
  { col: 'score_prescribing_safety', label: 'Prescribing & safety' },
  { col: 'score_patient_centred', label: 'Patient-centredness' },
];

export const PDQI9_LABEL: Record<string, string> = {
  up_to_date: 'Up-to-date', accurate: 'Accurate', thorough: 'Thorough', useful: 'Useful',
  organized: 'Organized', comprehensible: 'Comprehensible', succinct: 'Succinct',
  synthesized: 'Synthesized', internally_consistent: 'Internally consistent',
};

// PDQI-9 attribute help (keyed by display label). Dual-purpose by design: `def` tells the AUDITOR
// what the attribute means, `lever` says how to raise it — phrased so it both guides feedback to the
// doctor AND names the EMR-capture affordance for the design team (the "EMR:" cue).
// Shared by the dashboard pillars (hover tooltips) and the case-screen PDQI radar.
export const PDQI9_HELP: Record<string, { def: string; lever: string }> = {
  'Up-to-date': {
    def: 'Reflects the current picture — today’s medications, latest results and status — not stale content carried forward from a past visit.',
    lever: 'Reconcile meds & results at the visit. EMR: auto-pull the live med list + latest labs; visibly flag copied-forward text.',
  },
  'Accurate': {
    def: 'Factually correct — values, medications and history match reality, with no contradictions or copy-paste errors.',
    lever: 'Verify data before signing. EMR: pull vitals/labs from source instead of free-typing to remove transcription errors.',
  },
  'Thorough': {
    def: 'Covers what’s relevant — the complaint, pertinent history, comorbidities and key positive/negative findings — not just the headline issue.',
    lever: 'Prompt comorbidities + pertinent negatives. EMR: structured HPI / ROS / comorbidity fields rather than one free-text box.',
  },
  'Useful': {
    def: 'Gives the next clinician what they need to act — a clear plan and the reasoning behind it.',
    lever: 'Document an actionable plan + safety-net. EMR: a dedicated plan/instructions field with prompts.',
  },
  'Organized': {
    def: 'Logical, consistent structure — information sits where you expect it and the note is easy to scan.',
    lever: 'Keep to a consistent section order. EMR: enforce a SOAP-style layout; place fields in clinical order.',
  },
  'Comprehensible': {
    def: 'Clear and readable to another clinician — minimal ambiguous shorthand or unexplained abbreviations.',
    lever: 'Spell out ambiguous abbreviations. EMR: prefer structured pick-lists over free-typed shorthand.',
  },
  'Succinct': {
    def: 'Concise — the clinical signal isn’t buried under boilerplate or repetition.',
    lever: 'Trim auto-inserted boilerplate. EMR: drop default template walls-of-text; use smart, minimal defaults.',
  },
  'Synthesized': {
    def: 'Pulls the data together into the clinician’s reasoning — a coherent assessment/impression, not just a list of findings.',
    lever: 'Add an assessment linking findings → diagnosis → plan. EMR: these notes have no assessment/impression field — the single biggest capture gap.',
  },
  'Internally consistent': {
    def: 'No internal contradictions — the diagnosis, medications and plan all line up with each other.',
    lever: 'Check diagnosis ↔ drug ↔ plan alignment. EMR: cross-field checks (e.g. drug class vs diagnosis) that warn on mismatch.',
  },
};

/** Parse a jsonb column that the driver may hand back as an object/array or a JSON string. */
export function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'object') return v as T;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return fallback;
}

/** Short, stable label for a doctor_uid until name enrichment lands (PRD open item). */
export function doctorLabel(uid: string | null): string {
  if (!uid) return 'Unknown';
  return 'Dr · ' + uid.slice(0, 6);
}

export function fmtIstTime(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export function fmtIstDateLong(day: string): string {
  const t = new Date(day + 'T12:00:00+05:30').getTime();
  if (Number.isNaN(t)) return day;
  return new Date(t).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
